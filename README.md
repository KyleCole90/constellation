# Constellation

Each school is a star in your academic journey.

Constellation is a desktop app for adjunct instructors who teach at more than one school. You connect each school's Canvas, and you run the whole week from one workspace: grading, messages, announcements, due dates, and setting up next term's courses. AI can draft the work. Nothing reaches Canvas until you read a plain preview of the change and approve it.

## What it does

- **North Star** is home, above every course. Ask it a question, and it answers, finds things, or hands the work to the right course thread. Each chat stays in the sidebar.
- **Course threads.** Each task in a course is a thread: grading an assignment, answering a student, posting an announcement.
- **What's due** lists what needs you next, across every school.
- **Grading list.** Open it from What's due and move through submissions with `J` and `K`. Each draft shows the score, the rubric, and the feedback.
- **Gradebook** and **Announcements** for each course, and **Messages** with students across every school.
- **Calendar** shows every assignment at every school by the day it is due, with one row per course.
- **Start of term.** For each new course, Constellation copies a previous course or an `.imscc` export into it. It shifts the dates to the new term and scans for stale content. Then it drafts fixes, checks the course before you publish it, and saves it as a template at the end of term.
- **Approve, then send.** Every grade, comment, reply, and course edit waits on a preview of exactly what will be sent. **Send** stays off until you press **Approve**, and the AI has no way to approve or send. If a send fails partway, the app reads Canvas before it tries again, so a comment is not posted twice.
- **AI sources.** Choose one in setup or in **Settings**:
  - Claude with your Anthropic API key. The desktop app keeps the key in your Mac's Keychain and never shows it again.
  - Claude with your own Claude Code subscription (desktop app only).
  - The on-device model built into macOS (web demo only).
  - No AI. You fill in grades and replies by hand.

## Get it

**Desktop app.** Download the `.dmg` for your Mac (Apple silicon or Intel) from [GitHub Releases](https://github.com/KyleCole90/constellation/releases). On first run, type each school's Canvas address and paste a Canvas access token for it.

**From source.** Constellation needs the Node.js version in `.node-version`. Run:

```sh
npm install && npm run dev
```

`npm run dev` starts the desktop app. `npm run dev:web` starts the web demo alone, at http://localhost:4320/.

The web demo runs on a fake LMS with two invented schools and talks to no real Canvas. On the setup page, click **Try it with demo schools**, then **Connect** on each row. In the web demo, AI drafts come from built-in rules, and a fake school accepts any token of at least 20 characters.

## Keyboard shortcuts

| Keys            | Action                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `⌘K`            | Opens the command palette.                                                                                                                                                                                                         |
| `⌘B`            | Toggles the sidebar.                                                                                                                                                                                                               |
| `⌘1` to `⌘9`    | Opens that thread.                                                                                                                                                                                                                 |
| `⌘⇧[` and `⌘⇧]` | Moves to the previous or next thread.                                                                                                                                                                                              |
| `⌘N`            | Goes to North Star for a new chat. Needs AI on.                                                                                                                                                                                    |
| `⌘⇧O`           | Starts a thread in the current course. Needs AI on.                                                                                                                                                                                |
| `⌘D`            | Opens or closes the preview panel.                                                                                                                                                                                                 |
| `J` and `K`     | Moves through the grading list.                                                                                                                                                                                                    |
| `/`             | Focuses the composer. Needs AI on.                                                                                                                                                                                                 |
| `⌘↵`            | Walks to the next step. It never approves. On a draft, it moves focus to **Approve**. On a form with blanks, it stops at the preview. With a correction half typed in the composer, it opens the review and leaves the text there. |

Enter or Space on the focused **Approve** button approves.

## Privacy

[PRIVACY.md](PRIVACY.md) lists everything the desktop app sends and where. The setup page shows the same list, and you can turn crash reports off there or in **Settings**.

## Contributing

Run these checks before you open a pull request. CI runs the same ones.

| Command                  | What it checks                                                            |
| ------------------------ | ------------------------------------------------------------------------- |
| `npm run check`          | Formatting and lint.                                                      |
| `npm run knip`           | Unused files, exports, and dependencies.                                  |
| `npm run typecheck`      | Every TypeScript project.                                                 |
| `npm test`               | The Vitest suite.                                                         |
| `npm run build`          | The renderer and web demo to `out/dist`, and Electron's main and preload. |
| `npm run verify:web`     | The web demo loads in headless Chrome, and onboarding finishes.           |
| `npm run smoke:packaged` | The packaged app keeps its security fuses and boots.                      |

`npm run verify -- --only=<module>` drives the real Electron app in a hidden window for one module in `scripts/verify/`. `npm run fmt` fixes formatting. [CLAUDE.md](CLAUDE.md) lists the project's rules and the check that enforces each one.

## License

AGPL-3.0. See [LICENSE](LICENSE).
