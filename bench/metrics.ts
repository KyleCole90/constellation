/** Raw token counts from one model request, as the source reported them. */
export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * The API's price ratios. Anthropic doesn't publish how subscription limits weight token types, so this is an
 * assumption, written into every results file so a number is never compared under different weights.
 */
export const WEIGHTS = {
  input: 1,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  output: 5,
} as const satisfies Usage;

export type FixtureKind = "text" | "pdf" | "image" | "link-screenshot" | "document";
const KINDS = [
  "text",
  "pdf",
  "image",
  "link-screenshot",
  "document",
] as const satisfies readonly FixtureKind[];

export type SourceId = "api-key" | "claude-code";

/** One model request inside a draft. A fallback or a background call is a request of its own model. */
export interface Call {
  model: string;
  usage: Usage;
}

/** One fixture, drafted once. `modelMs` is the time the source spent waiting on the model; the rest of `wallMs` is ours. */
export interface Draft {
  fixture: string;
  kind: FixtureKind;
  calls: readonly Call[];
  wallMs: number;
  modelMs: number;
  /** The run came back ok, every effect parsed through `parseAgentEffect` with nothing set aside, and it proposed a grade. */
  valid: boolean;
  problems: readonly string[];
}

/** Everything one source's pass over the class produced, before any arithmetic. */
export interface Run {
  source: SourceId;
  model: string;
  claudeCodeVersion: string | null;
  /** The startup-overhead guard's p50 limit, or null where it doesn't apply (the API source). */
  overheadLimitMs: number | null;
  /** The first-try-validity guard's floor, as a percent of drafts. */
  minValidPercent: number;
  /** The source's weekly-limit utilization in percent, read before and after the class. Null for a source without one. */
  weekly: { before: number | null; after: number | null };
  drafts: readonly Draft[];
}

const ZERO: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const plus = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
});
export const sum = (usages: readonly Usage[]): Usage => usages.reduce(plus, ZERO);

export const weighted = (usage: Usage): number =>
  usage.input * WEIGHTS.input +
  usage.cacheWrite * WEIGHTS.cacheWrite +
  usage.cacheRead * WEIGHTS.cacheRead +
  usage.output * WEIGHTS.output;

const tokens = (usage: Usage): number =>
  usage.input + usage.cacheWrite + usage.cacheRead + usage.output;

/** Nearest rank, so a reported p90 is always a value that was measured. */
const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const round = (value: number): number => Math.round(value * 10) / 10;
const spread = (values: readonly number[]) => ({
  p50: round(percentile(values, 50)),
  p90: round(percentile(values, 90)),
});

const pinned = (draft: Draft, model: string): Usage =>
  sum(draft.calls.filter((call) => call.model === model).map((call) => call.usage));
const others = (draft: Draft, model: string): Usage =>
  sum(draft.calls.filter((call) => call.model !== model).map((call) => call.usage));

const perSubmission = (drafts: readonly Draft[], model: string): number =>
  drafts.length === 0
    ? 0
    : round(drafts.reduce((total, d) => total + weighted(pinned(d, model)), 0) / drafts.length);

export interface Meta {
  date: string;
  commit: string;
}

/** The dated results file: the headline, the three guards and the translation, with the raw counts behind them. */
export const results = (run: Run, meta: Meta) => {
  const { drafts, model } = run;
  const overhead = drafts.map((d) => d.wallMs - d.modelMs);
  const overheadP50 = round(percentile(overhead, 50));
  const otherTokens = tokens(sum(drafts.map((d) => others(d, model))));
  const valid = drafts.filter((d) => d.valid).length;
  const { before, after } = run.weekly;
  return {
    benchmark: "plan usage per graded submission (#85)",
    date: meta.date,
    commit: meta.commit,
    source: run.source,
    claudeCodeVersion: run.claudeCodeVersion,
    model,
    weights: WEIGHTS,
    fixtures: drafts.length,
    headline: { weightedOpusTokensPerSubmission: perSubmission(drafts, model) },
    raw: {
      pinnedModel: sum(drafts.map((d) => pinned(d, model))),
      otherModels: sum(drafts.map((d) => others(d, model))),
    },
    guards: {
      startupOverhead:
        run.overheadLimitMs === null
          ? { applies: false, p50Ms: overheadP50 }
          : {
              applies: true,
              p50Ms: overheadP50,
              limitMs: run.overheadLimitMs,
              pass: overheadP50 <= run.overheadLimitMs,
            },
      otherModelTokens: { tokens: otherTokens, pass: otherTokens === 0 },
      firstTryValid: {
        valid,
        of: drafts.length,
        minPercent: run.minValidPercent,
        pass: valid * 100 >= run.minValidPercent * drafts.length,
      },
    },
    translation: {
      weeklyLimitPercentPerClass: before === null || after === null ? null : after - before,
    },
    time: {
      draftWallMs: spread(drafts.map((d) => d.wallMs)),
      classWallMs: round(drafts.reduce((total, d) => total + d.wallMs, 0)),
      modelMs: spread(drafts.map((d) => d.modelMs)),
      overheadMs: spread(overhead),
    },
    byKind: Object.fromEntries(
      KINDS.map((kind) => {
        const mine = drafts.filter((d) => d.kind === kind);
        return [
          kind,
          {
            drafts: mine.length,
            weightedPerSubmission: perSubmission(mine, model),
            raw: sum(mine.map((d) => pinned(d, model))),
          },
        ];
      }),
    ),
    drafts: drafts.map((d) => ({
      fixture: d.fixture,
      kind: d.kind,
      weighted: round(weighted(pinned(d, model))),
      raw: pinned(d, model),
      otherModels: others(d, model),
      wallMs: round(d.wallMs),
      modelMs: round(d.modelMs),
      valid: d.valid,
      problems: d.problems,
    })),
  };
};

/** One file per source per run, named so runs sort by date and say which commit they measured. */
export const resultsPath = (source: SourceId, meta: Meta): string =>
  `bench/results/${meta.date}-${source}-${meta.commit}.json`;
