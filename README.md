# DiffCI

## Public Core and private Cloud

DiffCI's public-good analysis engine is released separately from its commercial hosted product.
The project lives in the [DiffCI GitHub organization](https://github.com/DiffCI).
This mixed repository was transferred to `DiffCI/DiffCI.com` on 2026-09-16 and remains private.

| Component | Scope | Licensing |
| --- | --- | --- |
| [DiffCI Core](https://github.com/DiffCI/core) | Standalone dependency/change analysis, CI graph inference, safety/fallback, advisory test selection, synthetic benchmarking and local compute measurement | AGPL-3.0-only; public |
| DiffCI Cloud | Hosted infrastructure, billing, enterprise dashboard, organization management, proprietary data/services, and managed acceleration | Proprietary |
| Optional enterprise code | Separately scoped, visible and auditable enterprise capabilities | Source available, with commercial production rights controlled by DiffCI |

**This mixed repository remains private.** Only the reviewed Core extraction was published, with
fresh Git history. This repository retains its existing engine snapshot while package integration is
migrated separately. No blanket AGPL license applies to this repository. Public Core is advisory-only;
energy/carbon/cost are modeled estimates, not verified environmental savings. The exact extraction is
recorded in [the Core release audit](docs/core-release-audit.md).

The funded Core should run independently of DiffCI Cloud. AGPL permits commercial use and competing
hosting; it adds source-sharing obligations for covered modifications, including qualifying remote
network use. Grant eligibility depends on each grant's agreement and funded deliverables.

See the [licensing boundaries](docs/licensing.md), [organization and migration plan](docs/github-organization.md),
and [prepared organization profile](docs/github-org/profile/README.md).

DiffCI is a deterministic, change-aware CI planner: given a commit or PR, it builds a real TypeScript
dependency graph, computes what's actually reachable from the changed files, and proposes which CI
tasks/tests could safely be skipped - without ever modifying production CI behavior itself. Every mode
this repository currently implements is observe-and-compare only; nothing here can cancel, skip, or block
a real CI run.

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
