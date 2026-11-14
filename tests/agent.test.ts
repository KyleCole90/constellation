import { describe, expect, it } from "vite-plus/test";

import {
  DRAFT_GRADE_REQUEST,
  describeViolation,
  parseAgentEffect,
  runAgent,
  type Agent,
  type AgentEffect,
  type AgentInput,
  type AgentScope,
  type AgentViolation,
} from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import type { GradeContent } from "~/shared/domain/change";
import type { ThreadId } from "~/shared/domain/ids";

import { AT, clickWitness } from "./fixtures/changes";
import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;

const emptyScope: AgentScope = {
  focus: null,
  changes: [],
  submissions: [],
  assignments: [],
  conversations: [],
  courses: [],
};

const collect = async (agent: Agent, input: Partial<AgentInput> & { request: string }) => {
  const effects: AgentEffect[] = [];
  const refused: AgentViolation[] = [];
  await runAgent(
    agent,
    { thread: { history: [] }, scope: emptyScope, ...input },
    {
      effect: (effect) => void effects.push(effect),
      refuse: (violation) => void refused.push(violation),
    },
    new AbortController().signal,
  );
  return { effects, refused };
};

const yields = (...raw: readonly unknown[]): Agent => ({
  label: "test double",
  async *run() {
    yield* raw;
  },
});

const opened = async (student = "Maya Ortiz", assignment = "Essay 2") => {
  const rig = await makeStoreRig();
  await rig.connectAll();
  const submission = rig.server.findSubmission(student, assignment);
  if (!submission) throw new Error(`No submission for ${student}.`);
  const id = await rig.state().openSubmission(QUEUE, submission, { fill: "draft" });
  if (!id) throw new Error("Nothing was drafted.");
  return { rig, id };
};
const contentOf = (rig: StoreRig, id: string): GradeContent =>
  rig.state().changes[id as never]?.content as GradeContent;
const lastMessage = (rig: StoreRig) => rig.state().threads[QUEUE]?.messages.at(-1);

describe("the effect parser", () => {
  it.each(["approve", "send", "mintSendPermit", "dispatch", "delete"])(
    "refuses a %s effect as unknown",
    async (type) => {
      const { effects, refused } = await collect(yields({ type, change: "ch-1" }), {
        request: "x",
      });
      expect(effects).toEqual([]);
      expect(refused).toEqual([{ kind: "unknown-effect", seen: type }]);
    },
  );

  it("refuses output that is not an object", () => {
    for (const raw of [null, "approve", 7, [], undefined])
      expect(parseAgentEffect(raw, emptyScope).ok).toBe(false);
  });

  it("drops extra keys, so nothing unparsed passes through", () => {
    const result = parseAgentEffect(
      { type: "say", text: "Hi", witness: { covers: () => true } },
      emptyScope,
    );
    expect(result).toEqual({ ok: true, value: { type: "say", text: "Hi" } });
  });

  it("refuses a change outside the thread's scope", () => {
    expect(
      parseAgentEffect(
        { type: "edit", change: "ch-other", patch: { kind: "reply", body: "x" }, why: "y" },
        emptyScope,
      ),
    ).toEqual({ ok: false, error: { kind: "out-of-scope", target: "ch-other" } });
  });

  it("a refusal explains itself without echoing a whole payload", () => {
    const text = describeViolation({ kind: "unknown-effect", seen: "approve" });
    expect(text).toContain("approve");
    expect(text).toContain("Approve and Send buttons");
  });

  it("an agent that throws reads as a refusal rather than a crash", async () => {
    const broken: Agent = {
      label: "broken",
      async *run() {
        yield { type: "say", text: "Starting." };
        throw new Error("model fell over");
      },
    };
    const { effects, refused } = await collect(broken, { request: "x" });
    expect(effects).toHaveLength(1);
    expect(refused).toEqual([{ kind: "malformed", detail: "the agent stopped unexpectedly" }]);
  });

  it("stops consuming once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const effects: AgentEffect[] = [];
    await runAgent(
      yields({ type: "say", text: "Hi" }),
      { request: "x", thread: { history: [] }, scope: emptyScope },
      { effect: (e) => void effects.push(e), refuse: () => undefined },
      controller.signal,
    );
    expect(effects).toEqual([]);
  });
});

