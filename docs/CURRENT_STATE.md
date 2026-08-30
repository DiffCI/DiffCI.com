# DiffCI — Current State

**As of:** 2026-08-21 (live-verified against the deployed Worker and this repo's own CI at the time of
writing; updated later the same day after the source-integrity fix below shipped and was live-verified)
· **Repo:** [github.com/adityankale190895/DiffCI.com](https://github.com/adityankale190895/DiffCI.com)
· **Branch:** `main` @ `b997c6d`, working tree clean

This document is a snapshot, not a design doc. For the full narrative and decision rationale behind any
of this, follow the links in [Reference index](#reference-index) at the bottom — this file exists so you
don't have to read all 31 research reports to know where things stand right now.

## TL;DR

- **What it does today:** given a commit range, DiffCI builds a real TypeScript dependency graph and
  computes a confidence-scored, fallback-aware CI execution plan (what could safely be skipped). It has
  never been wired to actually skip, cancel, or block real CI anywhere — every mode is observe-and-compare.
- **Validation stage:** Stage 0–1B (historical, 2,000+ deltas) are complete — **GO WITH CONDITIONS**.
  Stage 2 (prospective shadow validation on live traffic) is **in progress**, running autonomously
  24/7, verdict **EXTEND SHADOW VALIDATION** (not enough real volume yet for a go/no-go call).
- **Infra:** two Cloudflare Workers (research/shadow pipeline, and a self-hosted GitHub Actions runner
  dispatcher), D1 + R2 for persistence, Cloudflare Sandbox Containers for real git/TypeScript analysis.
  Two separate, least-privilege GitHub Apps.
- **CI health:** 336/336 tests passing, typecheck clean, this repo's own CI now runs on a
  Cloudflare-Container-backed self-hosted runner fleet (not GitHub-hosted) and has been green for the
  last 8 consecutive runs, ~1 minute each once warm, ~$0.004/job, zero GitHub Actions billing consumed.
- **Biggest live gap as of the original writing of this doc** (the autonomous cron's diffci source
  snapshot in R2 stamped `e58fdfb` while `main` had moved 4 commits past it) **is now fixed and
  live-verified** — see [`2026-08-21-shadow-source-integrity-fix.md`](research/2026-08-21-shadow-source-integrity-fix.md)
  and [Known gaps §1](#known-gaps--action-items). The invariant (deployed Worker's expected SHA == R2
  archive SHA == SHA recorded on every new prediction) now holds by construction — a mismatch fails
  closed (STALE/MISSING/UNKNOWN) instead of silently analyzing with old code.

## 1. What DiffCI is

A deterministic, change-aware CI planner. Given a commit or PR:

1. `src/git/` (`analyzeGitDelta`) parses the commit range into a structured `GitDelta`. Invariant: a
   failed analysis returns `{ success: false, error }` explicitly — never a silently-empty affected set,
   because an empty set would read as "safe to skip everything."
2. `src/repo/` builds a real TypeScript-compiler-backed dependency graph (`buildDependencyGraph`) and
   runs `ImpactAnalyzer` to turn the graph + delta into a confidence-scored, fallback-aware impact result.
3. `src/planner/` (`DefaultCIPlanner`) turns that impact result into an `ExecutionPlan` — which
   tasks/tests run, which are skip-candidates, and why.

Everything downstream of this (Stage 0/1 research pipeline, Stage 2 shadow pipeline) exists to measure
whether that plan is *safe* and *worth it* before anything is ever allowed to act on it.

## 2. Origin

Moved out of the `DentalPresence.in` monorepo (previously `diffci/` there) into its own repo on
2026-08-21. `DentalPresence.in` remains DiffCI's original dogfooding target — some code (DentalPresence
PATH baseline/task registry, a few fixture tests) still reflects that origin, but the research and
shadow-validation pipelines are generic and have run against dozens of real third-party repositories.

## 3. Validation history

| Stage | Scope | Verdict |
|---|---|---|
| **Stage 0** | 2,000-delta historical benchmark across 20 real repositories, run through a real Cloudflare orchestrator | **GO WITH CONDITIONS** |
| **Stage 1A** | Forensic root-cause investigation of every Stage 0 UNSAFE-confidence case and historical "unsafe miss" candidate; identified top 3 highest-leverage fixes | (diagnostic — feeds 1B) |
| **Stage 1B** | Implemented the 3 fixes (reachability-aware confidence narrowing, improved historical safety-measurement methodology, tsconfig-scope + package.json-diffing fix); validated live — coverage improved, zero contradicted safety cases; ran a real wall-clock FULL/PATH/DiffCI runtime pilot | Fixes shipped and validated |
| **Stage 2** (current) | Prospective shadow validation on real, currently-arriving CI events — not more historical benchmarking | **EXTEND SHADOW VALIDATION** |

Full reports: [`docs/research/`](../docs/research/) (31 dated documents). Start with
[`2026-08-21-stage2-final-report.md`](research/2026-08-21-stage2-final-report.md) and
[`2026-08-21-stage2-architecture.md`](research/2026-08-21-stage2-architecture.md) for the fullest picture
of what's built vs. not.

## 4. Stage 2 — live status (queried directly from the deployed Worker for this document)

Stage 2 moved from "a session has to babysit it" to **fully autonomous** partway through 2026-08-21: a
Cloudflare Cron Trigger (`*/10 * * * *`) polls+reconciles enrolled repositories on its own
(`src/research/cloudflare/shadow-cron.ts`), and a registered, read-only **DiffCI Shadow GitHub App**
delivers push/`workflow_run` webhooks for instant predictions and exactly-on-time reconciliation
(`src/shadow/github-app.ts`, `src/research/cloudflare/shadow-webhook.ts`).

Real numbers, pulled from `GET /v1/shadow/status` at time of writing:

| Repository | State | Predictions | Ground truth reconciled | Discriminative opportunities | Mandatory fallback | Baseline-already-optimal |
|---|---|---:|---:|---:|---:|---:|
| `unjs/h3` | SHADOW_ACTIVE | 3 | 0 | 0 | 2 | 1 |
| `unjs/unstorage` | SHADOW_ACTIVE | 1 | 0 | 1 | 0 | 0 |
| `unjs/defu` | VALIDATING | 0 | 0 | 0 | 0 | 0 |
| `adityankale190895/DiffCI.com` (self) | SHADOW_ACTIVE | 14 | 0 | 3 | 3 | 8 |
| `adityankale190895/DentalPresence.in` | SHADOW_ACTIVE | 15 | 0 | 6 | 6 | 3 |

**33 total predictions recorded, 0 reconciled to real ground truth yet.** This is expected, not broken:
`GET /v1/shadow/cron-status` shows the cron has run every 10 minutes without error (24 predictions
"still pending" in each of the last several runs) — commits simply haven't had time for their own CI to
finish and be fetched back yet, especially since this repo's own CI only just came online (see §5). Zero
reconciliations means every one of Stage 2's headline questions (prospective recall, unsafe-miss rate,
cost/savings) remains genuinely unmeasured — not a defect, just insufficient elapsed time, exactly as the
final report says.

