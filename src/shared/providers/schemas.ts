import * as v from "valibot";

import {
  FIELD_LABEL,
  type ChangeContent,
  type FieldKey,
  type LmsError,
  type RemoteEntry,
  type RemoteState,
} from "../domain/change";
import {
  isContentItemType,
  type ContentItemType,
  type CourseContent,
  type CourseShell,
  type Migration,
  type PickedPackage,
  type SamplePackage,
  type SourceCourse,
} from "../domain/content";
import type {
  ChangeId,
  IsoDate,
  IsoTime,
  LmsRef,
  Result,
  SchoolHost,
  SchoolId,
} from "../domain/ids";
import type {
  Announcement,
  Assignment,
  Conversation,
  Course,
  School,
  Student,
  Submission,
} from "../domain/lms";
import { isoDate, type TermDates, type TermPlan, type Weekday } from "../domain/term";

import type { AccountInfo, FieldOutcomes } from "./provider";

/*
 * What a provider's reads and writes carry across the bridge. Each schema is annotated with its domain type, so the
 * domain type stays the only definition and a schema that drifts from it fails to compile.
 */

const text = v.string();
const count = v.number();
const nullable = <T>(schema: v.GenericSchema<T>) => v.nullable(schema);

/** A whole list, as every provider read returns one. */
export const listOf = <T>(item: v.GenericSchema<T>): v.GenericSchema<readonly T[]> => v.array(item);

const brand = <T extends string>(check: (raw: string) => boolean = () => true) =>
  v.custom<T>((input) => typeof input === "string" && check(input));

export const SchoolIdSchema = brand<SchoolId>((raw) => raw !== "");
export const lmsRef = <K extends string>() => brand<LmsRef<K>>((raw) => raw !== "");
export const IsoTimeSchema = brand<IsoTime>((raw) => !Number.isNaN(Date.parse(raw)));
const IsoDateSchema = brand<IsoDate>((raw) => isoDate(raw) === raw);
const WeekdaySchema = v.custom<Weekday>(
  (input) => typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= 6,
);
export const FieldKeySchema = v.custom<FieldKey>(
  (input) => typeof input === "string" && Object.hasOwn(FIELD_LABEL, input),
);
export const FieldKeysSchema = listOf(FieldKeySchema);
export const ChangeIdSchema = brand<ChangeId>((raw) => raw !== "");

export const SchoolSchema: v.GenericSchema<School> = v.object({
  id: SchoolIdSchema,
  abbr: text,
  name: text,
  host: brand<SchoolHost>((raw) => raw !== ""),
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

/** A provider read: the value, or the LMS error it met. */
export const readOf = <T>(value: v.GenericSchema<T>): v.GenericSchema<Result<T, LmsError>> =>
  v.variant("ok", [
    v.object({ ok: v.literal(true), value }),
    v.object({ ok: v.literal(false), error: LmsErrorSchema }),
  ]);

// ---- Reads ----

export const AccountInfoSchema: v.GenericSchema<AccountInfo> = v.object({
  displayName: text,
  scopes: v.array(text),
});

export const CourseSchema: v.GenericSchema<Course> = v.object({
  ref: lmsRef<"course">(),
  school: SchoolIdSchema,
  code: text,
  title: text,
  section: nullable(text),
  modality: nullable(text),
  studentCount: count,
});

export const AssignmentSchema: v.GenericSchema<Assignment> = v.object({
  ref: lmsRef<"assignment">(),
  school: SchoolIdSchema,
  course: lmsRef<"course">(),
  title: text,
  shortTitle: text,
  dueAt: nullable(IsoTimeSchema),
  pointsPossible: count,
  rubric: nullable(v.array(v.object({ ref: lmsRef<"criterion">(), name: text, maxPoints: count }))),
  latePointsPerDay: nullable(count),
});

export const StudentSchema: v.GenericSchema<Student> = v.object({
  ref: lmsRef<"student">(),
  school: SchoolIdSchema,
  course: lmsRef<"course">(),
  name: text,
});

const ScoresSchema = v.record(text, count);

export const SubmissionSchema: v.GenericSchema<Submission> = v.object({
  ref: lmsRef<"submission">(),
  school: SchoolIdSchema,
  course: lmsRef<"course">(),
  assignment: lmsRef<"assignment">(),
  student: lmsRef<"student">(),
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
      kind: v.literal("media"),
      title: text,
      durationLabel: text,
      transcript: v.array(text),
    }),
    v.object({ kind: v.literal("none") }),
  ]),
});

