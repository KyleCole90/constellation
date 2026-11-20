import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { it } from "vite-plus/test";

import { loadClass } from "./class";
import { benchmark } from "./harness";
import { results, resultsPath, sum, weighted } from "./metrics";
import { SOURCES, refusal, sortSources } from "./sources";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const localDate = () => new Date().toLocaleDateString("sv-SE");

const fixtureLimit = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw))
    throw new Error(`BENCH_FIXTURES must be a positive whole number, not ${JSON.stringify(raw)}.`);
  return Number(raw);
};

it("measures plan usage per graded submission for each AI source", async () => {
  if (process.env["CI"]) throw new Error("The benchmark never runs in CI: it spends real quota.");
  const limit = fixtureLimit(process.env["BENCH_FIXTURES"]);
  const { ready, unavailable } = await sortSources(SOURCES, process.env);
  if (ready.length === 0) throw new Error(refusal(unavailable));
  for (const { id, missing } of unavailable)
    console.log(`${id}: unavailable, missing ${missing.join("; ")}`);

  const fixtures = (await loadClass()).slice(0, limit);
  const dirty = git("status", "--porcelain") !== "";
  const meta = {
    date: localDate(),
    commit: `${git("rev-parse", "--short", "HEAD")}${dirty ? "-dirty" : ""}`,
  };

  for (const source of ready) {
    const run = await benchmark(source, process.env, fixtures, (draft, index) =>
      console.log(
        `${source.id} ${index + 1}/${fixtures.length} ${draft.fixture}: ${Math.round(weighted(sum(draft.calls.map((call) => call.usage))))} weighted, ${Math.round(draft.wallMs)} ms${draft.valid ? "" : `, invalid: ${draft.problems.join("; ")}`}`,
      ),
    );
    const file = results(run, meta);
    console.log(JSON.stringify({ headline: file.headline, guards: file.guards }, null, 2));
    if (limit === undefined) {
      await mkdir(dirname(resultsPath(source.id, meta)), { recursive: true });
      await writeFile(resultsPath(source.id, meta), `${JSON.stringify(file, null, 2)}\n`);
      console.log(`Wrote ${resultsPath(source.id, meta)}`);
    }
  }
}, 3_600_000);
