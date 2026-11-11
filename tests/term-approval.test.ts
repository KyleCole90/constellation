import { describe, expect, it } from "vite-plus/test";

import { ApprovalWitness, fingerprintOf, type RiskKey } from "~/shared/domain/approval";
import { fieldText, riskOf, summarize, transition } from "~/shared/domain/change";
import type { IsoTime } from "~/shared/domain/ids";
import { copyMigration } from "~/shared/domain/setup";
import { FALL_2026 } from "~/shared/providers/fake-canvas/seed-term";

import { clickWitness } from "./fixtures/changes";
import { LCC, RSU } from "./fixtures/rig";
import { copyContent, makeTermRig, planFor, termOf } from "./fixtures/term";

const at = (rig: { clock: { now(): number } }): IsoTime =>
  new Date(rig.clock.now()).toISOString() as IsoTime;

/** A copy into the one seeded course that already has people and content in it. */
const riskyCopy = async () => {
  const rig = await makeTermRig();
  const shell = await rig.shellNamed(RSU, "HUM 150");
  const source = await rig.sourceNamed(RSU, "HUM 150", "Fall 2026");
  const draft = await rig.draft(RSU, copyContent(shell, source));
  return { rig, shell, source, draft };
};

/** A copy into an empty new course, which needs only the plain click. */
const plainCopy = async () => {
  const rig = await makeTermRig();
  const shell = await rig.shellNamed(LCC, "ENG 101");
  const source = await rig.sourceNamed(LCC, "ENG 101", "Fall 2026");
  const draft = await rig.draft(LCC, copyContent(shell, source));
  return { rig, shell, source, draft };
};

/** Two text fixes on the same syllabus, in different paragraphs. */
const twoFixes = async () => {
  const rig = await makeTermRig();
  const shell = await rig.shellNamed(LCC, "ENG 101");
  const source = await rig.sourceNamed(LCC, "ENG 101", "Fall 2026");
  const { findings } = await rig.scan(LCC, source.ref, planFor(termOf(source), shell));
  const termFix = rig.fixOf(findings, "old-term-name");
  const contactFix = rig.fixOf(findings, "foreign-contact");
  expect(termFix.target).toBe(contactFix.target);
  return { rig, termFix, contactFix };
};

describe("approving a risky copy", () => {
  it("is refused with a plain click, because the destination has students and items", async () => {
    const { rig, draft } = await riskyCopy();
    expect(riskOf(draft)).toBe("students:14|items:3");
    const result = transition(draft, {
      type: "approve",
      witness: clickWitness(draft),
      at: at(rig),
    });
    expect(result).toEqual({ ok: false, error: "needs-confirmation" });
  });

  it("is refused when the acknowledged risk is not the one the basis shows", async () => {
    const { rig, draft } = await riskyCopy();
    const witness = ApprovalWitness.fromClick({ isTrusted: true, type: "click" }, [
      {
        changeId: draft.id,
        fingerprint: fingerprintOf(draft),
        risk: "students:1|items:0" as RiskKey,
      },
    ]);
    expect(witness).not.toBeNull();
    if (!witness) return;
    expect(transition(draft, { type: "approve", witness, at: at(rig) })).toEqual({
      ok: false,
      error: "needs-confirmation",
    });
  });

  it("goes through when the click acknowledges the exact risk, and the approval says it was guarded", async () => {
    const { rig, draft } = await riskyCopy();
    const risk = riskOf(draft);
    if (risk === null) throw new Error("expected a risk");
    const witness = ApprovalWitness.fromClick({ isTrusted: true, type: "click" }, [
      { changeId: draft.id, fingerprint: fingerprintOf(draft), risk },
    ]);
    if (!witness) throw new Error("expected a witness");
    const result = transition(draft, { type: "approve", witness, at: at(rig) });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.state.tag === "approved")
      expect(result.value.state.approval.via).toBe("guarded-button");
  });

  it("cannot ride in a batch", async () => {
    const { draft: risky } = await riskyCopy();
    const { draft: plain } = await plainCopy();
    const risk = riskOf(risky);
    if (risk === null) throw new Error("expected a risk");
    const targets = [
      { changeId: risky.id, fingerprint: fingerprintOf(risky), risk },
      { changeId: plain.id, fingerprint: fingerprintOf(plain) },
    ];
    expect(ApprovalWitness.fromClick({ isTrusted: true, type: "click" }, targets)).toBeNull();
  });

  it("mints nothing from a click that is not trusted", async () => {
    const { draft } = await riskyCopy();
    const risk = riskOf(draft);
    if (risk === null) throw new Error("expected a risk");
    expect(
      ApprovalWitness.fromClick({ isTrusted: false, type: "click" }, [
        { changeId: draft.id, fingerprint: fingerprintOf(draft), risk },
      ]),
    ).toBeNull();
    expect(
      ApprovalWitness.fromClick({ isTrusted: true, type: "keydown" }, [
        { changeId: draft.id, fingerprint: fingerprintOf(draft), risk },
      ]),
    ).toBeNull();
  });
});

