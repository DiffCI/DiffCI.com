# Phase 02 — the client-side observer

**Date:** 2026-08-26 · **Exit criterion:** seven days in a third-party repository, CI byte-identical.

Phase 01 made the engine repo-agnostic. Phase 02 makes it *installable*: a command that runs inside
somebody else's CI, against a checkout they already have, and a GitHub Action that adds it as one inert
job. This document records what was built, what was measured, and — the longer half — what has to happen
outside this repository before the exit criterion can be claimed.

## The inversion

Every pipeline in this repository before today analysed other people's repositories **on DiffCI's
infrastructure**: a Cloudflare container cloned the source, built the graph, kept the evidence. That
shape cannot be installed by a stranger. It asks them to hand a private tree to a service they have not
evaluated, before they have seen a single number from it.

The observer runs the same engine on **their** runner. The source never moves. The only thing that
leaves is one JSON report, and the report says in its own body what it contains.

## What shipped

| File | What it is |
|---|---|
| [`src/client/report.ts`](../src/client/report.ts) | The wire format (`diffci.observation.v1`), plus the validator Phase 03 ingest will reuse. The privacy boundary is this file: every field DiffCI could learn is here, and `includesFileContents`/`includesCredentials` are typed as literal `false`. |
| [`src/client/context.ts`](../src/client/context.ts) | Recovers the commit range from the CI environment, or refuses. |
| [`src/client/observe.ts`](../src/client/observe.ts) | One observation: eligibility → delta → graph → impact → command → comparator. Never throws. |
| [`src/client/workflow-guard.ts`](../src/client/workflow-guard.ts) | Static proof that the DiffCI job cannot affect any other job. |
| [`src/client/cli.ts`](../src/client/cli.ts) | `diffci observe`, `diffci verify-workflow`, `diffci version`. |
| [`action.yml`](../action.yml) | The composite action a third-party repository installs. |
| [`examples/diffci-observe.yml`](../examples/diffci-observe.yml) | The workflow to copy, with the properties that matter commented in place. |
| [`.github/workflows/diffci-observe.yml`](../.github/workflows/diffci-observe.yml) | This repository observing itself through the same action, via `uses: ./`. |
| [`tsconfig.client.json`](../tsconfig.client.json) | Builds only the observer's transitive imports — 20 files, no Cloudflare modules — so the action installs `--omit=dev`. |

`@types/node` moved from `devDependencies` to `dependencies` for that last reason: the action compiles
the observer inside the consumer's CI with production dependencies only.

## Byte-identical, argued three ways

The claim is not "we were careful". It is three independent mechanisms, two of which are checked on
every single run:

**1. The job is structurally inert.** DiffCI goes in a job of its own. `verify-workflow` parses the
repository's real workflow YAML and fails on the specific ways that stops being true: another job
`needs:` it, it lacks `continue-on-error: true` (so a DiffCI failure becomes the *workflow's* conclusion,
which is what a required status check and a merge queue read), it shares a job with real build steps, it
holds write permissions, it is pinned to a mutable tag, or it shares a concurrency group. Findings carry
stable codes; `BLOCKING` means the byte-identical claim cannot be made from that workflow.

**2. The report lands outside the checkout.** An untracked file in the working tree changes
`git status`, and a repository with a clean-tree check (generated code, lockfiles, `git diff
--exit-code`) would start failing *because DiffCI was installed*. The default is `RUNNER_TEMP`; a
`--out` inside the repository is refused, not silently relocated.

**3. Every run carries its own evidence.** `HEAD` and a digest of `git status --porcelain` are captured
before and after the observation, and both pairs go in the report. A run that did dirty the tree says so
in its own record, on the day it happened, rather than being discovered at the end of the week.

There is no mode in the observer that runs, skips, cancels or re-orders anything. That is not a default
that could be flipped — the code to do it does not exist on this path.

## Measured

Four repositories, real clones, the production path end to end. Wall clock is from a Windows workstation
with a warm page cache, **not** from a GitHub runner — treat it as an order of magnitude, not a
benchmark.

| Repository | Changed file | DiffCI | Selected | Simple path-rule CI | Graph | Total |
|---|---|---|---:|---|---:|---:|
| `unjs/h3` | a docs page | SELECTIVE | 0/70 | 0 (docs-only rule) | 173 nodes | 3.2s |
| `immerjs/immer` | `__tests__/prototype-inspection.js` | SELECTIVE | 1/23 | 23 (directory scoping) | 39 nodes | 2.0s |
| `sindresorhus/execa` | `package.json` | **FULL** | 0/151 | everything | 446 nodes | 37.8s |
| this repository | two docs files | SELECTIVE | 0/138 | 0 (docs-only rule) | 358 nodes | 4.9s |

