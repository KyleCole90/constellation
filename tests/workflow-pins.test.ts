import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const WORKFLOWS = resolve(import.meta.dirname, "../.github/workflows");
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

const unpinned = (text: string): readonly string[] =>
  [...text.matchAll(/^\s*-?\s*uses:\s*(.+?)\s*$/gm)]
    .map((match) => match[1] ?? "")
    .filter((action) => !action.startsWith("./") && !PINNED.test(action));

describe("workflow actions", () => {
  it("each run a full commit SHA with its release beside it, the form Dependabot updates", () => {
    const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    expect(
      files.flatMap((name) =>
        unpinned(readFileSync(join(WORKFLOWS, name), "utf8")).map((action) => `${name}: ${action}`),
      ),
    ).toEqual([]);
  });

  it("refuse a tag, a branch, a short SHA or a SHA with no release beside it", () => {
    const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
    expect(
      unpinned(
        [
          "      - uses: actions/checkout@v7",
          "      - uses: actions/checkout@main",
          "      - uses: actions/checkout@3d3c42e",
          `      - uses: actions/checkout@${sha}`,
          `      - uses: actions/checkout@${sha} # v7.0.1`,
          "        uses: ./.github/actions/local",
        ].join("\n"),
      ),
    ).toEqual([
      "actions/checkout@v7",
      "actions/checkout@main",
      "actions/checkout@3d3c42e",
      `actions/checkout@${sha}`,
    ]);
  });
});
