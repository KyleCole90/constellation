import * as v from "valibot";

import type { AnswerLine, HandoffWork, Source } from "~/shared/agent/agent";
import type { Fingerprint } from "~/shared/domain/approval";
import type { ChangeRecord, Rationale, SendRun } from "~/shared/domain/change";
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
  ConversationSchema,
  CopySourceSchema,
  CourseSchema,
  CourseShellSchema,
  DraftDateSchema,
  FieldKeySchema,
  FieldOutcomeSchema,
  IsoTimeSchema,
  LmsErrorSchema,
  RemoteStateSchema,
  SchoolIdSchema,
  SchoolSchema,
  SetContentSchema,
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
 * The workspace as saved under lms-app.v1. Each schema is annotated with its domain type, so a required field the schema
 * doesn't check fails to compile. A new optional field or union member compiles without one, and a save holding it resets.
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

const ConnectionRecordSchema: v.GenericSchema<unknown, ConnectionRecord> = v.object({
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
});

const SchoolCacheSchema: v.GenericSchema<unknown, SchoolCache> = v.object({
  courses: v.array(CourseSchema),
  assignments: v.array(AssignmentSchema),
  students: v.array(StudentSchema),
  submissions: v.array(SubmissionSchema),
  conversations: v.array(ConversationSchema),
  announcements: v.array(AnnouncementSchema),
});

// ---- Changes ----

const ApprovalSchema = v.object({
  changeId: ChangeIdSchema,
  fingerprint: brand<Fingerprint>(nonEmpty),
  at,
  via: v.picklist(["button", "batch-button", "guarded-button"]),
});

const SendRunSchema: v.GenericSchema<unknown, SendRun> = v.object({
  attempt: count,
  startedAt: at,
  fields: recordOf(
    v.union([v.object({ status: v.literal("pending") }), FieldOutcomeSchema]),
    FieldKeySchema,
  ),
  waitingUntil: v.nullable(count),
});

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

const ChangeStateSchema: v.GenericSchema<unknown, ChangeRecord["state"]> = v.variant("tag", [
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
]);

const RationaleSchema: v.GenericSchema<unknown, Rationale> = v.object({
  field: text,
  why: text,
  anchors: v.array(v.object({ paragraph: count, start: count, end: count })),
});

export const ChangeRecordSchema: v.GenericSchema<unknown, ChangeRecord> = v.object({
  id: ChangeIdSchema,
  school: SchoolIdSchema,
  course: lmsRef("course"),
  subject: text,
  content: ChangeContentSchema,
  basis: v.object({ readAt: at, remote: RemoteStateSchema }),
  landed: v.array(FieldKeySchema),
  seen: v.nullable(recordOf(v.array(text))),
  rationale: v.array(RationaleSchema),
  // A change saved before the agent's comment was kept lacks it. Outside the fingerprint, so filling it in keeps the approval.
  agentComment: v.optional(v.nullable(text), null),
  state: ChangeStateSchema,
  activity: v.array(v.object({ at, actor: v.picklist(["you", "agent", "writeback"]), text })),
});

// ---- Threads ----

const SourceSchema: v.GenericSchema<unknown, Source> = v.variant("kind", [
  v.object({ kind: v.literal("course"), ref: lmsRef("course") }),
  v.object({ kind: v.literal("assignment"), ref: lmsRef("assignment") }),
  v.object({ kind: v.literal("announcement"), ref: lmsRef("announcement") }),
  v.object({ kind: v.literal("conversation"), ref: lmsRef("conversation") }),
  v.object({ kind: v.literal("submission"), ref: lmsRef("submission") }),
  v.object({ kind: v.literal("change"), ref: ChangeIdSchema }),
  v.object({ kind: v.literal("due") }),
]);

const AnswerLineSchema: v.GenericSchema<unknown, AnswerLine> = v.object({
  source: SourceSchema,
  title: text,
  detail: v.exactOptional(text),
});

const MessageFields = {
  change: v.exactOptional(ChangeIdSchema),
  seeded: v.exactOptional(v.literal(true)),
  at,
};

const ThreadMessageSchema: v.GenericSchema<unknown, ThreadMessage> = v.variant("type", [
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
    conversation: v.exactOptional(lmsRef("conversation")),
    people: v.exactOptional(v.array(text)),
    brief: text,
  }),
  v.object({
    ...MessageFields,
    type: v.literal("handed-off"),
    from: ThreadIdSchema,
    request: text,
    left: v.exactOptional(text),
  }),
]);

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

