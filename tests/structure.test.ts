import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { CLASS_TOKENS, cn } from "../src/renderer/lib/utils";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

const filesUnder = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

interface SourceFile {
  path: string;
  text: string;
  imports: readonly { spec: string; clause: string }[];
}

const IMPORT =
  /(?:import|export)\s+([^'"`;]*?)\s*from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

/** Resolves every form of an import to a path under src, so a relative import cannot dodge an alias check. */
const resolveSpec = (spec: string, from: string): string => {
  if (spec.startsWith("~/")) return spec.slice(2);
  if (spec.startsWith(".")) return relative(SRC, resolve(dirname(from), spec));
  return `npm:${spec}`;
};

const load = (path: string): SourceFile => {
  const text = readFileSync(path, "utf8");
  const imports = [...text.matchAll(IMPORT)].map((match) => ({
    clause: match[1] ?? "",
    spec: resolveSpec(match[2] ?? match[3] ?? match[4] ?? "", path),
  }));
  return { path: relative(SRC, path), text, imports };
};

const SOURCES = filesUnder(SRC).map(load);
const startsWith = (file: SourceFile, dir: string) =>
  file.path === dir || file.path.startsWith(`${dir}/`);

/** True when this import brings in a runtime value of this name, or the whole module under a namespace. */
const bringsValue = (clause: string, name: string): boolean => {
  if (clause.startsWith("type ")) return false;
  if (/\*\s+as\s+/.test(clause)) return true;
  const named = clause.match(/\{([^}]*)\}/)?.[1] ?? "";
  return named.split(",").some((item) => {
    const trimmed = item.trim();
    return !trimmed.startsWith("type ") && trimmed.split(/\s+as\s+/)[0] === name;
  });
};

const mintingFiles = (sources: readonly SourceFile[]): readonly string[] =>
  sources
    .filter(
      (file) =>
        file.path !== "shared/domain/approval.ts" &&
        file.path !== "renderer/components/ApproveButton.tsx",
    )
    .filter((file) => {
      const imports = file.imports.some(
        (entry) =>
          entry.spec === "shared/domain/approval" &&
          /\*\s+as\s+/.test(entry.clause) &&
          !entry.clause.startsWith("type "),
      );
      return imports || /\bfrom(Click|Chord)\b/.test(file.text);
    })
    .map((file) => file.path);

const witnessValueImporters = (sources: readonly SourceFile[]): readonly string[] =>
  sources
    .filter((file) =>
      file.imports.some(
        (entry) =>
          entry.spec === "shared/domain/approval" && bringsValue(entry.clause, "ApprovalWitness"),
      ),
    )
    .map((file) => file.path);

const permitImporters = (sources: readonly SourceFile[]): readonly string[] =>
  sources
    .filter(
      (file) => !startsWith(file, "renderer/writeback") && file.path !== "shared/domain/permit.ts",
    )
    .filter((file) =>
      file.imports.some(
        (entry) =>
          entry.spec === "shared/domain/permit" &&
          (bringsValue(entry.clause, "mintSendPermit") || /\bSendPermit\.mint\b/.test(file.text)),
      ),
    )
    .map((file) => file.path);

const FORBIDDEN_FOR_AGENT = [
  "renderer/stores",
  "renderer/writeback",
  "shared/providers/fake-canvas",
  "renderer/providers/vault",
];
const agentViolations = (sources: readonly SourceFile[]): readonly string[] =>
  sources
    .filter((file) => startsWith(file, "shared/agent"))
    .flatMap((file) =>
      file.imports
        .filter((entry) =>
          FORBIDDEN_FOR_AGENT.some((dir) => entry.spec === dir || entry.spec.startsWith(`${dir}/`)),
        )
        .map((entry) => `${file.path} -> ${entry.spec}`),
    );

const isScreen = (file: SourceFile) =>
  (startsWith(file, "renderer/components") || startsWith(file, "renderer/routes")) &&
  !/\.test\.tsx?$/.test(file.path);
const screensMatching = (sources: readonly SourceFile[], pattern: RegExp): readonly string[] =>
  sources
    .filter(isScreen)
    .filter((file) => pattern.test(file.text))
    .map((file) => file.path);
const BUILD_MODE = /import\.meta\.env\.MODE/;
const aiSourceReaders = (sources: readonly SourceFile[]): readonly string[] =>
  sources
    .filter((file) => /\baiSource\b/.test(file.text))
    .map((file) => file.path)
    .sort();
const VENDOR_WORD = /\b(?:Canvas|Moodle|Blackboard)\b/;
const STATE_BRANCH = /\bstate\.tag\b|\b(?:record|change)\.state\b/;
const providerImplementationImporters = (sources: readonly SourceFile[]): readonly string[] =>
  sources
    .filter(isScreen)
    .filter((file) =>
      file.imports.some(
        (entry) =>
          /^(shared|renderer)\/providers\//.test(entry.spec) &&
          entry.spec !== "shared/providers/provider",
      ),
    )
    .map((file) => file.path);

const fakeFile = (path: string, text: string): SourceFile => {
  const absolute = join(SRC, path);
  return {
    path,
    text,
    imports: [...text.matchAll(IMPORT)].map((match) => ({
      clause: match[1] ?? "",
      spec: resolveSpec(match[2] ?? match[3] ?? match[4] ?? "", absolute),
    })),
  };
};

describe("who may read a secret", () => {
  it("nothing but the vault, the provider layer and the store's validity check calls revealSecret", () => {
    const allowed = (path: string) =>
      path.startsWith("shared/providers/") ||
      path.startsWith("renderer/providers/") ||
      path === "renderer/stores/workspace.ts";
    expect(
      SOURCES.filter((file) => /\brevealSecret\b/.test(file.text) && !allowed(file.path)).map(
        (file) => file.path,
      ),
    ).toEqual([]);
  });
});

describe("who may approve", () => {
  it("nothing outside ApproveButton touches fromClick", () => {
    expect(mintingFiles(SOURCES)).toEqual([]);
  });

  it("only ApproveButton and the state machine import the witness class as a value", () => {
    expect(
      witnessValueImporters(SOURCES).filter(
        (path) => path !== "renderer/components/ApproveButton.tsx",
      ),
    ).toEqual(["shared/domain/change.ts"]);
  });

  it("the check catches a screen calling fromClick", () => {
    const screen = fakeFile(
      "renderer/routes/evil.tsx",
      'import { ApprovalWitness } from "~/shared/domain/approval";\nApprovalWitness.fromClick(event, targets);',
    );
    expect(mintingFiles([screen])).toEqual(["renderer/routes/evil.tsx"]);
    expect(witnessValueImporters([screen])).toEqual(["renderer/routes/evil.tsx"]);
  });

  it("the check catches a relative import and a namespace import", () => {
    const relativeImport = fakeFile(
      "renderer/stores/evil.ts",
      'import { ApprovalWitness as W } from "../../shared/domain/approval";',
    );
    const namespace = fakeFile(
      "renderer/stores/evil2.ts",
      'import * as approval from "~/shared/domain/approval";',
    );
    expect(witnessValueImporters([relativeImport])).toEqual(["renderer/stores/evil.ts"]);
    expect(mintingFiles([namespace])).toEqual(["renderer/stores/evil2.ts"]);
  });

  it("the check allows ApproveButton by its path", () => {
    expect(
      mintingFiles([
        fakeFile(
          "renderer/components/ApproveButton.tsx",
          'import { ApprovalWitness } from "~/shared/domain/approval";\nApprovalWitness.fromClick(e, t);',
        ),
      ]),
    ).toEqual([]);
  });

  it("a type-only import of the witness is fine", () => {
    expect(
      witnessValueImporters([
        fakeFile(
          "renderer/stores/fine.ts",
          'import type { ApprovalWitness } from "~/shared/domain/approval";',
        ),
      ]),
    ).toEqual([]);
  });
});

describe("who may mint a permit", () => {
  it("nothing outside src/renderer/writeback imports mintSendPermit", () => {
    expect(permitImporters(SOURCES)).toEqual([]);
  });

  it("src/renderer/writeback does import it, so this check is looking at the right module", () => {
    expect(
      SOURCES.filter((file) => startsWith(file, "renderer/writeback")).some((file) =>
        file.imports.some(
          (entry) =>
            entry.spec === "shared/domain/permit" && bringsValue(entry.clause, "mintSendPermit"),
        ),
      ),
    ).toBe(true);
  });

  it("the check catches a store importing it", () => {
    expect(
      permitImporters([
        fakeFile(
          "renderer/stores/evil.ts",
          'import { mintSendPermit } from "~/shared/domain/permit";',
        ),
      ]),
    ).toEqual(["renderer/stores/evil.ts"]);
  });

  it("the check catches a namespace import", () => {
    expect(
      permitImporters([
        fakeFile(
          "renderer/stores/evil.ts",
          'import * as permit from "../../shared/domain/permit";',
        ),
      ]),
    ).toEqual(["renderer/stores/evil.ts"]);
  });
});

describe("what the agent can reach", () => {
  it("src/shared/agent imports nothing from stores, writeback, or provider implementations", () => {
    expect(agentViolations(SOURCES)).toEqual([]);
  });

  it("the check catches each forbidden import, relative or aliased", () => {
    const evil = fakeFile(
      "shared/agent/evil.ts",
      'import { a } from "~/renderer/writeback/writeback";\nimport { b } from "../../renderer/stores/workspace";\nimport { c } from "~/shared/providers/fake-canvas/server";\nimport { d } from "../../renderer/providers/vault";\nconst e = import("~/renderer/stores/selectors");',
    );
    expect(agentViolations([evil])).toHaveLength(5);
  });
});

const SETUP_KIND = /course-copy|item-set/;
const agentNamingSetupKinds = (sources: readonly SourceFile[]): readonly string[] =>
  sources
    .filter((file) => startsWith(file, "shared/agent") && SETUP_KIND.test(file.text))
    .map((file) => file.path);

describe("what the agent can name", () => {
  it("src/shared/agent never names a copy or a setting kind, so no agent path can build one", () => {
    expect(agentNamingSetupKinds(SOURCES)).toEqual([]);
  });

  it("the check catches a kind written as a string or a type", () => {
    expect(
      agentNamingSetupKinds([
        fakeFile("shared/agent/evil.ts", 'const k = "course-copy";'),
        fakeFile("shared/agent/evil2.ts", 'type K = Extract<ChangeContent, { kind: "item-set" }>;'),
      ]),
    ).toEqual(["shared/agent/evil.ts", "shared/agent/evil2.ts"]);
  });
});

describe("how the app finds a vendor", () => {
  it("only the store's one wiring function and the provider folder name the fake LMS", () => {
    const named = SOURCES.filter(
      (file) =>
        !startsWith(file, "shared/providers/fake-canvas") &&
        file.imports.some((entry) => entry.spec.startsWith("shared/providers/fake-canvas")),
    ).map((file) => file.path);
    expect(named.sort()).toEqual([
      "renderer/stores/seedThreads.ts",
      "renderer/stores/workspace.ts",
    ]);
  });
});

describe("what a screen can know", () => {
  it("no screen says a vendor's name from code", () => {
    expect(screensMatching(SOURCES, VENDOR_WORD)).toEqual([]);
  });

  it("no screen branches on a change's state", () => {
    expect(screensMatching(SOURCES, STATE_BRANCH)).toEqual([]);
  });

  it("no screen imports a provider implementation", () => {
    expect(providerImplementationImporters(SOURCES)).toEqual([]);
  });

  it("only the store and the AI choice's own screens read the AI source", () => {
    expect(aiSourceReaders(SOURCES)).toEqual([
      "renderer/components/screens/WelcomeScreen.tsx",
      "renderer/components/settings/AiSection.tsx",
      "renderer/stores/types.ts",
      "renderer/stores/workspace.ts",
    ]);
  });

  it("no screen gates on the build mode", () => {
    expect(screensMatching(SOURCES, BUILD_MODE)).toEqual([]);
  });

  describe("cn and the tokens in index.css", () => {
    const css = readFileSync(join(ROOT, "src/renderer/index.css"), "utf8");
    const theme = css.slice(css.indexOf("@theme"), css.indexOf("\n}", css.indexOf("@theme")));
    const tokens = (prefix: string) =>
      [...theme.matchAll(new RegExp(`^\\s*--${prefix}-([a-z0-9-]+):`, "gm"))]
        .map((match) => match[1] as string)
        .filter((name) => !name.includes("--"));

    it.each(["text", "spacing", "container", "radius", "shadow"] as const)(
      "lists exactly the %s tokens the theme defines, so a rename can't leave it stale",
      (family) => {
        expect([...CLASS_TOKENS[family]].sort()).toEqual(tokens(family).sort());
      },
    );

    it("has been told about every theme family that makes a size class", () => {
      const families = new Set(
        [...theme.matchAll(/^\s*--([a-z]+)-/gm)].map((match) => match[1] as string),
      );
      const untaught = [...families].filter(
        (family) =>
          !["color", "font", "space", "motion", ...Object.keys(CLASS_TOKENS)].includes(family),
      );
      expect(untaught).toEqual([]);
    });

    it("keeps a text token beside a text color, in either order", () => {
      for (const name of CLASS_TOKENS.text) {
        expect(cn(`text-${name}`, "text-foreground")).toBe(`text-${name} text-foreground`);
        expect(cn("text-foreground", `text-${name}`)).toBe(`text-foreground text-${name}`);
      }
    });

    it.each([
      ["px-1", "px-card", "px-card"],
      ["px-card", "px-1", "px-1"],
      ["h-8", "h-btn-md", "h-btn-md"],
      ["h-btn-md", "h-8", "h-8"],
      ["min-h-row-one", "min-h-8", "min-h-8"],
      ["gap-2", "gap-card", "gap-card"],
      ["size-btn-sm", "size-4", "size-4"],
      ["px-2", "p-card", "p-card"],
      ["max-w-sm", "max-w-chat", "max-w-chat"],
      ["max-w-setup", "max-w-sm", "max-w-sm"],
    ])("lets the later of %s and %s win", (first, second, winner) => {
      expect(cn(first, second)).toBe(winner);
    });

    it("keeps a side override after a padding token", () => {
      expect(cn("p-card", "px-2")).toBe("p-card px-2");
    });
  });

  it("type and buttons come from the shared sizes", () => {
    const sized =
      /\btext-\[\d|\btext-(xs|sm|base|lg)\b|\bleading-(none|\[\d)|size="(xs|default|icon-xs)"/;
    expect(
      filesUnder(SRC).filter(
        (path) =>
          /\.tsx?$/.test(path) &&
          !path.endsWith(".test.ts") &&
          sized.test(readFileSync(path, "utf8")),
      ),
    ).toEqual([]);
  });

  describe("one type family on one scale", () => {
    const MONO = /\bfont-mono\b/;
    const RAW_SIZE = /\btext-(xs|sm|base|lg|xl|[2-9]xl)\b|\btext-\[\d/;
    const MONO_ALLOWED = ["renderer/components/settings/SecretForm.tsx"];
    const RAW_SIZE_ALLOWED = ["renderer/components/thread/Composer.tsx"];
    const hits = (
      sources: readonly SourceFile[],
      pattern: RegExp,
      allowed: readonly string[],
    ): readonly string[] =>
      sources
        .filter((file) => file.path.endsWith(".tsx") && !allowed.includes(file.path))
        .flatMap((file) =>
          file.text
            .split("\n")
            .flatMap((line, at) => (pattern.test(line) ? [`${file.path}:${at + 1}`] : [])),
        );

    it("no chrome sets font-mono, apart from the secret fields", () => {
      expect(hits(SOURCES, MONO, MONO_ALLOWED)).toEqual([]);
    });

    it("no screen uses a raw Tailwind size, apart from the North Star hero", () => {
      expect(hits(SOURCES, RAW_SIZE, RAW_SIZE_ALLOWED)).toEqual([]);
    });

    it("the allowlists name real files", () => {
      const paths = SOURCES.map((file) => file.path);
      expect(
        [...MONO_ALLOWED, ...RAW_SIZE_ALLOWED].filter((path) => !paths.includes(path)),
      ).toEqual([]);
    });

    it("the checks catch mono, a raw size, and a responsive raw size", () => {
      const screen = fakeFile(
        "renderer/components/evil.tsx",
        '<span className="font-mono">a</span>\n<p className="text-lg">b</p>\n<p className="sm:text-2xl">c</p>\n<p className="text-[15px]">d</p>',
      );
      expect(hits([screen], MONO, MONO_ALLOWED)).toEqual(["renderer/components/evil.tsx:1"]);
      expect(hits([screen], RAW_SIZE, RAW_SIZE_ALLOWED)).toEqual([
        "renderer/components/evil.tsx:2",
        "renderer/components/evil.tsx:3",
        "renderer/components/evil.tsx:4",
      ]);
    });
  });

  it("nothing in the app or the README talks about diffs", () => {
    const texts = [
      ...filesUnder(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") })),
      ...["src/renderer/index.css", "src/renderer/stores/API.md", "README.md", "index.html"].map(
        (path) => ({
          path,
          text: readFileSync(join(ROOT, path), "utf8"),
        }),
      ),
    ];
    expect(
      texts
        .filter(({ text }) => /\bdiffs?\b|Diff[A-Z]|[a-z]Diff|diff[A-Z]|\.dline/.test(text))
        .map(({ path }) => path),
    ).toEqual([]);
  });

  it("the app and the README are Canvas-only, with no other vendor named", () => {
    const texts = [
      ...filesUnder(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") })),
      ...["src/renderer/stores/API.md", "README.md", "index.html"].map((path) => ({
        path,
        text: readFileSync(join(ROOT, path), "utf8"),
      })),
    ];
    expect(
      texts
        .filter(({ text }) => /\bD2L\b|brightspace|desire2learn/i.test(text))
        .map(({ path }) => path),
    ).toEqual([]);
  });

  it("the checks are looking at real screens", () => {
    expect(
      SOURCES.filter(isScreen).some(
        (file) => file.path === "renderer/components/thread/ThreadScreen.tsx",
      ),
    ).toBe(true);
  });

  it("the checks catch each one in a screen, and leave a store alone", () => {
    const screen = fakeFile(
      "renderer/components/evil.tsx",
      'import { x } from "../providers/vault";\nconst a = record.state.tag === "sent";\nconst b = "Send to Canvas";',
    );
    expect(screensMatching([screen], VENDOR_WORD)).toEqual(["renderer/components/evil.tsx"]);
    expect(screensMatching([screen], STATE_BRANCH)).toEqual(["renderer/components/evil.tsx"]);
    expect(providerImplementationImporters([screen])).toEqual(["renderer/components/evil.tsx"]);
    expect(
      screensMatching(
        [fakeFile("renderer/stores/fine.ts", 'const a = record.state.tag === "sent";')],
        STATE_BRANCH,
      ),
    ).toEqual([]);
    expect(
      aiSourceReaders([
        fakeFile("renderer/components/evil.tsx", 'const on = state.aiSource !== "none";'),
      ]),
    ).toEqual(["renderer/components/evil.tsx"]);
    expect(
      screensMatching(
        [
          fakeFile(
            "renderer/components/evil.tsx",
            'const on = import.meta.env.MODE === "production";',
          ),
        ],
        BUILD_MODE,
      ),
    ).toEqual(["renderer/components/evil.tsx"]);
  });
});
