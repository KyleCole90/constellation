import type { ChangeContent, FieldKey, LmsError } from "~/shared/domain/change";
import {
  isContentItemType,
  type ContentItem,
  type CourseContent,
  type CourseModule,
  type Migration,
} from "~/shared/domain/content";
import { isoTime, type LmsRef, type SchoolHost, type SchoolId } from "~/shared/domain/ids";
import type { School } from "~/shared/domain/lms";
import { SendPermit } from "~/shared/domain/permit";
import type {
  Capabilities,
  CredentialLease,
  FieldOutcomes,
  LmsProvider,
  ProviderDescriptor,
  Read,
  TermSetup,
} from "~/shared/providers/provider";

import { CANVAS } from "../canvas";
import { classifyLink, type LinkContext } from "../canvas-links";
import { refParts, refs } from "../canvas-refs";
import {
  INSTRUCTOR,
  SCHOOLS_SEED,
  type FakeCanvasServer,
  type RawCourseContent,
  type Route,
} from "./server";

export const FAKE_SCHOOLS: readonly School[] = SCHOOLS_SEED.map((school) => ({
  ...school,
  id: school.id as SchoolId,
  host: school.host as SchoolHost,
  provider: "fake-canvas",
}));

const CAPABILITIES: Capabilities = {
  messaging: true,
  rubricWrite: true,
  attachments: true,
  excuse: true,
  commentEffect: "append",
};
const SCOPE_WORDS: Readonly<Record<string, string>> = {
  "url:GET|/api/v1/courses": "Read your courses, rosters, and submissions",
  "url:PUT|/api/v1/courses/:course_id/assignments/:assignment_id/submissions/:user_id":
    "Post grades and comments",
  "url:POST|/api/v1/conversations/:id/add_message": "Reply to messages",
  "url:POST|/api/v1/conversations": "Message students",
  "url:POST|/api/v1/courses/:course_id/discussion_topics": "Post announcements",
  "url:POST|/api/v1/courses/:course_id/content_migrations": "Copy content into a course",
  "url:GET|/api/v1/courses/:course_id/content_migrations": "Check on a copy",
  "url:GET|/api/v1/progress/:id": "Read how far a copy has gone",
  "url:GET|/api/v1/courses/:course_id/content_migrations/:id/migration_issues":
    "Read a copy's report",
  "url:PUT|/api/v1/courses/:id": "Publish a course and edit its syllabus",
  "url:PUT|/api/v1/courses/:course_id/pages/:url_or_id": "Edit pages",
  "url:PUT|/api/v1/courses/:course_id/assignments/:id": "Edit assignments",
  "url:PUT|/api/v1/courses/:course_id/discussion_topics/:topic_id": "Edit announcements",
  "url:DELETE|/api/v1/courses/:course_id/discussion_topics/:topic_id": "Delete an announcement",
};
const SCOPES = Object.keys(SCOPE_WORDS);

/** What the app knows about the fake Canvas without asking it, wherever the fake itself runs. */
export const FAKE_CANVAS_FACE = {
  vendorLabel: "Canvas",
  capabilities: CAPABILITIES,
  describeScope: (scope: string) => SCOPE_WORDS[scope] ?? scope,
} satisfies Pick<LmsProvider, "vendorLabel" | "capabilities" | "describeScope">;

/** The Canvas path for one content item. The syllabus is a course field, so it goes through the course itself. */
const itemPath = (target: LmsRef<"item">): string => {
  const [, , course, type, id] = refParts(target);
  // This provider minted the ref, so an unknown type is a corrupt ref. Writing it to some other path would be worse than failing.
  if (!isContentItemType(type)) throw new Error(`Not a content item ref: ${target}`);
  switch (type) {
    case "syllabus":
      return `/api/v1/courses/${course}`;
    case "page":
      return `/api/v1/courses/${course}/pages/${id}`;
    case "announcement":
      return `/api/v1/courses/${course}/discussion_topics/${id}`;
    case "assignment":
      return `/api/v1/courses/${course}/assignments/${id}`;
    case "file":
      return `/api/v1/courses/${course}/files/${id}`;
  }
};

