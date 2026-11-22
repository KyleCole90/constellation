# vite-plus and its vite alias move together

`@vitejs/plugin-react`, `@tailwindcss/vite` and `@tanstack/router-plugin` each name `vite` as a peer. Without a root `vite`, npm installs the real `vite` for them, and `vp build` refuses to run. So `package.json` sets `"vite": "npm:@voidzero-dev/vite-plus-core@<v>"` and `"overrides": { "vite": "$vite" }`, the layout `vp migrate` writes.

`vp` requires that `<v>` match exactly the core version that `vite-plus` itself depends on (`npm view vite-plus@<x> dependencies.vite`). Otherwise every build fails with `Expected @voidzero-dev/vite-plus-core@…, but found …`. Dependabot never rewrites an `npm:` alias. It bumped `vite-plus` alone in #25, #163, #231 and #234, and each of those PRs needed a commit by hand.

- `.github/dependabot.yml` keeps `vite-plus` out of the `npm` group. A `vite-plus` bump then fails on its own PR, and the rest of the group still merges.
- To land a `vite-plus` PR, set the alias to the version `vite-plus` depends on, run `npm install`, and push the lockfile to the PR's branch.
