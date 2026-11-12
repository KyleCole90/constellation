import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { canvasSchoolAt, createCanvasProvider, type Fetch } from "~/main/providers/canvas";
import type { LmsRef, SchoolHost, SchoolId } from "~/shared/domain/ids";
import type { School } from "~/shared/domain/lms";
import { Secret, type CredentialLease } from "~/shared/providers/provider";

import { bridgeCanvas } from "~/renderer/providers/lms";
import { createMemoryVault } from "~/renderer/providers/vault";
import { CANVAS, CANVAS_FACE, CANVAS_SCOPES } from "~/shared/providers/canvas";
import type { LabCommand } from "~/shared/providers/fake-canvas/lab";

import { bridgedLms, fakeLmsHandlers } from "./fixtures/bridge";

const HOST = "canvas.example.edu";
const ORIGIN = `https://${HOST}`;
const TOKEN = "SENTINEL-canvas-token-71c3";
const SCHOOL = (() => {
  const school = canvasSchoolAt(HOST);
  if (!school) throw new Error(`${HOST} should be a Canvas school`);
  return school;
})();
const COURSE = `${HOST}:course:2201` as LmsRef<"course">;

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/canvas/${name}`, import.meta.url), "utf8");

interface Reply {
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

/**
 * Canvas as recorded responses: each request's path and query, without `per_page`, names its reply. A request with no
 * reply fails the test, so a provider that asks for more than it should is caught.
 */
const recorded = (replies: Record<string, Reply | (() => never)>) => {
  const requests: { url: string; auth: string | null }[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    requests.push({ url, auth: headers.get("authorization") });
    const parsed = new URL(url);
    parsed.searchParams.delete("per_page");
    const key = `${parsed.origin === ORIGIN ? "" : parsed.origin}${parsed.pathname}${parsed.search}`;
    const reply = replies[decodeURIComponent(key)];
    if (reply === undefined) throw new Error(`no recorded reply for ${key}`);
    if (typeof reply === "function") return reply();
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetch, requests };
};

const leaseOf = (token: string | null): CredentialLease => ({
  use: (work) => work(token === null ? null : { kind: "bearer", token: new Secret(token) }),
  replace: async () => {},
});

const canvasWith = (
  replies: Record<string, Reply | (() => never)>,
  token: string | null = TOKEN,
) => {
  const network = recorded(replies);
  return {
    ...network,
    provider: createCanvasProvider({
      school: SCHOOL,
      lease: leaseOf(token),
      fetch: network.fetch,
      now: () => Date.now(),
      packageFile: async () => null,
    }),
  };
};

const ok = (name: string, headers?: Record<string, string>): Reply => ({
  body: fixture(name),
  ...(headers ? { headers } : {}),
});
const SELF = { "/api/v1/users/self": ok("users-self.json") };
const COURSES =
  "/api/v1/courses?enrollment_type=teacher&enrollment_state=active&include[]=total_students&state[]=available";

describe("a Canvas school's address", () => {
  it("names an https host, and the school's id is that host", () => {
    expect(canvasSchoolAt("https://Canvas.Example.edu/courses/1")).toEqual({
      id: HOST,
      abbr: "CANV",
      name: HOST,
      host: HOST,
      provider: "canvas",
    });
  });

  it.each([
    ["an IP address", "10.0.0.5"],
    ["an IP address the URL parser reads from hex", "0x7f.0.0.1"],
    ["a port", "canvas.example.edu:8443"],
    ["credentials", "user:pass@canvas.example.edu"],
    ["a bare name", "localhost"],
    ["nothing", "  "],
  ])("refuses %s", (_, raw) => {
    expect(canvasSchoolAt(raw)).toBeNull();
  });
});

describe("Canvas reads", () => {
  it("verify names the account and sends the token only as a bearer header to the school", async () => {
    const canvas = canvasWith(SELF);
    expect(await canvas.provider.verify()).toEqual({
      ok: true,
      value: { displayName: "Sample Instructor", scopes: CANVAS_SCOPES },
    });
    expect(canvas.requests).toEqual([
      { url: `${ORIGIN}/api/v1/users/self`, auth: `Bearer ${TOKEN}` },
    ]);
  });

  it("follows Link rel=next to the last page, so courses is the whole list", async () => {
    const next = `<${ORIGIN}/api/v1/courses?page=2&per_page=100>; rel="next", <${ORIGIN}/api/v1/courses?page=1&per_page=100>; rel="first"`;
    const canvas = canvasWith({
      [COURSES]: ok("courses-page-1.json", { link: next }),
      "/api/v1/courses?page=2": ok("courses-page-2.json", {
        link: `<${ORIGIN}/api/v1/courses?page=1&per_page=100>; rel="first"`,
      }),
    });
    const courses = await canvas.provider.courses();
    expect(courses).toEqual({
      ok: true,
      value: [
        {
          ref: `${HOST}:course:2201`,
          school: HOST,
          code: "ENG-101-01",
          title: "Introduction to Composition",
          section: null,
          modality: null,
          studentCount: 18,
        },
        {
          ref: `${HOST}:course:2203`,
          school: HOST,
          code: "ENG-210-02",
          title: "Technical Writing",
          section: null,
          modality: null,
          studentCount: 0,
        },
      ],
    });
    expect(canvas.requests.map(({ url }) => new URL(url).searchParams.get("per_page"))).toEqual([
      "100",
      "100",
    ]);
  });

  it("never follows a page link to another host, so the token stays with the school", async () => {
    const canvas = canvasWith({
      [COURSES]: ok("courses-page-1.json", {
        link: '<https://elsewhere.example.com/api/v1/courses?page=2>; rel="next"',
      }),
    });
    const courses = await canvas.provider.courses();
    expect(courses.ok || courses.error.kind).toBe("rejected");
    expect(canvas.requests.every(({ url }) => url.startsWith(`${ORIGIN}/`))).toBe(true);
  });

  it("stops on a page link that loops back", async () => {
    const canvas = canvasWith({
      [COURSES]: ok("courses-page-1.json", {
        link: `<${ORIGIN}${COURSES}&per_page=100>; rel="next"`,
      }),
    });
    const courses = await canvas.provider.courses();
    expect(courses.ok || courses.error.kind).toBe("rejected");
  });

  it("stops on a page chain that never ends", async () => {
    const requests: string[] = [];
    const endless: Fetch = async (url) => {
      requests.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return new Response("[]", {
        headers: { link: `<${ORIGIN}/api/v1/courses?page=${page + 1}>; rel="next"` },
      });
    };
    const provider = createCanvasProvider({
      school: SCHOOL,
      lease: leaseOf(TOKEN),
      fetch: endless,
      now: () => Date.now(),
      packageFile: async () => null,
    });
    const courses = await provider.courses();
    expect(courses.ok || courses.error.kind).toBe("rejected");
    expect(requests).toHaveLength(100);
  });

  it("reads assignments with their rubrics, and a missing point value as zero", async () => {
    const canvas = canvasWith({
      "/api/v1/courses/2201/assignments": ok("assignments.json"),
    });
    const assignments = await canvas.provider.assignments(COURSE);
    expect(assignments.ok && assignments.value).toEqual([
      {
        ref: `${HOST}:assignment:2201:5301`,
        school: HOST,
        course: COURSE,
        title: "Essay 1: Personal Narrative",
        shortTitle: "Essay 1: Personal Narrative",
        dueAt: "2027-02-01T05:59:59.000Z",
        pointsPossible: 100,
        rubric: [
          { ref: `${HOST}:criterion:5301:_1001`, name: "Ideas", maxPoints: 60 },
          { ref: `${HOST}:criterion:5301:_1002`, name: "Mechanics", maxPoints: 40 },
        ],
        latePointsPerDay: null,
      },
      {
        ref: `${HOST}:assignment:2201:5302`,
        school: HOST,
        course: COURSE,
        title: "Discussion: Introductions",
        shortTitle: "Discussion: Introductions",
        dueAt: null,
        pointsPossible: 0,
        rubric: null,
        latePointsPerDay: null,
      },
    ]);
  });

  it("reads a course's students", async () => {
    const canvas = canvasWith({
      "/api/v1/courses/2201/users?enrollment_type[]=student": ok("students.json"),
    });
    const students = await canvas.provider.students(COURSE);
    expect(students.ok && students.value.map((student) => [student.ref, student.name])).toEqual([
      [`${HOST}:student:6401`, "Avery Sample"],
      [`${HOST}:student:6402`, "Jordan Example"],
    ]);
  });

  it("reads submissions with plain-text bodies, rubric scores, and which comments are mine", async () => {
    const canvas = canvasWith({
      ...SELF,
      "/api/v1/courses/2201/students/submissions?student_ids[]=all&include[]=submission_comments&include[]=rubric_assessment&include[]=user":
        ok("submissions.json"),
    });
    const submissions = await canvas.provider.submissions(COURSE);
    if (!submissions.ok) throw new Error(submissions.error.kind);
    const [graded, missing] = submissions.value;
    expect(graded).toEqual({
      ref: `${HOST}:submission:2201:5301:6401`,
      school: HOST,
      course: COURSE,
      assignment: `${HOST}:assignment:2201:5301`,
      student: `${HOST}:student:6401`,
      studentName: "Avery Sample",
      workflow: "graded",
      attempt: 1,
      lateDays: 0,
      submittedAt: "2027-01-30T18:20:00.000Z",
      grade: 88,
      rubricScores: {
        [`${HOST}:criterion:5301:_1001`]: 52,
        [`${HOST}:criterion:5301:_1002`]: 36,
      },
      comments: [
        { id: "31", mine: true, text: "Strong opening.", at: "2027-02-02T15:00:00.000Z" },
        { id: "32", mine: false, text: "Thank you!", at: "2027-02-03T10:00:00.000Z" },
      ],
      body: {
        kind: "text",
        title: "",
        wordCount: 17,
        paragraphs: [
          "The summer I turned twelve, I learned to swim.",
          "It changed how I saw fear & courage.",
        ],
      },
    });
    expect(missing).toMatchObject({
      workflow: "missing",
      attempt: 0,
      lateDays: 3,
      grade: null,
      rubricScores: null,
      body: { kind: "none" },
    });
  });

  it("reads course conversations oldest message first, without marking them read", async () => {
    const canvas = canvasWith({
      ...SELF,
      "/api/v1/conversations": ok("conversations.json"),
      "/api/v1/conversations/7101?auto_mark_as_read=false": ok("conversation-7101.json"),
      "/api/v1/conversations/7102?auto_mark_as_read=false": ok("conversation-7102.json"),
    });
    const conversations = await canvas.provider.conversations();
    expect(conversations).toEqual({
      ok: true,
      value: [
        {
          ref: `${HOST}:conversation:7101`,
          school: HOST,
          course: COURSE,
          subject: "Question about Essay 1",
          from: "Avery Sample",
          unread: true,
          messages: [
            {
              id: "800",
              mine: true,
              author: "Sample Instructor",
              text: "Essay 1 is posted. Ask me anything.",
              at: "2027-01-19T09:00:00.000Z",
            },
            {
              id: "801",
              mine: false,
              author: "Avery Sample",
              text: "Can I write about a recent event?",
              at: "2027-01-20T16:00:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("reads posted announcements as plain text, and leaves out ones not posted yet", async () => {
    const canvas = canvasWith({
      "/api/v1/courses/2201/discussion_topics?only_announcements=true": ok("announcements.json"),
    });
    expect(await canvas.provider.announcements(COURSE)).toEqual({
      ok: true,
      value: [
        {
          ref: `${HOST}:announcement:8801`,
          school: HOST,
          course: COURSE,
          title: "Welcome to ENG 101",
          body: "Welcome!\n\nRead the syllabus before Tuesday.",
          postedAt: "2027-01-12T14:00:00.000Z",
        },
      ],
    });
  });
});

describe("Canvas failures", () => {
  const verifyAfter = (reply: Reply | (() => never)) =>
    canvasWith({ "/api/v1/users/self": reply }).provider.verify();

  it("reads Canvas's 403 Rate Limit Exceeded as a throttle, at once", async () => {
    expect(await verifyAfter({ status: 403, body: fixture("rate-limited.txt") })).toEqual({
      ok: false,
      error: { kind: "rate_limited", retryAfterMs: null },
    });
  });

  it("reads a 429 as a throttle, with its Retry-After", async () => {
    expect(await verifyAfter({ status: 429, body: "", headers: { "retry-after": "2" } })).toEqual({
      ok: false,
      error: { kind: "rate_limited", retryAfterMs: 2000 },
    });
  });

  it("reads any other 403 as forbidden", async () => {
    expect(await verifyAfter({ status: 403, body: fixture("unauthorized.json") })).toEqual({
      ok: false,
      error: { kind: "forbidden", missingScope: null },
    });
  });

  it("reads a 401 as an expired token", async () => {
    expect(await verifyAfter({ status: 401, body: fixture("invalid-token.json") })).toEqual({
      ok: false,
      error: { kind: "auth_expired" },
    });
  });

  it("reads no saved token as an expired one, and asks Canvas nothing", async () => {
    const canvas = canvasWith(SELF, null);
    expect(await canvas.provider.verify()).toEqual({ ok: false, error: { kind: "auth_expired" } });
    expect(canvas.requests).toEqual([]);
  });

  it("reads a network failure as the LMS not answering", async () => {
    expect(
      await verifyAfter(() => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({ ok: false, error: { kind: "unavailable", status: null } });
  });

  it("reads a 5xx as unavailable with its status", async () => {
    expect(await verifyAfter({ status: 503, body: "" })).toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503 },
    });
  });

  it("refuses a redirect rather than follow it with the token", async () => {
    const result = await verifyAfter({
      status: 302,
      body: "",
      headers: { location: "https://login.example.com/" },
    });
    expect(result.ok || result.error.kind).toBe("rejected");
  });

  it.each([
    ["a body that isn't JSON", "<html>Maintenance</html>"],
    ["JSON of the wrong shape", '{"id":"4101"}'],
  ])("refuses %s", async (_, body) => {
    const result = await verifyAfter({ body });
    expect(result.ok || result.error.kind).toBe("rejected");
  });

  it("refuses a list page of the wrong shape", async () => {
    const canvas = canvasWith({ [COURSES]: { body: '[{"id":1,"name":"No code"}]' } });
    const courses = await canvas.provider.courses();
    expect(courses.ok || courses.error.kind).toBe("rejected");
  });
});

describe("what the renderer can make Canvas fetch", () => {
  it.each([
    ["another school's course", "other.example.edu:course:2201"],
    ["a path in the id", `${HOST}:course:2201/../../users/self`],
    ["a query in the id", `${HOST}:course:2201?as_user_id=1`],
    ["a ref of another kind", `${HOST}:student:2201`],
    ["extra parts", `${HOST}:course:2201:9`],
  ])("refuses %s, and asks Canvas nothing", async (_, ref) => {
    const canvas = canvasWith({});
    const course = ref as LmsRef<"course">;
    for (const read of [
      canvas.provider.assignments(course),
      canvas.provider.students(course),
      canvas.provider.submissions(course),
      canvas.provider.announcements(course),
    ])
      expect(await read).toEqual({ ok: false, error: { kind: "not_found" } });
    expect(canvas.requests).toEqual([]);
  });
});

describe("student-written HTML", () => {
  it("reads an entity past Unicode as a replacement character, not a failed read", async () => {
    const body = JSON.stringify([
      {
        id: 1,
        title: "Odd",
        message: "<p>a &#99999999; b &#xD800; c &#x41;</p>",
        posted_at: "2027-01-12T14:00:00Z",
      },
    ]);
    const canvas = canvasWith({
      "/api/v1/courses/2201/discussion_topics?only_announcements=true": { body },
    });
    const announcements = await canvas.provider.announcements(COURSE);
    expect(announcements.ok && announcements.value[0]?.body).toBe("a \uFFFD b \uFFFD c A");
  });
});

describe("main's lms channels and real Canvas", () => {
  it("know no school at an unknown address while real Canvas is off, as verify runs the app", async () => {
    const lms = fakeLmsHandlers();
    expect(await lms["lms.schoolAt"]({ host: HOST })).toBeNull();
  });

  it("mint a Canvas school for a real host, and read it with the token saved under it", async () => {
    const vault = createMemoryVault();
    await vault.enroll(HOST as SchoolId, { kind: "bearer", token: new Secret(TOKEN) });
    const network = recorded(SELF);
    const lms = fakeLmsHandlers({ vault, fetch: network.fetch });
    const school = await lms["lms.schoolAt"]({ host: HOST });
    expect(school).toEqual(SCHOOL);
    if (!school) return;
    expect(await lms["lms.verify"]({ school })).toMatchObject({ ok: true });
    expect(network.requests[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("refuse a Canvas school whose id names another school's token", async () => {
    const vault = createMemoryVault();
    await vault.enroll(HOST as SchoolId, { kind: "bearer", token: new Secret(TOKEN) });
    const network = recorded({});
    const lms = fakeLmsHandlers({ vault, fetch: network.fetch });
    const forged: School = { ...SCHOOL, host: "elsewhere.example.com" as SchoolHost };
    await expect(async () => lms["lms.verify"]({ school: forged })).rejects.toThrow(
      "isn't a Canvas school",
    );
    expect(network.requests).toEqual([]);
  });
});

describe("the fake's failure lab and real Canvas", () => {
  it("never reaches a Canvas school: every lab command aimed at one leaves its reads untouched", async () => {
    const vault = createMemoryVault();
    await vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TOKEN) });
    const network = recorded({ ...SELF, [COURSES]: ok("courses-page-2.json") });
    const lms = fakeLmsHandlers({ vault, fetch: network.fetch });
    const commands: LabCommand[] = [
      { do: "expireToken", school: SCHOOL.id },
      {
        do: "changeGradeOutOfBand",
        submission: `${HOST}:submission:2201:5301:6401` as LmsRef<"submission">,
        newGrade: 1,
        by: "lab",
      },
      {
        do: "studentResubmits",
        submission: `${HOST}:submission:2201:5301:6401` as LmsRef<"submission">,
      },
      { do: "enrollStudents", course: COURSE, count: 3 },
      { do: "throttleNext", retryAfterMs: 60_000, on: "any" },
      { do: "failNextWrite", field: "grade", error: { kind: "auth_expired" } },
      { do: "loseNextResponse", applied: true },
      { do: "holdReads", held: true },
      { do: "setNoise", patch: { rate429: 1, rate5xx: 1 } },
      { do: "reset" },
      { do: "reload" },
    ];
    for (const command of commands) await lms["lms.lab"](command);
    expect(await lms["lms.verify"]({ school: SCHOOL })).toMatchObject({ ok: true });
    const courses = await lms["lms.courses"]({ school: SCHOOL });
    expect(courses.ok && courses.value.map((course) => course.code)).toEqual(["ENG-210-02"]);
    expect(network.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v1/users/self",
      "/api/v1/courses",
    ]);
  });
});

describe("a school the renderer relabels", () => {
  it("can't lend a Canvas school's token to the fake", async () => {
    const vault = createMemoryVault();
    await vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TOKEN) });
    const lms = fakeLmsHandlers({ vault, fetch: recorded({}).fetch });
    await expect(async () =>
      lms["lms.verify"]({ school: { ...SCHOOL, provider: "fake-canvas" } }),
    ).rejects.toThrow("isn't one of the demo schools");
  });
});

describe("the renderer's Canvas client", () => {
  it("finds the school through main, reads through the bridge, and offers term setup", async () => {
    const network = recorded({ ...SELF, [COURSES]: ok("courses-page-2.json") });
    const lms = bridgedLms({ fetch: network.fetch });
    await lms.vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TOKEN) });
    const school = await lms.bridge.invoke("lms.schoolAt", { host: HOST });
    if (!school) throw new Error("main knows no school at the host");
    const canvas = bridgeCanvas(lms.bridge, CANVAS, CANVAS_FACE, lms.clock.now).create({
      school,
      lease: createMemoryVault().leaseFor(school.id),
    });
    expect(await canvas.termSetup?.samplePackages()).toEqual({ ok: true, value: [] });
    expect(await canvas.verify()).toMatchObject({ ok: true });
    const courses = await canvas.courses();
    expect(courses.ok && courses.value.map((course) => course.code)).toEqual(["ENG-210-02"]);
  });
});