const ThreadSchema: v.GenericSchema<unknown, Thread> = v.variant("kind", [
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
]);

// ---- Setup ----

const FindingKeySchema = brand<FindingKey>(nonEmpty);

const FindingSchema: v.GenericSchema<unknown, Finding> = v.object({
  key: FindingKeySchema,
  type: v.custom<FindingType>(isFindingType),
  item: v.nullable(v.union([lmsRef("item"), lmsRef("module")])),
  where: text,
  quote: text,
  why: text,
  openUrl: v.nullable(text),
  fix: v.nullable(v.variant("kind", [TextFixContentSchema, SetContentSchema])),
});

const DraftTermSchema = v.object({
  name: text,
  start: DraftDateSchema,
  end: DraftDateSchema,
  days: v.array(WeekdaySchema),
});

const PlanDraftSchema: v.GenericSchema<unknown, PlanDraft> = v.object({
  oldTerm: DraftTermSchema,
  newTerm: DraftTermSchema,
  breaks: v.array(v.object({ name: text, start: DraftDateSchema, end: DraftDateSchema })),
});

const checkedAt = { at, version: text };

const CourseSetupSchema: v.GenericSchema<unknown, CourseSetup> = v.object({
  course: lmsRef("course"),
  school: SchoolIdSchema,
  thread: ThreadIdSchema,
  shell: CourseShellSchema,
  source: v.nullable(CopySourceSchema),
  plan: v.nullable(TermPlanSchema),
  draft: v.exactOptional(v.nullable(PlanDraftSchema)),
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
});

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

const ThreadUiSchema: v.GenericSchema<unknown, ThreadUi> = v.object({
  panel: v.nullable(v.picklist(["source", "writeback", "batch"])),
  queueOpen: v.boolean(),
  queueFilter: QueueFilterSchema,
  current: v.nullable(RowKeySchema),
  selected: v.array(RowKeySchema),
  scrollTop: v.nullable(count),
  composer: v.exactOptional(text),
});

const UiPrefsSchema: v.GenericSchema<unknown, UiPrefs> = v.object({
  sidebarOpen: v.boolean(),
  collapsed: recordOf(v.literal(true)),
  courseOpen: v.exactOptional(recordOf(v.boolean())),
  expandedThreads: recordOf(v.literal(true)),
  threadUi: recordOf(ThreadUiSchema, ThreadIdSchema),
  readThrough: v.exactOptional(recordOf(text)),
  offersDismissed: v.exactOptional(recordOf(v.literal(true))),
});

// ---- Handoffs and undrafted work ----

const HandoffWorkSchema: v.GenericSchema<unknown, HandoffWork> = v.variant("kind", [
  v.object({ kind: v.literal("announcement"), topic: v.exactOptional(text) }),
  v.object({ kind: v.literal("replies") }),
  v.object({ kind: v.literal("reply"), conversation: lmsRef("conversation") }),
  v.object({ kind: v.literal("grading"), assignment: lmsRef("assignment") }),
]);

const PendingHandoffSchema: v.GenericSchema<unknown, PendingHandoff> = v.object({
  thread: ThreadIdSchema,
  course: lmsRef("course"),
  work: HandoffWorkSchema,
});

const UndraftedSchema: v.GenericSchema<unknown, Undrafted> = v.object({
  submittedAt: v.nullable(at),
  said: text,
});

export const WorkspaceDataSchema: v.GenericSchema<unknown, WorkspaceData> = v.object({
  schools: v.array(SchoolSchema),
  connections: recordOf(ConnectionRecordSchema, SchoolIdSchema),
  onboarding: v.picklist(["welcome", "setup", "done"]),
  aiSource: v.picklist(["none", "key", "on-device", "claude-code"]),
  cache: recordOf(SchoolCacheSchema, SchoolIdSchema),
  changes: recordOf(ChangeRecordSchema, ChangeIdSchema),
  threads: recordOf(ThreadSchema, ThreadIdSchema),
  // A workspace saved before these existed lacks them. Anything else malformed fails the whole save.
  setups: v.optional(recordOf(CourseSetupSchema), {}),
  newCourses: v.optional(recordOf(v.array(CourseShellSchema), SchoolIdSchema), {}),
  prefs: UiPrefsSchema,
  handoffs: v.optional(recordOf(PendingHandoffSchema), {}),
  undrafted: v.optional(recordOf(UndraftedSchema), {}),
  resetAt: count,
});
