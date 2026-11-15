import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, constants, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import * as v from "valibot";

import { CLAUDE_CODE_MINIMUM, olderThan } from "../../shared/claude-code";
import type { Handlers } from "../../shared/ipc";

import {
  DECLINED,
  EFFECTS_SCHEMA,
  EFFECTS_SYSTEM,
  MODEL,
  OFFLINE,
  blocksOf,
  effectOf,
  failed,
  unreadable,
  type Answer,
  type Input,
} from "../agent";

type Status = Awaited<ReturnType<Handlers["claudeCode.status"]>>;
type Env = Readonly<Record<string, string | undefined>>;

/** One model request in a run, with its tokens split as the benchmark weighs them. */
interface Call {
  model: string;
  usage: { input: number; cacheWrite: number; cacheRead: number; output: number };
}

interface ClaudeCodeOptions {
  /** Where `claude` is, or null when it isn't installed. By default, the install locations, then the login shell. */
  locate?: (env: Env) => Promise<string | null>;
  /** The environment each run starts from, before the API-key variables come out. */
  env?: Env;
  /** Where each run's empty working folder goes. */
  tmpRoot?: string;
  timeoutMs?: number;
  /** Each finished run's model requests and the time the model took, for the benchmark. */
  onUsage?: (calls: readonly Call[], modelMs: number) => void;
}

const NOT_INSTALLED = failed(
  "Claude Code isn't installed on this Mac. Install it, or switch to an API key in Settings.",
);
const tooOld = (have: string) =>
  failed(
    `Update Claude Code (you have ${have}, Constellation needs ${CLAUDE_CODE_MINIMUM}), then ask again.`,
  );
const SIGNED_OUT = failed(
  "Claude Code is signed out. Open Terminal, run `claude` and sign in, then ask again.",
);
const TIMED_OUT = failed(
  "Claude Code didn't finish in 5 minutes, so nothing was drafted. Ask again.",
);
const UNUSABLE = failed(
  "Claude Code answered in a way Constellation can't use, so nothing was drafted. Ask again.",
);
const RESET_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
const limitReached = (resetsAt: number | undefined): Answer => ({
  ok: false,
  reason: `Your Claude plan's limit is reached.${resetsAt === undefined ? "" : ` It resets ${RESET_TIME.format(resetsAt * 1000)}.`} Nothing was queued.`,
  limited: true,
});

/**
 * Every built-in tool, MCP server, setting source and slash command off, and no session saved, so student work reaches
 * nothing on the Mac. `--bare` would also turn these off, but it accepts only an API key, never the teacher's sign-in.
 */
const ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  MODEL,
  "--effort",
  "medium",
  "--system-prompt",
  EFFECTS_SYSTEM,
  "--json-schema",
  JSON.stringify(EFFECTS_SCHEMA),
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--no-session-persistence",
];
/** Without these the teacher's subscription pays, never an API key that happens to be in the environment. */
const API_KEY_VARIABLES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
]);
const FIVE_MINUTES = 5 * 60_000;
/** The CLI retries an unreachable API for minutes. Two misses with no HTTP status is offline enough. */
const OFFLINE_AFTER_ATTEMPTS = 2;

const Init = v.looseObject({
  tools: v.array(v.string()),
  mcp_servers: v.array(v.unknown()),
  slash_commands: v.array(v.unknown()),
  claude_code_version: v.string(),
});
const Retry = v.looseObject({ attempt: v.number(), error_status: v.nullish(v.number()) });
/** `utilization` is a fraction and `resetsAt` epoch seconds. */
const Window = v.looseObject({ utilization: v.number(), resetsAt: v.number() });
const RateLimitInfo = v.looseObject({
  status: v.optional(v.string()),
  rateLimitType: v.optional(v.string()),
  utilization: v.optional(v.number()),
  resetsAt: v.optional(v.number()),
  unifiedWindows: v.optional(v.looseObject({ seven_day: v.optional(Window) })),
});
const RateLimit = v.looseObject({ rate_limit_info: RateLimitInfo });
const Assistant = v.looseObject({
  error: v.optional(v.string()),
  message: v.optional(v.looseObject({ stop_reason: v.nullish(v.string()) })),
});
const ModelUsage = v.looseObject({
  inputTokens: v.number(),
  outputTokens: v.number(),
  cacheReadInputTokens: v.optional(v.number(), 0),
  cacheCreationInputTokens: v.optional(v.number(), 0),
});
const Result = v.looseObject({
  is_error: v.boolean(),
  stop_reason: v.nullish(v.string()),
  structured_output: v.optional(v.unknown()),
  modelUsage: v.optional(v.record(v.string(), ModelUsage), {}),
  duration_api_ms: v.optional(v.number(), 0),
});
const Output = v.object({ effects: v.array(v.unknown()) });
const Effect = v.looseObject({ type: v.string() });
const Line = v.looseObject({ type: v.string(), subtype: v.optional(v.string()) });
const AuthStatus = v.looseObject({ loggedIn: v.boolean() });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const weeklyOf = (info: v.InferOutput<typeof RateLimitInfo>): Status["weekly"] => {
  const window =
    info.unifiedWindows?.seven_day ??
    (info.rateLimitType === "seven_day" &&
    info.utilization !== undefined &&
    info.resetsAt !== undefined
      ? { utilization: info.utilization, resetsAt: info.resetsAt }
      : null);
  return window
    ? {
        usedPercent: Math.round(window.utilization * 100),
        resetsAt: new Date(window.resetsAt * 1000).toISOString(),
      }
    : null;
};

