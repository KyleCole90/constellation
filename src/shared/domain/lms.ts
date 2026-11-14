import type { IsoTime, LmsRef, SchoolHost, SchoolId } from "./ids";

type ProviderKind = "fake-canvas" | "canvas";

export interface School {
  id: SchoolId;
  abbr: string;
  name: string;
  host: SchoolHost;
  provider: ProviderKind;
}

/** A demo school runs on the fake LMS. A new provider has to pick a side here. */
const DEMO_PROVIDER: Readonly<Record<ProviderKind, boolean>> = {
  "fake-canvas": true,
  canvas: false,
};

export const isDemoSchool = (school: School): boolean => DEMO_PROVIDER[school.provider];

/** The one order schools take in every list and filter: by name. */
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
  /** The student's own posts on a graded discussion, oldest first. */
  | { kind: "discussion"; title: string; wordCount: number; paragraphs: readonly string[] }
  | { kind: "media"; title: string; durationLabel: string; transcript: readonly string[] }
  /** A link, with any snapshot the LMS took of the page. */
  | { kind: "url"; title: string; url: string; files: readonly SubmissionFile[] }
  | { kind: "upload"; title: string; files: readonly SubmissionFile[] }
  /** Work the app can't read here, such as a quiz or an external tool. `what` names it for the teacher. */
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
  /** Mirrors the LMS, so a resubmission reads as submitted with its prior grade still present. */
  workflow: "unsubmitted" | "missing" | "submitted" | "graded" | "excused";
  attempt: number;
  lateDays: number;
  submittedAt: IsoTime | null;
  grade: number | null;
  rubricScores: Readonly<Record<string, number>> | null;
  comments: readonly SubmissionComment[];
  body: SubmissionBody;
  /** The LMS's own `https:` page for this submission, which opens in the browser. */
  page: string | null;
}

/** The text a rationale can anchor to: paragraphs of writing or posts, or the transcript of a recording. */
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

/** How a file reaches the teacher and Claude: a PDF, a picture, or words. */
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
/** The app's own caps on what it sends Claude, kept under Anthropic's limits with room for base64. */
const MAX_IMAGE_BYTES = 5 * MB;
const MAX_CLAUDE_BYTES = 20 * MB;

export const claudeBlockFor = (file: Pick<SubmissionFile, "mediaType">): FileView | null =>
  CLAUDE_READS[file.mediaType] ?? null;

/** Types main reads the words out of, so the app and Claude get them as Markdown text (#68). */
const MAIN_READS_AS_TEXT = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
  "text/rtf",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

export const mainReadsAsText = (mediaType: string): boolean => MAIN_READS_AS_TEXT.has(mediaType);

/** What the app can show of a listed file, once main has read it: null when it can't open it at all. */
export const viewOf = (file: Pick<SubmissionFile, "mediaType">): FileView | null =>
  claudeBlockFor(file) ?? (mainReadsAsText(file.mediaType) ? "text" : null);

const sizeLabel = (bytes: number): string =>
  bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(1)} MB`;

/** A file's type and size as a teacher reads them: "PDF, 4 KB". */
export const fileLabel = (file: Pick<SubmissionFile, "name" | "mediaType" | "bytes">): string => {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1];
  return `${extension ? extension.toUpperCase() : file.mediaType}, ${sizeLabel(file.bytes)}`;
};

/**
 * Why Claude can't draft a grade from this submission, or null when it can read everything the student turned in.
 * The one rule that keeps a draft from scoring work it never saw as nothing (#64): every caller that offers or runs
 * a grade draft asks here first. A download that fails later is refused where the files are read.
 */
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
      return "Claude can't open links, so it can't draft this one. Open the link and grade it yourself.";
    case "elsewhere":
      return `This is ${body.what}, which Claude can't read here. Grade it yourself.`;
    case "upload":
      return body.files.length === 0
        ? "No file came with this upload, so Claude can't draft it. Grade it yourself."
        : unreadableFiles(body.files);
  }
};

/**
 * `kindOf` defaults to what main can turn a listed file into. Main's own last check passes `claudeBlockFor`, since
 * the bytes it sends Claude must already be what Claude reads.
 */
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
  // A Word file's size is mostly what main leaves out, so only the files sent as they are count.
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
  unread: boolean;
  messages: readonly ConversationMessage[];
}

/** Unread and the last word isn't mine. A reply isn't reused the way a sent grade is, so opening an answered one would draft another. */
export const awaitsReply = (conversation: Conversation): boolean =>
  conversation.unread && conversation.messages.at(-1)?.mine !== true;

export interface Announcement {
  ref: LmsRef<"announcement">;
  school: SchoolId;
  course: LmsRef<"course">;
  title: string;
  body: string;
  postedAt: IsoTime;
}
