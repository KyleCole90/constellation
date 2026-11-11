import {
  FIELD_LABEL,
  type ChangeSummary,
  type ConflictChoice,
  type FieldConflict,
  type FieldKey,
} from "~/shared/domain/change";
import type { SubmissionComment } from "~/shared/domain/lms";
import type { PreviewField } from "~/shared/domain/preview";

const LANDED_WORDS: Readonly<Record<FieldKey, string>> = {
  grade: "Grade is in the gradebook.",
  rubric: "Rubric scores are in the gradebook.",
  excuse: "The excuse is in the gradebook.",
  comment: "The feedback posted.",
  attachment: "The attachment is on the submission.",
  message: "The message went out.",
  conversation: "The message went out.",
  post: "The announcement is posted.",
  copy: "The copy is on its way in the LMS.",
  value: "The setting is saved.",
  text: "The passage is rewritten.",
};
const FAILED_WORDS: Readonly<Record<FieldKey, string>> = {
  grade: "The grade did not save.",
  rubric: "The rubric scores did not save.",
  excuse: "The excuse did not save.",
  comment: "The feedback did not post.",
  attachment: "The attachment did not upload.",
  message: "The message did not send.",
  conversation: "The message did not send.",
  post: "The announcement did not post.",
  copy: "The copy did not start.",
  value: "The setting did not save.",
  text: "The passage was not rewritten.",
};
const UNKNOWN_WORDS: Readonly<Record<FieldKey, string>> = {
  grade: "We can't confirm the grade saved.",
  rubric: "We can't confirm the rubric scores saved.",
  excuse: "We can't confirm the excuse saved.",
  comment: "We can't confirm the feedback posted.",
  attachment: "We can't confirm the attachment uploaded.",
  message: "We can't confirm the message went out.",
  conversation: "We can't confirm the message went out.",
  post: "We can't confirm the announcement posted.",
  copy: "We can't confirm the copy started.",
  value: "We can't confirm the setting saved.",
  text: "We can't confirm the passage was rewritten.",
};
const NOT_WRITTEN_WORDS: Readonly<Record<FieldKey, string>> = {
  grade: "The grade was not written yet.",
  rubric: "The rubric scores were not written yet.",
  excuse: "The excuse was not written yet.",
  comment: "The feedback was not written yet.",
  attachment: "The attachment was not written yet.",
  message: "The message was not written yet.",
  conversation: "The message was not written yet.",
  post: "The announcement was not written yet.",
  copy: "The copy has not started yet.",
  value: "The setting was not written yet.",
  text: "The passage was not written yet.",
};

export const missingWords = (missing: readonly string[]): string =>
  `Fill in ${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0]} to approve.`;

/** One sentence per field, landed first, so a person reads where things stand without decoding chips. */
export const outcomeWords = (files: readonly PreviewField[]): string => {
  const words = (status: PreviewField["status"], table: Readonly<Record<FieldKey, string>>) =>
    files.filter((file) => file.status === status).map((file) => table[file.field]);
  return [
    ...words("landed", LANDED_WORDS),
    ...words("failed", FAILED_WORDS),
    ...words("unknown", UNKNOWN_WORDS),
    ...words("proposed", NOT_WRITTEN_WORDS),
    ...words("sending", NOT_WRITTEN_WORDS),
  ].join(" ");
};

export const unwritten = (files: readonly PreviewField[]): readonly PreviewField[] =>
  files.filter((file) => file.status !== "landed");
export const previewHeading = (
  fields: readonly PreviewField[],
  sent: boolean,
  host: string,
): string => {
  if (sent) return `What was sent to ${host}`;
  return fields.some((field) => field.status === "landed")
    ? `Partly sent to ${host}`
    : `What will be sent to ${host}`;
};
export const fieldCount = (count: number): string => `${count} field${count === 1 ? "" : "s"}`;

/** The button names what it will send, so nobody wonders whether the grade goes twice. */
export const retryRemainingLabel = (files: readonly PreviewField[]): string =>
  `Retry remaining: ${unwritten(files)
    .map((file) => file.label)
    .join(", ")}`;

export interface FieldChip {
  label: string;
  tone: "working" | "landed" | "failed" | "unknown" | "waiting";
}

/** Null before any send. A failure mid-retry isn't final, so it reads as retrying rather than failed. */
export const fieldChip = (
  status: PreviewField["status"],
  summary: Pick<ChangeSummary, "tone" | "banner">,
): FieldChip | null => {
  const sending = summary.tone === "working";
  switch (status) {
    case "landed":
      return { label: "Landed", tone: "landed" };
    case "sending":
      return { label: "Writing", tone: "working" };
    case "failed":
      return sending ? { label: "Retrying", tone: "working" } : { label: "Failed", tone: "failed" };
    case "unknown":
      return { label: "Unconfirmed", tone: "unknown" };
    case "proposed":
      return summary.banner === null ? null : { label: "Not written", tone: "waiting" };
  }
};

export const approvalResetWords = (reset: ChangeSummary["approvalReset"]): string | null => {
  switch (reset) {
    case "edited":
      return "You edited this after approving it, so it needs your approval again.";
    case "agent-edited":
      return "The agent edited this after you approved it, so it needs your approval again.";
    case "rebased":
      return "Conflict resolved. This is a draft again and needs a fresh approval.";
    case "revoked":
      return "You undid the approval. It needs your approval again before it can send.";
    case null:
      return null;
  }
};

export interface ConflictOption {
  choice: ConflictChoice;
  label: string;
}
const KEEP: ConflictOption = { choice: "keep-mine", label: "Keep mine" };
const THEIRS: ConflictOption = { choice: "use-theirs", label: "Use theirs" };
const ALREADY: ConflictOption = { choice: "it-landed", label: "It's already there" };

export const conflictOptions = (conflict: FieldConflict): readonly ConflictOption[] =>
  conflict.reason === "possible-own-write" ? [KEEP, THEIRS, ALREADY] : [KEEP, THEIRS];

export interface ConflictColumns {
  field: FieldKey;
  title: string;
  why: string;
  saw: string;
  now: string;
  mine: string;
}

const REASON_WORDS: Readonly<Record<FieldConflict["reason"], string>> = {
  "changed-by-other": "Someone changed this in the LMS after the draft was read.",
  "target-changed": "The student submitted again after the draft was read.",
  "possible-own-write":
    "An entry of yours is there that this draft didn't see, so this may be our own earlier write.",
  "passage-moved":
    "The passage this fix was written for is no longer where it was, so the fix has nowhere to land.",
};

const NONE = "Nothing";

export const conflictColumns = (conflict: FieldConflict): ConflictColumns => {
  const shared = {
    field: conflict.field,
    title: FIELD_LABEL[conflict.field],
    mine: conflict.mine ?? NONE,
  };
  if (conflict.reason !== "target-changed")
    return {
      ...shared,
      why: REASON_WORDS[conflict.reason],
      saw: conflict.basis ?? NONE,
      now: conflict.theirs ?? NONE,
    };
  if (conflict.field === "copy")
    return {
      ...shared,
      why: "The number of students or items in this course changed after the draft was read.",
      saw: "The course as the draft read it",
      now: "The course as it is now",
    };
  return {
    ...shared,
    why: REASON_WORDS[conflict.reason],
    saw: "The earlier attempt",
    now: "A newer attempt",
  };
};

/** The newest comment that isn't ours. It's the only record of who changed something from outside. */
export const lastOutsideNote = (comments: readonly SubmissionComment[]): string | null =>
  comments.filter((comment) => !comment.mine).at(-1)?.text ?? null;
