# Tests that reach real Canvas or spend Claude usage run only through their own scripts

Some checks write to a live Canvas school or spend real Claude quota. `npm test` and CI must never pick them up, so each runs only through a named script.

- `test.include` in `vite.config.ts` adds `tests/**/*.live.ts` only under `CONTRACT_LIVE` and `bench/*.run.ts` only under `BENCH`.
- `tests/canvas.live.ts` reads a live Canvas school and writes a grade and a comment. It runs only through `npm run contract:live`.
- `tests/claude-code.live.ts` drafts through the real signed-in `claude` and spends plan usage. It runs only with `CLAUDE_CODE_LIVE=1` under `npm run contract:live`.
- `bench/plan-usage.run.ts` spends real quota and runs only through `npm run bench:claude-code`. `BENCH_FIXTURES=N` drafts only the first N fixtures and writes no results file.
- `WEIGHTS` in `bench/metrics.ts` uses the Anthropic API's price ratios as an assumed weighting, because Anthropic doesn't publish how subscription limits weight token types. Every results file records the weights, so numbers under different weights are never compared.
- `minValidPercent` for the Claude Code source in `bench/sources.ts` is 90% valid on the first try, the bar agreed in #82.
- `scripts/make-bench-fixtures.mjs` generates `bench/files` from `bench/pages`. Run it again after you edit a page. The page suffix picks the output: `.pdf.html` is a Letter PDF, `.png.html` a 1200 px wide full-page PNG, `.shot.html` the first 1280x800 screen, `.md` a copy, and `.docx.md` a Word file.
