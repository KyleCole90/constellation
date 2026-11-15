import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { MODEL } from "~/main/agent";
import { claudeCodeAgent } from "~/main/providers/claude-code";
import { CLAUDE_CODE_MINIMUM } from "~/shared/claude-code";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const INPUT = { request: "Make it warmer.", history: [], scope: { focus: null }, files: [] };
const RESETS_AT = 1_795_000_000;

const init = (extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "init",
  tools: ["StructuredOutput"],
  mcp_servers: [],
  slash_commands: [],
  claude_code_version: "2.1.325",
  apiKeySource: "none",
  ...extra,
});
const result = (extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  stop_reason: "tool_use",
  total_cost_usd: 0.42,
  duration_ms: 4200,
  duration_api_ms: 4000,
  modelUsage: {
    [MODEL]: {
      inputTokens: 900,
      outputTokens: 300,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 100,
    },
  },
  structured_output: { effects: [{ type: "say", text: "Done." }] },
  ...extra,
});
const rateLimit = (info: Record<string, unknown>) => ({
  type: "rate_limit_event",
  rate_limit_info: info,
});

interface Run {
  pid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  cwdEntries: string[];
  stdin: string;
  started: number;
}

let dir = "";
let tmpRoot = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-test-"));
  tmpRoot = mkdtempSync(join(tmpdir(), "cc-runs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A Claude Code whose `claude` is the fake, replaying this scenario. */
const claude = (scenario: Record<string, unknown>, options: Record<string, unknown> = {}) => {
  const file = join(dir, "scenario.json");
  const record = join(dir, "runs.jsonl");
  writeFileSync(file, JSON.stringify({ record, ...scenario }));
  const usage: unknown[] = [];
  const agent = claudeCodeAgent({
    locate: async () => FAKE,
    env: {
      ...process.env,
      FAKE_CLAUDE: file,
      ANTHROPIC_API_KEY: "sk-ant-must-not-reach-claude",
      ANTHROPIC_AUTH_TOKEN: "token-must-not-reach-claude",
      ANTHROPIC_BASE_URL: "https://proxy.invalid",
    },
    tmpRoot,
    onUsage: (calls, modelMs) => usage.push({ calls, modelMs }),
    ...options,
  });
  const lines = () =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line))
      : [];
  const runs = () => lines().filter((line): line is Run => Reflect.has(Object(line), "argv"));
  const ended = () =>
    lines().flatMap((line) => {
      const at: unknown = Reflect.get(Object(line), "ended");
      return typeof at === "number" ? [at] : [];
    });
  return { agent, runs, ended, usage };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ok = { lines: [init(), result()] };

describe("a Claude Code run", () => {
  it("runs the teacher's claude with every tool, MCP server, setting source and slash command off", async () => {
    const { agent, runs } = claude(ok);
    await agent.run(INPUT);
    const [run] = runs();
    expect(run?.argv).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-opus-5-5",
      "--effort",
      "medium",
      "--system-prompt",
      expect.stringContaining("Return every item in `effects`"),
      "--json-schema",
      expect.any(String),
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
    ]);
    expect(run?.argv).not.toContain("--bare");
    expect(run?.argv).not.toContain("--mcp-config");
    expect(run?.argv.join(" ")).not.toContain("You act only by calling tools");
  });

  it("asks for every effect at once, one of the tools each, with the tool's name as its type", async () => {
    const { agent, runs } = claude(ok);
    await agent.run(INPUT);
    const argv = runs()[0]?.argv ?? [];
    const schema: unknown = JSON.parse(argv[argv.indexOf("--json-schema") + 1] ?? "null");
    expect(schema).toMatchObject({ type: "object", required: ["effects"] });
    const items: { properties: { type: { const: string } }; required: string[] }[] = Reflect.get(
      Reflect.get(Reflect.get(Object(schema), "properties"), "effects"),
      "items",
    ).oneOf;
    expect(items.map((item) => item.properties.type.const)).toEqual([
      "say",
      "decline",
      "guide",
      "work",
      "propose",
      "edit",
      "annotate",
      "finding",
      "handoff",
    ]);
    for (const item of items) expect(item.required).toContain("type");
  });

  it("pays with the teacher's subscription: no API key, token or base URL, and no background traffic", async () => {
    const { agent, runs } = claude(ok);
    await agent.run(INPUT);
    const env = runs()[0]?.env ?? {};
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
    expect(env["HOME"]).toBe(process.env["HOME"]);
  });

  it("runs in a fresh, empty folder, removed afterwards", async () => {
    const { agent, runs } = claude(ok);
    await agent.run(INPUT);
    await agent.run(INPUT);
    const [first, second] = runs();
    expect(first?.cwdEntries).toEqual([]);
    expect(first?.cwd).not.toBe(second?.cwd);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("hands over one user message: the files first, then the prompt", async () => {
    const { agent, runs } = claude(ok);
    const pdf = new TextEncoder().encode("%PDF-1.4");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await agent.run({
      ...INPUT,
      files: [
        { name: "essay.pdf", mediaType: "application/pdf", data: pdf },
        { name: "notes.png", mediaType: "image/png", data: png },
        { name: "RR5.docx", mediaType: "text/markdown", data: new TextEncoder().encode("# Notes") },
      ],
    });
    const lines = (runs()[0]?.stdin ?? "").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: Buffer.from(pdf).toString("base64"),
            },
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: Buffer.from(png).toString("base64"),
            },
          },
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: "# Notes" },
            title: "RR5.docx",
          },
          { type: "text", text: expect.stringContaining("<request>\nMake it warmer.\n</request>") },
        ],
      },
    });
  });

  it("hands back the structured output's effects raw, dropping what is no tool, with tokens and no dollars", async () => {
    const effects = [
      { type: "work", line: "Read the submission" },
      { type: "approve", change: "c1" },
      { type: "spend", tokens: 0, usd: 0 },
      "not an effect",
      { type: "say", text: "Here you go." },
    ];
    const { agent, usage } = claude({
      lines: [init(), result({ structured_output: { effects } })],
    });
    expect(await agent.run(INPUT)).toEqual({
      ok: true,
      effects: [
        { type: "work", line: "Read the submission" },
        { type: "say", text: "Here you go." },
      ],
      spend: { tokens: 6300, usd: 0 },
    });
    expect(usage).toEqual([
      {
        calls: [
          {
            model: MODEL,
            usage: { input: 900, cacheWrite: 100, cacheRead: 5000, output: 300 },
          },
        ],
        modelMs: 4000,
      },
    ]);
  });

  it("drafts nothing from bytes main never read, without starting claude", async () => {
    const { agent, runs } = claude(ok);
    const answer = await agent.run({
      ...INPUT,
      files: [{ name: "rr5.docx", mediaType: "application/rtf", data: new Uint8Array(8) }],
    });
    expect(!answer.ok && answer.reason).toContain("Nothing was drafted.");
    expect(runs()).toEqual([]);
  });

  it("runs two overlapping asks one after the other", async () => {
    const { agent, runs, ended } = claude({ ...ok, delayMs: 300 });
    const answers = await Promise.all([agent.run(INPUT), agent.run(INPUT)]);
    expect(answers.map((answer) => answer.ok)).toEqual([true, true]);
    const [first, second] = runs();
    expect(second?.started).toBeGreaterThanOrEqual(ended()[0] ?? Infinity);
    expect(first?.pid).not.toBe(second?.pid);
  });
});

