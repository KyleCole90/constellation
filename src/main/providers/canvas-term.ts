import { createHash } from "node:crypto";

import * as v from "valibot";

import type {
  CourseCopyContent,
  FieldKey,
  LmsError,
  RemoteState,
  SetContent,
  TextFixContent,
} from "../../shared/domain/change";
import { copySignature } from "../../shared/domain/change";
import {
  isContentItemType,
  type ContentItem,
  type ContentItemType,
  type CourseContent,
  type CourseShell,
  type Migration,
  type SourceCourse,
} from "../../shared/domain/content";
import {
  isoTime,
  parseIsoTime,
  type IsoTime,
  type LmsRef,
  type Result,
} from "../../shared/domain/ids";
import type { School } from "../../shared/domain/lms";
import { applySplice, spliceState } from "../../shared/domain/splice";
import { dateOfTime, type Weekday } from "../../shared/domain/term";
import { classifyLink } from "../../shared/providers/canvas-links";
import { refParts, refs } from "../../shared/providers/canvas-refs";
import type { FieldOutcomes, Read, TermSetup } from "../../shared/providers/provider";

type Outcome = NonNullable<FieldOutcomes[FieldKey]>;
type SetupContent = CourseCopyContent | TextFixContent | SetContent;

/** The request helpers `createCanvasProvider` builds, so term setup shares its paging, origin check and error mapping. */
export interface CanvasClient {
  school: School;
  now(): number;
  list<T extends v.GenericSchema>(path: string, row: T): Read<v.InferOutput<T>[]>;
  one<T extends v.GenericSchema>(path: string, schema: T): Read<v.InferOutput<T>>;
  write(method: "PUT" | "POST" | "DELETE", path: string, form: URLSearchParams): Promise<Outcome>;
  me(): Promise<Result<number, LmsError>>;
  /** The Canvas ids in a ref this school minted, or null. */
  idsIn(ref: string, kind: string, count: number): number[] | null;
  /** A name or draft as one line of main's send dialog. */
  oneLine(text: string): string;
  named(text: string): string;
}

export interface SendDescription {
  target: string;
  lines: readonly string[];
}

// ---- What Canvas sends for term setup, per its public API docs. ----

const Id = v.pipe(v.number(), v.integer());
const Time = v.pipe(
  v.string(),
  v.check((raw) => parseIsoTime(raw) !== null),
  v.transform((raw): IsoTime => isoTime(raw)),
);
const OptionalTime = v.nullish(Time, null);

