import { builtinModules } from "node:module";
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const IGNORED = [
  "out",
  "node_modules",
  "package-lock.json",
  "src/renderer/routeTree.gen.ts",
  ".audit",
  ".claude",
];

const ELECTRON_ONLY_IN_MAIN =
  "`electron` belongs to src/main and src/preload. The renderer reaches main through `window.constellation`.";
const ANTHROPIC_ONLY_IN_MAIN =
  "The Anthropic SDK runs in src/main, with the key from main's vault. The renderer asks over `agent.run`.";
const NODE_ONLY_IN_MAIN =
  "Node builtins belong to src/main. src/shared is pure code both processes run, and the renderer gets no Node access.";
const IPC_THROUGH_THE_MAP =
  "`ipcMain` belongs to src/main/index.ts and `ipcRenderer` to src/preload/index.ts. Add a channel to src/shared/ipc.ts instead.";
const NO_POSTHOG_SDK = {
  group: ["posthog-*", "posthog-*/**", "@posthog/*"],
  message:
    "Analytics go through src/main/telemetry.ts's batch POST, so only its typed events and scrubbed crash reports leave the app. No PostHog SDK.",
};

interface RestrictedPath {
  name: string;
  importNames?: string[];
  message: string;
}

interface RestrictedPattern {
  group: string[];
  message: string;
}

const restrictImports = (
  options: { paths?: RestrictedPath[]; patterns?: RestrictedPattern[] } = {},
): ["error", { paths?: RestrictedPath[]; patterns: RestrictedPattern[] }] => [
  "error",
  {
    ...(options.paths ? { paths: options.paths } : {}),
    patterns: [...(options.patterns ?? []), NO_POSTHOG_SDK],
  },
];
const RENDERER_IS_UNTRUSTED =
  "The renderer is untrusted and gets no network or Node access. Ask main over IPC.";

