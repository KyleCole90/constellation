import type { IsoDate, IsoTime, LmsRef } from "./ids";
import type { Course } from "./lms";
import type { Splice } from "./splice";
import type { DateShiftOptions, DraftDate, DueDay, TermDates, TermPlan, Weekday } from "./term";

// ---- What a provider returns for a new term. Neutral, with no wire types. ----

export interface CourseShell extends Course {
  termName: string;
  startAt: IsoDate | null;
  endAt: IsoDate | null;
  itemCount: number;
  copyTarget: LmsRef<"migrations">;
  stateTarget: LmsRef<"course-state">;
}

/**
 * Whether an unpublished course is one to set up for a coming term. Many schools hide term dates from teachers, so the
 * LMS says whether a course is over, and an unknown start counts as still to come.
 */
export const isComing = (
  course: { concluded: boolean; startAt: IsoDate | null },
  today: IsoDate,
): boolean => !course.concluded && (course.startAt === null || course.startAt > today);

/** Dashes, colons and the like a title can start or end with, which say nothing alone. */
const LOOSE_ENDS = /^[\s\-\u2013\u2014:|\u00b7,]+|[\s\-\u2013\u2014:|\u00b7,]+$/g;

/**
 * What a course's title says beyond its code, or null when nothing. Canvas often holds the code in the title too, as
 * code "Music Theory" with title "Music Theory -", so showing both would say it twice.
 */
export const titleBeyondCode = ({ code, title }: Pick<Course, "code" | "title">): string | null => {
  const trimmed = title.replace(LOOSE_ENDS, "");
  const prefix = code.trim();
  const repeats =
    prefix !== "" &&
    trimmed.toLowerCase().startsWith(prefix.toLowerCase()) &&
    !/\w/.test(trimmed.charAt(prefix.length));
  const rest = repeats ? trimmed.slice(prefix.length).replace(LOOSE_ENDS, "") : trimmed;
  return rest === "" ? null : rest;
};

/** A course's code and title, each said once. */
export const courseName = (course: Pick<Course, "code" | "title">): string =>
  [course.code, titleBeyondCode(course)].filter(Boolean).join(" ");

interface DatedItem {
  ref: LmsRef<"item">;
  title: string;
  dueAt: IsoTime;
}

export interface SourceCourse {
  ref: LmsRef<"course">;
  code: string;
  title: string;
  termName: string;
  /** Null when the school hides the term's dates and the course has none of its own; the person fills them in. */
  startAt: IsoDate | null;
  endAt: IsoDate | null;
  meetingDays: readonly Weekday[];
  template: boolean;
  dated: readonly DatedItem[];
}

export type CopySource =
  | { kind: "course"; ref: LmsRef<"course">; label: string; termName: string }
  | { kind: "cartridge"; name: string; kb: number; hint: PackageTerm | null };

/**
 * What a package says about its own term, and the due days it holds, as written in the course's own time zone. A real
 * export may leave out its end date, or have no due dates to read days from.
 */
export type PackageTerm = TermDates<DraftDate> & { dated: readonly DueDay[] };

/** A package main's file picker chose: its name, size and own term cross to the renderer, never its path or bytes. */
export type PickedPackage = Pick<SamplePackage, "name" | "kb"> & { hint: PackageTerm | null };

export interface SamplePackage {
  name: string;
  kb: number;
  note: string;
  hint: PackageTerm | null;
}

const CONTENT_ITEM_TYPES = ["syllabus", "page", "announcement", "assignment", "file"] as const;
export type ContentItemType = (typeof CONTENT_ITEM_TYPES)[number];
export const isContentItemType = (value: unknown): value is ContentItemType =>
  CONTENT_ITEM_TYPES.some((type) => type === value);

/** Classified by the provider, because URL grammar is vendor knowledge. Rules never parse a vendor URL. */
export type ContentLink = { text: string; url: string } & (
  | { points: "this-course" | "web" | "missing-page" | "missing-file" }
  | { points: "other-course"; replacement: string | null }
  | { points: "tool"; tool: LmsRef<"tool"> }
);

export interface ContentItem {
  ref: LmsRef<"item">;
  type: ContentItemType;
  title: string;
  body: string;
  published: boolean;
  dueAt: IsoTime | null;
  openUrl: string;
  links: readonly ContentLink[];
  /** Came in with a migration, rather than being written in this course. */
  copied: boolean;
}

export interface CourseModule {
  ref: LmsRef<"module">;
  title: string;
  published: boolean;
  itemCount: number;
  openUrl: string;
}

interface CourseTool {
  ref: LmsRef<"tool">;
  name: string;
  configured: boolean;
}

interface RequiredStatement {
  name: string;
  mustInclude: readonly string[];
  text: string;
}

export interface SchoolPolicy {
  contactDomain: string;
  /** This instructor's address at the school. What a foreign address is replaced with. */
  contactEmail?: string;
  statements: readonly RequiredStatement[];
}

export interface CourseContent {
  shell: CourseShell;
  /** Moves when anything in the course moves. A publish draft's targetVersion. */
  version: string;
  items: readonly ContentItem[];
  modules: readonly CourseModule[];
  tools: readonly CourseTool[];
  policy: SchoolPolicy;
}

export interface MigrationIssue {
  severity: "todo" | "warning" | "error";
  text: string;
  open: boolean;
  fixUrl: string | null;
}

export interface Migration {
  ref: LmsRef<"migration">;
  /** Equals the copy field's text. How a change finds its job. */
  signature: string;
  /** `stalled` has been preparing far longer than it should. It may still run, or may never have got its file. */
  state: "queued" | "preparing" | "stalled" | "running" | "completed" | "failed";
  completion: number;
  message: string | null;
  issues: readonly MigrationIssue[];
}

// ---- Setup content. Members of ChangeContent, so a copy and a finding's fix are changes like any other. ----

/** `plan` is what the person confirmed and what the preview reads. `shift` is what the LMS is told, and may carry day overrides. */
export interface CourseCopyContent {
  kind: "course-copy";
  target: LmsRef<"migrations">;
  into: { code: string; title: string };
  source: CopySource;
  plan: TermPlan;
  shift: DateShiftOptions;
}

export interface TextFixContent {
  kind: "text-fix";
  target: LmsRef<"item">;
  where: string;
  splice: Splice;
}

export type SetIntent =
  | { set: "due-at"; at: IsoTime }
  | { set: "item-published" }
  | { set: "item-deleted" }
  | { set: "course-published" }
  | { set: "course-template" };

export interface SetContent {
  kind: "item-set";
  target: LmsRef<"item"> | LmsRef<"course-state">;
  where: string;
  intent: SetIntent;
}
