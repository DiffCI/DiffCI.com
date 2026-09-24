# DiffCI Adoption App

The DiffCI Adoption App is separate from the read-only DiffCI observer App. Its only purpose is to
open a draft pull request containing maintainer-reviewable adoption files. It never merges a pull
request, changes branch protection, changes required checks, or pushes to the default branch.

The App requests:

- metadata: read, to identify the selected repository;
- contents: write, to create one adoption branch and commit;
- pull requests: write, to open that commit as a draft pull request.

## Default: workflow-only draft PR

The default adoption request uses no DiffCI-funded container. It opens a draft PR containing only a
new `.github/workflows/diffci.yml`, pinned to an exact DiffCI npm version. The workflow runs as a
separate, non-blocking job on the repository owner's GitHub Actions allowance. It does not modify
`package.json` or a lockfile and refuses to overwrite an existing workflow.

## Optional: full dependency installation

When a maintainer explicitly requests a checked-in dependency, the generation worker runs
`diffci init --install --workflow` in a disposable Sandbox checkout so the
repository's own package manager produces the lockfile. Dependency installation disables lifecycle
scripts. The worker passes the installation token through the clone process environment rather than
placing it in command arguments, verifies the generated workflow, rejects changes outside its explicit
allowlist, limits exported file sizes, and destroys the Sandbox on success or failure.

The publisher accepts those prepared bytes,
creates blobs and one tree/commit through GitHub's Git Data API, then creates the branch and draft PR.
It deliberately does not attempt to synthesize npm, pnpm, Yarn, or Bun lockfiles itself.

The read-only observer App manifest remains unchanged. Do not add write permissions to it or reuse its
credentials for adoption PRs.
