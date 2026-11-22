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
  parseSchoolHost,
  schoolIdOf,
  type LmsRef,
  type Result,
} from "../../shared/domain/ids";
import {
  googleExportOf,
  type Announcement,
  type Assignment,
  type Conversation,
  type Course,
  type School,
  type Student,
  type FileContent,
  type Submission,
  type SubmissionBody,
  type SubmissionFile,
} from "../../shared/domain/lms";
import { SendPermit } from "../../shared/domain/permit";
import { CANVAS_FACE, CANVAS_USED_PERMISSIONS } from "../../shared/providers/canvas";
import { refParts, refs } from "../../shared/providers/canvas-refs";
import {
  revealSecret,
  type CredentialLease,
  type FieldOutcome,
  type LmsProvider,
  type Read,
  type Secret,
} from "../../shared/providers/provider";

import { canvasTermSetup } from "./canvas-term";
import { Id, OptionalTime, Time } from "./canvas-wire";

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
  const id = schoolIdOf(host);
  if (normalized !== host || id === null || /^[\d.]+$/.test(host)) return null;
  return {
    id,
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
      const body = (await textUpTo(response, MAX_ANSWER_BYTES).catch(() => null)) ?? "";
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

const linkTo = (header: string | null, rel: "next" | "last"): string | null =>
  header
    ?.split(",")
    .flatMap((part) => new RegExp(`<([^>]+)>\\s*;\\s*rel="${rel}"`).exec(part)?.[1] ?? [])[0] ??
  null;

const Self = v.object({ id: Id, name: v.string() });
const CourseRow = v.union([
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
const AttachmentRow = v.object({
  id: Id,
  display_name: v.string(),
  "content-type": v.nullish(v.string(), "application/octet-stream"),
  size: v.nullish(v.number(), 0),
  url: v.nullish(v.string(), null),
});
const Attachments = v.nullish(v.array(AttachmentRow), []);
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
  submission_type: v.nullish(v.string(), null),
  url: v.nullish(v.string(), null),
  preview_url: v.nullish(v.string(), null),
  attachments: Attachments,
  discussion_entries: v.nullish(v.array(v.object({ message: v.nullish(v.string(), "") })), []),
  rubric_assessment: v.nullish(
    v.record(v.string(), v.object({ points: v.nullish(v.number(), null) })),
    null,
  ),
  submission_comments: v.nullish(
    v.array(
      v.object({
        id: Id,
        author_id: Id,
        comment: v.string(),
        created_at: Time,
        attachments: Attachments,
      }),
    ),
    [],
  ),
  user: v.nullish(v.object({ name: v.string() }), null),
});
const StudentSubmissions = v.object({ submissions: v.array(SubmissionRow) });
const ConversationRow = v.object({ id: Id, subject: v.nullish(v.string(), "") });
const ConversationDetail = v.object({
  id: Id,
  subject: v.nullish(v.string(), ""),
  workflow_state: v.string(),
  context_code: v.nullish(v.string(), null),
  audience_contexts: v.nullish(
    v.object({ courses: v.nullish(v.record(v.string(), v.unknown()), {}) }),
    null,
  ),
  participants: v.array(
    v.pipe(
      v.object({ id: Id, name: v.string(), full_name: v.nullish(v.string(), null) }),
      v.transform((person) => ({ id: person.id, name: person.full_name ?? person.name })),
    ),
  ),
  messages: v.array(v.object({ id: Id, author_id: Id, body: v.string(), created_at: Time })),
});
const AnnouncementRow = v.object({
  id: Id,
  title: v.string(),
  message: v.nullish(v.string(), ""),
  posted_at: OptionalTime,
  author: v.nullish(v.object({ id: v.nullish(Id, null) }), null),
});

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const paragraphsOf = (html: string): string[] =>
  html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
      if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? entity;
      const point = name.startsWith("#x")
        ? Number.parseInt(name.slice(2), 16)
        : Number(name.slice(1));
      const valid = point <= 0x10ffff && (point < 0xd800 || point > 0xdfff);
      return valid ? String.fromCodePoint(point) : "\uFFFD";
    })
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const htmlOf = (text: string): string =>
  text
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");

