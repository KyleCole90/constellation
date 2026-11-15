import * as v from "valibot";

import { MODEL, anthropicAgent } from "~/main/providers/anthropic";
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

/** An AI source to bench. #82 adds Claude Code by replacing its entry below; the harness doesn't change. */
export interface BenchSource {
  id: SourceId;
  model: string;
  /** The startup-overhead guard's p50 limit, or null where it doesn't apply. */
  overheadLimitMs: number | null;
  /** What this source still needs before it can run, in words for the maintainer. Empty when it can run. */
  missing(env: Env): readonly string[];
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
  missing: (env) => (env["ANTHROPIC_API_KEY"] ? [] : ["ANTHROPIC_API_KEY, for the api-key source"]),
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

/** Not built yet: #82 replaces this entry with the real provider, a signed-in check, its version and its weekly reading. */
const claudeCode: BenchSource = {
  id: "claude-code",
  model: MODEL,
  overheadLimitMs: 300,
  missing: () => ["a signed-in Claude Code, for the claude-code source, which #82 adds"],
  open: () => Promise.reject(new Error("The claude-code source arrives with #82.")),
};

export const SOURCES: readonly BenchSource[] = [apiKey, claudeCode];

/** Which sources have what they need, and what the rest are missing. */
export const sortSources = (sources: readonly BenchSource[], env: Env) => ({
  ready: sources.filter((source) => source.missing(env).length === 0),
  unavailable: sources.flatMap((source) => {
    const missing = source.missing(env);
    return missing.length > 0 ? [{ id: source.id, missing }] : [];
  }),
});

/** Why the benchmark won't start: nothing it could run, and each missing credential by name. */
export const refusal = (unavailable: ReturnType<typeof sortSources>["unavailable"]): string =>
  [
    "No AI source has the credentials it needs, so the benchmark didn't start. Missing:",
    ...unavailable.flatMap(({ missing }) => missing.map((what) => `- ${what}`)),
  ].join("\n");
