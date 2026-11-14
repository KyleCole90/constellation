import type { ChangeId, IsoTime, LmsRef, Result, SchoolId } from "./ids";
import { ApprovalWitness, fingerprintOf, type Approval, type RiskKey } from "./approval";
import type { CourseCopyContent, SetContent, SetIntent, TextFixContent } from "./content";
import { applySplice, spliceState } from "./splice";
import type { DateShiftOptions, TermPlan } from "./term";

// ---- What a change proposes. Vendor neutral. Hashing this is what an approval covers. ----

export interface RubricScore {
  criterion: LmsRef<"criterion">;
  name: string;
  points: number | null;
  outOf: number;
}
export interface LatePenalty {
  days: number;
  pointsPerDay: number;
  /** An extension or a documented absence. The penalty stays on the draft so the teacher sees what was waived. */
  waived: boolean;
}
export interface AttachmentDraft {
  name: string;
  kb: number;
}
export interface GradeContent {
  kind: "grade";
  target: LmsRef<"submission">;
  /** Used when there is no rubric. With a rubric the raw score is the rubric total. */
  points: number | null;
  outOf: number;
  rubric: readonly RubricScore[] | null;
  late: LatePenalty | null;
  comment: string | null;
  attachment: AttachmentDraft | null;
  /** The teacher's total, sent as the grade in place of the scores minus the late penalty. A score edit or an excuse clears it. */
  override: number | null;
  /** A documented absence. Holds no score: `applyPatch` clears the scores when it sets this, and a score or an override clears it. */
  excused: boolean;
}
interface ReplyContent {
  kind: "reply";
  target: LmsRef<"conversation">;
  body: string;
}
/** Starts a new conversation with the submission's student, about its assignment, without touching the grade. */
interface MessageContent {
  kind: "message";
  target: LmsRef<"submission">;
  subject: string;
  body: string;
}
interface AnnouncementContent {
  kind: "announcement";
  target: LmsRef<"course">;
  title: string;
  body: string;
}
export type ChangeContent =
  | GradeContent
  | ReplyContent
  | MessageContent
  | AnnouncementContent
  | CourseCopyContent
  | TextFixContent
  | SetContent;
export type { CourseCopyContent, SetContent, TextFixContent };

/** What an agent may draft or edit. A copy's dates and a setting's value are confirmed by a person in the setup screens. */
export type AgentContent = Exclude<ChangeContent, CourseCopyContent | SetContent>;
export const isAgentContent = (content: ChangeContent): content is AgentContent =>
  content.kind !== "course-copy" && content.kind !== "item-set";

/** One open change per slot. A grade and a message on the same submission are separate work. */
export const slotOf = ({ kind, target }: Pick<ChangeContent, "kind" | "target">): string =>
  `${kind}:${target}`;
export const sameSlot = (
  a: Pick<ChangeContent, "kind" | "target">,
  b: Pick<ChangeContent, "kind" | "target">,
): boolean => slotOf(a) === slotOf(b);

/**
 * Set fields replace a value. Append fields add an entry, so replaying one would duplicate it.
 * A splice field rewrites one passage, and the passage itself says whether it landed.
 */
const FIELD_MODE = {
  grade: "set",
  rubric: "set",
  excuse: "set",
  comment: "append",
  attachment: "append",
  message: "append",
  conversation: "append",
  post: "append",
  copy: "append",
  value: "set",
  text: "splice",
} as const;
export type FieldKey = keyof typeof FIELD_MODE;
/** An append field adds an entry each time it is written, so sending it twice posts twice. */
export const appendsEntry = (field: FieldKey): boolean => FIELD_MODE[field] === "append";

export const fieldsOf = (content: ChangeContent): readonly FieldKey[] => {
  switch (content.kind) {
    case "grade": {
      const fields: FieldKey[] = [];
      if (content.excused) fields.push("excuse");
      else {
        if (finalGrade(content) !== null) fields.push("grade");
        if (content.rubric && rawScore(content) !== null) fields.push("rubric");
      }
      if (content.comment !== null) fields.push("comment");
      if (content.attachment) fields.push("attachment");
      return fields;
    }
    case "reply":
      return ["message"];
    case "message":
      return ["conversation"];
    case "announcement":
      return ["post"];
    case "course-copy":
      return ["copy"];
    case "text-fix":
      return ["text"];
    case "item-set":
      return ["value"];
  }
};
export const withoutFloatNoise = (score: number): number => Math.round(score * 1e6) / 1e6;

export const rawScore = (content: GradeContent): number | null => {
  if (!content.rubric) return content.points;
  const total = content.rubric.reduce<number | null>(
    (sum, r) => (sum === null || r.points === null ? null : sum + r.points),
    0,
  );
  return total === null ? null : withoutFloatNoise(total);
};
export const latePenalty = (content: GradeContent): number =>
  content.late && !content.late.waived ? content.late.days * content.late.pointsPerDay : 0;
/** What the grade field sends. A draft saved before overrides existed has no `override`, which reads as none. */
export const finalGrade = (content: GradeContent): number | null => {
  if (content.override != null) return content.override;
  const raw = rawScore(content);
  return raw === null ? null : withoutFloatNoise(Math.max(0, raw - latePenalty(content)));
};
export const scoredRubricPoints = (
  rubric: readonly RubricScore[],
): Readonly<Record<string, number>> =>
  Object.fromEntries(rubric.flatMap((r) => (r.points === null ? [] : [[r.criterion, r.points]])));

export const unfilled = (content: ChangeContent): readonly string[] => {
  switch (content.kind) {
    case "grade":
      if (content.excused || finalGrade(content) !== null) return [];
      return content.rubric
        ? content.rubric.filter((r) => r.points === null).map((r) => r.name)
        : content.points === null
          ? ["Score"]
          : [];
    case "reply":
      return content.body.trim() ? [] : ["Reply"];
    case "message":
      return content.body.trim() ? [] : ["Message"];
    case "announcement":
      return [
        ...(content.title.trim() ? [] : ["Title"]),
        ...(content.body.trim() ? [] : ["Announcement"]),
      ];
    case "text-fix":
      return content.splice.after.trim() ? [] : ["New text"];
    case "course-copy":
    case "item-set":
      return [];
  }
};

export const FIELD_LABEL: Readonly<Record<FieldKey, string>> = {
  grade: "Grade",
  rubric: "Rubric scores",
  excuse: "Excused",
  comment: "Feedback",
  attachment: "Attachment",
  message: "Reply",
  conversation: "Message",
  post: "Announcement",
  copy: "Course copy",
  value: "Setting",
  text: "Passage",
};

