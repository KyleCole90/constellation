# Constellation project rules

## Checks

Run these before you open a PR. CI runs the same commands, and `main` accepts a PR only when the `Check` job passes.

- `npm run check`: format check and lint (`vp check`).
- `npm run knip`: unused files, exports and dependencies.
- `npm run typecheck`: the renderer (DOM), Node and test TypeScript projects.
- `npm test`: Vitest.
- `npm run build`: writes `out/dist/index.html`.
- `npm run verify`: drives the real app in headless Chrome (about 5 minutes).

Run `npm run fmt` to fix formatting. The pre-commit hook runs fmt and lint on staged files, then knip. Fix a finding in the code. A disable comment needs a reason after `--`. A `TS review debt:` disable marks a known violation to fix; don't copy it to new code.

## UI components

- `src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. If none fits and the look is a generic concept, add a variant to the component. Layout classes (width, flex, margin, position) belong on the parent. `shadcn/no-restyle` fails lint on violations.

## Rules and what enforces them

| Rule                                                                                                                                                                                                       | Enforced by                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Serve vite in-process (`createServer().listen()`, `preview()`); never spawn `vp dev` / `vp preview`                                                                                                        | `constellation/no-vp-server-spawn` in `scripts/lint-plugin.mjs`, run by `npm run check`                 |
| `src/components/ui` looks come from `variant` / `size`, not `className`                                                                                                                                    | `shadcn/no-restyle`                                                                                     |
| Stop only processes you started (`$!`, `timeout`, TaskStop); never `pkill`, `killall`, or `kill` a PID found with `ps`, `pgrep` or `lsof` (the old self-hosted CI's verify was killed twice on 2026-11-08) | `scripts/block-commands.mjs`, a PreToolUse hook wired in `.claude/settings.json`                        |
| No `any`; external data is `unknown` until parsed                                                                                                                                                          | `typescript/no-explicit-any`; in shipped `src`, `typescript/no-unsafe-*`                                |
| Never cast `JSON.parse` output; parse it into the domain type                                                                                                                                              | `constellation/no-json-parse-cast` in shipped `src`                                                     |
| A switch over a union names every case, so a new variant fails to compile                                                                                                                                  | `typescript/switch-exhaustiveness-check`, tsconfig `noFallthroughCasesInSwitch` and `noImplicitReturns` |
| Check object literals with `satisfies` or a `: T` annotation, not `as T`; CSS variables need no cast (`src/css-properties.d.ts`)                                                                           | `typescript/consistent-type-assertions` in shipped `src`                                                |
| No `!` in shipped code; type the value so it can't be missing                                                                                                                                              | `typescript/no-non-null-assertion` in shipped `src`                                                     |
| No casts that don't change the type                                                                                                                                                                        | `typescript/no-unnecessary-type-assertion`                                                              |
| No `console` in shipped code                                                                                                                                                                               | `eslint/no-console` in shipped `src`                                                                    |
