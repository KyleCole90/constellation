import * as v from "valibot";

import type { AnswerLine, HandoffWork, Source } from "~/shared/agent/agent";
import { fingerprintOf, type Fingerprint } from "~/shared/domain/approval";
import {
  ACTIVITY_KINDS,
  ACTIVITY_TEXT,
  type ActivityEntry,
  type ActivityKind,
  type ChangeRecord,
  type Rationale,
  type SendRun,
} from "~/shared/domain/change";
import {
  isFindingType,
  type Finding,
  type FindingKey,
  type FindingType,
} from "~/shared/domain/scan";
import type { CourseSetup } from "~/shared/domain/setup";
import type { PlanDraft } from "~/shared/domain/term";
import {
  AnnouncementSchema,
  AssignmentSchema,
  ChangeContentSchema,
  ChangeIdSchema,
  ConversationFields,
  CopySourceSchema,
  CourseSchema,
  CourseShellSchema,
  DraftDateSchema,
  FieldKeySchema,
  FieldOutcomeSchema,
  GradeContentSchema,
  IsoTimeSchema,
  LatePenaltySchema,
  LmsErrorSchema,
  RemoteGradeSchema,
  RemoteStateSchema,
  SchoolIdSchema,
  SchoolSchema,
  ItemSetContentSchema,
  CourseSetContentSchema,
  StudentSchema,
  SubmissionSchema,
  TermPlanSchema,
  TextFixContentSchema,
  ThreadIdSchema,
  WeekdaySchema,
  brand,
  lmsRef,
} from "~/shared/providers/schemas";

import type {
  ConnectionRecord,
  PendingHandoff,
  QueueFilter,
  RowKey,
  SchoolCache,
  Thread,
  ThreadMessage,
  ThreadUi,
  UiPrefs,
  Undrafted,
  WorkspaceData,
} from "./types";

/*
 * The workspace as saved under lms-app.v1. `covering` ties the schema to `WorkspaceData` both ways, so a field or union
 * member the schema doesn't accept fails to compile. A new optional field still compiles, and loads without it.
 */

const text = v.string();
const count = v.number();
const at = IsoTimeSchema;
const nonEmpty = (raw: string) => raw !== "";
/**
 * A record whose keys are checked, typed by plain string keys: valibot types a record keyed by a brand as partial,
 * which every lookup would then doubt. Valibot's own record takes an array.
 */
const recordOf = <T>(
  value: v.GenericSchema<unknown, T>,
  key: v.GenericSchema<unknown, string> = text,
) =>
  v.pipe(
    v.custom<Readonly<Record<string, unknown>>>(
      (input) => typeof input === "object" && input !== null && !Array.isArray(input),
    ),
    v.record(
      v.pipe(
        text,
        v.check((raw) => v.is(key, raw)),
      ),
      value,
    ),
  );

const ConnectionRecordSchema = v.object({
  school: SchoolIdSchema,
  status: v.picklist(["disconnected", "connected", "expired"]),
  connectedAt: v.nullable(at),
  accountName: v.nullable(text),
  scopes: v.array(text),
  lastSyncedAt: v.nullable(at),
  syncError: v.nullable(
    v.picklist([
      "auth_expired",
      "forbidden",
      "rate_limited",
      "not_found",
      "rejected",
      "unavailable",
      "lost_response",
      "unsupported",
    ]),
  ),
}) satisfies v.GenericSchema<unknown, ConnectionRecord>;

const SavedConversationSchema = v.object({
  ...ConversationFields,
  students: v.optional(v.array(lmsRef("student")), []),
});

const SchoolCacheSchema = v.object({
  courses: v.array(CourseSchema),
  assignments: v.array(AssignmentSchema),
  students: v.array(StudentSchema),
  submissions: v.array(SubmissionSchema),
  conversations: v.array(SavedConversationSchema),
  announcements: v.array(AnnouncementSchema),
}) satisfies v.GenericSchema<unknown, SchoolCache>;