const SetupCourse = v.object({
  id: Id,
  name: v.string(),
  course_code: v.string(),
  workflow_state: v.string(),
  start_at: OptionalTime,
  end_at: OptionalTime,
  total_students: v.nullish(v.number(), 0),
  /** A course an account offers as a template. Absent on schools without course templates. */
  template: v.nullish(v.boolean(), false),
  term: v.nullish(
    v.object({ name: v.nullish(v.string(), ""), start_at: OptionalTime, end_at: OptionalTime }),
    null,
  ),
  syllabus_body: v.nullish(v.string(), null),
});
type SetupCourseRow = v.InferOutput<typeof SetupCourse>;
const SetupCourseRow = v.union([
  v.object({ id: Id, access_restricted_by_date: v.literal(true) }),
  SetupCourse,
]);
const DatedRow = v.object({ id: Id, name: v.string(), due_at: OptionalTime });
const PageRow = v.object({
  page_id: Id,
  url: v.string(),
  title: v.string(),
  published: v.nullish(v.boolean(), true),
  html_url: v.nullish(v.string(), null),
  created_at: OptionalTime,
});
const PageBody = v.object({ page_id: Id, body: v.nullish(v.string(), "") });
const AssignmentItem = v.object({
  id: Id,
  name: v.string(),
  description: v.nullish(v.string(), ""),
  due_at: OptionalTime,
  published: v.nullish(v.boolean(), true),
  html_url: v.nullish(v.string(), null),
  created_at: OptionalTime,
});
const TopicItem = v.object({
  id: Id,
  title: v.string(),
  message: v.nullish(v.string(), ""),
  published: v.nullish(v.boolean(), true),
  html_url: v.nullish(v.string(), null),
  created_at: OptionalTime,
});
const FileItem = v.object({
  id: Id,
  display_name: v.string(),
  locked: v.nullish(v.boolean(), false),
  hidden: v.nullish(v.boolean(), false),
  created_at: OptionalTime,
});
const ModuleRow = v.object({
  id: Id,
  name: v.string(),
  published: v.nullish(v.boolean(), true),
  items_count: v.nullish(v.number(), 0),
});
const ToolRow = v.object({ id: Id, name: v.string() });
const Profile = v.object({ primary_email: v.nullish(v.string(), null) });
/** Canvas sends `settings.source_course_id` on a course copy, as a number or a numeric string. */
const SourceId = v.union([
  Id,
  v.pipe(
    v.string(),
    v.regex(/^\d+$/),
    v.transform((raw) => Number(raw)),
  ),
]);
const MigrationRow = v.object({
  id: Id,
  migration_type: v.nullish(v.string(), ""),
  workflow_state: v.string(),
  user_id: v.nullish(Id, null),
  started_at: OptionalTime,
  finished_at: OptionalTime,
  progress_url: v.nullish(v.string(), null),
  settings: v.nullish(v.object({ source_course_id: v.nullish(SourceId, null) }), null),
});
type MigrationRow = v.InferOutput<typeof MigrationRow>;
const ProgressRow = v.object({
  workflow_state: v.string(),
  completion: v.nullish(v.number(), 0),
  message: v.nullish(v.string(), null),
});
const IssueRow = v.object({
  issue_type: v.picklist(["todo", "warning", "error"]),
  description: v.nullish(v.string(), ""),
  workflow_state: v.string(),
  fix_issue_html_url: v.nullish(v.string(), null),
});

