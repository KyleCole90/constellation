import { describe, expect, it } from "vite-plus/test";

import type { Agent } from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import type { AnalyticsEvent } from "~/shared/analytics";
import { isoTime } from "~/shared/domain/ids";
import { Secret } from "~/shared/providers/provider";

import { clickWitness } from "./fixtures/changes";
import { makeStoreRig, type StoreRig, type StoreRigOptions } from "./fixtures/store-rig";
import { threadId } from "./fixtures/ids";

const QUEUE = threadId("t-queue");

const tracked = async (options: StoreRigOptions = {}) => {
  const events: AnalyticsEvent[] = [];
  const rig = await makeStoreRig({ ...options, track: (event) => events.push(event) });
  return { rig, events };
};
const atNow = (rig: StoreRig) => isoTime(rig.state().now());

describe("the store tells main what the teacher did", () => {
  it("names each setup step as the teacher moves past it, and only going forward", async () => {
    const { rig, events } = await tracked();
    await rig.clock.run(rig.state().chooseClaudeCode());
    events.length = 0;
    rig.state().setOnboarding("setup");
    rig.state().setOnboarding("done");
    rig.state().setOnboarding("done");
    expect(events).toEqual([
      { event: "onboarding_step_completed", step: "welcome", ai_source: "claude-code" },
      { event: "onboarding_step_completed", step: "setup", ai_source: "claude-code" },
      { event: "onboarding_finished" },
    ]);
  });

  it("names each change of AI source the teacher makes, and none that changes nothing", async () => {
    const { rig, events } = await tracked();
    await rig.clock.run(rig.state().addAiKey(new Secret("sk-ant-a-key-long-enough")));
    await rig.clock.run(rig.state().chooseClaudeCode());
    await rig.clock.run(rig.state().chooseClaudeCode());
    await rig.clock.run(rig.state().turnOffAi());
    expect(events).toEqual([
      { event: "ai_source_changed", from: "none", to: "key" },
      { event: "ai_source_changed", from: "key", to: "claude-code" },
      { event: "ai_source_changed", from: "claude-code", to: "none" },
    ]);
  });

  it("names a draft asked for, approved as written, and the grades one send posted", async () => {
    const { rig, events } = await tracked();
    await rig.connectAll();
    const ref = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    if (!ref) throw new Error("no submission");
    const id = await rig.clock.run(rig.state().openSubmission(QUEUE, ref, { fill: "draft" }));
    const draft = id ? rig.state().changes[id] : undefined;
    if (!id || !draft) throw new Error("nothing drafted");
    expect(
      rig
        .state()
        .dispatchUser(id, { type: "approve", witness: clickWitness(draft), at: atNow(rig) }),
    ).toMatchObject({ ok: true });
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(events).toEqual([
      { event: "draft_requested", kind: "grade" },
      { event: "draft_outcome", kind: "grade", outcome: "accepted" },
      { event: "grade_posted", count: 1 },
    ]);
  });

  it("names a discarded draft, and one the Claude plan's limit stopped", async () => {
    let limited = false;
    const rules = createRuleAgent();
    const agent: Agent = {
      async *run(input, signal) {
        if (limited) yield { type: "limited", text: "Your Claude plan's limit is reached." };
        else yield* rules.run(input, signal);
      },
    };
    const { rig, events } = await tracked({ agent });
    await rig.connectAll();
    const maya = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    if (!maya) throw new Error("no submission");
    const id = await rig.clock.run(rig.state().openSubmission(QUEUE, maya, { fill: "draft" }));
    if (!id) throw new Error("nothing drafted");
    expect(rig.state().dispatchUser(id, { type: "discard", at: atNow(rig) })).toMatchObject({
      ok: true,
    });
    limited = true;
    await rig.clock.run(rig.state().openSubmission(QUEUE, maya, { fill: "draft" }));
    expect(events).toEqual([
      { event: "draft_requested", kind: "grade" },
      { event: "draft_outcome", kind: "grade", outcome: "discarded" },
      { event: "draft_requested", kind: "grade" },
      { event: "draft_outcome", kind: "grade", outcome: "limited" },
    ]);
  });
});