Read the third row as the honest one: a `package.json` change forces a full run, DiffCI proposes nothing,
and the analysis still cost 38 seconds of somebody's runner. On the second row DiffCI selects one test
where the simple comparator runs all 23 — that is the only row here where DiffCI beats the comparator,
and one commit is not evidence of anything. The seven-day window exists to replace this table.

The action's own overhead was measured the same way, by running its steps against a copy of this
repository containing only `package.json`, the lockfile, the tsconfigs and `src/`:
`npm ci --omit=dev --ignore-scripts` installs **4 packages, 27 MB, 11s**, and
`tsc -p tsconfig.client.json` builds the observer in **3s**. That is what every observed run costs the
host repository before any analysis starts, on top of `actions/setup-node`.

`immerjs/immer` also confirms a Phase 01 fix in the client path: its 23 suites are `__tests__/*.js` with
no `.test.` infix, invisible to the engine before today, and the emitted command
(`yarn run vitest run --config vitest.config.ts __tests__/prototype-inspection.js`) is one that
repository could actually run.

## Tests

32 new tests (`tests/client/`), full suite 1,419 passing, typecheck clean. The ones that carry weight:

- A real fixture repository on disk — real git, real `ts.Program` — asserting the selection, the emitted
  command, `worktreeUnchanged`, and an empty `git status --porcelain` afterwards.
- Refusal, not a guess, for: a pull-request base missing from a shallow checkout, a first push whose
  `before` is forty zeros, a repository with no TypeScript project, a range that does not exist.
- The workflow guard against the installation someone actually writes first: pasted into the job that
  already builds, no `continue-on-error`, floating tag, and another job waiting on it.

## What the operator has to do — the exit criterion is not code

None of the above satisfies "seven days in a third-party repository". That needs, in order:

1. **A repository that is not ours, with its owner's agreement.** Not a fork, not a public repo we
   observe from the outside — an installation someone consented to. This is the Gate B blocker recorded
   in [`CURRENT_STATE.md`](CURRENT_STATE.md) §7, unchanged by Phase 02.
2. **This repository reachable as an action.** The canonical install line is
   `uses: DiffCI/DiffCI.com@v1`. For high-trust pilots, use the same repository pinned to a full commit
   SHA.
3. **A pinned commit SHA in their workflow for security-sensitive pilots**, not a branch or tag — the
   guard warns about mutable refs, and a SHA is what makes "the code did not change under them"
   checkable. The `v1` tag is the ergonomic OSS install path.
4. **`verify-workflow` run against their file, exiting 0**, before the window starts.
5. **Seven days of runs, and the artifacts collected.** Reports are workflow artifacts today; there is
   no ingest endpoint until Phase 03, so nothing is transmitted anywhere and collection is manual.
6. **A byte-identity comparison they can check**: the same set of jobs, the same steps, the same
   conclusions, on runs before and after installation. Every report carries its own non-interference
   evidence; the workflow-level comparison is theirs to make.

## Not done, stated so it is not discovered later

- **Now package-shaped.** The npm package name is `@diffci.com/diffci`, with `npx @diffci.com/diffci observe` and
  `npx @diffci.com/diffci verify-workflow` as the standalone CLI surface. Publishing still requires an npm token
  and a tagged release.
- **No ingest.** Reports stay on the runner as artifacts. Sending them anywhere — and the tenancy that
  has to exist before that is safe — is Phase 03.
- **TypeScript/JavaScript only**, ten test frameworks. Unchanged from Phase 01, and the eligibility
  refusal now says so in the report rather than in a log line.
- **Cost is real and falls on the host.** 38 seconds for a 446-node graph, plus `npm ci` and a TypeScript
  build of the observer in every run. The example workflow caps the job at 20 minutes; nothing caches
  the observer build yet.
- **The action has never run on a runner.** Its individual steps were reproduced locally — the
  production-only install, the client build, the observation — but `action.yml` as GitHub executes it,
  including `setup-node` and the artifact upload, has not run once. The self-observation workflow added
  in this phase is what exercises it first, on the next push to this repository; until that run is green
  the action is written but unproven.
- **Nothing is cached between runs.** The 11s install and 3s build repeat on every observed commit.
