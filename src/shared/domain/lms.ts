import type { IsoTime, LmsRef, SchoolHost, SchoolId } from "./ids";

type ProviderKind = "fake-canvas" | "canvas";

export interface School {
  id: SchoolId;
  abbr: string;
  name: string;
  host: SchoolHost;
  provider: ProviderKind;
}

const DEMO_PROVIDER: Readonly<Record<ProviderKind, boolean>> = {
  "fake-canvas": true,
  canvas: false,
};

export const isDemoSchool = (school: School): boolean => DEMO_PROVIDER[school.provider];

export const canResetDemo = (schools: readonly School[]): boolean =>
  schools.length > 0 && schools.every(isDemoSchool);

export const bySchoolName = (a: School, b: School): number => a.name.localeCompare(b.name);

export interface Student {
  ref: LmsRef<"student">;
  school: SchoolId;
  course: LmsRef<"course">;
  name: string;
}

export interface Course {
  ref: LmsRef<"course">;
  school: SchoolId;
  code: string;
  title: string;
  section: string | null;
  modality: string | null;
  studentCount: number;
}

interface RubricCriterion {
  ref: LmsRef<"criterion">;
  name: string;
  maxPoints: number;
}

export interface Assignment {
  ref: LmsRef<"assignment">;
  school: SchoolId;
  course: LmsRef<"course">;
  title: string;
  shortTitle: string;
  dueAt: IsoTime | null;
  pointsPossible: number;
  rubric: readonly RubricCriterion[] | null;
  latePointsPerDay: number | null;
}

export interface SubmissionFile {
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
}

export interface FileContent {
  mediaType: string;
  data: Uint8Array<ArrayBuffer>;
}

export type SubmissionBody =
  | { kind: "text"; title: string; wordCount: number; paragraphs: readonly string[] }
  | { kind: "discussion"; title: string; wordCount: number; paragraphs: readonly string[] }
  | { kind: "media"; title: string; durationLabel: string; transcript: readonly string[] }
  | { kind: "url"; title: string; url: string; files: readonly SubmissionFile[] }
  | { kind: "upload"; title: string; files: readonly SubmissionFile[] }
  | { kind: "elsewhere"; title: string; what: string }
  | { kind: "none" };

export interface SubmissionComment {
  id: string;
  mine: boolean;
  text: string;
  at: IsoTime;
}

export interface Submission {
  ref: LmsRef<"submission">;
  school: SchoolId;
  course: LmsRef<"course">;
  assignment: LmsRef<"assignment">;
  student: LmsRef<"student">;
  studentName: string;
  workflow: "unsubmitted" | "missing" | "submitted" | "graded" | "excused";
  attempt: number;
  lateDays: number;
  submittedAt: IsoTime | null;
  grade: number | null;
  rubricScores: Readonly<Record<LmsRef<"criterion">, number>> | null;
  comments: readonly SubmissionComment[];
  body: SubmissionBody;
  page: string | null;
}

export const resubmitted = (submission: Pick<Submission, "workflow" | "grade">): boolean =>
  submission.workflow === "submitted" && submission.grade !== null;

export const passagesOf = (submission: Submission): readonly string[] => {
  switch (submission.body.kind) {
    case "text":
    case "discussion":
      return submission.body.paragraphs;
    case "media":
      return submission.body.transcript;
    case "url":
    case "upload":
    case "elsewhere":
    case "none":
      return [];
  }
};

const wordsIn = (paragraphs: readonly string[]): number =>
  paragraphs.join(" ").split(/\s+/).filter(Boolean).length;

export const excerptNote = (body: SubmissionBody): string | null => {
  switch (body.kind) {
    case "text":
    case "discussion":
      return wordsIn(body.paragraphs) < body.wordCount ? "Excerpts" : null;
    case "media":
      return "Auto transcript, excerpts";
    case "url":
    case "upload":
    case "elsewhere":
    case "none":
      return null;
  }
};

export type FileView = "document" | "image" | "text";

const CLAUDE_READS: Readonly<Record<string, FileView>> = {
  "application/pdf": "document",
  "text/plain": "text",
  "text/markdown": "text",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
};
const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * MB;
const MAX_CLAUDE_BYTES = 20 * MB;

export const claudeBlockFor = (file: Pick<SubmissionFile, "mediaType">): FileView | null =>
  CLAUDE_READS[file.mediaType] ?? null;

const MAIN_READS_AS_TEXT = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
  "text/rtf",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

export const mainReadsAsText = (mediaType: string): boolean => MAIN_READS_AS_TEXT.has(mediaType);

export const viewOf = (file: Pick<SubmissionFile, "mediaType">): FileView | null =>
  claudeBlockFor(file) ?? (mainReadsAsText(file.mediaType) ? "text" : null);

