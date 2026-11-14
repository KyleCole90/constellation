import { describe, expect, it } from "vite-plus/test";

import type { Agent } from "~/shared/agent/agent";
import type { LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import { selectSubmission, selectUndrafted } from "~/renderer/stores/selectors";

import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;
const LCC = "lcc" as SchoolId;
const OFFER = "Draft a message asking Maya to resubmit the link";

/** Claude reads the work, can't see it, and drafts no grade, the way it answers a dead link. */
const cantSee = (): Agent & { calls: number } => {
  const agent = {
    calls: 0,
    async *run() {
      agent.calls += 1;
      yield {
        type: "say",
        text: "I didn't draft a grade because I can't see Maya's work.",
        replies: [OFFER],
      };
    },
  };
  return agent;
};

const declined = async () => {
  const agent = cantSee();
  const rig = await makeStoreRig({ agent });
  await rig.connectAll();
  const ref = rig.server.findSubmission("Maya Ortiz", "Essay 2");
  if (!ref) throw new Error("no submission");
  expect(await rig.clock.run(rig.state().openSubmission(QUEUE, ref, { fill: "draft" }))).toBeNull();
  return { rig, ref, agent };
};
const undrafted = (rig: StoreRig, ref: LmsRef<"submission">) =>
  selectUndrafted(rig.state(), selectSubmission(rig.state(), ref));

describe("after Claude drafts no grade for a submission", () => {
  it("keeps the next step Claude offered", async () => {
    const { rig, ref } = await declined();
    expect(undrafted(rig, ref)?.offer).toBe(OFFER);
  });

  it("drafting the unchanged submission again spends nothing", async () => {
    const { rig, ref, agent } = await declined();
    expect(
      await rig.clock.run(rig.state().openSubmission(QUEUE, ref, { fill: "draft" })),
    ).toBeNull();
    expect(agent.calls).toBe(1);
  });

  it("a resubmission can be drafted again", async () => {
    const { rig, ref, agent } = await declined();
    rig.server.studentResubmits(ref);
    await rig.clock.run(rig.state().syncSchool(LCC));
    expect(undrafted(rig, ref)).toBeNull();
    await rig.clock.run(rig.state().openSubmission(QUEUE, ref, { fill: "draft" }));
    expect(agent.calls).toBe(2);
  });
});
