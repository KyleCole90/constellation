import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import config from "../vite.config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULES = ["annotated-schemas", "no-as-never", "no-json-parse-cast"] as const;

const FIXTURES: Readonly<Record<string, string>> = {
  "src/shared/providers/schemas.ts": `
import * as v from "valibot";
type FieldOutcome = { field: string; ok: boolean };
type IsoTime = string & { readonly __brand: "IsoTime" };
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type LatePenalty = { days: number };
export const brand = <T extends string>(check: (raw: string) => boolean = () => true) =>
  v.custom<T>((input) => typeof input === "string" && check(input));
export const IsoTimeSchema: v.GenericSchema<IsoTime> = brand<IsoTime>((raw) => raw !== "");
export const FieldOutcomeSchema = v.object({ field: v.string(), ok: v.boolean() }); // flagged: annotated-schemas
export const FieldOutcomesSchema: v.GenericSchema<readonly FieldOutcome[]> = v.custom<readonly FieldOutcome[]>(Array.isArray); // flagged: annotated-schemas
export const WeekdaySchema: v.GenericSchema<Weekday> = v.picklist([0, 1, 2, 3, 4, 5, 6]);
export const LatePenaltySchema = v.object({ days: v.number() }) satisfies v.GenericSchema<LatePenalty>;
`,
  "src/shared/ipc.ts": `
import * as v from "valibot";
const VaultKeySchema = v.picklist(["anthropic", "canvas"]); // flagged: annotated-schemas
const AgentSourceSchema = v.picklist(["none", "key", "claude-code"]);
export type AgentSource = v.InferOutput<typeof AgentSourceSchema>;
export const keys = VaultKeySchema;
`,
  "src/shared/providers/fake-canvas/lab.ts": `
import * as v from "valibot";
export const NoiseSchema = v.object({ latencyMs: v.number() }); // flagged: annotated-schemas
`,
  "src/shared/providers/fake-canvas/server.ts": `
import * as v from "valibot";
export const RowSchema = v.custom<{ id: string }>(() => true);
`,
  "tests/agent.test.ts": `
const LCC = "lcc";
declare const openSubmission: (school: string) => void;
openSubmission("lcc" as never); // flagged: no-as-never
openSubmission(<never>"lcc"); // flagged: no-as-never
openSubmission(LCC);
`,
  "src/renderer/stores/workspace.test.ts": `
declare const select: (id: string) => void;
select("" as never); // flagged: no-as-never
export const saved = JSON.parse("{}") as { version: number }; // flagged: no-json-parse-cast
`,
  "src/renderer/stores/workspace.ts": `
export const pick = (value: unknown) => value as never;
`,
  "tests/north-star.test.ts": `
type Saved = { version: number };
declare const raw: string;
export const cast = JSON.parse(raw) as Saved; // flagged: no-json-parse-cast
export const parsed: unknown = JSON.parse(raw);
export const unknownCast = JSON.parse(raw) as unknown;
`,
  "bench/sources.ts": `
declare const text: string;
export const body = JSON.parse(text) as { ok: boolean }; // flagged: no-json-parse-cast
`,
};

const Report = v.object({
  number_of_files: v.number(),
  diagnostics: v.array(
    v.object({
      code: v.string(),
      filename: v.string(),
      labels: v.array(v.object({ span: v.object({ line: v.number() }) })),
    }),
  ),
});

const expected = (): readonly string[] =>
  Object.entries(FIXTURES).flatMap(([path, source]) =>
    source.split("\n").flatMap((line, index) => {
      const rule = /\/\/ flagged: (\S+)$/.exec(line)?.[1];
      return rule ? [`${path}:${index + 1} ${rule}`] : [];
    }),
  );

let root = "";
let lint: { status: number | null; stderr: string; files: number; reported: readonly string[] };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "schema-and-test-cast-lint-"));
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
    reported: report.diagnostics.flatMap((d) => {
      const rule = RULES.find((name) => d.code === `constellation(${name})`);
      return rule ? d.labels.map((label) => `${d.filename}:${label.span.line} ${rule}`) : [];
    }),
  };
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the schema and test-cast lint rules", () => {
  it("lints every fixture", () => {
    expect(lint.files, lint.stderr).toBe(Object.keys(FIXTURES).length);
  });

  it("report exactly the flagged lines, in the files each rule covers", () => {
    expect([...lint.reported].sort()).toEqual([...expected()].sort());
  });
});
