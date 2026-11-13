import { describe, expect, it } from "vite-plus/test";

import type { Agent } from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import type { GradeContent } from "~/shared/domain/change";
import type { IsoTime, ThreadId } from "~/shared/domain/ids";

import { clickWitness } from "./fixtures/changes";
import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;
const UNREACHABLE = "Claude couldn't be reached, so nothing was drafted.";

/** Claude is down for the first run, then back: the walk's outage, then coming back online. */
const downOnce = (): Agent => {
  const rules = createRuleAgent();
  let down = true;
  return {
    label: "down once",
    async *run(input, signal) {
      if (down) {
        down = false;
        yield { type: "decline", text: UNREACHABLE };
        return;
      }
      yield* rules.run(input, signal);
    },
  };
};

/** Opens Maya's essay as a queue row does, with Claude down, so the draft fails. */
const failedDraft = async () => {
  const rig = await makeStoreRig({ agent: downOnce() });
  await rig.connectAll();
  const ref = rig.server.findSubmission("Maya Ortiz", "Essay 2");
  if (!ref) throw new Error("no submission");
  rig.state().setThreadUi(QUEUE, { current: ref });
  expect(await rig.clock.run(rig.state().openSubmission(QUEUE, ref))).toBeNull();
  expect(rig.state().threads[QUEUE]?.focus).toBeNull();
  return { rig, ref };
};

const focused = (rig: StoreRig) => {
  const id = rig.state().threads[QUEUE]?.focus;
  const record = id ? (rig.state().changes[id] ?? rig.state().blanks[id]) : undefined;
  if (!record) throw new Error("nothing is open");
  return record;
};
const atNow = (rig: StoreRig) => new Date(rig.state().now()).toISOString() as IsoTime;

describe("after a draft fails, the submission on screen is still the one open", () => {
  it('"Draft this one" drafts the submission on screen', async () => {
    const { rig, ref } = await failedDraft();
    await rig.clock.run(rig.state().sendToAgent(QUEUE, "Draft this one"));
    expect(focused(rig).content.target).toBe(ref);
    expect(focused(rig).activity[0]?.actor).toBe("agent");
  });

  it("drafting again opens the same submission once Claude is back", async () => {
    const { rig, ref } = await failedDraft();
    const id = await rig.clock.run(rig.state().openSubmission(QUEUE, ref));
    expect(id).not.toBeNull();
    expect(focused(rig).content.target).toBe(ref);
  });

  it("with Claude still down, the teacher grades it by hand, and it sends the same way", async () => {
    const { rig, ref } = await failedDraft();
    const id = await rig.clock.run(rig.state().openSubmission(QUEUE, ref, { manual: true }));
    if (!id) throw new Error("no form opened");
    expect(focused(rig).content.target).toBe(ref);
    expect(focused(rig).activity[0]?.actor).toBe("you");
    const form = focused(rig).content as GradeContent;
    const full = Object.fromEntries((form.rubric ?? []).map((r) => [r.criterion, r.outOf]));
    const edited = rig.state().dispatchUser(id, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", rubricPoints: full, comment: "Strong thesis." },
      at: atNow(rig),
    });
    if (!edited.ok) throw new Error(edited.error);
    const saved = rig.state().changes[id];
    if (!saved) throw new Error("the edit didn't save the grade");
    expect(
      rig
        .state()
        .dispatchUser(id, { type: "approve", witness: clickWitness(saved), at: atNow(rig) }),
    ).toMatchObject({ ok: true });
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(rig.state().changes[id]?.state.tag).toBe("sent");
    const remote = rig.server.submissions(saved.course).find((s) => s.ref === ref);
    const content = saved.content as GradeContent;
    expect(remote?.grade).toBe(form.outOf);
    expect(remote?.comments.filter((c) => c.mine).map((c) => c.text)).toEqual([content.comment]);
  });
});