// ---- Changes ----

const ApprovalSchema = v.object({
  changeId: ChangeIdSchema,
  fingerprint: brand<Fingerprint>(nonEmpty),
  at,
  via: v.picklist(["button", "batch-button", "guarded-button"]),
});

const SendRunSchema = v.object({
  attempt: count,
  startedAt: at,
  fields: recordOf(
    v.union([v.object({ status: v.literal("pending") }), FieldOutcomeSchema]),
    FieldKeySchema,
  ),
  waitingUntil: v.nullable(count),
}) satisfies v.GenericSchema<unknown, SendRun>;

const HoldCauseSchema = v.variant("tag", [
  v.object({ tag: v.literal("reconnect") }),
  v.object({ tag: v.literal("forbidden"), missingScope: v.nullable(text) }),
  v.object({ tag: v.literal("failed"), error: LmsErrorSchema, retriesExhausted: v.boolean() }),
  v.object({ tag: v.literal("rejected"), reason: text }),
  v.object({ tag: v.picklist(["in-doubt", "interrupted"]), since: at }),
]);

const FieldConflictSchema = v.object({
  field: FieldKeySchema,
  reason: v.picklist(["changed-by-other", "target-changed", "possible-own-write", "passage-moved"]),
  basis: v.nullable(text),
  theirs: v.nullable(text),
  mine: v.nullable(text),
});

const ChangeStateSchema = v.variant("tag", [
  v.object({
    tag: v.literal("draft"),
    approvalReset: v.nullable(v.picklist(["edited", "agent-edited", "rebased", "revoked"])),
  }),
  v.object({ tag: v.literal("approved"), approval: ApprovalSchema }),
  v.object({ tag: v.literal("sending"), approval: ApprovalSchema, run: SendRunSchema }),
  v.object({
    tag: v.literal("held"),
    approval: ApprovalSchema,
    run: SendRunSchema,
    cause: HoldCauseSchema,
  }),
  v.object({
    tag: v.literal("conflicted"),
    run: SendRunSchema,
    conflicts: v.array(FieldConflictSchema),
  }),
  v.object({ tag: v.literal("sent"), approval: ApprovalSchema, run: SendRunSchema, at }),
  v.object({ tag: v.literal("discarded"), at }),
]) satisfies v.GenericSchema<unknown, ChangeRecord["state"]>;

const RationaleSchema = v.object({
  field: text,
  why: text,
  anchors: v.array(v.object({ paragraph: count, start: count, end: count })),
}) satisfies v.GenericSchema<unknown, Rationale>;

/** A grade drafted before late waivers, overrides or excuses existed lacks them, and gets what a new draft starts with. */
const SavedGradeSchema = v.object({
  ...GradeContentSchema.entries,
  late: v.nullable(
    v.object({ ...LatePenaltySchema.entries, waived: v.optional(v.boolean(), false) }),
  ),
  override: v.optional(v.nullable(count), null),
  excused: v.optional(v.boolean(), false),
});

/** Filling an old draft's defaults can move its fingerprint, and a stale approval never sends, so it is a draft again. */
const withLiveApproval = (record: ChangeRecord): ChangeRecord =>
  record.state.tag === "approved" && record.state.approval.fingerprint !== fingerprintOf(record)
    ? { ...record, state: { tag: "draft", approvalReset: null } }
    : record;

const fixedActivityText = (kind: ActivityKind): string | undefined =>
  kind === "retried" || kind === "outcomes" || kind === "held" ? undefined : ACTIVITY_TEXT[kind];

const LEGACY_ACTIVITY_KIND: ReadonlyMap<string, ActivityKind> = new Map(
  ACTIVITY_KINDS.flatMap((kind) => {
    const label = fixedActivityText(kind);
    return label === undefined ? [] : [[label, kind] as const];
  }),
);

