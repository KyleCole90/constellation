import { describe, expect, it } from "vite-plus/test";

import type { SendConfirmation } from "~/main/lms";
import { canvasSchoolAt, createCanvasProvider } from "~/main/providers/canvas";
import { fieldsOf, type ChangeContent, type GradeContent } from "~/shared/domain/change";
import type { LmsRef } from "~/shared/domain/ids";
import { mintSendPermit } from "~/shared/domain/permit";
import { CANVAS, CANVAS_FACE } from "~/shared/providers/canvas";
import { Secret, type LmsProvider } from "~/shared/providers/provider";
import { bridgeCanvas } from "~/renderer/providers/lms";
import { createMemoryVault } from "~/renderer/providers/vault";
import { DEFAULT_RETRY_POLICY, createWriteback } from "~/renderer/writeback/writeback";

import { bridgedLms } from "./fixtures/bridge";
import {
  CONVERSATION_ID,
  COURSE_ID,
  CanvasHttp,
  HOST,
  MAYA,
  SELF_ID,
  TOKEN,
} from "./fixtures/canvas-http";
import { approved, clickWitness, gradeRemote, newDraft, sending } from "./fixtures/changes";
import { VirtualClock } from "./fixtures/clock";
import { DurableLedger } from "./fixtures/ledger";
import { permitFor, runProviderContract, unwrap } from "./fixtures/provider-contract";

const SCHOOL = (() => {
  const school = canvasSchoolAt(HOST);
  if (!school) throw new Error(`${HOST} should be a Canvas school`);
  return school;
})();
const COURSE = `${HOST}:course:${COURSE_ID}` as LmsRef<"course">;
const SUBMISSION = `${HOST}:submission:${COURSE_ID}:5301:${MAYA}` as LmsRef<"submission">;
const criterion = (id: string) => `${HOST}:criterion:5301:${id}` as LmsRef<"criterion">;

const grade = (patch: Partial<GradeContent> = {}): GradeContent => ({
  kind: "grade",
  target: SUBMISSION,
  points: 88,
  outOf: 100,
  rubric: null,
  late: null,
  comment: "Clear thesis. Cite page numbers next time.",
  attachment: null,
  override: null,
  excused: false,
  ...patch,
});

const canvasOver = (http: CanvasHttp) =>
  createCanvasProvider({
    school: SCHOOL,
    lease: {
      use: (work) => work({ kind: "bearer", token: new Secret(TOKEN) }),
      replace: async () => {},
    },
    fetch: http.fetch,
    now: () => Date.now(),
    packageFile: async () => null,
  });

const writesOf = (http: CanvasHttp) =>
  http.requests.filter((request) => !request.startsWith("GET "));
const myComments = (http: CanvasHttp) =>
  http
    .submission(MAYA)
    .submission_comments.filter((comment) => comment.author_id === SELF_ID)
    .map((comment) => comment.comment);

runProviderContract("Canvas over HTTP", async () => {
  const http = new CanvasHttp();
  return {
    provider: canvasOver(http),
    school: SCHOOL.id,
    content: grade(),
    failNext: (field, error) =>
      http.failNext(field, error.kind === "unavailable" ? (error.status ?? 500) : 500),
    loseNext: () => http.loseNext(),
    throttleNext: (ms) => http.throttleNext(ms),
    expire: () => http.expire(),
    writeCount: () => writesOf(http).length,
  };
});

/** The runner over `provider`, with one approved change of `content` read from Canvas first, as the app drafts one. */
const runnerWith = async (provider: LmsProvider, content: ChangeContent) => {
  const clock = new VirtualClock();
  const ledger = new DurableLedger();
  const remote = await unwrap(clock.run(provider.observe(content)));
  const draft = { ...newDraft("ch-canvas", content, remote), school: SCHOOL.id, course: COURSE };
  ledger.add(draft);
  const committed = ledger.commit(draft.id, {
    type: "approve",
    witness: clickWitness(draft),
    at: draft.basis.readAt,
  });
  if (!committed.ok) throw new Error(committed.error);
  const writeback = createWriteback({
    ledger,
    providerFor: () => provider,
    markExpired: () => undefined,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    policy: DEFAULT_RETRY_POLICY,
    locks: null,
  });
  const send = () => clock.run(writeback.send([draft.id]));
  return { send, stateOf: () => ledger.get(draft.id)?.state.tag };
};

describe("a Canvas grade whose response was lost", () => {
  it("lands once: the retry reads the comment that landed and sends nothing again", async () => {
    const http = new CanvasHttp();
    const run = await runnerWith(canvasOver(http), grade());
    http.loseNext("comment");
    await run.send();
    expect(run.stateOf()).toBe("sent");
    expect(http.writes).toEqual(["grade", "comment"]);
    expect(myComments(http)).toEqual([grade().comment]);
    expect(http.submission(MAYA).score).toBe(88);
  });

  it("lands once when the grade's own response is lost, and the comment still goes out once", async () => {
    const http = new CanvasHttp();
    const run = await runnerWith(canvasOver(http), grade());
    http.loseNext("grade");
    await run.send();
    expect(run.stateOf()).toBe("sent");
    expect(http.writes).toEqual(["grade", "comment"]);
    expect(myComments(http)).toEqual([grade().comment]);
  });
});