/** When the limit that stopped a run lifts, in epoch seconds. */
const resetOf = (info: v.InferOutput<typeof RateLimitInfo>): number | undefined =>
  info.resetsAt ?? info.unifiedWindows?.seven_day?.resetsAt;

const versionIn = (stdout: string): string | null =>
  /^\d+(?:\.\d+)+/.exec(stdout.trim())?.[0] ?? null;

const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

/** Apps opened from the Finder don't get the shell's PATH, so the usual install locations come first, then one login-shell lookup. */
const findClaude = async (env: Env): Promise<string | null> => {
  for (const path of [
    join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ])
    if (await isExecutable(path)) return path;
  const stdout = await new Promise<string>((resolve) =>
    execFile(
      env["SHELL"] || "/bin/zsh",
      ["-lic", "command -v claude"],
      { env, timeout: 5_000 },
      (_error, out) => resolve(out),
    ),
  );
  return (
    stdout
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.startsWith("/")) ?? null
  );
};

interface Exec {
  ok: boolean;
  stdout: string;
}

/**
 * `agent.run` through the teacher's own installed, unmodified Claude Code, plus its status for Settings. One `claude`
 * runs at a time, in order, whoever asked. What comes back is raw, like the key's provider: the renderer's
 * `parseAgentEffect` decides what counts.
 */
