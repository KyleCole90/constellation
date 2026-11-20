import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

const FIXTURES: Record<string, { code: string; flagged: number }> = {
  "src/shared/explained.ts": { code: "// Sums the two.\nexport const sum = 1 + 1;", flagged: 1 },
  "src/shared/documented.ts": { code: "/** The answer. */\nexport const answer = 42;", flagged: 1 },
  "src/shared/disabled.ts": {
    code: "// oxlint-disable-next-line eslint/no-console -- the CLI prints its report\nconsole.log(1);",
    flagged: 0,
  },
  "src/shared/bare-disable.ts": {
    code: "// oxlint-disable-next-line eslint/no-console\nconsole.log(1);",
    flagged: 1,
  },
  "tests/forged.test.ts": {
    code: "// forged: a witness no approval made\nexport const w = {} as unknown as Set<string>;",
    flagged: 0,
  },
  "tests/expected.test.ts": {
    code: '// @ts-expect-error: a string is not a number\nexport const n: number = "1";',
    flagged: 0,
  },
  "scripts/run.mjs": { code: "#!/usr/bin/env node\nexport const ran = true;", flagged: 0 },
};

const root = mkdtempSync(join(tmpdir(), "no-comments-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const flaggedIn = (): Map<string, number> => {
  const files = Object.entries(FIXTURES).map(([path, { code }]) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${code}\n`);
    return file;
  });
  const run = spawnSync("npx", ["vp", "lint", "--format", "json", ...files], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const report: unknown = JSON.parse(run.stdout);
  const diagnostics =
    typeof report === "object" && report !== null && "diagnostics" in report
      ? report.diagnostics
      : null;
  if (!Array.isArray(diagnostics)) throw new Error(`not a lint report: ${run.stdout}${run.stderr}`);
  const flagged = new Map<string, number>();
  for (const d of diagnostics as unknown[]) {
    if (typeof d !== "object" || d === null) continue;
    if (!("code" in d) || d.code !== "constellation(no-comments)") continue;
    if (!("filename" in d) || typeof d.filename !== "string") continue;
    flagged.set(d.filename, (flagged.get(d.filename) ?? 0) + 1);
  }
  return flagged;
};

describe("the no-comments ratchet", () => {
  it("matches the baseline to every file's comments", () => {
    const run = spawnSync("node", ["scripts/comments.mjs", "--check"], { encoding: "utf8" });
    expect(run.stdout).toBe("");
    expect(run.status).toBe(0);
  });

  it("flags a new comment and passes the ones tools read", () => {
    const flagged = flaggedIn();
    expect(
      Object.fromEntries(
        Object.keys(FIXTURES).map((path) => [path, flagged.get(join(root, path)) ?? 0]),
      ),
    ).toEqual(
      Object.fromEntries(Object.entries(FIXTURES).map(([path, { flagged: n }]) => [path, n])),
    );
  }, 60_000);
});
