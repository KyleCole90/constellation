import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { GRADE_DRAFTS, type GradeDraft } from "~/shared/agent/rules/drafts";
import { FINDING_TYPES } from "~/shared/domain/scan";
import { SEED, type SeedPiece } from "~/shared/providers/fake-canvas/seed";
import { HOSTS, PACKAGES, SOURCES } from "~/shared/providers/fake-canvas/seed-term";

import { permitFor } from "./fixtures/provider-contract";
import { LCC, RSU } from "./fixtures/rig";
import { cartridgeContent, copyContent, makeTermRig, planFor } from "./fixtures/term";

const IMSCC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "imscc");

const pieces: readonly SeedPiece[] = SEED.courses.flatMap((course) =>
  course.assignments.flatMap((assignment) => assignment.pieces ?? []),
);
const pieceFor = (title: string, draft: GradeDraft): SeedPiece | undefined =>
  pieces.find((piece) => piece.title === title && (piece.doc[0] ?? "").startsWith(draft.opens));
const drafts = Object.entries(GRADE_DRAFTS).flatMap(([title, list]) =>
  list.map((draft) => ({ title, draft })),
);

describe("the grade draft bank", () => {
  it("has a draft for every seeded piece of work", () => {
    expect(drafts.length).toBeGreaterThan(0);
    for (const piece of pieces)
      expect(
        GRADE_DRAFTS[piece.title]?.some((draft) => (piece.doc[0] ?? "").startsWith(draft.opens)),
        piece.title,
      ).toBe(true);
  });

  it("every anchor quote is a verbatim substring of its paragraph", () => {
    let checked = 0;
    for (const { title, draft } of drafts) {
      const piece = pieceFor(title, draft);
      expect(piece, title).toBeDefined();
      for (const [criterion, anchors] of Object.entries(draft.anchors)) {
        for (const { paragraph, quote } of anchors) {
          expect(piece?.doc[paragraph], `${title} / ${criterion}: ${quote}`).toContain(quote);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("every rubric rationale has at least one quote", () => {
    for (const { title, draft } of drafts) {
      for (const criterion of Object.keys(draft.why))
        expect(draft.anchors[criterion]?.length ?? 0, `${title} / ${criterion}`).toBeGreaterThan(0);
    }
  });

  it("the provider's seed carries no agent-facing fields", () => {
    expect(JSON.stringify(SEED)).not.toMatch(/"(why|attach|anchors|drafts?)":/);
  });
});

describe("the seed", () => {
  it("every course has a posted announcement", () => {
    for (const course of SEED.courses)
      expect(course.announcements.length, course.code).toBeGreaterThan(0);
  });

  it("at least one conversation has thread history", () => {
    expect(
      SEED.courses
        .flatMap((course) => course.messages)
        .some((message) => message.history.length > 0),
    ).toBe(true);
  });

  it("the demo clock starts where the mockup does", () => {
    expect(SEED.now).toBe("2026-10-30T11:42");
  });
});

describe("the sample packages", () => {
  it("exist as real zip files named exactly as the LMS lists them", () => {
    const files = readdirSync(IMSCC_DIR)
      .filter((name) => name.endsWith(".imscc"))
      .sort();
    expect(files).toEqual(PACKAGES.map((pkg) => pkg.name).sort());
    for (const name of files)
      expect(readFileSync(join(IMSCC_DIR, name)).subarray(0, 2).toString("latin1"), name).toBe(
        "PK",
      );
  });
});

describe("the new-term seed", () => {
  const SHELL_FOR: Readonly<Record<string, string>> = { lcc: "ENG 101", rsu: "ENG 210" };

  /** Copies one source into an empty shell, lets the job finish, and scans the result the way the app would. */
  const typesAfterCopying = async (
    school: "lcc" | "rsu",
    make: (shell: Awaited<ReturnType<typeof rigShell>>["shell"]) => ReturnType<typeof copyContent>,
  ) => {
    const { rig, shell } = await rigShell(school);
    const content = make(shell);
    const outcomes = await rig
      .provider(school === "lcc" ? LCC : RSU)
      .apply(
        await permitFor(
          rig.provider(school === "lcc" ? LCC : RSU),
          content,
          ["copy"],
          school === "lcc" ? LCC : RSU,
        ),
      );
    expect(outcomes.copy?.status).toBe("landed");
    const jobs = await rig.finishJobs(school === "lcc" ? LCC : RSU, shell.ref);
    expect(jobs.map((job) => job.state)).toEqual(["completed"]);
    const { findings } = await rig.scan(
      school === "lcc" ? LCC : RSU,
      shell.ref,
      content.plan,
      jobs[0]?.issues ?? [],
    );
    return new Set(findings.map((finding) => finding.type));
  };
  const rigShell = async (school: "lcc" | "rsu") => {
    const rig = await makeTermRig();
    const shell = await rig.shellNamed(school === "lcc" ? LCC : RSU, SHELL_FOR[school] ?? "");
    return { rig, shell };
  };

  it.each(
    SOURCES.map(
      (source) => [`${source.school} ${source.code} ${source.term.name}`, source] as const,
    ),
  )("%s plants every finding type", async (_, source) => {
    const school = source.school as "lcc" | "rsu";
    const { rig } = await rigShell(school);
    const found = await rig.sourceNamed(
      school === "lcc" ? LCC : RSU,
      source.code,
      source.term.name,
    );
    const types = await typesAfterCopying(school, (shell) =>
      copyContent(shell, found, planFor(source.term, shell)),
    );
    expect([...FINDING_TYPES].filter((type) => !types.has(type))).toEqual([]);
  });

  /** A link into another school's host can only ever be "another course"; nothing on this host can tell whether it is broken. */
  const UNCHECKABLE_FROM_ANOTHER_HOST = ["broken-link", "missing-file", "lti-link"];

  it.each(PACKAGES.filter((pkg) => pkg.body !== null).map((pkg) => [pkg.name, pkg] as const))(
    "%s plants every finding type its host allows",
    async (_, pkg) => {
      const hint = pkg.hint;
      if (!hint) throw new Error("a readable package carries a term hint");
      const types = await typesAfterCopying("lcc", (shell) =>
        cartridgeContent(shell, pkg.name, hint, pkg.kb),
      );
      const unreachable = pkg.host === HOSTS["lcc"] ? [] : UNCHECKABLE_FROM_ANOTHER_HOST;
      expect([...FINDING_TYPES].filter((type) => !types.has(type))).toEqual(unreachable);
      expect(types.has("old-course-link")).toBe(true);
    },
  );

  it("the course that is already in use has students and content, and the empty ones have neither", async () => {
    const rig = await makeTermRig();
    const occupied = await rig.shellNamed(RSU, "HUM 150");
    expect(occupied.studentCount).toBe(14);
    expect(occupied.itemCount).toBe(3);
    for (const shell of [
      await rig.shellNamed(LCC, "ENG 101"),
      await rig.shellNamed(LCC, "COMM 110"),
      await rig.shellNamed(RSU, "ENG 210"),
    ]) {
      expect(shell.studentCount, shell.code).toBe(0);
      expect(shell.itemCount, shell.code).toBe(0);
    }
  });

  it("every seeded address and host belongs to an invented school", () => {
    const text = JSON.stringify({ SOURCES, PACKAGES });
    const hosts = [...text.matchAll(/[\w.-]+\.(?:edu|com)\b/g)].map((match) => match[0]);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of new Set(hosts))
      expect(host).toMatch(
        /^(?:[\w-]+\.)*(?:lakeshore|riverbend|northgate)\.(?:edu|instructure\.com)$/,
      );
  });
});