describe("an approved fix that is edited", () => {
  it("goes back to draft, and the runner then sends nothing", async () => {
    const { rig, termFix } = await twoFixes();
    const draft = await rig.draft(LCC, termFix);
    rig.approve(draft.id);
    const edited = rig.ledger.commit(draft.id, {
      type: "edit",
      by: "you",
      patch: { kind: "text-fix", after: "Spring 2027 (section 3)" },
      at: at(rig),
    });
    expect(edited.ok).toBe(true);
    expect(rig.stateOf(draft.id)).toEqual({ tag: "draft", approvalReset: "edited" });
    await rig.send([draft.id]);
    expect(rig.stateOf(draft.id).tag).toBe("draft");
    expect(rig.writes).toEqual([]);
  });

  it("goes back to draft when the agent edits it, and says so", async () => {
    const { rig, termFix } = await twoFixes();
    const draft = await rig.draft(LCC, termFix);
    rig.approve(draft.id);
    rig.ledger.commit(draft.id, {
      type: "edit",
      by: "agent",
      patch: { kind: "text-fix", after: "Spring 2027 term" },
      at: at(rig),
    });
    expect(rig.stateOf(draft.id)).toEqual({ tag: "draft", approvalReset: "agent-edited" });
  });
});

describe("sending a copy through the real runner", () => {
  it("writes nothing without an approval", async () => {
    const { rig, draft, shell } = await plainCopy();
    await rig.send([draft.id]);
    expect(rig.stateOf(draft.id).tag).toBe("draft");
    expect(rig.writes).toEqual([]);
    expect(await rig.migrations(LCC, shell.ref)).toEqual([]);
  });

  it("ends conflicted with nothing written when the destination fills up after the approval", async () => {
    const { rig, draft, shell } = await plainCopy();
    rig.approve(draft.id);
    rig.server.enrollStudents(shell.ref, 3);
    await rig.send([draft.id]);
    const state = rig.stateOf(draft.id);
    expect(state.tag).toBe("conflicted");
    if (state.tag === "conflicted")
      expect(state.conflicts.map((conflict) => conflict.reason)).toEqual(["target-changed"]);
    expect(rig.writes).toEqual([]);
    expect(await rig.migrations(LCC, shell.ref)).toEqual([]);
  });

  it("creates exactly one job when the response is lost, and the retry reads its own job as done", async () => {
    const { rig, draft, shell } = await plainCopy();
    rig.approve(draft.id);
    rig.server.loseNextResponse();
    await rig.send([draft.id]);
    if (rig.stateOf(draft.id).tag !== "sent") await rig.send([draft.id]);
    expect(rig.stateOf(draft.id).tag).toBe("sent");
    expect(rig.server.log.filter((entry) => entry.kind === "write")).toHaveLength(1);
    expect(await rig.migrations(LCC, shell.ref)).toHaveLength(1);
  });

  it("leaves the change sent when the job then fails, and a new draft does not take the failed job for its own", async () => {
    const { rig, draft, shell, source } = await plainCopy();
    rig.approve(draft.id);
    rig.server.failNextMigration("running", "The source course could not be read.");
    await rig.send([draft.id]);
    expect(rig.stateOf(draft.id).tag).toBe("sent");
    const jobs = await rig.finishJobs(LCC, shell.ref);
    expect(jobs.map((job) => job.state)).toEqual(["failed"]);
    expect(jobs[0]?.message).toBe("The source course could not be read.");
    const signature = fieldText(draft.content, "copy");
    expect(copyMigration(rig.record(draft.id), signature, jobs)?.state).toBe("failed");

    const retry = await rig.draft(LCC, copyContent(shell, source));
    expect(copyMigration(retry, signature, jobs)).toBeNull();
    rig.approve(retry.id);
    await rig.send([retry.id]);
    expect(rig.stateOf(retry.id).tag).toBe("sent");
    const after = await rig.finishJobs(LCC, shell.ref);
    expect(after).toHaveLength(2);
    expect(copyMigration(rig.record(retry.id), signature, after)?.ref).toBe(after[1]?.ref);
    expect((await rig.content(LCC, shell.ref)).items.length).toBeGreaterThan(0);
  });
});