This repository (`DiffCI.com`) and `DentalPresence.in` shadow-observe **themselves** via the installed
App (installation id `155368612`) — every push to `main` triggers an immediate poll.

## 5. CI / self-hosted runner infrastructure

This repo's own CI (`.github/workflows/ci.yml`, `npm run check` — typecheck + full test suite) no longer
runs on GitHub-hosted runners. It dispatches to `[self-hosted, cloudflare]`: a `workflow_job` webhook
(from a **second**, separate, write-scoped GitHub App — "DiffCI Runner Dispatcher") triggers
`src/research/cloudflare/github-runner-worker.ts`, which spins up a fresh Cloudflare Container
(`ops/github-runner/Dockerfile`, GitHub Actions runner agent 2.336.0) per queued job. The runner
registers, runs the job, deregisters, and self-terminates.

**Status: green, steady-state verified.** Last 8 consecutive `CI` runs on `main` all `success`, most
recent one 1m3s. Job cost ~$0.004; zero GitHub Actions compute billed. Getting here required fixing six
real, distinct bugs in sequence (all in commit history 2026-08-20/21): a missing `User-Agent` header that
403'd every Worker→GitHub API call, a CRLF-mangled `entrypoint.sh` shebang, missing `libicu74`/`libssl3`
on Ubuntu 24.04, a 15-releases-stale runner agent, a container `sleepAfter` killing idle containers
mid-queue-wait, and — the one that actually blocked steady state — every Cloudflare Container reporting
`HOSTNAME=cloudchamber`, so runner names collided and each new registration silently killed the previous
one's connection.

**Why this exists at all:** this GitHub account's own Actions billing is/was blocked ("recent account
payments have failed"), independent of anything in this codebase. Rather than wait on that, DiffCI's own
CI (and its own shadow ground truth) now runs entirely on Cloudflare credits.