export type ChangePatch =
  | {
      kind: "grade";
      rubricPoints?: Readonly<Record<string, number | null>>;
      points?: number | null;
      comment?: string | null;
      attachment?: AttachmentDraft | null;
      excused?: boolean;
      override?: number | null;
      lateWaived?: boolean;
    }
  | { kind: "reply" | "message"; body: string }
  | { kind: "announcement"; title?: string; body?: string }
  | { kind: "course-copy"; plan?: TermPlan; shift?: DateShiftOptions }
  | { kind: "text-fix"; after: string }
  | { kind: "item-set"; at: IsoTime };

// ---- What the LMS holds right now, in neutral terms. Providers report this and decide nothing. ----

export interface RemoteEntry {
  id: string;
  mine: boolean;
  text: string;
}
/** targetVersion changes when the target itself moved: a new attempt, or a student writing again. */
export type RemoteState =
  | {
      kind: "grade";
      targetVersion: string;
      grade: number | null;
      rubric: Readonly<Record<string, number>> | null;
      excused: boolean;
      comments: readonly RemoteEntry[];
      attachments: readonly RemoteEntry[];
    }
  /** For a message, `messages` opens each conversation with the student about this assignment, matched by subject. */
  | { kind: "reply" | "message"; targetVersion: string; messages: readonly RemoteEntry[] }
  | { kind: "announcement"; targetVersion: string; posts: readonly RemoteEntry[] }
  /** `students` and `items` are what a copy would land on top of. Either above zero makes the change risky. */
  | {
      kind: "course-copy";
      targetVersion: string;
      students: number;
      items: number;
      migrations: readonly RemoteEntry[];
    }
  | { kind: "text-fix"; targetVersion: string; body: string }
  /** `value` is the current reading of whatever the intent sets, in the same words `fieldText` would write. */
  | { kind: "item-set"; targetVersion: string; value: string | null };

export interface Basis {
  readAt: IsoTime;
  remote: RemoteState;
}

/** Read from the basis, which the fingerprint covers, so a later read that changes the counts also makes the approval stale. */
export const riskOf = ({ basis: { remote } }: Pick<ChangeRecord, "basis">): RiskKey | null =>
  remote.kind === "course-copy" && (remote.students > 0 || remote.items > 0)
    ? (`students:${remote.students}|items:${remote.items}` as RiskKey)
    : null;

type ConflictReason =
  | "changed-by-other"
  | "target-changed"
  | "possible-own-write"
  | "passage-moved";
export interface FieldConflict {
  field: FieldKey;
  reason: ConflictReason;
  basis: string | null;
  theirs: string | null;
  mine: string | null;
}
export type FieldDecision =
  | { do: "already-there" }
  | { do: "write" }
  | { do: "conflict"; conflict: FieldConflict };

/**
 * Pure, and the only place duplicate and conflict rules exist, so a new provider inherits them.
 * Set fields check desired first, so a retry reads its own earlier write as success rather than someone else's change.
 * Append fields look for my entries missing from `seen`, the ids present when the send first started.
 * A fresh entry of mine with different text may be my write after the LMS normalized it, so it never auto-posts.
 */
export const classify = (
  content: ChangeContent,
  basis: Basis,
  remote: RemoteState,
  seen: Seen,
): Readonly<Partial<Record<FieldKey, FieldDecision>>> =>
  Object.fromEntries(
    fieldsOf(content).map((field) => [
      field,
      classifyField(content, field, basis.remote, remote, seen),
    ]),
  );

const classifyField = (
  content: ChangeContent,
  field: FieldKey,
  basis: RemoteState,
  remote: RemoteState,
  seen: Seen,
): FieldDecision => {
  switch (FIELD_MODE[field]) {
    case "set":
      return classifySet(content, field, basis, remote);
    case "append":
      return classifyAppend(content, field, basis, remote, seen);
    case "splice":
      return classifySplice(content, field, remote);
  }
};

const targetMoved = (
  field: FieldKey,
  content: ChangeContent,
  basis: RemoteState,
  remote: RemoteState,
): FieldDecision => ({
  do: "conflict",
  conflict: {
    field,
    reason: "target-changed",
    basis: basis.targetVersion,
    theirs: remote.targetVersion,
    mine: fieldText(content, field),
  },
});

