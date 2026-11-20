import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

type Rule = "no-double-assertion" | "no-brand-cast" | "use-iso-time";

const FIXTURES: Record<string, { code: string; breaks: readonly Rule[] }> = {
  "src/renderer/stores/load.ts": {
    code: "export const v = ({ state, version: 3 } as unknown as StorageValue<WorkspaceData>);",
    breaks: ["no-double-assertion"],
  },
  "src/shared/providers/lms.ts": {
    code: "export const read = (state: object) => state as unknown as LmsState;",
    breaks: ["no-double-assertion"],
  },
  "src/shared/narrow.ts": {
    code: "export const t = (draft: object) => draft as Partial<Thread> as Thread;",
    breaks: ["no-double-assertion"],
  },
  "src/shared/forged.ts": {
    code: "// forged: shipped code has no forgeries\nexport const w = {} as unknown as ApprovalWitness;",
    breaks: ["no-double-assertion"],
  },
  "tests/partial.test.ts": {
    code: "export const row = { student: { name: 'Bea' } } as unknown as GradebookRow;",
    breaks: ["no-double-assertion"],
  },
  "tests/forged.test.ts": {
    code: "// forged: a witness no approval made\nexport const w = { covers: () => true } as unknown as ApprovalWitness;",
    breaks: [],
  },
  "src/renderer/components/forged.test.ts": {
    code: "export const permits = [\n  // forged: permits mintSendPermit never made\n  ...([{}] as unknown as SendPermit[]),\n];",
    breaks: [],
  },
  "src/renderer/stores/selectors.ts": {
    code: 'export const INBOX = "t-inbox" as ThreadId;',
    breaks: ["no-brand-cast"],
  },
  "src/shared/domain/setup.ts": {
    code: "export const keys = (fixes: object) => Object.keys(fixes) as readonly FindingKey[];",
    breaks: ["no-brand-cast"],
  },
  "tests/course.test.ts": {
    code: 'export const course = (ref: string) => ref as LmsRef<"course"> | undefined;',
    breaks: ["no-brand-cast"],
  },
  "src/shared/domain/ids.ts": {
    code: 'export const parseSchoolId = (raw: string) => (raw === "" ? null : (raw as SchoolId));',
    breaks: [],
  },
  "tests/fixtures/ids.ts": {
    code: "export const threadId = (text: string): ThreadId => text as ThreadId;",
    breaks: [],
  },
  "tests/fixtures/not-ids.ts": {
    code: "export const threadId = (text: string): ThreadId => text as ThreadId;",
    breaks: ["no-brand-cast"],
  },
  "tests/north-star.test.ts": {
    code: 'export const at = "2026-10-30T09:00:00" as IsoTime;',
    breaks: ["use-iso-time"],
  },
  "tests/fixtures/rig.ts": {
    code: "export const now = (ms: number) => new Date(ms).toISOString() as IsoTime;",
    breaks: ["use-iso-time"],
  },
  "src/shared/domain/term.ts": {
    code: "export const at = `2026-10-30T09:00:00.000Z` as IsoTime;",
    breaks: ["use-iso-time"],
  },
  "tests/minted.test.ts": {
    code: 'export const at = isoTime("2026-10-30T09:00:00Z");',
    breaks: [],
  },
  "tests/moved.test.ts": {
    code: "export const at = (date: string, time: string) => `${date}${time}` as IsoTime;",
    breaks: ["no-brand-cast"],
  },
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const declaredBrands = (): readonly string[] => {
  const files = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts"),
  );
  return files.flatMap((file) =>
    [
      ...readFileSync(join(ROOT, "src", file), "utf8").matchAll(
        /^export type (\w+)(?:<[^>]*>)? = Brand</gm,
      ),
    ].map((match) => match[1] ?? ""),
  );
};
const BRANDS = declaredBrands();
const brandFixture = (brand: string) => `src/shared/brand-${brand}.ts`;

let root = "";
let lint: { status: number | null; stderr: string; files: number; flagged: Map<string, Rule[]> };

const RULE = /^constellation\((no-double-assertion|no-brand-cast|use-iso-time)\)$/;
const isRule = (name: string): name is Rule =>
  name === "no-double-assertion" || name === "no-brand-cast" || name === "use-iso-time";

const parseLint = (stdout: string) => {
  const report: unknown = JSON.parse(stdout);
  if (typeof report !== "object" || report === null)
    throw new Error(`not a lint report: ${stdout}`);
  if (!("number_of_files" in report) || typeof report.number_of_files !== "number")
    throw new Error(`no number_of_files: ${stdout}`);
  if (!("diagnostics" in report) || !Array.isArray(report.diagnostics))
    throw new Error(`no diagnostics: ${stdout}`);
  const diagnostics: unknown[] = report.diagnostics;
  const flagged = new Map<string, Rule[]>();
  for (const d of diagnostics) {
    if (typeof d !== "object" || d === null) continue;
    if (!("code" in d) || typeof d.code !== "string") continue;
    if (!("filename" in d) || typeof d.filename !== "string") continue;
    const rule = RULE.exec(d.code)?.[1] ?? "";
    if (isRule(rule)) flagged.set(d.filename, [...(flagged.get(d.filename) ?? []), rule]);
  }
  return { files: report.number_of_files, flagged };
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "assertion-rules-"));
  const sources = {
    ...Object.fromEntries(Object.entries(FIXTURES).map(([path, { code }]) => [path, code])),
    ...Object.fromEntries(
      BRANDS.map((brand) => [
        brandFixture(brand),
        `export const b = (x: string) => x as ${brand};`,
      ]),
    ),
  };
  const files = Object.entries(sources).map(([path, code]) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${code}\n`);
    return file;
  });
  const run = spawnSync("npx", ["vp", "lint", "--format", "json", ...files], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  lint = { status: run.status, stderr: run.stderr, ...parseLint(run.stdout) };
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const broken = (path: string): readonly Rule[] => [...(lint.flagged.get(join(root, path)) ?? [])];

describe("the assertion rules", () => {
  it("lint every fixture", () => {
    expect(lint.files, lint.stderr).toBe(Object.keys(FIXTURES).length + BRANDS.length);
  });

  it.each(Object.entries(FIXTURES))("%s breaks exactly its rules", (path, { breaks }) =>
    expect(broken(path)).toEqual(breaks),
  );

  it("know every brand src declares", () => {
    expect(BRANDS).toContain("ThreadId");
    expect(
      BRANDS.filter((brand) => !broken(brandFixture(brand)).includes("no-brand-cast")),
    ).toEqual([]);
  });
});
