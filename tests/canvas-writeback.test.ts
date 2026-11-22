import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { SEND_PRESS_MS } from "~/main/lms";
import { canvasSchoolAt, createCanvasProvider } from "~/main/providers/canvas";
import { fieldsOf, type ChangeContent, type GradeContent } from "~/shared/domain/change";
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
import { lmsRef } from "./fixtures/ids";

const SCHOOL = (() => {
  const school = canvasSchoolAt(HOST);
  if (!school) throw new Error(`${HOST} should be a Canvas school`);
  return school;
})();
const COURSE = lmsRef<"course">(`${HOST}:course:${COURSE_ID}`);
const SUBMISSION = lmsRef<"submission">(`${HOST}:submission:${COURSE_ID}:5301:${MAYA}`);
const criterion = (id: string) => lmsRef<"criterion">(`${HOST}:criterion:5301:${id}`);

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

const canvasOver = (
  http: CanvasHttp,
  attachmentFile: (submission: string, name: string) => Promise<Blob | null> = async () => null,
) =>
  createCanvasProvider({
    school: SCHOOL,
    lease: {
      use: (work) => work({ kind: "bearer", token: new Secret(TOKEN) }),
      replace: async () => {},
    },
    fetch: http.fetch,
    now: () => Date.now(),
    packageFile: async () => null,
    attachmentFile,
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
  const setUp = async () => {
    const http = new CanvasHttp();
    const press = { at: Date.now() };
    const lms = bridgedLms({ fetch: http.fetch, pressedAt: () => press.at });
    await lms.vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TOKEN) });
    const provider = bridgeCanvas(lms.bridge, CANVAS, CANVAS_FACE, lms.clock.now).create({
      school: SCHOOL,
      lease: createMemoryVault().leaseFor(SCHOOL.id),
    });
    const forge = (content: ChangeContent, fields: readonly string[], changeId = "ch-forged") =>
      lms.call("lms.apply", { school: SCHOOL, permit: { changeId, content, fields } });
    const pressNow = () => (press.at = Date.now());
    const pressedLongAgo = () => (press.at = Date.now() - SEND_PRESS_MS - 1);
    return { http, provider, forge, pressNow, pressedLongAgo };
  };

  it("sends one press's grade and comment once, across a lost response", async () => {
    const { http, provider } = await setUp();
    const run = await runnerWith(provider, grade());
    http.loseNext("comment");
    await run.send();
    expect(run.stateOf()).toBe("sent");
    expect(http.writes).toEqual(["grade", "comment"]);
    expect(myComments(http)).toEqual([grade().comment]);
  });

  it("finishes a partly sent change later without a new press, while its content is the same", async () => {
    const { http, provider, pressedLongAgo } = await setUp();
    const run = await runnerWith(provider, grade());
    http.failNext("comment", 500);
    await run.send();
    expect(run.stateOf()).toBe("held");
    pressedLongAgo();
    await run.send();
    expect(run.stateOf()).toBe("sent");
    expect(http.writes).toEqual(["grade", "comment"]);
  });

  it("writes nothing a renderer forges when the teacher hasn't pressed anything, and says why", async () => {
    const { http, forge, pressedLongAgo } = await setUp();
    pressedLongAgo();
    const outcomes = await forge(grade({ points: 0, comment: "forged" }), ["grade", "comment"]);
    expect(outcomes).toMatchObject({
      grade: {
        status: "failed",
        error: { kind: "rejected", reason: expect.stringContaining("Send") },
      },
      comment: { status: "failed", error: { kind: "rejected" } },
    });
    expect(writesOf(http)).toEqual([]);
  });

  it("needs a new press when the same change comes back with other content", async () => {
    const { http, forge, pressedLongAgo } = await setUp();
    await forge(grade(), ["grade"], "ch-1");
    pressedLongAgo();
    await forge(grade(), ["grade"], "ch-1");
    const changed = await forge(grade({ points: 12 }), ["grade"], "ch-1");
    expect(changed).toMatchObject({ grade: { status: "failed", error: { kind: "rejected" } } });
    expect(http.writes).toEqual(["grade", "grade"]);
  });

  it("posts a comment once per press: a replay is refused until the teacher presses again", async () => {
    const { http, forge, pressNow, pressedLongAgo } = await setUp();
    await forge(grade(), ["comment"]);
    pressedLongAgo();
    const replayed = await forge(grade(), ["comment"]);
    expect(replayed).toMatchObject({ comment: { status: "failed", error: { kind: "rejected" } } });
    expect(myComments(http)).toEqual([grade().comment]);
    pressNow();
    await forge(grade(), ["comment"]);
    expect(myComments(http)).toEqual([grade().comment, grade().comment]);
  });

  it("refuses a field the content doesn't send, without writing", async () => {
    const { http, forge } = await setUp();
    const outcomes = await forge(grade(), ["excuse"]);
    expect(outcomes).toMatchObject({ excuse: { status: "failed", error: { kind: "rejected" } } });
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
      target: lmsRef<"conversation">(`${HOST}:conversation:${CONVERSATION_ID}`),
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
    expect(after.kind === "announcement" && after.posts.at(-1)?.mine).toBe(true);
  });

  it("marks observed announcements as mine only when their author matches self", async () => {
    const http = new CanvasHttp();
    http.topics.push(
      {
        id: 3002,
        title: "Co-teacher note",
        message: "<p>From someone else.</p>",
        posted_at: "2026-11-02T15:05:00Z",
        author: { id: 9999 },
      },
      {
        id: 3003,
        title: "My note",
        message: "<p>From me.</p>",
        posted_at: "2026-11-02T15:10:00Z",
        author: { id: SELF_ID },
      },
    );
    const content: ChangeContent = {
      kind: "announcement",
      target: COURSE,
      title: "Draft",
      body: "Body",
    };
    const observed = await unwrap(canvasOver(http).observe(content));
    expect(observed).toMatchObject({
      kind: "announcement",
      posts: [
        { id: "3001", mine: false },
        { id: "3002", mine: false },
        { id: "3003", mine: true },
      ],
    });
  });

  it("refuses a target at another school, and asks Canvas nothing", async () => {
    const http = new CanvasHttp();
    const content = grade({
      target: lmsRef<"submission">("other.example.edu:submission:2201:5301:6401"),
    });
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

  it("advertises attachments capability on Canvas", () => {
    expect(CANVAS_FACE.capabilities.attachments).toBe(true);
  });
});

