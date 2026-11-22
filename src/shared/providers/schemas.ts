import * as v from "valibot";

import {
  FIELD_KEYS,
  type ChangeContent,
  type FieldKey,
  type GradeContent,
  type LatePenalty,
  type LmsError,
  type RemoteEntry,
  type RemoteState,
} from "../domain/change";
import {
  CONTENT_ITEM_TYPES,
  type CopySource,
  type CourseContent,
  type CourseShell,
  type Migration,
  type PackageTerm,
  type PickedPackage,
  type SamplePackage,
  type SetContent,
  type SourceCourse,
  type TextFixContent,
} from "../domain/content";
import {
  parseIsoTime,
  parseSchoolHost,
  parseSchoolId,
  type ChangeId,
  type IsoDate,
  type IsoTime,
  type LmsRef,
  type Result,
  type SchoolHost,
  type SchoolId,
  type ThreadId,
} from "../domain/ids";
import type {
  Announcement,
  Assignment,
  Conversation,
  Course,
  School,
  FileContent,
  Student,
  Submission,
  SubmissionFile,
} from "../domain/lms";
import {
  isoDate,
  termName,
  type TermDates,
  type TermName,
  type TermPlan,
  type Weekday,
  WEEKDAYS,
} from "../domain/term";

import { refParts } from "./canvas-refs";
import type { AccountInfo, FieldOutcome, FieldOutcomes } from "./provider";

const text = v.string();
const count = v.number();
const nullable = <T>(schema: v.GenericSchema<T>) => v.nullable(schema);

export const listOf = <T>(item: v.GenericSchema<T>): v.GenericSchema<readonly T[]> => v.array(item);

export const brand = <T extends string>(check: (raw: string) => boolean = () => true) =>
  v.custom<T>((input) => typeof input === "string" && check(input));

export const SchoolIdSchema: v.GenericSchema<SchoolId> = brand<SchoolId>(
  (raw) => parseSchoolId(raw) === raw,
);
export const lmsRef = <K extends string>(_kind: K) =>
  brand<LmsRef<K>>((raw) => {
    const [school = "", ...ids] = refParts(raw);
    return parseSchoolId(school) === school && ids.length > 0 && ids.every((id) => id !== "");
  });
export const IsoTimeSchema: v.GenericSchema<IsoTime> = brand<IsoTime>(
  (raw) => parseIsoTime(raw) === raw,
);
export const IsoDateSchema: v.GenericSchema<IsoDate> = brand<IsoDate>(
  (raw) => isoDate(raw) === raw,
);
export const WeekdaySchema: v.GenericSchema<Weekday> = v.picklist(WEEKDAYS);
export const FieldKeySchema: v.GenericSchema<FieldKey> = v.picklist(FIELD_KEYS);
export const FieldKeysSchema: v.GenericSchema<readonly FieldKey[]> = listOf(FieldKeySchema);
export const ChangeIdSchema: v.GenericSchema<ChangeId> = brand<ChangeId>((raw) => raw !== "");
export const ThreadIdSchema: v.GenericSchema<ThreadId> = brand<ThreadId>((raw) => raw !== "");

export const SchoolSchema: v.GenericSchema<School> = v.object({
  id: SchoolIdSchema,
  abbr: text,
  name: text,
  host: brand<SchoolHost>((raw) => {
    const parsed = parseSchoolHost(raw);
    return parsed.ok && parsed.value === raw;
  }),
  provider: v.picklist(["fake-canvas", "canvas"]),
});

export const LmsErrorSchema: v.GenericSchema<LmsError> = v.variant("kind", [
  v.object({ kind: v.literal("auth_expired") }),
  v.object({ kind: v.literal("forbidden"), missingScope: nullable(text) }),
  v.object({ kind: v.literal("rate_limited"), retryAfterMs: nullable(count) }),
  v.object({ kind: v.literal("not_found") }),
  v.object({ kind: v.literal("rejected"), reason: text }),
  v.object({ kind: v.literal("unavailable"), status: nullable(count) }),
  v.object({ kind: v.literal("lost_response") }),
  v.object({ kind: v.literal("unsupported"), capability: text }),
]);

export const readOf = <T>(value: v.GenericSchema<T>): v.GenericSchema<Result<T, LmsError>> =>
  v.variant("ok", [
    v.object({ ok: v.literal(true), value }),
    v.object({ ok: v.literal(false), error: LmsErrorSchema }),
  ]);