const sameNumbers = (
  a: Readonly<Record<string, number>> | null,
  b: Readonly<Record<string, number>> | null,
): boolean => {
  if (a === null || b === null) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const classifySet = (
  content: ChangeContent,
  field: FieldKey,
  basis: RemoteState,
  remote: RemoteState,
): FieldDecision => {
  if (content.kind === "item-set") return classifyValue(content, field, basis, remote);
  if (content.kind !== "grade" || remote.kind !== "grade" || basis.kind !== "grade")
    throw new Error("set fields exist only on grades");
  if (field === "excuse") return classifyExcuse(content, basis, remote);
  const isGrade = field === "grade";
  const desired = isGrade ? null : scoredRubricPoints(content.rubric ?? []);
  if (isGrade ? remote.grade === finalGrade(content) : sameNumbers(remote.rubric, desired))
    return { do: "already-there" };
  if (remote.targetVersion !== basis.targetVersion)
    return targetMoved(field, content, basis, remote);
  const unchanged = isGrade
    ? remote.grade === basis.grade && !(remote.excused && !basis.excused)
    : sameNumbers(remote.rubric, basis.rubric);
  if (unchanged) return { do: "write" };
  const conflict: FieldConflict = isGrade
    ? {
        field,
        reason: "changed-by-other",
        basis: gradeText(basis),
        theirs: gradeText(remote),
        mine: fieldText(content, field),
      }
    : {
        field,
        reason: "changed-by-other",
        basis: rubricText(content, basis.rubric),
        theirs: rubricText(content, remote.rubric),
        mine: fieldText(content, field),
      };
  return { do: "conflict", conflict };
};

const classifyExcuse = (
  content: GradeContent,
  basis: Extract<RemoteState, { kind: "grade" }>,
  remote: Extract<RemoteState, { kind: "grade" }>,
): FieldDecision => {
  if (remote.excused) return { do: "already-there" };
  if (remote.targetVersion !== basis.targetVersion)
    return targetMoved("excuse", content, basis, remote);
  // A basis saved before excuses existed has no `excused`, which reads as not excused.
  if (!basis.excused && remote.grade === basis.grade) return { do: "write" };
  return {
    do: "conflict",
    conflict: {
      field: "excuse",
      reason: "changed-by-other",
      basis: gradeText(basis),
      theirs: gradeText(remote),
      mine: fieldText(content, "excuse"),
    },
  };
};

/** One plain value, in the same order as a grade: desired first, so a retry reads its own write as done. */
const classifyValue = (
  content: SetContent,
  field: FieldKey,
  basis: RemoteState,
  remote: RemoteState,
): FieldDecision => {
  if (remote.kind !== "item-set" || basis.kind !== "item-set")
    throw new Error("a value field reads an item-set remote");
  const mine = fieldText(content, field);
  if (remote.value === mine) return { do: "already-there" };
  if (remote.targetVersion !== basis.targetVersion)
    return targetMoved(field, content, basis, remote);
  if (remote.value === basis.value) return { do: "write" };
  return {
    do: "conflict",
    conflict: { field, reason: "changed-by-other", basis: basis.value, theirs: remote.value, mine },
  };
};

/** The passage says whether it landed, so the target version is not consulted and a neighbor's fix leaves this one valid. */
const classifySplice = (
  content: ChangeContent,
  field: FieldKey,
  remote: RemoteState,
): FieldDecision => {
  if (content.kind !== "text-fix" || remote.kind !== "text-fix")
    throw new Error("splice fields exist only on text fixes");
  const { splice } = content;
  switch (spliceState(remote.body, splice)) {
    case "already-there":
      return { do: "already-there" };
    case "ready":
      return { do: "write" };
    case "moved":
      return {
        do: "conflict",
        conflict: {
          field,
          reason: "passage-moved",
          basis: splice.prefix + splice.before + splice.suffix,
          theirs: null,
          mine: splice.after,
        },
      };
  }
};

const classifyAppend = (
  content: ChangeContent,
  field: FieldKey,
  basis: RemoteState,
  remote: RemoteState,
  seen: Seen,
): FieldDecision => {
  const known = new Set(seen[field] ?? []);
  const fresh = appendEntries(remote, field).filter((entry) => entry.mine && !known.has(entry.id));
  const mine = fieldText(content, field);
  if (fresh.some((entry) => sameText(entry.text, mine))) return { do: "already-there" };
  const other = fresh[0];
  if (other)
    return {
      do: "conflict",
      conflict: { field, reason: "possible-own-write", basis: null, theirs: other.text, mine },
    };
  if (remote.targetVersion !== basis.targetVersion)
    return targetMoved(field, content, basis, remote);
  return { do: "write" };
};

const appendEntries = (remote: RemoteState, field: FieldKey): readonly RemoteEntry[] => {
  switch (remote.kind) {
    case "grade":
      return field === "attachment" ? remote.attachments : remote.comments;
    case "reply":
    case "message":
      return remote.messages;
    case "announcement":
      return remote.posts;
    case "course-copy":
      return remote.migrations;
    case "text-fix":
    case "item-set":
      return [];
  }
};

/** An LMS may normalize whitespace on the way in, and that must not read as someone else's text. */
const sameText = (a: string, b: string): boolean =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
const numberText = (value: number | null): string | null => (value === null ? null : String(value));
const gradeText = (remote: Extract<RemoteState, { kind: "grade" }>): string | null =>
  remote.excused ? "Excused" : numberText(remote.grade);
const rubricText = (
  content: GradeContent,
  scores: Readonly<Record<string, number>> | null,
): string | null =>
  scores === null
    ? null
    : (content.rubric ?? []).map((r) => `${r.name} ${scores[r.criterion] ?? "(none)"}`).join(", ");

/** The value a field would write, as display text. Also what entries are matched against. */
export const fieldText = (content: ChangeContent, field: FieldKey): string => {
  switch (content.kind) {
    case "grade":
      if (field === "grade") return String(finalGrade(content) ?? "");
      if (field === "excuse") return "Excused";
      if (field === "rubric")
        return rubricText(content, scoredRubricPoints(content.rubric ?? [])) ?? "";
      if (field === "attachment") return content.attachment?.name ?? "";
      return content.comment ?? "";
    case "reply":
    case "message":
      return content.body;
    case "announcement":
      return `${content.title}\n\n${content.body}`;
    case "course-copy":
      return copySignature(content);
    case "text-fix":
      return content.splice.after;
    case "item-set":
      return intentText(content.intent);
  }
};

/**
 * Equals the migration's signature the LMS reports, so a change finds its job by text alone. Only the source: Canvas
 * doesn't echo a job's date shift back, and `seen` already keeps an earlier job from passing as this one.
 */
export const copySignature = ({ source }: Pick<CourseCopyContent, "source">): string =>
  source.kind === "course" ? source.ref : `cartridge:${source.name}`;

/** Also the words a provider reports as the current value, so the two compare as plain strings. */
const intentText = (intent: SetIntent): string => {
  switch (intent.set) {
    case "due-at":
      return intent.at;
    case "item-published":
    case "course-published":
      return "published";
    case "item-deleted":
      return "deleted";
    case "course-template":
      return "template";
  }
};

/** Entry ids per append field, taken once before anything is written. A new entry of mine that isn't here came from a send. */
export type Seen = Readonly<Record<string, readonly string[]>>;

export const seenOf = (remote: RemoteState): Seen => {
  const ids = (entries: readonly RemoteEntry[]) => entries.map((entry) => entry.id);
  switch (remote.kind) {
    case "grade":
      return { comment: ids(remote.comments), attachment: ids(remote.attachments) };
    case "reply":
      return { message: ids(remote.messages) };
    case "message":
      return { conversation: ids(remote.messages) };
    case "announcement":
      return { post: ids(remote.posts) };
    case "course-copy":
      return { copy: ids(remote.migrations) };
    case "text-fix":
    case "item-set":
      return {};
  }
};

export type LmsError =
  | { kind: "auth_expired" }
  | { kind: "forbidden"; missingScope: string | null }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "not_found" }
  | { kind: "rejected"; reason: string }
  | { kind: "unavailable"; status: number | null }
  /** The request may have applied. Only a later read can say. */
  | { kind: "lost_response" }
  | { kind: "unsupported"; capability: string };

export type FieldRun =
  | { status: "pending" }
  | { status: "landed"; at: IsoTime; via: "response" | "observed" | "user" }
  | { status: "failed"; error: LmsError }
  | { status: "unknown"; since: IsoTime };

