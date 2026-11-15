import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { it } from "vite-plus/test";

import { loadClass } from "./class";
import { benchmark } from "./harness";
import { results, resultsPath, sum, weighted } from "./metrics";
import { SOURCES, refusal, sortSources } from "./sources";

/*
 * `npm run bench:claude-code`: drafts the 30-fixture class through each AI source that has credentials and writes a
 * dated results file per source to bench/results. It spends real quota, so it runs only through that script, never in
 * `npm test` or CI. `BENCH_FIXTURES=2` drafts only the first two and writes nothing, for a cheap check while developing.
 */
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const localDate = () => new Date().toLocaleDateString("sv-SE");

it("measures plan usage per graded submission for each AI source", async () => {
  if (process.env["CI"]) throw new Error("The benchmark never runs in CI: it spends real quota.");
  const { ready, unavailable } = await sortSources(SOURCES, process.env);
  if (ready.length === 0) throw new Error(refusal(unavailable));
  for (const { id, missing } of unavailable)
    console.log(`${id}: unavailable, missing ${missing.join("; ")}`);

  const limit = Number(process.env["BENCH_FIXTURES"]) || undefined;
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
