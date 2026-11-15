import { describe, expect, it } from "vite-plus/test";

import { DRAFT_GRADE_REQUEST, type Agent, type AgentInput } from "~/shared/agent/agent";
import type { LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import { invoker, type Bridge } from "~/shared/ipc";
import { createBridgeAgent } from "~/renderer/providers/agent";
import {
  selectCourseWaiting,
  selectGradebook,
  selectMessageSince,
  selectQueueRows,
  selectSubmission,
  selectThreadChanges,
  selectUndrafted,
  selectWhatsDue,
} from "~/renderer/stores/selectors";

import { clickWitness } from "./fixtures/changes";
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

  it("Claude's chips don't show, so the app's resubmit button is the one way on (#81)", async () => {
    const { rig } = await declined();
    const said = rig
      .state()
      .threads[QUEUE]?.messages.find((m) => m.type === "agent" && m.text === SAID);
    expect(said).toBeDefined();
    expect(said && "replies" in said).toBe(false);
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

describe("once the message asking for a resubmit is sent (#98)", () => {
  const send = async (rig: StoreRig, ref: LmsRef<"submission">) => {
    const drafted = await message(rig, ref);
    if (!drafted) throw new Error("no message");
    rig.state().dispatchUser(drafted.id, {
      type: "approve",
      witness: clickWitness(drafted),
      at: drafted.basis.readAt,
    });
    await rig.clock.run(rig.state().sendChanges([drafted.id]));
    expect(rig.state().changes[drafted.id]?.state.tag).toBe("sent");
  };
  const rowOf = (rig: StoreRig, ref: LmsRef<"submission">) =>
    selectQueueRows(rig.state()).find((row) => row.submission.ref === ref);
  /** The submission's Gradebook cell, which must say what the grading list says. */
  const cellOf = (rig: StoreRig, ref: LmsRef<"submission">) => {
    const course = rowOf(rig, ref)?.course.ref;
    if (!course) throw new Error("no row");
    return selectGradebook(rig.state(), course)
      ?.rows.flatMap((row) => row.cells)
      .find((cell) => cell.submission?.ref === ref);
  };
  /** The grading list, the course's sidebar count and What's due, which must agree. */
  const toGrade = (rig: StoreRig, ref: LmsRef<"submission">) => {
    const course = rowOf(rig, ref)?.course.ref;
    if (!course) throw new Error("no row");
    return [
      selectQueueRows(rig.state()).filter((row) => row.course.ref === course && row.open).length,
      selectCourseWaiting(rig.state(), course).grade,
      selectWhatsDue(rig.state(), rig.clock.now())
        .flatMap((group) => group.items)
        .filter((item) => item.course.ref === course)
        .reduce((sum, item) => sum + item.toGrade, 0),
    ];
  };

  it("the row says the student was asked, and leaves every to-grade count", async () => {
    const { rig, ref } = await declined();
    const [list = 0, course = 0, due = 0] = toGrade(rig, ref);
    await send(rig, ref);
    expect(rowOf(rig, ref)).toMatchObject({ open: false, change: null });
    expect(rowOf(rig, ref)?.asked).not.toBeNull();
    expect(cellOf(rig, ref)?.asked).toBe(rowOf(rig, ref)?.asked);
    expect(toGrade(rig, ref)).toEqual([list - 1, course - 1, due - 1]);
  });

  it("the student's resubmission brings the row back to the teacher", async () => {
    const { rig, ref } = await declined();
    const before = toGrade(rig, ref);
    await send(rig, ref);
    rig.clock.advance(60_000);
    rig.server.studentResubmits(ref);
    await rig.clock.run(rig.state().syncSchool(LCC));
    expect(rowOf(rig, ref)).toMatchObject({ open: true, asked: null });
    expect(toGrade(rig, ref)).toEqual(before);
  });

  /** Another computer, or this one after a reinstall: nothing local, only what the LMS holds. */
  const freshCopy = async (rig: StoreRig) => {
    rig.store.setState({ changes: {}, undrafted: {} });
    await rig.clock.run(rig.state().syncSchool(LCC));
  };

  it("a copy with nothing local reads the asked state from the LMS (#102)", async () => {
    const { rig, ref } = await declined();
    await send(rig, ref);
    const counts = toGrade(rig, ref);
    const asked = rowOf(rig, ref)?.asked;
    await freshCopy(rig);
    expect(rowOf(rig, ref)).toMatchObject({ open: false, change: null });
    expect(rowOf(rig, ref)?.asked?.slice(0, 16)).toBe(asked?.slice(0, 16));
    expect(cellOf(rig, ref)?.asked).toBe(rowOf(rig, ref)?.asked);
    expect(toGrade(rig, ref)).toEqual(counts);
  });

  it("the message names the assignment, so the LMS can tell which work it was about", async () => {
    const { rig, ref } = await declined();
    const drafted = await message(rig, ref);
    const content = drafted?.content;
    if (content?.kind !== "message") throw new Error("no message");
    expect(`${content.subject}\n${content.body}`).toContain("Essay 2");
  });

  it("a resubmission after the message reopens the row on a fresh copy too", async () => {
    const { rig, ref } = await declined();
    const before = toGrade(rig, ref);
    await send(rig, ref);
    rig.clock.advance(60_000);
    rig.server.studentResubmits(ref);
    await freshCopy(rig);
    expect(rowOf(rig, ref)).toMatchObject({ open: true, asked: null });
    expect(cellOf(rig, ref)?.asked).toBeNull();
    expect(toGrade(rig, ref)).toEqual(before);
  });

  it("North Star sends Claude the app's to-grade count, with the asked work apart (#110)", async () => {
    const { rig, ref, agent } = await declined();
    await send(rig, ref);
    const started = rig.state().startChat("What's waiting for me to grade?");
    if (!started) throw new Error("No chat started.");
    await rig.clock.run(started.done);
    const heard = agent.heard.at(-1);
    if (!heard?.scope.northStar) throw new Error("no North Star turn");

    const sent: unknown[] = [];
    const bridge: Bridge = {
      agent: "claude",
      invoke: invoker(async (_channel, raw) => {
        sent.push(raw);
        return { ok: true, effects: [], spend: { tokens: 0, usd: 0 } };
      }),
    };
    for await (const _ of createBridgeAgent(bridge, () => true).run(
      heard,
      new AbortController().signal,
    ));
    const claude = sent[0] as {
      scope: {
        submissions: { ref: string; waiting: string }[];
        northStar: {
          grading: {
            course: string;
            toGrade: number;
            askedToResubmit: number;
          }[];
        };
      };
    };
    const course = rowOf(rig, ref)?.course.ref;
    const [list] = toGrade(rig, ref);
    expect(claude.scope.northStar.grading.find((c) => c.course === course)).toEqual({
      course,
      toGrade: list,
      askedToResubmit: 1,
    });
    expect(claude.scope.submissions.find((s) => s.ref === ref)?.waiting).toBe("asked to resubmit");
  });
});
