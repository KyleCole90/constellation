import * as v from "valibot";
import { lateOf } from "~/shared/domain/blank";
import {
  type ChangeContent,
  type ChangePatch,
  type ChangeRecord,
  type GradeContent,
  type RubricScore,
} from "~/shared/domain/change";
import type { CourseContent } from "~/shared/domain/content";
import type { ChangeId, IsoTime, LmsRef, Result, SchoolId } from "~/shared/domain/ids";
import {
  passagesOf,
  type Announcement,
  type Assignment,
  type Conversation,
  type Course,
  type School,
  type Submission,
} from "~/shared/domain/lms";
import { FINDING_TYPES, type Finding, type FindingType } from "~/shared/domain/scan";
import type { TermDates, TermPlan } from "~/shared/domain/term";
import { isRecord } from "~/shared/is-record";

export type HandoffWork =
  | { kind: "announcement"; topic?: string }
  | { kind: "replies" }
  | { kind: "reply"; conversation: LmsRef<"conversation"> }
  | { kind: "grading"; assignment: LmsRef<"assignment"> };

export type Source =
  | { kind: "course"; ref: LmsRef<"course"> }
  | { kind: "assignment"; ref: LmsRef<"assignment"> }
  | { kind: "announcement"; ref: LmsRef<"announcement"> }
  | { kind: "conversation"; ref: LmsRef<"conversation"> }
  | { kind: "submission"; ref: LmsRef<"submission"> }
  | { kind: "change"; ref: ChangeId }
  | { kind: "due" };

export interface AnswerLine {
  source: Source;
  title: string;
  detail?: string;
}

export interface NextWork {
  course: LmsRef<"course">;
  work: HandoffWork;
}

export type AgentEffect =
  | { type: "say"; text: string; lines?: readonly AnswerLine[]; replies?: readonly string[] }
  | { type: "decline"; text: string; lines?: readonly AnswerLine[] }
  | Raw<"limited" | "work" | "guide" | "spend">
  | {
      type: "propose";
      school: SchoolId;
      course: LmsRef<"course">;
      subject: string;
      content: ChangeContent;
    }
  | { type: "edit"; change: ChangeId; patch: ChangePatch; why: string }
  | {
      type: "annotate";
      change: ChangeId;
      field: string;
      why: string;
      quotes: readonly v.InferOutput<typeof Quote>[];
    }
  | {
      type: "finding";
      findingType: FindingType;
      item: LmsRef<"item">;
      quote: string;
      why: string;
      after: string | null;
    }
  | {
      type: "handoff";
      school: SchoolId;
      course: LmsRef<"course">;
      work: HandoffWork;
      brief: string;
      request: string;
      left?: string;
    };

export interface AgentInput {
  request: string;
  thread: { history: readonly { role: "user" | "agent"; text: string }[]; guidance?: string };
  scope: AgentScope;
  files?: readonly SubmittedFile[];
}

export interface SubmittedFile {
  name: string;
  mediaType: string;
  data: Uint8Array<ArrayBuffer>;
}
export type Standing = "On track" | "Watch" | "At risk" | "No grades yet";

export interface CourseGrades {
  course: LmsRef<"course">;
  average: number | null;
  students: readonly {
    name: string;
    percent: number | null;
    missing: number;
    standing: Standing;
  }[];
}

export interface AgentScope {
  focus: ChangeId | null;
  changes: readonly ChangeRecord[];
  submissions: readonly Submission[];
  assignments: readonly Assignment[];
  conversations: readonly Conversation[];
  courses: readonly Course[];
  scan?: ScanScope;
  northStar?: {
    announcements: readonly Announcement[];
    schools: readonly School[];
    now: IsoTime;
    next: readonly NextWork[];
    grades: readonly CourseGrades[];
    grading: {
      toGrade: readonly LmsRef<"submission">[];
      asked: readonly LmsRef<"submission">[];
    };
  };
}

type ScanPlan = Omit<TermPlan, "oldTerm"> & {
  oldTerm: TermDates | Pick<TermDates, "name">;
};
export interface ScanScope {
  content: CourseContent;
  findings: readonly Finding[];
  plan: ScanPlan;
}