export const AccountInfoSchema: v.GenericSchema<AccountInfo> = v.object({
  displayName: text,
  usedPermissions: v.array(text),
});

export const CourseSchema: v.GenericSchema<Course> = v.object({
  ref: lmsRef("course"),
  school: SchoolIdSchema,
  code: text,
  title: text,
  section: nullable(text),
  modality: nullable(text),
  studentCount: count,
});

export const AssignmentSchema: v.GenericSchema<Assignment> = v.object({
  ref: lmsRef("assignment"),
  school: SchoolIdSchema,
  course: lmsRef("course"),
  title: text,
  shortTitle: text,
  dueAt: nullable(IsoTimeSchema),
  pointsPossible: count,
  rubric: nullable(v.array(v.object({ ref: lmsRef("criterion"), name: text, maxPoints: count }))),
  latePointsPerDay: nullable(count),
});

export const StudentSchema: v.GenericSchema<Student> = v.object({
  ref: lmsRef("student"),
  school: SchoolIdSchema,
  course: lmsRef("course"),
  name: text,
});

const ScoresSchema: v.GenericSchema<Readonly<Record<LmsRef<"criterion">, number>>> = v.record(
  v.pipe(
    text,
    v.check((raw) => v.is(lmsRef("criterion"), raw)),
  ),
  count,
);

const FileSchema: v.GenericSchema<SubmissionFile> = v.object({
  id: text,
  name: text,
  mediaType: text,
  bytes: count,
});

export const SubmissionSchema: v.GenericSchema<Submission> = v.object({
  ref: lmsRef("submission"),
  school: SchoolIdSchema,
  course: lmsRef("course"),
  assignment: lmsRef("assignment"),
  student: lmsRef("student"),
  studentName: text,
  workflow: v.picklist(["unsubmitted", "missing", "submitted", "graded", "excused"]),
  attempt: count,
  lateDays: count,
  submittedAt: nullable(IsoTimeSchema),
  grade: nullable(count),
  rubricScores: nullable(ScoresSchema),
  comments: v.array(v.object({ id: text, mine: v.boolean(), text, at: IsoTimeSchema })),
  body: v.variant("kind", [
    v.object({
      kind: v.literal("text"),
      title: text,
      wordCount: count,
      paragraphs: v.array(text),
    }),
    v.object({
      kind: v.literal("discussion"),
      title: text,
      wordCount: count,
      paragraphs: v.array(text),
    }),
    v.object({
      kind: v.literal("media"),
      title: text,
      durationLabel: text,
      transcript: v.array(text),
    }),
    v.object({ kind: v.literal("url"), title: text, url: text, files: v.array(FileSchema) }),
    v.object({ kind: v.literal("upload"), title: text, files: v.array(FileSchema) }),
    v.object({ kind: v.literal("elsewhere"), title: text, what: text }),
    v.object({ kind: v.literal("none") }),
  ]),
  page: nullable(text),
});

export const FileContentSchema: v.GenericSchema<FileContent> = v.object({
  mediaType: text,
  data: v.instance(Uint8Array),
});

export const ConversationFields = {
  ref: lmsRef("conversation"),
  school: SchoolIdSchema,
  course: lmsRef("course"),
  subject: text,
  from: text,
  students: v.array(lmsRef("student")),
  unread: v.boolean(),
  messages: v.array(
    v.object({ id: text, mine: v.boolean(), author: text, text, at: IsoTimeSchema }),
  ),
};

export const ConversationSchema: v.GenericSchema<Conversation> = v.object(ConversationFields);

export const AnnouncementSchema: v.GenericSchema<Announcement> = v.object({
  ref: lmsRef("announcement"),
  school: SchoolIdSchema,
  course: lmsRef("course"),
  title: text,
  body: text,
  postedAt: IsoTimeSchema,
});

export const RemoteEntrySchema: v.GenericSchema<RemoteEntry> = v.object({
  id: text,
  mine: v.boolean(),
  text,
});
const EntriesSchema: v.GenericSchema<readonly RemoteEntry[]> = v.array(RemoteEntrySchema);

export const RemoteGradeSchema = v.object({
  kind: v.literal("grade"),
  targetVersion: text,
  grade: nullable(count),
  rubric: nullable(ScoresSchema),
  excused: v.boolean(),
  comments: EntriesSchema,
  attachments: EntriesSchema,
}) satisfies v.GenericSchema<Extract<RemoteState, { kind: "grade" }>>;

