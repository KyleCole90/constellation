import { describe, expect, it } from "vite-plus/test";

import { DRAFT_GRADE_REQUEST, type Agent } from "~/shared/agent/agent";
import type { LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import {
  selectMessageSince,
  selectSubmission,
  selectThreadChanges,
  selectUndrafted,
} from "~/renderer/stores/selectors";

import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;
const LCC = "lcc" as SchoolId;
const OFFER = "Draft a message asking Maya to resubmit the link";

/** Claude reads the work, can't see it, and drafts no grade, the way it answers a dead link. Asked after that, it drafts the message. */
const cantSee = (): Agent & { calls: number } => {
  const agent: Agent & { calls: number } = {
    calls: 0,
    async *run({ request, scope }) {
      agent.calls += 1;
      const submission = scope.submissions[0];
      if (request === DRAFT_GRADE_REQUEST || !submission)
        yield {
          type: "say",
          text: "I didn't draft a grade because I can't see Maya's work.",
          replies: [OFFER],
        };
      else {
        yield {
          type: "propose",
          school: submission.school,
          course: submission.course,
          subject: "Message to Maya",
          content: {
            kind: "message",
            target: submission.ref,
            subject: "Please resubmit your Essay 2 link",
            body: "Hi Maya, your link opens an error page. Can you check it and resubmit?",
          },
        };
        yield { type: "say", text: "I drafted a message to Maya. Press Approve, then Send." };
      }
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
  rig.state().setThreadUi(QUEUE, { queueOpen: false, current: ref });
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

  it("taking Claude's offer shows the message it drafts, for the student on screen (#87)", async () => {
    const { rig, ref } = await declined();
    await rig.clock.run(rig.state().sendToAgent(QUEUE, OFFER));
    const focus = rig.state().threads[QUEUE]?.focus;
    const shown = selectThreadChanges(rig.state(), QUEUE).find((change) => change.id === focus);
    expect(shown?.content).toMatchObject({ kind: "message", target: ref });
    expect(rig.state().threads[QUEUE]?.messages.at(-1)).toMatchObject({ change: focus });
  });

  it("once the message is drafted, the submission leads to it instead of drafting another (#87)", async () => {
    const { rig, ref, agent } = await declined();
    await rig.clock.run(rig.state().sendToAgent(QUEUE, OFFER));
    const drafted = rig.state().threads[QUEUE]?.focus;
    rig.state().focusChange(QUEUE, null);
    const ask = () => selectMessageSince(rig.state(), selectSubmission(rig.state(), ref));
    expect(ask()?.id).toBe(drafted);
    expect(agent.calls).toBe(2);
    rig.state().dispatchUser(drafted!, {
      type: "discard",
      at: new Date(rig.clock.now()).toISOString() as never,
    });
    expect(ask()).toBeNull();
  });
});