export const ConversationSchema: v.GenericSchema<Conversation> = v.object({
  ref: lmsRef<"conversation">(),
  school: SchoolIdSchema,
  course: lmsRef<"course">(),
  subject: text,
  from: text,
  unread: v.boolean(),
  messages: v.array(
    v.object({ id: text, mine: v.boolean(), author: text, text, at: IsoTimeSchema }),
  ),
});

export const AnnouncementSchema: v.GenericSchema<Announcement> = v.object({
  ref: lmsRef<"announcement">(),
  school: SchoolIdSchema,
  course: lmsRef<"course">(),
  title: text,
  body: text,
  postedAt: IsoTimeSchema,
});

const EntriesSchema: v.GenericSchema<readonly RemoteEntry[]> = v.array(
  v.object({ id: text, mine: v.boolean(), text }),
);

export const RemoteStateSchema: v.GenericSchema<RemoteState> = v.variant("kind", [
  v.object({
    kind: v.literal("grade"),
    targetVersion: text,
    grade: nullable(count),
    rubric: nullable(ScoresSchema),
    excused: v.boolean(),
    comments: EntriesSchema,
    attachments: EntriesSchema,
  }),
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

// ---- Term setup reads ----

const TermDatesSchema: v.GenericSchema<TermDates> = v.object({
  name: text,
  start: IsoDateSchema,
  end: IsoDateSchema,
  days: v.array(WeekdaySchema),
});

export const CourseShellSchema: v.GenericSchema<CourseShell> = v.object({
  ref: lmsRef<"course">(),
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
  copyTarget: lmsRef<"migrations">(),
  stateTarget: lmsRef<"course-state">(),
});

export const SourceCourseSchema: v.GenericSchema<SourceCourse> = v.object({
  ref: lmsRef<"course">(),
  code: text,
  title: text,
  termName: text,
  startAt: nullable(IsoDateSchema),
  endAt: nullable(IsoDateSchema),
  meetingDays: v.array(WeekdaySchema),
  template: v.boolean(),
  dated: v.array(v.object({ ref: lmsRef<"item">(), title: text, dueAt: IsoTimeSchema })),
});

const ContentLinkFields = { text, url: text };

export const CourseContentSchema: v.GenericSchema<CourseContent> = v.object({
  shell: CourseShellSchema,
  version: text,
  items: v.array(
    v.object({
      ref: lmsRef<"item">(),
      type: v.custom<ContentItemType>(isContentItemType),
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
          v.object({ ...ContentLinkFields, points: v.literal("tool"), tool: lmsRef<"tool">() }),
        ]),
      ),
      copied: v.boolean(),
    }),
  ),
  modules: v.array(
    v.object({
      ref: lmsRef<"module">(),
      title: text,
      published: v.boolean(),
      itemCount: count,
      openUrl: text,
    }),
  ),
  tools: v.array(v.object({ ref: lmsRef<"tool">(), name: text, configured: v.boolean() })),
  policy: v.object({
    contactDomain: text,
    contactEmail: v.exactOptional(text),
    statements: v.array(v.object({ name: text, mustInclude: v.array(text), text })),
  }),
});

export const MigrationSchema: v.GenericSchema<Migration> = v.object({
  ref: lmsRef<"migration">(),
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
});

