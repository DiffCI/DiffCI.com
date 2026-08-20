# Stage 0 full experiment (20 repos / ~2,000 deltas) — gap analysis

Status: **pre-implementation investigation only**. No code changed. This document is the required
output of the "inspect before implementing" step for the full Stage 0 Cloudflare experiment.

Scope note: DiffCI is not a standalone repository — it is a nested package at `diffci/` inside the
`dentalpresence` repo (its own `package.json`, `src/`, `tests/`, `.research/`). All paths below are
relative to `diffci/` unless given in full. The DentalPresence.in application and its own Cloudflare
infrastructure are unrelated to this work and are not touched by anything below.

---

## 1. What already exists

**Production engine (mature, reused as-is — do not redesign):**
- `src/git/git-diff.ts` — real git delta computation (`ChangedFile`, `GitDelta`, rename/binary handling).
- `src/repo/analyzer.ts` — `RepositoryProfile` (scripts, test file discovery, workflows, tsconfig aliases).
- `src/repo/graph.ts` — TypeScript-compiler-based dependency graph, `GraphConfidence` (`COMPLETE` /
  `PARTIAL` / `UNSAFE`), TS project-reference resolution.
- `src/repo/impact.ts` — `ImpactAnalyzer`, fallback-reason accumulation.
- `src/planner/planner.ts`, `path-baseline.ts` — `DefaultCIPlanner` (real selection algorithm) and the
  real per-test PATH baseline, both reused directly by the research harness rather than reimplemented.
- `src/cache/graph-cache.ts` — `GraphCache`, keyed by `{commitSha, tsconfigHash, configHash,
  diffciVersion}`, schema-versioned, rejects corrupt/mismatched entries rather than trusting them.