export interface SendRun {
  attempt: number;
  startedAt: IsoTime;
  fields: Readonly<Partial<Record<FieldKey, FieldRun>>>;
  /** Epoch ms. Set while waiting out a 429 or a retry delay, so the UI can say why nothing is moving. */
  waitingUntil: number | null;
}

type HoldCause =
  | { tag: "reconnect" }
  | { tag: "forbidden"; missingScope: string | null }
  | { tag: "failed"; error: LmsError; retriesExhausted: boolean }
  | { tag: "rejected"; reason: string }
  /** A response was lost and a settle-window read still could not confirm it. Resuming is a human press. */
  | { tag: "in-doubt"; since: IsoTime }
  /** The tab went away mid-send. Boot only reads, and a human press resumes. */
  | { tag: "interrupted"; since: IsoTime };

/**
 * The approval rule is the shape of this union. `sending` and `held` cannot exist without an approval,
 * and `draft` has no approval field, so an edited change cannot still read as approved.
 */
type ChangeState =
  | { tag: "draft"; approvalReset: null | "edited" | "agent-edited" | "rebased" | "revoked" }
  | { tag: "approved"; approval: Approval }
  | { tag: "sending"; approval: Approval; run: SendRun }
  | { tag: "held"; approval: Approval; run: SendRun; cause: HoldCause }
  /** No approval: resolving a conflict changes what would be written, so it always needs a fresh one. */
  | { tag: "conflicted"; run: SendRun; conflicts: readonly FieldConflict[] }
  | { tag: "sent"; approval: Approval; run: SendRun; at: IsoTime }
  | { tag: "discarded"; at: IsoTime };

export type ActivityActor = "you" | "agent" | "writeback";
interface ActivityEntry {
  at: IsoTime;
  actor: ActivityActor;
  text: string;
}

/** Local reasoning shown beside the document. Outside the fingerprint and never written to the LMS. */
export interface PassageAnchor {
  paragraph: number;
  start: number;
  end: number;
}
export interface Rationale {
  field: string;
  why: string;
  anchors: readonly PassageAnchor[];
}
/** `Rationale.field` for a score with no rubric criterion behind it. */
export const OVERALL_RATIONALE = "overall";

const scoreFor = (content: ChangeContent, field: string): number | null | undefined => {
  if (content.kind !== "grade") return undefined;
  if (field === OVERALL_RATIONALE) return content.points;
  return content.rubric?.find((score) => score.criterion === field)?.points;
};

export interface ChangeRecord {
  id: ChangeId;
  school: SchoolId;
  course: LmsRef<"course">;
  subject: string;
  content: ChangeContent;
  basis: Basis;
  /** Fields already in the LMS from an earlier partial send. Their values are the new baseline. */
  landed: readonly FieldKey[];
  /** Set when the first send starts, and kept through every edit, conflict and discard, because a write can land after any of them. */
  seen: Seen | null;
  rationale: readonly Rationale[];
  /** The comment as the agent last wrote it. An excuse drops the comment while it still reads this way, because the agent wrote it for a score. */
  agentComment: string | null;
  state: ChangeState;
  /** Appended only by `transition`, so it cannot disagree with state. */
  activity: readonly ActivityEntry[];
}

// ---- Events. Screens get UserEvent. The store adds HostEvent. Only the writeback runner gets RunEvent. ----

export type ConflictChoice = "keep-mine" | "use-theirs" | "it-landed";
export type UserEvent =
  | { type: "edit"; by: "you"; patch: ChangePatch; at: IsoTime }
  | { type: "approve"; witness: ApprovalWitness; at: IsoTime }
  | { type: "revoke"; at: IsoTime }
  | { type: "discard"; at: IsoTime };

/** The store sends these. An agent's edit has to say so, and resolving a conflict carries a read of the LMS that a screen can't vouch for. */
type HostEvent =
  | { type: "edit"; by: "agent"; patch: ChangePatch; at: IsoTime }
  | {
      type: "resolve-conflict";
      choices: Readonly<Partial<Record<FieldKey, ConflictChoice>>>;
      remote: RemoteState;
      at: IsoTime;
    }
  | { type: "annotate"; rationale: Rationale; at: IsoTime };

type RunEvent =
  | { type: "begin-send"; seen: Seen; at: IsoTime }
  | { type: "field-outcomes"; outcomes: SendRun["fields"]; at: IsoTime }
  | { type: "wait"; until: number }
  | { type: "hold"; cause: HoldCause; at: IsoTime }
  | { type: "conflict"; conflicts: readonly FieldConflict[]; at: IsoTime }
  | { type: "finish"; at: IsoTime }
  | { type: "interrupt"; at: IsoTime }
  /** A read-only look found fields already in the LMS. Writes nothing, and finishes the change if nothing is left. */
  | { type: "confirm"; outcomes: SendRun["fields"]; at: IsoTime };

export type ChangeEvent = UserEvent | HostEvent | RunEvent;

export type Rejection =
  | "incomplete"
  | "not-editable"
  | "field-already-landed"
  | "stale-approval"
  | "needs-confirmation"
  | "needs-review"
  | "not-approved"
  | "not-sendable"
  | "not-sending"
  | "not-conflicted";

/**
 * A grade no agent drafted, edited, or explained. Only this may be approved by the chord, without the preview.
 * A zero or a grade with no comment stops at the preview first, since one keystroke shouldn't send either. An excuse has neither by design.
 */
export const sendsOnChord = ({ content, rationale, activity }: ChangeRecord): boolean =>
  content.kind === "grade" &&
  rationale.length === 0 &&
  activity.every(({ actor }) => actor !== "agent") &&
  (content.excused || (finalGrade(content) !== 0 && Boolean(content.comment?.trim())));

/** The activity entries that put your words in the change. Approving, undoing and resolving a conflict are yours too, but write nothing. */
const YOUR_WORDS: ReadonlySet<string> = new Set(["Started", "Edited", "Edited, approval reset"]);

export const editedByYou = ({ activity }: ChangeRecord): boolean =>
  activity.some(({ actor, text }) => actor === "you" && YOUR_WORDS.has(text));

const commentOf = (content: ChangeContent): string | null =>
  content.kind === "grade" ? content.comment : null;

