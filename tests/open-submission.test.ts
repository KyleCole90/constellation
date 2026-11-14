import { describe, expect, it } from "vite-plus/test";

import { FILL_GRADE_REQUEST, type Agent } from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import type { IsoTime, LmsRef, ThreadId } from "~/shared/domain/ids";

import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;

const spyAgent = () => {
  const inner = createRuleAgent();
  const runs: string[] = [];
  const agent: Agent = {
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

  it("Draft with Claude from an untouched hand form drafts once and replaces the form (#59)", async () => {
    const { rig, ref, runs } = await maya();
    const form = await open(rig, ref, "by-hand");
    if (!form) throw new Error("no form opened");

    const id = await open(rig, ref, "draft");
    expect(runs).toHaveLength(1);
    expect(id).not.toBeNull();
    expect(id).not.toBe(form);
    expect(rig.state().threads[QUEUE]?.focus).toBe(id);
    expect(rig.state().blanks).toEqual({});
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

describe("Draft with Claude on a hand form the teacher has typed into (#66)", () => {
  it("fills in only what is blank and keeps what the teacher entered", async () => {
    const { rig, ref, runs } = await maya();
    const form = await open(rig, ref, "by-hand");
    if (!form) throw new Error("no form opened");
    const first = rig.state().blanks[form];
    const content = first?.content.kind === "grade" ? first.content : null;
    const [typed, ...rest] = content?.rubric ?? [];
    if (!typed || rest.length === 0) throw new Error("no rubric");
    const edited = rig.state().dispatchUser(form, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", rubricPoints: { [typed.criterion]: 3 } },
      at: atNow(rig),
    });
    expect(edited.ok).toBe(true);

    await rig.clock.run(rig.state().sendToAgent(QUEUE, FILL_GRADE_REQUEST));

    expect(runs).toEqual([FILL_GRADE_REQUEST]);
    const after = rig.state().changes[form]?.content;
    if (after?.kind !== "grade") throw new Error("no grade");
    expect(after.rubric?.find((score) => score.criterion === typed.criterion)?.points).toBe(3);
    expect(after.rubric?.every((score) => score.points !== null)).toBe(true);
    expect(after.comment).toMatch(/\S/);
    expect(rig.state().threads[QUEUE]?.focus).toBe(form);
  });

  it("keeps a comment the teacher wrote", async () => {
    const { rig, ref } = await maya();
    const form = await open(rig, ref, "by-hand");
    if (!form) throw new Error("no form opened");
    rig.state().dispatchUser(form, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", comment: "My own words." },
      at: atNow(rig),
    });
    await rig.clock.run(rig.state().sendToAgent(QUEUE, FILL_GRADE_REQUEST));
    const after = rig.state().changes[form]?.content;
    expect(after?.kind === "grade" && after.comment).toBe("My own words.");
    expect(after?.kind === "grade" && after.rubric?.every((s) => s.points !== null)).toBe(true);
  });

  it("keeps what the teacher entered even when Claude's edit tries to overwrite it", async () => {
    const overwrite: Agent = {
      async *run({ scope }) {
        const change = scope.changes.find((c) => c.id === scope.focus);
        if (change?.content.kind !== "grade") return;
        const rubricPoints = Object.fromEntries(
          (change.content.rubric ?? []).map((score) => [score.criterion, 1]),
        );
        yield {
          type: "edit",
          change: change.id,
          patch: { kind: "grade", rubricPoints, comment: "Claude's words.", excused: true },
          why: "Filled in what was blank.",
        };
      },
    };
    const rig = await makeStoreRig({ agent: overwrite });
    await rig.connectAll();
    const ref = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    if (!ref) throw new Error("no submission");
    const form = await open(rig, ref, "by-hand");
    if (!form) throw new Error("no form opened");
    const first = rig.state().blanks[form];
    const [typed] = first?.content.kind === "grade" ? (first.content.rubric ?? []) : [];
    if (!typed) throw new Error("no rubric");
    rig.state().dispatchUser(form, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", rubricPoints: { [typed.criterion]: 3 }, comment: "My own words." },
      at: atNow(rig),
    });

    await rig.clock.run(rig.state().sendToAgent(QUEUE, FILL_GRADE_REQUEST));

    const after = rig.state().changes[form]?.content;
    if (after?.kind !== "grade") throw new Error("no grade");
    expect(after.rubric?.find((score) => score.criterion === typed.criterion)?.points).toBe(3);
    const others = after.rubric?.filter((score) => score.criterion !== typed.criterion) ?? [];
    expect(others.length > 0 && others.every((score) => score.points === 1)).toBe(true);
    expect(after.comment).toBe("My own words.");
    expect(after.excused).toBe(false);
  });
});
