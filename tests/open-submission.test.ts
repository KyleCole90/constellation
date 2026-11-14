import { describe, expect, it } from "vite-plus/test";

import type { Agent } from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import type { IsoTime, LmsRef, ThreadId } from "~/shared/domain/ids";

import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;

const spyAgent = () => {
  const inner = createRuleAgent();
  const runs: string[] = [];
  const agent: Agent = {
    label: inner.label,
    run: (input, signal) => {
      runs.push(input.request);
      return inner.run(input, signal);
    },
  };
  return { agent, runs };
};

const maya = async () => {
  const spy = spyAgent();
  const rig = await makeStoreRig({ agent: spy.agent });
  await rig.connectAll();
  const ref = rig.server.findSubmission("Maya Ortiz", "Essay 2");
  if (!ref) throw new Error("no submission");
  return { rig, ref, runs: spy.runs };
};

const open = (rig: StoreRig, ref: LmsRef<"submission">, fill?: "draft" | "by-hand") =>
  rig.clock.run(rig.state().openSubmission(QUEUE, ref, fill ? { fill } : {}));
const atNow = (rig: StoreRig) => new Date(rig.state().now()).toISOString() as IsoTime;

describe("opening a submission with AI on spends nothing until the teacher asks", () => {
  it("opening drafts nothing and opens no form", async () => {
    const { rig, ref, runs } = await maya();
    expect(await open(rig, ref)).toBeNull();
    expect(runs).toEqual([]);
    expect(rig.state().changes).toEqual({});
    expect(rig.state().blanks).toEqual({});
  });

  it("Draft with Claude runs the agent once and focuses its draft", async () => {
    const { rig, ref, runs } = await maya();
    const id = await open(rig, ref, "draft");
    expect(runs).toHaveLength(1);
    expect(id).not.toBeNull();
    expect(rig.state().threads[QUEUE]?.focus).toBe(id);
  });

  it("Grade it yourself opens a blank form and runs no agent", async () => {
    const { rig, ref, runs } = await maya();
    const id = await open(rig, ref, "by-hand");
    if (!id) throw new Error("no form opened");
    expect(runs).toEqual([]);
    expect(rig.state().blanks[id]?.content.target).toBe(ref);
  });

  it("a discarded draft stays discarded on reopen, until the teacher asks again", async () => {
    const { rig, ref, runs } = await maya();
    const id = await open(rig, ref, "draft");
    if (!id) throw new Error("nothing drafted");
    expect(rig.state().dispatchUser(id, { type: "discard", at: atNow(rig) }).ok).toBe(true);

    expect(await open(rig, ref)).toBeNull();
    expect(runs).toHaveLength(1);

    expect(await open(rig, ref, "draft")).not.toBeNull();
    expect(runs).toHaveLength(2);
  });
});