const sizeLabel = (bytes: number): string =>
  bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(1)} MB`;

export const fileLabel = (file: Pick<SubmissionFile, "name" | "mediaType" | "bytes">): string => {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1];
  return `${extension ? extension.toUpperCase() : file.mediaType}, ${sizeLabel(file.bytes)}`;
};

const GOOGLE_EXPORTS = {
  document: { what: "Google Doc", path: "export?format=pdf" },
  presentation: { what: "Google Slides deck", path: "export/pdf" },
  spreadsheets: { what: "Google Sheet", path: "export?format=pdf" },
} as const;
const GOOGLE_FILE =
  /^https?:\/\/docs\.google\.com\/(document|presentation|spreadsheets)\/(?:u\/\d+\/)?d\/([\w-]+)(?:[/?#]|$)/i;

export const googleExportOf = (url: string): { what: string; url: string } | null => {
  const [, kind, id] = GOOGLE_FILE.exec(url.trim()) ?? [];
  if (!id || (kind !== "document" && kind !== "presentation" && kind !== "spreadsheets"))
    return null;
  const { what, path } = GOOGLE_EXPORTS[kind];
  return { what, url: `https://docs.google.com/${kind}/d/${id}/${path}` };
};

export const snapshotOf = (body: Extract<SubmissionBody, { kind: "url" }>): SubmissionFile | null =>
  body.files.find((file) => claudeBlockFor(file) === "image" && file.bytes <= MAX_IMAGE_BYTES) ??
  null;

export const linkReads = (
  body: Extract<SubmissionBody, { kind: "url" }>,
): readonly ("export" | "snapshot")[] => [
  ...(googleExportOf(body.url) ? (["export"] as const) : []),
  ...(snapshotOf(body) ? (["snapshot"] as const) : []),
];

export const undraftableReason = (body: SubmissionBody): string | null => {
  switch (body.kind) {
    case "text":
    case "discussion":
    case "none":
      return null;
    case "media":
      return body.transcript.length > 0
        ? null
        : "This recording has no transcript, so Claude can't draft it. Grade it yourself.";
    case "url":
      return linkReads(body).length > 0
        ? null
        : "Claude can't open this link, and Canvas took no snapshot of it. Open the link and grade it yourself.";
    case "elsewhere":
      return `This is ${body.what}, which Claude can't read here. Grade it yourself.`;
    case "upload":
      return body.files.length === 0
        ? "No file came with this upload, so Claude can't draft it. Grade it yourself."
        : unreadableFiles(body.files);
  }
};

export const unreadableFiles = (
  files: readonly Omit<SubmissionFile, "id">[],
  kindOf: (file: Pick<SubmissionFile, "mediaType">) => FileView | null = viewOf,
): string | null => {
  const unread = files.find((file) => kindOf(file) === null);
  if (unread)
    return `Claude can't read ${unread.name} (${fileLabel(unread)}), so it can't draft this one. Grade it yourself.`;
  const big = files.find((file) => kindOf(file) === "image" && file.bytes > MAX_IMAGE_BYTES);
  if (big)
    return `${big.name} is larger than the 5 MB picture the app sends to Claude. Grade it yourself.`;
  const sent = files.filter((file) => kindOf(file) !== "text");
  if (sent.reduce((sum, file) => sum + file.bytes, 0) > MAX_CLAUDE_BYTES)
    return "These files are larger than the 20 MB the app sends to Claude at once. Grade it yourself.";
  return null;
};

export interface ConversationMessage {
  id: string;
  mine: boolean;
  author: string;
  text: string;
  at: IsoTime;
}

export interface Conversation {
  ref: LmsRef<"conversation">;
  school: SchoolId;
  course: LmsRef<"course">;
  subject: string;
  from: string;
  students: readonly LmsRef<"student">[];
  unread: boolean;
  messages: readonly ConversationMessage[];
}

export const awaitsReply = (
  last: Pick<ConversationMessage, "mine" | "at"> | null | undefined,
  repliedAt: IsoTime | null,
): boolean => last?.mine === false && (repliedAt === null || repliedAt < last.at);

export interface Announcement {
  ref: LmsRef<"announcement">;
  school: SchoolId;
  course: LmsRef<"course">;
  title: string;
  body: string;
  postedAt: IsoTime;
}

const TITLE_FILLER = new Set(["a", "an", "the", "of", "and", "to", "your", "my", "own", "create"]);
const wordsOf = (text: string): readonly string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const namesAssignment = (text: string, assignment: Pick<Assignment, "title">): boolean => {
  const telling = wordsOf(assignment.title).filter((word) => !TITLE_FILLER.has(word));
  const words = new Set(wordsOf(text));
  return telling.length > 0 && telling.every((word) => words.has(word));
};

export const namingAssignment = <M extends { subject: string; body: string }>(
  message: M,
  assignment: Pick<Assignment, "title">,
): M =>
  namesAssignment(`${message.subject}\n${message.body}`, assignment)
    ? message
    : { ...message, body: `${message.body.trimEnd()}\n\nAssignment: ${assignment.title}` };

export const askedInLms = (
  conversations: readonly Conversation[],
  submission: Submission,
  assignment: Pick<Assignment, "title">,
): IsoTime | null => {
  let last: IsoTime | null = null;
  for (const conversation of conversations) {
    const opening = conversation.messages[0];
    if (
      !opening?.mine ||
      conversation.course !== submission.course ||
      !conversation.students.includes(submission.student) ||
      !namesAssignment(`${conversation.subject}\n${opening.text}`, assignment)
    )
      continue;
    const at = opening.at;
    if ((submission.submittedAt === null || at >= submission.submittedAt) && (!last || at > last))
      last = at;
  }
  return last;
};
