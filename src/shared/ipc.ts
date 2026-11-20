import * as v from "valibot";

import { AnalyticsEventSchema } from "./analytics";
import { LabCommandSchema, LabSnapshotSchema } from "./providers/fake-canvas/lab";
import type { VaultKey } from "./providers/provider";
import { keysOf } from "./keys-of";
import {
  AccountInfoSchema,
  AnnouncementSchema,
  AssignmentSchema,
  ChangeContentSchema,
  ChangeIdSchema,
  ConversationSchema,
  CourseContentSchema,
  CourseSchema,
  CourseShellSchema,
  FieldKeysSchema,
  FieldOutcomesSchema,
  MigrationSchema,
  PickedPackageSchema,
  RemoteStateSchema,
  SchoolIdSchema,
  SamplePackageSchema,
  SchoolSchema,
  SourceCourseSchema,
  StudentSchema,
  SubmissionSchema,
  FileContentSchema,
  listOf,
  lmsRef,
  readOf,
} from "./providers/schemas";

export const MAX_FRAMES = 50;
const MAX_STACK = 16_000;

const RendererError = v.strictObject({
  type: v.pipe(v.string(), v.maxLength(64)),
  stack: v.pipe(v.string(), v.maxLength(MAX_STACK)),
});

export type ErrorReport = v.InferOutput<typeof RendererError>;

export const errorReport = (error: unknown): ErrorReport => {
  if (!(error instanceof Error)) return { type: "NonError", stack: "" };
  const stack = error.stack ?? "";
  const header = String(error);
  const frames = stack.startsWith(header) ? stack.slice(header.length) : "";
  return {
    type: error.name.slice(0, 64),
    stack: frames
      .split("\n")
      .slice(0, MAX_FRAMES + 1)
      .join("\n")
      .slice(0, MAX_STACK),
  };
};

export const VaultKeySchema: v.GenericSchema<VaultKey> = v.union([
  v.literal("ai-key"),
  SchoolIdSchema,
]);
const ByKey = v.strictObject({ key: VaultKeySchema });
const BySchool = v.strictObject({ school: SchoolSchema });
const ByCourse = v.strictObject({ school: SchoolSchema, course: lmsRef("course") });

const AgentRunInput = v.strictObject({
  request: v.pipe(v.string(), v.minLength(1)),
  history: v.array(v.strictObject({ role: v.picklist(["user", "agent"]), text: v.string() })),
  guidance: v.optional(v.string()),
  scope: v.unknown(),
  files: v.array(
    v.strictObject({ name: v.string(), mediaType: v.string(), data: v.instance(Uint8Array) }),
  ),
});
const AgentRunOutput = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    effects: v.array(v.unknown()),
    spend: v.strictObject({
      tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
      usd: v.pipe(v.number(), v.minValue(0)),
    }),
  }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.string(),
    limited: v.optional(v.literal(true)),
  }),
]);

const AgentSourceSchema = v.picklist(["none", "key", "claude-code"]);
export type AgentSource = v.InferOutput<typeof AgentSourceSchema>;

const WeeklyUsage = v.strictObject({
  usedPercent: v.pipe(v.number(), v.minValue(0)),
  resetsAt: v.pipe(v.string(), v.isoTimestamp()),
});
const ClaudeCodeStatus = v.variant("installed", [
  v.strictObject({ installed: v.literal(false), weekly: v.nullable(WeeklyUsage) }),
  v.strictObject({
    installed: v.literal(true),
    version: v.string(),
    tooOld: v.boolean(),
    signedIn: v.boolean(),
    weekly: v.nullable(WeeklyUsage),
  }),
]);
export type ClaudeCodeStatus = v.InferOutput<typeof ClaudeCodeStatus>;

interface Channel {
  readonly input: v.GenericSchema;
  readonly output: v.GenericSchema;
}