export const newChangeRecord = (
  init: Pick<ChangeRecord, "id" | "school" | "course" | "subject" | "content" | "basis"> & {
    at: IsoTime;
    by: ActivityActor;
  },
): ChangeRecord => ({
  id: init.id,
  school: init.school,
  course: init.course,
  subject: init.subject,
  content: init.content,
  basis: init.basis,
  landed: [],
  seen: null,
  rationale: [],
  agentComment: init.by === "agent" ? commentOf(init.content) : null,
  state: { tag: "draft", approvalReset: null },
  activity: [{ at: init.at, actor: init.by, text: init.by === "agent" ? "Drafted" : "Started" }],
});

/** Takes out what this school's LMS can't accept, so a change never carries a field that could only fail. */
export const fitContent = (
  content: ChangeContent,
  can: { rubricWrite: boolean; attachments: boolean },
): ChangeContent => {
  if (content.kind !== "grade") return content;
  return {
    ...content,
    rubric: can.rubricWrite ? content.rubric : null,
    points: can.rubricWrite || !content.rubric ? content.points : rawScore(content),
    attachment: can.attachments ? content.attachment : null,
  };
};

/** One click on missing work: every criterion at 0 on a rubric, otherwise a score of 0. */
export const zeroPatch = (content: GradeContent): ChangePatch =>
  content.rubric
    ? {
        kind: "grade",
        rubricPoints: Object.fromEntries(content.rubric.map((r) => [r.criterion, 0])),
      }
    : { kind: "grade", points: 0 };

export const applyPatch = (content: ChangeContent, patch: ChangePatch): ChangeContent | null => {
  if (content.kind === "grade" && patch.kind === "grade") {
    const scores = patch.rubricPoints;
    const rescored = scores !== undefined || patch.points !== undefined;
    const excused = patch.excused ?? (rescored || patch.override != null ? false : content.excused);
    const patched: GradeContent = {
      ...content,
      excused,
      override:
        excused || rescored
          ? null
          : patch.override === undefined
            ? content.override
            : patch.override,
      late:
        content.late && patch.lateWaived !== undefined
          ? { ...content.late, waived: patch.lateWaived }
          : content.late,
      rubric:
        content.rubric && scores
          ? content.rubric.map((r) => {
              const points = scores[r.criterion];
              return { ...r, points: points === undefined ? r.points : points };
            })
          : content.rubric,
      points: content.rubric || patch.points === undefined ? content.points : patch.points,
      comment:
        patch.comment === undefined
          ? content.comment
          : patch.comment?.trim()
            ? patch.comment
            : null,
      attachment: patch.attachment === undefined ? content.attachment : patch.attachment,
    };
    if (!excused) return patched;
    return {
      ...patched,
      points: null,
      rubric: patched.rubric?.map((r) => ({ ...r, points: null })) ?? null,
    };
  }
  if ((content.kind === "reply" || content.kind === "message") && patch.kind === content.kind)
    return { ...content, body: patch.body };
  if (content.kind === "announcement" && patch.kind === "announcement")
    return { ...content, title: patch.title ?? content.title, body: patch.body ?? content.body };
  if (content.kind === "course-copy" && patch.kind === "course-copy")
    return { ...content, plan: patch.plan ?? content.plan, shift: patch.shift ?? content.shift };
  if (content.kind === "text-fix" && patch.kind === "text-fix")
    return { ...content, splice: { ...content.splice, after: patch.after } };
  // Only a due date has a value to edit. The other intents are a single choice, so the patch has nothing to say.
  if (content.kind === "item-set" && patch.kind === "item-set")
    return content.intent.set === "due-at"
      ? { ...content, intent: { set: "due-at", at: patch.at } }
      : null;
  return null;
};

const landedFieldsOf = (run: SendRun): readonly FieldKey[] =>
  (Object.keys(run.fields) as FieldKey[]).filter((field) => run.fields[field]?.status === "landed");

/** Moves what a run landed into the baseline, so a later conflict check compares against the value now in the LMS. */
const absorbRun = (record: ChangeRecord, run: SendRun, at: IsoTime): ChangeRecord => {
  const fresh = landedFieldsOf(run).filter((field) => !record.landed.includes(field));
  if (fresh.length === 0) return record;
  return {
    ...record,
    landed: [...record.landed, ...fresh],
    basis: {
      readAt: at,
      remote: fresh.reduce(
        (remote, field) => withLanded(remote, record.content, field),
        record.basis.remote,
      ),
    },
  };
};

const withLanded = (remote: RemoteState, content: ChangeContent, field: FieldKey): RemoteState => {
  const entry: RemoteEntry = { id: `landed:${field}`, mine: true, text: fieldText(content, field) };
  switch (remote.kind) {
    case "grade":
      if (content.kind !== "grade") return remote;
      if (field === "grade") return { ...remote, grade: finalGrade(content), excused: false };
      if (field === "excuse") return { ...remote, grade: null, rubric: null, excused: true };
      if (field === "rubric")
        return { ...remote, rubric: scoredRubricPoints(content.rubric ?? []) };
      return field === "attachment"
        ? { ...remote, attachments: [...remote.attachments, entry] }
        : { ...remote, comments: [...remote.comments, entry] };
    case "reply":
    case "message":
      return { ...remote, messages: [...remote.messages, entry] };
    case "announcement":
      return { ...remote, posts: [...remote.posts, entry] };
    case "course-copy":
      return { ...remote, migrations: [...remote.migrations, entry] };
    case "text-fix":
      return content.kind === "text-fix"
        ? { ...remote, body: applySplice(remote.body, content.splice) }
        : remote;
    case "item-set":
      return { ...remote, value: entry.text };
  }
};

/** A field that might still land has to be settled by Check again or a Resume before the change can be reworked. */
export const mayStillLand = (run: SendRun): boolean =>
  Object.values(run.fields).some((field) => field.status === "unknown");

const emptyRun = (at: IsoTime): SendRun => ({
  attempt: 0,
  startedAt: at,
  fields: {},
  waitingUntil: null,
});

/**
 * `seen` for a change about to send for the first time. A discarded change that started sending may still have a
 * write on its way, so the next draft of that target keeps watching for it, until a later send settles the target.
 */
export const seenForFirstSend = (
  records: readonly ChangeRecord[],
  content: ChangeContent,
  remote: RemoteState,
): Seen => {
  const onTarget = records.filter((record) => sameSlot(record.content, content));
  const lastSent = onTarget.reduce(
    (latest, { state }) => (state.tag === "sent" && state.at > latest ? state.at : latest),
    "",
  );
  const abandoned = onTarget
    .filter(({ state, seen }) => state.tag === "discarded" && state.at > lastSent && seen !== null)
    .at(-1);
  return abandoned?.seen ?? seenOf(remote);
};