const ACTIVE = new Set(["pre_processing", "pre_processed", "waiting_for_select", "running"]);
const stateOf = (row: MigrationRow, progress: string | null): Migration["state"] => {
  if (row.workflow_state === "completed") return "completed";
  if (row.workflow_state === "failed" || progress === "failed") return "failed";
  if (row.workflow_state === "running") return progress === "queued" ? "queued" : "running";
  return "preparing";
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const dayName = (day: Weekday): string => DAY_NAMES[day];
const dateOf = (at: IsoTime | null) => (at === null ? null : dateOfTime(at));
const hashOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
/** A sentence's closing mark isn't part of the address it ends on. */
const BARE_URL = /https?:\/\/[^\s"'<>]*[^\s"'<>.,;:!?)]/g;
const REFUSED_FILE_TEXT = "This app doesn't edit files in Canvas.";

/**
 * Term setup on a school's real Canvas (docs/electron-spec.md, step 13): the reads a new term needs, and the writes a
 * copy, a fix, a publish and a template send, each one request. Long jobs aren't waited on here: `migrations` reads
 * each job's progress once, and the setup screen asks again.
 */
export const canvasTermSetup = (client: CanvasClient) => {
  const { school, list, one, write, idsIn } = client;
  const origin = `https://${school.host}`;
  const NOT_FOUND = { ok: false, error: { kind: "not_found" } } as const;
  const refused = (reason: string): Promise<Outcome> =>
    Promise.resolve({ status: "failed", error: { kind: "rejected", reason } });

  const course = (id: number) =>
    one(
      `/courses/${id}?include[]=term&include[]=total_students&include[]=syllabus_body`,
      SetupCourse,
    );
  /** A course's own dates, or its term's when it has none. */
  const datesOf = (row: SetupCourseRow) => ({
    start: dateOf(row.start_at ?? row.term?.start_at ?? null),
    end: dateOf(row.end_at ?? row.term?.end_at ?? null),
  });

  const shellOf = (row: SetupCourseRow, itemCount: number): CourseShell => {
    const { start, end } = datesOf(row);
    return {
      ref: refs.course(school.id, row.id),
      school: school.id,
      code: row.course_code,
      title: row.name,
      section: null,
      modality: null,
      studentCount: row.total_students,
      termName: row.term?.name ?? "",
      startAt: start,
      endAt: end,
      itemCount,
      copyTarget: refs.migrations(school.id, row.id),
      stateTarget: refs.courseState(school.id, row.id),
    };
  };

  /** What a copy would land on top of: everything a course lists, without reading any bodies. */
  const itemCount = async (id: number): Read<number> => {
    let count = 0;
    for (const [path, row] of [
      [`/courses/${id}/pages`, PageRow],
      [`/courses/${id}/assignments`, DatedRow],
      [`/courses/${id}/discussion_topics?only_announcements=true`, TopicItem],
      [`/courses/${id}/files`, FileItem],
    ] as const) {
      const rows = await list(path, row);
      if (!rows.ok) return rows;
      count += rows.value.length;
    }
    return { ok: true, value: count };
  };

  const teacherCourses = (states: string) =>
    list(
      `/courses?enrollment_type=teacher&include[]=term&include[]=total_students&${states}`,
      SetupCourseRow,
    );
  const readable = (rows: v.InferOutput<typeof SetupCourseRow>[]): SetupCourseRow[] =>
    rows.flatMap((row) => ("access_restricted_by_date" in row ? [] : [row]));

  const newCourses = async (): Read<readonly CourseShell[]> => {
    const rows = await teacherCourses("state[]=unpublished");
    if (!rows.ok) return rows;
    const today = dateOfTime(isoTime(client.now()));
    const out: CourseShell[] = [];
    for (const row of readable(rows.value)) {
      const start = datesOf(row).start;
      if (row.workflow_state !== "unpublished" || start === null || start <= today) continue;
      const count = await itemCount(row.id);
      if (!count.ok) return count;
      out.push(shellOf(row, count.value));
    }
    return { ok: true, value: out };
  };

  /** Courses taught before, and any course saved as a template. A course with no dates of its own or its term's can't be shifted from, so it isn't offered. */
  const copySources = async (): Read<readonly SourceCourse[]> => {
    const rows = await teacherCourses("state[]=available&state[]=completed&state[]=unpublished");
    if (!rows.ok) return rows;
    const out: SourceCourse[] = [];
    for (const row of readable(rows.value)) {
      const { start, end } = datesOf(row);
      if ((row.workflow_state === "unpublished" && !row.template) || start === null || end === null)
        continue;
      const dated = await list(`/courses/${row.id}/assignments`, DatedRow);
      if (!dated.ok) return dated;
      out.push({
        ref: refs.course(school.id, row.id),
        code: row.course_code,
        title: row.name,
        termName: row.term?.name ?? "",
        startAt: start,
        endAt: end,
        // Canvas keeps no meeting pattern, so the person names the days on the Dates step.
        meetingDays: [],
        template: row.template,
        dated: dated.value.flatMap((item) =>
          item.due_at === null
            ? []
            : [
                {
                  ref: refs.item(school.id, row.id, "assignment", item.id),
                  title: item.name,
                  dueAt: item.due_at,
                },
              ],
        ),
      });
    }
    return { ok: true, value: out.sort((a, b) => Number(b.template) - Number(a.template)) };
  };

  const migrationRows = async (id: number): Read<MigrationRow[]> => {
    const rows = await list(`/courses/${id}/content_migrations`, MigrationRow);
    return rows.ok ? { ok: true, value: rows.value.toSorted((a, b) => a.id - b.id) } : rows;
  };
  /** A job by the words a copy change carries: the course it copied from. Any other job matches no change. */
  const signatureOf = (row: MigrationRow): string => {
    const source = row.settings?.source_course_id ?? null;
    return row.migration_type === "course_copy_importer" && source !== null
      ? copySignature({
          source: { kind: "course", ref: refs.course(school.id, source), label: "", termName: "" },
        })
      : `migration:${row.id}`;
  };
  const progressOf = async (row: MigrationRow) => {
    const id = /^\/api\/v1\/progress\/(\d+)$/.exec(
      row.progress_url !== null &&
        URL.canParse(row.progress_url) &&
        new URL(row.progress_url).origin === origin
        ? new URL(row.progress_url).pathname
        : "",
    )?.[1];
    return id === undefined ? null : one(`/progress/${id}`, ProgressRow);
  };

  /** Every job, oldest first. A live or failed job's progress is read once; a finished job's issues come with it. */
  const migrations = (courseRef: LmsRef<"course">): Read<readonly Migration[]> => {
    const [id] = idsIn(courseRef, "course", 1) ?? [];
    if (id === undefined) return Promise.resolve(NOT_FOUND);
    return (async () => {
      const rows = await migrationRows(id);
      if (!rows.ok) return rows;
      const out: Migration[] = [];
      for (const row of rows.value) {
        const progress = row.workflow_state === "completed" ? null : await progressOf(row);
        if (progress && !progress.ok) return progress;
        const state = stateOf(row, progress?.value.workflow_state ?? null);
        let issues: Migration["issues"] = [];
        if (!ACTIVE.has(row.workflow_state)) {
          const read = await list(
            `/courses/${id}/content_migrations/${row.id}/migration_issues`,
            IssueRow,
          );
          if (!read.ok) return read;
          issues = read.value.map((issue) => ({
            severity: issue.issue_type,
            text: issue.description,
            open: issue.workflow_state === "active",
            fixUrl: issue.fix_issue_html_url,
          }));
        }
        out.push({
          ref: refs.migration(school.id, id, row.id),
          signature: signatureOf(row),
          state,
          completion: state === "completed" ? 100 : (progress?.value.completion ?? 0),
          message: progress?.value.message ?? null,
          issues,
        });
      }
      return { ok: true, value: out };
    })();
  };

  const courseContent = (courseRef: LmsRef<"course">): Read<CourseContent> => {
    const [id] = idsIn(courseRef, "course", 1) ?? [];
    if (id === undefined) return Promise.resolve(NOT_FOUND);
    return (async () => {
      const row = await course(id);
      if (!row.ok) return row;
      const pages = await list(`/courses/${id}/pages`, PageRow);
      if (!pages.ok) return pages;
      const assignments = await list(`/courses/${id}/assignments`, AssignmentItem);
      if (!assignments.ok) return assignments;
      const topics = await list(
        `/courses/${id}/discussion_topics?only_announcements=true`,
        TopicItem,
      );
      if (!topics.ok) return topics;
      const files = await list(`/courses/${id}/files`, FileItem);
      if (!files.ok) return files;
      const modules = await list(`/courses/${id}/modules`, ModuleRow);
      if (!modules.ok) return modules;
      const tools = await list(`/courses/${id}/external_tools`, ToolRow);
      if (!tools.ok) return tools;
      const jobs = await migrationRows(id);
      if (!jobs.ok) return jobs;
      const profile = await one("/users/self/profile", Profile);
      if (!profile.ok) return profile;
      const bodies = new Map<number, string>();
      for (const page of pages.value) {
        const read = await one(`/courses/${id}/pages/${page.page_id}`, PageBody);
        if (!read.ok) return read;
        bodies.set(page.page_id, read.value.body);
      }

      /** Canvas marks no item as copied, so an item made while a copy into this course ran came with it. */
      const windows = jobs.value.flatMap((job) =>
        job.workflow_state === "completed" && job.started_at !== null && job.finished_at !== null
          ? [{ from: job.started_at, to: job.finished_at }]
          : [],
      );
      const copied = (at: IsoTime | null) =>
        at !== null && windows.some(({ from, to }) => at >= from && at <= to);
      const ctx = {
        school: school.id,
        host: school.host,
        courseId: id,
        pages: new Set(pages.value.map((page) => page.url)),
        files: new Set(files.value.map((file) => file.id)),
      };
      /** Every anchor's href, and every web address written out as text outside an anchor. */
      const linksIn = (html: string) => {
        const anchors = [...html.matchAll(ANCHOR)].map((match) => ({
          from: match.index,
          to: match.index + match[0].length,
          link: classifyLink(
            { text: client.oneLine((match[3] ?? "").replace(/<[^>]*>/g, "")), url: match[2] ?? "" },
            ctx,
          ),
        }));
        const bare = [...html.matchAll(BARE_URL)].flatMap((match) =>
          anchors.some(({ from, to }) => match.index >= from && match.index < to)
            ? []
            : [{ from: match.index, link: classifyLink({ text: match[0], url: match[0] }, ctx) }],
        );
        return [...anchors, ...bare].sort((a, b) => a.from - b.from).map(({ link }) => link);
      };
      const item = (
        type: ContentItemType,
        itemId: number,
        fields: {
          title: string;
          body: string;
          published: boolean;
          dueAt: IsoTime | null;
          openUrl: string | null;
          copied: boolean;
        },
      ): ContentItem => ({
        ref: refs.item(school.id, id, type, itemId),
        type,
        title: fields.title,
        body: fields.body,
        published: fields.published,
        dueAt: fields.dueAt,
        openUrl: fields.openUrl ?? `${origin}/courses/${id}`,
        links: linksIn(fields.body),
        copied: fields.copied,
      });
      const syllabus = row.value.syllabus_body ?? "";
      const items: ContentItem[] = [
        ...(syllabus === ""
          ? []
          : [
              item("syllabus", id, {
                title: "Syllabus",
                body: syllabus,
                published: true,
                dueAt: null,
                openUrl: `${origin}/courses/${id}/assignments/syllabus`,
                // The syllabus is a course field with no date of its own, and a copy brings it.
                copied: windows.length > 0,
              }),
            ]),
        ...pages.value.map((page) =>
          item("page", page.page_id, {
            title: page.title,
            body: bodies.get(page.page_id) ?? "",
            published: page.published,
            dueAt: null,
            openUrl: page.html_url,
            copied: copied(page.created_at),
          }),
        ),
        ...topics.value.map((topic) =>
          item("announcement", topic.id, {
            title: topic.title,
            body: topic.message,
            published: topic.published,
            dueAt: null,
            openUrl: topic.html_url,
            copied: copied(topic.created_at),
          }),
        ),
        ...assignments.value.map((assignment) =>
          item("assignment", assignment.id, {
            title: assignment.name,
            body: assignment.description,
            published: assignment.published,
            dueAt: assignment.due_at,
            openUrl: assignment.html_url,
            copied: copied(assignment.created_at),
          }),
        ),
        ...files.value.map((file) =>
          item("file", file.id, {
            title: file.display_name,
            body: "",
            published: !file.locked && !file.hidden,
            dueAt: null,
            openUrl: `${origin}/courses/${id}/files/${file.id}`,
            copied: copied(file.created_at),
          }),
        ),
      ];
      const email = profile.value.primary_email;
      const domain = email?.split("@")[1] ?? "";
      const value: CourseContent = {
        shell: shellOf(
          row.value,
          pages.value.length + topics.value.length + assignments.value.length + files.value.length,
        ),
        version: hashOf([row.value, items, modules.value, tools.value]),
        items,
        modules: modules.value.map((module) => ({
          ref: refs.module(school.id, id, module.id),
          title: module.name,
          published: module.published,
          itemCount: module.items_count,
          openUrl: `${origin}/courses/${id}/modules/${module.id}`,
        })),
        // A tool Canvas lists for the course, its own or its account's, is set up for it.
        tools: tools.value.map((tool) => ({
          ref: refs.tool(school.id, id, tool.id),
          name: tool.name,
          configured: true,
        })),
        // Canvas keeps no required statements, so only the teacher's own address is school policy here.
        policy:
          email === null || domain === ""
            ? { contactDomain: school.host, statements: [] }
            : { contactDomain: domain, contactEmail: email, statements: [] },
      };
      return { ok: true, value };
    })();
  };

  const termSetup: TermSetup = {
    newCourses,
    copySources,
    courseContent,
    migrations,
    // Uploading a package comes with step 14, so there is none to offer yet.
    samplePackages: () => Promise.resolve({ ok: true, value: [] }),
  };

  // ---- Writes. Each ref comes from the untrusted renderer, so it is parsed before any path is built. ----

  /** An item ref this school minted: `<school>:item:<course>:<type>:<id>`. */
  const itemAt = (ref: string) => {
    const [owner, kind, courseId, type, itemId, ...rest] = refParts(ref);
    if (
      owner !== school.id ||
      kind !== "item" ||
      !isContentItemType(type) ||
      !/^\d+$/.test(courseId ?? "") ||
      !/^\d+$/.test(itemId ?? "") ||
      rest.length > 0
    )
      return null;
    const course = Number(courseId);
    const id = Number(itemId);
    return { course, id, type, base: `/courses/${course}` };
  };
  type ItemAt = NonNullable<ReturnType<typeof itemAt>>;

  /** The rich text an item holds, as Canvas stores it, and the form key that writes it back. */
  const textOf = async (
    at: ItemAt,
  ): Read<{ body: string; title: string; path: string; key: string }> => {
    switch (at.type) {
      case "syllabus": {
        const read = await course(at.course);
        return read.ok
          ? {
              ok: true,
              value: {
                body: read.value.syllabus_body ?? "",
                title: "Syllabus",
                path: at.base,
                key: "course[syllabus_body]",
              },
            }
          : read;
      }
      case "page": {
        const path = `${at.base}/pages/${at.id}`;
        const read = await one(
          path,
          v.object({ title: v.string(), body: v.nullish(v.string(), "") }),
        );
        return read.ok
          ? { ok: true, value: { ...read.value, path, key: "wiki_page[body]" } }
          : read;
      }
      case "assignment": {
        const path = `${at.base}/assignments/${at.id}`;
        const read = await one(path, AssignmentItem);
        return read.ok
          ? {
              ok: true,
              value: {
                body: read.value.description,
                title: read.value.name,
                path,
                key: "assignment[description]",
              },
            }
          : read;
      }
      case "announcement": {
        const path = `${at.base}/discussion_topics/${at.id}`;
        const read = await one(path, TopicItem);
        return read.ok
          ? {
              ok: true,
              value: { body: read.value.message, title: read.value.title, path, key: "message" },
            }
          : read;
      }
      // A file has no text to fix, but has a name for the send dialog.
      case "file": {
        const read = await one(`${at.base}/files/${at.id}`, FileItem);
        return read.ok
          ? { ok: true, value: { body: "", title: read.value.display_name, path: "", key: "" } }
          : read;
      }
    }
  };

  /** Where an item's published state is read and written, and the form that publishes it. Null for the syllabus. */
  const publishOf = (
    at: ItemAt,
  ): { read?: string; path: string; form: Record<string, string> } | null => {
    switch (at.type) {
      case "page":
        return { path: `${at.base}/pages/${at.id}`, form: { "wiki_page[published]": "true" } };
      case "assignment":
        return {
          path: `${at.base}/assignments/${at.id}`,
          form: { "assignment[published]": "true" },
        };
      case "announcement":
        return { path: `${at.base}/discussion_topics/${at.id}`, form: { published: "true" } };
      case "file":
        // Canvas writes a file at `/files/:id` only, which names no course, so the read goes through the course.
        return {
          read: `${at.base}/files/${at.id}`,
          path: `/files/${at.id}`,
          form: { locked: "false", hidden: "false" },
        };
      case "syllabus":
        return null;
    }
  };
  const Published = v.object({
    published: v.nullish(v.boolean(), null),
    locked: v.nullish(v.boolean(), false),
    hidden: v.nullish(v.boolean(), false),
  });

  const courseStateAt = (ref: string) => idsIn(ref, "course-state", 1)?.[0];
  const shiftForm = ({ shift }: CourseCopyContent, form: URLSearchParams) => {
    form.set("date_shift_options[shift_dates]", "true");
    form.set("date_shift_options[old_start_date]", shift.oldStart);
    form.set("date_shift_options[old_end_date]", shift.oldEnd);
    form.set("date_shift_options[new_start_date]", shift.newStart);
    form.set("date_shift_options[new_end_date]", shift.newEnd);
    for (const [day, to] of Object.entries(shift.substitutions))
      form.set(`date_shift_options[day_substitutions][${day}]`, String(to));
    return form;
  };
  const copyIds = (content: CourseCopyContent) => {
    const [target] = idsIn(content.target, "migrations", 1) ?? [];
    const [source] =
      content.source.kind === "course" ? (idsIn(content.source.ref, "course", 1) ?? []) : [];
    return target === undefined || source === undefined ? null : { target, source };
  };
  const CARTRIDGE = "Uploading a course package to Canvas comes in a later version.";

  const writeOf = async (content: SetupContent, field: FieldKey): Promise<Outcome> => {
    switch (content.kind) {
      case "course-copy": {
        if (field !== "copy") break;
        if (content.source.kind === "cartridge") return refused(CARTRIDGE);
        const ids = copyIds(content);
        if (!ids) return refused("That course isn't at this school.");
        const form = new URLSearchParams({
          migration_type: "course_copy_importer",
          "settings[source_course_id]": String(ids.source),
        });
        return write("POST", `/courses/${ids.target}/content_migrations`, shiftForm(content, form));
      }
      case "text-fix": {
        if (field !== "text") break;
        const at = itemAt(content.target);
        if (!at) return refused("That item isn't at this school.");
        if (at.type === "file") return refused(REFUSED_FILE_TEXT);
        const read = await textOf(at);
        if (!read.ok) return { status: "failed", error: read.error };
        if (spliceState(read.value.body, content.splice) !== "ready")
          return refused("The passage changed in Canvas since it was read.");
        return write(
          "PUT",
          read.value.path,
          new URLSearchParams({ [read.value.key]: applySplice(read.value.body, content.splice) }),
        );
      }
      case "item-set": {
        if (field !== "value") break;
        const { intent } = content;
        switch (intent.set) {
          case "course-published":
          case "course-template": {
            const id = courseStateAt(content.target);
            if (id === undefined) return refused("That course isn't at this school.");
            return write(
              "PUT",
              `/courses/${id}`,
              new URLSearchParams(
                intent.set === "course-published"
                  ? { event: "offer" }
                  : { "course[template]": "true" },
              ),
            );
          }
          case "due-at": {
            const at = itemAt(content.target);
            if (at?.type !== "assignment")
              return refused("Only an assignment's due date is set from here.");
            return write(
              "PUT",
              `${at.base}/assignments/${at.id}`,
              new URLSearchParams({ "assignment[due_at]": intent.at }),
            );
          }
          case "item-published": {
            const at = itemAt(content.target);
            const publish = at && publishOf(at);
            if (!publish) return refused("That item can't be published from here.");
            // A file id is global in Canvas, so it is written only once its own course says it holds it.
            if (publish.read !== undefined) {
              const held = await one(publish.read, FileItem);
              if (!held.ok) return { status: "failed", error: held.error };
            }
            return write("PUT", publish.path, new URLSearchParams(publish.form));
          }
          case "item-deleted": {
            const at = itemAt(content.target);
            if (at?.type !== "announcement")
              return refused("Only an announcement is deleted from here.");
            return write("DELETE", `${at.base}/discussion_topics/${at.id}`, new URLSearchParams());
          }
        }
      }
    }
    return {
      status: "failed",
      error: { kind: "unsupported", capability: `${content.kind} ${field}` },
    };
  };

  const valueOf = (targetVersion: string, value: string | null): Read<RemoteState> =>
    Promise.resolve({ ok: true, value: { kind: "item-set", targetVersion, value } });

  const observe = async (content: SetupContent): Read<RemoteState> => {
    switch (content.kind) {
      case "course-copy": {
        const [id] = idsIn(content.target, "migrations", 1) ?? [];
        if (id === undefined) return NOT_FOUND;
        const mine = await client.me();
        if (!mine.ok) return mine;
        const row = await course(id);
        if (!row.ok) return row;
        const items = await itemCount(id);
        if (!items.ok) return items;
        const jobs = await migrationRows(id);
        if (!jobs.ok) return jobs;
        const students = row.value.total_students;
        return {
          ok: true,
          value: {
            kind: "course-copy",
            targetVersion: `students:${students}|items:${items.value}`,
            students,
            items: items.value,
            migrations: jobs.value.map((job) => ({
              id: refs.migration(school.id, id, job.id),
              mine: job.user_id === mine.value,
              text: signatureOf(job),
            })),
          },
        };
      }
      case "text-fix": {
        const at = itemAt(content.target);
        if (!at) return NOT_FOUND;
        const read = await textOf(at);
        return read.ok
          ? { ok: true, value: { kind: "text-fix", targetVersion: "body", body: read.value.body } }
          : read;
      }
      case "item-set": {
        const { intent } = content;
        if (intent.set === "course-published" || intent.set === "course-template") {
          const id = courseStateAt(content.target);
          if (id === undefined) return NOT_FOUND;
          const read = await course(id);
          if (!read.ok) return read;
          return intent.set === "course-template"
            ? valueOf("present", read.value.template ? "template" : "not-template")
            : valueOf(
                "present",
                read.value.workflow_state === "available" ? "published" : "unpublished",
              );
        }
        const at = itemAt(content.target);
        if (!at) return NOT_FOUND;
        const publish = publishOf(at);
        const path = publish && (publish.read ?? publish.path);
        if (path === null)
          return valueOf("present", intent.set === "item-deleted" ? "present" : null);
        const read = await one(path, v.object({ ...Published.entries, due_at: OptionalTime }));
        // A deleted item still observes, as `deleted`, so a delete whose response was lost reads as done.
        if (!read.ok) return read.error.kind === "not_found" ? valueOf("deleted", "deleted") : read;
        switch (intent.set) {
          case "due-at":
            return valueOf("present", read.value.due_at);
          case "item-published": {
            const shown =
              at.type === "file"
                ? !read.value.locked && !read.value.hidden
                : read.value.published !== false;
            return valueOf("present", shown ? "published" : "unpublished");
          }
          case "item-deleted":
            return valueOf("present", "present");
        }
      }
    }
  };

  const describeSend = async (content: SetupContent): Read<SendDescription> => {
    const described = (target: string, lines: readonly string[]): Read<SendDescription> =>
      Promise.resolve({ ok: true, value: { target: client.named(target), lines } });
    const courseName = async (id: number): Read<string> => {
      const read = await course(id);
      return read.ok ? { ok: true, value: `${read.value.course_code}, ${read.value.name}` } : read;
    };
    switch (content.kind) {
      case "course-copy": {
        if (content.source.kind === "cartridge")
          return { ok: false, error: { kind: "rejected", reason: CARTRIDGE } };
        const ids = copyIds(content);
        if (!ids) return NOT_FOUND;
        const into = await courseName(ids.target);
        if (!into.ok) return into;
        const from = await courseName(ids.source);
        if (!from.ok) return from;
        const { shift } = content;
        const days = Object.entries(shift.substitutions).flatMap(([day, to]) =>
          // Every weekday is named, and only the ones that move are worth a line.
          to === undefined || String(to) === day
            ? []
            : [`${DAY_NAMES[Number(day)] ?? day} to ${dayName(to)}`],
        );
        return described(`Copy into ${into.value}`, [
          `Copy from: ${client.named(from.value)}`,
          `Dates: ${shift.oldStart} to ${shift.oldEnd} move to ${shift.newStart} to ${shift.newEnd}`,
          ...(days.length === 0 ? [] : [`Days: ${days.join(", ")}`]),
        ]);
      }
      case "text-fix": {
        const at = itemAt(content.target);
        if (!at) return NOT_FOUND;
        const read = await textOf(at);
        if (!read.ok) return read;
        const where = await courseName(at.course);
        if (!where.ok) return where;
        const { before, after } = content.splice;
        return described(`${read.value.title}, ${where.value}`, [
          ...(before === "" ? [] : [`Replace: ${client.oneLine(before)}`]),
          `${before === "" ? "Add" : "With"}: ${client.oneLine(after)}`,
        ]);
      }
      case "item-set": {
        const { intent } = content;
        if (intent.set === "course-published" || intent.set === "course-template") {
          const id = courseStateAt(content.target);
          if (id === undefined) return NOT_FOUND;
          const name = await courseName(id);
          if (!name.ok) return name;
          return described(name.value, [
            intent.set === "course-published"
              ? "Publish the course, so its students can see it"
              : "Save the course as a template",
          ]);
        }
        const at = itemAt(content.target);
        if (!at) return NOT_FOUND;
        const where = await courseName(at.course);
        if (!where.ok) return where;
        const item = await textOf(at);
        if (!item.ok) return item;
        const line =
          intent.set === "due-at"
            ? `Due: ${intent.at}`
            : intent.set === "item-published"
              ? "Publish it"
              : "Delete it";
        return described(`${item.value.title}, ${where.value}`, [line]);
      }
    }
  };

  return { termSetup, writeOf, observe, describeSend };
};
