# DiffCI observer

Change-aware CI analysis that runs inside your own CI and **changes nothing**.

For each commit or pull request, DiffCI builds a dependency graph of your repository, works out which
tests that change could actually affect, and records what a change-aware run *would* have selected. It
does not run tests, skip tests, cancel jobs, re-order steps, or write to your repository. There is no
option that turns any of that on.

Proprietary software, licensed — see [LICENSE](LICENSE).

## Install

DiffCI is installed from an authenticated registry and pinned to an exact version. Your onboarding page
generates this file with the version and integrity hash issued to you - the example below shows the
shape, not the version you should use:

```yaml
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true          # a DiffCI failure must never become your workflow's conclusion
    permissions:
      contents: read                 # the only permission needed
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0             # the base commit must exist locally, or DiffCI refuses
      # Your onboarding page generates this whole file with your own values filled in.
      - run: npx --yes @diffci/observer@1.4.2 observe
        env:
          NODE_AUTH_TOKEN: ${{ secrets.DIFFCI_REGISTRY_TOKEN }}
          DIFFCI_API_URL: https://app.diffci.com/v1/ingest/observations
          DIFFCI_TOKEN: ${{ secrets.DIFFCI_TOKEN }}
```

**Pin the exact version, never a range.** `@latest`, `^1.4` and `1.x` all resolve to whatever is newest
at install time, which means the code running in your CI can change without your repository changing.
DiffCI will not generate onboarding instructions that do this.

Your lockfile records the integrity hash npm verifies on every install. Keep it.

## What runs where

**Everything that touches your code runs on your runner.** The dependency graph, impact analysis and
selection are computed locally against the checkout your workflow already has. Your source never leaves
the runner, and DiffCI has no ability to read your repository from anywhere else.

**Optionally**, one JSON report is sent to DiffCI. With no `DIFFCI_API_URL` and `DIFFCI_TOKEN`
configured, nothing leaves the runner and the report is written to disk instead.

## What is in the report

Counts, durations, commit SHAs, repository and CI identity, graph statistics, and — unless you turn
them off — **the paths of changed and selected files**. Never file contents, environment variables, or
credentials.

Set `--redact-paths` to replace every path with a stable 12-character digest. Counts and comparisons
still work; the paths become opaque.

## Supported

**Repositories with a TypeScript project — a `tsconfig.json`.** That is the actual requirement, and
DiffCI refuses anything else at eligibility rather than guessing. Within that: TypeScript project
references and `paths` mappings, npm/pnpm/yarn workspaces, and test discovery from **vitest**,
**jest** and **`node:test`**.

JavaScript sources inside such a project are analysed. A **JavaScript-only repository with no
`tsconfig.json` is not supported** — DiffCI declines it and says so. Earlier wording here said
"TypeScript and JavaScript repositories", which promised more than the product does.

Other language ecosystems need graph builders that do not exist yet.

## Fail-closed

Whenever DiffCI cannot be certain, it reports FULL — "run everything" — rather than a selection. That
happens when there is no recognisable TypeScript configuration, when no graph can be built, when the
test framework cannot be identified, when the discovered test universe is empty, when a changed file
cannot be classified, when dependency manifests change in ways the graph cannot bound, or when the
commit range cannot be resolved.

A FULL verdict is DiffCI working correctly. On some repositories a simple path-rule CI already scopes
changes as well as DiffCI does; the report includes what such a comparator would have selected, next to
DiffCI's own selection, so you can see when DiffCI adds nothing.

## Verifying it changed nothing

Every report records the head SHA and a digest of the worktree before and after the run, and whether the
report was written outside the checkout. `npx @diffci/observer verify-workflow` parses your own workflow
files and fails if the DiffCI job is not isolated — if another job `needs:` it, if it lacks
`continue-on-error: true`, if it shares a job with build steps, or if it holds write permissions.

## Status

Early. DiffCI is observation-only, and every figure it produces is potential opportunity — what a
change-aware run *could* have avoided — never a measured saving, because the selected subset is never
executed. Treat the numbers accordingly.

## Support

<SUPPORT CONTACT — TO BE ESTABLISHED>

Security reports: <SECURITY CONTACT — TO BE ESTABLISHED>. Please do not disclose publicly first.