export const RemoteStateSchema: v.GenericSchema<RemoteState> = v.variant("kind", [
  RemoteGradeSchema,
  v.object({
    kind: v.picklist(["reply", "message"]),
    targetVersion: text,
    messages: EntriesSchema,
  }),
  v.object({ kind: v.literal("announcement"), targetVersion: text, posts: EntriesSchema }),
  v.object({
    kind: v.literal("course-copy"),
    targetVersion: text,
    students: count,
    items: count,
    migrations: EntriesSchema,
  }),
  v.object({ kind: v.literal("text-fix"), targetVersion: text, body: text }),
  v.object({ kind: v.literal("item-set"), targetVersion: text, value: nullable(text) }),
]);

const TermNameSchema: v.GenericSchema<TermName | null> = nullable(
  brand<TermName>((raw) => termName(raw) !== null),
);
const TermDatesSchema: v.GenericSchema<TermDates> = v.object({
  name: TermNameSchema,
  start: IsoDateSchema,
  end: IsoDateSchema,
  days: v.array(WeekdaySchema),
});

export const DraftDateSchema: v.GenericSchema<IsoDate | ""> = v.union([
  IsoDateSchema,
  v.literal(""),
]);
const PackageTermSchema: v.GenericSchema<PackageTerm> = v.object({
  name: TermNameSchema,
  start: DraftDateSchema,
  end: DraftDateSchema,
  days: v.array(WeekdaySchema),
  dated: v.array(v.object({ title: text, due: IsoDateSchema })),
});

export const CourseShellSchema: v.GenericSchema<CourseShell> = v.object({
  ref: lmsRef("course"),
  school: SchoolIdSchema,
  code: text,
  title: text,
  section: nullable(text),
  modality: nullable(text),
  studentCount: count,
  termName: text,
  startAt: nullable(IsoDateSchema),
  endAt: nullable(IsoDateSchema),
  itemCount: count,
  setUp: v.boolean(),
  copyTarget: lmsRef("migrations"),
  stateTarget: lmsRef("course-state"),
});

export const SourceCourseSchema: v.GenericSchema<SourceCourse> = v.object({
  ref: lmsRef("course"),
  code: text,
  title: text,
  termName: text,
  startAt: nullable(IsoDateSchema),
  endAt: nullable(IsoDateSchema),
  meetingDays: v.array(WeekdaySchema),
  template: v.boolean(),
  dated: v.array(v.object({ ref: lmsRef("item"), title: text, dueAt: IsoTimeSchema })),
});

const ContentLinkFields = { text, url: text };

export const CourseContentSchema: v.GenericSchema<CourseContent> = v.object({
  shell: CourseShellSchema,
  version: text,
  items: v.array(
    v.object({
      ref: lmsRef("item"),
      type: v.picklist(CONTENT_ITEM_TYPES),
      title: text,
      body: text,
      published: v.boolean(),
      dueAt: nullable(IsoTimeSchema),
      openUrl: text,
      links: v.array(
        v.variant("points", [
          v.object({
            ...ContentLinkFields,
            points: v.picklist(["this-course", "web", "missing-page", "missing-file"]),
          }),
          v.object({
            ...ContentLinkFields,
            points: v.literal("other-course"),
            replacement: nullable(text),
          }),
          v.object({ ...ContentLinkFields, points: v.literal("tool"), tool: lmsRef("tool") }),
        ]),
      ),
      copied: v.boolean(),
    }),
  ),
  modules: v.array(
    v.object({
      ref: lmsRef("module"),
      title: text,
      published: v.boolean(),
      itemCount: count,
      openUrl: text,
    }),
  ),
  tools: v.array(v.object({ ref: lmsRef("tool"), name: text, configured: v.boolean() })),
  policy: v.object({
    contactDomain: text,
    contactEmail: v.exactOptional(text),
    statements: v.array(v.object({ name: text, mustInclude: v.array(text), text })),
  }),
});

export const MigrationSchema: v.GenericSchema<Migration> = v.object({
  ref: lmsRef("migration"),
  signature: text,
  state: v.picklist(["queued", "preparing", "stalled", "running", "completed", "failed"]),
  completion: count,
  message: nullable(text),
  issues: v.array(
    v.object({
      severity: v.picklist(["todo", "warning", "error"]),
      text,
      open: v.boolean(),
      fixUrl: nullable(text),
    }),
  ),
});

export const PickedPackageSchema: v.GenericSchema<PickedPackage> = v.object({
  name: text,
  kb: count,
  hint: nullable(PackageTermSchema),
});