describe("the agent, going through the store", () => {
  it("an unknown effect from a test double appears in the thread as a refusal and changes nothing", async () => {
    const rig = await makeStoreRig({ agent: yields({ type: "approve", change: "anything" }) });
    await rig.connectAll();
    await rig.state().sendToAgent(QUEUE, "do it");
    expect(lastMessage(rig)).toMatchObject({ type: "refusal" });
    expect(lastMessage(rig)?.type === "refusal" && lastMessage(rig)).toMatchObject({
      text: expect.stringContaining("approve"),
    });
    expect(Object.keys(rig.state().changes)).toEqual([]);
  });

  it("a quote that is not in the submission is refused and leaves no rationale", async () => {
    const { rig, id } = await opened();
    const annotated = rig.state().changes[id]?.rationale.length;
    const liar = yields({
      type: "annotate",
      change: id,
      field: "x",
      why: "y",
      quotes: [{ paragraph: 0, quote: "These words were never written." }],
    });
    const scope = rig.scopeFor(id);
    const { effects, refused } = await collect(liar, { request: "x", scope });
    expect(effects).toEqual([]);
    expect(refused[0]).toMatchObject({ kind: "quote-not-found" });
    expect(rig.state().changes[id]?.rationale).toHaveLength(annotated ?? 0);
  });

  it("a quote from the wrong paragraph is refused", async () => {
    const { rig, id } = await opened();
    const scope = rig.scopeFor(id);
    const submission = scope.submissions[0];
    const paragraphs = submission?.body.kind === "text" ? submission.body.paragraphs : [];
    const quote = paragraphs[0]?.slice(0, 30) ?? "";
    const { refused } = await collect(
      yields({
        type: "annotate",
        change: id,
        field: "x",
        why: "y",
        quotes: [{ paragraph: 1, quote }],
      }),
      { request: "x", scope },
    );
    expect(refused[0]).toMatchObject({ kind: "quote-not-found" });
  });

  it("a score above the criterion's maximum is refused", async () => {
    const { rig, id } = await opened();
    const scope = rig.scopeFor(id);
    const criterion = contentOf(rig, id).rubric?.[0]?.criterion as string;
    const { refused } = await collect(
      yields({
        type: "edit",
        change: id,
        patch: { kind: "grade", rubricPoints: { [criterion]: 999 } },
        why: "x",
      }),
      { request: "x", scope },
    );
    expect(refused[0]).toMatchObject({ kind: "out-of-range" });
  });

  it("a correction on an approved change resets its approval", async () => {
    const { rig, id } = await opened();
    const record = rig.state().changes[id];
    if (!record) throw new Error("No change.");
    expect(
      rig.state().dispatchUser(id, {
        type: "approve",
        witness: clickWitness(record),
        at: record.basis.readAt,
      }).ok,
    ).toBe(true);
    await rig.state().sendToAgent(QUEUE, "make it shorter");
    expect(rig.state().changes[id]?.state).toEqual({ tag: "draft", approvalReset: "agent-edited" });
    expect(rig.state().threads[QUEUE]?.messages.at(-1)).toMatchObject({ type: "agent" });
  });

  it("the input the store hands an agent holds data and no callable thing", async () => {
    let received: unknown = null;
    const spy: Agent = {
      label: "spy",
      async *run(input) {
        received = input;
        yield { type: "say", text: "Noted." };
      },
    };
    const rig = await makeStoreRig({ agent: spy });
    await rig.connectAll();
    await rig.state().sendToAgent(QUEUE, "anything");
    const functionsIn = (value: unknown): number => {
      if (typeof value === "function") return 1;
      if (typeof value !== "object" || value === null) return 0;
      return Object.values(value).reduce((sum: number, entry) => sum + functionsIn(entry), 0);
    };
    expect(received).not.toBeNull();
    expect(functionsIn(received)).toBe(0);
  });
});