export const scanScopeOf = (
  content: CourseContent,
  findings: readonly Finding[],
  plan: TermPlan,
): ScanScope => ({
  content,
  findings,
  plan: content.items.some((item) => item.dueAt !== null)
    ? plan
    : { ...plan, oldTerm: { name: plan.oldTerm.name } },
});

export const DRAFT_GRADE_REQUEST = "Draft a grade for this submission.";
export const DRAFT_REPLY_REQUEST = "Draft a reply to this conversation.";
export const DRAFT_ANNOUNCEMENT_REQUEST = "Draft an announcement for this course.";
export const DRAFT_MESSAGE_REQUEST = "Draft a message to this student about this assignment.";
export const draftAnnouncementAbout = (topic: string): string =>
  `Draft an announcement for this course about ${topic}.`;
export const FILL_GRADE_REQUEST =
  "Fill in the rest of this grade. Keep the scores and comment I already entered.";
export const SCAN_COURSE_REQUEST = "Look over this course for the new term.";

export interface Agent {
  run(input: AgentInput, signal: AbortSignal): AsyncIterable<unknown>;
}

export type AgentViolation =
  | { kind: "unknown-effect"; seen: string }
  | { kind: "malformed"; detail: string }
  | { kind: "out-of-scope"; target: string }
  | { kind: "out-of-range"; detail: string }
  | { kind: "quote-not-found"; quote: string };

const MAX_TEXT = 20_000;
const fail = (error: AgentViolation): Result<AgentEffect, AgentViolation> => ({ ok: false, error });
const clip = (value: unknown): string => String(value).slice(0, 80);

const text = (detail: string) =>
  v.pipe(
    v.string(detail),
    v.check((raw) => raw.trim().length > 0 && raw.length <= MAX_TEXT, detail),
  );
const amount = (detail: string) => v.pipe(v.number(detail), v.finite(detail));
const Items = v.array(v.unknown());

const Attachment = v.object(
  { name: text("attachment"), kb: v.pipe(amount("attachment"), v.minValue(0, "attachment")) },
  "attachment",
);

const Line = v.object({
  source: v.object({ kind: v.string(), ref: v.optional(v.string()) }),
  title: text("say line"),
  detail: v.optional(text("say line")),
});
const Replies = v.array(text("say replies"));
const Quote = v.object({ paragraph: v.pipe(v.number(), v.integer()), quote: text("quote") });

const GradeDraft = v.object({
  kind: v.literal("grade"),
  target: v.string("target"),
  points: v.nullish(amount("points"), null),
  rubric: v.optional(
    v.array(
      v.object({ criterion: v.string("rubric"), points: amount("rubric") }, "rubric"),
      "rubric",
    ),
  ),
  comment: v.nullish(text("comment"), null),
  attachment: v.nullish(Attachment, null),
});
const Content = v.variant(
  "kind",
  [
    GradeDraft,
    v.object({ kind: v.literal("reply"), target: v.string("target"), body: text("body") }),
    v.object({
      kind: v.literal("message"),
      target: v.string("target"),
      subject: text("subject or body"),
      body: text("subject or body"),
    }),
    v.object({
      kind: v.literal("announcement"),
      target: v.string("target"),
      title: text("title or body"),
      body: text("title or body"),
    }),
  ],
  (issue) => (issue.path ? `content kind ${clip(issue.input)}` : "content"),
);

const GradePatch = v.object({
  kind: v.literal("grade"),
  rubricPoints: v.exactOptional(v.record(v.string(), amount("rubricPoints"), "rubricPoints")),
  points: v.exactOptional(amount("points")),
  comment: v.exactOptional(v.nullable(text("comment"))),
  attachment: v.exactOptional(v.nullable(Attachment)),
});
const Patch = v.variant(
  "kind",
  [
    GradePatch,
    v.object({ kind: v.literal("reply"), body: text("body") }),
    v.object({ kind: v.literal("message"), body: text("body") }),
    v.object({
      kind: v.literal("announcement"),
      title: v.exactOptional(text("title")),
      body: v.exactOptional(text("body")),
    }),
    v.object({ kind: v.literal("text-fix"), after: text("after") }),
  ],
  (issue) => (issue.path ? `patch for ${clip(issue.input)}` : "patch"),
);

