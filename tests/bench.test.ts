import { describe, expect, it } from "vite-plus/test";

import {
  WEIGHTS,
  results,
  resultsPath,
  type Draft,
  type FixtureKind,
  type Run,
} from "../bench/metrics";
import { SOURCES, callsOf, refusal, sortSources } from "../bench/sources";

const OPUS = "claude-opus-5-5";
const META = { date: "2026-11-15", commit: "abc1234" };

const draft = (
  kind: FixtureKind,
  usage: { input: number; cacheWrite?: number; cacheRead?: number; output: number },
  extra: Partial<Draft> = {},
): Draft => ({
  fixture: `${kind}-${usage.input}`,
  kind,
  calls: [
    {
      model: OPUS,
      usage: { cacheWrite: 0, cacheRead: 0, ...usage },
    },
  ],
  wallMs: 5000,
  modelMs: 4800,
  valid: true,
  problems: [],
  ...extra,
});

const run = (drafts: readonly Draft[], extra: Partial<Run> = {}): Run => ({
  source: "api-key",
  model: OPUS,
  claudeCodeVersion: null,
  overheadLimitMs: null,
  weekly: { before: null, after: null },
  drafts,
  ...extra,
});

describe("the headline", () => {
  it("weights input 1, cache writes 1.25, cache reads 0.1 and output 5, averaged per submission", () => {
    const file = results(
      run([
        draft("text", { input: 1000, cacheWrite: 400, cacheRead: 2000, output: 200 }),
        draft("pdf", { input: 3000, output: 600 }),
      ]),
      META,
    );
    // (1000 + 500 + 200 + 1000) and (3000 + 3000), over two submissions.
    expect(file.headline.weightedOpusTokensPerSubmission).toBe(4350);
    expect(file.weights).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
    expect(file.raw.pinnedModel).toEqual({
      input: 4000,
      cacheWrite: 400,
      cacheRead: 2000,
      output: 800,
    });
  });

  it("counts only the pinned model, and a fallback's tokens fail the other-model guard", () => {
    const fallback = draft(
      "image",
      { input: 1000, output: 100 },
      {
        calls: [
          { model: OPUS, usage: { input: 1000, cacheWrite: 0, cacheRead: 0, output: 100 } },
          {
            model: "claude-haiku-5-5",
            usage: { input: 1210, cacheWrite: 0, cacheRead: 0, output: 0 },
          },
        ],
      },
    );
    const file = results(run([fallback]), META);
    expect(file.headline.weightedOpusTokensPerSubmission).toBe(1500);
    expect(file.guards.otherModelTokens).toEqual({ tokens: 1210, pass: false });
    expect(
      results(run([draft("text", { input: 10, output: 1 })]), META).guards.otherModelTokens,
    ).toEqual({ tokens: 0, pass: true });
  });

  it("breaks the class down by kind, including kinds it didn't draft", () => {
    const file = results(
      run([
        draft("text", { input: 1000, output: 100 }),
        draft("text", { input: 3000, output: 100 }),
        draft("pdf", { input: 8000, output: 200 }),
      ]),
      META,
    );
    expect(file.byKind["text"]).toMatchObject({ drafts: 2, weightedPerSubmission: 2500 });
    expect(file.byKind["pdf"]).toMatchObject({ drafts: 1, weightedPerSubmission: 9000 });
    expect(file.byKind["document"]).toMatchObject({ drafts: 0, weightedPerSubmission: 0 });
  });
});

describe("the guards", () => {
  it("checks startup overhead, wall time minus model time, against the source's p50 limit", () => {
    const quick = [180, 200, 250].map((overhead) =>
      draft("text", { input: 1, output: 1 }, { wallMs: 4000 + overhead, modelMs: 4000 }),
    );
    expect(results(run(quick, { overheadLimitMs: 300 }), META).guards.startupOverhead).toEqual({
      applies: true,
      p50Ms: 200,
      limitMs: 300,
      pass: true,
    });
    const slow = quick.map((d) => ({ ...d, wallMs: d.wallMs + 200 }));
    expect(results(run(slow, { overheadLimitMs: 300 }), META).guards.startupOverhead).toMatchObject(
      { p50Ms: 400, pass: false },
    );
  });

  it("doesn't apply the overhead guard to a source without a limit", () => {
    expect(
      results(run([draft("text", { input: 1, output: 1 })]), META).guards.startupOverhead,
    ).toEqual({ applies: false, p50Ms: 200 });
  });

  it("passes first-try validity only when every draft was valid", () => {
    const good = draft("text", { input: 1, output: 1 });
    const bad = { ...good, valid: false, problems: ["no grade proposed"] };
    expect(results(run([good, good]), META).guards.firstTryValid).toEqual({
      valid: 2,
      of: 2,
      pass: true,
    });
    expect(results(run([good, bad]), META).guards.firstTryValid).toEqual({
      valid: 1,
      of: 2,
      pass: false,
    });
  });
});