export default defineConfig({
  plugins: [
    tanstackRouter({
      routesDirectory: "src/renderer/routes",
      generatedRouteTree: "src/renderer/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "out/dist" },
  pack: [
    {
      entry: "src/main/index.ts",
      outDir: "out/main",
      format: "esm",
      deps: {
        neverBundle: ["electron"],
        alwaysBundle: ["valibot", "@anthropic-ai/sdk", "electron-updater"],
      },
      env: {
        CONSTELLATION_UPDATES: process.env.CONSTELLATION_UPDATES === "on" ? "on" : "off",
        CONSTELLATION_POSTHOG_KEY: process.env.CONSTELLATION_POSTHOG_KEY ?? "",
        CONSTELLATION_POSTHOG_HOST: process.env.CONSTELLATION_POSTHOG_HOST ?? "",
      },
    },
    {
      entry: "src/preload/index.ts",
      outDir: "out/preload",
      format: "cjs",
      deps: { neverBundle: ["electron"], alwaysBundle: ["valibot"] },
    },
  ],
  test: {
    environment: "node",
    include: process.env.CONTRACT_LIVE
      ? ["tests/**/*.live.ts"]
      : process.env.BENCH
        ? ["bench/*.run.ts"]
        : ["tests/**/*.test.ts", "src/**/*.test.ts"],
    allowOnly: !process.env.CI,
    retry: 0,
  },
  staged: {
    "*": ["vp fmt --no-error-on-unmatched-pattern", "vp lint --no-error-on-unmatched-pattern"],
    "{*.{js,jsx,ts,tsx,mjs,cjs,mts,cts},package.json,knip.json}": () => "npm run knip",
  },
  fmt: {
    ignorePatterns: IGNORED,
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: IGNORED,
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["@shadcn/lint", "./scripts/lint-plugin.mjs"],
    settings: {
      shadcn: { ui: "~/renderer/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "constellation/no-vp-server-spawn": "error",
      "constellation/process-boundary": "error",
      "constellation/no-double-assertion": "error",
      "constellation/no-brand-cast": "error",
      "constellation/use-iso-time": "error",
      "constellation/no-comments": "error",
      "eslint/no-restricted-imports": restrictImports(),
      "typescript/no-explicit-any": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/consistent-return": "off",
      "typescript/unbound-method": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-misused-spread": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/no-unnecessary-template-expression": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "oxc/no-accumulating-spread": "error",
      "eslint/no-control-regex": "off",
      "typescript/no-this-alias": "off",
      "unicorn/prefer-add-event-listener": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/prefer-array-find": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-array-reverse": "off",
      "react/no-object-type-as-default-prop": "off",
      "react/jsx-no-constructed-context-values": "off",
      "react/memo-dependencies": "error",
      "react/purity": "error",
      "react/refs": "error",
      "react/exhaustive-effect-dependencies": "error",
      "react/set-state-in-effect": "error",
      "react/immutability": "error",
      "react/no-array-index-key": "error",
      "react/no-unstable-nested-components": "error",
      "react/static-components": "error",
      "react/capitalized-calls": "error",
      "typescript/no-extraneous-class": "error",
      "eslint/no-empty-pattern": "error",
      "eslint/no-new": "error",
      "unicorn/no-useless-spread": "error",
      "eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "eslint/no-unsafe-optional-chaining": "error",
      "eslint/no-unneeded-ternary": "error",
      "unicorn/no-useless-fallback-in-spread": "error",
      "unicorn/require-module-specifiers": "error",
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
    },
    overrides: [
      {
        files: ["src/renderer/**", "src/shared/**"],
        rules: {
          "eslint/no-restricted-imports": restrictImports({
            paths: [
              { name: "electron", message: ELECTRON_ONLY_IN_MAIN },
              { name: "@anthropic-ai/sdk", message: ANTHROPIC_ONLY_IN_MAIN },
              ...builtinModules.map((name) => ({ name, message: NODE_ONLY_IN_MAIN })),
            ],
            patterns: [
              { group: ["electron/*"], message: ELECTRON_ONLY_IN_MAIN },
              { group: ["@anthropic-ai/*"], message: ANTHROPIC_ONLY_IN_MAIN },
              { group: ["node:*", "node:*/**"], message: NODE_ONLY_IN_MAIN },
            ],
          }),
        },
      },
      {
        files: ["src/main/**", "src/preload/**"],
        excludeFiles: ["src/main/index.ts", "src/preload/index.ts"],
        rules: {
          "eslint/no-restricted-imports": restrictImports({
            paths: [
              {
                name: "electron",
                importNames: ["ipcMain", "ipcRenderer"],
                message: IPC_THROUGH_THE_MAP,
              },
            ],
          }),
        },
      },
      {
        files: ["src/renderer/**"],
        rules: {
          "eslint/no-restricted-globals": [
            "error",
            { name: "fetch", message: RENDERER_IS_UNTRUSTED },
            { name: "process", message: RENDERER_IS_UNTRUSTED },
            { name: "require", message: RENDERER_IS_UNTRUSTED },
          ],
        },
      },
      {
        files: ["src/**"],
        excludeFiles: ["src/**/*.test.ts"],
        rules: {
          "eslint/no-console": "error",
          "typescript/no-non-null-assertion": "error",
          "typescript/consistent-type-assertions": [
            "error",
            { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
          ],
          "typescript/no-unsafe-argument": "error",
          "typescript/no-unsafe-assignment": "error",
          "typescript/no-unsafe-call": "error",
          "typescript/no-unsafe-member-access": "error",
          "typescript/no-unsafe-return": "error",
          "constellation/no-json-parse-cast": "error",
          "typescript/no-unsafe-type-assertion": "error",
        },
      },
      {
        files: ["tests/**", "bench/**", "src/**/*.test.ts"],
        rules: { "constellation/no-json-parse-cast": "error" },
      },
      {
        files: ["tests/**", "src/**/*.test.ts"],
        rules: { "constellation/no-as-never": "error" },
      },
      {
        files: [
          "src/shared/providers/schemas.ts",
          "src/shared/ipc.ts",
          "src/shared/providers/fake-canvas/lab.ts",
        ],
        rules: { "constellation/annotated-schemas": "error" },
      },
      {
        files: ["src/**"],
        rules: { "shadcn/no-unknown-classes": "error" },
      },
      {
        files: ["src/**"],
        rules: { "shadcn/no-raw-colors": "error" },
      },
      {
        files: ["src/**"],
        excludeFiles: ["src/renderer/components/ui/**"],
        rules: {
          "shadcn/require-static-classes": "error",
          "shadcn/no-arbitrary-values": [
            "error",
            { allow: ["layout", "transition", "rounded-b-[9px]", "rounded-[20px]"] },
          ],
          "shadcn/no-restyle": ["error", { allow: ["layout"] }],
        },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: true,
      typeCheck: false,
    },
  },
});