const Work = v.variant(
  "kind",
  [
    v.object({ kind: v.literal("announcement"), topic: v.optional(text("announcement topic")) }),
    v.object({ kind: v.literal("replies") }),
    v.object({ kind: v.literal("reply"), conversation: v.string("conversation") }),
    v.object({ kind: v.literal("grading"), assignment: v.string("assignment") }),
  ],
  (issue) => (issue.path ? `handoff work ${clip(issue.input)}` : "handoff work"),
);

const RawEffect = v.variant("type", [
  v.object({
    type: v.literal("say"),
    text: text("say text"),
    lines: v.optional(v.unknown()),
    replies: v.optional(v.unknown()),
  }),
  v.object({
    type: v.literal("decline"),
    text: text("decline text"),
    lines: v.optional(v.unknown()),
  }),
  v.object({ type: v.literal("limited"), text: text("limited text") }),
  v.object({ type: v.literal("work"), line: text("work line") }),
  v.object({
    type: v.literal("guide"),
    text: v.nullish(v.pipe(text("guide text"), v.trim()), null),
  }),
  v.object({
    type: v.literal("spend"),
    tokens: v.pipe(v.number("spend"), v.integer("spend"), v.minValue(0, "spend")),
    usd: v.pipe(amount("spend"), v.minValue(0, "spend")),
  }),
  v.object({
    type: v.literal("propose"),
    school: v.string("school"),
    course: v.string("course"),
    subject: text("subject"),
    content: Content,
  }),
  v.object({ type: v.literal("edit"), change: v.string("change"), why: text("why"), patch: Patch }),
  v.object({
    type: v.literal("annotate"),
    change: v.string("change"),
    field: text("annotate field"),
    why: text("annotate why"),
    quotes: v.optional(v.unknown()),
  }),
  v.object({
    type: v.literal("finding"),
    findingType: v.picklist(FINDING_TYPES, (issue) => `finding type ${clip(issue.input)}`),
    item: v.string("item"),
    quote: text("quote"),
    why: text("why"),
    after: v.nullish(text("after"), null),
  }),
  v.object({
    type: v.literal("handoff"),
    school: v.string("school"),
    course: v.string("course"),
    work: Work,
    brief: text("brief"),
    request: text("request"),
    left: v.optional(text("left")),
  }),
]);
type RawEffect = v.InferOutput<typeof RawEffect>;
type Raw<T extends RawEffect["type"]> = Extract<RawEffect, { type: T }>;
const EFFECT_TYPES: ReadonlySet<unknown> = new Set(
  RawEffect.options.map((option) => option.entries.type.literal),
);

type Drop = (violation: AgentViolation) => void;

const itemsOf = <T>(
  raw: unknown,
  item: v.GenericSchema<unknown, T>,
  details: { list: string; item: string },
  drop: Drop,
): T[] => {
  const list = v.safeParse(Items, raw);
  if (!list.success) {
    drop({ kind: "malformed", detail: details.list });
    return [];
  }
  return list.output.flatMap((entry) => {
    const parsed = v.safeParse(item, entry);
    if (parsed.success) return [parsed.output];
    drop({ kind: "malformed", detail: details.item });
    return [];
  });
};

const sourceOf = (
  { kind, ref }: v.InferOutput<typeof Line>["source"],
  scope: AgentScope,
): Source | null => {
  const isRef = (item: { ref: string }) => item.ref === ref;
  switch (kind) {
    case "course": {
      const found = scope.courses.find(isRef);
      return found ? { kind: "course", ref: found.ref } : null;
    }
    case "assignment": {
      const found = scope.assignments.find(isRef);
      return found ? { kind: "assignment", ref: found.ref } : null;
    }
    case "announcement": {
      const found = scope.northStar?.announcements.find(isRef);
      return found ? { kind: "announcement", ref: found.ref } : null;
    }
    case "conversation": {
      const found = scope.conversations.find(isRef);
      return found ? { kind: "conversation", ref: found.ref } : null;
    }
    case "submission": {
      const found = scope.submissions.find(isRef);
      return found ? { kind: "submission", ref: found.ref } : null;
    }
    case "change": {
      const found = scope.changes.find((change) => change.id === ref);
      return found ? { kind: "change", ref: found.id } : null;
    }
    case "due":
      return { kind: "due" };
    default:
      return null;
  }
};

