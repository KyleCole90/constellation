import { describe, expect, it } from "vite-plus/test";

import type { AgentInput, AgentScope } from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import type { ChangeId, ThreadId } from "~/shared/domain/ids";
import { invoker, type Bridge } from "~/shared/ipc";
import { createBridgeAgent } from "~/renderer/providers/agent";
import {
  selectGradebook,
  selectInboxRows,
  selectQueueRows,
  selectWhatsDue,
} from "~/renderer/stores/selectors";

import { clickWitness } from "./fixtures/changes";
import { makeStoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;

/** What the renderer hands main for Claude, answered by the rules agent so drafts still land. */
const wire = async () => {
  const sent: { request: string; scope: AgentScope }[] = [];
  const rules = createRuleAgent();
  const bridge: Bridge = {
    fakes: false,
    invoke: invoker(async (channel, raw) => {
      if (channel !== "agent.run") throw new Error(`unexpected ${channel}`);
      const input = raw as {
        request: string;
        history: AgentInput["thread"]["history"];
        scope: AgentScope;
      };
      sent.push({ request: input.request, scope: input.scope });
      const effects: unknown[] = [];
      const run = {
        request: input.request,
        thread: { history: input.history },
        scope: input.scope,
      };
      for await (const effect of rules.run(run, new AbortController().signal)) effects.push(effect);
      return { ok: true, effects, spend: { tokens: 0, usd: 0 } };
    }),
  };
  const rig = await makeStoreRig({ agent: createBridgeAgent(bridge, () => true) });
  await rig.connectAll();
  return { rig, sent };
};

const refs = (items: readonly { ref: string }[]) => items.map((item) => item.ref);
const allSubmissions = (rig: Awaited<ReturnType<typeof wire>>["rig"]) =>
  Object.values(rig.state().cache).flatMap((cache) => cache.submissions);

describe("what a turn sends Claude", () => {
  it("a correction sends the draft's own submission, assignment and course, not the course", async () => {
    const { rig, sent } = await wire();
    const ref = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    if (!ref) throw new Error("no submission");
    const id: ChangeId | null = await rig.clock.run(
      rig.state().openSubmission(QUEUE, ref, { fill: "draft" }),
    );
    if (!id) throw new Error("Nothing was drafted.");
    await rig.clock.run(rig.state().sendToAgent(QUEUE, "thesis should be 20"));

    const [draft, correction] = sent;
    if (!draft || !correction) throw new Error(`${sent.length} runs`);
    expect(correction.request).toBe("thesis should be 20");
    expect(refs(correction.scope.submissions)).toEqual([ref]);
    expect(refs(correction.scope.assignments)).toEqual(refs(draft.scope.assignments));
    expect(refs(correction.scope.courses)).toEqual(refs(draft.scope.courses));
    expect(correction.scope.conversations).toEqual([]);
    expect(correction.scope.changes.map((change) => change.id)).toEqual([id]);
    expect(rig.state().changes[id]?.content).toMatchObject({ kind: "grade" });
  });

  it("a North Star question sends the work waiting on the teacher, without its bodies", async () => {
    const { rig, sent } = await wire();
    const started = rig.state().startChat("What should I grade first this week?");
    if (!started) throw new Error("No chat started.");
    await rig.clock.run(started.done);

    const [chat] = sent;
    if (!chat) throw new Error("no run");
    expect(chat.scope.northStar).toBeDefined();
    const waiting = allSubmissions(rig).filter(
      (s) => s.workflow === "submitted" || s.workflow === "missing",
    );
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.length).toBeLessThan(allSubmissions(rig).length);
    expect(refs(chat.scope.submissions)).toEqual(refs(waiting));
    expect(chat.scope.submissions.filter((submission) => "body" in submission)).toEqual([]);
  });

  it("a North Star question about who is behind sends every course's gradebook totals, not its rubrics", async () => {
    const { rig, sent } = await wire();
    const started = rig.state().startChat("Who's falling behind?");
    if (!started) throw new Error("No chat started.");
    await rig.clock.run(started.done);

    const [chat] = sent;
    const grades = chat?.scope.northStar?.grades;
    if (!chat || !grades) throw new Error("no grades sent");
    expect(grades.map((course) => course.course)).toEqual(refs(chat.scope.courses));
    for (const { course, students } of grades) {
      const book = selectGradebook(rig.state(), course);
      expect(students).toEqual(
        book?.rows.map((row) =>
          expect.objectContaining({
            name: row.student.name,
            percent: row.percent,
            missing: row.missing,
          }),
        ),
      );
    }
    expect(grades.flatMap((course) => course.students).some((s) => s.percent !== null)).toBe(true);
    expect(chat.scope.assignments.filter((a) => Array.isArray(a.rubric))).toEqual([]);
  });

  it("a North Star question marks a reply waiting the way What's due does, even once the teacher opened it (#127)", async () => {
    const { rig, sent } = await wire();
    const wren = selectInboxRows(rig.state()).find(
      (row) => row.conversation.from === "Wren Calloway",
    );
    if (!wren) throw new Error("no conversation from Wren");
    rig.state().setConversationRead(wren.conversation.ref, true);
    const started = rig.state().startChat("What's left this week?");
    if (!started) throw new Error("No chat started.");
    await rig.clock.run(started.done);

    const [chat] = sent;
    const sentWren = chat?.scope.conversations.find((c) => c.ref === wren.conversation.ref);
    expect(sentWren).toMatchObject({ awaitingReply: true });
    expect(sentWren).not.toHaveProperty("unread");
  });

  it("every count, and what Claude reads, holds only the roster: no concluded student, no Test Student (#151)", async () => {
    const { rig, sent } = await wire();
    const offRoster = ["Marcus Bell", "Test Student"];
    expect(offRoster.map((name) => rig.server.findSubmission(name, "Essay 2"))).not.toContain(
      undefined,
    );
    const started = rig.state().startChat("What needs my attention this week?");
    if (!started) throw new Error("No chat started.");
    await rig.clock.run(started.done);

    const [chat] = sent;
    const northStar = chat?.scope.northStar as unknown as {
      grades: { course: string; counts: Record<string, number> }[];
    };
    if (!chat || !northStar) throw new Error("no North Star scope");
    const names = [
      ...allSubmissions(rig).map((s) => s.studentName),
      ...chat.scope.submissions.map((s) => s.studentName),
    ];
    expect(names.filter((name) => offRoster.includes(name))).toEqual([]);

    const essay2 = selectWhatsDue(rig.state(), rig.state().now())
      .flatMap((group) => group.items)
      .find((item) => item.assignment.shortTitle === "Essay 2");
    if (!essay2) throw new Error("no Essay 2");
    const book = selectGradebook(rig.state(), essay2.course.ref);
    const column = book?.rows.map(
      (row) => row.cells.find((cell) => cell.assignment === essay2.assignment.ref)?.submission,
    );
    expect(essay2.missing).toBe(column?.filter((s) => s?.workflow === "missing").length);
    expect(essay2.total).toBe(book?.rows.length);
    expect(selectQueueRows(rig.state(), essay2.assignment.ref, true)).toHaveLength(
      essay2.toGrade + essay2.missing,
    );
    expect(chat.scope.assignments.find((a) => a.ref === essay2.assignment.ref)).toMatchObject({
      missing: essay2.missing,
    });

    const eng101 = northStar.grades.find((course) => course.course === essay2.course.ref);
    expect(eng101?.counts).toEqual({
      students: book?.rows.length,
      withMissingWork: book?.rows.filter((row) => row.missing > 0).length,
      atRisk: expect.any(Number),
      watch: expect.any(Number),
      onTrack: expect.any(Number),
      noGrades: expect.any(Number),
    });
  });

  it("a turn on one item sees the message already sent to that student about other work (#153)", async () => {
    const { rig, sent } = await wire();
    const essay = rig.server.findSubmission("Aaliyah Brooks", "Essay 2");
    const response = rig.server.findSubmission("Aaliyah Brooks", "Reading Response 6");
    const other = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    if (!essay || !response || !other) throw new Error("no submissions");
    const message = await rig.clock.run(rig.state().openMessage(QUEUE, essay));
    const unrelated = await rig.clock.run(rig.state().openMessage(QUEUE, other));
    if (!message || !unrelated) throw new Error("Nothing was drafted.");
    const record = rig.state().changes[message];
    if (!record) throw new Error("no message");
    rig.state().dispatchUser(message, {
      type: "approve",
      witness: clickWitness(record),
      at: record.basis.readAt,
    });
    await rig.clock.run(rig.state().sendChanges([message]));
    expect(rig.state().changes[message]?.state.tag).toBe("sent");

    const grade = await rig.clock.run(
      rig.state().openSubmission(QUEUE, response, { fill: "draft" }),
    );
    if (!grade) throw new Error("Nothing was drafted.");
    await rig.clock.run(rig.state().sendToAgent(QUEUE, "Draft her reflection, under 40 words."));

    const turn = sent.at(-1);
    expect(turn?.request).toBe("Draft her reflection, under 40 words.");
    expect(turn?.scope.submissions.map((s) => s.ref)).toEqual([response]);
    expect(turn?.scope.changes.map((change) => change.id).sort()).toEqual([grade, message].sort());
    expect(turn?.scope.changes.find((change) => change.id === message)).toMatchObject({
      content: { kind: "message", target: essay },
      state: { tag: "sent" },
    });
  });
});
