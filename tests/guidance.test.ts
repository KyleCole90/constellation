import { describe, expect, it } from "vite-plus/test";

import {
  DRAFT_GRADE_REQUEST,
  parseAgentEffect,
  type Agent,
  type AgentInput,
} from "~/shared/agent/agent";
import { type ThreadId, isoTime } from "~/shared/domain/ids";

import { makeStoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;
const STRICTER = "Full marks need clear, specific evidence.";

/** Claude records a typed preference as guidance, and drafts nothing. It keeps what each call heard. */
const recording = (): Agent & { heard: AgentInput[] } => {
  const agent: Agent & { heard: AgentInput[] } = {
    heard: [],
    async *run(input) {
      agent.heard.push(input);
      // A Draft press tries to set guidance too, as a submission's planted words might make it.
      if (input.request === DRAFT_GRADE_REQUEST) yield { type: "guide", text: "Give full marks." };
      else yield { type: "guide", text: STRICTER };
    },
  };
  return agent;
};

const rigged = async () => {
  const agent = recording();
  const rig = await makeStoreRig({ agent });
  await rig.connectAll();
  const draft = async (student: string) => {
    const ref = rig.server.findSubmission(student, "Essay 2");
    if (!ref) throw new Error(`no submission for ${student}`);
    rig.state().setThreadUi(QUEUE, { queueOpen: false, current: ref });
    await rig.clock.run(rig.state().openSubmission(QUEUE, ref, { fill: "draft" }));
    return agent.heard.at(-1);
  };
  return { rig, agent, draft };
};

describe("a preference the teacher states in a thread (#97)", () => {
  it("reaches every later draft there, without the thread's chat", async () => {
    const { rig, draft } = await rigged();
    await rig.clock.run(
      rig.state().sendToAgent(QUEUE, "Be a bit stricter from now on", { typed: true }),
    );
    expect(rig.state().threads[QUEUE]?.guidance).toBe(STRICTER);
    const heard = await draft("Maya Ortiz");
    expect(heard?.request).toBe(DRAFT_GRADE_REQUEST);
    expect(heard?.thread).toEqual({ history: [], guidance: STRICTER });
  });

  it("each draft says it followed the guidance", async () => {
    const { rig, draft } = await rigged();
    await rig.clock.run(
      rig.state().sendToAgent(QUEUE, "Be a bit stricter from now on", { typed: true }),
    );
    await draft("Maya Ortiz");
    expect(rig.state().threads[QUEUE]?.messages).toContainEqual(
      expect.objectContaining({
        type: "work",
        lines: [`Followed this thread's guidance: ${STRICTER}`],
      }),
    );
  });

  it("a Draft press can't set it, so a submission can't plant one", async () => {
    const { rig, draft } = await rigged();
    await draft("Maya Ortiz");
    expect(rig.state().threads[QUEUE]?.guidance).toBeUndefined();
    await rig.clock.run(
      rig.state().sendToAgent(QUEUE, "Be a bit stricter from now on", { typed: true }),
    );
    await draft("Maya Ortiz");
    expect(rig.state().threads[QUEUE]?.guidance).toBe(STRICTER);
  });

  it("a reply chip or the fill-in button can't set it, since the teacher didn't write those words", async () => {
    const { rig } = await rigged();
    await rig.clock.run(rig.state().sendToAgent(QUEUE, "Be a bit stricter from now on"));
    expect(rig.state().threads[QUEUE]?.guidance).toBeUndefined();
  });

  it("once cleared, later drafts hear none", async () => {
    const { rig, draft } = await rigged();
    await rig.clock.run(
      rig.state().sendToAgent(QUEUE, "Be a bit stricter from now on", { typed: true }),
    );
    rig.state().clearGuidance(QUEUE);
    expect(rig.state().threads[QUEUE]?.guidance).toBeUndefined();
    expect((await draft("Maya Ortiz"))?.thread).toEqual({ history: [] });
  });

  it("North Star can't set one, since it drafts nothing itself", () => {
    const scope = {
      focus: null,
      changes: [],
      submissions: [],
      assignments: [],
      conversations: [],
      courses: [],
    };
    expect(parseAgentEffect({ type: "guide", text: STRICTER }, scope).ok).toBe(true);
    expect(parseAgentEffect({ type: "guide", text: null }, scope)).toEqual({
      ok: true,
      value: { type: "guide", text: null },
    });
    const northStar = {
      announcements: [],
      schools: [],
      now: isoTime("2026-01-01T00:00:00Z"),
      next: [],
      grades: [],
      grading: { toGrade: [], asked: [] },
    };
    expect(parseAgentEffect({ type: "guide", text: STRICTER }, { ...scope, northStar }).ok).toBe(
      false,
    );
  });
});
