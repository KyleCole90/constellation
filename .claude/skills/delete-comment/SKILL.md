---
name: delete-comment
description: Sweep the code comments left in the no-comments baseline. Judge each one, file issues for hacks, move decisions to docs/adr/, delete the rest, and shrink the baseline.
disable-model-invocation: true
---

# Delete comments

`constellation/no-comments` fails on any comment a tool doesn't read, in JS and TS. `npm run check` also counts CSS and HTML. Files that had comments when the rule landed get an allowance in `scripts/comment-baseline.json`. Each run of this skill sweeps whole folders out of that baseline. The baseline only shrinks.

`scripts/comments.mjs` is the lever. Every step below goes through it:

- `node scripts/comments.mjs --summary`: comments and comment lines left.
- `node scripts/comments.mjs --tsv`: one row per comment: file, line, line count, own line or trailing, text.
- `node scripts/comments.mjs --delete <path>…`: deletes every comment under the paths, and leaves a file alone when the deletion would change its parsed code.
- `node scripts/comments.mjs --write-baseline`: lower the baseline to the tree. It refuses to raise or add an entry.
- `node scripts/comments.mjs --check`: fails when the baseline differs from the tree, or allows more than `origin/main`'s (`COMMENT_BASE` names another base).

## Steps

1. **Pick the scope.** Run `--tsv` and pick whole folders, the largest left first, about 1,000 comments for one PR. Branch from `main`. Done when the scope is a list of folders and `--tsv` rows for it are saved to a file.
2. **Judge every comment.** Read the code around it and give it one category:
   - **Tautology**: the code already says it (names, types, the flow). JSDoc that restates a signature counts.
   - **Stale**: it names code, files, issues or behaviour that no longer match.
   - **Excuse**: it justifies a hack a real fix would remove: a cast "because", a list kept in sync by hand, a "for now", a guard for a state that should be impossible, or a surprise in our own code that a rename or a type would make plain.
   - **Decision Record**: an important, non-obvious decision a later change could silently break: a format, an order, a platform or vendor rule, a security boundary.

   Past about 200 comments, split the rows into chunks and give each chunk to a `pstack:comment-sicko` subagent with these categories, asking for a TSV of file, line, category and note, and no edits. Done when every row has a category, and each Excuse and Decision Record a note.
3. **File the Excuses.** One issue on KyleCole90/constellation per hack, not per comment: the files and lines, what the hack is, and what a real fix looks like. Fix nothing in this PR. Done when every Excuse row names its issue number.
4. **Record the Decisions.** A decision a test, lint rule, typecheck, verify module or `smoke:packaged` already fails on needs no doc. For the rest, read `docs/adr/` first and extend the ADR on the same subject; otherwise add `docs/adr/NNNN-slug.md`, numbered after the highest, as a title and one paragraph: the decision, where it lives, and why. Done when every unenforced Decision Record is in an ADR.
5. **Delete.** Run `--delete` on the scope, then `npx vp fmt`. Any file it leaves alone, edit by hand. Done when `--tsv` lists no row in the scope.
6. **Shrink the baseline.** Run `--write-baseline`, then `--check`. Done when both exit 0.
7. **Check.** Run the CLAUDE.md checks, and `npm run verify -- --only=<module>` for each verify module whose files you touched. Open one PR. Its body gives the count per category, the issues filed, the ADRs added, and `--summary` before and after.