describe("drafting", () => {
  it("a draft of a submission comes from the bank, with rationale anchored to passages that exist", async () => {
    const { rig, id } = await opened();
    const record = rig.state().changes[id];
    expect(record?.state).toEqual({ tag: "draft", approvalReset: null });
    expect(record?.rationale.length).toBeGreaterThan(0);
    const submission = rig
      .state()
      .cache["lcc" as never]?.submissions.find((s) => s.ref === record?.content.target);
    const paragraphs = submission?.body.kind === "text" ? submission.body.paragraphs : [];
    for (const rationale of record?.rationale ?? []) {
      expect(rationale.anchors.length).toBeGreaterThan(0);
      for (const anchor of rationale.anchors) {
        expect(anchor.end).toBeGreaterThan(anchor.start);
        expect(paragraphs[anchor.paragraph]?.length).toBeGreaterThanOrEqual(anchor.end);
      }
    }
  });

  it("a draft's basis comes from observe, so a resubmission's prior grade is the removed line", async () => {
    const { rig, id } = await opened("Luis Cardenas");
    const record = rig.state().changes[id];
    expect(record?.basis.remote.kind === "grade" && record.basis.remote.grade).not.toBeNull();
    expect(rig.state().previewFor(id)?.[0]?.note).toContain("now in the LMS");
  });

  it("a student who turned nothing in gets a zero, not a grade for work that isn't there", async () => {
    const { rig, id } = await opened("Fiona Kerr", "Sequence Analysis");
    const content = contentOf(rig, id);
    expect(content.rubric?.length).toBeGreaterThan(0);
    expect(content.rubric?.every((score) => score.points === 0)).toBe(true);
    expect(content.comment).toContain("recorded a zero");
    expect(content.comment).not.toContain("thank you for submitting");
  });

  it("opening the same submission twice returns the same change", async () => {
    const { rig, id } = await opened();
    const again = await rig
      .state()
      .openSubmission(QUEUE, rig.state().changes[id]?.content.target as never);
    expect(again).toBe(id);
    expect(Object.keys(rig.state().changes)).toHaveLength(1);
  });

  it("two opens at once create one change", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    const ref = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    if (!ref) throw new Error("no submission");
    const [a, b] = await Promise.all([
      rig.state().openSubmission(QUEUE, ref, { fill: "draft" }),
      rig.state().openSubmission(QUEUE, ref, { fill: "draft" }),
    ]);
    expect(a).toBe(b);
    expect(Object.keys(rig.state().changes)).toHaveLength(1);
  });

  it("a background draft leaves focus alone until someone opens that submission", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    const maya = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    const luis = rig.server.findSubmission("Luis Cardenas", "Essay 2");
    if (!maya || !luis) throw new Error("no submission");
    const drafted = await rig.state().openSubmission(QUEUE, maya, { focus: false, fill: "draft" });
    expect(drafted).not.toBeNull();
    expect(rig.state().threads[QUEUE]?.focus).toBeNull();

    const drafting = rig.state().openSubmission(QUEUE, luis, { focus: false, fill: "draft" });
    const asked = rig.state().openSubmission(QUEUE, luis);
    const [id] = await Promise.all([drafting, asked]);
    expect(rig.state().threads[QUEUE]?.focus).toBe(id);
  });

  it("a submission with no bank entry gets a generic draft that says it is only a starting point", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    const cache = rig.state().cache["lcc" as never];
    const submission = cache?.submissions.find((s) => s.workflow === "submitted");
    const assignment = cache?.assignments.find((a) => a.ref === submission?.assignment);
    const course = cache?.courses.find((c) => c.ref === submission?.course);
    if (!submission || !assignment || !course) throw new Error("No submission to draft.");
    const unbanked = {
      ...submission,
      body: {
        kind: "text",
        title: "Not in the bank",
        wordCount: 5,
        paragraphs: ["A paragraph nobody prepared for."],
      },
    } as const;
    const { effects, refused } = await collect(createRuleAgent(), {
      request: DRAFT_GRADE_REQUEST,
      scope: {
        ...emptyScope,
        submissions: [unbanked],
        assignments: [assignment],
        courses: [course],
      },
    });
    expect(refused).toEqual([]);
    expect(effects.find((effect) => effect.type === "propose")).toMatchObject({
      content: { kind: "grade", target: submission.ref },
    });
  });

  it("opening a conversation drafts a reply that a thread can edit", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    const conversation = rig.state().cache["lcc" as never]?.conversations[0];
    if (!conversation) throw new Error("no conversation");
    const id = await rig.state().openConversation(QUEUE, conversation.ref);
    const record = id && rig.state().changes[id];
    expect(record && record.content.kind).toBe("reply");
  });

  it("after a discard, asking a messages thread to draft drafts the conversation on screen", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    const mail = "t-e101-mail" as ThreadId;
    const course = rig.state().threads[mail]?.course;
    const conversation = rig
      .state()
      .cache["lcc" as never]?.conversations.find((c) => c.course === course);
    if (!conversation) throw new Error("no conversation");
    rig.state().setThreadUi(mail, { current: conversation.ref });
    const first = await rig.state().openConversation(mail, conversation.ref);
    if (!first) throw new Error("nothing drafted");
    rig.state().dispatchUser(first, { type: "discard", at: AT });
    rig.state().focusChange(mail, null);

    await rig.state().sendToAgent(mail, "Draft a reply");

    const focus = rig.state().threads[mail]?.focus;
    const record = focus ? rig.state().changes[focus] : undefined;
    expect(record?.content).toMatchObject({ kind: "reply", target: conversation.ref });
  });

  it("opening an announcement drafts one for that course", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    const course = rig.state().cache["lcc" as never]?.courses[0];
    if (!course) throw new Error("no course");
    const id = await rig.state().openAnnouncement(QUEUE, course.ref);
    const record = id && rig.state().changes[id];
    expect(record && record.content.kind).toBe("announcement");
  });
});

