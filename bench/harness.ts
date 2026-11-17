import {
  DRAFT_GRADE_REQUEST,
  describeViolation,
  runAgent,
  type AgentScope,
} from "~/shared/agent/agent";
import { newChangeRecord, type ChangeRecord } from "~/shared/domain/change";
import { type ChangeId, isoTime } from "~/shared/domain/ids";
import { invoker, serve, type Handlers } from "~/shared/ipc";
import { createBridgeAgent } from "~/renderer/providers/agent";

import type { Fixture } from "./class";
import type { Call, Draft, Run } from "./metrics";
import type { BenchSource, Env } from "./sources";

const AT = isoTime("2026-11-03T16:00:00Z");

/**
 * One fixture through the path a teacher's "Draft N" takes: the renderer's bridge agent, main's input check and
 * handler, then `runAgent`'s parse. A propose files a draft into scope, as the store does, so the annotates after it
 * parse against it. Wall time is the handler's alone, the part a source can change.
 */
const draftOne = async (run: Handlers["agent.run"], fixture: Fixture) => {
  const changes: ChangeRecord[] = [];
  const scope: AgentScope = {
    focus: null,
    get changes() {
      return changes;
    },
    submissions: [fixture.submission],
    assignments: [fixture.assignment],
    courses: [fixture.course],
    conversations: [],
  };
  let wallMs = 0;
  const agent = createBridgeAgent(
    {
      fakes: false,
      invoke: invoker(async (channel, input) => {
        if (channel !== "agent.run") throw new Error(`The benchmark only drafts, not ${channel}`);
        const started = performance.now();
        try {
          return await serve(channel, run, input);
        } finally {
          wallMs = performance.now() - started;
        }
      }),
    },
    () => true,
  );
  const problems: string[] = [];
  let graded = false;
  let declined: string | null = null;
  await runAgent(
    agent,
    { request: DRAFT_GRADE_REQUEST, thread: { history: [] }, scope, files: fixture.files },
    {
      effect: (effect) => {
        if (effect.type === "decline") declined = effect.text;
        if (effect.type !== "propose" || effect.content.kind !== "grade") return;
        graded = true;
        changes.push(
          newChangeRecord({
            id: `bench-${fixture.id}` as ChangeId,
            school: effect.school,
            course: effect.course,
            subject: effect.subject,
            content: effect.content,
            basis: {
              readAt: AT,
              remote: {
                kind: "grade",
                targetVersion: "attempt:1",
                grade: null,
                rubric: null,
                excused: false,
                comments: [],
                attachments: [],
              },
            },
            at: AT,
            by: "agent",
          }),
        );
      },
      refuse: (violation, effect) =>
        problems.push(`${effect ?? "run"}: ${describeViolation(violation)}`),
    },
    new AbortController().signal,
  );
  if (declined !== null) problems.push(`declined: ${declined}`);
  else if (!graded) problems.push("no grade proposed");
  return { wallMs, valid: problems.length === 0, problems };
};

/** One source's pass over the class, one draft at a time, as "Draft N" runs them. */
export const benchmark = async (
  source: BenchSource,
  env: Env,
  fixtures: readonly Fixture[],
  onDraft: (draft: Draft, index: number) => void = () => {},
): Promise<Run> => {
  let calls: Call[] = [];
  let modelMs = 0;
  const opened = await source.open(env, {
    request: (made, ms) => {
      calls.push(...made);
      modelMs += ms;
    },
  });
  const before = await opened.weeklyUsed();
  const drafts: Draft[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    calls = [];
    modelMs = 0;
    const outcome = await draftOne(opened.run, fixture);
    const draft: Draft = { fixture: fixture.id, kind: fixture.kind, calls, modelMs, ...outcome };
    drafts.push(draft);
    onDraft(draft, index);
  }
  return {
    source: source.id,
    model: source.model,
    claudeCodeVersion: opened.claudeCodeVersion,
    overheadLimitMs: source.overheadLimitMs,
    minValidPercent: source.minValidPercent,
    weekly: { before, after: await opened.weeklyUsed() },
    drafts,
  };
};