/** "Post mine anyway" means the entries there now aren't this change's write, so they stop being suspects. */
const withKeptEntries = (
  seen: Seen | null,
  fields: readonly FieldKey[],
  remote: RemoteState,
): Seen | null => {
  if (seen === null) return null;
  const next: Record<string, readonly string[]> = { ...seen };
  for (const field of fields)
    next[field] = [
      ...new Set([
        ...(next[field] ?? []),
        ...appendEntries(remote, field).map((entry) => entry.id),
      ]),
    ];
  return next;
};

const outcomeText = (field: FieldKey, run: FieldRun): string | null => {
  switch (run.status) {
    case "landed":
      return `${FIELD_LABEL[field]} landed`;
    case "failed":
      return `${FIELD_LABEL[field]} failed (${run.error.kind})`;
    case "unknown":
      return `${FIELD_LABEL[field]} unconfirmed`;
    case "pending":
      return null;
  }
};

const HOLD_TEXT: Readonly<Record<HoldCause["tag"], string>> = {
  reconnect: "Held: the connection expired",
  forbidden: "Held: the LMS refused this token",
  failed: "Held: the send failed",
  rejected: "Held: the LMS rejected this change",
  "in-doubt": "Held: could not confirm whether it landed",
  interrupted: "Held: the send was interrupted",
};

const useTheirs = (content: ChangeContent, field: FieldKey, remote: RemoteState): ChangeContent => {
  if (content.kind !== "grade" || remote.kind !== "grade") return content;
  switch (field) {
    // Rubric scores set the grade, so keeping their grade means not sending the rubric either.
    case "grade":
      if (remote.excused)
        return {
          ...content,
          excused: true,
          override: null,
          rubric: null,
          points: null,
          late: null,
        };
      return {
        ...content,
        override: null,
        rubric: null,
        points: remote.grade ?? rawScore(content),
        late: null,
      };
    case "excuse":
      return {
        ...content,
        excused: false,
        override: null,
        rubric: null,
        points: remote.grade,
        late: null,
      };
    case "rubric": {
      const theirs = remote.rubric ?? {};
      return {
        ...content,
        rubric: (content.rubric ?? []).map((r) => ({
          ...r,
          points: theirs[r.criterion] ?? r.points,
        })),
      };
    }
    case "comment":
      return { ...content, comment: null };
    case "attachment":
      return { ...content, attachment: null };
    // A grade has none of these fields.
    case "message":
    case "conversation":
    case "post":
    case "copy":
    case "value":
    case "text":
      return content;
  }
};

/**
 * The only way a change moves. Pure.
 * - edit from approved, held, or draft goes to draft. Coming from approved or held records approvalReset.
 * - approve only from draft, and the witness must cover this change's current fingerprint.
 * - begin-send only from approved or held, and only while the approval's fingerprint still matches.
 * - hold and conflict also accept approved and held, because the first observe can fail before begin-send.
 * - resolve-conflict only from conflicted, always to draft, or to discarded if nothing is left to write.
 */
