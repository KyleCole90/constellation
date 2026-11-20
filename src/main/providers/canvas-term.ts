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
import { copySignature, fieldText } from "../../shared/domain/change";
import {
  isContentItemType,
  type ContentItem,
  type ContentItemType,
  type CourseContent,
  type CourseShell,
  isComing,
  type Migration,
  type SourceCourse,
} from "../../shared/domain/content";
import { isoTime, type IsoTime, type LmsRef, type Result } from "../../shared/domain/ids";
import type { School } from "../../shared/domain/lms";
import { applySplice, spliceState } from "../../shared/domain/splice";
import { dateOfTime, meetingDaysOf } from "../../shared/domain/term";
import { classifyLink } from "../../shared/providers/canvas-links";
import { refParts, refs } from "../../shared/providers/canvas-refs";
import {
  fewAtATime,
  type FieldOutcome,
  type Read,
  type TermSetup,
} from "../../shared/providers/provider";

import { Id, OptionalTime } from "./canvas-wire";

type SetupContent = CourseCopyContent | TextFixContent | SetContent;

export interface CanvasClient {
  school: School;
  now(): number;
  list<T extends v.GenericSchema>(path: string, row: T): Read<v.InferOutput<T>[]>;
  one<T extends v.GenericSchema>(path: string, schema: T): Read<v.InferOutput<T>>;
  write(
    method: "PUT" | "POST" | "DELETE",
    path: string,
    form: URLSearchParams,
  ): Promise<FieldOutcome>;
  importPackage(
    path: string,
    form: URLSearchParams,
    file: Blob,
    name: string,
  ): Promise<FieldOutcome>;
  packageFile(name: string): Promise<Blob | null>;
  me(): Promise<Result<number, LmsError>>;
  idsIn(ref: string, kind: string, count: number): number[] | null;
  oneLine(text: string): string;
}

const SetupCourse = v.object({
  id: Id,
  name: v.string(),
  course_code: v.string(),
  workflow_state: v.string(),
  concluded: v.nullish(v.boolean(), false),
  start_at: OptionalTime,
  end_at: OptionalTime,
  total_students: v.nullish(v.number(), 0),
  template: v.nullish(v.boolean(), false),
  term: v.nullish(
    v.object({ name: v.nullish(v.string(), ""), start_at: OptionalTime, end_at: OptionalTime }),
    null,
  ),
  syllabus_body: v.nullish(v.string(), null),
});
type SetupCourseRow = v.InferOutput<typeof SetupCourse>;
const termNameOf = (row: SetupCourseRow): string =>
  row.term?.name === "Default Term" ? "" : (row.term?.name ?? "");
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
  created_at: OptionalTime,
  started_at: OptionalTime,
  finished_at: OptionalTime,
  progress_url: v.nullish(v.string(), null),
  settings: v.nullish(v.object({ source_course_id: v.nullish(SourceId, null) }), null),
  attachment: v.nullish(v.object({ display_name: v.nullish(v.string(), null) }), null),
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
const ARRIVING = new Set(["duplicating", "importing", "migrating", "outcome_alignment_cloning"]);
const AssignmentState = v.object({ workflow_state: v.nullish(v.string(), null) });
const ARRIVE_MS = 5 * 60_000;
const arrivingAt = (row: MigrationRow, now: number): boolean =>
  row.workflow_state === "completed" &&
  row.finished_at !== null &&
  now - Date.parse(row.finished_at) < ARRIVE_MS;
const stateOf = (row: MigrationRow, progress: string | null): Migration["state"] => {
  if (row.workflow_state === "completed") return "completed";
  if (row.workflow_state === "failed" || progress === "failed") return "failed";
  if (row.workflow_state === "running") return progress === "queued" ? "queued" : "running";
  return "preparing";
};

const STALLED_MS = 10 * 60_000;
const stalledAt = (row: MigrationRow, now: number): boolean =>
  row.migration_type === "common_cartridge_importer" &&
  row.workflow_state === "pre_processing" &&
  row.created_at !== null &&
  now - Date.parse(row.created_at) > STALLED_MS;

