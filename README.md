# DiffCI

[![npm version](https://img.shields.io/npm/v/@diffci.com/diffci.svg)](https://www.npmjs.com/package/@diffci.com/diffci)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://docs.npmjs.com/generating-provenance-statements)
[![GitHub Action](https://img.shields.io/badge/action-DiffCI%2FDiffCI.com%40v0.1.4-blue)](https://github.com/DiffCI/DiffCI.com)

**Find test-selection opportunities in your CI before changing what it runs.** DiffCI analyzes a
commit's changes and dependency graph, then reports which test files it would select, why it falls
back to a full run, and whether it can propose a test command. The `observe` command and Action are observation-only;
the opt-in `pilot` and `verify-savings` commands execute tests.

From an existing repository checkout, with Node.js 22.5+ and Git installed:

```bash
npx @diffci.com/diffci@latest observe --no-send
```

For the fastest self-serve runtime pilot, run one paired check from the repository root:

```bash
npx @diffci.com/diffci@latest pilot --full "npm test"
```

On Windows PowerShell, quote the package name:

```powershell
npx '@diffci.com/diffci@latest' pilot --full "npm test"
```

This executes the full and selected commands sequentially, and writes `diffci-observe.json`,
`diffci-savings.json`, and `diffci-savings.md` to a sibling `diffci-output` folder outside the checkout.
The commands you supply may create files or otherwise change the checkout. One paired run is preliminary
timing evidence; repeat comparisons and account for cache effects before claiming savings.

**Upgrade from 0.1.3:** tests excluded by a source-only `tsconfig.json` could be discovered without
their dependency edges, producing an incomplete selection. This is fixed in **0.1.4**. Revalidate
affected observations before using them as opportunity evidence; see the
[historical validation](docs/evidence/growth-history-01/README.md) and
[release qualification](docs/evidence/release-0.1.4/README.md).

The local default compares `HEAD` with its first parent; both commits must be available. For a specific
comparison, add `--base <base-sha> --head <head-sha>`. DiffCI prints the selection, fallback reasons,
and the path to a JSON report outside your checkout. `REFUSED` or `ERROR` is not a successful analysis;
check the reported status even when the command exits successfully. See the
[support matrix](docs/language-support.md) for setup requirements and supported workloads.

**Measured example:** a controlled Cal.com replay showed **44.2% net reduction in a job-equivalent
install + pretest + test workload**, including analysis overhead. This is one sandbox comparison,
not Cal.com's production savings or a prediction for your repository.
[Read the timings and method](docs/research/2026-08-24-calcom-execution-observability/11-frozen-identity-and-complete-job-savings.md).

Selection counts alone do not establish runtime savings. Observation mode measures neither the
selected test execution nor realized savings.

For an advanced paired runtime check, you can still run `observe` first and then run `verify-savings`
against the observation report. It compares your normal full command with
DiffCI's proposed selected command and writes JSON plus Markdown evidence; see
[`docs/npm-adoption.md`](docs/npm-adoption.md#self-serve-runtime-pilot).

## Observe in GitHub Actions

Save this as `.github/workflows/diffci.yml` to add a dedicated, non-blocking observation job:

```yaml
name: DiffCI observation
on: [push, pull_request]
permissions:
  contents: read
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: DiffCI/DiffCI.com@dee4f7b938a7720d077c1124ef2ea050aa2625d6
```

Then check the workflow locally with `npx @diffci.com/diffci@latest verify-workflow`. Keep the observer
out of required checks and other jobs' `needs` lists. The Action adds a job summary and a
`diffci-observation` artifact to the run; it does not alter which tests your other jobs execute.
The example pins release `v0.1.4` to its full commit SHA for reproducibility.

The CLI sends no report with `--no-send`. The Action uploads a GitHub artifact by default; sending to
DiffCI's hosted service requires an explicitly configured endpoint and token.
[Installation details](docs/distribution.md) · [Seven-day pilot](docs/shadow-pilot-runbook.md)

## Which DiffCI package should I use?

| Surface | Use it for | Current distribution |
| --- | --- | --- |
| [`@diffci.com/diffci`](https://www.npmjs.com/package/@diffci.com/diffci) | Try `observe` locally, run an opt-in runtime pilot, or install the GitHub Action from this repository | Published npm CLI and Action |
| [`DiffCI/core`](https://github.com/DiffCI/core) | Study or build on the standalone dependency-analysis and conservative-planning engine | Public AGPL source; clone and build locally; `@diffci.com/core` is being prepared for npm publication |

The published npm CLI still uses the engine bundled in this repository. This migration branch switches
the observer to the standalone Core engine; that change will reach npm after the Core package is
published and the CLI package is released. See
[`docs/package-relationship.md`](docs/package-relationship.md) for the current boundary and integration
path. For evaluation results and their limits, start with
[`docs/adoption-evidence.md`](docs/adoption-evidence.md).

## Project background

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
- uses: DiffCI/DiffCI.com@dee4f7b938a7720d077c1124ef2ea050aa2625d6
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
