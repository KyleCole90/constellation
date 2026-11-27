# Contributing

## Build from source

Install the Node.js version in `.node-version`. Then run:

```sh
npm install && npm run dev
```

`npm run dev` starts the desktop app against vite. It restarts the app when `src/main`, `src/preload`, or `src/shared` changes.

## Run the checks

Run these checks before you open a pull request. CI runs the same checks, plus the full verify suite.

| Command                  | What it checks                                               |
| ------------------------ | ------------------------------------------------------------ |
| `npm run check`          | Formatting and lint.                                         |
| `npm run knip`           | Unused files, exports, and dependencies.                     |
| `npm run typecheck`      | Every TypeScript project.                                    |
| `npm test`               | The Vitest suite.                                            |
| `npm run build`          | The renderer to `out/dist`, and Electron's main and preload. |
| `npm run smoke:packaged` | The packaged app keeps its security fuses and boots.         |

`npm run verify -- --only=<module>` drives the real Electron app in a hidden window for one module in `scripts/verify/`. Run it for each module that your change touches. `npm run fmt` fixes formatting.

[CLAUDE.md](CLAUDE.md) lists the project's rules and the check that enforces each one. [docs/adr/](docs/adr/) records the decisions that the code cannot show.

## Update the README screenshot

`npm run verify -- --only=ui-shots` writes screenshots of the app to `out/screenshots`. The README image, `docs/readme/hero.webp`, is `05-grading-draft-1440.png` from that run, resized to 1600 pixels wide:

```sh
magick out/screenshots/05-grading-draft-1440.png -resize 1600x -quality 82 docs/readme/hero.webp
```
