import type { Fetch } from "~/main/providers/canvas";
import type { IsoDate } from "~/shared/domain/ids";
import { shiftDate, type Weekday } from "~/shared/domain/term";

/**
 * A small Canvas over HTTP for term setup, in the shapes the Canvas docs give, all synthetic: a course taught last term,
 * a template, and an empty unpublished course for next term. A course copy is a content migration whose progress moves
 * with the test's clock; its content lands once, when the job completes. A write whose response is lost still applies.
 */
export const TERM_HOST = "canvas.example.edu";
const ORIGIN = `https://${TERM_HOST}`;
export const TERM_TOKEN = "SENTINEL-canvas-token-71c3";
const SELF_ID = 4101;
export const SOURCE_ID = 2201;
const TEMPLATE_ID = 2301;
export const SHELL_ID = 3301;
/** Another course on this host, which the old course's pages still link to. */
const ELSEWHERE_ID = 1901;
const JOB_MS = 4000;

interface Page {
  page_id: number;
  url: string;
  title: string;
  body: string;
  published: boolean;
  created_at: string;
}
interface Assignment {
  id: number;
  name: string;
  description: string;
  due_at: string | null;
  published: boolean;
  created_at: string;
}
interface Topic {
  id: number;
  title: string;
  message: string;
  published: boolean;
  created_at: string;
}
interface CourseBody {
  pages: Page[];
  assignments: Assignment[];
  topics: Topic[];
}
interface CourseRow {
  id: number;
  name: string;
  course_code: string;
  workflow_state: "unpublished" | "available" | "completed";
  template: boolean;
  start_at: string;
  end_at: string;
  term: { name: string; start_at: string; end_at: string };
  total_students: number;
  syllabus_body: string;
  body: CourseBody;
}
interface Job {
  id: number;
  course: number;
  source: number;
  startedMs: number;
  shift: {
    oldStart: IsoDate;
    oldEnd: IsoDate;
    newStart: IsoDate;
    newEnd: IsoDate;
    substitutions: Partial<Record<Weekday, Weekday>>;
  };
  failAt: { completion: number; message: string } | null;
  landed: boolean;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const missing = () =>
  json({ errors: [{ message: "The specified resource does not exist." }] }, 404);
const at = (ms: number) => new Date(ms).toISOString();
const START_MS = Date.parse("2026-11-11T15:00:00Z");

const course = (
  id: number,
  code: string,
  state: CourseRow["workflow_state"],
  term: [string, string, string],
  body: CourseBody,
  extra: Partial<CourseRow> = {},
): CourseRow => ({
  id,
  name: `${code} Composition`,
  course_code: code,
  workflow_state: state,
  template: false,
  start_at: `${term[1]}T08:00:00Z`,
  end_at: `${term[2]}T08:00:00Z`,
  term: { name: term[0], start_at: `${term[1]}T08:00:00Z`, end_at: `${term[2]}T08:00:00Z` },
  total_students: 0,
  syllabus_body: "",
  body,
  ...extra,
});

const EMPTY = (): CourseBody => ({ pages: [], assignments: [], topics: [] });
const sourceBody = (): CourseBody => ({
  pages: [
    {
      page_id: 501,
      url: "welcome",
      title: "Welcome",
      body: `<p>Welcome to Fall 2026.</p><p>See the <a href="${ORIGIN}/courses/${ELSEWHERE_ID}/pages/reading-list">reading list</a>.</p>`,
      published: true,
      created_at: "2026-08-01T12:00:00Z",
    },
    {
      page_id: 502,
      url: "reading-list",
      title: "Reading list",
      body: `<p>Write to <a href="mailto:teacher@example.edu">teacher@example.edu</a>.</p>`,
      published: false,
      created_at: "2026-08-01T12:00:00Z",
    },
  ],
  assignments: [
    {
      id: 601,
      name: "Essay 1",
      description: "<p>Due in week three.</p>",
      due_at: "2026-09-10T23:59:00Z",
      published: true,
      created_at: "2026-08-01T12:00:00Z",
    },
  ],
  topics: [
    {
      id: 701,
      title: "Midterm moved",
      message: "<p>The midterm is Thursday.</p>",
      published: true,
      created_at: "2026-10-01T12:00:00Z",
    },
  ],
});

export class CanvasTermHttp {
  #now = START_MS;
  #seq = 9000;
  #lose = false;
  #fail: Job["failAt"] = null;
  readonly requests: string[] = [];
  readonly courses: CourseRow[] = [
    course(
      SOURCE_ID,
      "ENG-101",
      "completed",
      ["Fall 2026", "2026-08-24", "2026-12-11"],
      sourceBody(),
      {
        total_students: 24,
        syllabus_body: "<p>Grading: essays 60%.</p>",
      },
    ),
    course(
      TEMPLATE_ID,
      "ENG-TPL",
      "unpublished",
      ["Default Term", "2026-01-05", "2026-05-01"],
      EMPTY(),
      {
        template: true,
      },
    ),
    course(
      SHELL_ID,
      "ENG-101",
      "unpublished",
      ["Spring 2027", "2027-01-19", "2027-05-14"],
      EMPTY(),
    ),
  ];
  readonly jobs: Job[] = [];
  readonly issues = [
    {
      id: 1,
      issue_type: "warning",
      description: "Some links point to another course.",
      workflow_state: "active",
      fix_issue_html_url: `${ORIGIN}/courses/${SHELL_ID}/pages/welcome`,
    },
  ];