const routeOf = (content: ChangeContent): string => {
  switch (content.kind) {
    case "grade": {
      const [, , course, assignment, student] = refParts(content.target);
      return `PUT /api/v1/courses/${course}/assignments/${assignment}/submissions/${student}`;
    }
    case "reply":
      return `POST /api/v1/conversations/${refParts(content.target)[2]}/add_message`;
    case "message":
      return "POST /api/v1/conversations";
    case "announcement":
      return `POST /api/v1/courses/${refParts(content.target)[2]}/discussion_topics`;
    case "course-copy":
      return `POST /api/v1/courses/${refParts(content.target)[2]}/content_migrations`;
    case "text-fix":
      return `PUT ${itemPath(content.target)}`;
    case "item-set": {
      const [, kind, course] = refParts(content.target);
      if (kind === "course-state") return `PUT /api/v1/courses/${course}`;
      return `${content.intent.set === "item-deleted" ? "DELETE" : "PUT"} ${itemPath(content.target as LmsRef<"item">)}`;
    }
  }
};

const observeRoute = (content: ChangeContent): string =>
  content.kind === "course-copy"
    ? `GET /api/v1/courses/${refParts(content.target)[2]}/content_migrations`
    : `GET ${routeOf(content).split(" ")[1]}`;

const allFields = (
  fields: readonly FieldKey[],
  outcome: NonNullable<FieldOutcomes[FieldKey]>,
): FieldOutcomes => Object.fromEntries(fields.map((field) => [field, outcome]));

const openUrl = (
  host: string,
  courseId: number,
  item: RawCourseContent["items"][number],
): string => {
  switch (item.type) {
    case "syllabus":
      return `https://${host}/courses/${courseId}/assignments/syllabus`;
    case "page":
      return `https://${host}/courses/${courseId}/pages/${item.slug}`;
    case "announcement":
      return `https://${host}/courses/${courseId}/discussion_topics/${item.id}`;
    case "assignment":
      return `https://${host}/courses/${courseId}/assignments/${item.id}`;
    case "file":
      return `https://${host}/courses/${courseId}/files/${item.id}`;
  }
};

const toCourseContent = (raw: RawCourseContent): CourseContent => {
  const { school } = raw.shell;
  const ctx: LinkContext = {
    school,
    host: raw.host,
    courseId: raw.courseId,
    pages: new Set(raw.items.filter((item) => item.type === "page").map((item) => item.slug)),
    files: new Set(raw.items.filter((item) => item.type === "file").map((item) => item.id)),
  };
  const items: ContentItem[] = raw.items.map((item) => ({
    ref: refs.item(school, raw.courseId, item.type, item.id),
    type: item.type,
    title: item.title,
    body: item.body,
    published: item.published,
    dueAt: item.dueAt,
    openUrl: openUrl(raw.host, raw.courseId, item),
    links: item.links.map((link) => classifyLink(link, ctx)),
    copied: item.copied,
  }));
  const modules: CourseModule[] = raw.modules.map((module) => ({
    ref: refs.module(school, raw.courseId, module.id),
    title: module.title,
    published: module.published,
    itemCount: module.itemCount,
    openUrl: `https://${raw.host}/courses/${raw.courseId}/modules/${module.id}`,
  }));
  return {
    shell: raw.shell,
    version: raw.version,
    items,
    modules,
    tools: raw.tools.map((tool) => ({
      ref: refs.tool(school, raw.courseId, tool.id),
      name: tool.name,
      configured: tool.configured,
    })),
    policy: raw.policy,
  };
};

const isActive = ({ state }: Migration): boolean =>
  state === "queued" || state === "preparing" || state === "stalled" || state === "running";

