# CI runs each action at a commit SHA

A tag can be moved to other code after review, and the release job runs with the signing and notarizing secrets. So each `uses:` in `.github/workflows` names the full commit SHA it runs.

- `tests/workflow-pins.test.ts` fails on a `uses:` with a tag, a branch or a short SHA. Only a local `./` action is exempt.
- The release sits beside the SHA as `# vX.Y.Z`, the most specific version tag on that commit. Dependabot's `github-actions` updates in `.github/dependabot.yml` move the SHA and rewrite that comment to the new commit's most specific tag (`VersionCommenter` in dependabot-core), so the pins stay current with no new setting. A `# v7` comment would not match the tag Dependabot looks up.
