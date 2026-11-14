import {
  FIELD_LABEL,
  fieldsOf,
  finalGrade,
  latePenalty,
  rawScore,
  type ChangeRecord,
  type CourseCopyContent,
  type FieldKey,
  type GradeContent,
  type RemoteState,
  type SetContent,
  type TextFixContent,
} from "./change";
import { parseIsoTime, type IsoDate, type IsoTime } from "./ids";
import { paragraphAfter } from "./splice";
import { isoDate, type TermBreak, type TermDates, type Weekday } from "./term";

export type CommentEffect = "append" | "replace";

/** No body shows an old value beside a new one. A passage reads as it will read, and a note names what it replaces. */
export type PreviewBody =
  | { kind: "grade"; points: number; outOf: number }
  | { kind: "excused" }
  | {
      kind: "rubric";
      rows: readonly {
        criterion: string;
        name: string;
        points: number;
        outOf: number;
        rating: string;
      }[];
    }
  | { kind: "text"; title: string | null; text: string }
  | { kind: "attachment"; name: string; kb: number }
  | { kind: "passage"; where: string; text: string }
  | {
      kind: "copy";
      source: string;
      oldTerm: string;
      newTerm: string;
      days: readonly { from: string; to: string }[];
      breaks: readonly string[];
      occupied: { students: number; items: number } | null;
    }
  | { kind: "setting"; text: string };

export interface PreviewField {
  field: FieldKey;
  label: string;
  status: "proposed" | "sending" | "landed" | "failed" | "unknown";
  body: PreviewBody;
  /** A plain sentence about something the instructor can't see in the value itself. */
  note: string | null;
}

export const ratingLabel = (score: number, max: number): string => {
  const ratio = score / max;
  return ratio >= 0.9
    ? "Exemplary"
    : ratio >= 0.75
      ? "Proficient"
      : ratio >= 0.6
        ? "Developing"
        : "Beginning";
};

const DAY_NAMES: Readonly<Record<Weekday, string>> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};
/** Dates in the app are plain calendar days, so they format in UTC and never slide a day in some time zone. */
export const longDate = (date: IsoDate): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
/** A finding quotes what it found, and a bare ISO date reads as a date. */
export const quoteWords = (quote: string): string => {
  const date = isoDate(quote);
  return date ? longDate(date) : quote;
};
export const weekdayDate = (date: IsoDate): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const longTime = (at: IsoTime): string =>
  new Date(at).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
const span = ({ start, end }: { start: IsoDate; end: IsoDate }): string =>
  start === end ? longDate(start) : `${longDate(start)} to ${longDate(end)}`;
const termWords = (term: TermDates): string =>
  term.name === null ? span(term) : `${term.name}, ${span(term)}`;
const breakWords = (held: TermBreak): string => `${held.name}, ${span(held)}`;

const scored = (points: number | null): number => {
  if (points === null) throw new Error("A preview can't hold an unset score.");
  return points;
};

const gradeBody = (content: GradeContent, field: FieldKey): PreviewBody => {
  switch (field) {
    case "rubric":
      return {
        kind: "rubric",
        rows: (content.rubric ?? []).map((score) => ({
          criterion: score.criterion,
          name: score.name,
          points: scored(score.points),
          outOf: score.outOf,
          rating: ratingLabel(scored(score.points), score.outOf),
        })),
      };
    case "attachment":
      return {
        kind: "attachment",
        name: content.attachment?.name ?? "",
        kb: content.attachment?.kb ?? 0,
      };
    case "comment":
      return { kind: "text", title: null, text: content.comment ?? "" };
    case "excuse":
      return { kind: "excused" };
    case "grade":
    // A grade has none of these fields.
    case "message":
    case "conversation":
    case "post":
    case "copy":
    case "value":
    case "text":
      return { kind: "grade", points: scored(finalGrade(content)), outOf: content.outOf };
  }
};

const copyBody = ({ source, plan, shift }: CourseCopyContent, remote: RemoteState): PreviewBody => {
  const days = [...plan.oldTerm.days]
    .sort((a, b) => a - b)
    .map((day) => ({ from: DAY_NAMES[day], to: DAY_NAMES[shift.substitutions[day] ?? day] }));
  const occupied =
    remote.kind === "course-copy" && (remote.students > 0 || remote.items > 0)
      ? { students: remote.students, items: remote.items }
      : null;
  return {
    kind: "copy",
    source: source.kind === "course" ? `${source.label} (${source.termName})` : source.name,
    oldTerm: termWords(plan.oldTerm),
    newTerm: termWords(plan.newTerm),
    days,
    breaks: plan.breaks.map(breakWords),
    occupied,
  };
};

