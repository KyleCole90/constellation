import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import config from "../vite.config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Enforcers {
  scripts: ReadonlySet<string>;
  /** Lint rules switched on as errors, anywhere in the config. oxlint itself rejects a rule name that doesn't exist. */
  lintRules: ReadonlySet<string>;
  lintPlugins: ReadonlySet<string>;
  compilerOptions: ReadonlySet<string>;
  exists(path: string): boolean;
}

interface Row {
  rule: string;
  enforcedBy: readonly string[];
}

/** The rows of the "Rules and what enforces them" table, with each enforcer cell's backticked names. */
const tableRows = (markdown: string): readonly Row[] => {
  const section = markdown
    .split(/^## /m)
    .find((part) => part.startsWith("Rules and what enforces them"));
  if (!section) return [];
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => {
      const [rule = "", enforcedBy = ""] = line
        .split("|")
        .slice(1)
        .map((cell) => cell.trim());
      return { rule, enforcedBy: [...enforcedBy.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "") };
    });
};

const missing = (name: string, enforcers: Enforcers): string | null => {
  const script = /^npm run (\S+)$/.exec(name);
  if (script) return enforcers.scripts.has(script[1] ?? "") ? null : "no such npm script";
  const lint = /^([a-z-]+)\/([a-z*-]+)$/.exec(name);
  if (lint && enforcers.lintPlugins.has(lint[1] ?? "")) {
    const prefix = name.endsWith("*") ? name.slice(0, -1) : null;
    const on = prefix
      ? [...enforcers.lintRules].some((rule) => rule.startsWith(prefix))
      : enforcers.lintRules.has(name);
    return on ? null : "not an error in vite.config.ts lint";
  }
  if (/^[a-z][A-Za-z]+$/.test(name) && !enforcers.exists(name))
    return enforcers.compilerOptions.has(name) ? null : "not on in tsconfig.base.json";
  return enforcers.exists(name) ? null : "no such file";
};

const unenforced = (markdown: string, enforcers: Enforcers): readonly string[] =>
  tableRows(markdown).flatMap((row) =>
    row.enforcedBy.length === 0
      ? [`${row.rule}: names no enforcer`]
      : row.enforcedBy.flatMap((name) => {
          const reason = missing(name, enforcers);
          return reason ? [`${row.rule}: \`${name}\` ${reason}`] : [];
        }),
  );

const isError = (setting: unknown): boolean => {
  const level = Array.isArray(setting) ? (setting as readonly unknown[])[0] : setting;
  return level === "error" || level === "deny" || level === 2;
};

const errorRules = (rules: Record<string, unknown> | undefined): readonly string[] =>
  Object.entries(rules ?? {})
    .filter(([, setting]) => isError(setting))
    .map(([name]) => name);

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const objectAt = (value: unknown, key: string): Record<string, unknown> => {
  const inner = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return typeof inner === "object" && inner !== null ? { ...inner } : {};
};

const lint = config.lint ?? {};
const REAL: Enforcers = {
  scripts: new Set(Object.keys(objectAt(readJson("package.json"), "scripts"))),
  lintRules: new Set([
    ...errorRules(lint.rules),
    ...(lint.overrides ?? []).flatMap((override) => errorRules(override.rules)),
  ]),
  lintPlugins: new Set([...(lint.plugins ?? []), "constellation", "shadcn"]),
  compilerOptions: new Set(
    Object.entries(objectAt(readJson("tsconfig.base.json"), "compilerOptions"))
      .filter(([, value]) => value === true)
      .map(([name]) => name),
  ),
  exists: (path) => existsSync(join(ROOT, path)),
};

const CLAUDE_MD = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");

describe("the CLAUDE.md enforcement table", () => {
  it("names only enforcers that exist", () => {
    expect(unenforced(CLAUDE_MD, REAL)).toEqual([]);
  });

  it("is the table this test reads", () => {
    expect(tableRows(CLAUDE_MD).length).toBeGreaterThan(10);
  });

  it("catches a missing rule, file, script and compiler option, and a row with no enforcer", () => {
    const table = [
      "## Rules and what enforces them",
      "| Rule | Enforced by |",
      "| --- | --- |",
      "| a | `constellation/no-such-rule` |",
      "| b | `typescript/no-such-*` |",
      "| c | `tests/no-such.test.ts` |",
      "| d | `npm run no-such-script` |",
      "| e | `noSuchOption` |",
      "| f | a reviewer |",
      "| g | `eslint/no-console`, `npm run check`, `scripts/lint-plugin.mjs`, `noImplicitReturns` |",
    ].join("\n");
    expect(unenforced(table, REAL)).toEqual([
      "a: `constellation/no-such-rule` not an error in vite.config.ts lint",
      "b: `typescript/no-such-*` not an error in vite.config.ts lint",
      "c: `tests/no-such.test.ts` no such file",
      "d: `npm run no-such-script` no such npm script",
      "e: `noSuchOption` not on in tsconfig.base.json",
      "f: names no enforcer",
    ]);
  });
});