const linesOf = (raw: unknown, scope: AgentScope, drop: Drop): AnswerLine[] =>
  raw === undefined
    ? []
    : itemsOf(raw, Line, { list: "say lines", item: "say line" }, drop).flatMap(
        ({ source, title, detail }) => {
          const found = sourceOf(source, scope);
          if (found) return [{ source: found, title, ...(detail === undefined ? {} : { detail }) }];
          drop({ kind: "out-of-scope", target: clip(source.ref ?? source.kind) });
          return [];
        },
      );

const gradeOf = (
  raw: v.InferOutput<typeof GradeDraft>,
  scope: AgentScope,
): Result<GradeContent, AgentViolation> => {
  const submission = scope.submissions.find((s) => s.ref === raw.target);
  if (!submission) return { ok: false, error: { kind: "out-of-scope", target: clip(raw.target) } };
  const assignment = scope.assignments.find((a) => a.ref === submission.assignment);
  if (!assignment)
    return { ok: false, error: { kind: "out-of-scope", target: submission.assignment } };
  const outOf = assignment.pointsPossible;
  if (raw.points !== null && (raw.points < 0 || raw.points > outOf))
    return {
      ok: false,
      error: { kind: "out-of-range", detail: `points ${raw.points} of ${outOf}` },
    };
  const grade = {
    kind: "grade",
    target: submission.ref,
    outOf,
    late: lateOf(submission, assignment),
    comment: raw.comment,
    attachment: raw.attachment,
    override: null,
    excused: false,
  } as const;
  if (!assignment.rubric)
    return { ok: true, value: { ...grade, points: raw.points, rubric: null } };
  if (!raw.rubric) return { ok: false, error: { kind: "malformed", detail: "rubric" } };
  const scores = new Map(raw.rubric.map((entry) => [entry.criterion, entry.points]));
  const rubric: RubricScore[] = [];
  for (const criterion of assignment.rubric) {
    const value = scores.get(criterion.ref);
    if (value === undefined || value < 0 || value > criterion.maxPoints)
      return {
        ok: false,
        error: {
          kind: "out-of-range",
          detail: `${criterion.name}: ${clip(value)} of ${criterion.maxPoints}`,
        },
      };
    rubric.push({
      criterion: criterion.ref,
      name: criterion.name,
      points: value,
      outOf: criterion.maxPoints,
    });
  }
  return { ok: true, value: { ...grade, points: null, rubric } };
};

const contentOf = (
  raw: v.InferOutput<typeof Content>,
  scope: AgentScope,
): Result<ChangeContent, AgentViolation> => {
  const outside = { ok: false, error: { kind: "out-of-scope", target: clip(raw.target) } } as const;
  switch (raw.kind) {
    case "grade":
      return gradeOf(raw, scope);
    case "reply": {
      const conversation = scope.conversations.find((c) => c.ref === raw.target);
      return conversation
        ? { ok: true, value: { kind: "reply", target: conversation.ref, body: raw.body } }
        : outside;
    }
    case "message": {
      const submission = scope.submissions.find((s) => s.ref === raw.target);
      return submission ? { ok: true, value: { ...raw, target: submission.ref } } : outside;
    }
    case "announcement": {
      const course = scope.courses.find((c) => c.ref === raw.target);
      return course ? { ok: true, value: { ...raw, target: course.ref } } : outside;
    }
  }
};

const gradePatchOf = (
  raw: v.InferOutput<typeof GradePatch>,
  content: GradeContent,
): Result<ChangePatch, AgentViolation> => {
  for (const [criterion, value] of Object.entries(raw.rubricPoints ?? {})) {
    const score = content.rubric?.find((r) => r.criterion === criterion);
    if (!score) return { ok: false, error: { kind: "out-of-scope", target: clip(criterion) } };
    if (value < 0 || value > score.outOf)
      return {
        ok: false,
        error: { kind: "out-of-range", detail: `${score.name}: ${value} of ${score.outOf}` },
      };
  }
  if (raw.points !== undefined && (raw.points < 0 || raw.points > content.outOf))
    return {
      ok: false,
      error: { kind: "out-of-range", detail: `points ${raw.points} of ${content.outOf}` },
    };
  return { ok: true, value: raw };
};

