# The teacher picks one AI source, and the rules agent stands in for Claude

Student work goes only to the source the teacher chose: Anthropic with the teacher's API key, or the teacher's own Claude Code. The rules agent gives the same kind of answers with no model, for the demo and for verify. Size caps keep every request inside what one Claude call accepts.

- The `agent.source` channel in `src/shared/ipc.ts` sets the one source that `agent.run` uses. Main never falls back from the API key to Claude Code or back, so the teacher's choice of who sees student work always holds.
- `AgentRunInput.scope` in `src/shared/ipc.ts` stays `v.unknown()`. Main only writes the scope into the prompt. `parseAgentEffect` checks what the model returns against the renderer's own scope, so trust never rests on this field.
- `ARGS` in `src/main/providers/claude-code.ts` turns off tools, MCP, setting sources, slash commands and session saving one flag at a time, not with `--bare`. `--bare` accepts only an API key and refuses the teacher's Claude subscription sign-in.
- `findClaude` in `src/main/providers/claude-code.ts` checks `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, then runs one `$SHELL -lic "command -v claude"`. A macOS app opened from the Finder doesn't get the shell's `PATH`.
- `CLAUDE_CODE_MINIMUM` in `src/shared/claude-code.ts` is the oldest Claude Code whose flags, init message and stream-json were checked. Raise it only after `tests/claude-code.live.ts` passes on the newer version.
- `PRICES` in `src/main/providers/anthropic.ts` prices a model it doesn't list, such as a fallback Anthropic picks on its side, at `HIGHEST`. A thread never shows less than Anthropic billed. Add new models to the table instead of lowering the default.
- `MAX_CHARS` in `src/main/document-text.ts` is 400,000 characters, about 70,000 words. A submitted file's text then fits in one Claude request with the scope.
- `MAX_IMAGE_BYTES` (5 MB) and `MAX_CLAUDE_BYTES` (20 MB) in `src/shared/domain/lms.ts` are the app's caps on what it sends Claude. They sit below Anthropic's limits with room for base64 growth. Check Anthropic's current limits before you raise them.
- `unreadableFiles` in `src/shared/domain/lms.ts` leaves files main reads as text (Word, RTF) out of the 20 MB total. Main sends Claude only their words, so most of a Word file's bytes never leave.
- `draftGrade` in `src/shared/agent/rules/index.ts` refuses an upload or URL submission that arrived without files. On the Claude path that work reaches the model only as files.
- `GradeDraft.opens` in `src/shared/agent/rules/drafts.ts` matches a bank entry by the start of the submission's first paragraph, not the assignment title. Two seeded assignments share a title and have different submissions.
- `INTENTS` in `src/shared/agent/rules/northStar.ts` is first-match-wins, so its order is its meaning. Refusals come first, and a search comes before the intents for the words it searches for.
