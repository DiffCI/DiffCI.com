# DiffCI

[![npm version](https://img.shields.io/npm/v/@diffci.com/diffci.svg)](https://www.npmjs.com/package/@diffci.com/diffci)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://docs.npmjs.com/generating-provenance-statements)
[![GitHub Action](https://img.shields.io/badge/action-DiffCI%2FDiffCI.com%40v1-blue)](https://github.com/DiffCI/DiffCI.com)

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
- uses: DiffCI/DiffCI.com@v1
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

## Architecture

- `src/git/` - Git delta analysis (`analyzeGitDelta`): parses a commit range into a structured,
  serializable `GitDelta`. Project invariant: **failure to analyze must never be interpreted as
  permission to skip CI** - a failed analysis returns `{ success: false, error }` explicitly, never a
  silently-empty affected set.
- `src/repo/` - the dependency graph engine (`buildDependencyGraph`, TypeScript-compiler-backed) and the
  impact analyzer (`ImpactAnalyzer`) that turns a graph + delta into a confidence-scored, fallback-aware
  impact result.
- `src/planner/` - turns an impact result into an `ExecutionPlan` (`DefaultCIPlanner`): which tasks/tests
  run, which are skip-candidates, and why.
- `src/research/` - the Stage 0/1 historical benchmark pipeline: repository sampling, the generic
  (non-DentalPresence-specific) PATH baseline, the opportunity classifier, historical GitHub CI evidence
  collection with flakiness detection, and the Cloudflare orchestrator (`src/research/cloudflare/`) that
  runs all of it at scale.
- `src/shadow/` - the Stage 2 prospective pipeline: event identity (`event-identity.ts`), failure
  classification, ground-truth reconciliation (`reconcile.ts`) against real CI outcomes, and (written,
  not yet registered) GitHub App JWT/webhook code (`github-app.ts`).

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
- uses: DiffCI/DiffCI.com@v1
```

```bash
npx @diffci.com/diffci@latest observe
npx @diffci.com/diffci@latest verify-workflow
```

The GitHub App remains the easiest shadow-mode entry point. The GitHub Action and npm CLI establish
the OSS/package distribution path: DiffCI can become an explicit CI dependency while preserving the
same observe-only contract. See [`docs/distribution.md`](docs/distribution.md) for the package and
Action positioning, or [`docs/npm-adoption.md`](docs/npm-adoption.md) for copy-paste pilot material.