export function transition(
  record: ChangeRecord,
  event: ChangeEvent,
): Result<ChangeRecord, Rejection> {
  const { state } = record;
  const ok = (
    next: ChangeRecord,
    at: IsoTime | null,
    actor: ActivityActor,
    text: string | null,
  ): Result<ChangeRecord, Rejection> => ({
    ok: true,
    value:
      at !== null && text !== null
        ? { ...next, activity: [...next.activity, { at, actor, text }] }
        : next,
  });
  const fail = (error: Rejection): Result<ChangeRecord, Rejection> => ({ ok: false, error });

  switch (event.type) {
    case "edit": {
      if (state.tag !== "draft" && state.tag !== "approved" && state.tag !== "held")
        return fail("not-editable");
      if (state.tag === "held" && mayStillLand(state.run)) return fail("not-editable");
      const base = state.tag === "held" ? absorbRun(record, state.run, event.at) : record;
      const { patch } = event;
      const dropsAgentComment =
        patch.kind === "grade" &&
        patch.excused === true &&
        patch.comment === undefined &&
        !base.landed.includes("comment") &&
        commentOf(base.content) === base.agentComment;
      const content = applyPatch(
        base.content,
        dropsAgentComment ? { ...patch, comment: null } : patch,
      );
      if (content === null) return fail("not-editable");
      const moved = base.landed.filter(
        (field) => fieldText(base.content, field) !== fieldText(content, field),
      );
      if (moved.some((field) => FIELD_MODE[field] !== "set")) return fail("field-already-landed");
      const approvalReset =
        state.tag === "draft"
          ? state.approvalReset
          : event.by === "agent"
            ? "agent-edited"
            : "edited";
      const text = state.tag === "draft" ? "Edited" : "Edited, approval reset";
      const subject =
        content.kind === "announcement" && content.title.trim()
          ? content.title.trim()
          : base.subject;
      return ok(
        {
          ...base,
          subject,
          content,
          agentComment:
            event.by === "agent" && patch.kind === "grade" && patch.comment !== undefined
              ? commentOf(content)
              : base.agentComment,
          landed: base.landed.filter((field) => !moved.includes(field)),
          // A reason explains one score, so it goes when that score changes.
          rationale: base.rationale.filter(
            ({ field }) => scoreFor(base.content, field) === scoreFor(content, field),
          ),
          state: { tag: "draft", approvalReset },
        },
        event.at,
        event.by,
        text,
      );
    }
    case "approve": {
      if (state.tag !== "draft") return fail("not-editable");
      if (unfilled(record.content).length > 0) return fail("incomplete");
      const fingerprint = fingerprintOf(record);
      if (
        !ApprovalWitness.isGenuine(event.witness) ||
        !event.witness.covers(record.id, fingerprint)
      )
        return fail("stale-approval");
      const risk = riskOf(record);
      if (risk !== null && !event.witness.acknowledges(record.id, risk))
        return fail("needs-confirmation");
      if (event.witness.via === "chord" && !sendsOnChord(record)) return fail("needs-review");
      return ok(
        {
          ...record,
          state: {
            tag: "approved",
            approval: { changeId: record.id, fingerprint, at: event.at, via: event.witness.via },
          },
        },
        event.at,
        "you",
        "Approved",
      );
    }
    case "revoke": {
      if (state.tag !== "approved" && state.tag !== "held") return fail("not-editable");
      if (state.tag === "held" && mayStillLand(state.run)) return fail("not-editable");
      const base = state.tag === "held" ? absorbRun(record, state.run, event.at) : record;
      return ok(
        { ...base, state: { tag: "draft", approvalReset: "revoked" } },
        event.at,
        "you",
        "Approval revoked",
      );
    }
    case "discard": {
      if (state.tag === "sending" || state.tag === "sent" || state.tag === "discarded")
        return fail("not-editable");
      return ok(
        { ...record, state: { tag: "discarded", at: event.at } },
        event.at,
        "you",
        "Discarded",
      );
    }
    case "annotate": {
      const rationale = [
        ...record.rationale.filter((r) => r.field !== event.rationale.field),
        event.rationale,
      ];
      return ok({ ...record, rationale }, null, "agent", null);
    }
    case "resolve-conflict": {
      if (state.tag !== "conflicted") return fail("not-conflicted");
      const base = absorbRun(record, state.run, event.at);
      let content = base.content;
      const landed = new Set(base.landed);
      for (const { field } of state.conflicts) {
        const choice = event.choices[field] ?? "keep-mine";
        if (choice === "keep-mine") continue;
        if (choice === "use-theirs") content = useTheirs(content, field, event.remote);
        // A dropped comment simply leaves fieldsOf, and can come back. Anything else we stop writing joins `landed`.
        if (fieldsOf(content).includes(field)) landed.add(field);
      }
      const left = fieldsOf(content).filter((field) => !landed.has(field));
      const kept = state.conflicts
        .filter(
          ({ field }) =>
            (event.choices[field] ?? "keep-mine") === "keep-mine" && FIELD_MODE[field] === "append",
        )
        .map(({ field }) => field);
      const next = {
        ...base,
        content,
        landed: [...landed],
        seen: withKeptEntries(base.seen, kept, event.remote),
        basis: { readAt: event.at, remote: event.remote },
      };
      if (left.length === 0)
        return ok(
          { ...next, state: { tag: "discarded", at: event.at } },
          event.at,
          "you",
          "Conflict resolved, nothing left to write",
        );
      return ok(
        { ...next, state: { tag: "draft", approvalReset: "rebased" } },
        event.at,
        "you",
        "Conflict resolved, needs a fresh approval",
      );
    }
    case "begin-send": {
      if (state.tag === "draft") return fail("not-approved");
      if (state.tag !== "approved" && state.tag !== "held") return fail("not-sendable");
      if (unfilled(record.content).length > 0) return fail("not-sendable");
      if (state.approval.fingerprint !== fingerprintOf(record)) return fail("stale-approval");
      const prior = state.tag === "held" && state.run.attempt > 0 ? state.run : null;
      const fields = Object.fromEntries(
        fieldsOf(record.content)
          .filter((field) => !record.landed.includes(field))
          .map((field) => {
            const run = prior?.fields[field];
            return [field, run?.status === "landed" ? run : ({ status: "pending" } as const)];
          }),
      );
      const run: SendRun = {
        attempt: (prior?.attempt ?? 0) + 1,
        startedAt: event.at,
        fields,
        waitingUntil: null,
      };
      return ok(
        {
          ...record,
          seen: record.seen ?? event.seen,
          state: { tag: "sending", approval: state.approval, run },
        },
        event.at,
        "writeback",
        prior ? `Retry, attempt ${run.attempt}` : "Sending",
      );
    }
    case "field-outcomes": {
      if (state.tag !== "sending") return fail("not-sending");
      const fields = { ...state.run.fields, ...event.outcomes };
      const text = (Object.keys(event.outcomes) as FieldKey[])
        .map((field) => {
          const run = event.outcomes[field];
          return run ? outcomeText(field, run) : null;
        })
        .filter((line) => line !== null)
        .join(", ");
      return ok(
        { ...record, state: { ...state, run: { ...state.run, fields, waitingUntil: null } } },
        event.at,
        "writeback",
        text || null,
      );
    }
    case "wait": {
      if (state.tag !== "sending") return fail("not-sending");
      return ok(
        { ...record, state: { ...state, run: { ...state.run, waitingUntil: event.until } } },
        null,
        "writeback",
        null,
      );
    }
    case "hold": {
      if (state.tag !== "approved" && state.tag !== "held" && state.tag !== "sending")
        return fail("not-sending");
      const run =
        state.tag === "approved" ? emptyRun(event.at) : { ...state.run, waitingUntil: null };
      return ok(
        { ...record, state: { tag: "held", approval: state.approval, run, cause: event.cause } },
        event.at,
        "writeback",
        HOLD_TEXT[event.cause.tag],
      );
    }
    case "conflict": {
      if (state.tag !== "approved" && state.tag !== "held" && state.tag !== "sending")
        return fail("not-sending");
      const run =
        state.tag === "approved" ? emptyRun(event.at) : { ...state.run, waitingUntil: null };
      return ok(
        { ...record, state: { tag: "conflicted", run, conflicts: event.conflicts } },
        event.at,
        "writeback",
        "Changed in the LMS since the draft. Nothing was written",
      );
    }
    case "finish": {
      if (state.tag !== "sending") return fail("not-sending");
      return ok(
        {
          ...record,
          state: {
            tag: "sent",
            approval: state.approval,
            run: { ...state.run, waitingUntil: null },
            at: event.at,
          },
        },
        event.at,
        "writeback",
        "Sent",
      );
    }
    case "interrupt": {
      if (state.tag !== "sending") return fail("not-sending");
      const cause: HoldCause = { tag: "interrupted", since: event.at };
      return ok(
        {
          ...record,
          state: {
            tag: "held",
            approval: state.approval,
            run: { ...state.run, waitingUntil: null },
            cause,
          },
        },
        event.at,
        "writeback",
        HOLD_TEXT.interrupted,
      );
    }
    case "confirm": {
      if (state.tag !== "held") return fail("not-sendable");
      const run = { ...state.run, fields: { ...state.run.fields, ...event.outcomes } };
      const left = fieldsOf(record.content).filter(
        (field) => !record.landed.includes(field) && run.fields[field]?.status !== "landed",
      );
      if (left.length === 0)
        return ok(
          { ...record, state: { tag: "sent", approval: state.approval, run, at: event.at } },
          event.at,
          "writeback",
          "Confirmed in the LMS. Sent",
        );
      return ok(
        { ...record, state: { ...state, run } },
        event.at,
        "writeback",
        "Checked the LMS: still unconfirmed",
      );
    }
  }
}

