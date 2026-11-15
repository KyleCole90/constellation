import * as v from "valibot";

import { MODEL } from "~/main/agent";
import { anthropicAgent } from "~/main/providers/anthropic";
import { claudeCodeAgent } from "~/main/providers/claude-code";
import type { Handlers } from "~/shared/ipc";
import { Secret } from "~/shared/providers/provider";

import type { Call, SourceId } from "./metrics";

export type Env = Readonly<Record<string, string | undefined>>;

/** How a source tells the harness what each model request used and how long the model took. */
interface Meter {
  request(calls: readonly Call[], modelMs: number): void;
}

interface OpenSource {
  /** The same `agent.run` handler main would register for this source. */
  run: Handlers["agent.run"];
  claudeCodeVersion: string | null;
  /** Weekly-limit utilization in percent, or null for a source with no weekly limit. */
  weeklyUsed(): Promise<number | null>;
}

/** An AI source to bench. */
export interface BenchSource {
  id: SourceId;
  model: string;
  /** The startup-overhead guard's p50 limit, or null where it doesn't apply. */
  overheadLimitMs: number | null;
  /** The first-try-validity guard's floor, as a percent of drafts. */
  minValidPercent: number;
  /** What this source still needs before it can run, in words for the maintainer. Empty when it can run. */
  missing(env: Env): Promise<readonly string[]>;
  open(env: Env, meter: Meter): Promise<OpenSource>;
}

const Tokens = v.object({
  input_tokens: v.number(),
  output_tokens: v.number(),
  cache_creation_input_tokens: v.nullish(v.number()),
  cache_read_input_tokens: v.nullish(v.number()),
  model: v.nullish(v.string()),
});
const MessageUsage = v.object({
  model: v.string(),
  usage: v.object({ ...Tokens.entries, iterations: v.nullish(v.array(v.unknown())) }),
});

/** Every attempt in a response, each under its own model, as `spendOf` reads them. Anything else is no model request. */
export const callsOf = (body: unknown): Call[] => {
  const message = v.safeParse(MessageUsage, body);
  if (!message.success) return [];
  const { model, usage } = message.output;
  const attempts = usage.iterations
    ? usage.iterations.flatMap((attempt) => {
        const parsed = v.safeParse(Tokens, attempt);
        return parsed.success ? [parsed.output] : [];
      })
    : [usage];
  return attempts.map((attempt) => ({
    model: attempt.model ?? model,
    usage: {
      input: attempt.input_tokens,
      cacheWrite: attempt.cache_creation_input_tokens ?? 0,
      cacheRead: attempt.cache_read_input_tokens ?? 0,
      output: attempt.output_tokens,
    },
  }));
};

/** The provider main builds for a saved key, given the key from the environment and a `fetch` that reads each response's usage. */
const apiKey: BenchSource = {
  id: "api-key",
  model: MODEL,
  overheadLimitMs: null,
  minValidPercent: 100,
  missing: async (env) =>
    env["ANTHROPIC_API_KEY"] ? [] : ["ANTHROPIC_API_KEY, for the api-key source"],
  open: async (env, meter) => ({
    run: anthropicAgent({
      lease: {
        use: (work) => work({ kind: "bearer", token: new Secret(env["ANTHROPIC_API_KEY"] ?? "") }),
        replace: async () => {},
      },
      fetch: async (url, init) => {
        const started = performance.now();
        const response = await fetch(url, init);
        const text = await response.text();
        const modelMs = performance.now() - started;
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          // An unreadable body is no model request; the provider reports the failure itself.
        }
        meter.request(callsOf(body), modelMs);
        return new Response(text, response);
      },
    }),
    claudeCodeVersion: null,
    weeklyUsed: async () => null,
  }),
};

/** The `claude` on this Mac, or the one `CONSTELLATION_CLAUDE` names, as main runs it, with its usage read from each result. */
const claudeCodeFor = (env: Env, meter?: Meter) => {
  const binary = env["CONSTELLATION_CLAUDE"];
  return claudeCodeAgent({
    env,
    ...(binary ? { locate: async () => binary } : {}),
    ...(meter ? { onUsage: (calls, modelMs) => meter.request(calls, modelMs) } : {}),
  });
};

const claudeCode: BenchSource = {
  id: "claude-code",
  model: MODEL,
  overheadLimitMs: 300,
  // Kyle's call on 2026-11-15 (#82): 90% first-try valid is enough for Claude Code.
  minValidPercent: 90,
  missing: async (env) => {
    const status = await claudeCodeFor(env).status();
    return status.installed && status.signedIn && !status.tooOld
      ? []
      : ["a signed-in, current Claude Code, for the claude-code source"];
  },
  open: async (env, meter) => {
    const agent = claudeCodeFor(env, meter);
    const status = await agent.status();
    return {
      run: agent.run,
      claudeCodeVersion: status.installed ? status.version : null,
      // Claude Code reports the week's usage only as a run's rate-limit event, so there's none before the first draft.
      weeklyUsed: async () => (await agent.status()).weekly?.usedPercent ?? null,
    };
  },
};

export const SOURCES: readonly BenchSource[] = [apiKey, claudeCode];

/** Which sources have what they need, and what the rest are missing. */
export const sortSources = async (sources: readonly BenchSource[], env: Env) => {
  const checked = await Promise.all(
    sources.map(async (source) => ({ source, missing: await source.missing(env) })),
  );
  return {
    ready: checked.filter(({ missing }) => missing.length === 0).map(({ source }) => source),
    unavailable: checked.flatMap(({ source, missing }) =>
      missing.length > 0 ? [{ id: source.id, missing }] : [],
    ),
  };
};

/** Why the benchmark won't start: nothing it could run, and each missing credential by name. */
export const refusal = (
  unavailable: Awaited<ReturnType<typeof sortSources>>["unavailable"],
): string =>
  [
    "No AI source has the credentials it needs, so the benchmark didn't start. Missing:",
    ...unavailable.flatMap(({ missing }) => missing.map((what) => `- ${what}`)),
  ].join("\n");