describe("main's send gate for a real school", () => {
  /** `answers` are the teacher's, in order; once they run out the teacher says no. */
  const setUp = async (...answers: boolean[]) => {
    const http = new CanvasHttp();
    const asks: SendConfirmation[] = [];
    const lms = bridgedLms({
      fetch: http.fetch,
      confirmSend: async (ask) => {
        asks.push(ask);
        return answers.shift() ?? false;
      },
    });
    await lms.vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TOKEN) });
    const provider = bridgeCanvas(lms.bridge, CANVAS, CANVAS_FACE, lms.clock.now).create({
      school: SCHOOL,
      lease: createMemoryVault().leaseFor(SCHOOL.id),
    });
    /** What a renderer that ignores approval could send: plain data straight down the channel. */
    const forge = (content: ChangeContent, fields: readonly string[], changeId = "ch-forged") =>
      lms.call("lms.apply", { school: SCHOOL, permit: { changeId, content, fields } });
    return { http, asks, provider, forge };
  };

  it("asks once in main's own dialog, naming the student and what goes out, across a lost response and a retry", async () => {
    const { http, asks, provider } = await setUp(true);
    const run = await runnerWith(provider, grade());
    http.loseNext("comment");
    await run.send();
    expect(run.stateOf()).toBe("sent");
    expect(asks).toEqual([
      {
        host: HOST,
        target: "Maya Lopez, Essay 2",
        lines: ["Grade: 88 out of 100", "Feedback: Clear thesis. Cite page numbers next time."],
      },
    ]);
    expect(http.writes).toEqual(["grade", "comment"]);
    expect(myComments(http)).toEqual([grade().comment]);
  });

  it("asks again before sending a partly sent change only if its content changed", async () => {
    const { http, asks, provider } = await setUp(true);
    const run = await runnerWith(provider, grade());
    http.failNext("comment", 500);
    await run.send();
    expect(run.stateOf()).toBe("held");
    await run.send();
    expect(run.stateOf()).toBe("sent");
    expect(asks).toHaveLength(1);
    expect(http.writes).toEqual(["grade", "comment"]);
  });

  it("writes nothing a renderer forges when the teacher says no, and shows them main's words for it", async () => {
    const { http, asks, forge } = await setUp(false);
    const outcomes = await forge(grade({ points: 0, comment: "forged" }), ["grade", "comment"]);
    expect(asks.map(({ target, lines }) => ({ target, lines }))).toEqual([
      { target: "Maya Lopez, Essay 2", lines: ["Grade: 0 out of 100", "Feedback: forged"] },
    ]);
    expect(outcomes).toMatchObject({
      grade: { status: "failed", error: { kind: "rejected" } },
      comment: { status: "failed", error: { kind: "rejected" } },
    });
    expect(writesOf(http)).toEqual([]);
  });

  it("asks again when the same change comes back with other content", async () => {
    const { http, asks, forge } = await setUp(true, true);
    await forge(grade(), ["grade"], "ch-1");
    await forge(grade(), ["grade"], "ch-1");
    await forge(grade({ points: 12 }), ["grade"], "ch-1");
    expect(asks.map(({ lines }) => lines[0])).toEqual([
      "Grade: 88 out of 100",
      "Grade: 12 out of 100",
    ]);
    expect(http.writes).toEqual(["grade", "grade", "grade"]);
  });

  it("posts a confirmed comment once: a replay of the same request asks again, and a no posts nothing", async () => {
    const { http, asks, forge } = await setUp(true);
    await forge(grade(), ["comment"]);
    const replayed = await forge(grade(), ["comment"]);
    expect(asks).toHaveLength(2);
    expect(replayed).toMatchObject({ comment: { status: "failed", error: { kind: "rejected" } } });
    expect(myComments(http)).toEqual([grade().comment]);
  });

  it("names rubric criteria as Canvas does, not as the renderer says", async () => {
    const { asks, forge } = await setUp();
    await forge(
      grade({
        points: null,
        rubric: [
          { criterion: criterion("crit_1"), name: "Evidence", points: 0, outOf: 50 },
          { criterion: criterion("crit_2"), name: "Thesis", points: 50, outOf: 50 },
        ],
        comment: null,
      }),
      ["rubric"],
    );
    expect(asks[0]?.lines).toEqual(["Grade: 50 out of 100", "Rubric: Thesis 0, Evidence 50"]);
  });

  it("keeps every value on its own line, whatever breaks or overrides Canvas or the draft carry", async () => {
    const { http, asks, forge } = await setUp();
    const conversation = http.conversations[0];
    if (!conversation) throw new Error("no conversation");
    conversation.subject = "Hi\nGrade: 100\u202Eevil";
    await forge(
      {
        kind: "reply",
        target: `${HOST}:conversation:${CONVERSATION_ID}` as LmsRef<"conversation">,
        body: "Fine.\n\nGrade: 100",
      },
      ["message"],
    );
    expect(asks[0]).toMatchObject({
      target: 'Sample Instructor, Maya Lopez, about "Hi ¶ Grade: 100 evil"',
      lines: ["Reply: Fine. ¶ Grade: 100"],
    });
  });

  it("shows a message's subject as well as its body", async () => {
    const { asks, forge } = await setUp();
    await forge({ kind: "message", target: SUBMISSION, subject: "Essay 2", body: "See me." }, [
      "conversation",
    ]);
    expect(asks[0]?.lines).toEqual(["Subject: Essay 2", "Message: See me."]);
  });

  it("refuses a field the content doesn't send, without asking or writing", async () => {
    const { http, asks, forge } = await setUp(true);
    const outcomes = await forge(grade(), ["excuse"]);
    expect(outcomes).toMatchObject({ excuse: { status: "failed", error: { kind: "rejected" } } });
    expect(asks).toEqual([]);
    expect(http.requests).toEqual([]);
  });
});