Two GitHub Apps exist and are **deliberately never merged**:

| App | Permissions | Installable by | Status |
|---|---|---|---|
| **DiffCI Shadow** | Read-only: Metadata, Contents, Actions, Checks, Pull requests | Design partners + own repos | **Registered, live** (`docs/github-app-registration.md`) |
| **DiffCI Runner Dispatcher** | `Administration:write`, `Actions:write` | Own repos only (DiffCI.com, DentalPresence.in) | **Registered, live** (`docs/github-app-registration-runner.md`) |

## 6. Build/test health (verified for this document)

```
npm run typecheck   → clean, no errors
npm run test        → 336 passed, 0 failed, 0 skipped (74 suites) — 34 new tests from the source-integrity fix
```

Working tree is clean; `main` is up to date with `origin/main`.

## 7. Known gaps / action items

1. ~~Cron is polling a stale source snapshot~~ — **fixed and live-verified**
   ([`2026-08-21-shadow-source-integrity-fix.md`](research/2026-08-21-shadow-source-integrity-fix.md)).
   `GET /v1/shadow/cron-status`'s `sourceIntegrity` now reports `status: "CURRENT"` with `expectedSha`,
   `archiveSha`, and this repo's real HEAD (`b997c6d...`) all equal — confirmed by directly querying the
   deployed Worker after running the new `npm run shadow:deploy` pipeline. A live self-observed
   prediction (via the DiffCI Shadow App's push webhook, triggered by this fix's own commits) recorded a
   real, non-null `engine_source_sha`, proving the field flows through end-to-end, not just in unit
   tests. Any future drift between the deployed Worker's expected SHA and the R2 archive now fails
   closed (`STALE`/`MISSING`/`UNKNOWN`) and blocks autonomous analysis rather than silently using old
   code — this class of bug cannot recur silently.
2. **Zero ground-truth reconciliations across all 5 enrolled repositories.** Every headline Stage 2
   metric (prospective recall, unsafe-miss rate, fallback rate at scale, cost/savings) is still an empty
   denominator. This should resolve itself now that own-repo CI is real and green — but hasn't yet as of
   this writing.
3. ~~`docs/github-app-registration-runner.md` is stale~~ — **fixed**: its status banner now reflects
   registration + verified green CI (see §5).
4. **No `DISCRIMINATIVE_OPPORTUNITY` prediction has been ground-truthed yet** — the category that
   actually exercises DiffCI's selective-skipping logic. 4 have been predicted (1 on `unstorage`, 3 on
   this repo) but none reconciled.
5. **No real design-partner repositories** — Gates B (1 partner), C (3 repos), D (5-10 repos) all
   explicitly need actual external stakeholders, which this project does not have yet. Cannot be
   substituted with more public repos.
6. **No dashboard/customer-facing UI, no dollar-cost economics** — `/v1/shadow/status` returns raw JSON
   only; no UI. Blocked on real reconciled volume, not effort.
7. **`DentalPresence.in`'s own workflows** reportedly still target `ubuntu-latest` (billing-blocked) per
   project memory as of this writing — not independently re-verified in this session since it's a
   separate repository; switching them to `[self-hosted, cloudflare]` (same pattern as this repo's
   `ci.yml`) would put its CI on Cloudflare too and unblock its own shadow ground truth.

## 8. Architecture map

```
src/git/       Git delta analysis → structured GitDelta (fail-closed by design)
src/repo/      TS-compiler-backed dependency graph + ImpactAnalyzer (confidence-scored impact)
src/planner/   Impact result → ExecutionPlan (DefaultCIPlanner); DentalPresence-specific PATH
               baseline/task registry lives here too (origin artifact, not generic)
src/cache/     Graph caching
src/research/  Stage 0/1 historical benchmark pipeline: repo sampling, generic PATH baseline,
               opportunity classifier, historical GitHub CI evidence + flakiness detection,
               and the Cloudflare orchestrator (src/research/cloudflare/) that runs it at scale
src/shadow/    Stage 2 prospective pipeline: event identity, failure classification,
               ground-truth reconciliation (reconcile.ts), GitHub App JWT/webhook code
               (github-app.ts) — registered and live, see §5
```

**Cloudflare deployment (two Workers, deliberately separate):**

- `diffci-research-sandbox` (`wrangler.research-sandbox.jsonc`) — the Stage 0/1/2 research + shadow
  pipeline. D1 (`diffci-research`), R2 (`diffci-research-evidence`), Sandbox Containers
  (`cloudflare/sandbox:0.12.5`, real git clone + TypeScript compiler), Cron Trigger every 10 minutes.