const patchOf = (
  raw: v.InferOutput<typeof Patch>,
  { content }: ChangeRecord,
): Result<ChangePatch, AgentViolation> => {
  if (raw.kind !== content.kind)
    return { ok: false, error: { kind: "malformed", detail: "patch" } };
  return raw.kind === "grade" && content.kind === "grade"
    ? gradePatchOf(raw, content)
    : { ok: true, value: raw };
};

const workOf = (
  raw: v.InferOutput<typeof Work>,
  course: Course,
  scope: AgentScope,
): Result<HandoffWork, AgentViolation> => {
  switch (raw.kind) {
    case "announcement":
      return {
        ok: true,
        value: { kind: "announcement", ...(raw.topic === undefined ? {} : { topic: raw.topic }) },
      };
    case "replies":
      return { ok: true, value: raw };
    case "reply": {
      const conversation = scope.conversations.find(
        (c) => c.ref === raw.conversation && c.course === course.ref,
      );
      return conversation
        ? { ok: true, value: { kind: "reply", conversation: conversation.ref } }
        : { ok: false, error: { kind: "out-of-scope", target: clip(raw.conversation) } };
    }
    case "grading": {
      const assignment = scope.assignments.find(
        (a) => a.ref === raw.assignment && a.course === course.ref,
      );
      return assignment
        ? { ok: true, value: { kind: "grading", assignment: assignment.ref } }
        : { ok: false, error: { kind: "out-of-scope", target: clip(raw.assignment) } };
    }
  }
};

const handoffOf = (raw: Raw<"handoff">, scope: AgentScope): Result<AgentEffect, AgentViolation> => {
  const course = scope.courses.find((c) => c.ref === raw.course && c.school === raw.school);
  if (!course) return fail({ kind: "out-of-scope", target: clip(raw.course) });
  const work = workOf(raw.work, course, scope);
  if (!work.ok) return fail(work.error);
  return {
    ok: true,
    value: {
      type: "handoff",
      school: course.school,
      course: course.ref,
      work: work.value,
      brief: raw.brief,
      request: raw.request,
      ...(raw.left === undefined ? {} : { left: raw.left }),
    },
  };
};

const annotateOf = (
  raw: Raw<"annotate">,
  scope: AgentScope,
  drop: Drop,
): Result<AgentEffect, AgentViolation> => {
  const record = scope.changes.find((c) => c.id === raw.change);
  if (!record) return fail({ kind: "out-of-scope", target: clip(raw.change) });
  if (record.content.kind !== "grade")
    return fail({ kind: "malformed", detail: "only a grade can be annotated" });
  const { target } = record.content;
  const submission = scope.submissions.find((s) => s.ref === target);
  if (!submission) return fail({ kind: "out-of-scope", target });
  const passages = passagesOf(submission);
  const quotes = itemsOf(
    raw.quotes,
    Quote,
    { list: "annotate quotes", item: "quote" },
    drop,
  ).filter(({ paragraph, quote }) => {
    const found = passages[paragraph]?.includes(quote) === true;
    if (!found) drop({ kind: "quote-not-found", quote: clip(quote) });
    return found;
  });
  return {
    ok: true,
    value: { type: "annotate", change: record.id, field: raw.field, why: raw.why, quotes },
  };
};

const findingOf = (raw: Raw<"finding">, scan: ScanScope): Result<AgentEffect, AgentViolation> => {
  const item = scan.content.items.find((entry) => entry.ref === raw.item);
  if (!item) return fail({ kind: "out-of-scope", target: clip(raw.item) });
  if (!item.body.includes(raw.quote))
    return fail({ kind: "quote-not-found", quote: clip(raw.quote) });
  if (
    !scan.findings.some((finding) => finding.type === raw.findingType && finding.item === item.ref)
  )
    return fail({ kind: "out-of-scope", target: `${raw.findingType} on ${item.ref}` });
  return { ok: true, value: { ...raw, item: item.ref } };
};