const SavedActivityEntrySchema = v.pipe(
  v.object({
    at,
    actor: v.picklist(["you", "agent", "writeback"]),
    kind: v.optional(v.picklist(ACTIVITY_KINDS)),
    text,
  }),
  v.transform((entry): ActivityEntry => ({
    at: entry.at,
    actor: entry.actor,
    kind: entry.kind ?? LEGACY_ACTIVITY_KIND.get(entry.text) ?? "outcomes",
    text: entry.text,
  })),
) satisfies v.GenericSchema<unknown, ActivityEntry>;

export const ChangeRecordSchema = v.object({
  id: ChangeIdSchema,
  school: SchoolIdSchema,
  course: lmsRef("course"),
  subject: text,
  content: v.union([SavedGradeSchema, ChangeContentSchema]),
  basis: v.object({
    readAt: at,
    remote: v.union([
      v.object({ ...RemoteGradeSchema.entries, excused: v.optional(v.boolean(), false) }),
      RemoteStateSchema,
    ]),
  }),
  landed: v.array(FieldKeySchema),
  skipped: v.optional(v.array(FieldKeySchema), []),
  seen: v.nullable(recordOf(v.array(text))),
  rationale: v.array(RationaleSchema),
  // A change saved before the agent's comment was kept lacks it. Outside the fingerprint, so filling it in keeps the approval.
  agentComment: v.optional(v.nullable(text), null),
  state: ChangeStateSchema,
  activity: v.array(SavedActivityEntrySchema),
});

// ---- Threads ----

const SourceSchema = v.variant("kind", [
  v.object({ kind: v.literal("course"), ref: lmsRef("course") }),
  v.object({ kind: v.literal("assignment"), ref: lmsRef("assignment") }),
  v.object({ kind: v.literal("announcement"), ref: lmsRef("announcement") }),
  v.object({ kind: v.literal("conversation"), ref: lmsRef("conversation") }),
  v.object({ kind: v.literal("submission"), ref: lmsRef("submission") }),
  v.object({ kind: v.literal("change"), ref: ChangeIdSchema }),
  v.object({ kind: v.literal("due") }),
]) satisfies v.GenericSchema<unknown, Source>;

const AnswerLineSchema = v.object({
  source: SourceSchema,
  title: text,
  detail: v.exactOptional(text),
}) satisfies v.GenericSchema<unknown, AnswerLine>;

const MessageFields = {
  change: v.exactOptional(ChangeIdSchema),
  seeded: v.exactOptional(v.literal(true)),
  at,
};

const ThreadMessageSchema = v.variant("type", [
  v.object({ ...MessageFields, type: v.picklist(["user", "refusal", "notice"]), text }),
  v.object({
    ...MessageFields,
    type: v.literal("agent"),
    text,
    edited: v.exactOptional(v.array(v.object({ label: text, from: text, to: text }))),
    lines: v.exactOptional(v.array(AnswerLineSchema)),
    replies: v.exactOptional(v.array(text)),
  }),
  v.object({ ...MessageFields, type: v.literal("work"), lines: v.array(text) }),
  v.object({
    ...MessageFields,
    type: v.literal("declined"),
    text,
    lines: v.exactOptional(v.array(AnswerLineSchema)),
  }),
  v.object({
    ...MessageFields,
    type: v.literal("handoff"),
    to: ThreadIdSchema,
    course: lmsRef("course"),
    work: v.variant("kind", [
      v.object({ kind: v.literal("reply"), conversation: lmsRef("conversation") }),
      v.object({ kind: v.literal("replies"), people: v.array(text) }),
      v.object({ kind: v.literal("thread") }),
    ]),
    brief: text,
  }),
  v.object({
    ...MessageFields,
    type: v.literal("handed-off"),
    from: ThreadIdSchema,
    request: text,
    left: v.exactOptional(text),
  }),
]) satisfies v.GenericSchema<unknown, ThreadMessage>;

