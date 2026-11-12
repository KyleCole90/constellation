import type { Fetch } from "~/main/providers/canvas";

/**
 * A small Canvas over HTTP, for the provider's write path: one course, one assignment with a rubric, two students, a
 * conversation and an announcement. It answers the routes the provider calls, in the shapes the Canvas docs give,
 * and applies writes the way Canvas does. A write whose response is lost still applies.
 */
export const HOST = "canvas.example.edu";
const ORIGIN = `https://${HOST}`;
export const TOKEN = "SENTINEL-canvas-token-71c3";
export const SELF_ID = 4101;
export const COURSE_ID = 2201;
const ASSIGNMENT_ID = 5301;
export const MAYA = 6401;
const THEO = 6402;
export const CONVERSATION_ID = 7101;

type Field = "grade" | "rubric" | "excuse" | "comment" | "message" | "conversation" | "post";

interface Comment {
  id: number;
  author_id: number;
  comment: string;
  created_at: string;
}
interface SubmissionState {
  assignment_id: number;
  user_id: number;
  workflow_state: string;
  attempt: number;
  submitted_at: string;
  score: number | null;
  excused: boolean;
  rubric_assessment: Record<string, { points: number }> | null;
  submission_comments: Comment[];
  body: string;
}
interface Message {
  id: number;
  author_id: number;
  body: string;
  created_at: string;
}
interface ConversationState {
  id: number;
  subject: string;
  context_code: string;
  participants: { id: number; name: string }[];
  /** Newest first, as Canvas sends them. */
  messages: Message[];
}
interface Topic {
  id: number;
  title: string;
  message: string;
  posted_at: string;
}

const AT = "2026-11-02T15:00:00Z";
const NAMES: Readonly<Record<number, string>> = {
  [SELF_ID]: "Sample Instructor",
  [MAYA]: "Maya Lopez",
  [THEO]: "Theo Park",
};
const RUBRIC = [
  { id: "crit_1", description: "Thesis", points: 50 },
  { id: "crit_2", description: "Evidence", points: 50 },
];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const fieldOf = (method: string, path: string, form: URLSearchParams): Field | null => {
  if (method === "PUT") {
    if (form.has("submission[excuse]")) return "excuse";
    if (form.has("submission[posted_grade]")) return "grade";
    if (form.has("comment[text_comment]")) return "comment";
    if ([...form.keys()].some((key) => key.startsWith("rubric_assessment["))) return "rubric";
    return null;
  }
  if (path.endsWith("/add_message")) return "message";
  if (path === "/conversations") return "conversation";
  if (path.endsWith("/discussion_topics")) return "post";
  return null;
};

export class CanvasHttp {
  #seq = 9000;
  #expired = false;
  #throttleMs: number | null = null;
  #fail: { field: Field; status: number } | null = null;
  #lose: { field: Field | null } | null = null;
  /** Every write that reached Canvas, by field, in order. */
  readonly writes: Field[] = [];
  /** Every request, as `METHOD /path?query`. */
  readonly requests: string[] = [];
  readonly submissions = new Map<number, SubmissionState>(
    [MAYA, THEO].map((user) => [
      user,
      {
        assignment_id: ASSIGNMENT_ID,
        user_id: user,
        workflow_state: "submitted",
        attempt: 1,
        submitted_at: AT,
        score: null,
        excused: false,
        rubric_assessment: null,
        submission_comments: [],
        body: "<p>My essay.</p>",
      },
    ]),
  );
  readonly conversations: ConversationState[] = [
    {
      id: CONVERSATION_ID,
      subject: "Extension on Essay 2?",
      context_code: `course_${COURSE_ID}`,
      participants: [
        { id: SELF_ID, name: NAMES[SELF_ID] ?? "" },
        { id: MAYA, name: NAMES[MAYA] ?? "" },
      ],
      messages: [
        { id: 8001, author_id: MAYA, body: "Could I have two more days?", created_at: AT },
      ],
    },
  ];
  readonly topics: Topic[] = [
    { id: 3001, title: "Welcome", message: "<p>Glad you're here.</p>", posted_at: AT },
  ];

  expire(): void {
    this.#expired = true;
  }
  /** The next request gets Canvas's throttle: a 403 that says so. */
  throttleNext(ms: number): void {
    this.#throttleMs = ms;
  }
  failNext(field: Field, status: number): void {
    this.#fail = { field, status };
  }
  /** The next write (of `field`, if given) applies, and its response never arrives. */
  loseNext(field: Field | null = null): void {
    this.#lose = { field };
  }
  submission(user: number): SubmissionState {
    const found = this.submissions.get(user);
    if (!found) throw new Error(`no submission for ${user}`);
    return found;
  }

  readonly fetch: Fetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const path = parsed.pathname.replace(/^\/api\/v1/, "");
    parsed.searchParams.delete("per_page");
    this.requests.push(`${method} ${path}${decodeURIComponent(parsed.search)}`);
    if (parsed.origin !== ORIGIN) throw new Error(`a request left the school: ${url}`);
    if (this.#expired || new Headers(init.headers).get("authorization") !== `Bearer ${TOKEN}`)
      return json({ errors: [{ message: "Invalid access token." }] }, 401);
    if (this.#throttleMs !== null) {
      const seconds = this.#throttleMs / 1000;
      this.#throttleMs = null;
      return new Response("403 Forbidden (Rate Limit Exceeded)", {
        status: 403,
        headers: { "retry-after": String(seconds) },
      });
    }
    if (method === "GET") return this.#read(path, parsed.searchParams);
    const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
    const field = fieldOf(method, path, form);
    if (field === null) return json({ errors: [{ message: "No route." }] }, 404);
    if (this.#fail?.field === field) {
      const { status } = this.#fail;
      this.#fail = null;
      return json({ errors: [{ message: "Internal error." }] }, status);
    }
    const response = this.#write(method, path, form);
    if (response.ok) this.writes.push(field);
    if (this.#lose && (this.#lose.field === null || this.#lose.field === field)) {
      this.#lose = null;
      throw new TypeError("fetch failed");
    }
    return response;
  };

