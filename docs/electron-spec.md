# Constellation desktop (Electron) spec

Status: agreed with Kyle in a grilling session on 2026-11-11. Each decision is numbered (D1 to D41) and gives its reason. The decision log at the end keeps each round's wording.

Electron was chosen on 2026-11-10 and isn't reopened here. GPUI was dropped because it has no accessibility by default, no end-to-end driver, and would mean a full rewrite. An Electron 45 spike on `out/dist` measured about 0.6 s to the first window, about 360 MB of memory, and a 120 MB download.

## Goals

- A public, signed and notarised Mac download that auto-updates (D1, D2, D6, D19).
- **0.0.1 is stable** when the app can set up, grade and interact with a course from start to finish against real Canvas, with real AI (D34, D39). Proof: one walk on Kyle's sandbox course, with zero double posts and `contract:live` green, then one week of Kyle's use on a live course:
  1. Detect a new course, copy last term (or upload an `.imscc` package), shift the dates, approve fixes, publish.
  2. The AI drafts a grade, and Kyle edits and sends it.
  3. Reply to a conversation and post an announcement.
  4. Save the course as a template.
- Tokens, Canvas traffic and model calls never touch the renderer or any Constellation server (D5, #1, #2).
- Every rule an agent must follow is enforced by a machine (D31).

## Non-goals for 0.0.1

- Windows and Linux builds. The code stays portable (D2).
- Canvas OAuth, deep links and redirect handling. Personal access tokens only (D7).
- Migrating data from the web demo (D9).
- The on-device model, and any LLM provider besides Anthropic (D27).
- AI features beyond what the rules agent does today, including #2 (D41).
- Product analytics events (#3). Only error reports are sent (D35).
- More than one window (D22), beta update channels (D19), and an in-app spending cap (D28).
- Self-hosted runners on the public repo (D13).

## Repo and cutover

- A new **public** repo, `constellation`, starts from one squashed commit of today's main, under AGPL-3.0 from that first commit (D11, D12, D14, D33). There is no CLA.
- Only three issues were re-filed by hand: #1 (keychain), #2 (AI content grounded in course materials) and #3 (PostHog analytics), formerly #2, #3 and #52 in the old repo. They were re-filed because GitHub can't transfer issues from a private repo to a public one.
- The current repo becomes `constellation-old`. It is frozen now (demo fixes only) and archived when 0.0.1 is stable.
- Releases go to the new repo's GitHub Releases (D11).

## Architecture

### Processes and folders (D5, D15)

| Folder          | Runs in                                        | May use                                                                                                       | Must not use                                    |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `src/main/`     | Electron main (Node)                           | `electron`, Node, `fetch`, `safeStorage`, the Anthropic SDK, PostHog's capture API (in `main/telemetry` only) | DOM                                             |
| `src/preload/`  | Sandboxed preload                              | `contextBridge` and `ipcRenderer`, in one file                                                                | Anything else                                   |
| `src/renderer/` | Renderer: today's app, also the web demo build | DOM, React, `shared`                                                                                          | `electron`, Node, `fetch`, `process`, `require` |
| `src/shared/`   | Both sides                                     | Pure TypeScript: domain types, valibot schemas, parsers, the IPC map, and the fake Canvas                     | DOM, Node, `electron`                           |

Each folder has its own tsconfig: the renderer gets DOM types and no Node types, main gets Node types and no DOM. A lint rule fails any cross-folder import except one into `shared`.

The main process owns everything sensitive:

- **Vault.** Tokens and the Anthropic key are encrypted with `safeStorage`, whose key lives in the macOS Keychain, and the ciphertext is stored in `userData`. Removing a school deletes its entry. The IndexedDB vault remains only in the web demo build (#1).
- **LMS providers.** The real Canvas provider, and in the desktop app the fake Canvas too, with its `StorageLike` backed by a JSON file in `userData` (D8).
- **Agent.** Anthropic calls with the user's key (D26, D27).
- **Telemetry.** PostHog error tracking (D20, D23).
- **Updater, menu, single-instance lock and window** (D19, D22, D37).

The renderer keeps the workspace store in localStorage, which Electron persists in `userData` (D9). It keeps `parseAgentEffect`, `transition`, the writeback runner and `classify`. Those are pure logic, and they decide what a provider is allowed to do.

### The IPC contract (D16)

`src/shared/ipc.ts` declares every channel exactly once:

```ts
export const ipc = {
  "lms.courses": { input: v.object({ school: SchoolId }), output: v.array(Course) },
  "lms.apply": { input: SendPermitSchema, output: FieldOutcomesSchema },
  "vault.enroll": { input: v.object({ key: VaultKey, token: v.string() }), output: v.void() },
  "agent.run": { input: AgentRunInput, output: AgentRunOutput }, // { ok, effects: unknown[], spend } or { ok: false, reason }
  "error.report": { input: RendererErrorSchema, output: v.void() },
} as const;
```

- Main registers handlers through `handle(ipc, handlers)`. The type of `handlers` is a mapped type over the map's keys, so a missing or misspelled handler fails to compile.
- Main parses every input before its handler runs. The preload parses every output before the renderer sees it. A payload that fails to parse is rejected and reported as an error. It is never coerced.
- The preload exposes one object, `window.constellation`, with `invoke(channel, input)` and `agent`: `"claude"`, or `"rules"` when main runs verify's fake schools. The renderer never sees `ipcRenderer`.
- Only `agent.run` outputs `unknown`, on purpose: its effects. Each raw effect goes to `parseAgentEffect` in the renderer, the same parser the rules agent goes through today: one parser, one path (D26).
- `SendPermit` is checked again in main: `apply` refuses anything that isn't a genuine permit. The renderer is untrusted, so main checks the permit's fingerprint against the approved content it was minted from. (The exact check is designed in the writeback PR.)
- The renderer's provider and agent become thin clients over this bridge, with the same `LmsProvider` and `Agent` interfaces, so screens and tests don't change.

### Security baseline (D18, D29)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and `webSecurity` left at its default.
- The app loads from a custom `app://` protocol that serves only the bundled files. It never loads from `file://` or from a remote origin.
- The CSP is `default-src 'self'`. `connect-src` allows only `'self'`, with no remote script and no `eval`.
- `will-navigate` and `setWindowOpenHandler` deny every navigation and new window. Links open in the system browser through `shell.openExternal`, and only for `https:` links.
- Electron fuses turn off `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`, and turn on `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`.
- A packaged build quits at startup if it gets `--remote-debugging-port`. Only the unpackaged app that verify drives accepts it.

### Canvas (D7, D25, D40)

- Enrolment is paste-token: the school host plus a personal access token. The `redirect` enrolment type stays in the code for later.
- Requests run in main with `fetch` to `https://<host>/api/v1/...`. That avoids CORS and keeps the token off the renderer.
- Paging follows `Link: rel="next"` inside the provider, so every read still returns a whole list.
- Canvas throttles with a **403 "Rate Limit Exceeded"**, not a 429. The provider maps it, and any 429, to the existing throttled error, so the runner pauses that school's lane without spending a retry. The provider never sleeps.
- Writes go through the existing single write path: observe, then classify, then apply, with per-field outcomes and the first-send record. The README's design is unchanged, and the Canvas provider must pass `runProviderContract`.
- Term setup does course copy and `.imscc` upload. The upload uses `pre_attachment`, then the upload URL. The file picker and the file read run in main. A package job still `pre_processing` 10 minutes after it was made reads as stalled, never failed, since Canvas can't say whether its file arrived. The setup offers Copy again and warns that, if the first import still runs, the content lands twice.
- Canvas reports a term's dates to a teacher only when the term has teacher dates, so at most schools they read as null. Term setup never depends on them. Canvas's `concluded` flag (`include[]=concluded`) leaves out past terms, an unpublished course with no known start is a new-term course, and the Dates step asks the teacher for any date Canvas hides. `courses()` drops `enrollment_state=active` for the same flag, since that filter also hides a published course whose term hasn't started.
- Writeback ships only after `npm run contract:live` passes against Kyle's sandbox courses.

### AI (D26, D27, D28, D41)

- Anthropic only, through the official SDK, in main, with the user's key from the vault. Use the newest Claude model that fits each task.
- The model replaces the rules agent behind `Agent` and `parseAgentEffect`. It covers drafts (grades, replies, announcements, messages), the setup scan and North Star chat, and nothing new.
- Each thread shows its token use and cost. Settings links to Anthropic's console spend limits. There is no in-app cap.
- The web demo keeps the rules agent.

### Offline (D28)

- The app opens from saved state, and each school shows "offline".
- Send and AI are disabled, with the reason shown. Nothing queues, because a queued send risks a double post.

### Error tracking and privacy (D20, D23, D24, D36)

- PostHog error tracking, sent from main only. Renderer errors reach main over `error.report`.
- A payload carries only the error type, the stack, the app version and the OS. The type is one of JavaScript's own error names, or `Error`; our own typed error codes join that closed set when they exist. A stack frame keeps its file, line and column only when the file exists in the app's own bundle, and is otherwise only `<withheld>`. No frame carries a function name, since a name can come from data. Message text is never sent.
- Breadcrumbs, autocapture, session replay and GeoIP are off. The app treats every value as student data.
- Reports are on by default. The opt-out sits on the setup page and in Settings, and `CONSTELLATION_TELEMETRY_ENABLED=false` also turns them off.
- `PRIVACY.md` lives in the repo and is shown during setup. It lists everything that leaves the machine: Canvas calls to your school, Anthropic calls with your key, and scrubbed crash reports to PostHog. It says no Constellation server exists, and it makes no claim of FERPA compliance.

### App shell (D22, D37)

- One window. A second launch focuses it.
- A native menu with the standard App, Edit, View and Window roles, so ⌘C, ⌘V and ⌘Z work. The keyboard shortcuts in the README carry over.

## Developer experience

- `npm run dev` starts vite in-process, as the existing rule requires, launches Electron against it, and restarts main when its code changes (D17).
- `vp build` builds the renderer, `vp pack` builds main and preload, and electron-builder packages the app. There is no electron-vite.
- `npm run build:web` builds the demo. It uses the same renderer, with the fake Canvas and the rules agent wired in-renderer.
- `npm run verify` launches the unpackaged Electron app on a free CDP port and runs every existing part unchanged (D10, D29). `npm run verify:web` is a small smoke check of the demo: it loads, and onboarding finishes.
- `npm run smoke:packaged` launches the packaged build and checks that a window opens, the CSP holds, and the app refuses `--remote-debugging-port`.
- `npm run contract:live` runs the provider contract against real sandbox courses. The token comes from an env var. It never runs in CI (D25).
- The existing checks (`check`, `knip`, `typecheck`, `test`, `build`, `verify`) and the pre-commit hook carry over. Knip covers main and preload.

### CI and release (D13, D21, D32, D38)

- Every PR job runs on GitHub-hosted macOS runners: Lint, Build, Test, Verify (Electron), Verify web smoke, and `Check`, which needs them all. Kyle's Macs run only agents' local verify.
- Pushing a `v*` tag runs the release workflow on a GitHub-hosted runner. It builds, signs with Developer ID, notarises, staples, and uploads a **draft** GitHub Release with the electron-updater metadata. Kyle publishes the release.
- Signing and notarisation secrets live in a `release` environment that only Kyle can approve.
- Updates check at launch, download in the background, and install on quit. There is one stable channel. Before 0.0.1, releases are tagged `0.0.1-alpha.N`.
- Electron is pinned to an exact version, and Dependabot opens a PR for each major. Falling 3 or more majors behind counts as a security bug.
- Nothing deploys the web demo from this public repo. The mini's port-4320 deploy is removed.

## Enforcement

Every rule here has an enforcer. The CLAUDE.md table lists only enforced rules, and a test fails if a row names a lint rule, test or script that doesn't exist (D31).

**Carried over unchanged:** no vp server spawn, `shadcn/no-restyle`, the PreToolUse command block on killing found PIDs, no `any` and `no-unsafe-*`, `no-json-parse-cast`, switch exhaustiveness, `satisfies` over `as`, no `!`, no unnecessary casts, and no `console` in shipped code. Each one extends to `src/main`, `src/preload` and `src/shared`.

**New:**

| Rule                                                         | Enforced by                                                                                                         | PR     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------ |
| Each process folder imports only itself and `shared`         | Per-folder tsconfigs (lib/types) plus a lint rule on import paths                                                   | 2      |
| No `electron` import in `renderer` or `shared`               | `no-restricted-imports`                                                                                             | 2      |
| No `fetch`, `process` or `require` in the renderer           | `no-restricted-globals`, backed at runtime by CSP `connect-src 'self'`                                              | 2      |
| CLAUDE.md lists only rules that have an enforcer             | `tests/enforcement-table.test.ts` resolves every row's lint rule, test or script                                    | 2      |
| `ipcMain` and `ipcRenderer` each appear in one file          | `no-restricted-imports` with a per-file override                                                                    | 5      |
| Every IPC channel has a handler; no payload crosses unparsed | Mapped `handlers` type; the `handle` and `invoke` wrappers parse inputs and outputs; an IPC test feeds bad payloads | 5      |
| `webPreferences`, CSP, navigation lock and fuses stay set    | `tests/security.test.ts` on the window options and fuse config, plus a verify step that reads the live CSP          | 3      |
| A packaged build refuses `--remote-debugging-port`           | `smoke:packaged`                                                                                                    | 7      |
| `revealSecret` stays in main's providers and vault           | `tests/structure.test.ts`                                                                                           | 6      |
| Error reports carry no message text and no student data      | `tests/telemetry.test.ts` plants student data in a main error and a renderer stack, and fails if any appears        | 9      |
| Canvas paging and throttling behave                          | Provider unit tests over recorded real responses                                                                    | 10     |
| The Canvas provider honours the contract                     | `runProviderContract` in CI against the fake; `contract:live` by hand before writeback ships                        | 10, 11 |
| Electron stays current                                       | Dependabot plus the pin                                                                                             | 7      |

## Build order

Each step is one PR that ends green on every check and is proven on the real app.

1. **New repo.** Squash today's main into the public `constellation` repo, add the AGPL-3.0 `LICENSE`, and move CI to GitHub-hosted runners (still Chrome verify for now). Deploy to Pages from a hosted job. Re-file #1, #2 and #3. Freeze the old repo. _Proof:_ CI green on hosted runners, and the demo URL serves.
2. **Folder split, no behaviour change.** Move `src/` to `src/renderer/` and the pure code to `src/shared/`. Add the per-folder tsconfigs, the boundary lint rules and the enforcement-table test. _Proof:_ every check passes, and a planted `import "node:fs"` in the renderer fails.
3. **Electron shell.** Add main and preload, the `app://` protocol, the security baseline, the menu, the single-instance lock and `npm run dev`. The fake LMS still runs in the renderer. Add `tests/security.test.ts`. _Proof:_ a screenshot of the app in Electron; ⌘C and ⌘V work.
4. **Verify drives Electron.** The harness launches the unpackaged app with CDP. Prove that hidden or background windows paint and that `focus.mjs` holds; this is the main risk. CI Verify switches to Electron, and `verify:web` is added. _Proof:_ a full verify passes on a hosted runner.
5. **The IPC map.** Add `src/shared/ipc.ts`, valibot, `handle` and `invoke`, and the IPC payload test. The first channel is `error.report`, a no-op sink for now. _Proof:_ a bad payload is rejected in a test.
6. **The vault moves to main.** `safeStorage` and the Keychain behind `vault.*`. The web build keeps the IndexedDB vault. Closes #1. _Proof:_ the token isn't readable from DevTools; removing a school deletes its entry.
7. **Packaging and release.** electron-builder, fuses, Developer ID signing, notarisation, the release workflow (draft Release on tag), `smoke:packaged`, and Dependabot. Cut `0.0.1-alpha.1`. _Proof:_ the downloaded DMG opens without a Gatekeeper warning.
8. **Auto-update.** electron-updater. Cut `alpha.2`. _Proof:_ an `alpha.1` install updates itself to `alpha.2`.
9. **Error tracking and privacy.** PostHog in `main/telemetry`, the scrubber, the payload test, the opt-out on the setup page and in Settings, and `PRIVACY.md` in the repo and in setup. _Proof:_ a forced error arrives in PostHog with no message text.
10. **The fake LMS moves to main.** `lms.*` channels, the file-backed `StorageLike`, and the renderer provider as a bridge client. _Proof:_ a full verify passes unchanged, so the bridge carries every flow.
11. **Real Canvas reads.** The Canvas provider in main: `verify` and the six list reads, paging, throttling, offline state, recorded-response tests, and the read half of `contract:live`. _Proof:_ Kyle's sandbox courses appear in the app.
12. **Real Canvas writeback.** `observe` and `apply` for grades, rubric scores and comments, conversations, announcements and messages. A main-side permit check. Run `contract:live` writes on the sandbox. _Proof:_ a sent grade appears in Canvas once, including after a forced lost response.
13. **Real Canvas term setup.** `TermSetup` reads, course copy with date shift, progress and migration issues, fixes, publish, and template. _Proof:_ a sandbox course goes from copy to published.
14. **`.imscc` upload.** The file picker in main, `pre_attachment` and the upload. _Proof:_ a sample package from `fixtures/imscc/` imports into the sandbox.
15. **Real AI.** An Anthropic `Agent` in main over `agent.run`, the key in the vault, per-thread cost, and offline disabling. _Proof:_ an AI-drafted grade goes through approval to Canvas.
16. **0.0.1.** The D39 walk on the sandbox course, then a week of Kyle's use on a live course. Tag `v0.0.1`, publish it, and archive `constellation-old`.

## Open questions and risks

- **Verify in Electron windows.** Hidden or background windows may throttle painting, or report `document.hasFocus()` as false. PR 4 must prove this before CI depends on it. The fallbacks are `paintWhenInitiallyHidden` with `backgroundThrottling: false`, or a visible window placed off-screen. _Settled in PR 4:_ a covered or minimised window got no frames at all, while a window that is never shown painted at 60 fps with the default `paintWhenInitiallyHidden` but reported no focus. Verify starts the window hidden (`CONSTELLATION_WINDOW=hidden`, unpackaged only) and turns on CDP focus emulation. Production keeps `backgroundThrottling`.
- **Hosted-runner verify time and flakes.** Verify may take about 10 minutes instead of 5. Some of the known timing flakes may move or get worse. Measure in PR 1, and log flakes in the new repo's issues.
- **The permit check in main.** `SendPermit` and approval are minted in the renderer today. With the renderer untrusted, main needs its own check before `apply`. The exact rule is designed in PR 12, and it must not add a second write path. _Settled in PR 12:_ the renderer's permit only asks. Before main first writes a change to a real school, it asks the teacher in a native dialog that names the target as Canvas reports it and every field in main's own words. Main remembers the confirmed content per change while it runs, so a retry or resume of that content doesn't ask again. A comment, message or post goes out once per confirmation, and a field the content doesn't send is refused. The demo schools aren't gated, because the failure lab already lets the renderer rewrite the fake. _Changed for #38:_ the dialog made a fourth confirmation after Approve and Send, so it is gone. Main instead sends new content only within 10 seconds of a real click, Return or Space in the window, which main sees in the OS input it forwards and page script can't produce. A retry of the same content needs no new press, and a comment, message or post goes out once per press.
- **PostHog delivery.** Send straight to PostHog, or through our own proxy (#3)? Recommendation: send direct for 0.0.1, since a proxy would be the only Constellation server.
- **Student data at rest.** Workspace state in `userData` localStorage is unencrypted on disk, protected only by the user's account (D9). That's accepted for 0.0.1. `PRIVACY.md` must say so.
- **The Anthropic model choice and prompts** for each agent task are designed in PR 15. _Settled in PR 15:_ one model, `claude-opus-5-5` at `medium` effort, with Anthropic's server-side refusal fallback on, for every task the rules agent covers. One system prompt, and one tool per `AgentEffect` type, so each tool call is one raw effect. `agent.run` is a plain invoke rather than a stream: main returns the run's raw effects and its cost together, and the renderer still parses each one with `parseAgentEffect`. Main writes the scope into the prompt and never reads it, so it crosses as `unknown`. The model names the submission it annotates, because the change id is minted in the renderer once the propose lands. Verify drafts with the rules agent, so a run reaches neither Canvas nor Anthropic. Desktop offers no on-device model (D27). Offline, the composer is disabled with the reason and a run declines without asking main. What students wrote stays data: `<` is escaped in the scope, and the prompt says so.
- **Notarisation credentials.** Kyle provides an App Store Connect API key, or an app-specific password, for the `release` environment in PR 7.

## Decision log

### Settled before the grilling

- The desktop shell is Electron. See `.wiki/decisions/desktop-shell.md`.

### Round 1

- **D1 Audience: a public download.** Kyle chose this over "Kyle only first". Signing, notarisation, auto-update, crash reports and privacy become v1 work.
- **D2 macOS only in v1.** Portable code, but no Windows or Linux build until someone asks. Both CI machines are Macs.
- **D3 Three milestones, in order:** the shell, then real Canvas (reads, then writeback), then real AI. Each changes one thing.
- **D4 The web build stays, as a demo only.** No token or student data passes through a browser.
- **D5 The renderer is untrusted.** Main owns tokens, Canvas HTTP, model calls and files. This closes the vault's "same-origin script can ask it to decrypt" gap and avoids CORS.

### Round 2

- **D6** Kyle has an Apple Developer account. Signing is in scope.
- **D7 Personal access tokens only.** OAuth needs a developer key from each school's admin, which adjuncts can't get. So there are no deep links.
- **D8** The desktop runs the fake LMS in main, so verify tests the real bridge.
- **D9 Nothing migrates.** Desktop users start fresh. State stays in renderer localStorage, and only tokens move to main.
- **D10** CI verify targets Electron only, plus a web smoke check.
- **D11 A new public repo, `constellation`.** The old repo becomes `constellation-old` and is archived at a stable 0.0.1. Releases go to that repo.

### Round 3

- **D12** Seed the new repo with one squashed commit. No old history goes public, and issues are re-filed.
- **D13 GitHub-hosted runners for PRs.** A fork PR must never run on Kyle's Macs. Hosted runners are free for public repos.
- **D14** AGPL-3.0 from the moment the repo goes public. No CLA yet.
- **D15** Folders, tsconfigs and lint enforce the process split.

### Round 4

- **D16** One IPC map with valibot schemas, a compile-checked handler set, and parsing on both edges.
- **D17** `vp build` and `vp pack`, then electron-builder. No electron-vite.
- **D18** The security baseline above.
- **D19** electron-updater from GitHub Releases, with one channel.
- **D20 PostHog error tracking in v1.** Kyle chose this over local-only. Every value counts as student data.
- **D21** Release on a tag, to a draft that Kyle publishes, with a protected `release` environment.
- **D22** One window.

### Round 5

- **D24** Error tracking is on by default, with the opt-out on the setup page.
- **D25** Recorded-response unit tests, plus `contract:live` against Kyle's sandbox courses. Writeback waits for a live pass.
- **D26** The model runs in main and returns raw effects, and the renderer parses them: one parser. (PR 15 replaced the planned stream with a plain invoke.)
- **D27** Anthropic only. The on-device model is dropped, because it needs a native Swift addon.
- **D28** No in-app cap, with cost shown. Offline disables Send and AI, and nothing queues.

### Round 6

- **D23** The error payload rules above, and a test that fails on leaked student data.
- **D29** Verify drives the unpackaged app, the packaged app refuses CDP, and a packaged smoke test runs.
- **D30** The bridge lints in the enforcement table.
- **D31** A rule exists only if a machine enforces it, and the table is tested.
- **D32** Pin Electron exactly, with a Dependabot PR per major.

### Round 7

- **D33** The cutover happens now, and the old repo freezes.
- **D34 0.0.1 includes real AI.** Kyle chose this over shipping AI after 0.0.1. Success means setting up, grading and interacting with a course from start to finish.
- **D35** Product analytics (#3) come after 0.0.1.
- **D36** `PRIVACY.md` lives in the repo and is shown in setup.
- **D37** A native menu with the standard roles.
- **D38** The mini's demo deploy goes away. _Revised 2026-11-13:_ the demo is not deployed from this public repo at all.

### Round 8

- **D39** The 0.0.1 bar is the sandbox walk plus a week on a live course (see Goals).
- **D40 `.imscc` upload is in 0.0.1.** Kyle chose this over course copy only.
- **D41** Real AI covers only what the rules agent does today. #2 comes after.
