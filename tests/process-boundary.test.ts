import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

/** Each fixture is a one-import file at `src/<path>`, linted by the real `vp lint`. */
const FIXTURES = {
  "shared/alias-cross.ts": "~/renderer/lib/utils",
  "shared/alias-dotdot-cross.ts": "~/shared/../renderer/lib/utils",
  "shared/relative-cross.ts": "../renderer/lib/utils",
  "shared/alias-case-cross.ts": "~/Renderer/lib/utils",
  "shared/domain/alias-dotdot-same.ts": "~/shared/../shared/domain/ids",
  "shared/domain/relative-same.ts": "./ids",
  "renderer/alias-into-shared.ts": "~/shared/domain/ids",
  "renderer/alias-dotdot-into-shared.ts": "~/renderer/../shared/domain/ids",
  "renderer/relative-into-shared.ts": "../shared/domain/ids",
} as const;

type Fixture = keyof typeof FIXTURES;

let root = "";
let lint: { status: number | null; stderr: string; files: number; flagged: Set<string> };

const RULE = "constellation(process-boundary)";

/** Reads `vp lint --format json`: how many files it linted and which ones broke the rule. */
const parseLint = (stdout: string) => {
  const report: unknown = JSON.parse(stdout);
  if (typeof report !== "object" || report === null)
    throw new Error(`not a lint report: ${stdout}`);
  if (!("number_of_files" in report) || typeof report.number_of_files !== "number")
    throw new Error(`no number_of_files: ${stdout}`);
  if (!("diagnostics" in report) || !Array.isArray(report.diagnostics))
    throw new Error(`no diagnostics: ${stdout}`);
  const diagnostics: unknown[] = report.diagnostics;
  const flagged = new Set<string>();
  for (const d of diagnostics) {
    if (typeof d !== "object" || d === null) continue;
    if ("code" in d && d.code === RULE && "filename" in d && typeof d.filename === "string")
      flagged.add(d.filename);
  }
  return { files: report.number_of_files, flagged };
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "process-boundary-"));
  const files = Object.entries(FIXTURES).map(([path, spec]) => {
    const file = join(root, "src", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `export * from "${spec}";\n`);
    return file;
  });
  const run = spawnSync("npx", ["vp", "lint", "--format", "json", ...files], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  lint = { status: run.status, stderr: run.stderr, ...parseLint(run.stdout) };
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const flagged = (fixture: Fixture): boolean => lint.flagged.has(join(root, "src", fixture));

describe("constellation/process-boundary", () => {
  it("lints every fixture and fails on the reported ones", () => {
    expect(lint.files, lint.stderr).toBe(Object.keys(FIXTURES).length);
    expect(lint.status, lint.stderr).toBe(1);
  });

  it.each<Fixture>([
    "shared/alias-cross.ts",
    "shared/alias-dotdot-cross.ts",
    "shared/relative-cross.ts",
    "shared/alias-case-cross.ts",
  ])("reports %s", (fixture) => expect(flagged(fixture)).toBe(true));

  it.each<Fixture>([
    "shared/domain/alias-dotdot-same.ts",
    "shared/domain/relative-same.ts",
    "renderer/alias-into-shared.ts",
    "renderer/alias-dotdot-into-shared.ts",
    "renderer/relative-into-shared.ts",
  ])("allows %s", (fixture) => expect(flagged(fixture)).toBe(false));
});