  #read(path: string, query: URLSearchParams): Response {
    if (path === "/users/self") return json({ id: SELF_ID, name: NAMES[SELF_ID] });
    if (path === "/courses")
      return json([
        { id: COURSE_ID, name: "Introduction to Composition", course_code: "ENG-101-01" },
      ]);
    if (path === `/courses/${COURSE_ID}`)
      return json({
        id: COURSE_ID,
        name: "Introduction to Composition",
        course_code: "ENG-101-01",
      });
    if (path === `/courses/${COURSE_ID}/assignments`)
      return json([
        { id: ASSIGNMENT_ID, name: "Essay 2", due_at: AT, points_possible: 100, rubric: RUBRIC },
      ]);
    if (path === `/courses/${COURSE_ID}/users`)
      return json([MAYA, THEO].map((id) => ({ id, name: NAMES[id] })));
    if (path === `/courses/${COURSE_ID}/students/submissions`)
      return json([...this.submissions.values()].map((row) => this.#submissionJson(row)));
    const one = new RegExp(
      `^/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}/submissions/(\\d+)$`,
    ).exec(path);
    if (one) {
      const row = this.submissions.get(Number(one[1]));
      return row ? json(this.#submissionJson(row)) : json({ errors: [] }, 404);
    }
    if (path === "/conversations") {
      const user = /^user_(\d+)$/.exec(query.get("filter[]") ?? "")?.[1];
      const sent = query.get("scope") === "sent";
      return json(
        this.conversations
          .filter((c) => !sent || c.messages.some((m) => m.author_id === SELF_ID))
          .filter((c) => user === undefined || c.participants.some((p) => p.id === Number(user)))
          .map(({ id, subject }) => ({ id, subject })),
      );
    }
    const conversation = /^\/conversations\/(\d+)$/.exec(path);
    if (conversation) {
      const found = this.conversations.find((c) => c.id === Number(conversation[1]));
      return found
        ? json({ ...found, workflow_state: "read" })
        : json({ errors: [{ message: "The specified resource does not exist." }] }, 404);
    }
    if (path === `/courses/${COURSE_ID}/discussion_topics`) return json(this.topics);
    return json({ errors: [{ message: "No route." }] }, 404);
  }

  #submissionJson(row: SubmissionState) {
    return {
      ...row,
      user: { name: NAMES[row.user_id] },
      assignment: { name: "Essay 2", points_possible: 100, rubric: RUBRIC },
    };
  }

  #write(method: string, path: string, form: URLSearchParams): Response {
    const at = new Date(Date.UTC(2026, 10, 2, 16, 0, this.#seq % 60)).toISOString();
    const graded = new RegExp(
      `^/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}/submissions/(\\d+)$`,
    ).exec(path);
    if (method === "PUT" && graded) {
      const row = this.submissions.get(Number(graded[1]));
      if (!row) return json({ errors: [] }, 404);
      if (form.get("submission[excuse]") === "true") {
        row.excused = true;
        row.score = null;
        row.workflow_state = "graded";
      }
      const grade = form.get("submission[posted_grade]");
      if (grade !== null) {
        row.score = Number(grade);
        row.excused = false;
        row.workflow_state = "graded";
      }
      const rubric: Record<string, { points: number }> = {};
      for (const [key, value] of form) {
        const criterion = /^rubric_assessment\[([^\]]+)\]\[points\]$/.exec(key)?.[1];
        if (criterion !== undefined) rubric[criterion] = { points: Number(value) };
      }
      if (Object.keys(rubric).length > 0) {
        row.rubric_assessment = rubric;
        // The rubric is used for grading, so Canvas scores the submission from it.
        row.score = Object.values(rubric).reduce((sum, { points }) => sum + points, 0);
        row.workflow_state = "graded";
      }
      const comment = form.get("comment[text_comment]");
      if (comment !== null)
        row.submission_comments.push({
          id: ++this.#seq,
          author_id: SELF_ID,
          comment,
          created_at: at,
        });
      return json(row);
    }
    const reply = /^\/conversations\/(\d+)\/add_message$/.exec(path);
    if (method === "POST" && reply) {
      const found = this.conversations.find((c) => c.id === Number(reply[1]));
      if (!found) return json({ errors: [] }, 404);
      found.messages.unshift({
        id: ++this.#seq,
        author_id: SELF_ID,
        body: form.get("body") ?? "",
        created_at: at,
      });
      return json(found);
    }
    if (method === "POST" && path === "/conversations") {
      const recipient = Number(form.get("recipients[]"));
      const started: ConversationState = {
        id: ++this.#seq,
        subject: form.get("subject") ?? "",
        context_code: form.get("context_code") ?? "",
        participants: [
          { id: SELF_ID, name: NAMES[SELF_ID] ?? "" },
          { id: recipient, name: NAMES[recipient] ?? "" },
        ],
        messages: [
          { id: ++this.#seq, author_id: SELF_ID, body: form.get("body") ?? "", created_at: at },
        ],
      };
      this.conversations.push(started);
      return json([started], 201);
    }
    if (method === "POST" && path === `/courses/${COURSE_ID}/discussion_topics`) {
      const topic: Topic = {
        id: ++this.#seq,
        title: form.get("title") ?? "",
        message: form.get("message") ?? "",
        posted_at: at,
      };
      this.topics.push(topic);
      return json(topic);
    }
    return json({ errors: [{ message: "No route." }] }, 404);
  }
}
