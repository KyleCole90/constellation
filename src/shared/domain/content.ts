import type { IsoDate, IsoTime, LmsRef } from "./ids";
import type { Course } from "./lms";
import type { Splice } from "./splice";
import type { DateShiftOptions, DraftDate, DueDay, TermDates, TermPlan, Weekday } from "./term";

export interface CourseShell extends Course {
  termName: string;
  startAt: IsoDate | null;
  endAt: IsoDate | null;
  itemCount: number;
  setUp: boolean;
  copyTarget: LmsRef<"migrations">;
  stateTarget: LmsRef<"course-state">;
}

export const isComing = (
  course: { concluded: boolean; startAt: IsoDate | null },
  today: IsoDate,
): boolean => !course.concluded && (course.startAt === null || course.startAt > today);

const LOOSE_ENDS = /^[\s\-\u2013\u2014:|\u00b7,]+|[\s\-\u2013\u2014:|\u00b7,]+$/g;

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
  startAt: IsoDate | null;
  endAt: IsoDate | null;
  meetingDays: readonly Weekday[];
  template: boolean;
  dated: readonly DatedItem[];
}

export type CopySource =
  | { kind: "course"; ref: LmsRef<"course">; label: string; termName: string }
  | { kind: "cartridge"; name: string; kb: number; hint: PackageTerm | null };

export const sourceName = (source: CopySource): string => {
  if (source.kind === "cartridge") return source.name;
  return source.termName === "" ? source.label : `${source.label} (${source.termName})`;
};

export type PackageTerm = TermDates<DraftDate> & { dated: readonly DueDay[] };

export type PickedPackage = Pick<SamplePackage, "name" | "kb"> & { hint: PackageTerm | null };

export interface SamplePackage {
  name: string;
  kb: number;
  note: string;
  hint: PackageTerm | null;
}

export const CONTENT_ITEM_TYPES = [
  "syllabus",
  "page",
  "announcement",
  "assignment",
  "file",
] as const;
export type ContentItemType = (typeof CONTENT_ITEM_TYPES)[number];
export const isContentItemType = (value: unknown): value is ContentItemType =>
  CONTENT_ITEM_TYPES.some((type) => type === value);

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
  contactEmail?: string;
  statements: readonly RequiredStatement[];
}

export interface CourseContent {
  shell: CourseShell;
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
  signature: string;
  state: "queued" | "preparing" | "stalled" | "running" | "completed" | "failed";
  completion: number;
  message: string | null;
  issues: readonly MigrationIssue[];
}

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

export type ItemSetIntent =
  | { set: "due-at"; at: IsoTime }
  | { set: "item-published" }
  | { set: "item-deleted" };
type CourseSetIntent = { set: "course-published" } | { set: "course-template" };
export type SetIntent = ItemSetIntent | CourseSetIntent;

export type SetContent = ItemSetContent | CourseSetContent;
interface ItemSetContent {
  kind: "item-set";
  target: LmsRef<"item">;
  where: string;
  intent: ItemSetIntent;
}
export interface CourseSetContent {
  kind: "item-set";
  target: LmsRef<"course-state">;
  where: string;
  intent: CourseSetIntent;
}

export const isCourseSet = (content: SetContent): content is CourseSetContent =>
  content.intent.set === "course-published" || content.intent.set === "course-template";