const settingWords = ({ where, intent }: SetContent): string => {
  switch (intent.set) {
    case "due-at":
      return `${where} is due ${longTime(intent.at)}.`;
    case "item-published":
      return `Publishes ${where}.`;
    case "item-deleted":
      return `Deletes ${where}.`;
    case "course-published":
      return "Publishes the course, so students can see it.";
    case "course-template":
      return "Marks the course as a template.";
  }
};

const passageBody = ({ where, splice }: TextFixContent, remote: RemoteState): PreviewBody => ({
  kind: "passage",
  where,
  text: paragraphAfter(remote.kind === "text-fix" ? remote.body : "", splice),
});

const bodyOf = (record: ChangeRecord, field: FieldKey): PreviewBody => {
  const { content } = record;
  switch (content.kind) {
    case "grade":
      return gradeBody(content, field);
    case "reply":
      return { kind: "text", title: null, text: content.body };
    case "message":
      return { kind: "text", title: content.subject, text: content.body };
    case "announcement":
      return { kind: "text", title: content.title, text: content.body };
    case "course-copy":
      return copyBody(content, record.basis.remote);
    case "text-fix":
      return passageBody(content, record.basis.remote);
    case "item-set":
      return { kind: "setting", text: settingWords(content) };
  }
};

const totalNote = (content: GradeContent): string | null => {
  const penalty = latePenalty(content);
  const { late } = content;
  const raw = rawScore(content);
  if (content.override != null)
    return raw === null
      ? "Your total."
      : `Your total, in place of the ${raw} the scores add up to.`;
  if (late?.waived) return "Late penalty waived.";
  return late && penalty
    ? `${raw} points, minus ${penalty} for ${late.days} day${late.days > 1 ? "s" : ""} late at ${late.pointsPerDay} per day.`
    : null;
};

const gradeNote = (
  content: GradeContent,
  remote: RemoteState,
  field: FieldKey,
  effect: CommentEffect,
): string | null => {
  if (remote.kind !== "grade") return null;
  if (field === "grade") {
    const replaced =
      remote.grade !== null && remote.grade !== finalGrade(content)
        ? `Replaces the ${remote.grade} / ${content.outOf} now in the LMS.`
        : null;
    return [totalNote(content), replaced].filter(Boolean).join(" ") || null;
  }
  if (field === "excuse" && remote.grade !== null)
    return `Replaces the ${remote.grade} / ${content.outOf} now in the LMS.`;
  if (field === "comment" && remote.comments.some((comment) => comment.mine))
    return effect === "append"
      ? "Your earlier comments stay on the submission."
      : "Replaces your earlier feedback on the submission.";
  return null;
};

const passageNote = ({ where, splice }: TextFixContent): string =>
  splice.before === "" ? `Adds the text at the end of ${where}.` : `Replaces "${splice.before}".`;

const noteFor = (record: ChangeRecord, field: FieldKey, effect: CommentEffect): string | null => {
  const { content } = record;
  const remote: RemoteState = record.basis.remote;
  if (record.landed.includes(field)) return null;
  switch (content.kind) {
    case "grade":
      return gradeNote(content, remote, field, effect);
    case "text-fix":
      return passageNote(content);
    case "item-set": {
      const { intent } = content;
      if (intent.set !== "due-at" || remote.kind !== "item-set" || remote.value === null)
        return null;
      const replaced = parseIsoTime(remote.value);
      return replaced !== null && replaced !== intent.at ? `Replaces ${longTime(replaced)}.` : null;
    }
    case "reply":
    case "message":
    case "announcement":
    case "course-copy":
      return null;
  }
};

const statusOf = (record: ChangeRecord, field: FieldKey): PreviewField["status"] => {
  if (record.landed.includes(field)) return "landed";
  const { state } = record;
  if (
    state.tag !== "sending" &&
    state.tag !== "held" &&
    state.tag !== "conflicted" &&
    state.tag !== "sent"
  )
    return "proposed";
  const run = state.run.fields[field];
  switch (run?.status) {
    case "landed":
    case "failed":
    case "unknown":
      return run.status;
    case "pending":
    case undefined:
      return state.tag === "sending" ? "sending" : "proposed";
  }
};

/** What the send will write, read from the content the approval fingerprint covers. */
export const previewOf = (record: ChangeRecord, effect: CommentEffect): readonly PreviewField[] =>
  fieldsOf(record.content).map((field) => ({
    field,
    label: FIELD_LABEL[field],
    status: statusOf(record, field),
    body: bodyOf(record, field),
    note: noteFor(record, field, effect),
  }));