  now = (): number => this.#now;
  advance(ms: number): void {
    this.#now += ms;
  }
  loseNext(): void {
    this.#lose = true;
  }
  failNextMigration(stage: "pre_processing" | "running", message: string): void {
    this.#fail = { completion: stage === "pre_processing" ? 5 : 40, message };
  }
  writeCount = (): number => this.requests.filter((line) => !line.startsWith("GET ")).length;

  #course(id: number): CourseRow | undefined {
    return this.courses.find((row) => row.id === id);
  }
  /** Where a job is now, from the clock alone. Its content lands on the first look after it completes. */
  #status(job: Job) {
    const completion = Math.min(100, Math.floor(((this.#now - job.startedMs) / JOB_MS) * 100));
    if (job.failAt && completion >= job.failAt.completion)
      return { state: "failed", completion: job.failAt.completion, message: job.failAt.message };
    if (completion >= 100) {
      if (!job.landed) this.#land(job);
      return { state: "completed", completion: 100, message: null };
    }
    return { state: completion === 0 ? "queued" : "running", completion, message: "Copying" };
  }
  #land(job: Job): void {
    job.landed = true;
    const from = this.#course(job.source);
    const into = this.#course(job.course);
    if (!from || !into) return;
    const created = at(job.startedMs + JOB_MS);
    const rewrite = (html: string) =>
      html.split(`/courses/${from.id}/`).join(`/courses/${into.id}/`);
    into.syllabus_body = rewrite(from.syllabus_body);
    into.body.pages.push(
      ...from.body.pages.map((page) => ({
        ...page,
        page_id: ++this.#seq,
        body: rewrite(page.body),
        created_at: created,
      })),
    );
    into.body.assignments.push(
      ...from.body.assignments.map((assignment) => ({
        ...assignment,
        id: ++this.#seq,
        description: rewrite(assignment.description),
        due_at:
          assignment.due_at === null
            ? null
            : `${shiftDate(assignment.due_at.slice(0, 10) as IsoDate, job.shift)}${assignment.due_at.slice(10)}`,
        created_at: created,
      })),
    );
    into.body.topics.push(
      ...from.body.topics.map((topic) => ({
        ...topic,
        id: ++this.#seq,
        message: rewrite(topic.message),
        created_at: created,
      })),
    );
  }
  #jobJson(job: Job) {
    const status = this.#status(job);
    const workflow_state = status.state === "queued" ? "running" : status.state;
    return {
      id: job.id,
      migration_type: "course_copy_importer",
      migration_type_title: "Copy a Canvas Course",
      workflow_state,
      user_id: SELF_ID,
      started_at: at(job.startedMs),
      finished_at:
        workflow_state === "completed" || workflow_state === "failed"
          ? at(job.startedMs + JOB_MS)
          : null,
      progress_url: `${ORIGIN}/api/v1/progress/${job.id + 1}`,
      migration_issues_url: `${ORIGIN}/api/v1/courses/${job.course}/content_migrations/${job.id}/migration_issues`,
      settings: {
        source_course_id: job.source,
        source_course_name: this.#course(job.source)?.name,
      },
    };
  }
  #courseJson(row: CourseRow) {
    const { body: _body, ...rest } = row;
    return rest;
  }