describe("Canvas submission comment attachments", () => {
  const dirs: string[] = [];
  const onDisk = (name: string, bytes: Uint8Array) => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-attach-"));
    dirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const bridgedCanvas = (chooseAttachment: () => Promise<string | null>) => {
    const http = new CanvasHttp();
    const lms = bridgedLms({ fetch: http.fetch, chooseAttachment });
    const provider = bridgeCanvas(lms.bridge, CANVAS, CANVAS_FACE, () => Date.now()).create({
      school: SCHOOL,
      lease: createMemoryVault().leaseFor(SCHOOL.id),
    });
    return { http, lms, provider };
  };

  it("picks a real file in main, hides its path, uploads its bytes, and observes it back", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\nannotated feedback");
    const path = onDisk("feedback.pdf", bytes);
    const { http, lms, provider } = bridgedCanvas(async () => path);
    await lms.vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TOKEN) });

    const picked = await unwrap(
      provider.pickAttachment?.(SUBMISSION) ?? Promise.reject(new Error("no picker")),
    );
    expect(picked).toEqual({ name: "feedback.pdf", kb: Math.ceil(bytes.byteLength / 1024) });
    expect(JSON.stringify(picked)).not.toContain(path);

    const content = grade({ comment: "See attached.", attachment: picked });
    const sent = await provider.apply(
      await permitFor(provider, content, fieldsOf(content), SCHOOL.id),
    );
    expect(sent.attachment?.status).toBe("landed");
    expect(http.uploads).toHaveLength(1);
    expect(http.uploads[0]?.bytes).toEqual(bytes);

    const after = await unwrap(provider.observe(content));
    expect(after.kind === "grade" && after.attachments).toMatchObject([
      { mine: true, text: "feedback.pdf" },
    ]);
    expect(after.kind === "grade" && after.comments).toEqual([
      expect.objectContaining({ mine: true, text: "See attached." }),
    ]);
  });

  it("follows a same-origin create_success redirect and attaches the file", async () => {
    const bytes = new TextEncoder().encode("redirected upload");
    const http = new CanvasHttp();
    http.confirmRedirect = true;
    const provider = canvasOver(http, async (submission, name) =>
      submission === SUBMISSION && name === "notes.txt" ? new Blob([bytes]) : null,
    );
    const content = grade({ comment: null, attachment: { name: "notes.txt", kb: 1 } });
    const sent = await provider.apply(
      await permitFor(provider, content, ["attachment"], SCHOOL.id),
    );
    expect(sent.attachment?.status).toBe("landed");
    expect(http.uploads[0]?.bytes).toEqual(bytes);
    expect(http.requests).toContain("GET /files/9001/create_success");
  });

  it("recovers from a lost attachment response without uploading twice", async () => {
    const bytes = new TextEncoder().encode("annotated");
    const http = new CanvasHttp();
    const provider = canvasOver(http, async () => new Blob([bytes]));
    const content = grade({ comment: null, attachment: { name: "marked.pdf", kb: 1 } });
    const run = await runnerWith(provider, content);
    http.loseNext("attachment");

    await run.send();
    expect(run.stateOf()).toBe("sent");
    expect(http.uploads).toHaveLength(1);
    expect(http.writes.filter((w) => w === "attachment")).toHaveLength(1);
  });

  it("keeps same-named attachments separate per submission", async () => {
    const theo = lmsRef<"submission">(`${HOST}:submission:${COURSE_ID}:5301:6402`);
    const mayaBytes = new TextEncoder().encode("maya feedback");
    const theoBytes = new TextEncoder().encode("theo feedback");
    const queue = [onDisk("feedback.pdf", mayaBytes), onDisk("feedback.pdf", theoBytes)];
    const { http, lms, provider } = bridgedCanvas(async () => queue.shift() ?? null);
    await lms.vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TOKEN) });

    const mayaPicked = await unwrap(
      provider.pickAttachment?.(SUBMISSION) ?? Promise.reject(new Error("no picker")),
    );
    const theoPicked = await unwrap(
      provider.pickAttachment?.(theo) ?? Promise.reject(new Error("no picker")),
    );
    const mayaContent = grade({ target: SUBMISSION, comment: null, attachment: mayaPicked });
    const theoContent = grade({ target: theo, comment: null, attachment: theoPicked });

    const mayaSent = await provider.apply(
      await permitFor(provider, mayaContent, ["attachment"], SCHOOL.id),
    );
    const theoSent = await provider.apply(
      await permitFor(provider, theoContent, ["attachment"], SCHOOL.id),
    );
    expect(mayaSent.attachment?.status).toBe("landed");
    expect(theoSent.attachment?.status).toBe("landed");
    expect(http.uploads.map((u) => u.bytes)).toEqual([mayaBytes, theoBytes]);
  });

  it("refuses empty, unpicked, non-https, and off-origin redirect uploads, and returns null on cancel", async () => {
    const emptyPath = onDisk("empty.pdf", new Uint8Array());
    const empty = bridgedCanvas(async () => emptyPath);
    expect(await empty.provider.pickAttachment?.(SUBMISSION)).toMatchObject({
      ok: false,
      error: { kind: "rejected" },
    });

    const cancelled = bridgedCanvas(async () => null);
    expect(await cancelled.provider.pickAttachment?.(SUBMISSION)).toEqual({
      ok: true,
      value: null,
    });

    const http = new CanvasHttp();
    const unpicked = canvasOver(http);
    const content = grade({ comment: null, attachment: { name: "forged.pdf", kb: 1 } });
    expect(
      await unpicked.apply(await permitFor(unpicked, content, ["attachment"], SCHOOL.id)),
    ).toMatchObject({
      attachment: { status: "failed", error: { kind: "rejected" } },
    });
    expect(http.requests.filter((r) => !r.startsWith("GET "))).toEqual([]);

    const badUrlHttp = new CanvasHttp();
    badUrlHttp.uploadUrlOverride = "http://insecure.example.edu/upload";
    const badUrl = canvasOver(badUrlHttp, async () => new Blob(["ok"]));
    expect(
      await badUrl.apply(await permitFor(badUrl, content, ["attachment"], SCHOOL.id)),
    ).toMatchObject({
      attachment: { status: "failed", error: { kind: "rejected" } },
    });

    const offOriginHttp = new CanvasHttp();
    offOriginHttp.confirmRedirect = true;
    offOriginHttp.confirmLocationOverride =
      "https://evil.example.com/api/v1/files/1/create_success";
    const offOrigin = canvasOver(offOriginHttp, async () => new Blob(["ok"]));
    expect(
      await offOrigin.apply(await permitFor(offOrigin, content, ["attachment"], SCHOOL.id)),
    ).toMatchObject({
      attachment: { status: "failed", error: { kind: "rejected" } },
    });
  });
});