const UNUSABLE =
  "Claude Code answered in a way Constellation can't use, so nothing was drafted. Ask again.";

describe("a run Constellation refuses", () => {
  it.each([
    ["a tool besides StructuredOutput", { tools: ["StructuredOutput", "Bash"] }],
    ["no StructuredOutput", { tools: [] }],
    ["an MCP server", { mcp_servers: [{ name: "files", status: "connected" }] }],
    ["a slash command", { slash_commands: ["review"] }],
  ])("stops claude and drafts nothing when init lists %s", async (_what, extra) => {
    const { agent, runs } = claude({ lines: [init(extra)], hang: true }, { timeoutMs: 20_000 });
    expect(await agent.run(INPUT)).toEqual({ ok: false, reason: UNUSABLE });
    expect(alive(runs()[0]?.pid ?? 0)).toBe(false);
  });
});

describe("what a teacher reads when a run fails", () => {
  it("with no claude to find, says it isn't installed", async () => {
    const agent = claudeCodeAgent({ locate: async () => null, tmpRoot });
    expect(await agent.run(INPUT)).toEqual({
      ok: false,
      reason:
        "Claude Code isn't installed on this Mac. Install it, or switch to an API key in Settings.",
    });
  });

  it("when the claude it found is gone, looks again, and runs the one it finds", async () => {
    const found = ["/nowhere/claude", FAKE];
    const { agent } = claude(ok, { locate: async () => found.shift() ?? null });
    expect(await agent.run(INPUT)).toMatchObject({ ok: true });
  });

  it("when claude is gone and can't be found again, says it isn't installed", async () => {
    const { agent } = claude(ok, { locate: async () => "/nowhere/claude" });
    expect(await agent.run(INPUT)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("isn't installed"),
    });
  });

  it("names the version a too-old claude reports at start and the one Constellation needs", async () => {
    const { agent } = claude({ lines: [init({ claude_code_version: "2.1.9" })], hang: true });
    expect(await agent.run(INPUT)).toEqual({
      ok: false,
      reason: `Update Claude Code (you have 2.1.9, Constellation needs ${CLAUDE_CODE_MINIMUM}), then ask again.`,
    });
  });

  it("asks a claude that dies before it starts for its version, to explain", async () => {
    const { agent } = claude({ exitAtOnce: 1, version: "2.0.1" });
    expect(await agent.run(INPUT)).toMatchObject({
      reason: expect.stringContaining("you have 2.0.1"),
    });
  });

  it("a current claude that dies before it starts is unusable", async () => {
    const { agent } = claude({ exitAtOnce: 1 });
    expect(await agent.run(INPUT)).toEqual({ ok: false, reason: UNUSABLE });
  });

  it("signed out, says to sign in from Terminal", async () => {
    const { agent } = claude({
      lines: [
        init(),
        {
          type: "assistant",
          error: "authentication_failed",
          message: { role: "assistant", content: [{ type: "text", text: "Not logged in" }] },
        },
        result({ is_error: true, result: "Not logged in · Please run /login" }),
      ],
      exitCode: 1,
    });
    expect(await agent.run(INPUT)).toEqual({
      ok: false,
      reason: "Claude Code is signed out. Open Terminal, run `claude` and sign in, then ask again.",
    });
  });

  it("at the plan's limit, stops, says when it resets, and marks the answer limited", async () => {
    const { agent, runs } = claude({
      lines: [
        init(),
        rateLimit({ status: "rejected", rateLimitType: "seven_day", resetsAt: RESETS_AT }),
      ],
      hang: true,
    });
    const when = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(RESETS_AT * 1000);
    expect(await agent.run(INPUT)).toEqual({
      ok: false,
      reason: `Your Claude plan's limit is reached. It resets ${when}. Nothing was queued.`,
      limited: true,
    });
    expect(alive(runs()[0]?.pid ?? 0)).toBe(false);
  });

  it("at the limit by the assistant's error alone, still marks the answer limited", async () => {
    const { agent } = claude({
      lines: [init(), { type: "assistant", error: "rate_limit", message: {} }],
      hang: true,
    });
    expect(await agent.run(INPUT)).toMatchObject({ ok: false, limited: true });
  });

  it("offline, stops retrying after a few misses and says what the key path says", async () => {
    const retry = (attempt: number) => ({
      type: "system",
      subtype: "api_retry",
      attempt,
      error_status: null,
      error: "unknown",
    });
    const { agent, runs } = claude({
      lines: [init(), retry(1), retry(2), retry(3)],
      hang: true,
    });
    expect(await agent.run(INPUT)).toEqual({
      ok: false,
      reason:
        "Claude couldn't be reached, so nothing was drafted. Check your connection and ask again. Nothing was queued.",
    });
    expect(alive(runs()[0]?.pid ?? 0)).toBe(false);
  });

  it("an overloaded API's retries are not offline", async () => {
    const { agent } = claude({
      lines: [
        init(),
        { type: "system", subtype: "api_retry", attempt: 3, error_status: 529 },
        result(),
      ],
    });
    expect(await agent.run(INPUT)).toMatchObject({ ok: true });
  });

  it("past the time limit, kills claude and says nothing was drafted", async () => {
    const { agent, runs } = claude({ lines: [init()], hang: true }, { timeoutMs: 300 });
    expect(await agent.run(INPUT)).toEqual({
      ok: false,
      reason: "Claude Code didn't finish in 5 minutes, so nothing was drafted. Ask again.",
    });
    expect(alive(runs()[0]?.pid ?? 0)).toBe(false);
  });

  it.each([
    ["no effects", { structured_output: { nope: [] } }],
    ["no structured output", { structured_output: undefined }],
    ["an error result", { is_error: true, subtype: "error_max_structured_output_retries" }],
  ])("with %s, is unusable", async (_what, extra) => {
    const { agent } = claude({ lines: [init(), result(extra)] });
    expect(await agent.run(INPUT)).toEqual({ ok: false, reason: UNUSABLE });
  });

  it("a claude that crashes after it starts is unusable", async () => {
    const { agent } = claude({ lines: [init()], exitCode: 1 });
    expect(await agent.run(INPUT)).toEqual({ ok: false, reason: UNUSABLE });
  });

  it("a refusal keeps nothing written and reads as the key path's decline", async () => {
    const { agent } = claude({
      lines: [
        init(),
        { type: "assistant", message: { role: "assistant", stop_reason: "refusal", content: [] } },
        result({ stop_reason: "refusal" }),
      ],
    });
    expect(await agent.run(INPUT)).toEqual({
      ok: true,
      effects: [
        {
          type: "decline",
          text: "Claude declined this request, so nothing was drafted. You can fill it in by hand.",
        },
      ],
      spend: { tokens: 6300, usd: 0 },
    });
  });

  it("stop() kills the run in progress", async () => {
    const { agent, runs } = claude({ lines: [init()], hang: true }, { timeoutMs: 20_000 });
    const answer = agent.run(INPUT);
    while (runs().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    agent.stop();
    expect(await answer).toMatchObject({ ok: false });
    expect(alive(runs()[0]?.pid ?? 0)).toBe(false);
  });
});

