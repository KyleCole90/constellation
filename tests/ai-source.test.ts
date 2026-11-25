import { describe, expect, it } from "vite-plus/test";

import { CLAUDE_CODE_MINIMUM, olderThan } from "~/shared/claude-code";
import type { AiSource } from "~/shared/ai-source";
import { invoker, serve, type Bridge, type ClaudeCodeStatus } from "~/shared/ipc";
import { Secret } from "~/shared/providers/provider";
import { setupBlocker } from "~/renderer/components/screens/setup.logic";
import {
  claudeCodeWords,
  readingOf,
  weeklyWords,
} from "~/renderer/components/settings/claude-code.logic";
import { draftInTurn, fromQueueRows, type WorkRow } from "~/renderer/components/thread/queue.logic";
import { spendWords } from "~/renderer/components/thread/spend.logic";
import { createBridgeAgent } from "~/renderer/providers/agent";
import { selectQueueRows } from "~/renderer/stores/selectors";

import { rulesMain } from "./fixtures/rules-main";
import { STORE_TOKEN, makeStoreRig, type StoreRigOptions } from "./fixtures/store-rig";
import { threadId } from "./fixtures/ids";

const QUEUE = threadId("t-queue");
const LIMIT_REASON = "Your Claude plan's limit is reached. It resets 9:00 AM. Nothing was queued.";
const SIGNED_OUT: ClaudeCodeStatus = {
  installed: true,
  version: "2.1.323",
  tooOld: false,
  signedIn: false,
  weekly: null,
};

type Answers = Record<string, (input: unknown) => Promise<unknown>>;

const fakeMain = (answers: Answers) => {
  const told: AiSource[] = [];
  const bridge: Bridge = {
    fakes: false,
    invoke: invoker(async (channel, input) => {
      if (channel === "agent.source")
        return serve("agent.source", async ({ source }) => void told.push(source), input);
      const answer = answers[channel];
      if (!answer) throw new Error(`no answer for ${channel}`);
      return answer(input);
    }),
  };
  const agentMain: NonNullable<StoreRigOptions["agentMain"]> = {
    source: (source) => bridge.invoke("agent.source", { source }),
    claudeCode: () => bridge.invoke("claudeCode.status", undefined),
  };
  return { bridge, agentMain, told };
};

const claudeCodeRuns = (allowed: number) => {
  let runs = 0;
  const main = rulesMain({
    spend: { tokens: 1200, usd: 0 },
    before: () => (++runs > allowed ? { ok: false, reason: LIMIT_REASON, limited: true } : null),
  });
  const answers: Answers = { "agent.run": main.handle };
  return { runs: () => runs, answers, agent: main.agent };
};

describe("the Claude Code source", () => {
  it("forgets the key, turns AI on, and survives a reload", async () => {
    const main = fakeMain({});
    const rig = await makeStoreRig({ noKey: true, agentMain: main.agentMain });
    await rig.state().addAiKey(new Secret(STORE_TOKEN));
    await rig.state().chooseClaudeCode();
    expect([rig.state().aiSource, rig.state().aiOn()]).toEqual(["claude-code", true]);
    expect(await rig.vault.has("ai-key")).toBe(false);

    const reloaded = await makeStoreRig({
      noKey: true,
      storage: rig.storage,
      vault: rig.vault,
      clock: rig.clock,
      agentMain: main.agentMain,
    });
    await reloaded.clock.run(reloaded.state().boot());
    expect([reloaded.state().aiSource, reloaded.state().aiOn()]).toEqual(["claude-code", true]);
  });

  it("tells main the source on load and on every change", async () => {
    const main = fakeMain({});
    const rig = await makeStoreRig({ noKey: true, agentMain: main.agentMain });
    await rig.clock.run(rig.state().boot());
    await rig.state().chooseClaudeCode();
    await rig.state().addAiKey(new Secret(STORE_TOKEN));
    await rig.state().chooseClaudeCode();
    await rig.state().turnOffAi();
    expect(main.told).toEqual(["none", "claude-code", "key", "claude-code", "none"]);

    await rig.state().chooseClaudeCode();
    const next = fakeMain({});
    const reloaded = await makeStoreRig({
      noKey: true,
      storage: rig.storage,
      vault: rig.vault,
      clock: rig.clock,
      agentMain: next.agentMain,
    });
    expect(next.told).toEqual([]);
    await reloaded.clock.run(reloaded.state().boot());
    expect(next.told).toEqual(["claude-code"]);
  });

  it("reads no status when main doesn't answer", async () => {
    const broken = fakeMain({ "claudeCode.status": async () => ({ installed: "yes" }) });
    const rig = await makeStoreRig({ noKey: true, agentMain: broken.agentMain });
    expect(await rig.state().claudeCodeStatus()).toBeNull();
  });
});