// ---- What screens read. Derived, so no screen knows a vendor or a state machine. ----

type Recovery = "reconnect" | "retry" | "resume" | "resolve-conflict" | "rescan" | "edit" | "none";
/** Which designed banner the panel shows. A screen picks a banner from this and never reads the state machine. */
type RecoveryBanner =
  | "reconnect"
  | "forbidden"
  | "conflict"
  | "partial"
  | "in-doubt"
  | "interrupted"
  | "rejected"
  | "failed";
export interface ChangeSummary {
  label: string;
  tone: "todo" | "approval" | "ready" | "working" | "attention" | "done";
  recovery: Recovery;
  banner: RecoveryBanner | null;
  canEdit: boolean;
  canApprove: boolean;
  canSend: boolean;
  canUndoApproval: boolean;
  canDiscard: boolean;
  missing: readonly string[];
  /** Why the change is stuck, in words. */
  reason: string | null;
  retriesExhausted: boolean;
  /** Who reset the approval, so the panel and the chat can name them. */
  approvalReset: Extract<ChangeState, { tag: "draft" }>["approvalReset"];
  approvedAt: IsoTime | null;
  sentAt: IsoTime | null;
  conflicts: readonly FieldConflict[];
  /** Epoch ms the send is waiting until. */
  waitingUntil: number | null;
  /** The school's token is the only thing in the way. Set by the store, which knows about connections. */
  waitingOnReconnect: boolean;
}

const QUIET: Omit<ChangeSummary, "label" | "tone" | "recovery"> = {
  banner: null,
  canEdit: false,
  canApprove: false,
  canSend: false,
  canUndoApproval: false,
  canDiscard: false,
  missing: [],
  reason: null,
  retriesExhausted: false,
  approvalReset: null,
  approvedAt: null,
  sentAt: null,
  conflicts: [],
  waitingUntil: null,
  waitingOnReconnect: false,
};

export const summarize = (record: ChangeRecord): ChangeSummary => {
  const { state } = record;
  switch (state.tag) {
    case "draft": {
      const missing = unfilled(record.content);
      if (missing.length > 0)
        return {
          ...QUIET,
          label: "In progress",
          tone: "todo",
          recovery: "none",
          canEdit: true,
          canDiscard: true,
          missing,
          approvalReset: state.approvalReset,
        };
      return {
        ...QUIET,
        label: state.approvalReset
          ? "Needs approval again"
          : record.activity[0]?.actor !== "agent"
            ? "Draft. Not sent"
            : editedByYou(record)
              ? "AI draft, edited by you. Not sent"
              : "AI draft. Not sent",
        tone: "approval",
        recovery: "none",
        canEdit: true,
        canApprove: true,
        canDiscard: true,
        approvalReset: state.approvalReset,
      };
    }
    case "approved":
      return {
        ...QUIET,
        label: "Ready to send",
        tone: "ready",
        recovery: "none",
        canEdit: true,
        canSend: true,
        canUndoApproval: true,
        canDiscard: true,
        approvedAt: state.approval.at,
      };
    case "sending":
      return {
        ...QUIET,
        label: state.run.waitingUntil === null ? "Sending" : "Waiting on the LMS",
        tone: "working",
        recovery: "none",
        approvedAt: state.approval.at,
        waitingUntil: state.run.waitingUntil,
      };
    case "conflicted": {
      // A moved passage has no "theirs" to pick. A fresh scan reads the item again and drafts the fix where the text now sits.
      const moved = state.conflicts.some(({ reason }) => reason === "passage-moved");
      return {
        ...QUIET,
        label: moved ? "The passage moved" : "Changed in the LMS",
        tone: "attention",
        recovery: moved ? "rescan" : "resolve-conflict",
        banner: "conflict",
        canDiscard: true,
        conflicts: state.conflicts,
      };
    }
    case "sent":
      return {
        ...QUIET,
        label: "Sent",
        tone: "done",
        recovery: "none",
        approvedAt: state.approval.at,
        sentAt: state.at,
      };
    case "discarded":
      return { ...QUIET, label: "Discarded", tone: "done", recovery: "none" };
    case "held": {
      const settled = !mayStillLand(state.run);
      return {
        ...summarizeHold(state.cause, landedFieldsOf(state.run).length > 0),
        canEdit: settled,
        canSend: true,
        canUndoApproval: settled,
        canDiscard: true,
        approvedAt: state.approval.at,
      };
    }
  }
};

const summarizeHold = (cause: HoldCause, partial: boolean): ChangeSummary => {
  switch (cause.tag) {
    case "reconnect":
      return {
        ...QUIET,
        label: "Reconnect to send",
        tone: "attention",
        recovery: "reconnect",
        banner: "reconnect",
      };
    case "forbidden":
      return {
        ...QUIET,
        label: "Token lacks permission",
        tone: "attention",
        recovery: "reconnect",
        banner: "forbidden",
        reason: cause.missingScope
          ? `The token is missing the ${cause.missingScope} permission.`
          : "The LMS refused this token.",
      };
    case "failed":
      return {
        ...QUIET,
        label: partial ? "Partly sent" : "Send failed",
        tone: "attention",
        recovery: "retry",
        banner: partial ? "partial" : "failed",
        reason: errorWords(cause.error),
        retriesExhausted: cause.retriesExhausted,
      };
    case "rejected":
      return {
        ...QUIET,
        label: "Rejected by the LMS",
        tone: "attention",
        recovery: "edit",
        banner: "rejected",
        reason: cause.reason,
      };
    case "in-doubt":
      return {
        ...QUIET,
        label: "Could not confirm",
        tone: "attention",
        recovery: "resume",
        banner: "in-doubt",
      };
    case "interrupted":
      return {
        ...QUIET,
        label: "Interrupted",
        tone: "attention",
        recovery: "resume",
        banner: "interrupted",
      };
  }
};

export const errorWords = (error: LmsError): string => {
  switch (error.kind) {
    case "auth_expired":
      return "The token expired.";
    case "forbidden":
      return "The LMS refused this token.";
    case "rate_limited":
      return "The LMS asked us to slow down.";
    case "not_found":
      return "The LMS could not find this item any more.";
    case "rejected":
      return error.reason;
    case "unavailable":
      return error.status === null
        ? "The LMS did not answer."
        : `The LMS returned an error (${error.status}).`;
    case "lost_response":
      return "The LMS never answered, and a later read could not confirm the write.";
    case "unsupported":
      return `This school's LMS does not support ${error.capability}.`;
  }
};