describe("the translation and the times", () => {
  it("reports the weekly limit's change across the class, or null for a source without one", () => {
    const drafts = [draft("text", { input: 1, output: 1 })];
    expect(
      results(run(drafts, { weekly: { before: 16, after: 19 } }), META).translation
        .weeklyLimitPercentPerClass,
    ).toBe(3);
    expect(results(run(drafts), META).translation.weeklyLimitPercentPerClass).toBeNull();
  });

  it("reports wall, model and overhead time apart, as nearest-rank p50 and p90", () => {
    const drafts = [3900, 5000, 11100].map((modelMs) =>
      draft("text", { input: 1, output: 1 }, { modelMs, wallMs: modelMs + 100 }),
    );
    expect(results(run(drafts), META).time).toEqual({
      draftWallMs: { p50: 5100, p90: 11200 },
      classWallMs: 20300,
      modelMs: { p50: 5000, p90: 11100 },
      overheadMs: { p50: 100, p90: 100 },
    });
  });
});

describe("the results file", () => {
  it("records the commit, date, source, Claude Code version, model, weights, raw counts, headline, guards and translation", () => {
    const file = results(run([draft("pdf", { input: 5000, output: 400 })]), META);
    expect(Object.keys(file)).toEqual([
      "benchmark",
      "date",
      "commit",
      "source",
      "claudeCodeVersion",
      "model",
      "weights",
      "fixtures",
      "headline",
      "raw",
      "guards",
      "translation",
      "time",
      "byKind",
      "drafts",
    ]);
    expect(file).toMatchObject({
      date: "2026-11-15",
      commit: "abc1234",
      source: "api-key",
      claudeCodeVersion: null,
      model: OPUS,
      weights: WEIGHTS,
      fixtures: 1,
    });
    expect(file.drafts[0]).toEqual({
      fixture: "pdf-5000",
      kind: "pdf",
      weighted: 7000,
      raw: { input: 5000, cacheWrite: 0, cacheRead: 0, output: 400 },
      otherModels: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      wallMs: 5000,
      modelMs: 4800,
      valid: true,
      problems: [],
    });
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });

  it("is named by date, source and commit, under bench/results", () => {
    expect(resultsPath("api-key", META)).toBe("bench/results/2026-11-15-api-key-abc1234.json");
  });
});

describe("credentials", () => {
  it("runs the API-key source with ANTHROPIC_API_KEY and reports Claude Code as unavailable until #82", () => {
    const { ready, unavailable } = sortSources(SOURCES, { ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(ready.map((source) => source.id)).toEqual(["api-key"]);
    expect(unavailable).toEqual([
      {
        id: "claude-code",
        missing: ["a signed-in Claude Code, for the claude-code source, which #82 adds"],
      },
    ]);
  });

  it("refuses to start with no credentials, naming each one missing", () => {
    const { ready, unavailable } = sortSources(SOURCES, { ANTHROPIC_API_KEY: "" });
    expect(ready).toEqual([]);
    expect(refusal(unavailable)).toBe(
      [
        "No AI source has the credentials it needs, so the benchmark didn't start. Missing:",
        "- ANTHROPIC_API_KEY, for the api-key source",
        "- a signed-in Claude Code, for the claude-code source, which #82 adds",
      ].join("\n"),
    );
  });
});

describe("the API source's usage", () => {
  it("reads one request from a message, and each attempt under its own model when a fallback ran", () => {
    const usage = {
      input_tokens: 9000,
      output_tokens: 700,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 0,
    };
    expect(callsOf({ model: OPUS, usage })).toEqual([
      { model: OPUS, usage: { input: 9000, cacheWrite: 0, cacheRead: 0, output: 700 } },
    ]);
    expect(
      callsOf({
        model: "claude-opus-5",
        usage: {
          ...usage,
          iterations: [
            { ...usage, model: OPUS, output_tokens: 20 },
            { ...usage, model: "claude-opus-5" },
          ],
        },
      }).map((call) => [call.model, call.usage.output]),
    ).toEqual([
      [OPUS, 20],
      ["claude-opus-5", 700],
    ]);
    expect(callsOf({ type: "error", error: { type: "overloaded_error" } })).toEqual([]);
  });
});