describe("Claude Code's status", () => {
  const AUTH = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "teacher@school.example",
    orgId: "org-123",
    orgName: "Teacher's Org",
    subscriptionType: "max",
    configDirectory: "/Users/teacher/.claude",
  };

  it("says installed, its version and signed in, and nothing of the account", async () => {
    const { agent } = claude({ auth: AUTH });
    const status = await agent.status();
    expect(status).toEqual({
      installed: true,
      version: "2.1.325",
      tooOld: false,
      signedIn: true,
      weekly: null,
    });
    expect(JSON.stringify(status)).not.toMatch(/teacher|org-123|max|\.claude/);
  });

  it("signed out, says so", async () => {
    const { agent } = claude({ auth: { ...AUTH, loggedIn: false } });
    expect(await agent.status()).toMatchObject({ installed: true, signedIn: false });
  });

  it("an old claude reads as too old", async () => {
    const { agent } = claude({ version: "2.1.9" });
    expect(await agent.status()).toMatchObject({ version: "2.1.9", tooOld: true });
  });

  it("with no claude to find, says not installed", async () => {
    const agent = claudeCodeAgent({ locate: async () => null });
    expect(await agent.status()).toEqual({ installed: false, weekly: null });
  });

  it("carries the last run's weekly reading, as a percent and an ISO time", async () => {
    const { agent } = claude({
      lines: [
        init(),
        rateLimit({
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 0.9,
          resetsAt: 1_794_000_000,
          unifiedWindows: { seven_day: { utilization: 0.45, resetsAt: RESETS_AT } },
        }),
        result(),
      ],
    });
    await agent.run(INPUT);
    expect((await agent.status()).weekly).toEqual({
      usedPercent: 45,
      resetsAt: new Date(RESETS_AT * 1000).toISOString(),
    });
  });

  it("reads a seven-day event's own utilization when it has no windows", async () => {
    const { agent } = claude({
      lines: [
        init(),
        rateLimit({
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.16,
          resetsAt: RESETS_AT,
        }),
        result(),
      ],
    });
    await agent.run(INPUT);
    expect((await agent.status()).weekly).toMatchObject({ usedPercent: 16 });
  });
});