export const claudeCodeAgent = (options: ClaudeCodeOptions = {}) => {
  const base = options.env ?? process.env;
  const env: Record<string, string> = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  for (const [name, value] of Object.entries(base))
    if (value !== undefined && !API_KEY_VARIABLES.has(name)) env[name] ??= value;
  const locate = options.locate ?? findClaude;
  const timeoutMs = options.timeoutMs ?? FIVE_MINUTES;
  const tmpRoot = options.tmpRoot ?? tmpdir();

  let found: string | null = null;
  let weekly: Status["weekly"] = null;
  let running: ChildProcess | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  /** Runs `work` on the remembered `claude`, searching again once if that path stopped working. Null with none to run. */
  const onClaude = async <T>(work: (path: string) => Promise<T | "gone">): Promise<T | null> => {
    for (const fresh of [false, true]) {
      if (fresh || found === null) found = await locate(base);
      if (found === null) return null;
      const outcome = await work(found);
      if (outcome !== "gone") return outcome;
    }
    found = null;
    return null;
  };

  const exec = (args: readonly string[]) =>
    onClaude(
      (path) =>
        new Promise<Exec | "gone">((resolve) =>
          execFile(path, args, { env, timeout: 10_000 }, (error, stdout) =>
            resolve(
              error && ["ENOENT", "EACCES"].includes(String(error.code))
                ? "gone"
                : { ok: !error, stdout },
            ),
          ),
        ),
    );

  const version = async (): Promise<string | null> => {
    const result = await exec(["--version"]);
    return result?.ok ? versionIn(result.stdout) : null;
  };

  /** One run of `claude`. "early" when it died before saying who it is, as a CLI too old for a flag does. */
  const once = (path: string, cwd: string, input: Input) =>
    new Promise<Answer | "gone" | "early">((resolve) => {
      const child = spawn(path, ARGS, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
      running = child;
      let answer: Answer | null = null;
      let started = false;
      let refused = false;
      let limit: v.InferOutput<typeof RateLimitInfo> | null = null;
      const decide = (decided: Answer, kill = true) => {
        answer ??= decided;
        if (kill) child.kill("SIGKILL");
      };
      const timer = setTimeout(() => decide(TIMED_OUT), timeoutMs);
      let settled = false;
      const settle = (spawned: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (running === child) running = null;
        resolve(answer ?? (!spawned ? "gone" : started ? UNUSABLE : "early"));
      };
      child.on("error", () => settle(child.pid !== undefined));
      child.on("close", () => settle(true));

      const read = (line: string) => {
        const json = parseJson(line);
        const kind = v.safeParse(Line, json);
        if (!kind.success) return;
        const { type, subtype } = kind.output;
        if (type === "system" && subtype === "init") {
          started = true;
          const init = v.safeParse(Init, json);
          if (!init.success) return decide(UNUSABLE);
          const { tools, mcp_servers, slash_commands, claude_code_version } = init.output;
          if (tools.length !== 1 || tools[0] !== "StructuredOutput") return decide(UNUSABLE);
          if (mcp_servers.length > 0 || slash_commands.length > 0) return decide(UNUSABLE);
          if (olderThan(claude_code_version, CLAUDE_CODE_MINIMUM))
            return decide(tooOld(claude_code_version));
        } else if (type === "system" && subtype === "api_retry") {
          const retry = v.safeParse(Retry, json);
          if (
            retry.success &&
            retry.output.attempt > OFFLINE_AFTER_ATTEMPTS &&
            retry.output.error_status == null
          )
            decide(OFFLINE);
        } else if (type === "rate_limit_event") {
          const event = v.safeParse(RateLimit, json);
          if (!event.success) return;
          limit = event.output.rate_limit_info;
          weekly = weeklyOf(limit) ?? weekly;
          if (limit.status === "rejected") decide(limitReached(resetOf(limit)));
        } else if (type === "assistant") {
          const message = v.safeParse(Assistant, json);
          if (!message.success) return;
          if (message.output.error === "authentication_failed") return decide(SIGNED_OUT);
          if (message.output.error === "rate_limit")
            return decide(limitReached(limit ? resetOf(limit) : undefined));
          if (message.output.message?.stop_reason === "refusal") refused = true;
        } else if (type === "result") {
          const result = v.safeParse(Result, json);
          if (!result.success) return decide(UNUSABLE);
          decide(answerOf(result.output, refused), false);
        }
      };
      createInterface({ input: child.stdout }).on("line", read);
      child.stdin.on("error", () => {});
      child.stdin.end(
        `${JSON.stringify({ type: "user", message: { role: "user", content: blocksOf(input) } })}\n`,
      );
    });

  const answerOf = (result: v.InferOutput<typeof Result>, refused: boolean): Answer => {
    const calls = Object.entries(result.modelUsage).map(([model, usage]) => ({
      model,
      usage: {
        input: usage.inputTokens,
        cacheWrite: usage.cacheCreationInputTokens,
        cacheRead: usage.cacheReadInputTokens,
        output: usage.outputTokens,
      },
    }));
    options.onUsage?.(calls, result.duration_api_ms);
    // The CLI's `total_cost_usd` is an estimate, not a bill: the plan pays, so a thread shows no dollars.
    const spend = {
      tokens: calls.reduce(
        (sum, { usage }) => sum + usage.input + usage.cacheWrite + usage.cacheRead + usage.output,
        0,
      ),
      usd: 0,
    };
    // A refusal can stop partway through, so nothing it wrote is kept.
    if (refused || result.stop_reason === "refusal")
      return { ok: true, effects: [{ type: "decline", text: DECLINED }], spend };
    if (result.is_error) return UNUSABLE;
    const output = v.safeParse(Output, result.structured_output);
    if (!output.success) return UNUSABLE;
    const effects = output.output.effects.flatMap((item) => {
      const effect = v.safeParse(Effect, item);
      return effect.success ? effectOf(effect.output.type, item) : [];
    });
    return { ok: true, effects, spend };
  };

  const draft = async (input: Input): Promise<Answer> => {
    const outcome = await onClaude(async (path) => {
      const cwd = await mkdtemp(join(tmpRoot, "constellation-claude-"));
      try {
        return await once(path, cwd, input);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
    if (outcome === null) return NOT_INSTALLED;
    if (outcome !== "early") return outcome;
    const have = await version();
    if (have === null) return NOT_INSTALLED;
    return olderThan(have, CLAUDE_CODE_MINIMUM) ? tooOld(have) : UNUSABLE;
  };

  const run: Handlers["agent.run"] = (input) => {
    const unread = unreadable(input);
    if (unread) return Promise.resolve(unread);
    const turn = tail.then(() => draft(input)).catch(() => UNUSABLE);
    tail = turn;
    return turn;
  };

  /** Only what the contract names: never the account's email, organization or token. */
  const status = async (): Promise<Status> => {
    const have = await version();
    if (have === null) return { installed: false, weekly };
    const auth = await exec(["auth", "status"]);
    const signedIn = v.safeParse(AuthStatus, parseJson(auth?.stdout ?? ""));
    return {
      installed: true,
      version: have,
      tooOld: olderThan(have, CLAUDE_CODE_MINIMUM),
      signedIn: signedIn.success && signedIn.output.loggedIn,
      weekly,
    };
  };

  /** Kills the run in progress, the only `claude` this app has running. Main calls it as the app quits. */
  const stop = () => {
    running?.kill("SIGKILL");
  };

  return { run, status, stop };
};
