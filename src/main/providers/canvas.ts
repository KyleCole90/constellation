import * as v from "valibot";

import type { FieldKey, LmsError } from "../../shared/domain/change";
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
/** Writes ship in step 12 (docs/electron-spec.md). Until then every write and its read-back refuse, rather than half-run. */
const NOT_YET = { kind: "unsupported", capability: "sending changes from this app yet" } as const;

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
const ConversationRow = v.object({ id: Id });
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
      if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");

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

const PER_PAGE = 100;

/** `fetch` as the provider calls it. Main passes Electron's `net.fetch`, which uses the system's proxy and certificates. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A school's real Canvas, run in main with the token from main's vault (docs/electron-spec.md, step 11). Each read
 * follows `Link: rel="next"` to the end, so it returns the whole list. A throttle comes back as `rate_limited` at once:
 * the runner pauses the lane, and this never sleeps. Writes refuse until step 12.
 */
export const createCanvasProvider = (deps: {
  school: School;
  lease: CredentialLease;
  fetch: Fetch;
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
      const visited = new Set<string>();
      for (let next: string | null = first.toString(); next !== null;) {
        const url: string = next;
        if (visited.has(url) || !URL.canParse(url) || new URL(url).origin !== origin)
          return unreadable("a page link");
        visited.add(url);
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

  const courseId = (course: LmsRef<"course">): string => refParts(course)[2] ?? "";
  const notYet = (fields: readonly FieldKey[]): FieldOutcomes =>
    Object.fromEntries(fields.map((field) => [field, { status: "failed", error: NOT_YET }]));

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
        "/courses?enrollment_type=teacher&enrollment_state=active&include[]=total_students",
        CourseRow,
      );
      if (!rows.ok) return rows;
      return {
        ok: true,
        value: rows.value.flatMap((row): Course[] =>
          "access_restricted_by_date" in row
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
    assignments: async (course) => {
      const rows = await list(`/courses/${courseId(course)}/assignments`, AssignmentRow);
      if (!rows.ok) return rows;
      return {
        ok: true,
        value: rows.value.map((row): Assignment => ({
          ref: refs.assignment(school.id, Number(courseId(course)), row.id),
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
    },
    students: async (course) => {
      const rows = await list(
        `/courses/${courseId(course)}/users?enrollment_type[]=student`,
        StudentRow,
      );
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
    },
    submissions: async (course) => {
      const mine = await me();
      if (!mine.ok) return mine;
      const id = Number(courseId(course));
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
    },
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
    announcements: async (course) => {
      const rows = await list(
        `/courses/${courseId(course)}/discussion_topics?only_announcements=true`,
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
    },
    observe: async () => ({ ok: false, error: NOT_YET }),
    apply: async (permit) => (SendPermit.isGenuine(permit) ? notYet(permit.fields) : {}),
  };
};