const ThreadFields = {
  id: ThreadIdSchema,
  title: text,
  messages: v.array(ThreadMessageSchema),
  focus: v.nullable(ChangeIdSchema),
  updatedAt: at,
  settledAt: v.exactOptional(at),
  spend: v.exactOptional(v.object({ tokens: count, usd: count })),
  guidance: v.exactOptional(text),
  dropped: v.exactOptional(v.array(v.object({ text, at }))),
};

const ThreadSchema = v.variant("kind", [
  v.object({
    ...ThreadFields,
    kind: v.literal("grading"),
    school: SchoolIdSchema,
    course: lmsRef("course"),
    assignment: lmsRef("assignment"),
  }),
  v.object({
    ...ThreadFields,
    kind: v.picklist(["announcement", "setup"]),
    school: SchoolIdSchema,
    course: lmsRef("course"),
  }),
  v.object({
    ...ThreadFields,
    kind: v.picklist(["north-star", "north-star-chat", "queue", "messages", "general"]),
    school: v.nullable(SchoolIdSchema),
    course: v.nullable(lmsRef("course")),
  }),
]) satisfies v.GenericSchema<unknown, Thread>;

// ---- Setup ----

const FindingKeySchema = brand<FindingKey>(nonEmpty);

const FindingSchema = v.object({
  key: FindingKeySchema,
  type: v.custom<FindingType>(isFindingType),
  item: v.nullable(v.union([lmsRef("item"), lmsRef("module")])),
  where: text,
  quote: text,
  why: text,
  openUrl: v.nullable(text),
  fix: v.nullable(
    v.variant("kind", [TextFixContentSchema, ItemSetContentSchema, CourseSetContentSchema]),
  ),
}) satisfies v.GenericSchema<unknown, Finding>;

const DraftTermSchema = v.object({
  name: text,
  start: DraftDateSchema,
  end: DraftDateSchema,
  days: v.array(WeekdaySchema),
});

const PlanDraftSchema = v.object({
  oldTerm: DraftTermSchema,
  newTerm: DraftTermSchema,
  breaks: v.array(v.object({ name: text, start: DraftDateSchema, end: DraftDateSchema })),
}) satisfies v.GenericSchema<unknown, PlanDraft>;

const checkedAt = { at, version: text };

const CourseSetupSchema = v.object({
  course: lmsRef("course"),
  school: SchoolIdSchema,
  thread: ThreadIdSchema,
  shell: CourseShellSchema,
  source: v.nullable(CopySourceSchema),
  plan: v.nullable(TermPlanSchema),
  draft: v.optional(v.nullable(PlanDraftSchema), null),
  copy: v.nullable(ChangeIdSchema),
  publish: v.nullable(ChangeIdSchema),
  scan: v.nullable(
    v.object({ ...checkedAt, copy: ChangeIdSchema, findings: v.array(FindingSchema) }),
  ),
  check: v.nullable(v.object(checkedAt)),
  resolved: recordOf(
    v.object({ at, how: v.picklist(["dismissed", "handled"]), reason: v.nullable(text) }),
    FindingKeySchema,
  ),
  fixes: recordOf(ChangeIdSchema, FindingKeySchema),
  written: v.optional(v.array(ChangeIdSchema), []),
}) satisfies v.GenericSchema<unknown, CourseSetup>;

// ---- Prefs ----

const QUEUE_FILTERS: readonly string[] = [
  "all",
  "needs-draft",
  "ready-to-approve",
  "approved",
  "attention",
  "missing",
] satisfies readonly QueueFilter[];

const QueueFilterSchema = v.custom<QueueFilter>(
  (input) =>
    typeof input === "string" &&
    (QUEUE_FILTERS.includes(input) || /^(school|course|assignment):/.test(input)),
);

const RowKeySchema = brand<RowKey>(nonEmpty);

const ThreadUiSchema = v.object({
  panel: v.nullable(v.picklist(["source", "writeback", "batch"])),
  queueOpen: v.boolean(),
  queueFilter: QueueFilterSchema,
  current: v.nullable(RowKeySchema),
  selected: v.array(RowKeySchema),
  scrollTop: v.nullable(count),
  composer: v.exactOptional(text),
}) satisfies v.GenericSchema<unknown, ThreadUi>;

