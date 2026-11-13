import * as v from "valibot";

import {
  finalGrade,
  scoredRubricPoints,
  type ChangeContent,
  type FieldKey,
  type GradeContent,
  type LmsError,
  type RemoteEntry,
  type RemoteState,
} from "../../shared/domain/change";
import {
  isoTime,
  parseIsoTime,
  parseSchoolHost,
  type IsoTime,
  type LmsRef,
  type Result,
  type SchoolId,
} from "../../shared/domain/ids";
import type {
  Announcement,
  Assignment,
  Conversation,
  Course,
  School,
  Student,
  Submission,
  SubmissionBody,
} from "../../shared/domain/lms";
import { SendPermit } from "../../shared/domain/permit";
import { CANVAS_FACE, CANVAS_SCOPES } from "../../shared/providers/canvas";
import { refParts, refs } from "../../shared/providers/canvas-refs";
import {
  revealSecret,
  type CredentialLease,
  type FieldOutcomes,
  type LmsProvider,
  type Read,
} from "../../shared/providers/provider";

import { canvasTermSetup } from "./canvas-term";

/**
 * The school at `raw` as real Canvas: an `https:` host name with no port, path or credentials, and no IP literal,
 * since a school's Canvas always has a name. The id is the host, so a token saved under an id only ever goes to that
 * host. Null when `raw` isn't such a host.
 */
export const canvasSchoolAt = (raw: string): School | null => {
  const parsed = parseSchoolHost(raw);
  if (!parsed.ok) return null;
  const host = parsed.value;
  let normalized: string;
  try {
    normalized = new URL(`https://${host}/`).host;
  } catch {
    return null;
  }
  // The URL parser reads `0x7f.1` as an IPv4 address, so anything it rewrites is refused along with plain IPs and ports.
  if (normalized !== host || host.includes(":") || /^[\d.]+$/.test(host)) return null;
  return {
    // The id is the host by design, so the two can't name different schools.
    id: host as string as SchoolId,
    abbr: (host.split(".")[0] ?? host).slice(0, 4).toUpperCase(),
    name: host,
    host,
    provider: "canvas",
  };
};

const OFFLINE = {
  ok: false,
  error: { kind: "unavailable", status: null },
} as const satisfies Result<never, LmsError>;
const unreadable = (what: string) =>
  ({
    ok: false,
    error: { kind: "rejected", reason: `Canvas sent ${what} this app can't read.` },
  }) as const satisfies Result<never, LmsError>;
const retryAfterMs = (response: Response): number | null => {
  const seconds = Number(response.headers.get("retry-after"));
  return response.headers.has("retry-after") && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : null;
};

/** Canvas throttles with a 403 whose body says so, not a 429 (docs/electron-spec.md, Canvas). */
const errorOf = async (response: Response): Promise<LmsError> => {
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
    return {
      kind: "rejected",
      reason: "Canvas sent this request to another address. Check the school's address.",
    };
  switch (response.status) {
    case 401:
      return { kind: "auth_expired" };
    case 403: {
      const body = await response.text().catch(() => "");
      return /rate limit exceeded/i.test(body)
        ? { kind: "rate_limited", retryAfterMs: retryAfterMs(response) }
        : { kind: "forbidden", missingScope: null };
    }
    case 404:
      return { kind: "not_found" };
    case 429:
      return { kind: "rate_limited", retryAfterMs: retryAfterMs(response) };
    default:
      return { kind: "unavailable", status: response.status };
  }
};

const nextLink = (header: string | null): string | null =>
  header?.split(",").flatMap((part) => /<([^>]+)>\s*;\s*rel="next"/.exec(part)?.[1] ?? [])[0] ??
  null;

// ---- What Canvas sends, per its public API docs. Unknown keys are dropped; a missing required one fails the read. ----

const Id = v.pipe(v.number(), v.integer());
const Time = v.pipe(
  v.string(),
  v.check((raw) => parseIsoTime(raw) !== null),
  v.transform((raw): IsoTime => isoTime(raw)),
);
const OptionalTime = v.nullish(Time, null);