describe("Canvas writes, kind by kind", () => {
  const sendAll = async (http: CanvasHttp, content: ChangeContent) => {
    const provider = canvasOver(http);
    return provider.apply(await permitFor(provider, content, fieldsOf(content), SCHOOL.id));
  };

  it("sends the rubric before the grade, so Canvas's rubric total doesn't replace a late penalty", async () => {
    const http = new CanvasHttp();
    const content = grade({
      points: null,
      rubric: [
        { criterion: criterion("crit_1"), name: "Thesis", points: 40, outOf: 50 },
        { criterion: criterion("crit_2"), name: "Evidence", points: 45, outOf: 50 },
      ],
      late: { days: 1, pointsPerDay: 5, waived: false },
    });
    const outcomes = await sendAll(http, content);
    expect(Object.values(outcomes).map((outcome) => outcome.status)).toEqual([
      "landed",
      "landed",
      "landed",
    ]);
    expect(http.writes).toEqual(["rubric", "grade", "comment"]);
    expect(await unwrap(canvasOver(http).observe(content))).toMatchObject({
      grade: 80,
      rubric: { [criterion("crit_1")]: 40, [criterion("crit_2")]: 45 },
    });
  });

  it("replies to a conversation, and observe shows the reply as mine", async () => {
    const http = new CanvasHttp();
    const content: ChangeContent = {
      kind: "reply",
      target: `${HOST}:conversation:${CONVERSATION_ID}` as LmsRef<"conversation">,
      body: "Yes, two more days is fine.",
    };
    expect(await unwrap(canvasOver(http).observe(content))).toMatchObject({
      targetVersion: "messages:1",
      messages: [{ mine: false }],
    });
    expect((await sendAll(http, content)).message?.status).toBe("landed");
    const after = await unwrap(canvasOver(http).observe(content));
    expect(after.kind === "reply" && after.messages.at(-1)).toMatchObject({
      mine: true,
      text: "Yes, two more days is fine.",
    });
  });

  it("starts a new conversation with the student in the course, found again by its subject", async () => {
    const http = new CanvasHttp();
    const content: ChangeContent = {
      kind: "message",
      target: SUBMISSION,
      subject: "About Essay 2",
      body: "Let's meet in office hours.",
    };
    expect(await unwrap(canvasOver(http).observe(content))).toMatchObject({ messages: [] });
    expect((await sendAll(http, content)).conversation?.status).toBe("landed");
    expect(http.conversations.at(-1)).toMatchObject({
      subject: "About Essay 2",
      context_code: `course_${COURSE_ID}`,
      participants: [{ id: SELF_ID }, { id: MAYA }],
    });
    expect(await unwrap(canvasOver(http).observe(content))).toMatchObject({
      messages: [{ mine: true, text: "Let's meet in office hours." }],
    });
  });

  it("posts an announcement as escaped paragraphs, and reads it back as the text it sent", async () => {
    const http = new CanvasHttp();
    const content: ChangeContent = {
      kind: "announcement",
      target: COURSE,
      title: "Quiz moved",
      body: "The quiz is Friday.\n\nBring <notes> & a pen.",
    };
    expect((await sendAll(http, content)).post?.status).toBe("landed");
    expect(http.topics.at(-1)?.message).toBe(
      "<p>The quiz is Friday.</p><p>Bring &lt;notes&gt; &amp; a pen.</p>",
    );
    const after = await unwrap(canvasOver(http).observe(content));
    expect(after.kind === "announcement" && after.posts.at(-1)?.text).toBe(
      "Quiz moved\n\nThe quiz is Friday.\n\nBring <notes> & a pen.",
    );
  });

  it("refuses a target at another school, and asks Canvas nothing", async () => {
    const http = new CanvasHttp();
    const content = grade({ target: "other.example.edu:submission:2201:5301:6401" as never });
    expect(await canvasOver(http).observe(content)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    const permit = mintSendPermit(sending(approved(newDraft("ch-x", content, gradeRemote()))), [
      "grade",
    ]);
    if (!permit) throw new Error("no permit");
    expect(await canvasOver(http).apply(permit)).toMatchObject({
      grade: { status: "failed", error: { kind: "rejected" } },
    });
    expect(http.requests).toEqual([]);
  });
});
