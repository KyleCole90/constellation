import { describe, expect, it } from "vite-plus/test";

import type { AgentInput, AgentScope } from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import type { ChangeId, ThreadId } from "~/shared/domain/ids";
import { invoker, type Bridge } from "~/shared/ipc";
import { createBridgeAgent } from "~/renderer/providers/agent";
import { selectGradebook } from "~/renderer/stores/selectors";

import { makeStoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;

/** What the renderer hands main for Claude, answered by the rules agent so drafts still land. */
const wire = async () => {
  const sent: { request: string; scope: AgentScope }[] = [];
  const rules = createRuleAgent();
  const bridge: Bridge = {
    agent: "claude",
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
});