const Self = v.object({ id: Id, name: v.string() });
const CourseRow = v.union([
  /** A course whose dates have passed or not begun lists with only these. */
  v.object({ id: Id, access_restricted_by_date: v.literal(true) }),
  v.object({
    id: Id,
    name: v.string(),
    course_code: v.string(),
    total_students: v.nullish(v.number(), 0),
    concluded: v.nullish(v.boolean(), false),
  }),
]);
const AssignmentRow = v.object({
  id: Id,
  name: v.string(),
  due_at: OptionalTime,
  points_possible: v.nullish(v.number(), 0),
  rubric: v.nullish(
    v.array(v.object({ id: v.string(), description: v.string(), points: v.number() })),
  ),
});
const StudentRow = v.object({ id: Id, name: v.string() });
const SubmissionRow = v.object({
  assignment_id: Id,
  user_id: Id,
  workflow_state: v.string(),
  missing: v.nullish(v.boolean(), false),
  excused: v.nullish(v.boolean(), false),
  attempt: v.nullish(v.number(), 0),
  late: v.nullish(v.boolean(), false),
  seconds_late: v.nullish(v.number(), 0),
  submitted_at: OptionalTime,
  score: v.nullish(v.number(), null),
  body: v.nullish(v.string(), null),
  rubric_assessment: v.nullish(
    v.record(v.string(), v.object({ points: v.nullish(v.number(), null) })),
    null,
  ),
  submission_comments: v.nullish(
    v.array(v.object({ id: Id, author_id: Id, comment: v.string(), created_at: Time })),
    [],
  ),
  user: v.nullish(v.object({ name: v.string() }), null),
});
const ConversationRow = v.object({ id: Id, subject: v.nullish(v.string(), "") });
const ConversationDetail = v.object({
  id: Id,
  subject: v.nullish(v.string(), ""),
  workflow_state: v.string(),
  context_code: v.nullish(v.string(), null),
  participants: v.array(v.object({ id: Id, name: v.string() })),
  /** Newest first. */
  messages: v.array(v.object({ id: Id, author_id: Id, body: v.string(), created_at: Time })),
});
const AnnouncementRow = v.object({
  id: Id,
  title: v.string(),
  message: v.nullish(v.string(), ""),
  posted_at: OptionalTime,
});

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Canvas stores rich text as HTML. The app shows plain paragraphs. */
const paragraphsOf = (html: string): string[] =>
  html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
      if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? entity;
      const point = name.startsWith("#x")
        ? Number.parseInt(name.slice(2), 16)
        : Number(name.slice(1));
      // Student-written HTML can name any number, and one past Unicode must not throw out of the whole read.
      const valid = point <= 0x10ffff && (point < 0xd800 || point > 0xdfff);
      return valid ? String.fromCodePoint(point) : "\uFFFD";
    })
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Plain text as the rich text Canvas stores: a paragraph per blank line, which `paragraphsOf` reads back. */
const htmlOf = (text: string): string =>
  text
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");

