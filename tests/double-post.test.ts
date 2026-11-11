import { describe, expect, it } from "vite-plus/test";

import type { LmsError } from "~/domain/change";
import type { ChangeId } from "~/domain/ids";
import type { Submission } from "~/domain/lms";
import { DEFAULT_RETRY_POLICY, createWriteback } from "~/writeback/writeback";

import { clickWitness } from "./fixtures/changes";
import { LCC, makeRig, type Rig } from "./fixtures/rig";

const myComments = (rig: Rig, submission: Submission) =>
  rig.lmsSubmission(submission).comments.filter((comment) => comment.mine);
const iso = (rig: Rig) => new Date(rig.clock.now()).toISOString() as never;

const reapprove = (rig: Rig, id: ChangeId) => {
  const record = rig.ledger.get(id);
  if (!record) throw new Error("No change.");
  rig.ledger.commit(id, { type: "approve", witness: clickWitness(record), at: iso(rig) });
};

const resolveKeepingMine = async (rig: Rig, id: ChangeId) => {
  const record = rig.ledger.get(id);
  if (!record || record.state.tag !== "conflicted")
    throw new Error(`Expected a conflict, got ${record?.state.tag}.`);
  const remote = await rig.clock.run(rig.provider(LCC).observe(record.content));
  if (!remote.ok) throw new Error(remote.error.kind);
  const choices = Object.fromEntries(
    record.state.conflicts.map((conflict) => [conflict.field, "keep-mine"]),
  );
  const resolved = rig.ledger.commit(id, {
    type: "resolve-conflict",
    choices,
    remote: remote.value,
    at: iso(rig),
  });
  if (!resolved.ok) throw new Error(resolved.error);
};

describe("a write the app lost track of is never posted a second time", () => {
  it("a conflict found while resuming keeps what that read saw landed", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.lateLanding(60_000);
    const writeback = rig.newWriteback();
    await rig.clock.run(writeback.send([id]));
    await rig.clock.flush();
    rig.server.changeGradeOutOfBand(submission.ref, 1, "A TA");

    await rig.clock.run(writeback.send([id]));
    expect(rig.stateOf(id).tag).toBe("conflicted");
    await resolveKeepingMine(rig, id);
    reapprove(rig, id);
    await rig.clock.run(writeback.send([id]));

    expect(rig.stateOf(id).tag).toBe("sent");
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("revoking and re-approving after a crash finds the write that landed meanwhile", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.lateLanding(60_000);
    rig.ledger.armCrash({ atCommit: 2, when: "before-durable" });
    await rig.clock.run(
      rig
        .newWriteback()
        .send([id])
        .catch(() => undefined),
    );
    rig.ledger.armCrash(null);

    const writeback = rig.reload();
    await rig.clock.run(writeback.recover());
    expect(rig.stateOf(id).tag).toBe("held");
    expect(rig.ledger.commit(id, { type: "revoke", at: iso(rig) }).ok).toBe(true);
    await rig.clock.flush();
    reapprove(rig, id);
    await rig.clock.run(writeback.send([id]));

    expect(rig.stateOf(id).tag).toBe("sent");
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("an edit after a crash stops at a conflict instead of adding a second comment", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.lateLanding(60_000);
    rig.ledger.armCrash({ atCommit: 2, when: "before-durable" });
    await rig.clock.run(
      rig
        .newWriteback()
        .send([id])
        .catch(() => undefined),
    );
    rig.ledger.armCrash(null);

    const writeback = rig.reload();
    await rig.clock.run(writeback.recover());
    expect(
      rig.ledger.commit(id, {
        type: "edit",
        by: "you",
        patch: { kind: "grade", comment: "Different words." },
        at: iso(rig),
      }).ok,
    ).toBe(true);
    await rig.clock.flush();
    reapprove(rig, id);
    await rig.clock.run(writeback.send([id]));

    expect(rig.stateOf(id).tag).toBe("conflicted");
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("a new draft after discarding an unconfirmed send doesn't repost what landed", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.lateLanding(60_000);
    const writeback = rig.newWriteback();
    await rig.clock.run(writeback.send([id]));
    expect(rig.ledger.commit(id, { type: "discard", at: iso(rig) }).ok).toBe(true);
    await rig.clock.flush();

    const next = await rig.draft(LCC, rig.contentFor(submission));
    rig.approve(next.id);
    await rig.clock.run(writeback.send([next.id]));

    expect(rig.stateOf(next.id).tag).toBe("sent");
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("once a later send settles the target, the discarded one stops counting", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.failNextWrite("grade", { kind: "rejected", reason: "Locked." });
    const writeback = rig.newWriteback();
    await rig.clock.run(writeback.send([id]));
    rig.ledger.commit(id, { type: "discard", at: iso(rig) });

    const second = await rig.draft(LCC, rig.contentFor(submission, "First comment."));
    rig.approve(second.id);
    await rig.clock.run(writeback.send([second.id]));
    expect(rig.stateOf(second.id).tag).toBe("sent");
    rig.clock.advance(1000);

    const third = await rig.draft(LCC, rig.contentFor(submission, "Second comment."));
    rig.approve(third.id);
    await rig.clock.run(writeback.send([third.id]));

    expect(rig.stateOf(third.id).tag).toBe("sent");
    expect(myComments(rig, submission).map((comment) => comment.text)).toEqual(
      expect.arrayContaining(["First comment.", "Second comment."]),
    );
  });
});

describe("errors a retry can't fix", () => {
  const failing = async (error: LmsError) => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    const inner = rig.provider(LCC);
    const writeback = createWriteback({
      ledger: rig.ledger,
      providerFor: () => ({
        ...inner,
        apply: async (permit) =>
          Object.fromEntries(permit.fields.map((field) => [field, { status: "failed", error }])),
      }),
      markExpired: () => undefined,
      now: rig.clock.now,
      sleep: rig.clock.sleep,
      random: () => 0.5,
      policy: DEFAULT_RETRY_POLICY,
      locks: null,
    });
    await rig.clock.run(writeback.send([id]));
    return rig.stateOf(id);
  };

  it("an unsupported field asks for an edit, not a retry", async () => {
    const state = await failing({ kind: "unsupported", capability: "rubric scores" });
    expect(state).toMatchObject({
      tag: "held",
      cause: { tag: "rejected", reason: "This school's LMS does not support rubric scores." },
    });
  });

  it("a target that is gone asks for an edit, not a retry", async () => {
    const state = await failing({ kind: "not_found" });
    expect(state).toMatchObject({ tag: "held", cause: { tag: "rejected" } });
  });
});

describe("a retry delay", () => {
  it("says why nothing is moving", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    rig.server.failNextWrite("grade", { kind: "unavailable", status: 503 });
    const waits: number[] = [];
    const commit = rig.ledger.commit.bind(rig.ledger);
    rig.ledger.commit = (change, event) => {
      if (event.type === "wait") waits.push(event.until);
      return commit(change, event);
    };
    await rig.clock.run(rig.newWriteback().send([id]));
    expect(rig.stateOf(id).tag).toBe("sent");
    expect(waits.length).toBeGreaterThan(0);
  });
});