const dateOf = (at: IsoTime | null) => (at === null ? null : dateOfTime(at));
const hashOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
const BARE_URL = /https?:\/\/[^\s"'<>]*[^\s"'<>.,;:!?)]/g;
const REFUSED_FILE_TEXT = "This app doesn't edit files in Canvas.";

export const canvasTermSetup = (client: CanvasClient) => {
  const { school, list, one, write, idsIn } = client;
  const origin = `https://${school.host}`;
  const NOT_FOUND = { ok: false, error: { kind: "not_found" } } as const;
  const refused = (reason: string): Promise<FieldOutcome> =>
    Promise.resolve({ status: "failed", error: { kind: "rejected", reason } });

  const course = (id: number) =>
    one(
      `/courses/${id}?include[]=term&include[]=total_students&include[]=syllabus_body`,
      SetupCourse,
    );
  const datesOf = (row: SetupCourseRow) => ({
    start: dateOf(row.start_at ?? row.term?.start_at ?? null),
    end: dateOf(row.end_at ?? row.term?.end_at ?? null),
  });

  const shellOf = (
    row: SetupCourseRow,
    itemCount: number,
    jobs: readonly MigrationRow[],
    mine: number,
  ): CourseShell => {
    const { start, end } = datesOf(row);
    return {
      ref: refs.course({ school: school.id, course: row.id }),
      school: school.id,
      code: row.course_code,
      title: row.name,
      section: null,
      modality: null,
      studentCount: row.total_students,
      termName: termNameOf(row),
      startAt: start,
      endAt: end,
      itemCount,
      setUp: jobs.some((job) => job.user_id === mine && job.workflow_state === "completed"),
      copyTarget: refs.migrations({ school: school.id, course: row.id }),
      stateTarget: refs.courseState({ school: school.id, course: row.id }),
    };
  };

  const itemCount = async (id: number): Read<number> => {
    const lists = await Promise.all([
      list(`/courses/${id}/pages`, PageRow),
      list(`/courses/${id}/assignments`, DatedRow),
      list(`/courses/${id}/discussion_topics?only_announcements=true`, TopicItem),
      list(`/courses/${id}/files`, FileItem),
    ]);
    let count = 0;
    for (const rows of lists) {
      if (!rows.ok) return rows;
      count += rows.value.length;
    }
    return { ok: true, value: count };
  };

  const teacherCourses = (states: string) =>
    list(
      `/courses?enrollment_type=teacher&include[]=term&include[]=total_students&include[]=concluded&${states}`,
      SetupCourseRow,
    );
  const readable = (rows: v.InferOutput<typeof SetupCourseRow>[]): SetupCourseRow[] =>
    rows.flatMap((row) => ("access_restricted_by_date" in row ? [] : [row]));

  const newCourses = async (): Read<readonly CourseShell[]> => {
    const rows = await teacherCourses("state[]=unpublished");
    if (!rows.ok) return rows;
    const today = dateOfTime(isoTime(client.now()));
    const shells = readable(rows.value).filter(
      (row) =>
        row.workflow_state === "unpublished" &&
        isComing({ ...row, startAt: datesOf(row).start }, today),
    );
    const mine = await client.me();
    if (!mine.ok) return mine;
    const counted = await fewAtATime(shells, async (row) => ({
      row,
      count: await itemCount(row.id),
      jobs: await migrationRows(row.id),
    }));
    const out: CourseShell[] = [];
    for (const { row, count, jobs } of counted) {
      if (!count.ok) return count;
      if (!jobs.ok) return jobs;
      out.push(shellOf(row, count.value, jobs.value, mine.value));
    }
    return { ok: true, value: out };
  };

  const copySources = async (): Read<readonly SourceCourse[]> => {
    const rows = await teacherCourses("state[]=available&state[]=completed&state[]=unpublished");
    if (!rows.ok) return rows;
    const out: SourceCourse[] = [];
    for (const row of readable(rows.value)) {
      const { start, end } = datesOf(row);
      if (row.workflow_state === "unpublished" && !row.template) continue;
      const dated = await list(`/courses/${row.id}/assignments`, DatedRow);
      if (!dated.ok) return dated;
      const items = dated.value.flatMap((item) =>
        item.due_at === null
          ? []
          : [
              {
                ref: refs.item({
                  school: school.id,
                  course: row.id,
                  type: "assignment",
                  item: item.id,
                }),
                title: item.name,
                dueAt: item.due_at,
              },
            ],
      );
      out.push({
        ref: refs.course({ school: school.id, course: row.id }),
        code: row.course_code,
        title: row.name,
        termName: termNameOf(row),
        startAt: start,
        endAt: end,
        meetingDays: meetingDaysOf(items.map((item) => dateOfTime(item.dueAt))),
        template: row.template,
        dated: items,
      });
    }
    return { ok: true, value: out.sort((a, b) => Number(b.template) - Number(a.template)) };
  };

  const migrationRows = async (id: number): Read<MigrationRow[]> => {
    const rows = await list(`/courses/${id}/content_migrations`, MigrationRow);
    return rows.ok ? { ok: true, value: rows.value.toSorted((a, b) => a.id - b.id) } : rows;
  };
  const signatureOf = (row: MigrationRow): string => {
    const source = row.settings?.source_course_id ?? null;
    const file = row.attachment?.display_name ?? null;
    if (row.migration_type === "course_copy_importer" && source !== null)
      return copySignature({
        source: {
          kind: "course",
          ref: refs.course({ school: school.id, course: source }),
          label: "",
          termName: "",
        },
      });
    if (row.migration_type === "common_cartridge_importer" && file !== null)
      return copySignature({ source: { kind: "cartridge", name: file, kb: 0, hint: null } });
    return `migration:${row.id}`;
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
        const state = stalledAt(row, client.now())
          ? "stalled"
          : stateOf(row, progress?.value.workflow_state ?? null);
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
          ref: refs.migration({ school: school.id, course: id, migration: row.id }),
          signature: signatureOf(row),
          state,
          completion: state === "completed" ? 100 : (progress?.value.completion ?? 0),
          message: progress?.value.message ?? null,
          issues,
        });
      }
      const recent = rows.value.flatMap((row, index) =>
        arrivingAt(row, client.now()) ? [index] : [],
      );
      if (recent.length > 0) {
        const quizzes = await list(`/courses/${id}/assignments`, AssignmentState);
        if (!quizzes.ok) return quizzes;
        if (quizzes.value.some((row) => ARRIVING.has(row.workflow_state ?? "")))
          for (const index of recent) {
            const job = out[index];
            if (job)
              out[index] = {
                ...job,
                state: "running",
                message: "Canvas is still copying the quizzes.",
              };
          }
      }
      return { ok: true, value: out };
    })();
  };

  const courseContent = (courseRef: LmsRef<"course">): Read<CourseContent> => {
    const [id] = idsIn(courseRef, "course", 1) ?? [];
    if (id === undefined) return Promise.resolve(NOT_FOUND);
    return (async () => {
      const [row, pages, assignments, topics, files, modules, tools, jobs, profile, mine] =
        await Promise.all([
          course(id),
          list(`/courses/${id}/pages`, PageRow),
          list(`/courses/${id}/assignments`, AssignmentItem),
          list(`/courses/${id}/discussion_topics?only_announcements=true`, TopicItem),
          list(`/courses/${id}/files`, FileItem),
          list(`/courses/${id}/modules`, ModuleRow),
          list(`/courses/${id}/external_tools`, ToolRow),
          migrationRows(id),
          one("/users/self/profile", Profile),
          client.me(),
        ]);
      if (!row.ok) return row;
      if (!pages.ok) return pages;
      if (!assignments.ok) return assignments;
      if (!topics.ok) return topics;
      if (!files.ok) return files;
      if (!modules.ok) return modules;
      if (!tools.ok) return tools;
      if (!jobs.ok) return jobs;
      if (!profile.ok) return profile;
      if (!mine.ok) return mine;
      const reads = await Promise.all(
        pages.value.map(
          async (page) =>
            [page.page_id, await one(`/courses/${id}/pages/${page.page_id}`, PageBody)] as const,
        ),
      );
      const bodies = new Map<number, string>();
      for (const [pageId, read] of reads) {
        if (!read.ok) return read;
        bodies.set(pageId, read.value.body);
      }

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
        ref: refs.item({ school: school.id, course: id, type, item: itemId }),
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
            published: !file.locked,
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
          jobs.value,
          mine.value,
        ),
        version: hashOf([row.value, items, modules.value, tools.value]),
        items,
        modules: modules.value.map((module) => ({
          ref: refs.module({ school: school.id, course: id, module: module.id }),
          title: module.name,
          published: module.published,
          itemCount: module.items_count,
          openUrl: `${origin}/courses/${id}/modules/${module.id}`,
        })),
        tools: tools.value.map((tool) => ({
          ref: refs.tool({ school: school.id, course: id, tool: tool.id }),
          name: tool.name,
          configured: true,
        })),
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
    samplePackages: () => Promise.resolve({ ok: true, value: [] }),
  };

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
      case "file": {
        const read = await one(`${at.base}/files/${at.id}`, FileItem);
        return read.ok
          ? { ok: true, value: { body: "", title: read.value.display_name, path: "", key: "" } }
          : read;
      }
    }
  };

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
        return {
          read: `${at.base}/files/${at.id}`,
          path: `/files/${at.id}`,
          form: { locked: "false" },
        };
      case "syllabus":
        return null;
    }
  };
  const Published = v.object({
    published: v.nullish(v.boolean(), null),
    locked: v.nullish(v.boolean(), false),
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
  const NOT_PICKED =
    "Choose the .imscc file again. The app forgets a chosen file when it quits, and sends only a file you chose.";
  const copyIds = (content: CourseCopyContent) => {
    const [target] = idsIn(content.target, "migrations", 1) ?? [];
    const [source] =
      content.source.kind === "course" ? (idsIn(content.source.ref, "course", 1) ?? []) : [];
    return target === undefined || source === undefined ? null : { target, source };
  };

  const writeOf = async (content: SetupContent, field: FieldKey): Promise<FieldOutcome> => {
    switch (content.kind) {
      case "course-copy": {
        if (field !== "copy") break;
        if (content.source.kind === "cartridge") {
          const [target] = idsIn(content.target, "migrations", 1) ?? [];
          if (target === undefined) return refused("That course isn't at this school.");
          const { name } = content.source;
          const file = await client.packageFile(name);
          if (!file) return refused(NOT_PICKED);
          const form = new URLSearchParams({
            migration_type: "common_cartridge_importer",
            "pre_attachment[name]": name,
            "pre_attachment[size]": String(file.size),
          });
          return client.importPackage(
            `/courses/${target}/content_migrations`,
            shiftForm(content, form),
            file,
            name,
          );
        }
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
        const sent = await setOf(content);
        return sent.status === "landed" ? confirmed(content, sent) : sent;
      }
    }
    return {
      status: "failed",
      error: { kind: "unsupported", capability: `${content.kind} ${field}` },
    };
  };

  const confirmed = async (content: SetContent, sent: FieldOutcome): Promise<FieldOutcome> => {
    const read = await observe(content);
    if (!read.ok) return { status: "unknown", since: isoTime(client.now()) };
    const now = read.value.kind === "item-set" ? read.value.value : null;
    const wanted = fieldText(content, "value");
    const same =
      content.intent.set === "due-at" && now !== null
        ? Math.abs(Date.parse(now) - Date.parse(wanted)) <= 1000
        : now === wanted;
    return same ? sent : refused(`Canvas answered, but didn't change ${content.where}.`);
  };

  const setOf = async (content: SetContent): Promise<FieldOutcome> => {
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
              ? { "course[event]": "offer" }
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
              id: refs.migration({ school: school.id, course: id, migration: job.id }),
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
        if (!read.ok) return read.error.kind === "not_found" ? valueOf("deleted", "deleted") : read;
        switch (intent.set) {
          case "due-at":
            return valueOf("present", read.value.due_at);
          case "item-published": {
            const shown = at.type === "file" ? !read.value.locked : read.value.published !== false;
            return valueOf("present", shown ? "published" : "unpublished");
          }
          case "item-deleted":
            return valueOf("present", "present");
        }
      }
    }
  };

  return { termSetup, writeOf, observe };
};