const UiPrefsSchema = v.object({
  sidebarOpen: v.boolean(),
  collapsed: recordOf(v.literal(true), SchoolIdSchema),
  courseOpen: v.exactOptional(recordOf(v.boolean(), lmsRef("course"))),
  expandedThreads: recordOf(v.literal(true)),
  threadUi: recordOf(ThreadUiSchema, ThreadIdSchema),
  readThrough: v.exactOptional(recordOf(text, lmsRef("conversation"))),
  offersDismissed: v.exactOptional(recordOf(v.literal(true), lmsRef("course"))),
}) satisfies v.GenericSchema<unknown, UiPrefs>;

// ---- Handoffs and undrafted work ----

const HandoffWorkSchema = v.variant("kind", [
  v.object({ kind: v.literal("announcement"), topic: v.exactOptional(text) }),
  v.object({ kind: v.literal("replies") }),
  v.object({ kind: v.literal("reply"), conversation: lmsRef("conversation") }),
  v.object({ kind: v.literal("grading"), assignment: lmsRef("assignment") }),
]) satisfies v.GenericSchema<unknown, HandoffWork>;

const PendingHandoffSchema = v.object({
  thread: ThreadIdSchema,
  course: lmsRef("course"),
  work: HandoffWorkSchema,
}) satisfies v.GenericSchema<unknown, PendingHandoff>;

/** A thread id, a space, then the work: what `HandoffKey` spells. */
const HandoffKeySchema = v.pipe(
  text,
  v.check((raw) => raw.indexOf(" ") > 0),
);

const UndraftedSchema = v.object({
  submittedAt: v.nullable(at),
  said: text,
}) satisfies v.GenericSchema<unknown, Undrafted>;

const WorkspaceDataFields = v.object({
  schools: v.array(SchoolSchema),
  connections: recordOf(ConnectionRecordSchema, SchoolIdSchema),
  onboarding: v.picklist(["welcome", "setup", "done"]),
  aiSource: v.picklist(["none", "key", "on-device", "claude-code"]),
  cache: recordOf(SchoolCacheSchema, SchoolIdSchema),
  changes: recordOf(ChangeRecordSchema, ChangeIdSchema),
  threads: recordOf(ThreadSchema, ThreadIdSchema),
  // A workspace saved before these existed lacks them. Anything else malformed fails the whole save.
  setups: v.optional(recordOf(CourseSetupSchema, lmsRef("course")), {}),
  newCourses: v.optional(recordOf(v.array(CourseShellSchema), SchoolIdSchema), {}),
  prefs: UiPrefsSchema,
  handoffs: v.optional(recordOf(PendingHandoffSchema, HandoffKeySchema), {}),
  undrafted: v.optional(recordOf(UndraftedSchema, lmsRef("submission")), {}),
  resetAt: count,
});

/** Readonly dropped, because valibot outputs mutable lists, and readonly is no part of what a save may hold. */
type Writable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? Writable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Writable<T[K]> }
      : T;

/**
 * Ties the schema to `WorkspaceData` both ways. Its output must be a `WorkspaceData`, and every `WorkspaceData` must be
 * one of its outputs, so a new union member (a thread kind, a change state, an AI source) fails to compile here until
 * the schema accepts it, instead of resetting every save that holds it.
 */
const covering =
  <T>() =>
  <S extends v.GenericSchema<unknown, T>>(
    schema: S & (Writable<T> extends v.InferOutput<S> ? unknown : never),
  ): v.GenericSchema<unknown, T> =>
    schema;

export const WorkspaceDataSchema = v.pipe(
  covering<WorkspaceData>()(WorkspaceDataFields),
  v.transform((data): WorkspaceData => ({
    ...data,
    changes: Object.fromEntries(
      Object.entries(data.changes).map(([id, change]) => [id, withLiveApproval(change)]),
    ),
  })),
);