/** Text on one line: a newline, a control character or a direction override can't break it. A break shows as ¶. */
const oneLine = (text: string): string =>
  text
    .replace(/\s*\n\s*/g, " ¶ ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

type Outcome = NonNullable<FieldOutcomes[FieldKey]>;
/**
 * The order a grade's fields go out in, one request each so each reports its own outcome. Canvas may score a submission
 * from its rubric assessment, so the grade follows the rubric and keeps the teacher's total.
 */
const WRITE_ORDER: readonly FieldKey[] = [
  "excuse",
  "rubric",
  "grade",
  "comment",
  "attachment",
  "message",
  "conversation",
  "post",
  "copy",
  "value",
  "text",
];

const workflowOf = (row: v.InferOutput<typeof SubmissionRow>): Submission["workflow"] => {
  if (row.excused) return "excused";
  if (row.workflow_state === "graded") return "graded";
  if (row.workflow_state === "submitted" || row.workflow_state === "pending_review")
    return "submitted";
  return row.missing ? "missing" : "unsubmitted";
};

const bodyOf = (html: string | null): SubmissionBody => {
  const paragraphs = paragraphsOf(html ?? "");
  if (paragraphs.length === 0) return { kind: "none" };
  const wordCount = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  return { kind: "text", title: "", wordCount, paragraphs };
};

/** What Canvas answers a migration created with a `pre_attachment`: where, and with which fields, to post the file. */
const PreAttachment = v.object({
  pre_attachment: v.object({
    upload_url: v.pipe(v.string(), v.url()),
    upload_params: v.nullish(
      v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
      {},
    ),
    file_param: v.nullish(v.string(), "file"),
  }),
});

const PER_PAGE = 100;
/** A list longer than this many pages is a Canvas fault (a looping or endless `next`), not a course. */
const MAX_PAGES = 100;

/** `fetch` as the provider calls it. Main passes Electron's `net.fetch`, which uses the system's proxy and certificates. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A school's real Canvas, run in main with the token from main's vault (docs/electron-spec.md, step 11). Each read
 * follows `Link: rel="next"` to the end, so it returns the whole list. A throttle comes back as `rate_limited` at once:
 * the runner pauses the lane, and this never sleeps. Each written field is its own request, so it reports its own
 * outcome, and a request whose answer never came back is `unknown` until a read says otherwise.
 */
export const createCanvasProvider = (deps: {
  school: School;
  lease: CredentialLease;
  fetch: Fetch;
  now(): number;
  /** The `.imscc` file main's picker chose under `name` for this school, or null when none was. */
  packageFile(name: string): Promise<Blob | null>;
}): LmsProvider => {
  const { school, lease } = deps;
  const origin = `https://${school.host}`;

  const page = async (
    url: string,
    token: string,
  ): Promise<Result<{ body: unknown; next: string | null }, LmsError>> => {
    let response: Response;
    let text: string;
    try {
      response = await deps.fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        // A redirect could carry the request to another host. Canvas answers its API without one.
        redirect: "manual",
      });
      if (!response.ok) return { ok: false, error: await errorOf(response) };
      text = await response.text();
    } catch {
      return OFFLINE;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return unreadable("an answer");
    }
    return { ok: true, value: { body, next: nextLink(response.headers.get("link")) } };
  };

  /** Every page of `path`, each parsed by `row`. The token goes only to this school's origin, page links included. */
  const list = <T extends v.GenericSchema>(path: string, row: T): Read<v.InferOutput<T>[]> =>
    lease.use(async (credential) => {
      if (!credential) return { ok: false, error: { kind: "auth_expired" } };
      const secret = credential.kind === "bearer" ? credential.token : credential.access;
      const first = new URL(`${origin}/api/v1${path}`);
      first.searchParams.set("per_page", String(PER_PAGE));
      const rows: v.InferOutput<T>[] = [];
      let pages = 0;
      for (let next: string | null = first.toString(); next !== null;) {
        const url: string = next;
        if (++pages > MAX_PAGES || !URL.canParse(url) || new URL(url).origin !== origin)
          return unreadable("a page link");
        const result = await revealSecret(secret, (token) => page(url, token));
        if (!result.ok) return result;
        const parsed = v.safeParse(v.array(row), result.value.body);
        if (!parsed.success) return unreadable("a list");
        rows.push(...parsed.output);
        next = result.value.next;
      }
      return { ok: true, value: rows };
    });

  /** One object: the same request as a list of one, since Canvas pages only arrays. */
  const one = async <T extends v.GenericSchema>(path: string, schema: T): Read<v.InferOutput<T>> =>
    lease.use(async (credential) => {
      if (!credential) return { ok: false, error: { kind: "auth_expired" } };
      const secret = credential.kind === "bearer" ? credential.token : credential.access;
      const result = await revealSecret(secret, (token) => page(`${origin}/api/v1${path}`, token));
      if (!result.ok) return result;
      const parsed = v.safeParse(schema, result.value.body);
      return parsed.success ? { ok: true, value: parsed.output } : unreadable("an answer");
    });

  let selfId: Promise<Result<number, LmsError>> | null = null;
  /** Who "mine" is on a comment or message. Asked once; a failed ask is asked again next time. */
  const me = (): Promise<Result<number, LmsError>> => {
    selfId ??= one("/users/self", Self).then((result) => {
      if (!result.ok) selfId = null;
      return result.ok ? { ok: true, value: result.value.id } : result;
    });
    return selfId;
  };

  /**
   * The Canvas ids in a ref this provider minted, as `<school>:<kind>:<digits>...`. The ref comes from the untrusted
   * renderer, so anything else goes nowhere near a request path.
   */
  const idsIn = (ref: string, kind: string, count: number): number[] | null => {
    const [owner, refKind, ...ids] = refParts(ref);
    return owner === school.id &&
      refKind === kind &&
      ids.length === count &&
      ids.every((id) => /^\d+$/.test(id))
      ? ids.map(Number)
      : null;
  };
  const NOT_FOUND = { ok: false, error: { kind: "not_found" } } as const;
  const inCourse = async <T>(course: LmsRef<"course">, read: (id: number) => Read<T>): Read<T> => {
    const [id] = idsIn(course, "course", 1) ?? [];
    return id === undefined ? NOT_FOUND : read(id);
  };
  /** A submission ref's course, assignment and student, and the path Canvas keeps it at. */
  const submissionAt = (ref: LmsRef<"submission">) => {
    const [course, assignment, user] = idsIn(ref, "submission", 3) ?? [];
    if (course === undefined || assignment === undefined || user === undefined) return null;
    return {
      course,
      assignment,
      user,
      path: `/courses/${course}/assignments/${assignment}/submissions/${user}`,
    };
  };

  /** The rubric scores as Canvas takes them, by criterion id. Null when one names a criterion of another assignment. */
  const rubricOf = (content: GradeContent, assignment: number): [string, number][] | null => {
    const scores: [string, number][] = [];
    for (const [criterion, points] of Object.entries(scoredRubricPoints(content.rubric ?? []))) {
      const [owner, kind, of, id, ...rest] = refParts(criterion);
      if (
        owner !== school.id ||
        kind !== "criterion" ||
        of !== String(assignment) ||
        id === undefined ||
        !/^[\w-]+$/.test(id) ||
        rest.length > 0
      )
        return null;
      scores.push([id, points]);
    }
    return scores;
  };
  const NO_SUCH_CRITERION = "A rubric score names a criterion this assignment doesn't have.";

  /**
   * One write. Canvas answering at all means it did or didn't apply; a request that never got an answer may have
   * applied, so it is `unknown`, and only a later read can say.
   */
  const write = (
    method: "PUT" | "POST" | "DELETE",
    path: string,
    form: URLSearchParams,
  ): Promise<Outcome> =>
    lease.use(async (credential): Promise<Outcome> => {
      if (!credential) return { status: "failed", error: { kind: "auth_expired" } };
      const secret = credential.kind === "bearer" ? credential.token : credential.access;
      let response: Response;
      try {
        response = await revealSecret(secret, (token) =>
          deps.fetch(`${origin}/api/v1${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
            redirect: "manual",
          }),
        );
      } catch {
        return { status: "unknown", since: isoTime(deps.now()) };
      }
      if (!response.ok) return { status: "failed", error: await errorOf(response) };
      return { status: "landed", at: isoTime(deps.now()), via: "response" };
    });
  const refused = (reason: string): Promise<Outcome> =>
    Promise.resolve({ status: "failed", error: { kind: "rejected", reason } });

  /**
   * A package import, as Canvas documents a file upload: create the migration with a `pre_attachment`, post the file
   * to the upload address it returns, then confirm back at the school if the upload redirects. The upload address is
   * often file storage on another host, so that request carries only Canvas's upload params and never the token.
   */
  const importPackage = (path: string, form: URLSearchParams, file: Blob, name: string) =>
    lease.use(async (credential): Promise<Outcome> => {
      if (!credential) return { status: "failed", error: { kind: "auth_expired" } };
      const secret = credential.kind === "bearer" ? credential.token : credential.access;
      const lost: Outcome = { status: "unknown", since: isoTime(deps.now()) };
      const rejected = (reason: string): Outcome => ({
        status: "failed",
        error: { kind: "rejected", reason },
      });
      const withToken = (
        url: string,
        init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string },
      ) =>
        revealSecret(secret, (token) =>
          deps.fetch(url, {
            ...init,
            headers: {
              ...init.headers,
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
            redirect: "manual",
          }),
        );

      let text: string;
      try {
        const created = await withToken(`${origin}/api/v1${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        if (!created.ok) return { status: "failed", error: await errorOf(created) };
        text = await created.text();
      } catch {
        return lost;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const parsed = v.safeParse(PreAttachment, body);
      const upload = parsed.success ? parsed.output.pre_attachment : null;
      if (!upload || new URL(upload.upload_url).protocol !== "https:")
        return rejected("Canvas started the import but gave no address to upload the package to.");

      const files = new FormData();
      for (const [key, value] of Object.entries(upload.upload_params))
        files.append(key, String(value));
      // Last, as the storage behind the upload address requires.
      files.append(upload.file_param, file, name);
      let uploaded: Response;
      try {
        uploaded = await deps.fetch(upload.upload_url, {
          method: "POST",
          body: files,
          redirect: "manual",
        });
      } catch {
        return lost;
      }
      const landed: Outcome = { status: "landed", at: isoTime(deps.now()), via: "response" };
      if (uploaded.ok) return landed;
      if (uploaded.type === "opaqueredirect")
        return rejected("Canvas's file storage redirected the upload where the app can't follow.");
      if (uploaded.status < 300 || uploaded.status >= 400)
        return rejected(`The package upload was refused (status ${uploaded.status}).`);
      // A redirect is Canvas's confirm step: a GET back at the school, with the token, marks the file uploaded. Storage
      // chose this address, so the token goes only to the one path Canvas documents for it.
      const location = uploaded.headers.get("location");
      const confirm =
        location !== null && URL.canParse(location, upload.upload_url)
          ? new URL(location, upload.upload_url)
          : null;
      if (
        confirm?.origin !== origin ||
        !/^\/api\/v1\/files\/\d+\/create_success$/.test(confirm.pathname)
      )
        return rejected(
          "Canvas asked to finish the upload at another address, so the app didn't send your token there.",
        );
      try {
        const confirmed = await withToken(confirm.toString(), { method: "GET" });
        return confirmed.ok ? landed : { status: "failed", error: await errorOf(confirmed) };
      } catch {
        return lost;
      }
    });

  const term = canvasTermSetup({
    school,
    now: deps.now,
    list,
    one,
    write,
    importPackage,
    packageFile: deps.packageFile,
    me,
    idsIn,
    oneLine,
  });

  /** The request that writes `field` of `content`, or a refusal when the content names nothing this school holds. */
  const writeOf = (content: ChangeContent, field: FieldKey): Promise<Outcome> => {
    const form = (entries: Record<string, string>) => new URLSearchParams(entries);
    switch (content.kind) {
      case "grade": {
        const at = submissionAt(content.target);
        if (!at) return refused("That submission isn't at this school.");
        switch (field) {
          case "excuse":
            return write("PUT", at.path, form({ "submission[excuse]": "true" }));
          case "grade": {
            const grade = finalGrade(content);
            return grade === null
              ? refused("There is no grade to send.")
              : write("PUT", at.path, form({ "submission[posted_grade]": String(grade) }));
          }
          case "rubric": {
            const scores = rubricOf(content, at.assignment);
            if (!scores) return refused(NO_SUCH_CRITERION);
            const params = new URLSearchParams();
            for (const [id, points] of scores)
              params.set(`rubric_assessment[${id}][points]`, String(points));
            return scores.length === 0
              ? refused("There are no rubric scores to send.")
              : write("PUT", at.path, params);
          }
          case "comment":
            return content.comment === null
              ? refused("There is no feedback to send.")
              : write("PUT", at.path, form({ "comment[text_comment]": content.comment }));
          case "attachment":
          case "message":
          case "conversation":
          case "post":
          case "copy":
          case "value":
          case "text":
            break;
        }
        break;
      }
      case "reply": {
        const [id] = idsIn(content.target, "conversation", 1) ?? [];
        if (id === undefined) return refused("That conversation isn't at this school.");
        if (field === "message")
          return write("POST", `/conversations/${id}/add_message`, form({ body: content.body }));
        break;
      }
      case "message": {
        const at = submissionAt(content.target);
        if (!at) return refused("That student isn't at this school.");
        // `force_new`, or Canvas adds the message to an earlier conversation with the student.
        if (field === "conversation")
          return write(
            "POST",
            "/conversations",
            form({
              "recipients[]": String(at.user),
              subject: content.subject,
              body: content.body,
              context_code: `course_${at.course}`,
              force_new: "true",
            }),
          );
        break;
      }
      case "announcement": {
        const [id] = idsIn(content.target, "course", 1) ?? [];
        if (id === undefined) return refused("That course isn't at this school.");
        if (field === "post")
          return write(
            "POST",
            `/courses/${id}/discussion_topics`,
            form({
              title: content.title,
              message: htmlOf(content.body),
              is_announcement: "true",
              published: "true",
            }),
          );
        break;
      }
      case "course-copy":
      case "text-fix":
      case "item-set":
        return term.writeOf(content, field);
    }
    return Promise.resolve({
      status: "failed",
      error: { kind: "unsupported", capability: `${content.kind} ${field}` },
    });
  };

  const entriesOf = (
    messages: readonly { id: number; author_id: number; body: string }[],
    mine: number,
  ): RemoteEntry[] =>
    messages.map((message) => ({
      id: String(message.id),
      mine: message.author_id === mine,
      text: message.body,
    }));

  const observe = async (content: ChangeContent): Read<RemoteState> => {
    switch (content.kind) {
      case "grade": {
        const at = submissionAt(content.target);
        if (!at) return NOT_FOUND;
        const mine = await me();
        if (!mine.ok) return mine;
        const read = await one(
          `${at.path}?include[]=submission_comments&include[]=rubric_assessment`,
          SubmissionRow,
        );
        if (!read.ok) return read;
        const row = read.value;
        return {
          ok: true,
          value: {
            kind: "grade",
            targetVersion: `attempt:${row.attempt}`,
            grade: row.excused ? null : row.score,
            rubric: row.rubric_assessment
              ? Object.fromEntries(
                  Object.entries(row.rubric_assessment).flatMap(([criterion, { points }]) =>
                    points === null
                      ? []
                      : [[refs.criterion(school.id, at.assignment, criterion), points]],
                  ),
                )
              : null,
            excused: row.excused,
            comments: row.submission_comments.map((comment) => ({
              id: String(comment.id),
              mine: comment.author_id === mine.value,
              text: comment.comment,
            })),
            attachments: [],
          },
        };
      }
      case "reply": {
        const [id] = idsIn(content.target, "conversation", 1) ?? [];
        if (id === undefined) return NOT_FOUND;
        const mine = await me();
        if (!mine.ok) return mine;
        const read = await one(`/conversations/${id}?auto_mark_as_read=false`, ConversationDetail);
        if (!read.ok) return read;
        const messages = read.value.messages.toReversed();
        return {
          ok: true,
          value: {
            kind: "reply",
            targetVersion: `messages:${messages.length}`,
            messages: entriesOf(messages, mine.value),
          },
        };
      }
      case "message": {
        const at = submissionAt(content.target);
        if (!at) return NOT_FOUND;
        const mine = await me();
        if (!mine.ok) return mine;
        // A conversation the teacher started and nobody answered sits in "sent", not the inbox.
        const rows = await list(
          `/conversations?scope=sent&filter[]=user_${at.user}`,
          ConversationRow,
        );
        if (!rows.ok) return rows;
        const openings: RemoteEntry[] = [];
        for (const row of rows.value.filter((entry) => entry.subject === content.subject)) {
          const read = await one(
            `/conversations/${row.id}?auto_mark_as_read=false`,
            ConversationDetail,
          );
          if (!read.ok) return read;
          openings.push(...entriesOf(read.value.messages.slice(-1), mine.value));
        }
        return {
          ok: true,
          value: { kind: "message", targetVersion: "student", messages: openings },
        };
      }
      case "announcement":
        return inCourse(content.target, async (id) => {
          // Every topic, delayed ones too: a post this app made is there whether or not it shows yet.
          const rows = await list(
            `/courses/${id}/discussion_topics?only_announcements=true`,
            AnnouncementRow,
          );
          if (!rows.ok) return rows;
          return {
            ok: true,
            value: {
              kind: "announcement",
              targetVersion: "course",
              // Only teachers post announcements, and `seen` tells this app's posts from earlier ones.
              posts: rows.value.map((row) => ({
                id: String(row.id),
                mine: true,
                text: `${row.title}\n\n${paragraphsOf(row.message).join("\n\n")}`,
              })),
            },
          };
        });
      case "course-copy":
      case "text-fix":
      case "item-set":
        return term.observe(content);
    }
  };

  const conversation = async (
    id: number,
    mine: number,
  ): Promise<Result<Conversation | null, LmsError>> => {
    // Reading a conversation marks it read unless told not to, and a sync must not change what the teacher sees.
    const detail = await one(`/conversations/${id}?auto_mark_as_read=false`, ConversationDetail);
    if (!detail.ok) return detail;
    const row = detail.value;
    const courseCode = /^course_(\d+)$/.exec(row.context_code ?? "")?.[1];
    if (courseCode === undefined) return { ok: true, value: null };
    const names = new Map(row.participants.map((person) => [person.id, person.name]));
    return {
      ok: true,
      value: {
        ref: refs.conversation(school.id, row.id),
        school: school.id,
        course: refs.course(school.id, Number(courseCode)),
        subject: row.subject,
        from: row.participants.find((person) => person.id !== mine)?.name ?? "",
        unread: row.workflow_state === "unread",
        messages: row.messages.toReversed().map((message) => ({
          id: String(message.id),
          mine: message.author_id === mine,
          author: names.get(message.author_id) ?? "",
          text: message.body,
          at: message.created_at,
        })),
      },
    };
  };

  return {
    ...CANVAS_FACE,
    verify: async () => {
      const self = await one("/users/self", Self);
      return self.ok
        ? { ok: true, value: { displayName: self.value.name, scopes: CANVAS_SCOPES } }
        : self;
    },
    courses: async () => {
      const rows = await list(
        // Only a published course is one students can reach. `enrollment_state=active` would also drop a course whose
        // term hasn't started, so Canvas's `concluded` flag is what leaves out past terms.
        "/courses?enrollment_type=teacher&include[]=total_students&include[]=concluded&state[]=available",
        CourseRow,
      );
      if (!rows.ok) return rows;
      return {
        ok: true,
        value: rows.value.flatMap((row): Course[] =>
          "access_restricted_by_date" in row || row.concluded
            ? []
            : [
                {
                  ref: refs.course(school.id, row.id),
                  school: school.id,
                  code: row.course_code,
                  title: row.name,
                  section: null,
                  modality: null,
                  studentCount: row.total_students,
                },
              ],
        ),
      };
    },
    assignments: (course) =>
      inCourse(course, async (id) => {
        const rows = await list(`/courses/${id}/assignments`, AssignmentRow);
        if (!rows.ok) return rows;
        return {
          ok: true,
          value: rows.value.map((row): Assignment => ({
            ref: refs.assignment(school.id, id, row.id),
            school: school.id,
            course,
            title: row.name,
            shortTitle: row.name,
            dueAt: row.due_at,
            pointsPossible: row.points_possible,
            rubric:
              row.rubric?.map((criterion) => ({
                ref: refs.criterion(school.id, row.id, criterion.id),
                name: criterion.description,
                maxPoints: criterion.points,
              })) ?? null,
            latePointsPerDay: null,
          })),
        };
      }),
    students: (course) =>
      inCourse(course, async (id) => {
        const rows = await list(`/courses/${id}/users?enrollment_type[]=student`, StudentRow);
        if (!rows.ok) return rows;
        return {
          ok: true,
          value: rows.value.map((row): Student => ({
            ref: refs.student(school.id, row.id),
            school: school.id,
            course,
            name: row.name,
          })),
        };
      }),
    submissions: (course) =>
      inCourse(course, async (id) => {
        const mine = await me();
        if (!mine.ok) return mine;
        const rows = await list(
          `/courses/${id}/students/submissions?student_ids[]=all&include[]=submission_comments&include[]=rubric_assessment&include[]=user`,
          SubmissionRow,
        );
        if (!rows.ok) return rows;
        return {
          ok: true,
          value: rows.value.map((row): Submission => ({
            ref: refs.submission(school.id, id, row.assignment_id, row.user_id),
            school: school.id,
            course,
            assignment: refs.assignment(school.id, id, row.assignment_id),
            student: refs.student(school.id, row.user_id),
            studentName: row.user?.name ?? "",
            workflow: workflowOf(row),
            attempt: row.attempt,
            lateDays: row.late ? Math.ceil(row.seconds_late / 86_400) : 0,
            submittedAt: row.submitted_at,
            grade: row.score,
            rubricScores: row.rubric_assessment
              ? Object.fromEntries(
                  Object.entries(row.rubric_assessment).flatMap(([criterion, { points }]) =>
                    points === null
                      ? []
                      : [[refs.criterion(school.id, row.assignment_id, criterion), points]],
                  ),
                )
              : null,
            comments: row.submission_comments.map((comment) => ({
              id: String(comment.id),
              mine: comment.author_id === mine.value,
              text: comment.comment,
              at: comment.created_at,
            })),
            body: bodyOf(row.body),
          })),
        };
      }),
    conversations: async () => {
      const mine = await me();
      if (!mine.ok) return mine;
      const rows = await list("/conversations", ConversationRow);
      if (!rows.ok) return rows;
      const out: Conversation[] = [];
      for (const row of rows.value) {
        const read = await conversation(row.id, mine.value);
        if (!read.ok) return read;
        if (read.value) out.push(read.value);
      }
      return { ok: true, value: out };
    },
    announcements: (course) =>
      inCourse(course, async (id) => {
        const rows = await list(
          `/courses/${id}/discussion_topics?only_announcements=true`,
          AnnouncementRow,
        );
        if (!rows.ok) return rows;
        return {
          ok: true,
          value: rows.value.flatMap((row): Announcement[] =>
            // An announcement with no post time is a draft or delayed, and not posted yet.
            row.posted_at === null
              ? []
              : [
                  {
                    ref: refs.announcement(school.id, row.id),
                    school: school.id,
                    course,
                    title: row.title,
                    body: paragraphsOf(row.message).join("\n\n"),
                    postedAt: row.posted_at,
                  },
                ],
          ),
        };
      }),
    observe,
    /**
     * In `WRITE_ORDER`, one request per field. After a field that didn't land, nothing more is sent, so the rest
     * failed: with its error, or as unavailable when its answer was lost.
     */
    apply: async (permit) => {
      if (!SendPermit.isGenuine(permit)) return {};
      const { content, fields } = permit;
      const outcomes: Partial<Record<FieldKey, Outcome>> = {};
      let unsent: Outcome | null = null;
      for (const field of WRITE_ORDER.filter((key) => fields.includes(key))) {
        const outcome: Outcome = unsent ?? (await writeOf(content, field));
        outcomes[field] = outcome;
        if (outcome.status === "failed") unsent = outcome;
        if (outcome.status === "unknown")
          unsent = { status: "failed", error: { kind: "unavailable", status: null } };
      }
      return outcomes;
    },
    termSetup: term.termSetup,
  };
};
