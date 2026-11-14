import { describe, expect, it } from "vite-plus/test";

import { DRAFT_GRADE_REQUEST, type Agent, type AgentInput } from "~/shared/agent/agent";
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
const SAID = "I didn't draft a grade because I can't see Maya's work.";

/** Claude reads the work, can't see it, and drafts no grade, the way it answers a dead link. Asked for a message, it drafts one. It keeps what each call heard. */
const cantSee = (): Agent & { calls: number; heard: AgentInput[] } => {
  const agent: Agent & { calls: number; heard: AgentInput[] } = {
    calls: 0,
    heard: [],
    async *run(input) {
      const { request, scope } = input;
      agent.calls += 1;
      agent.heard.push(input);
      const submission = scope.submissions[0];
      if (request === DRAFT_GRADE_REQUEST || !submission)
        yield { type: "say", text: SAID, replies: ["Show me the message to Maya"] };
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
const focused = (rig: StoreRig) => {
  const focus = rig.state().threads[QUEUE]?.focus;
  return selectThreadChanges(rig.state(), QUEUE).find((change) => change.id === focus);
};
const message = async (rig: StoreRig, ref: LmsRef<"submission">) => {
  await rig.clock.run(rig.state().openMessage(QUEUE, ref));
  return focused(rig);
};

describe("after Claude drafts no grade for a submission", () => {
  it("keeps what Claude said about it", async () => {
    const { rig, ref } = await declined();
    expect(undrafted(rig, ref)?.said).toBe(SAID);
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

  it("the resubmit message is drafted for this submission, from what Claude said about it alone (#87, #91)", async () => {
    const { rig, ref, agent } = await declined();
    expect((await message(rig, ref))?.content).toMatchObject({ kind: "message", target: ref });
    expect(agent.heard.at(-1)?.thread.history).toEqual([{ role: "agent", text: SAID }]);
  });

  it("once the message is drafted, the submission leads to it instead of drafting another (#87)", async () => {
    const { rig, ref, agent } = await declined();
    const drafted = (await message(rig, ref))?.id;
    rig.state().focusChange(QUEUE, null);
    const ask = () => selectMessageSince(rig.state(), selectSubmission(rig.state(), ref));
    expect(ask()?.id).toBe(drafted);
    expect(await message(rig, ref)).toMatchObject({ id: drafted });
    expect(agent.calls).toBe(2);
    rig.state().dispatchUser(drafted!, {
      type: "discard",
      at: new Date(rig.clock.now()).toISOString() as never,
    });
    expect(ask()).toBeNull();
  });

  it("the same student's next unreadable submission gets its own decline and its own message, untouched by the first (#91)", async () => {
    const { rig, ref, agent } = await declined();
    await message(rig, ref);
    const other = Object.values(rig.state().cache)
      .flatMap((cache) => cache.submissions)
      .find((s) => s.studentName === "Maya Ortiz" && s.ref !== ref && s.body.kind === "text");
    if (!other) throw new Error("no second submission");
    rig.state().focusChange(QUEUE, null);
    rig.state().setThreadUi(QUEUE, { current: other.ref });
    await rig.clock.run(rig.state().openSubmission(QUEUE, other.ref, { fill: "draft" }));
    expect(agent.heard.at(-1)?.request).toBe(DRAFT_GRADE_REQUEST);
    expect(agent.heard.at(-1)?.thread.history).toEqual([]);
    expect(undrafted(rig, other.ref)?.said).toBe(SAID);
    expect(selectMessageSince(rig.state(), selectSubmission(rig.state(), other.ref))).toBeNull();
    const second = await message(rig, other.ref);
    expect(second?.content).toMatchObject({ kind: "message", target: other.ref });
    expect(selectMessageSince(rig.state(), selectSubmission(rig.state(), ref))?.id).not.toBe(
      second?.id,
    );
  });
});