const oneLine = (text: string): string =>
  text
    .replace(/\s*\n\s*/g, " ¶ ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

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

const textOf = (kind: "text" | "discussion", paragraphs: readonly string[]): SubmissionBody => ({
  kind,
  title: "",
  wordCount: paragraphs.join(" ").split(/\s+/).filter(Boolean).length,
  paragraphs,
});

const SUBMISSION_TYPES = {
  online_text_entry: "a text entry",
  discussion_topic: "a discussion post",
  online_url: "a link",
  online_upload: "an upload",
  media_recording: "a recording, which plays in Canvas",
  online_quiz: "a quiz, which Canvas grades",
  basic_lti_launch: "work in an external tool",
  external_tool: "work in an external tool",
  student_annotation: "an annotated document in Canvas",
} as const;
type SubmissionType = keyof typeof SUBMISSION_TYPES;
const isSubmissionType = (type: string): type is SubmissionType =>
  Object.hasOwn(SUBMISSION_TYPES, type);

const filesOf = (rows: v.InferOutput<typeof Attachments>): SubmissionFile[] =>
  rows.map((row) => ({
    id: String(row.id),
    name: row.display_name,
    mediaType: row["content-type"],
    bytes: row.size,
  }));

const bodyOf = (row: v.InferOutput<typeof SubmissionRow>): SubmissionBody => {
  const type = row.submission_type;
  if (type === null) {
    const paragraphs = paragraphsOf(row.body ?? "");
    return paragraphs.length === 0 ? { kind: "none" } : textOf("text", paragraphs);
  }
  if (!isSubmissionType(type))
    return { kind: "elsewhere", title: "", what: `a ${type.replaceAll("_", " ")} submission` };
  const elsewhere = { kind: "elsewhere", title: "", what: SUBMISSION_TYPES[type] } as const;
  switch (type) {
    case "online_text_entry": {
      const paragraphs = paragraphsOf(row.body ?? "");
      return paragraphs.length === 0 ? elsewhere : textOf("text", paragraphs);
    }
    case "discussion_topic": {
      const paragraphs = row.discussion_entries.flatMap((entry) => paragraphsOf(entry.message));
      return paragraphs.length === 0 ? elsewhere : textOf("discussion", paragraphs);
    }
    case "online_url":
      return row.url !== null && URL.parse(row.url)?.protocol === "https:"
        ? { kind: "url", title: "", url: row.url, files: filesOf(row.attachments) }
        : elsewhere;
    case "online_upload":
      return { kind: "upload", title: "", files: filesOf(row.attachments) };
    case "media_recording":
    case "online_quiz":
    case "basic_lti_launch":
    case "external_tool":
    case "student_annotation":
      return elsewhere;
  }
};

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ANSWER_BYTES = 50 * 1024 * 1024;
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 20_000;

const bytesUpTo = async (
  response: Response,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (Number(response.headers.get("content-length")) > max) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) {
    total += part.value.byteLength;
    if (total > max) {
      await reader?.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const data = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.byteLength;
  }
  return data;
};

const textUpTo = async (response: Response, max: number): Promise<string | null> => {
  const data = await bytesUpTo(response, max);
  return data && new TextDecoder().decode(data);
};

const UploadTarget = v.object({
  upload_url: v.pipe(v.string(), v.url()),
  upload_params: v.nullish(
    v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
    {},
  ),
  file_param: v.nullish(v.string(), "file"),
});
const PreAttachment = v.object({ pre_attachment: UploadTarget });
const UploadedFile = v.object({ id: Id });

const PER_PAGE = 100;
const PARALLEL_PAGES = 8;
const STUDENTS_PER_PAGE = 3;
const MAX_ROWS = 10_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const createCanvasProvider = (deps: {
  school: School;
  lease: CredentialLease;
  fetch: Fetch;
  now(): number;
  packageFile(name: string): Promise<Blob | null>;
  attachmentFile(submission: LmsRef<"submission">, name: string): Promise<Blob | null>;
}): LmsProvider => {
  const { school, lease } = deps;
  const origin = `https://${school.host}`;

  let free = PARALLEL_PAGES;
  const waiting: (() => void)[] = [];
  const slot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (free > 0) free -= 1;
    else await new Promise<void>((wake) => waiting.push(wake));
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else free += 1;
    }
  };

  const page = async (
    url: string,
    token: string,
  ): Promise<Result<{ body: unknown; link: string | null }, LmsError>> => {
    let response: Response;
    let text: string | null;
    try {
      response = await deps.fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "manual",
      });
      if (!response.ok) return { ok: false, error: await errorOf(response) };
      text = await textUpTo(response, MAX_ANSWER_BYTES);
    } catch {
      return OFFLINE;
    }
    if (text === null) return unreadable("an answer");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return unreadable("an answer");
    }
    return { ok: true, value: { body, link: response.headers.get("link") } };
  };

  const list = <T extends v.GenericSchema>(
    path: string,
    row: T,
    perPage = PER_PAGE,
  ): Read<v.InferOutput<T>[]> =>
    lease.use(async (credential) => {
      if (!credential) return { ok: false, error: { kind: "auth_expired" } };
      const secret = credential.kind === "bearer" ? credential.token : credential.access;
      const read = async (
        url: string,
      ): Promise<Result<{ rows: v.InferOutput<T>[]; link: string | null }, LmsError>> => {
        if (!URL.canParse(url) || new URL(url).origin !== origin) return unreadable("a page link");
        const result = await revealSecret(secret, (token) => page(url, token));
        if (!result.ok) return result;
        const parsed = v.safeParse(v.array(row), result.value.body);
        return parsed.success
          ? { ok: true, value: { rows: parsed.output, link: result.value.link } }
          : unreadable("a list");
      };
      const maxPages = Math.ceil(MAX_ROWS / perPage);
      const first = new URL(`${origin}/api/v1${path}`);
      first.searchParams.set("per_page", String(perPage));
      const head = await slot(() => read(first.toString()));
      if (!head.ok) return head;
      const rows = [...head.value.rows];

      const last = linkTo(head.value.link, "last");
      const count =
        last && URL.canParse(last) ? Number(new URL(last).searchParams.get("page")) : NaN;
      if (last && Number.isInteger(count) && count >= 1) {
        if (count > maxPages) return unreadable("a page link");
        const urls = Array.from({ length: count - 1 }, (_, index) => {
          const url = new URL(last);
          url.searchParams.set("page", String(index + 2));
          return url.toString();
        });
        const results: Awaited<ReturnType<typeof read>>[] = [];
        let at = 0;
        const worker = async () => {
          for (let index = at++; index < urls.length; index = at++) {
            results[index] = await slot(() => read(urls[index] ?? ""));
            if (!results[index]?.ok) at = urls.length;
          }
        };
        await Promise.all(Array.from({ length: PARALLEL_PAGES }, worker));
        for (const result of results) {
          if (!result.ok) return result;
          rows.push(...result.value.rows);
        }
        return { ok: true, value: rows };
      }

      let pages = 1;
      for (let next = linkTo(head.value.link, "next"); next !== null;) {
        if (++pages > maxPages) return unreadable("a page link");
        const result = await read(next);
        if (!result.ok) return result;
        rows.push(...result.value.rows);
        next = linkTo(result.value.link, "next");
      }
      return { ok: true, value: rows };
    });

  const one = async <T extends v.GenericSchema>(path: string, schema: T): Read<v.InferOutput<T>> =>
    lease.use(async (credential) => {
      if (!credential) return { ok: false, error: { kind: "auth_expired" } };
      const secret = credential.kind === "bearer" ? credential.token : credential.access;
      const result = await revealSecret(secret, (token) =>
        slot(() => page(`${origin}/api/v1${path}`, token)),
      );
      if (!result.ok) return result;
      const parsed = v.safeParse(schema, result.value.body);
      return parsed.success ? { ok: true, value: parsed.output } : unreadable("an answer");
    });

  let selfId: Promise<Result<number, LmsError>> | null = null;
  const me = (): Promise<Result<number, LmsError>> => {
    selfId ??= one("/users/self", Self).then((result) => {
      if (!result.ok) selfId = null;
      return result.ok ? { ok: true, value: result.value.id } : result;
    });
    return selfId;
  };

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

  const write = (
    method: "PUT" | "POST" | "DELETE",
    path: string,
    form: URLSearchParams,
  ): Promise<FieldOutcome> =>
    lease.use(async (credential): Promise<FieldOutcome> => {
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
  const refused = (reason: string): Promise<FieldOutcome> =>
    Promise.resolve({ status: "failed", error: { kind: "rejected", reason } });

  const parseJson = (text: string | null): unknown => {
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const withBearer =
    (secret: Secret) =>
    (
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

  const canvasUpload = (step: {
    path: string;
    form: URLSearchParams;
    file: Blob;
    name: string;
    targetOf: (body: unknown) => v.InferOutput<typeof UploadTarget> | null;
    onNetworkError: FieldOutcome;
    what: string;
    noAddress: string;
  }): Promise<{ ok: true; response: Response } | { ok: false; outcome: FieldOutcome }> =>
    lease.use(async (credential) => {
      if (!credential)
        return { ok: false, outcome: { status: "failed", error: { kind: "auth_expired" } } };
      const secret = credential.kind === "bearer" ? credential.token : credential.access;
      const withToken = withBearer(secret);
      const rejected = (reason: string): { ok: false; outcome: FieldOutcome } => ({
        ok: false,
        outcome: { status: "failed", error: { kind: "rejected", reason } },
      });

      let text: string | null;
      try {
        const created = await withToken(`${origin}/api/v1${step.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: step.form.toString(),
        });
        if (!created.ok)
          return { ok: false, outcome: { status: "failed", error: await errorOf(created) } };
        text = await textUpTo(created, MAX_ANSWER_BYTES);
      } catch {
        return { ok: false, outcome: step.onNetworkError };
      }

      const upload = step.targetOf(parseJson(text));
      if (!upload || URL.parse(upload.upload_url)?.protocol !== "https:")
        return rejected(step.noAddress);

      const files = new FormData();
      for (const [key, value] of Object.entries(upload.upload_params))
        files.append(key, String(value));
      files.append(upload.file_param, step.file, step.name);
      let uploaded: Response;
      try {
        uploaded = await deps.fetch(upload.upload_url, {
          method: "POST",
          body: files,
          redirect: "manual",
        });
      } catch {
        return { ok: false, outcome: step.onNetworkError };
      }
      if (uploaded.ok) return { ok: true, response: uploaded };
      if (uploaded.type === "opaqueredirect")
        return rejected("Canvas's file storage redirected the upload where the app can't follow.");
      if (uploaded.status < 300 || uploaded.status >= 400)
        return rejected(`The ${step.what} upload was refused (status ${uploaded.status}).`);

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
        return confirmed.ok
          ? { ok: true, response: confirmed }
          : { ok: false, outcome: { status: "failed", error: await errorOf(confirmed) } };
      } catch {
        return { ok: false, outcome: step.onNetworkError };
      }
    });

  const importPackage = async (
    path: string,
    form: URLSearchParams,
    file: Blob,
    name: string,
  ): Promise<FieldOutcome> => {
    const done = await canvasUpload({
      path,
      form,
      file,
      name,
      targetOf: (body) => {
        const parsed = v.safeParse(PreAttachment, body);
        return parsed.success ? parsed.output.pre_attachment : null;
      },
      onNetworkError: { status: "unknown", since: isoTime(deps.now()) },
      what: "package",
      noAddress: "Canvas started the import but gave no address to upload the package to.",
    });
    return done.ok ? { status: "landed", at: isoTime(deps.now()), via: "response" } : done.outcome;
  };

  const uploadAttachment = async (
    submissionPath: string,
    submission: LmsRef<"submission">,
    name: string,
  ): Promise<FieldOutcome> => {
    const file = await deps.attachmentFile(submission, name);
    if (!file) return refused("Choose the attachment again before sending.");
    const offlineOutcome: FieldOutcome = { status: "failed", error: OFFLINE.error };
    const params = new URLSearchParams({ name, size: String(file.size) });
    if (file.type) params.set("content_type", file.type);

    const done = await canvasUpload({
      path: `${submissionPath}/comments/files`,
      form: params,
      file,
      name,
      targetOf: (body) => {
        const parsed = v.safeParse(UploadTarget, body);
        return parsed.success ? parsed.output : null;
      },
      onNetworkError: offlineOutcome,
      what: "attachment",
      noAddress: "Canvas gave no address to upload the attachment to.",
    });
    if (!done.ok) return done.outcome;

    let uploadedText: string | null;
    try {
      uploadedText = await textUpTo(done.response, MAX_ANSWER_BYTES);
    } catch {
      return offlineOutcome;
    }
    const uploaded = v.safeParse(UploadedFile, parseJson(uploadedText));
    if (!uploaded.success)
      return refused("Canvas uploaded the file, but didn't return its file id.");

    return write(
      "PUT",
      submissionPath,
      new URLSearchParams({ "comment[file_ids][]": String(uploaded.output.id) }),
    );
  };

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

  const writeOf = (content: ChangeContent, field: FieldKey): Promise<FieldOutcome> => {
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
            return content.attachment === null
              ? refused("There is no attachment to send.")
              : uploadAttachment(at.path, content.target, content.attachment.name);
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
                      : [
                          [
                            refs.criterion({
                              school: school.id,
                              assignment: at.assignment,
                              criterion,
                            }),
                            points,
                          ],
                        ],
                  ),
                )
              : null,
            excused: row.excused,
            comments: row.submission_comments
              .filter((comment) => comment.comment !== "")
              .map((comment) => ({
                id: String(comment.id),
                mine: comment.author_id === mine.value,
                text: comment.comment,
              })),
            attachments: row.submission_comments.flatMap((comment) =>
              comment.attachments.map((attachment) => ({
                id: String(attachment.id),
                mine: comment.author_id === mine.value,
                text: attachment.display_name,
              })),
            ),
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
          const mine = await me();
          if (!mine.ok) return mine;
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
              posts: rows.value.map((row) => ({
                id: String(row.id),
                mine: row.author?.id === mine.value,
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

  const file = async (ref: LmsRef<"submission">, id: string): Read<FileContent> => {
    const at = submissionAt(ref);
    if (!at || !/^\d+$/.test(id)) return NOT_FOUND;
    const row = await one(at.path, v.object({ attachments: Attachments }));
    if (!row.ok) return row;
    const listed = row.value.attachments.find((attachment) => String(attachment.id) === id);
    if (!listed) return NOT_FOUND;
    const tooBig = {
      ok: false,
      error: {
        kind: "rejected",
        reason: `${listed.display_name} is larger than the 50 MB the app opens.`,
      },
    } as const;
    if (listed.size > MAX_FILE_BYTES) return tooBig;
    const signed = await one(`/files/${id}/public_url`, v.object({ public_url: v.string() }));
    if (!signed.ok) return signed;
    const storage = URL.parse(signed.value.public_url);
    if (storage?.protocol !== "https:") return unreadable("a file address");
    try {
      const response = await deps.fetch(storage.toString(), {});
      if (!response.ok) return { ok: false, error: await errorOf(response) };
      const data = await bytesUpTo(response, MAX_FILE_BYTES);
      if (!data) return tooBig;
      return { ok: true, value: { mediaType: listed["content-type"], data } };
    } catch {
      return OFFLINE;
    }
  };

  const linkExport = async (ref: LmsRef<"submission">): Read<FileContent> => {
    const at = submissionAt(ref);
    if (!at) return NOT_FOUND;
    const row = await one(at.path, v.object({ url: v.nullish(v.string(), null) }));
    if (!row.ok) return row;
    const exported = row.value.url === null ? null : googleExportOf(row.value.url);
    if (!exported) return NOT_FOUND;
    const refused = (reason: string) =>
      ({ ok: false, error: { kind: "rejected", reason } }) as const;
    try {
      const response = await deps.fetch(exported.url, {
        credentials: "omit",
        signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
      });
      const landed = URL.parse(response.url || exported.url);
      const type = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (!response.ok || landed?.protocol !== "https:" || type !== "application/pdf")
        return refused(`The ${exported.what} isn't shared publicly, so the app can't read it.`);
      const data = await bytesUpTo(response, MAX_EXPORT_BYTES);
      return data
        ? { ok: true, value: { mediaType: "application/pdf", data } }
        : refused(`The ${exported.what} is larger than the 20 MB the app sends to Claude.`);
    } catch {
      return OFFLINE;
    }
  };

  const conversation = async (
    id: number,
    mine: number,
  ): Promise<Result<Conversation | null, LmsError>> => {
    const detail = await one(`/conversations/${id}?auto_mark_as_read=false`, ConversationDetail);
    if (!detail.ok) return detail;
    const row = detail.value;
    const audience = Object.keys(row.audience_contexts?.courses ?? {});
    const courseCode =
      /^course_(\d+)$/.exec(row.context_code ?? "")?.[1] ??
      (audience.length === 1 ? audience[0] : undefined);
    if (courseCode === undefined || !/^\d+$/.test(courseCode)) return { ok: true, value: null };
    const names = new Map(row.participants.map((person) => [person.id, person.name]));
    return {
      ok: true,
      value: {
        ref: refs.conversation({ school: school.id, conversation: row.id }),
        school: school.id,
        course: refs.course({ school: school.id, course: Number(courseCode) }),
        subject: row.subject,
        from: row.participants.find((person) => person.id !== mine)?.name ?? "",
        students: row.participants
          .filter((person) => person.id !== mine)
          .map((person) => refs.student({ school: school.id, user: person.id })),
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
    linkExport,
    verify: async () => {
      const self = await one("/users/self", Self);
      return self.ok
        ? {
            ok: true,
            value: { displayName: self.value.name, usedPermissions: CANVAS_USED_PERMISSIONS },
          }
        : self;
    },
    courses: async () => {
      const rows = await list(
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
                  ref: refs.course({ school: school.id, course: row.id }),
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
            ref: refs.assignment({ school: school.id, course: id, assignment: row.id }),
            school: school.id,
            course,
            title: row.name,
            shortTitle: row.name,
            dueAt: row.due_at,
            pointsPossible: row.points_possible,
            rubric:
              row.rubric?.map((criterion) => ({
                ref: refs.criterion({
                  school: school.id,
                  assignment: row.id,
                  criterion: criterion.id,
                }),
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
            ref: refs.student({ school: school.id, user: row.id }),
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
        const students = await list(
          `/courses/${id}/students/submissions?student_ids[]=all&grouped=true&include[]=submission_comments&include[]=rubric_assessment&include[]=user`,
          StudentSubmissions,
          STUDENTS_PER_PAGE,
        );
        if (!students.ok) return students;
        const seen = new Set<string>();
        return {
          ok: true,
          value: students.value
            .flatMap(({ submissions }) => submissions)
            .filter((row) => {
              const key = `${row.assignment_id}:${row.user_id}`;
              return !seen.has(key) && Boolean(seen.add(key));
            })
            .map((row): Submission => ({
              ref: refs.submission({
                school: school.id,
                course: id,
                assignment: row.assignment_id,
                user: row.user_id,
              }),
              school: school.id,
              course,
              assignment: refs.assignment({
                school: school.id,
                course: id,
                assignment: row.assignment_id,
              }),
              student: refs.student({ school: school.id, user: row.user_id }),
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
                        : [
                            [
                              refs.criterion({
                                school: school.id,
                                assignment: row.assignment_id,
                                criterion,
                              }),
                              points,
                            ],
                          ],
                    ),
                  )
                : null,
              comments: row.submission_comments.map((comment) => ({
                id: String(comment.id),
                mine: comment.author_id === mine.value,
                text: comment.comment,
                at: comment.created_at,
              })),
              body: bodyOf(row),
              page:
                row.preview_url !== null && URL.parse(row.preview_url)?.origin === origin
                  ? row.preview_url
                  : null,
            })),
        };
      }),
    file,
    conversations: async () => {
      const mine = await me();
      if (!mine.ok) return mine;
      const inbox = await list("/conversations", ConversationRow);
      if (!inbox.ok) return inbox;
      const sent = await list("/conversations?scope=sent", ConversationRow);
      if (!sent.ok) return sent;
      const ids = new Set([...inbox.value, ...sent.value].map((row) => row.id));
      const out: Conversation[] = [];
      for (const id of ids) {
        const read = await conversation(id, mine.value);
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
            row.posted_at === null
              ? []
              : [
                  {
                    ref: refs.announcement({ school: school.id, announcement: row.id }),
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
    apply: async (permit) => {
      if (!SendPermit.isGenuine(permit)) return {};
      const { content, fields } = permit;
      const outcomes: Partial<Record<FieldKey, FieldOutcome>> = {};
      let unsent: FieldOutcome | null = null;
      for (const field of WRITE_ORDER.filter((key) => fields.includes(key))) {
        const outcome: FieldOutcome = unsent ?? (await writeOf(content, field));
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