const ipc = {
  "error.report": { input: RendererError, output: v.void() },
  "analytics.track": { input: AnalyticsEventSchema, output: v.void() },
  "telemetry.status": {
    input: v.void(),
    output: v.strictObject({ enabled: v.boolean(), available: v.boolean() }),
  },
  "telemetry.choose": { input: v.strictObject({ enabled: v.boolean() }), output: v.void() },
  "vault.enroll": {
    input: v.strictObject({ key: VaultKeySchema, token: v.pipe(v.string(), v.minLength(1)) }),
    output: v.void(),
  },
  "vault.keys": { input: v.void(), output: v.array(VaultKeySchema) },
  "vault.forget": { input: ByKey, output: v.void() },
  "vault.standIn": { input: ByKey, output: v.nullable(v.string()) },
  "agent.run": { input: AgentRunInput, output: AgentRunOutput },
  "agent.source": { input: v.strictObject({ source: AgentSourceSchema }), output: v.void() },
  "claudeCode.status": { input: v.void(), output: ClaudeCodeStatus },
  "lms.schoolAt": { input: v.strictObject({ host: v.string() }), output: v.nullable(SchoolSchema) },
  "lms.verify": { input: BySchool, output: readOf(AccountInfoSchema) },
  "lms.courses": { input: BySchool, output: readOf(listOf(CourseSchema)) },
  "lms.assignments": { input: ByCourse, output: readOf(listOf(AssignmentSchema)) },
  "lms.students": { input: ByCourse, output: readOf(listOf(StudentSchema)) },
  "lms.submissions": { input: ByCourse, output: readOf(listOf(SubmissionSchema)) },
  "lms.file": {
    input: v.strictObject({
      school: SchoolSchema,
      submission: lmsRef("submission"),
      file: v.string(),
    }),
    output: readOf(FileContentSchema),
  },
  "lms.linkExport": {
    input: v.strictObject({ school: SchoolSchema, submission: lmsRef("submission") }),
    output: readOf(FileContentSchema),
  },
  "lms.conversations": { input: BySchool, output: readOf(listOf(ConversationSchema)) },
  "lms.announcements": { input: ByCourse, output: readOf(listOf(AnnouncementSchema)) },
  "lms.observe": {
    input: v.strictObject({ school: SchoolSchema, content: ChangeContentSchema }),
    output: readOf(RemoteStateSchema),
  },
  "lms.apply": {
    input: v.strictObject({
      school: SchoolSchema,
      permit: v.strictObject({
        changeId: ChangeIdSchema,
        content: ChangeContentSchema,
        fields: FieldKeysSchema,
      }),
    }),
    output: FieldOutcomesSchema,
  },
  "lms.newCourses": { input: BySchool, output: readOf(listOf(CourseShellSchema)) },
  "lms.copySources": { input: BySchool, output: readOf(listOf(SourceCourseSchema)) },
  "lms.courseContent": { input: ByCourse, output: readOf(CourseContentSchema) },
  "lms.migrations": { input: ByCourse, output: readOf(listOf(MigrationSchema)) },
  "lms.samplePackages": { input: BySchool, output: readOf(listOf(SamplePackageSchema)) },
  "lms.pickPackage": { input: BySchool, output: readOf(v.nullable(PickedPackageSchema)) },
  "lms.lab": { input: LabCommandSchema, output: v.void() },
  "lms.labNext": {
    input: v.strictObject({ after: v.nullable(v.number()) }),
    output: v.strictObject({ version: v.number(), lab: LabSnapshotSchema }),
  },
  "lms.stored": { input: v.void(), output: v.nullable(v.string()) },
  "lms.findSubmission": {
    input: v.strictObject({ student: v.string(), assignment: v.string() }),
    output: v.nullable(lmsRef("submission")),
  },
} satisfies Record<string, Channel>;

type Ipc = typeof ipc;
type ChannelName = keyof Ipc;
type Input<C extends ChannelName> = v.InferInput<Ipc[C]["input"]>;
type Output<C extends ChannelName> = v.InferOutput<Ipc[C]["output"]>;

export type Handlers = {
  readonly [C in ChannelName]: (
    input: v.InferOutput<Ipc[C]["input"]>,
  ) => Promise<v.InferInput<Ipc[C]["output"]>>;
};

type Register = (
  channel: string,
  listener: (sender: string | null, input: unknown) => Promise<unknown>,
) => void;

export const serve = <C extends ChannelName>(channel: C, handler: Handlers[C], input: unknown) =>
  handler(v.parse(ipc[channel].input, input));

export const handle = (
  register: Register,
  trusted: (sender: string) => boolean,
  handlers: Handlers,
) => {
  for (const channel of keysOf(ipc))
    register(channel, async (sender, input) => {
      if (sender === null || !trusted(sender)) throw new Error(`${channel}: untrusted sender`);
      return serve(channel, handlers[channel], input);
    });
};

export const FAKES_SWITCH = "--constellation-fakes";

export interface Bridge {
  readonly fakes: boolean;
  invoke<C extends ChannelName>(channel: C, input: Input<C>): Promise<Output<C>>;
}

const isChannel = (name: unknown): name is ChannelName =>
  typeof name === "string" && Object.hasOwn(ipc, name);

export const invoker =
  (send: (channel: ChannelName, input: unknown) => Promise<unknown>): Bridge["invoke"] =>
  async (channel, input) => {
    if (!isChannel(channel)) throw new Error(`No IPC channel named ${JSON.stringify(channel)}`);
    return v.parse(ipc[channel].output, await send(channel, input));
  };
