import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import config from "../vite.config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BLOCKED_FIXTURES: Readonly<Record<string, string>> = {
  "src/renderer/telemetry.ts": 'import posthog from "posthog-js";\nexport const p = posthog;\n',
  "src/shared/telemetry.ts":
    'import { PostHog } from "@posthog/core";\nexport const p = PostHog;\n',
  "src/main/extra.ts": 'import { PostHog } from "posthog-node";\nexport const p = PostHog;\n',
  "src/main/index.ts": 'import { PostHog } from "posthog-node";\nexport const p = PostHog;\n',
  "src/preload/extra.ts":
    'import posthog from "posthog-js/dist/module";\nexport const p = posthog;\n',
  "src/preload/index.ts": 'import posthog from "posthog-js";\nexport const p = posthog;\n',
  "scripts/check-ph.mjs": 'import { PostHog } from "posthog-node";\nexport const p = PostHog;\n',
  "tests/ph.test.ts": 'import posthog from "posthog-js";\nexport const p = posthog;\n',
};

const ALLOWED_FIXTURES: Readonly<Record<string, string>> = {
  "src/shared/clean.ts": 'import * as v from "valibot";\nexport const s = v.string();\n',
};

const FIXTURES: Readonly<Record<string, string>> = {
  ...BLOCKED_FIXTURES,
  ...ALLOWED_FIXTURES,
};

const Report = v.object({
  number_of_files: v.number(),
  diagnostics: v.array(
    v.object({
      code: v.string(),
      filename: v.string(),
      help: v.optional(v.string()),
    }),
  ),
});

let root = "";
let lint: { status: number | null; stderr: string; files: number; flagged: Set<string> };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "no-posthog-sdk-lint-"));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  const lintConfig = config.lint ?? {};
  writeFileSync(
    join(root, ".oxlintrc.json"),
    JSON.stringify({
      ...lintConfig,
      jsPlugins: (lintConfig.jsPlugins ?? []).map((plugin) =>
        typeof plugin === "string" && plugin.startsWith(".") ? join(ROOT, plugin) : plugin,
      ),
      options: { ...lintConfig.options, typeAware: false },
    }),
  );
  for (const [path, source] of Object.entries(FIXTURES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  const run = spawnSync(
    join(ROOT, "node_modules/.bin/oxlint"),
    ["-c", ".oxlintrc.json", "--format", "json", ...Object.keys(FIXTURES)],
    { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } },
  );
  const report = v.parse(Report, JSON.parse(run.stdout));
  lint = {
    status: run.status,
    stderr: run.stderr,
    files: report.number_of_files,
    flagged: new Set(
      report.diagnostics
        .filter(
          (d) =>
            d.code === "eslint(no-restricted-imports)" && (d.help ?? "").includes("No PostHog SDK"),
        )
        .map((d) => d.filename),
    ),
  };
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("eslint/no-restricted-imports forbids PostHog SDK in every scope", () => {
  it("lints every fixture", () => {
    expect(lint.files, lint.stderr).toBe(Object.keys(FIXTURES).length);
    expect(lint.status, lint.stderr).toBe(1);
  });

  it.each(Object.keys(BLOCKED_FIXTURES))("rejects PostHog SDK import in %s", (path) => {
    expect(lint.flagged.has(path)).toBe(true);
  });

  it.each(Object.keys(ALLOWED_FIXTURES))("allows non-PostHog import in %s", (path) => {
    expect(lint.flagged.has(path)).toBe(false);
  });
});
