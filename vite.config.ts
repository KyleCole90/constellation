import { builtinModules } from "node:module";
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// `.claude` holds agent worktrees, each a full copy of the repo.
const IGNORED = [
  "out",
  "node_modules",
  "package-lock.json",
  "src/renderer/routeTree.gen.ts",
  ".audit",
  ".claude",
];

const ELECTRON_ONLY_IN_MAIN =
  "`electron` belongs to src/main and src/preload. The renderer reaches main through `window.constellation` (docs/electron-spec.md, D16).";
const ANTHROPIC_ONLY_IN_MAIN =
  "The Anthropic SDK runs in src/main, with the key from main's vault. The renderer asks over `agent.run` (docs/electron-spec.md, AI).";
const NODE_ONLY_IN_MAIN =
  "Node builtins belong to src/main. src/shared is pure code both processes run, and the renderer gets no Node access (docs/electron-spec.md, D5, D15).";
const IPC_THROUGH_THE_MAP =
  "`ipcMain` belongs to src/main/index.ts and `ipcRenderer` to src/preload/index.ts. Add a channel to src/shared/ipc.ts instead (docs/electron-spec.md, D16).";
const RENDERER_IS_UNTRUSTED =
  "The renderer is untrusted and gets no network or Node access. Ask main over IPC (docs/electron-spec.md, D5).";

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
  server: { port: 4320, allowedHosts: [".ts.net"] },
  build: { outDir: "out/dist" },
  // Main and preload, next to the renderer in `out/` so main finds both by relative path. A sandboxed preload must be CommonJS.
  pack: [
    {
      entry: "src/main/index.ts",
      outDir: "out/main",
      format: "esm",
      // The packaged app ships no node_modules, so every dependency main imports goes in its bundle. `npm run smoke:packaged` fails on one left out.
      deps: {
        neverBundle: ["electron"],
        alwaysBundle: ["valibot", "@anthropic-ai/sdk", "electron-updater"],
      },
      // Fixed at build time, so a packaged app's environment can't turn updates on (src/main/index.ts), and crash
      // reports go only to the PostHog project named at build time. Unset, as in CI and verify, the build sends nothing.
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
      // A sandboxed preload can require only `electron`, so everything else it imports goes in its bundle.
      deps: { neverBundle: ["electron"], alwaysBundle: ["valibot"] },
    },
  ],
  test: {
    environment: "node",
    // `npm run contract:live` reaches a real Canvas, so its tests run only through that script (docs/electron-spec.md, D25).
    include: process.env.CONTRACT_LIVE
      ? ["tests/**/*.live.ts"]
      : ["tests/**/*.test.ts", "src/**/*.test.ts"],
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
  },
  staged: {
    // In order, so lint reads the formatted file.
    "*": ["vp fmt --no-error-on-unmatched-pattern", "vp lint --no-error-on-unmatched-pattern"],
    // knip checks the whole project, so it takes no file list.
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
      "typescript/no-explicit-any": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      // Type-aware linting turns these on through the categories. They are off until someone adopts them on purpose.
      "typescript/consistent-return": "off",
      "typescript/unbound-method": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-misused-spread": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/no-unnecessary-template-expression": "off",
      // 121 casts in shipped code today, mostly brand mints. Turn on once they go through mint helpers.
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
          "eslint/no-restricted-imports": [
            "error",
            {
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
            },
          ],
        },
      },
      {
        files: ["src/main/**", "src/preload/**"],
        excludeFiles: ["src/main/index.ts", "src/preload/index.ts"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "electron",
                  importNames: ["ipcMain", "ipcRenderer"],
                  message: IPC_THROUGH_THE_MAP,
                },
              ],
            },
          ],
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
        // Shipped code: src without its colocated tests.
        files: ["src/**"],
        excludeFiles: ["src/**/*.test.ts"],
        rules: {
          "eslint/no-console": "error",
          "typescript/no-non-null-assertion": "error",
          // `satisfies T` or a `: T` annotation checks an object literal; `as T` only claims it.
          "typescript/consistent-type-assertions": [
            "error",
            { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
          ],
          // External data is `unknown` until parsed. These stop an `any` (JSON.parse, IndexedDB) flowing into typed code.
          "typescript/no-unsafe-argument": "error",
          "typescript/no-unsafe-assignment": "error",
          "typescript/no-unsafe-call": "error",
          "typescript/no-unsafe-member-access": "error",
          "typescript/no-unsafe-return": "error",
          "constellation/no-json-parse-cast": "error",
        },
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