export const SamplePackageSchema: v.GenericSchema<SamplePackage> = v.object({
  name: text,
  kb: count,
  note: text,
  hint: nullable(PackageTermSchema),
});

export const TermPlanSchema: v.GenericSchema<TermPlan> = v.object({
  oldTerm: TermDatesSchema,
  newTerm: TermDatesSchema,
  breaks: v.array(v.object({ name: text, start: IsoDateSchema, end: IsoDateSchema })),
});

const substitute = v.exactOptional(WeekdaySchema);
export const SubstitutionsSchema: v.GenericSchema<Readonly<Partial<Record<Weekday, Weekday>>>> =
  v.strictObject({
    0: substitute,
    1: substitute,
    2: substitute,
    3: substitute,
    4: substitute,
    5: substitute,
    6: substitute,
  });

export const CopySourceSchema = v.variant("kind", [
  v.object({ kind: v.literal("course"), ref: lmsRef("course"), label: text, termName: text }),
  v.object({
    kind: v.literal("cartridge"),
    name: text,
    kb: count,
    hint: nullable(PackageTermSchema),
  }),
]) satisfies v.GenericSchema<CopySource>;

export const TextFixContentSchema = v.object({
  kind: v.literal("text-fix"),
  target: lmsRef("item"),
  where: text,
  splice: v.object({ prefix: text, before: text, after: text, suffix: text }),
}) satisfies v.GenericSchema<TextFixContent>;

export const ItemSetContentSchema = v.object({
  kind: v.literal("item-set"),
  target: lmsRef("item"),
  where: text,
  intent: v.variant("set", [
    v.object({ set: v.literal("due-at"), at: IsoTimeSchema }),
    v.object({ set: v.literal("item-published") }),
    v.object({ set: v.literal("item-deleted") }),
  ]),
}) satisfies v.GenericSchema<SetContent>;

export const CourseSetContentSchema = v.object({
  kind: v.literal("item-set"),
  target: lmsRef("course-state"),
  where: text,
  intent: v.variant("set", [
    v.object({ set: v.literal("course-published") }),
    v.object({ set: v.literal("course-template") }),
  ]),
}) satisfies v.GenericSchema<SetContent>;

export const LatePenaltySchema = v.object({
  days: count,
  pointsPerDay: count,
  waived: v.boolean(),
}) satisfies v.GenericSchema<LatePenalty>;

export const GradeContentSchema = v.object({
  kind: v.literal("grade"),
  target: lmsRef("submission"),
  points: nullable(count),
  outOf: count,
  rubric: nullable(
    v.array(
      v.object({
        criterion: lmsRef("criterion"),
        name: text,
        points: nullable(count),
        outOf: count,
      }),
    ),
  ),
  late: nullable(LatePenaltySchema),
  comment: nullable(text),
  attachment: nullable(v.object({ name: text, kb: count })),
  override: nullable(count),
  excused: v.boolean(),
}) satisfies v.GenericSchema<GradeContent>;

export const ChangeContentSchema: v.GenericSchema<ChangeContent> = v.variant("kind", [
  GradeContentSchema,
  v.object({ kind: v.literal("reply"), target: lmsRef("conversation"), body: text }),
  v.object({
    kind: v.literal("message"),
    target: lmsRef("submission"),
    subject: text,
    body: text,
  }),
  v.object({
    kind: v.literal("announcement"),
    target: lmsRef("course"),
    title: text,
    body: text,
  }),
  v.object({
    kind: v.literal("course-copy"),
    target: lmsRef("migrations"),
    into: v.object({ code: text, title: text }),
    source: CopySourceSchema,
    plan: TermPlanSchema,
    shift: v.object({
      oldStart: IsoDateSchema,
      oldEnd: IsoDateSchema,
      newStart: IsoDateSchema,
      newEnd: IsoDateSchema,
      substitutions: SubstitutionsSchema,
    }),
  }),
  TextFixContentSchema,
  ItemSetContentSchema,
  CourseSetContentSchema,
]);

export const FieldOutcomeSchema: v.GenericSchema<FieldOutcome> = v.variant("status", [
  v.object({
    status: v.literal("landed"),
    at: IsoTimeSchema,
    via: v.picklist(["response", "observed", "user"]),
  }),
  v.object({ status: v.literal("failed"), error: LmsErrorSchema }),
  v.object({ status: v.literal("unknown"), since: IsoTimeSchema }),
]);

export const FieldOutcomesSchema: v.GenericSchema<FieldOutcomes> = v.record(
  FieldKeySchema,
  FieldOutcomeSchema,
);