- `src/shadow/*` — a **second, more mature** pipeline (DiffCI's own dogfooding on this repo) that
  already solves several problems the research pipeline still needs:
  - `github-baseline.ts` — real, working GitHub Actions REST API historical-evidence fetcher (runs →
    jobs → step timings, auth via bearer token). **Not reused by `src/research/` today.**
  - `failure-recall.ts` — real failure-recall computation against that evidence.
  - `record-validation.ts` — schema/consistency/secret-scanning validation before persistence.
  - `report.ts` — dedup by logical key, unique-commit-delta counting, workflow-retry detection.
  - `cold-warm-equivalence.ts` — proves cold vs warm graph builds produce an identical plan.
  - `persistence.ts` — append-only JSONL with malformed-record quarantine.

**Research/Stage 0 pipeline (`src/research/`) — the actual target of this task:**
- `config/corpus.json` — 20-repo target corpus already selected, spanning TS/JS/Python/Go/Rust/Java.
- `config/stage0.ts` — `STAGE0_CONFIG`: 20 repos / 2,000 deltas / **`budgetUsd: 200`** (USD, not
  "credits") / a `costModel` of per-operation USD estimates that is defined but never multiplied
  against anything real.
- `repository/collector.ts`, `sampler.ts` — real shallow clone/fetch + deterministic commit sampling
  (excludes merges, bot authors, reverts). Genuinely deterministic (pure function of `git log` output).
- `diffci/adapter.ts` — real (non-stubbed) wrapper: git delta → graph (cache-or-build) → impact →
  planner, with per-stage timing, a size-class timeout, and the critical fix (pilot bug #1) that
  overwrites the caller's placeholder `gitDelta` with the real one.
- `baseline/*` — a **second**, generic/workflow-derived PATH baseline for arbitrary external repos
  (distinct from `src/planner/path-baseline.ts`, which is DentalPresence-specific).
- `benchmark/runner.ts` — per-repo orchestration; generates `logicalDeltaKey =
  "${owner}/${name}:${baseSha}:${headSha}:${diffciVersion}:${schemaVersion}"` (deterministic, embeds
  repo identity so a shared store can't conflate repos).
- `benchmark/aggregator.ts` — computes medians/percentiles/verdict, **but**: `historicalFailures`,
  `historicalFailingDeltas`, `unsafeMisses`, `pathUnsafeMisses`, `duplicateAnalyses`,
  `timingCompleteDeltas` are **hardcoded to 0**, and `observedDiffciFailureRecall` /
  `observedPathFailureRecall` are **hardcoded to the string `"NOT MEASURABLE"`** — not computed from
  evidence, because no historical-CI-evidence fetcher exists in `src/research/` today.
  `computeProceedRecommendation()` is driven **only** by task-level reduction — it never looks at the
  test-level numbers the pilot found to be the real signal.
- `store/evidence.ts` — `LocalEvidenceStore` (filesystem, actually used everywhere today).
- `cloudflare/*` — `worker.ts`, `queue.ts` (+ `InMemoryExperimentQueue`), `r2-store.ts`
  (`R2EvidenceStore`), `wrangler.toml.example`. **All scaffolding**: no D1, no KV, no Workflows, and
  none of it is imported by `cli/run-stage0.ts`. The worker's `queue` handler just logs and acks.
- `cli/run-stage0.ts` — the real entrypoint. Budget guard control-flow is real (stops scheduling new
  repos once `cloudflareSpendUsd >= budgetUsd`), but the accrual line is
  `cloudflareSpendUsd += repoResult.commitsAnalyzed * 0.0 // local execution spend is zero; override
  when hosted` — i.e. **the guard can never actually trip** because nothing feeds it real spend.
  **No resumability**: no `store.exists(...)` check anywhere before `analyzeCommit()` re-runs and
  `store.put()` overwrites — a rerun always redoes every clone, sample, and analysis from scratch.

**Known, already-fixed bugs (2026-08-19 pilot), regression-tested:**
1. `gitDelta` placeholder not propagated to downstream comparisons (`adapter-gitdelta.test.ts`).
2. TS project-reference tsconfigs producing an empty-but-`"COMPLETE"` graph — now correctly capped at
   `PARTIAL` (`graph.project-references.test.ts`).
3. A glob-matcher ordering bug (`**` vs `*` substitution order) present in **three** places, including
   DiffCI's own production planner — fixed in all three, regression-tested
   (`baseline/matcher.test.ts`, `planner.test.ts`, `analyzer.test.ts`). A **fourth**, structurally
   different matcher in `src/repo/impact.ts`'s `collectAlwaysRunTests()` was deliberately left unfixed
   (lower priority; its only call site has an independent correct fallback check).
4. `testsTotal` / `testsSelectedByPath` / `testsSelectedByDiffci` added end-to-end
   (`test-count-tracking.test.ts`).

**Pilot result (real, 2 repos — zustand + hono, 16 deltas), from
`docs/research/2026-08-19-stage0-real-pilot.md`:**
- Task-level: **0% median DiffCI advantage over PATH** — the misleading, coarse signal.
- Test-level (the real signal): **63.7% median DiffCI test reduction**, 0.0% median PATH test
  reduction, **16.3% median incremental DiffCI advantage over PATH**.
- Cache correctness held cold vs warm (zustand 3,632ms→774ms; hono 8,614ms→604ms).
- No unsafe misses observed — but failure recall is `NOT MEASURABLE` because no historical-CI-evidence
  fetcher runs in `src/research/`.
- Human verdict: **"YES WITH CHANGES."** The *automated* aggregator instead prints `STOP` for this
  run, but only because `computeProceedRecommendation()` hardcodes `STOP` below 10 repos / 500 deltas —
  a threshold any 2-repo pilot trips regardless of quality, not a judgment on the result itself.
- Cloudflare not exercised: `$0.00` spend, `LocalEvidenceStore` only.

**Stale evidence on disk today:** `.research/output/stage0/` currently mixes (a) a `--dry-run`
artifact (2 repos, 6 synthetic FULL-fallback records, useless) and (b) leftovers from an **earlier,
pre-bugfix** real run that reached 18/20 repos — those numbers are **known-inflated** by since-fixed
false-negative bugs and must not be reused or aggregated into the real run. This directory needs to be
archived/cleared before the real Stage 0 run starts, or the run needs to write to a fresh output root,
so stale and real evidence can never be conflated.

---

## 2. What must change to safely run ~20 repos / ~2,000 deltas

1. **"Credits" is undefined.** The codebase's only budget unit is `budgetUsd` (a made-up USD estimate,
   currently multiplied by zero). The task explicitly forbids inventing a credit conversion and asks me
   to inspect the *actual* Cloudflare billing model. This needs a real answer before I can implement
   the guard — see the open question in §3 below; I have not guessed at this.
2. **Corpus/engine language mismatch.** `config/corpus.json` includes Python, Go, Rust, and Java repos,
   but `src/repo/graph.ts` is TypeScript-compiler-based and only supports TS/JS
   (`repository/collector.ts` sets `diffciGraphCapable: true` only for those languages). Non-JS/TS repos
   will fall back to FULL on every single delta by construction — that's a legitimate finding about
   generalization (and the spec explicitly asks "does the advantage persist across repository types"),
   but it means real budget will be spent getting a 100%-fallback result on a large fraction of the
   corpus. This should be surfaced as an explicit, expected outcome in the report rather than hidden,
   and probably argues for weighting the *initial* small/medium batches toward TS/JS repos so budget
   validation happens against repos where DiffCI can do real work first.
3. **Budget guard needs real accrual**, not `* 0.0`. Needs wiring to whatever the real billing unit
   turns out to be (§3), plus the warning/reserve/hard-stop tiers the task specifies, plus a distinct
   `BUDGET_STOPPED` terminal status (today only a console.error string `BUDGET_GUARD_TRIGGERED` exists,
   and it's unreachable in practice).
4. **Resumability is entirely missing.** Every commit is unconditionally re-analyzed and every evidence
   key is unconditionally overwritten. Needs a real "already completed" check
   (`store.exists(logicalDeltaKey)` or an index/manifest of completed keys) before repeating expensive
   work, plus a repo/batch-level checkpoint so a mid-run failure or budget stop doesn't lose progress.
5. **Cloudflare orchestration is unwired scaffolding.** `run-stage0.ts` never touches
   `src/research/cloudflare/*`. To run ~2,000 analyses safely (not inside one Worker request, per the
   task's explicit instruction) this needs an actual durable/resumable execution unit — most likely
   Cloudflare Workflows (durable steps + built-in retries/checkpointing) driving one execution per
   repository or per delta-batch, persisting to R2 (`R2EvidenceStore` already exists) and probably D1
   for a queryable completed-deltas index (no D1 exists today). This needs verifying against current
   Cloudflare Workflows capabilities/limits before committing to the design (§3).
6. **Historical CI evidence collection is missing from `src/research/`** even though a working
   implementation (`src/shadow/github-baseline.ts`) already exists for the shadow pipeline. The most
   direct path is adapting/reusing that fetcher (it's already repo-agnostic — takes `repository`,
   `headSha`, `token` as plain params) rather than building a new one, plus reusing
   `src/shadow/failure-recall.ts`'s recall computation instead of reinventing it.
7. **`computeProceedRecommendation()` needs to weigh test-level numbers**, not just task-level
   reduction — otherwise the automated verdict will keep contradicting the real signal the way it did
   in the pilot.
8. **Evidence-store key scheme has a latent inconsistency**: `LocalEvidenceStore` flattens all path
   separators out of keys before writing (so `commits/foo.json` becomes a single file, not a
   subdirectory entry), but `list(prefix)` assumes real subdirectories exist under `root/prefix`. This
   hasn't bitten anything yet because `list()` is never called in current code, but resumability (§4
   above) will likely need `list()` or `exists()` against exactly this kind of prefixed key, so it
   needs fixing before it's relied upon.

---

## 3. Open questions I need answered before designing the Cloudflare architecture and budget guard

I did not guess at any of these — the task explicitly says not to invent a credit conversion or assume
the Cloudflare architecture blindly, and getting them wrong would mean building the wrong thing or (worse)
risking real spend against the wrong account/budget.

1. **What does "credit" mean concretely for this account?** Memory shows a Cloudflare **$10k T3**
   promotional credit balance mentioned in an earlier audit (separate from AWS/GCP balances). Is the
   2,000-credit ceiling meant to map to that balance (e.g. 1 credit ≈ $1, so a $2,000 cap out of $10k)?
   Or is it a different, DiffCI-specific unit you already have in mind? I'd like to check the account's
   actual current Workers/Queues/R2/D1 pricing and remaining balance via the Cloudflare tools before
   proposing a concrete conversion, but I want your intent on the unit itself first since it changes
   the whole accounting design.
2. **Should the research Worker/Workflows/D1/R2/Queue run in the same Cloudflare account/zone as the
   production DentalPresence.in app**, or do you want it isolated (separate account or at least clearly
   separated resource names/tags) given it will be cloning 20 external repos and making outbound GitHub
   API calls at some volume? The `wrangler.toml.example` already names things `diffci-research`
   distinctly, which suggests same-account-different-resources was the original intent — confirming
   before I provision anything.
3. **GitHub API rate limits / token**: historical CI evidence collection and repo cloning/fetching for
   ~2,000 deltas across 20 repos will need a GitHub token with reasonable rate limits (unauthenticated
   REST calls are capped at 60/hour; authenticated at 5,000/hour, higher for GitHub Apps). Do you have a
   token you want used for this (env var name), or should I plan around unauthenticated limits (which
   would meaningfully slow down or cap the historical-evidence collection)?

I'll proceed with the architecture design once these are resolved. Everything else in this document
stands on its own and doesn't block on them.