describe("free-text corrections", () => {
  const correct = async (request: string, student = "Maya Ortiz", assignment = "Essay 2") => {
    const { rig, id } = await opened(student, assignment);
    const before = contentOf(rig, id);
    await rig.state().sendToAgent(QUEUE, request);
    return { rig, id, before, after: contentOf(rig, id), reply: lastMessage(rig) };
  };
  const pointsOf = (content: GradeContent, partial: string) =>
    content.rubric?.find((r) => r.name.toLowerCase().includes(partial))?.points;

  it('"thesis should be 20" sets that criterion', async () => {
    const { after } = await correct("thesis should be 20");
    expect(pointsOf(after, "thesis")).toBe(20);
  });

  it('"lower analysis by 3" takes three points off', async () => {
    const { before, after } = await correct("lower analysis by 3");
    expect(pointsOf(after, "analysis")).toBe((pointsOf(before, "analysis") ?? 0) - 3);
  });

  it("a criterion is found by a partial name", async () => {
    const { before, after } = await correct("raise evid by 1");
    expect(pointsOf(after, "evid")).toBe((pointsOf(before, "evid") ?? 0) + 1);
  });

  it('"the grade should be 88" makes the rubric total reach it', async () => {
    const { after } = await correct("the grade should be 88");
    expect(after.rubric?.reduce((sum, r) => sum + (r.points ?? Number.NaN), 0)).toBe(88);
  });

  it("a grade change leaves the teacher's override alone and says so", async () => {
    const { rig, id } = await opened("Maya Ortiz", "Essay 2");
    rig.state().dispatchUser(id, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", override: 90 },
      at: AT,
    });
    const before = contentOf(rig, id);
    await rig.state().sendToAgent(QUEUE, "lower the grade by 2");
    expect(contentOf(rig, id)).toEqual(before);
    expect(lastMessage(rig)).toMatchObject({ type: "declined" });
  });

  it("a score out of range gets a reply and no edit", async () => {
    const { before, after, reply } = await correct("thesis should be 900");
    expect(after).toEqual(before);
    expect(reply).toMatchObject({ type: "declined" });
  });

  it('"drop the last sentence" removes it', async () => {
    const { before, after } = await correct("drop the last sentence");
    expect(after.comment?.length).toBeLessThan(before.comment?.length ?? 0);
    expect(before.comment?.startsWith(after.comment ?? "x")).toBe(true);
  });

  it('"say X instead of Y" swaps the phrase', async () => {
    const { rig, id } = await opened();
    const word = contentOf(rig, id).comment?.split(" ")[1] ?? "";
    await rig.state().sendToAgent(QUEUE, `say SWAPPED instead of ${word}`);
    expect(contentOf(rig, id).comment).toContain("SWAPPED");
    expect(contentOf(rig, id).comment?.split(" ")[1]).toBe("SWAPPED");
  });

  it('"say X instead of Y" with a phrase not in the draft changes nothing and says so', async () => {
    const { before, after, reply } = await correct("say this instead of nonexistentphrase");
    expect(after).toEqual(before);
    expect(reply).toMatchObject({
      type: "agent",
      text: expect.stringContaining("nonexistentphrase"),
    });
  });

  it('"make it shorter" shortens the comment', async () => {
    const { before, after } = await correct("make it shorter");
    expect(after.comment?.length).toBeLessThan(before.comment?.length ?? 0);
  });

  it('"warmer" adds to the comment', async () => {
    const { before, after } = await correct("warmer");
    expect(after.comment?.length).toBeGreaterThan(before.comment?.length ?? 0);
  });

  it('"warmer" twice does not repeat itself', async () => {
    const { rig, id, after } = await correct("warmer");
    await rig.state().sendToAgent(QUEUE, "warmer");
    expect(contentOf(rig, id)).toEqual(after);
  });

  it('"remove the attachment" clears it', async () => {
    const { rig, id } = await opened();
    rig.state().dispatchUser(id, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", attachment: { name: "notes.pdf", kb: 10 } },
      at: rig.state().changes[id]?.basis.readAt as never,
    });
    expect(contentOf(rig, id).attachment).not.toBeNull();
    await rig.state().sendToAgent(QUEUE, "remove the attachment");
    expect(contentOf(rig, id).attachment).toBeNull();
  });

  it('"mention the footnote" appends a sentence', async () => {
    const { before, after } = await correct("mention the footnote");
    expect(after.comment?.startsWith(before.comment ?? "x")).toBe(true);
    expect(after.comment).toContain("the footnote");
  });

  it("a reply can be corrected too", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    const conversation = rig.state().cache["lcc" as never]?.conversations[0];
    if (!conversation) throw new Error("no conversation");
    const id = await rig.state().openConversation(QUEUE, conversation.ref);
    if (!id) throw new Error("no change");
    await rig.state().sendToAgent(QUEUE, "warmer");
    const content = rig.state().changes[id]?.content;
    expect(content?.kind === "reply" && content.body).toContain("glad");
  });

  it("text it does not understand gets a plain reply naming what it can do, and no effects", async () => {
    const { before, after, reply } = await correct("what is the meaning of this essay");
    expect(after).toEqual(before);
    expect(reply).toMatchObject({
      type: "agent",
      text: expect.stringContaining('"thesis and claim should be 20"'),
    });
  });

  it("the reply shows only the sentence that changed", async () => {
    const { before, after, reply } = await correct("drop the last sentence");
    const dropped = before.comment?.slice(after.comment?.length).trim();
    expect(reply).toMatchObject({ edited: [{ label: "Feedback", from: dropped, to: "" }] });
    const { reply: warmer } = await correct("warmer");
    expect(warmer).toMatchObject({
      edited: [{ label: "Feedback", from: "", to: expect.stringMatching(/^I can see the effort/) }],
    });
  });

  describe("on a speech", () => {
    const speech = (request: string) => correct(request, "Jada Whitfield", "Speech 2");

    it('"make visual aid 15" sets that criterion', async () => {
      const { after } = await speech("make visual aid 15");
      expect(pointsOf(after, "visual")).toBe(15);
    });

    it("a request with two corrections does both", async () => {
      const { before, after } = await speech(
        "please raise the grade by 3 points and mention the video",
      );
      const total = (c: GradeContent) => c.rubric?.reduce((sum, r) => sum + (r.points ?? 0), 0);
      expect(total(after)).toBe((total(before) ?? 0) + 3);
      expect(after.comment).toContain("the video");
    });

    it("help names this rubric's criteria", async () => {
      const { reply } = await speech("what is this");
      expect(reply?.type === "agent" && reply.text).toContain(
        '"content and organization should be 32"',
      );
      expect(reply?.type === "agent" && reply.text).not.toMatch(/thesis|analysis|footnote/);
    });
  });

  describe("on an announcement", () => {
    const announcement = async () => {
      const rig = await makeStoreRig();
      await rig.connectAll();
      const course = rig.state().cache["lcc" as never]?.courses.find((c) => c.code === "ENG 102");
      if (!course) throw new Error("no course");
      const id = await rig.state().openAnnouncement(QUEUE, course.ref);
      if (!id) throw new Error("no change");
      const content = () => rig.state().changes[id]?.content;
      return { rig, content };
    };

    it('"make it about X" retargets the draft', async () => {
      const { rig, content } = await announcement();
      await rig
        .state()
        .sendToAgent(QUEUE, "Make it about the midterm review on Friday at 3pm in room 204");
      expect(content()).toMatchObject({
        title: "Midterm review on Friday at 3pm in room 204",
        body: expect.stringContaining("the midterm review on Friday at 3pm in room 204"),
      });
      expect(JSON.stringify(content())).not.toContain("library");
      expect(lastMessage(rig)).toMatchObject({
        edited: [
          { label: "Title", to: "Midterm review on Friday at 3pm in room 204" },
          { label: "Announcement", to: expect.stringMatching(/^Hello, ENG 102/) },
        ],
      });
    });

    it("text it does not understand gets help about announcements, not grades", async () => {
      const { rig } = await announcement();
      await rig.state().sendToAgent(QUEUE, "what is this");
      const reply = lastMessage(rig);
      expect(reply).toMatchObject({
        type: "agent",
        text: expect.stringContaining("make it about"),
      });
      expect(reply?.type === "agent" && reply.text).not.toMatch(/thesis|grade|attachment/);
    });
  });

  it("with nothing open it says to open something", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    await rig.state().sendToAgent(QUEUE, "thesis should be 20");
    expect(lastMessage(rig)).toMatchObject({
      type: "agent",
      text: expect.stringContaining("Open a submission"),
    });
  });

  it.each(["approve this", "send it", "please approve", "post it", "submit this", "Send them all"])(
    '"%s" gets a plain note that points at the real button, and moves nothing',
    async (request) => {
      const { before, after, reply, rig, id } = await correct(request);
      expect(after).toEqual(before);
      expect(rig.state().changes[id]?.state.tag).toBe("draft");
      expect(reply).toMatchObject({
        type: "declined",
        text: expect.stringContaining("Approve on the draft"),
      });
      expect(rig.server.log.filter((entry) => entry.kind === "write")).toEqual([]);
    },
  );
});
