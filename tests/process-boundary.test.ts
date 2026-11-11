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
  "shared/domain/alias-dotdot-same.ts": "~/shared/../shared/domain/ids",
  "shared/domain/relative-same.ts": "./ids",
  "renderer/alias-into-shared.ts": "~/shared/domain/ids",
  "renderer/alias-dotdot-into-shared.ts": "~/renderer/../shared/domain/ids",
  "renderer/relative-into-shared.ts": "../shared/domain/ids",
} as const;

type Fixture = keyof typeof FIXTURES;

let root = "";
let output = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "process-boundary-"));
  const files = Object.entries(FIXTURES).map(([path, spec]) => {
    const file = join(root, "src", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `export * from "${spec}";\n`);
    return file;
  });
  output = spawnSync("npx", ["vp", "lint", ...files], { encoding: "utf8" }).stdout;
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const flagged = (fixture: Fixture): boolean =>
  output
    .split("\n")
    .some(
      (line) =>
        line.startsWith(join(root, "src", fixture)) &&
        line.includes("constellation(process-boundary)"),
    );

describe("constellation/process-boundary", () => {
  it.each<Fixture>([
    "shared/alias-cross.ts",
    "shared/alias-dotdot-cross.ts",
    "shared/relative-cross.ts",
  ])("reports %s", (fixture) => expect(flagged(fixture)).toBe(true));

  it.each<Fixture>([
    "shared/domain/alias-dotdot-same.ts",
    "shared/domain/relative-same.ts",
    "renderer/alias-into-shared.ts",
    "renderer/alias-dotdot-into-shared.ts",
    "renderer/relative-into-shared.ts",
  ])("allows %s", (fixture) => expect(flagged(fixture)).toBe(false));
});