const createFakeCanvasProvider = (
  server: FakeCanvasServer,
  now: () => number,
  school: School,
  lease: CredentialLease,
): LmsProvider => {
  const route = (kind: Route["kind"], label: string): Route => ({ school: school.id, kind, label });

  const read = async <T>(target: Route, work: () => T): Read<T> => {
    try {
      return await lease.use((credential) => server.call(target, credential, work));
    } catch {
      return { ok: false, error: { kind: "unavailable", status: null } };
    }
  };

  const courseId = (course: LmsRef<"course">): string => refParts(course)[2] ?? "";

  /** The list, then one progress read per live job and one issues read per finished job, as the real API lays it out. */
  const migrations = async (course: LmsRef<"course">): Read<readonly Migration[]> => {
    const list = await read(
      route("read", `GET /api/v1/courses/${courseId(course)}/content_migrations`),
      () => server.migrations(course),
    );
    if (!list.ok) return list;
    const out: Migration[] = [];
    for (const job of list.value) {
      const id = refParts(job.ref)[3];
      const detail = isActive(job)
        ? await read(route("read", `GET /api/v1/progress/${id}`), () =>
            server.migrations(course).find((entry) => entry.ref === job.ref),
          )
        : await read(
            route(
              "read",
              `GET /api/v1/courses/${courseId(course)}/content_migrations/${id}/migration_issues`,
            ),
            () => server.migrations(course).find((entry) => entry.ref === job.ref),
          );
      if (!detail.ok) return detail;
      out.push(detail.value ?? job);
    }
    return { ok: true, value: out };
  };

  const termSetup: TermSetup = {
    newCourses: () =>
      read(route("read", "GET /api/v1/courses?enrollment_type=teacher&state[]=unpublished"), () =>
        server.newCourses(school.id),
      ),
    copySources: () =>
      read(
        route(
          "read",
          "GET /api/v1/courses?enrollment_type=teacher&include[]=term&state[]=available&state[]=completed",
        ),
        () => server.copySources(school.id),
      ),
    courseContent: async (course) => {
      const result = await read(
        route("read", `GET /api/v1/courses/${courseId(course)}/content`),
        () => server.courseContent(course),
      );
      if (!result.ok) return result;
      return result.value
        ? { ok: true, value: toCourseContent(result.value) }
        : { ok: false, error: { kind: "not_found" } };
    },
    migrations,
    samplePackages: () =>
      read(route("read", "GET /api/v1/users/self/files?search_term=.imscc"), () =>
        server.samplePackages(),
      ),
  };

  return {
    ...FAKE_CANVAS_FACE,
    verify: () =>
      read({ ...route("read", "GET /api/v1/users/self"), verify: true }, () => ({
        displayName: INSTRUCTOR,
        scopes: SCOPES,
      })),
    courses: () => read(route("read", "GET /api/v1/courses"), () => server.courses(school.id)),
    assignments: (course) =>
      read(route("read", `GET /api/v1/courses/${courseId(course)}/assignments`), () =>
        server.assignments(course),
      ),
    students: (course) =>
      read(route("read", `GET /api/v1/courses/${courseId(course)}/users`), () =>
        server.students(course),
      ),
    submissions: (course) =>
      read(route("read", `GET /api/v1/courses/${courseId(course)}/students/submissions`), () =>
        server.submissions(course),
      ),
    conversations: () =>
      read(route("read", "GET /api/v1/conversations"), () => server.conversations(school.id)),
    announcements: (course) =>
      read(
        route(
          "read",
          `GET /api/v1/courses/${courseId(course)}/discussion_topics?only_announcements=true`,
        ),
        () => server.announcements(course),
      ),
    observe: async (content) => {
      const result = await read(route("read", observeRoute(content)), () =>
        server.observe(content),
      );
      if (!result.ok) return result;
      return result.value
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: "not_found" } };
    },
    apply: async (permit) => {
      if (!SendPermit.isGenuine(permit)) return {};
      const { content, fields } = permit;
      const result = await read(route("write", routeOf(content)), () =>
        server.applyFields(content, fields),
      );
      if (result.ok) return result.value;
      const error: LmsError = result.error;
      if (error.kind === "lost_response")
        return allFields(fields, {
          status: "unknown",
          since: isoTime(now()),
        });
      return allFields(fields, { status: "failed", error });
    },
    termSetup,
  };
};

/** The fake Canvas as onboarding shows it: as real Canvas does. `create` is the one part that needs the fake itself. */
export const FAKE_CANVAS: Omit<ProviderDescriptor, "create"> = { ...CANVAS, kind: "fake-canvas" };

export const createFakeCanvasDescriptor = (
  server: FakeCanvasServer,
  now: () => number,
): ProviderDescriptor => ({
  ...FAKE_CANVAS,
  create: ({ school, lease }) => createFakeCanvasProvider(server, now, school, lease),
});