describe("finishing setup with Claude Code", () => {
  const blockerFor = async (status: ClaudeCodeStatus) => {
    const main = fakeMain({ "claudeCode.status": async () => status });
    const rig = await makeStoreRig({ noKey: true, agentMain: main.agentMain });
    return setupBlocker({
      connected: 1,
      choice: "claude-code",
      keySaved: false,
      claudeCode: readingOf(await rig.state().claudeCodeStatus()),
      reading: "",
    });
  };

  it("waits until Claude Code reads Ready", async () => {
    const blocked = "Set up Claude Code to finish.";
    expect(await blockerFor({ installed: false, weekly: null })).toBe(blocked);
    expect(await blockerFor(SIGNED_OUT)).toBe(blocked);
    expect(
      await blockerFor({ ...SIGNED_OUT, version: "2.0.1", tooOld: true, signedIn: true }),
    ).toBe(blocked);
    expect(await blockerFor({ ...SIGNED_OUT, signedIn: true })).toBeNull();
    expect(
      setupBlocker({
        connected: 1,
        choice: "claude-code",
        keySaved: false,
        claudeCode: { kind: "checking" },
        reading: "",
      }),
    ).toBe(blocked);
  });

  it("names the version Constellation needs, comparing versions by number", () => {
    expect(claudeCodeWords(readingOf({ ...SIGNED_OUT, version: "2.1.9", tooOld: true }))).toBe(
      `Update Claude Code. You have 2.1.9, and Constellation needs ${CLAUDE_CODE_MINIMUM} or newer. Then press Check again.`,
    );
    expect(olderThan("2.1.9", "2.1.10")).toBe(true);
    expect(olderThan(CLAUDE_CODE_MINIMUM, CLAUDE_CODE_MINIMUM)).toBe(false);
  });

  it("names the weekly limit and when it resets, and nothing before the first run", () => {
    expect(weeklyWords(null)).toBeNull();
    expect(
      weeklyWords({ usedPercent: 16.4, resetsAt: new Date(2026, 10, 20, 9, 0).toISOString() }),
    ).toBe("Weekly limit: 16% used, resets Fri 9:00 AM");
  });
});

describe("a Claude Code thread", () => {
  const draftingRig = async (allowed: number) => {
    const runs = claudeCodeRuns(allowed);
    const main = fakeMain(runs.answers);
    const rig = await makeStoreRig({
      noKey: true,
      agentMain: main.agentMain,
      agent: runs.agent(createBridgeAgent(main.bridge, () => true)),
    });
    await rig.connectAll();
    await rig.state().chooseClaudeCode();
    return { rig, runs };
  };
  type Rig = Awaited<ReturnType<typeof draftingRig>>["rig"];
  const undrafted = (rig: Rig) =>
    fromQueueRows(selectQueueRows(rig.state())).filter(
      (row) => row.open && row.draftable && row.change === null,
    );
  const draft = (rig: Rig, row: WorkRow, focus = true) =>
    row.kind === "submission"
      ? rig.state().openSubmission(QUEUE, row.key, { focus, fill: "draft" })
      : Promise.resolve(null);

  it("shows tokens and no cost, while a key's thread keeps its cost", async () => {
    const { rig } = await draftingRig(1);
    const [row] = undrafted(rig);
    if (!row) throw new Error("Nothing to draft.");
    await rig.clock.run(draft(rig, row));
    const spend = rig.state().threads[QUEUE]?.spend;
    if (!spend) throw new Error("No spend reported.");
    expect(spendWords(spend)).toBe("1.2k tokens");
    expect(spendWords({ tokens: 1200, usd: 0.03 })).toBe("1.2k tokens · $0.03");
  });

  it("Draft N stops at the plan limit: drafts so far stay, the rest stay undrafted, and the thread says so once", async () => {
    const { rig, runs } = await draftingRig(2);
    const rows = undrafted(rig).slice(0, 5);
    expect(rows).toHaveLength(5);
    const done: string[] = [];
    await rig.clock.run(
      draftInTurn(
        rows,
        (row) => draft(rig, row, false),
        () => rig.state().limitHits[QUEUE] ?? 0,
        (row) => done.push(row.key),
      ),
    );
    expect(runs.runs()).toBe(3);
    expect(done).toEqual(rows.slice(0, 3).map((row) => row.key));
    const left = new Set(undrafted(rig).map((row) => row.key));
    expect(rows.map((row) => left.has(row.key))).toEqual([false, false, true, true, true]);
    const declined = rig.state().threads[QUEUE]?.messages.filter((m) => m.type === "declined");
    expect(declined?.map((m) => m.type === "declined" && m.text)).toEqual([LIMIT_REASON]);
  });
});