export const SamplePackageSchema: v.GenericSchema<SamplePackage> = v.object({
  name: text,
  kb: count,
  note: text,
  hint: nullable(TermDatesSchema),
});

// ---- Writes ----

const TermPlanSchema: v.GenericSchema<TermPlan> = v.object({
  oldTerm: TermDatesSchema,
  newTerm: TermDatesSchema,
  breaks: v.array(v.object({ name: text, start: IsoDateSchema, end: IsoDateSchema })),
});

const isWeekday = (input: unknown) => v.is(WeekdaySchema, input);
const SubstitutionsSchema = v.custom<Readonly<Partial<Record<Weekday, Weekday>>>>(
  (input) =>
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.entries(input).every(([day, to]) => isWeekday(Number(day)) && isWeekday(to)),
);

export const ChangeContentSchema: v.GenericSchema<ChangeContent> = v.variant("kind", [
  v.object({
    kind: v.literal("grade"),
    target: lmsRef<"submission">(),
    points: nullable(count),
    outOf: count,
    rubric: nullable(
      v.array(
        v.object({
          criterion: lmsRef<"criterion">(),
          name: text,
          points: nullable(count),
          outOf: count,
        }),
      ),
    ),
    late: nullable(v.object({ days: count, pointsPerDay: count, waived: v.boolean() })),
    comment: nullable(text),
    attachment: nullable(v.object({ name: text, kb: count })),
    override: nullable(count),
    excused: v.boolean(),
  }),
  v.object({ kind: v.literal("reply"), target: lmsRef<"conversation">(), body: text }),
  v.object({
    kind: v.literal("message"),
    target: lmsRef<"submission">(),
    subject: text,
    body: text,
  }),
  v.object({
    kind: v.literal("announcement"),
    target: lmsRef<"course">(),
    title: text,
    body: text,
  }),
  v.object({
    kind: v.literal("course-copy"),
    target: lmsRef<"migrations">(),
    into: v.object({ code: text, title: text }),
    source: v.variant("kind", [
      v.object({ kind: v.literal("course"), ref: lmsRef<"course">(), label: text, termName: text }),
      v.object({
        kind: v.literal("cartridge"),
        name: text,
        kb: count,
        hint: nullable(TermDatesSchema),
      }),
    ]),
    plan: TermPlanSchema,
    shift: v.object({
      oldStart: IsoDateSchema,
      oldEnd: IsoDateSchema,
      newStart: IsoDateSchema,
      newEnd: IsoDateSchema,
      substitutions: SubstitutionsSchema,
    }),
  }),
  v.object({
    kind: v.literal("text-fix"),
    target: lmsRef<"item">(),
    where: text,
    splice: v.object({ prefix: text, before: text, after: text, suffix: text }),
  }),
  v.object({
    kind: v.literal("item-set"),
    target: v.union([lmsRef<"item">(), lmsRef<"course-state">()]),
    where: text,
    intent: v.variant("set", [
      v.object({ set: v.literal("due-at"), at: IsoTimeSchema }),
      v.object({ set: v.literal("item-published") }),
      v.object({ set: v.literal("item-deleted") }),
      v.object({ set: v.literal("course-published") }),
      v.object({ set: v.literal("course-template") }),
    ]),
  }),
]);

const FieldOutcomeSchema = v.variant("status", [
  v.object({
    status: v.literal("landed"),
    at: IsoTimeSchema,
    via: v.picklist(["response", "observed", "user"]),
  }),
  v.object({ status: v.literal("failed"), error: LmsErrorSchema }),
  v.object({ status: v.literal("unknown"), since: IsoTimeSchema }),
]);

export const FieldOutcomesSchema: v.GenericSchema<FieldOutcomes> = v.custom<FieldOutcomes>(
  (input) =>
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.entries(input).every(
      ([field, outcome]) => v.is(FieldKeySchema, field) && v.is(FieldOutcomeSchema, outcome),
    ),
);