- `diffci-github-runner` (`wrangler.github-runner.jsonc`) — the ephemeral self-hosted Actions runner
  dispatcher. Durable Object–backed container class (`GithubRunner`), `max_instances: 5`, triggered by
  `workflow_job` webhooks from the separate Runner Dispatcher App.

## 9. Security model (Stage 2 shadow pipeline)

- Every `/v1/shadow/*` route requires the same constant-time Bearer-token check as every other route on
  the research Worker.
- `owner`/`name`/`language` are validated against a strict allow-list before reaching any shell command
  inside a Container.
- Webhook payloads are verified by HMAC-SHA256 before any processing (`verifyWebhookSignature`).
- Shadow mode is read-only end-to-end — clone and analyze, never write, never comment, never label,
  never check out a branch for writing.
- Tenant isolation today is by-value only (every D1 row/R2 key is repository-scoped) — no cross-repo
  query path exists, but there's also no row-level access control tied to installation identity yet.
  Flagged as a real gap for Gate B+ (multi-tenant), not silently assumed solved.

## 10. Commands

```bash
npm run check                    # typecheck + full test suite
npm run diffci / npm run impact  # generate a delta/impact/plan for this repo's latest commit
npm run research:stage0          # real Stage 0-style historical benchmark, locally
npm run shadow:deploy            # CANONICAL: typecheck+test, deploy the research/shadow Worker, upload
                                  # the source archive tagged with real HEAD, verify source integrity is
                                  # CURRENT before exiting 0 - use this, not the two commands below, for
                                  # any change to src/ that should be live in autonomous shadow polling
npm run research:sandbox:deploy  # low-level: deploy the research/shadow Worker only (no source upload/verify)
npm run shadow:upload-source     # low-level: re-upload the diffci source tarball only (no Worker deploy)
npm run github-runner:deploy     # deploy the self-hosted-runner dispatcher Worker
```

## Reference index

- [`README.md`](../README.md) — the maintained top-level summary this doc supplements with live numbers.
- [`docs/research/2026-08-21-shadow-source-integrity-fix.md`](research/2026-08-21-shadow-source-integrity-fix.md) —
  the source-version integrity fix (stale-cron incident, invariant, schema/migration, tests, live
  verification).
- [`docs/research/2026-08-21-stage2-final-report.md`](research/2026-08-21-stage2-final-report.md) —
  Stage 2 results and decision as of the session that shipped the shadow pipeline itself.
- [`docs/research/2026-08-21-stage2-architecture.md`](research/2026-08-21-stage2-architecture.md) — full
  Stage 2 design, gap analysis, GitHub App design.
- [`docs/research/2026-08-21-stage2-enforcement-thresholds.md`](research/2026-08-21-stage2-enforcement-thresholds.md) —
  the pre-committed volume floor (≥50 reconciled runs, ≥15 discriminative opportunities, ≥5 evaluable
  failures, ≥14 days) that would need to be met before any enforcement conversation.
- [`docs/github-app-registration.md`](github-app-registration.md) — Shadow App registration checklist
  (done).
- [`docs/github-app-registration-runner.md`](github-app-registration-runner.md) — Runner Dispatcher App
  checklist (done, status banner updated to match).
- `docs/research/2026-08-20-stage0-full-experiment-final-report.md` and neighboring
  `2026-08-2{0,1}-stage0-*`/`stage1a-*`/`stage1b-*` files — the full historical-validation story.

## Validation programme (safety, economics, eligibility)

- [`docs/external-validation-protocol.md`](external-validation-protocol.md) — **the live one.** Protocol
  frozen at `910969f`, no target selected, nothing cloned. Read before touching the eligibility gate.
- [`docs/economic-eligibility-gate.md`](economic-eligibility-gate.md) — the pre-deployment assessment:
  what it predicts, from observation alone, and what it deliberately does not do.
- [`docs/laboratory-defects.md`](laboratory-defects.md) — every defect found in the measuring apparatus,
  and what each would have produced had it survived. Almost all of them fail toward optimism.
- [`docs/technical-branch-endpoint.md`](technical-branch-endpoint.md) — why selector work stopped.
- [`docs/safety-validation-milestone.md`](safety-validation-milestone.md) and
  [`docs/compute-economics-results.md`](compute-economics-results.md) — the underlying evidence.
