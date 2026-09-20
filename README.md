# DiffCI

[![npm version](https://img.shields.io/npm/v/@diffci.com/diffci.svg)](https://www.npmjs.com/package/@diffci.com/diffci)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://docs.npmjs.com/generating-provenance-statements)
[![GitHub Action](https://img.shields.io/badge/action-DiffCI%2FDiffCI.com%40v0.1.4-blue)](https://github.com/DiffCI/DiffCI.com)

DiffCI is a deterministic, change-aware CI planner: given a commit or PR, it builds a real TypeScript
dependency graph, computes what's actually reachable from the changed files, and proposes which CI
tasks/tests could safely be skipped - without ever modifying production CI behavior itself. Every mode
this repository currently implements is observe-and-compare only; nothing here can cancel, skip, or block
a real CI run.

Try it in shadow mode:

```bash
npx @diffci.com/diffci@latest observe
npx @diffci.com/diffci@latest verify-workflow
```

Or install it as a non-blocking GitHub Action:

```yaml
- uses: DiffCI/DiffCI.com@v0.1.4
```

The promise is deliberately narrow: DiffCI observes your CI and reports what it would have selected.
It does not skip tests, cancel jobs, change required checks, or send reports anywhere unless you
explicitly configure an endpoint and token.

**This repository moved out of the [DentalPresence.in](https://github.com/adityankale190895/DentalPresence.in)
monorepo** (previously `diffci/` there) into its own repo on 2026-08-21, once the project outgrew being a
subfolder. DentalPresence.in remains DiffCI's original dogfooding target - some code (the `planner`
DentalPresence-specific PATH baseline/task registry, a few fixture tests) still reflects that origin - but
the research and shadow-validation pipelines are generic and have been exercised against dozens of
real third-party repositories.

## Current state

Language expansion: initial Vue SFC and Go package-level analysis is implemented through repository
adapters. See [the support matrix and setup requirements](docs/language-support.md) for exact scope,
fallback behavior, and validation boundaries.

Three completed research stages plus an in-progress prospective-validation stage, in order:

- **Stage 0** - a 2,000-delta historical benchmark across 20 real repositories, run through a real
  Cloudflare orchestrator. Verdict: **GO WITH CONDITIONS**.
- **Stage 1A** - forensic root-cause investigation of every repository/delta where Stage 0's confidence
  model degraded to UNSAFE, and of every historical "unsafe miss" candidate. Identified the top 3
  highest-leverage fixes.
- **Stage 1B** - implemented those 3 fixes (reachability-aware confidence narrowing, an improved
  historical safety-measurement methodology, a tsconfig-scope + package.json-diffing fix), validated them
  live against real repositories (coverage improved, zero contradicted safety cases), and ran a real
  wall-clock FULL/PATH/DiffCI runtime pilot.
- **Stage 2** (current) - prospective shadow validation on real, currently-arriving CI events, not more
  historical benchmarking. A live pipeline (Cloudflare Sandbox Containers + Worker, D1 + R2) observes real
  repositories, predicts *before* their outcome is known, and later reconciles against the real CI result.
  Current verdict: **EXTEND SHADOW VALIDATION** - the pipeline is real and defect-free, and since
  2026-08-21 it runs **autonomously**: a Cron Trigger polls enrolled repositories every 10 minutes
  (`src/research/cloudflare/shadow-cron.ts`), and the registered **DiffCI Shadow GitHub App**
  (read-only; see [`docs/github-app-registration.md`](docs/github-app-registration.md)) delivers
  push/workflow events to `/v1/shadow/webhook` for instant predictions and exactly-on-time
  reconciliation - this repository shadow-observes itself through that App. See
  [`docs/research/2026-08-21-stage2-final-report.md`](docs/research/2026-08-21-stage2-final-report.md)
  for the full picture; what's honestly still missing is real observation volume, working GitHub
  Actions on our own repositories (account billing), and real design-partner repositories.

Every dated report behind these stages lives in [`docs/research/`](docs/research/) - start with
`2026-08-21-stage2-architecture.md` for the fullest current picture of what's built vs not, or the
Stage 0/1A/1B reports for the historical-validation story.

For the next product milestone, see [`docs/alpha-readiness.md`](docs/alpha-readiness.md). It tracks the
private-alpha bar: install DiffCI, keep CI unchanged, collect real shadow observations, and render a
trustworthy potential-savings report.

## Architecture

DiffCI is now framed as an open-core product:

```text
DiffCI
|
├── Open-source core
|   ├── DiffCI engine
|   ├── CLI / npm package
|   ├── Local analysis
|   └── Basic GitHub Action
|       |
|       └── Tidelift package support
|
└── Commercial DiffCI
    ├── Hosted service / DiffCI Cloud
    ├── Organization dashboard
    ├── Historical analytics
    ├── Advanced CI/CD optimization
    ├── Enterprise policies
    ├── Managed runners
    ├── Team features
    └── Support / enterprise services
```

The open-source core is the trust and adoption surface. It runs locally or in the host repository's own
CI, writes a report, and changes nothing about CI execution. Commercial DiffCI adds hosted history,
organization views, policy, managed operations, runners, and support. Tidelift belongs to the supported
open-source package path, not the hosted product feature boundary. See
[`docs/open-core-packaging.md`](docs/open-core-packaging.md) and
[`docs/tidelift-package-support.md`](docs/tidelift-package-support.md).

The source tree follows that split:

- `src/git/`, `src/repo/`, `src/planner/`, and `src/client/` are the installable OSS observer path.
- `action.yml` wraps the observer as a basic non-blocking GitHub Action.
- `src/research/` and `src/shadow/` run validation, GitHub App shadow observation, and reconciliation.
- `src/product/`, `src/auth/`, `src/billing/`, `src/ingest/`, `src/ledger/`, `src/runner/`, and
  `src/usage/` are the commercial/control-plane layer.
- `docs/oss-boundary.md` records what is allowed into the npm package.

## Commands

```bash
# Type-check and run the full test suite
npm run check

# Generate an example delta / impact / plan for the current repo's latest commit
npm run diffci
npm run impact

# Run a real Stage 0-style historical benchmark locally
npm run research:stage0

# Deploy the Cloudflare research/shadow Worker (D1 + R2 + Sandbox Containers)
npm run research:sandbox:deploy
```

## Install Surfaces

DiffCI is intended to be installable as infrastructure, not only as a hosted shadow experiment:

```yaml
- uses: DiffCI/DiffCI.com@v0.1.4
```

```bash
npx @diffci.com/diffci@latest observe
npx @diffci.com/diffci@latest verify-workflow
```

The GitHub Action and npm CLI establish the OSS/package distribution path. The hosted GitHub App and
DiffCI Cloud build on that trust boundary for teams that want shared reports and history. See
[`docs/distribution.md`](docs/distribution.md) for the package and Action positioning,
[`docs/open-core-packaging.md`](docs/open-core-packaging.md) for the commercial split, and
[`docs/npm-adoption.md`](docs/npm-adoption.md) for copy-paste pilot material.