  readonly fetch: Fetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const path = parsed.pathname.replace(/^\/api\/v1/, "");
    parsed.searchParams.delete("per_page");
    this.requests.push(`${method} ${path}${decodeURIComponent(parsed.search)}`);
    if (parsed.origin !== ORIGIN) throw new Error(`a request left the school: ${url}`);
    if (new Headers(init.headers).get("authorization") !== `Bearer ${TERM_TOKEN}`)
      return json({ errors: [{ message: "Invalid access token." }] }, 401);
    if (method === "GET") return this.#read(path, parsed.searchParams);
    const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
    const response = this.#write(method, path, form);
    if (this.#lose && response.ok) {
      this.#lose = false;
      throw new TypeError("fetch failed");
    }
    return response;
  };

  #read(path: string, query: URLSearchParams): Response {
    if (path === "/users/self") return json({ id: SELF_ID, name: "Sample Instructor" });
    if (path === "/users/self/profile")
      return json({ id: SELF_ID, primary_email: "teacher@example.edu" });
    if (path === "/courses") {
      const states = query.getAll("state[]");
      return json(
        this.courses
          .filter((row) => states.length === 0 || states.includes(row.workflow_state))
          .map((row) => this.#courseJson(row)),
      );
    }
    const progress = /^\/progress\/(\d+)$/.exec(path);
    if (progress) {
      const job = this.jobs.find((entry) => entry.id + 1 === Number(progress[1]));
      if (!job) return missing();
      const status = this.#status(job);
      return json({
        id: job.id + 1,
        workflow_state: status.state,
        completion: status.completion,
        message: status.message,
        tag: "content_migration",
      });
    }
    const file = /^\/files\/(\d+)$/.exec(path);
    if (file) return missing();
    const match = /^\/courses\/(\d+)(\/.*)?$/.exec(path);
    const row = match ? this.#course(Number(match[1])) : undefined;
    if (!match || !row) return missing();
    const rest = match[2] ?? "";
    const { body } = row;
    if (rest === "") return json(this.#courseJson(row));
    if (rest === "/pages")
      return json(
        body.pages.map(({ body: _b, ...page }) => ({
          ...page,
          html_url: `${ORIGIN}/courses/${row.id}/pages/${page.url}`,
        })),
      );
    const page = /^\/pages\/(\d+)$/.exec(rest);
    if (page) {
      const found = body.pages.find((entry) => entry.page_id === Number(page[1]));
      return found ? json(found) : missing();
    }
    if (rest === "/assignments") return json(body.assignments);
    const assignment = /^\/assignments\/(\d+)$/.exec(rest);
    if (assignment) {
      const found = body.assignments.find((entry) => entry.id === Number(assignment[1]));
      return found ? json(found) : missing();
    }
    if (rest === "/discussion_topics") return json(body.topics);
    const topic = /^\/discussion_topics\/(\d+)$/.exec(rest);
    if (topic) {
      const found = body.topics.find((entry) => entry.id === Number(topic[1]));
      return found ? json(found) : missing();
    }
    if (rest === "/files" || rest === "/modules" || rest === "/external_tools") return json([]);
    if (rest === "/content_migrations")
      // Newest first, as Canvas lists them.
      return json(
        this.jobs
          .filter((job) => job.course === row.id)
          .map((job) => this.#jobJson(job))
          .toReversed(),
      );
    const issues = /^\/content_migrations\/(\d+)\/migration_issues$/.exec(rest);
    if (issues) {
      const job = this.jobs.find((entry) => entry.id === Number(issues[1]));
      return job ? json(this.issues) : missing();
    }
    return missing();
  }

  #write(method: string, path: string, form: URLSearchParams): Response {
    const match = /^\/courses\/(\d+)(\/.*)?$/.exec(path);
    const row = match ? this.#course(Number(match[1])) : undefined;
    if (!match || !row) return missing();
    const rest = match[2] ?? "";
    if (method === "PUT" && rest === "") {
      if (form.get("event") === "offer") row.workflow_state = "available";
      if (form.get("course[template]") === "true") row.template = true;
      const syllabus = form.get("course[syllabus_body]");
      if (syllabus !== null) row.syllabus_body = syllabus;
      return json(this.#courseJson(row));
    }
    if (method === "POST" && rest === "/content_migrations") {
      const source = Number(form.get("settings[source_course_id]"));
      if (form.get("migration_type") !== "course_copy_importer" || !this.#course(source))
        return json({ errors: [{ message: "invalid migration" }] }, 400);
      const substitutions: Partial<Record<Weekday, Weekday>> = {};
      for (const [key, value] of form) {
        const day = /^date_shift_options\[day_substitutions\]\[(\d)\]$/.exec(key)?.[1];
        if (day !== undefined) substitutions[Number(day) as Weekday] = Number(value) as Weekday;
      }
      const date = (key: string) => (form.get(`date_shift_options[${key}]`) ?? "") as IsoDate;
      const job: Job = {
        id: (this.#seq += 10),
        course: row.id,
        source,
        startedMs: this.#now,
        shift: {
          oldStart: date("old_start_date"),
          oldEnd: date("old_end_date"),
          newStart: date("new_start_date"),
          newEnd: date("new_end_date"),
          substitutions,
        },
        failAt: this.#fail,
        landed: false,
      };
      this.#fail = null;
      this.jobs.push(job);
      return json(this.#jobJson(job));
    }
    const page = /^\/pages\/(\d+)$/.exec(rest);
    const found = page && row.body.pages.find((entry) => entry.page_id === Number(page[1]));
    if (method === "PUT" && found) {
      found.body = form.get("wiki_page[body]") ?? found.body;
      if (form.get("wiki_page[published]") === "true") found.published = true;
      return json(found);
    }
    const topic = /^\/discussion_topics\/(\d+)$/.exec(rest);
    if (method === "DELETE" && topic) {
      const before = row.body.topics.length;
      row.body.topics = row.body.topics.filter((entry) => entry.id !== Number(topic[1]));
      return before === row.body.topics.length ? missing() : json({});
    }
    return missing();
  }
}