const resolve = (
  raw: RawEffect,
  scope: AgentScope,
  drop: Drop,
): Result<AgentEffect, AgentViolation> => {
  switch (raw.type) {
    case "say": {
      const replies = raw.replies === undefined ? undefined : v.safeParse(Replies, raw.replies);
      if (replies?.success === false) drop({ kind: "malformed", detail: "say replies" });
      const lines = linesOf(raw.lines, scope, drop);
      return {
        ok: true,
        value: {
          type: "say",
          text: raw.text,
          ...(lines.length > 0 ? { lines } : {}),
          ...(replies?.success ? { replies: replies.output } : {}),
        },
      };
    }
    case "decline": {
      const lines = linesOf(raw.lines, scope, drop);
      return {
        ok: true,
        value: { type: "decline", text: raw.text, ...(lines.length > 0 ? { lines } : {}) },
      };
    }
    case "limited":
    case "work":
    case "spend":
    case "guide":
      return { ok: true, value: raw };
    case "propose": {
      const course = scope.courses.find((c) => c.ref === raw.course && c.school === raw.school);
      if (!course) return fail({ kind: "out-of-scope", target: clip(raw.course) });
      const content = contentOf(raw.content, scope);
      if (!content.ok) return fail(content.error);
      return {
        ok: true,
        value: {
          type: "propose",
          school: course.school,
          course: course.ref,
          subject: raw.subject,
          content: content.value,
        },
      };
    }
    case "edit": {
      const record = scope.changes.find((c) => c.id === raw.change);
      if (!record) return fail({ kind: "out-of-scope", target: clip(raw.change) });
      const patch = patchOf(raw.patch, record);
      if (!patch.ok) return fail(patch.error);
      return {
        ok: true,
        value: { type: "edit", change: record.id, patch: patch.value, why: raw.why },
      };
    }
    case "annotate":
      return annotateOf(raw, scope, drop);
    case "finding":
      return scope.scan
        ? findingOf(raw, scope.scan)
        : fail({ kind: "out-of-scope", target: "course content" });
    case "handoff":
      return handoffOf(raw, scope);
  }
};

const closedTo = (type: unknown, scope: AgentScope): AgentViolation | null => {
  if (type === "handoff" && !scope.northStar) return { kind: "out-of-scope", target: "handoff" };
  if (type === "guide" && scope.northStar) return { kind: "out-of-scope", target: "guidance" };
  if (type === "finding" && !scope.scan) return { kind: "out-of-scope", target: "course content" };
  return null;
};

const detailOf = (issue: v.BaseIssue<unknown>): string => {
  const key = issue.path?.at(-1)?.key;
  return issue.kind === "schema" && issue.type === "object" && typeof key === "string"
    ? key
    : issue.message;
};

export const parseAgentEffect = (
  raw: unknown,
  scope: AgentScope,
  drop: Drop = () => {},
): Result<AgentEffect, AgentViolation> => {
  if (!isRecord(raw)) return fail({ kind: "malformed", detail: "effect is not an object" });
  if (!EFFECT_TYPES.has(raw["type"]))
    return fail({ kind: "unknown-effect", seen: clip(raw["type"]) });
  const shut = closedTo(raw["type"], scope);
  if (shut) return fail(shut);
  const parsed = v.safeParse(RawEffect, raw, { abortEarly: true });
  if (!parsed.success) return fail({ kind: "malformed", detail: detailOf(parsed.issues[0]) });
  return resolve(parsed.output, scope, drop);
};

export const describeViolation = (violation: AgentViolation): string => {
  switch (violation.kind) {
    case "unknown-effect":
      return `asked to "${violation.seen}", which no tool allows`;
    case "malformed":
      return `unreadable ${violation.detail}`;
    case "out-of-scope":
      return `aimed outside the thread at ${violation.target}`;
    case "out-of-range":
      return `value out of range: ${violation.detail}`;
    case "quote-not-found":
      return `quote not in the text: "${violation.quote}"`;
  }
};

export interface AgentSink {
  effect(effect: AgentEffect): void | Promise<void>;
  refuse(violation: AgentViolation, effect: string | null): void;
}

export const runAgent = async (
  agent: Agent,
  input: AgentInput,
  sink: AgentSink,
  signal: AbortSignal,
): Promise<void> => {
  try {
    for await (const raw of agent.run(input, signal)) {
      if (signal.aborted) return;
      const type = isRecord(raw) ? clip(raw["type"]) : "not an object";
      const parsed = parseAgentEffect(raw, input.scope, (part) => sink.refuse(part, type));
      if (parsed.ok) await sink.effect(parsed.value);
      else sink.refuse(parsed.error, type);
    }
  } catch {
    sink.refuse({ kind: "malformed", detail: "the agent stopped unexpectedly" }, null);
  }
};
