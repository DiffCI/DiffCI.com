# Stage 0 full experiment — Cloudflare architecture & budget design

Builds on [2026-08-20-stage0-full-experiment-gap-analysis.md](./2026-08-20-stage0-full-experiment-gap-analysis.md).
Decisions below reflect the user's answers: 1 credit ≈ $1 of Cloudflare spend (2,000-credit ceiling ≈
$2,000, well inside the existing ~$10k T3 credit balance), same Cloudflare account with clearly
separate `diffci-research*` resources, and no GitHub token available — the pipeline must pace itself
under the unauthenticated 60 requests/hour REST limit.

## 1. Verified current Cloudflare pricing/limits (checked 2026-08-20, live docs)

| Dimension | Included (Workers Paid, already active on this account) | Overage rate |
|---|---|---|
| Worker/Workflow requests | 10M / month | $0.30 / million |
| Worker/Workflow CPU time | 30M CPU-ms / month | $0.02 / million CPU-ms |
| Workflow steps | 500,000 / month | $0.80 / additional 100,000 |
| Workflow storage | 1 GB-month | $0.20 / GB-month |
| D1 rows read | 25B / month | $0.001 / million rows |
| D1 rows written | 50M / month | $1.00 / million rows |
| D1 storage | 5 GB | $0.75 / GB-month |
| R2 storage | 10 GB-month | $0.015 / GB-month |
| R2 Class A ops (writes/mutations) | 1M / month | $4.50 / million |
| R2 Class B ops (reads) | 10M / month | $0.36 / million |
| Queues operations (read+write+delete, per 64KB) | 1M / month | $0.40 / million |

Limits that shape the architecture:
- A Workflow instance defaults to 10,000 steps, configurable up to 25,000; **step count excludes
  retries**. Each step's execution time is capped at 30 minutes; a step is free (no CPU billed) while
  waiting/sleeping.
- A Worker/Workflow invocation CPU cap is 30s by default, up to 5 minutes on Paid; a Queue consumer
  invocation gets up to 15 minutes.
- Workflow persisted state: 10MB soft guidance per the Agents runtime doc, up to ~1GB paid account
  ceiling in the platform limits doc — either way, evidence payloads must go to R2/D1, not into
  Workflow instance state itself.
- The account already runs 4 Workers (`dentalpresence-production/staging/zone-hardening/cloud-builder`)
  and 3 R2 buckets, 0 D1 databases, 0 KV namespaces (checked live). All account-level included
  allowances above are **shared** with the production app — this design doesn't assume untouched
  quota, it prices every operation at the documented overage rate regardless of whether free tier
  would actually absorb it, which is the conservative direction the task requires.

**Back-of-envelope real-dollar cost at 2,000 deltas / 20 repos** (assuming ~6 Workflow steps/delta, ~2
R2 writes/delta, ~3 D1 writes/delta, ~2s estimated CPU/delta): roughly 12,000 steps, 4,000 R2 Class A
ops, 6,000 D1 row-writes, ~4M CPU-ms — every one of those is one to three orders of magnitude below its
overage threshold, so the realistic real-dollar cost of the full experiment is well under $10, not
anywhere near the $2,000 ceiling. That's expected and fine: the credit ceiling in this task is a safety
rail against a runaway/misconfigured run, not a number this experiment should normally approach. The
guard still needs real accounting behind it so it's meaningful if something does go wrong (e.g. a retry
storm, a pathological repo, or a bug that reprocesses the same deltas repeatedly).

## 2. Execution architecture

```
CLI/script (local, unchanged entrypoint shape)
  -> Orchestrator Worker (diffci-research), HTTP-triggered
       -> creates one Cloudflare Workflow instance per repository (not one giant workflow, not one
          instance per delta — bounds step count per instance well under the 10k default cap and
          isolates one repo's failure from the other 19)
            repo Workflow instance:
              step: clone/fetch repo (git, outside REST rate limits) -> record RepositoryResult row
              step: sample commits (deterministic, per src/research/repository/sampler.ts)
              step: for each delta, batched (~10 deltas/step to respect the 30-min step cap and keep
                    step count low):
                      - check D1 completed-deltas index; skip if logicalDeltaKey already done
                      - runDiffCIAnalysis (adapter.ts, unchanged) + PATH baseline
                      - opportunistic historical-CI-evidence fetch, paced under the GitHub rate budget
                        (see §4) -- best-effort, never blocks the delta's own result
                      - persist BenchmarkRecord to R2 (key = logicalDeltaKey)
                      - insert completed-delta row + budget-ledger row into D1 (both, one write)
                      - check budget guard (D1 running total) before continuing the batch
              step: finalize repo -> RepositoryResult to R2, mark repo complete in D1
       -> aggregation step (separate, run after repo instances complete, or triggered manually once
          the orchestrator observes all dispatched repos are COMPLETE/EXCLUDED/BUDGET_STOPPED in D1):
          reads all RepositoryResult rows from D1/R2, runs buildStage0Report(), writes summary.json/md
          to R2, same as today's local aggregator.ts/stage0-report.ts (reused, not rewritten).
```

