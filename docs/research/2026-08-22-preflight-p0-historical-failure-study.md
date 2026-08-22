# DiffCI Preflight — Phase P0: Historical Failure Study

Parallel research/product track to the existing DiffCI roadmap. **Shadow/counterfactual only** - nothing
in this document or its accompanying code blocks commits, pushes, PRs, or CI, and nothing here modifies
Stage 2F's frozen test-selection algorithm (see [Part 15 — Stage 2F protection](#part-15--stage-2f-protection)).

## Methodology and honesty notes (read first)

This is real data, not a simulation: 24 failed CI runs on `DiffCI.com` (**exhaustive** - every real failed
run in the repository's history) and a **sample of 10 of 50** failed runs on `DentalPresence.in`
(explicitly a sample, documented as such throughout - never presented as exhaustive). Extraction code:
[`src/preflight/`](../../src/preflight/), extractor script:
[`scripts/preflight-p0-extract.ts`](../../scripts/preflight-p0-extract.ts), raw dataset:
[`docs/research/preflight-p0-dataset.json`](preflight-p0-dataset.json).

**A real methodological bug was found and fixed while building this**: the first extraction pass took a
blind tail of each failed run's log, which for jobs with post-checkout cleanup steps returned only
generic cleanup noise (`git config --unset`, `Cleaning up orphan processes`) instead of the actual error -
confirmed by manually inspecting D1's real 1752-line log, where the actual `AssertionError`/`not ok 1` was
at line 1329, nowhere near the tail. Fixed by searching for the first line matching a real failure-signal
pattern and extracting a context window around it. This is disclosed because a research study's own
extraction bugs are exactly the kind of "measured vs. estimated" discipline this document otherwise
demands of its own numbers - see the git history of `scripts/preflight-p0-extract.ts` for both versions.

**A second, smaller limitation, disclosed rather than hidden**: the fingerprint for the 7 real
`node:sqlite`/Node-version CONFIGURATION failures (case study #1 below) split into 2 distinct fingerprint
groups (4 + 3) due to a cosmetic step-name formatting difference between two batches of `gh` log output,
even though all 7 are the exact same root cause (verified independently - I diagnosed and fixed this bug
myself in the same session). The automated pipeline under-counts this specific repeat by treating it as 2
known patterns instead of 1. Reported honestly below rather than manually overridden, since silently
correcting the automated pipeline's own output would defeat the purpose of testing it.

**`TARGETED_TEST_PREFLIGHT` was never assigned by this pass** - the classifier requires a real
changed-files-directly-implicate-the-failing-test signal, which this P0 extractor does not yet compute
(it would require wiring in DiffCI's own dependency graph/impact analysis - Part 20's explicitly future
"DiffCI Impact Intelligence feeds both Test Selection and Preflight," not done in P0). This is a real gap
in this pass's classification power, not evidence that no historical failure was targeted-test-preventable.

---

## Part 1 — Failure taxonomy

[`src/preflight/taxonomy.ts`](../../src/preflight/taxonomy.ts): `TYPECHECK`, `LINT`, `BUILD`, `UNIT_TEST`,
`INTEGRATION_TEST`, `DEPENDENCY`, `CONFIGURATION`, `GENERATED_ARTIFACT`, `SECURITY_SCAN`, `DEPLOYMENT`,
`RUNNER_INFRASTRUCTURE`, `TIMEOUT`, `FLAKY`, `UNKNOWN`. Classification (`classifyFailureFromEvidence()`,
[`src/preflight/fingerprint.ts`](../../src/preflight/fingerprint.ts)) is driven entirely by step-level
error-text/command evidence, never by the job's display name - proven directly by test: a CodeQL job
failure classifies as `SECURITY_SCAN` regardless of surrounding job name, and a `node:sqlite` failure
inside a job literally named `check` classifies as `CONFIGURATION`, not implied "test failure" by the job
name (`tests/preflight/fingerprint.test.ts`).

## Part 2 — Historical failed-run extractor

[`scripts/preflight-p0-extract.ts`](../../scripts/preflight-p0-extract.ts) pulls real data via `gh` (run
list, per-run failed-step logs, per-commit changed files) for both repos DiffCI has real visibility into.
Output is a separate JSON research artifact
([`docs/research/preflight-p0-dataset.json`](preflight-p0-dataset.json)) - never written into
`shadow_predictions`/`shadow_ground_truth` or the `diffci-research` D1 database (Part 25).

## Part 3 — Normalized failure fingerprints

`computeFailureFingerprint()` combines failure class + job/step class + failing test id + a **normalized**
error signature (absolute paths → `<path>`, line:column → stripped, hex hashes/commit SHAs → `<hash>`,
timestamps → `<timestamp>`, durations → `<duration>`) - never a hash of the raw log. Proven by test: two
occurrences of the identical error differing only in path/timestamp/duration/commit SHA produce the
*same* fingerprint; genuinely different classes or different failing tests produce *different* fingerprints.

## Part 4 — Preventability classifier

[`src/preflight/preventability.ts`](../../src/preflight/preventability.ts), 6 classes exactly as specified.
Deliberately conservative - `SECURITY_SCAN` and `DEPLOYMENT` are never auto-classified as
`DETERMINISTIC_PREFLIGHT` (a real security finding or a deploy failure isn't "cheaply" preventable the
same way a typecheck error is); `insufficientEvidence` unconditionally forces `UNKNOWN`, overriding every
other signal. 10 tests cover every class and the precedence rules between them.

## Part 5 — Historical baseline

| | DiffCI.com (n=24, exhaustive) | DentalPresence.in (n=10 sampled of 50 real failures) |
|---|---:|---:|
| Total failed CI runs | 24 | 50 (10 sampled) |
| Unique failure fingerprints | 9 | not computed on the sample (see note) |
| Repeat failures (fingerprint count > 1) | 3 fingerprint groups covering 16 of 24 runs (9x, 4x, 3x - see note above on the 4x/3x split artifact) | n/a |
| `DETERMINISTIC_PREFLIGHT` | **16** | 0 |
| `TARGETED_TEST_PREFLIGHT` | **0** (not computed this pass - see methodology note) | 0 |
| `KNOWN_FAILURE_PREFLIGHT` | **2** | 0 |
| `POTENTIALLY_PREDICTABLE` | 5 | 8 |
| `NOT_REASONABLY_PREVENTABLE` | 0 | 0 |
| `UNKNOWN` | 1 (log unavailable) | 2 (log unavailable) |

**Historical preventable failure rate (DiffCI.com, the only exhaustively-classified population)**:

```
credible preventable failures / total failures
= (DETERMINISTIC_PREFLIGHT + TARGETED_TEST_PREFLIGHT + KNOWN_FAILURE_PREFLIGHT) / total
= (16 + 0 + 2) / 24
= 18 / 24
= 75.0%
```

Per Part 5's explicit instruction, `POTENTIALLY_PREDICTABLE` (5/24) is **reported separately, not folded
into this number**. If it were (which this document deliberately does not headline):
23/24 = 95.8% - included here only to show why the distinction matters, not as a claim.

**DentalPresence.in is not included in the headline rate** - its 50 real failures are 100% CodeQL
security-scan jobs (confirmed both by this sample and the earlier Stage 2D Part 9 audit of its full
history), and `SECURITY_SCAN` never classifies as credible-preventable in P0's conservative rules. Its
`POTENTIALLY_PREDICTABLE` rate (8/10 sampled) is reported for completeness, explicitly not combined with
DiffCI.com's measured rate into one blended number (mixing an exhaustive population with a small sample
would misrepresent both).

## Part 6 — Wasted time (measured, real durations)

Real wall-clock durations pulled via `gh run list` (`updatedAt - startedAt`), 24/24 DiffCI.com runs.
**A real, disclosed methodological split**: 9 of the 24 runs (2026-08-21, before CI-on-Cloudflare reached
documented steady-state) show 2-3+ hour durations - this is queue time waiting for a then-unstable
self-hosted runner fleet, **not CI execution time**, and is reported separately rather than blended into
"wasted CI minutes" (blending it would wildly overstate the metric with an artifact of infrastructure
history, not a Preflight-relevant signal).

**Post-stabilization runs only (n=15, 2026-08-21 evening onward - the representative population)**:
- Median time to failure: **78s**
- p90 time to failure: **94s**
- Total CI wall-clock consumed by these 15 failed runs: **20.1 minutes**

**Estimated CI minutes an ideal Preflight could have avoided**: for the 7 `CONFIGURATION` (node:sqlite)
failures in this set, the check job runs `typecheck && test`, and the failure occurs mid-test-suite -
meaning **the full typecheck phase plus most of the test suite ran before failing** (measured: ~70-78s per
run, of which a Preflight-grade Node-version/environment-parity check would need well under 1 second).
Estimated avoidable compute: **~5-6 of those ~6 minutes** (7 runs × ~75s ≈ 525s ≈ 8.75min gross, of which
well under 10s total would remain if a cheap config check ran first) — **labeled ESTIMATED**, not measured
to the second, since exact per-phase (typecheck vs test) timing wasn't captured separately in this pass.

For the `TYPECHECK`-class failures (D4 and the pre-stabilization batch), `&&` short-circuits before `test`
ever runs, so **very little compute is actually wasted** in absolute terms - the real benefit there is
faster developer *signal* (Part 14), not compute savings, and the two should not be conflated.

## Part 7-8 — Deterministic Preflight engine design + check registry

[`src/preflight/checks-registry.ts`](../../src/preflight/checks-registry.ts): 6 provider-independent
checks (`typecheck`, `lint`, `dependency_validation`, `config_validation`, `build`, `affected_tests`,
`known_pattern_match`), each with estimated cost/duration/confidence/prerequisites/detected failure
classes. Metadata only - **no execution against production CI**, per the task's explicit constraint.

## Part 9 — Risk-signal model v0

[`src/preflight/risk-model.ts`](../../src/preflight/risk-model.ts): a fully interpretable, hand-weighted
additive score (never a black box) - every non-zero contribution is an explicit `RiskReason{signal,
weight, detail}`, and the total score is provably the sum of its own disclosed reasons (tested directly).
Signals: config/global change, dependency-manifest change, migration/schema change, generated-code
change, known-fingerprint match (highest single weight), dependency fan-out, zero affected tests,
historical module failure rate.

## Part 10-14 — Ordering heuristic, replay design, prevention-recall/cost/time-to-signal metrics

**Explicitly out of scope for P0** (per the task's own "First deliverable... Then STOP" instruction - these
are Phase P1+ work, requiring the shadow-Preflight prediction-before-outcome infrastructure Part 15+ of
the main spec describes). What *is* delivered now is the **design**:

**Risk-based ordering heuristic (research starting point, explicitly not final)**:
`probability_of_failure × downstream_cost_avoided / check_cost` - using
`checks-registry.ts`'s `estimatedCostUnits`/`confidence` fields as the initial inputs once real
shadow-Preflight data exists to calibrate `probability_of_failure` against.

**Temporal-leakage-safe replay design (Part 11, design only - not run in P0)**:
1. Freeze a chronological commit list per repository.
2. For commit N, the replay engine may read only: the diff of commit N itself, the dependency
   graph/impact analysis as of commit N's parent, and failure fingerprints/rules derived **exclusively**
   from commits strictly before N (an explicit `asOf` cutoff parameter threaded through every lookup -
   the failure-fingerprint index must be rebuilt incrementally per commit, never queried against its
   final, all-history state).
3. A rule discovered to correlate with a later failure may not be backdated and applied to commits before
   its own discovery date - a rule's "effective from" timestamp is the timestamp of the failure that
   produced it, and it is inert for any replay position before that.
4. Record, per historical failed run: would the rule set *active as of that commit's own timestamp* have
   recommended a check that exposed this failure? This governs Part 12's prevention-recall calculation
   once implemented.
5. This design is deliberately conservative to avoid the single most damaging mistake a replay study can
   make (Part 11's own explicit warning): claiming a failure was "predicted" using information that did
   not exist yet when that commit's real CI ran.

**Prevention recall / Preflight cost / time-to-signal**: metric *definitions* only, matching the task's
own future Part 22 product-metrics list - not computed against real replay data in P0, since that replay
does not exist yet.

## Part 15 — Stage 2F protection

`git diff --stat -- src/repo/ src/planner/ src/shadow/ src/git/ tsconfig.json src/research/cloudflare/schema*.sql`
→ **empty**. All Preflight code lives under `src/preflight/`, `scripts/preflight-p0-extract.ts`, and this
document - a fully separate module tree from Stage 2F's frozen core, from the product/billing/auth/runner
SaaS-foundation modules, and from Stage 2F's own D1 database. `diffciPredictionExisted` is stored as
`false` throughout this dataset because P0 does not join against `shadow_ground_truth` at all (a future
pass could, strictly read-only, exactly as `src/product/shadow-read-boundary.ts` already does for the
product layer).

---

## 10 representative case studies

**#1 — CONFIGURATION / DETERMINISTIC_PREFLIGHT (the most valuable finding in this study)**
Commits `98b7790`, `303fa11`, `091fec4`, `35388f4`, `400d37a`, `b05b480`, `55f3d5f3` (7 real, organic
failures, 2026-08-22). Error: `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`. Root
cause: the self-hosted CI runner's Docker image pinned Node 20; `node:sqlite` requires Node 22.5+; local
development happened on Node 24, so the gap was invisible until real CI logs were inspected for *this
Preflight study itself*. A single `config_validation` check (compare `package.json`'s `engines.node`
against the CI runner's actual Node version) would have caught all 7 in well under a second, before any
of the ~75s test suite ran. **This exact failure was found and fixed while building this study** (see
`fix(ci)` commit) - a live demonstration, not a hypothetical, of Preflight's core thesis.

**#2 — TYPECHECK / DETERMINISTIC_PREFLIGHT**
Commit `b7cd05b` (Stage 2D "D4"). `noUncheckedIndexedAccess: true` in `tsconfig.json` produced 5 real
`tsc` errors. `npm run check` is `typecheck && test`, so `test` never ran (`&&` short-circuit) - a pure
typecheck failure, deterministically caught by `npx tsc --noEmit` alone in seconds.

**#3 — UNIT_TEST / KNOWN_FAILURE_PREFLIGHT (a genuine repeat)**
Commits `4ca8a11` (first occurrence, correctly `POTENTIALLY_PREDICTABLE`) → `3548380` → `498f0e2` (both
correctly reclassified `KNOWN_FAILURE_PREFLIGHT` on repeat). Same normalized fingerprint: `"ok 1 - reports
ok below the warning threshold"` failing - the deliberately-reused off-by-one boundary bug in
`evaluateBudgetStatus` (Stage 2B Experiment A, reused for Stage 2C's live proof). A known-pattern check
("has this exact fingerprint failed before?") would have flagged the 2nd and 3rd occurrences instantly.

**#4 — UNIT_TEST / POTENTIALLY_PREDICTABLE (first occurrence of a novel, deliberately-diverse bug)**
Commit `9e47334` (Stage 2D "D1"). A mapping-table typo in `failure-classification.ts`
(`build: "BUILD_FAILURE"` → `"LINT_FAILURE"`). No prior fingerprint match (this was its first and only
occurrence); the changed-files-implication signal wasn't computed in this pass (see methodology note), so
this correctly lands as `POTENTIALLY_PREDICTABLE` rather than an overclaimed `TARGETED_TEST_PREFLIGHT`.

**#5 — UNIT_TEST / POTENTIALLY_PREDICTABLE (transitive dependency)**
Commit `92f96aa` (Stage 2D "D2"). An inverted boolean in `task-mapping.ts`'s `failedTaskIds()`, exposed
two import-hops away in `failure-recall.test.ts`. Same reasoning as #4 - a real, novel, non-repeating
failure that this pass cannot yet claim was targeted-test-preventable without the impact-analysis wiring.

**#6 — UNIT_TEST / POTENTIALLY_PREDICTABLE (fan-out)**
Commit `63230cb` (Stage 2D "D3"). An inverted comparison in `event-identity.ts`'s
`predictionPrecededGroundTruth()`, exposed in two separate consumer test files simultaneously (fan-out).

**#7 — UNIT_TEST / POTENTIALLY_PREDICTABLE (cross-directory)**
Commit `b6d9167` (Stage 2E "D5"). A negated file-type guard in `analyzer.ts`'s `scanFiles()`, exposed
transitively across a research→repo package boundary. Genuinely novel dependency shape, no repeat.

**#8 — UNKNOWN / UNKNOWN (a real, honest gap)**
Commit `c4da121` (2026-08-21, early self-hosted-runner infrastructure work: "private-repository shadow
polling via App installation"). `gh run view --log-failed` returned "log not found" for this run -
GitHub's log retention/the runner's own early instability during setup likely means this evidence is
simply gone now. Correctly reported as `UNKNOWN`, not guessed.

**#9 — SECURITY_SCAN / POTENTIALLY_PREDICTABLE (DentalPresence.in sample)**
Representative of 8/10 sampled CodeQL job failures (of 48 real CodeQL failures total in that repo's
history). No step-level log is retrievable via `gh run view --log-failed` for a CodeQL job at all (its
failure is an annotation-based security-scan verdict, not a conventional step exit code) - job-name-based
classification (`SECURITY_SCAN`) is the only evidence available without deeper GitHub code-scanning-API
integration, correctly kept out of the `DETERMINISTIC_PREFLIGHT` bucket per Part 4's own guidance that a
real security finding isn't "cheaply" preventable.

**#10 — TYPECHECK, pre-stabilization batch (the "queue time vs. execution time" finding)**
Commits `d4de5ab`, `31e818e`, `1ef7782`, `a147ce8`, `e58fdfb`, `b981b38`, `829edc3`, `fe39008`
(2026-08-21, early runner-infrastructure iteration). Wall-clock durations of 2-3+ hours are recorded for
these runs, but this reflects real, documented self-hosted-runner instability during initial setup (agent
version pinning, container hostname collisions - see project history), **not** CI execution time or
"wasted compute" a Preflight check would have avoided. Reported separately from Part 6's headline wasted-
minutes figure specifically so this infrastructure-history artifact doesn't distort it.

---

## Proposed deterministic Preflight rules (Part 12 of the "First deliverable" list)

1. **Config/environment-parity check** (`config_validation`): compare `package.json engines.node` (and
   any other pinned-runtime declarations) against the CI runner's actual installed version before running
   anything else. Directly motivated by, and would have caught, case study #1 (7/24 = 29% of this
   dataset's real failures).
2. **Typecheck-first ordering**: already effectively true (`npm run check` runs `typecheck && test`), but
   a *separate*, even-cheaper standalone `tsc --noEmit` Preflight step (no `npm ci` wait, no test-runner
   startup) would surface case study #2-class failures in seconds rather than ~70s.
3. **Known-fingerprint short-circuit**: before running full CI, check the new commit's diff-derived
   context against the fingerprint index of the last N failures; an exact/near match on a Preflight-cheap
   signal is the single highest-confidence, cheapest-to-check rule available (case study #3).

## Proposed risk signals (Part 13 of the "First deliverable" list)

Already implemented in [`src/preflight/risk-model.ts`](../../src/preflight/risk-model.ts): config/global
change, dependency-manifest change, migration/schema change, generated-code change, known-fingerprint
match, dependency fan-out (high/moderate tiers), zero-affected-tests, historical per-module failure rate.
Not yet added, flagged as a real gap surfaced by this exact study: an explicit **"CI runtime/environment
declaration changed or is stale relative to the CI runner's actual environment"** signal - case study #1
would have scored highly on this if it existed, and it currently doesn't correspond to any of the eight
signals above (closest is `isConfigOrGlobalChange`, which is about repo-side config files, not
runner-environment-parity specifically).

---

## Answer to the P0 research question

> How many of the CI failures we're seeing could DiffCI realistically have detected before the normal CI
> run consumed significant time?

**On `DiffCI.com`'s complete, real failure history (n=24, no sampling): 75.0% (18/24)** were credible
deterministic- or known-pattern-preventable, using only conservative rules and zero speculative
"potentially predictable" inflation. The single largest contributor (7/24 = 29%) was a genuinely
avoidable environment-parity bug this study itself uncovered and fixed live. A further 5/24 (20.8%) are
real, novel, non-repeating test failures this pass cannot yet credibly claim as preventable without
wiring in real changed-file/dependency-graph matching (`TARGETED_TEST_PREFLIGHT`, not computed in P0).

This is a **defensible, evidence-grounded, not-commercially-precommitted number**, computed with an
explicit, honest 24-run denominator - not the "prevent 80% of failures" style claim the task explicitly
warned against precommitting to.

**Do not begin enforcement.** This document is Phase P0 only, as instructed - it stops here.