describe("a passage fix", () => {
  it("stays approved and lands after a neighbor's fix landed in the same item", async () => {
    const { rig, termFix, contactFix } = await twoFixes();
    const first = await rig.draft(LCC, termFix);
    const second = await rig.draft(LCC, contactFix);
    rig.approve(first.id);
    rig.approve(second.id);
    await rig.send([first.id]);
    expect(rig.stateOf(first.id).tag).toBe("sent");
    await rig.send([second.id]);
    expect(rig.stateOf(second.id).tag).toBe("sent");
    const remote = await rig.provider(LCC).observe(contactFix);
    if (!remote.ok || remote.value.kind !== "text-fix") throw new Error("expected the item");
    expect(remote.value.body).toContain(contactFix.splice.after);
    expect(remote.value.body).toContain(termFix.splice.after);
  });

  it("conflicts with nothing written when its passage moved, and asks for a fresh scan", async () => {
    const { rig, termFix } = await twoFixes();
    const draft = await rig.draft(LCC, termFix);
    rig.approve(draft.id);
    // Someone rewrites the same passage in the LMS before the send.
    rig.server.applyFields({ ...termFix, splice: { ...termFix.splice, after: "Autumn 2026" } }, [
      "text",
    ]);
    const before = await rig.provider(LCC).observe(termFix);
    await rig.send([draft.id]);
    const state = rig.stateOf(draft.id);
    expect(state.tag).toBe("conflicted");
    if (state.tag === "conflicted")
      expect(state.conflicts.map((conflict) => conflict.reason)).toEqual(["passage-moved"]);
    expect(summarize(rig.record(draft.id)).recovery).toBe("rescan");
    expect(rig.writes).toEqual([]);
    expect(await rig.provider(LCC).observe(termFix)).toEqual(before);
  });

  it("a retry of a landed fix reads already-there and writes nothing more", async () => {
    const { rig, termFix } = await twoFixes();
    const draft = await rig.draft(LCC, termFix);
    rig.approve(draft.id);
    rig.server.loseNextResponse();
    await rig.send([draft.id]);
    if (rig.stateOf(draft.id).tag !== "sent") await rig.send([draft.id]);
    expect(rig.stateOf(draft.id).tag).toBe("sent");
    expect(rig.server.log.filter((entry) => entry.kind === "write")).toHaveLength(1);
  });
});

describe("the planned dates", () => {
  it("name the seeded Fall term the copy sources carry", async () => {
    const rig = await makeTermRig();
    const source = await rig.sourceNamed(LCC, "ENG 101", "Fall 2026");
    expect(termOf(source)).toEqual(FALL_2026([2, 4]));
  });
});
