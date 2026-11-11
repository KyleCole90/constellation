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
  "src/routeTree.gen.ts",
  ".audit",
  ".claude",
];

export default defineConfig({
  plugins: [
    tanstackRouter({ routesDirectory: "src/routes", generatedRouteTree: "src/routeTree.gen.ts" }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 4320, allowedHosts: [".ts.net"] },
  build: { outDir: "out/dist" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
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
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "constellation/no-vp-server-spawn": "error",
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
        excludeFiles: ["src/components/ui/**"],
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