Why per-repository Workflow instances rather than per-delta or one-giant-workflow:
- Repository failure isolation (task requirement) falls out for free — one repo's clone/graph/timeout
  failure can't touch another's instance or its persisted state.
- Step budget stays comfortable: ~100 deltas/repo × (1 completion check + 1 analysis + 1 persist,
  batched ~10/step) + clone/sample/finalize overhead ≈ a few hundred steps per instance, far under the
  10,000 default cap, with headroom to raise to 25,000 if a large repo needs more.
- Matches the task's explicit instruction not to run ~2,000 analyses inside one Worker request, and its
  suggested shape (orchestrator → repo work unit → isolated execution → persist → checkpoint →
  continue → aggregate).

Why D1 in addition to R2 (R2-only was the prior scaffolding's assumption):
- Resumability needs a fast existence check over up to 2,000 keys; R2 `list()`/`exists()` per key is
  workable but D1 gives an actual indexed table (`completed_deltas(logical_delta_key PRIMARY KEY, ...)`)
  that's cheap to query and makes the budget ledger, corpus manifest, and completed-repo tracking
  queryable in one place instead of scattered JSON files. R2 remains the evidence-of-record for full
  `BenchmarkRecord` payloads (unchanged from today's `R2EvidenceStore` shape) — D1 is the index/ledger,
  not a replacement for it.

`LocalEvidenceStore` stays as-is for local dev/dry-run/typecheck/tests; `R2EvidenceStore` becomes the
one actually wired into the Cloudflare path (today it's defined but unused — this design is what wires
it in). The `list()`-vs-flattened-`put()`-key inconsistency in `LocalEvidenceStore` (noted in the gap
analysis) gets fixed as part of this work since resumability will start relying on it locally too (dry
runs and the small-batch validation both run through the local store first).

## 3. Budget guard design

Three explicitly separate numbers, never conflated:
- **Measured spend**: exact operation counts our own code performs (R2 Class A/B ops, D1 rows
  read/written, Workflow steps, Queue ops, Worker requests) × the published per-unit rates in §1. These
  counts are exact because we control every call site — this is as close to "real billing" as is
  obtainable without waiting on the GraphQL Analytics API's reporting lag, and is labeled `measuredUsd`.
- **Estimated spend**: CPU-ms. Workers/Workflows expose no in-request CPU-ms readback API, so this uses
  the wall-clock timings `runDiffCIAnalysis` already captures (`gitAnalysisMs`, `graphConstructionMs`,
  `impactAnalysisMs`, `plannerMs`) as a conservative proxy (wall clock ≥ CPU time under contention, so
  this over-estimates rather than under-estimates), × the CPU-ms rate. Labeled `estimatedUsd`, never
  merged into `measuredUsd`.
- **Projected spend**: `(measuredUsd + estimatedUsd) / deltasCompleted × deltasRemaining`, recomputed
  after each repo/batch, used purely to decide whether starting the next unit of work is safe.

Thresholds (of the 2,000-credit ≈ $2,000 ceiling), enforced in the orchestrator before dispatching each
new repository/batch, reading the D1 ledger:
- **≥1,600 credits (80%)** — WARNING: log a warning row to D1, keep going, but recompute projected
  total cost for all remaining planned work and downgrade any repo not yet started to low-priority.
- **≥1,850 credits (92.5%)** — RESERVE MODE: do not start a new repository unless its conservatively
  projected cost fits inside the remaining budget; let already-running repo instances finish/checkpoint.
- **≥1,950 credits (97.5%)** — HARD STOP: do not start any further expensive operation (new repo, new
  delta batch) if its projected cost could push total spend past 1,950. Status becomes
  **`BUDGET_STOPPED`** (a real enum value replacing today's unreachable `BUDGET_GUARD_TRIGGERED`
  console string) — an explicit, non-failure terminal state. Remaining ~50 credits reserved for
  aggregation, report writing, and cleanup, which are cheap D1/R2 reads and one report write and won't
  meaningfully consume that reserve.

`Stage0Summary`/report already have `budgetGuardTriggered`; this design adds `budgetStatus: "OK" |
"WARNING" | "RESERVE" | "BUDGET_STOPPED"` and keeps all evidence collected before a stop fully usable
(nothing about a stop invalidates or deletes prior R2/D1 records) per the task's explicit requirement
that a budget stop is not a failure.

## 4. Historical CI evidence collection

Reuses `src/shadow/github-baseline.ts` (`fetchBaselineEvidence`) — already repo-agnostic — adapted into
`src/research/` rather than reimplemented, per the gap analysis. Given no GitHub token, unauthenticated
REST calls are capped at 60/hour account-wide (shared across whatever else might call the GitHub API
from this network path). At ~2 REST calls per delta (list runs + fetch jobs for the matched run), 2,000
deltas would need ~4,000 calls — completely infeasible under 60/hour without a token.

Design response: historical-evidence collection is **explicitly sampled, rate-paced, and honestly
labeled**, never silently skipped or faked:
- A fixed per-run REST call budget (e.g. 50/hour, leaving headroom under the 60 cap for any other
  concurrent use of the same IP) is tracked and enforced before each fetch attempt.
- Deltas are queued for historical-evidence fetch in a fixed, deterministic order (by
  `logicalDeltaKey`, not by any result-dependent ordering, so sampling can't be tuned toward favorable
  outcomes); once the hourly budget is exhausted, remaining deltas in that window are marked
  `evidenceStatus: "UNAVAILABLE"` with reason `"github_rate_limit"`, not left ambiguous.
- Each delta's evidence is classified `MEASURABLE` / `PARTIALLY_MEASURABLE` / `UNAVAILABLE` per the
  task's requirement, using the same status semantics `github-baseline.ts` already returns
  (`COMPLETE`/`PARTIAL`/`UNAVAILABLE` on `BaselineEvidence`).
- Failure recall is computed (via the existing `src/shadow/failure-recall.ts` logic, adapted) only over
  the subset of deltas with `MEASURABLE`/`PARTIALLY_MEASURABLE` evidence, and the report states both
  numerator and denominator explicitly (e.g. `historical failures evaluable = X`,
  `preserved by DiffCI = Y`) rather than a bare percentage — exactly as the task specifies.
- Because the sample will necessarily be small under this rate limit, the report must state plainly
  that failure-recall coverage is partial-corpus, not full-corpus, and must not claim more precision
  than the sample supports. If you're able to supply a GitHub token later, this same code raises the
  cap to 5,000/hour and the sample size grows accordingly — no redesign needed, just a higher paced
  budget.

## 5. Verdict logic fix

`computeProceedRecommendation()` currently only reads task-level `medianTaskReduction`. This design adds
the test-level numbers (`medianTestReductionByDiffci`, `diffciIncrementalTestAdvantage`) as required
inputs alongside the existing thresholds, so the automated verdict can no longer contradict the human
narrative verdict the way it did in the 2-repo pilot (automated: `STOP`, human: `YES WITH CHANGES`, for
reasons unrelated to result quality). The repo-count/delta-count floor stays (it's a legitimate
"not enough data yet" guard), but once past it, task-level and test-level reduction are both weighed.

## 6. Stale evidence handling

Before the real Stage 0 run starts, `.research/output/stage0/` (currently a mix of a `--dry-run`
artifact and a pre-bugfix, now-known-inflated 18-repo run) gets archived to
`.research/output/stage0-superseded-2026-08-19/` rather than deleted (evidence preservation, not
destruction) and the real run writes to a fresh `.research/output/stage0/`. The Cloudflare/R2 path uses
its own R2 key prefix (`stage0/<runId>/...`) so a rerun can never silently merge with a prior run's
records regardless of local-vs-cloud storage.

## 7a. Cloud validation results (2026-08-20, addendum)

Before writing this section, the execution-environment assumption in §2 turned out to be wrong in an
important way: plain Cloudflare Workers/Workflows have **no filesystem or subprocess-spawning
capability** (confirmed against live docs) - `git clone` and the TypeScript compiler API (which reads
real files from disk) cannot run there at all. The real "isolated execution environment" has to be a
**Cloudflare Container** via the Sandbox SDK - the same primitive `ops/cloudflare-builder` already uses
for this app's own production builds (a real Linux container with `git`/`node`/full shell exec).

Deployed `diffci-research-sandbox` (Worker + `ResearchSandbox` container) to validate this for real
against one small external repo (`pmndrs/zustand`), separate resources from the production app per the
earlier account-isolation decision:
- R2 bucket `diffci-research-evidence`, D1 database `diffci-research` (schema.sql applied - 4 tables).
- No local Docker build was available or used. `wrangler.research-sandbox.jsonc` references the
  **public pre-built** `docker.io/cloudflare/sandbox:0.12.5` image directly (Cloudflare pulls public
  Docker Hub images server-side, no local build step) rather than `Dockerfile.research-sandbox` (kept,
  documented, unused for now - see its header comment). The diffci source is uploaded into the running
  container at request time as a tarball and `npm ci`'d there, mirroring how `ops/cloudflare-builder`
  receives this app's own source.
- `scripts/cloudflare-validation-run.ts` runs **unmodified** `runRepoBenchmark()`/`analyzeCommit()`
  inside the container against a `LocalEvidenceStore` rooted in the container's own workspace; the
  Worker (`validation-worker.ts`) invokes it twice against the same container session (no wipe between
  calls) so the second invocation exercises the exact resumability check already covered by
  `tests/research/resumability.test.ts`, not a special case.

**Real result** (`runId pmndrs-zustand-1787197021264`, verified independently via direct D1 query and
`wrangler r2 object get`, not just the Worker's own response):
- Cold run: 2 real commits cloned/analyzed against real zustand history, `resumedFromExisting: 0`,
  container-reported `durationMs: 5233`.
- Warm run (same container session): `resumedFromExisting: 2` (both records reused verbatim, zero
  re-analysis), `durationMs: 1095` - **resumability proven on real Cloudflare infrastructure**, not just
  locally.
- Real, sane analysis output: one delta correctly forced FULL fallback (`.github/workflows/docs.yml`
  changed -> "GitHub workflow definition(s) changed; full validation required"), the other correctly
  went SELECTIVE (`README.md` only -> `testsSelectedByDiffci: 0` vs `testsSelectedByPath: 13`,
  `graphConfidence: COMPLETE`).
- R2: 3 keys written per run (summary + 2 commit records), confirmed present via direct `wrangler r2
  object get`. D1: `experiment_runs`/`repository_runs`/`completed_deltas` rows written and queried back
  directly, keyed by the real commit SHAs.
- Cost: `estimatedTotalWallMs` ~9.4s across both runs (Worker-side wall clock, explicitly labeled
  ESTIMATED per the measured/estimated split - real billed Container vCPU/memory/disk-seconds need
  reconciling via the dashboard/GraphQL Analytics API separately). At published Container rates
  (§1) this is a small fraction of a cent - consistent with the back-of-envelope estimate.

**Scope note**: this proves the resumability *mechanism* and R2/D1 persistence work for real. It does
NOT yet prove resumability *across separate container instances* (each `/v1/validate` call currently
wipes and `destroy()`s its own container) - that needs the container-side evidence store to consult R2/D1
before analyzing, which is orchestrator-level work for the small/medium/full batch stages, not this
one-repository validation.

## 7. Sequencing from here

1. Implement the budget-guard/cost-model module (real accounting, three-tier thresholds, `BUDGET_STOPPED`).
2. Implement the D1 schema + migrations (completed-deltas index, budget ledger, repo/run manifest).
3. Fix `LocalEvidenceStore`/`R2EvidenceStore` key scheme; wire `R2EvidenceStore` + D1 into a Cloudflare
   path the CLI can actually target (not just unused scaffolding).
4. Implement the per-repository Workflow + orchestrator Worker.
5. Adapt `github-baseline.ts` + `failure-recall.ts` into `src/research/` with the rate-paced sampler.
6. Fix `computeProceedRecommendation()` to weigh test-level metrics.
7. Add regression tests for all of the above (budget guard, resume/no-duplicate, cache isolation, D1/R2
   persistence, test-count invariants).
8. Local validation (typecheck/test/build), then the smallest real Cloudflare validation run (one
   external repo through the real deployed path) — I'll flag clearly before creating any real Cloudflare
   resources, since that's the first outward/persistent action in this plan.
