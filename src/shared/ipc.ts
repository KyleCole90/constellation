import * as v from "valibot";

import { LabCommandSchema, LabSnapshotSchema } from "./providers/fake-canvas/lab";
import type { VaultKey } from "./providers/provider";
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
  RemoteStateSchema,
  SamplePackageSchema,
  SchoolSchema,
  SourceCourseSchema,
  StudentSchema,
  SubmissionSchema,
  listOf,
  lmsRef,
  readOf,
} from "./providers/schemas";

/**
 * A renderer error as it crosses to main: its type and its stack, never its message (docs/electron-spec.md, D23).
 * Strict, so a payload carrying anything more is rejected rather than trimmed.
 */
const RendererError = v.strictObject({ type: v.string(), stack: v.string() });

/** A school's id or `ai-key`. Main can't check a school id against anything yet, so any non-empty string passes. */
export const VaultKeySchema = v.custom<VaultKey>(
  (input) => typeof input === "string" && input !== "",
);
const ByKey = v.strictObject({ key: VaultKeySchema });
const BySchool = v.strictObject({ school: SchoolSchema });
const ByCourse = v.strictObject({ school: SchoolSchema, course: lmsRef<"course">() });

interface Channel {
  readonly input: v.GenericSchema;
  readonly output: v.GenericSchema;
}

/** Every channel between the renderer and main, declared once (docs/electron-spec.md, D16). */
const ipc = {
  "error.report": { input: RendererError, output: v.void() },
  "vault.enroll": {
    input: v.strictObject({ key: VaultKeySchema, token: v.pipe(v.string(), v.minLength(1)) }),
    output: v.void(),
  },
  "vault.keys": { input: v.void(), output: v.array(VaultKeySchema) },
  "vault.forget": { input: ByKey, output: v.void() },
  /**
   * A handle for the saved token, which never leaves main. Enrolling it again under the same key puts that token back,
   * which is how a refused replacement keeps the token it replaced. Null when there is no entry.
   */
  "vault.standIn": { input: ByKey, output: v.nullable(v.string()) },
  /** The school at an address: one of the fake's, or real Canvas at that host. Null when main knows none there. */
  "lms.schoolAt": { input: v.strictObject({ host: v.string() }), output: v.nullable(SchoolSchema) },
  // A school's LmsProvider, run in main with the token from main's vault (docs/electron-spec.md, step 10).
  "lms.verify": { input: BySchool, output: readOf(AccountInfoSchema) },
  "lms.courses": { input: BySchool, output: readOf(listOf(CourseSchema)) },
  "lms.assignments": { input: ByCourse, output: readOf(listOf(AssignmentSchema)) },
  "lms.students": { input: ByCourse, output: readOf(listOf(StudentSchema)) },
  "lms.submissions": { input: ByCourse, output: readOf(listOf(SubmissionSchema)) },
  "lms.conversations": { input: BySchool, output: readOf(listOf(ConversationSchema)) },
  "lms.announcements": { input: ByCourse, output: readOf(listOf(AnnouncementSchema)) },
  "lms.observe": {
    input: v.strictObject({ school: SchoolSchema, content: ChangeContentSchema }),
    output: readOf(RemoteStateSchema),
  },
  /** A SendPermit the renderer minted, as plain data. It asks; main decides (`lmsHandlers` in `src/main/lms.ts`). */
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
  /** The fake LMS's failure lab, which the Settings screen drives. */
  "lms.lab": { input: LabCommandSchema, output: v.void() },
  /**
   * The lab's state once it differs from `after`, so the renderer follows it over `invoke` alone. A null `after`
   * answers at once.
   */
  "lms.labNext": {
    input: v.strictObject({ after: v.nullable(v.number()) }),
    output: v.strictObject({ version: v.number(), lab: LabSnapshotSchema }),
  },
  /** Verify reads these. An unpackaged app only: a packaged one refuses them. */
  "lms.stored": { input: v.void(), output: v.nullable(v.string()) },
  "lms.findSubmission": {
    input: v.strictObject({ student: v.string(), assignment: v.string() }),
    output: v.nullable(lmsRef<"submission">()),
  },
} satisfies Record<string, Channel>;

type Ipc = typeof ipc;
type ChannelName = keyof Ipc;
type Input<C extends ChannelName> = v.InferInput<Ipc[C]["input"]>;
type Output<C extends ChannelName> = v.InferOutput<Ipc[C]["output"]>;

/** One handler per channel. A missing or misspelled one fails to compile. */
export type Handlers = {
  readonly [C in ChannelName]: (
    input: v.InferOutput<Ipc[C]["input"]>,
  ) => Promise<v.InferInput<Ipc[C]["output"]>>;
};

/**
 * `ipcMain.handle`, typed loosely enough that shared code needn't import `electron`.
 * Main passes each call's sender frame URL, or null when the frame is gone.
 */
type Register = (
  channel: string,
  listener: (sender: string | null, input: unknown) => Promise<unknown>,
) => void;

const serve = <C extends ChannelName>(channel: C, handler: Handlers[C], input: unknown) =>
  handler(v.parse(ipc[channel].input, input));

/**
 * Registers every handler in main. A call from a frame `trusted` refuses, or with an input that doesn't parse,
 * rejects before its handler runs.
 */
export const handle = (
  register: Register,
  trusted: (sender: string) => boolean,
  handlers: Handlers,
) => {
  for (const channel of Object.keys(ipc) as ChannelName[])
    register(channel, async (sender, input) => {
      if (sender === null || !trusted(sender)) throw new Error(`${channel}: untrusted sender`);
      return serve(channel, handlers[channel], input);
    });
};

/** What the preload exposes to the renderer as `window.constellation`. */
export interface Bridge {
  invoke<C extends ChannelName>(channel: C, input: Input<C>): Promise<Output<C>>;
}

const isChannel = (name: unknown): name is ChannelName =>
  typeof name === "string" && Object.hasOwn(ipc, name);

/**
 * The renderer's `invoke`, over `ipcRenderer.invoke`. The renderer is untrusted, so the channel is checked here too,
 * and each output is parsed before the renderer sees it.
 */
export const invoker =
  (send: (channel: ChannelName, input: unknown) => Promise<unknown>): Bridge["invoke"] =>
  async (channel, input) => {
    if (!isChannel(channel)) throw new Error(`No IPC channel named ${JSON.stringify(channel)}`);
    return v.parse(ipc[channel].output, await send(channel, input));
  };
