# Stage 0 full experiment — frozen methodology (2026-08-21)

Written and committed BEFORE any Gate 1-4 data is observed, per the spec's explicit requirement: "Do
not modify them after observing results unless a genuine correctness bug is discovered." If a
correctness bug requires a change during execution, the STOP → document → identify-affected-evidence →
regression-test → fix → invalidate → rerun → report procedure (already used twice in the medium batch,
once already in this experiment's own Gate 0) applies, and any such deviation will be recorded in the
final report's Research Integrity section, not silently absorbed.

**Frozen at commit `5c9e936f23fc1309dac4f8f72240d93168148c6c`** (2026-08-20 14:09:06 +0530 - the commit
log's own timezone; this experiment runs starting 2026-08-21 per session date). All hashes below are
SHA-256 of the file content at this commit.

## Frozen components

| Component | File | SHA-256 |
|---|---|---|
| Deterministic commit sampler | `src/research/repository/sampler.ts` | `3eedd72f342618cad36c6fac6f63d8441374de189aca7c8c297f819179b32f7d` |
| PATH baseline (production, per-test) | `src/planner/path-baseline.ts` | `59c361a2788af46ecc067c3943bb1ad0dbd37d4f5204485af9e0da01cdfc3941` |
| PATH baseline (research, task-level) | `src/research/baseline/path-baseline.ts` | `37bbed8b4681bd162c4fe5509d307a9ee7c155ff01f31806b1d054a9f4c548a3` |
| DiffCI planner | `src/planner/planner.ts` | `8245e64e008886ab9d0f44c47329ece4acbdb99050a745c357c3d1d312b9b66c` |
| Dependency graph builder / confidence rules | `src/repo/graph.ts` | `f5bdce6c7b0f1e10ac7b5ca9b9314808377a6eb6abad893f2787cd48a418a4a1` |
| Impact analysis / fallback rules | `src/repo/impact.ts` | `824b54ae69482901773db2f0dc5b6d092c9c8a858eb7ae5f78d31fd053346fdb` |
| Repository analysis / test-discovery rules | `src/repo/analyzer.ts` | `51b473808ffeeab94e7df77b185e267572b55bbe69c023f6f44bd8b333ba99c0` |
| Opportunity classifier | `src/research/benchmark/opportunity-analysis.ts` | `202c5f9c6f3104064b3f394e31c62ac80d2f37fc8fcd8ca71f260a9575bb50b4` |
| Aggregation formulas | `src/research/benchmark/aggregator.ts` | `d9ab590c9887affe9ee41abf8c2470558929227164fe3a56669ca54f3e9f63cc` |
| Repository exclusion rules | `src/research/repository/collector.ts` | `1d921a442b7f00e8350e3cef502902780e2415e9de031dad21ba7e19c0fc7481` |
| Stage 0 config constants | `src/research/config/stage0.ts` | `e5cb4a25ea9e80d0408ed0b5f182060b0968503e8d1655c53a079e17a5a6d75a` |
| Resumability decision logic | `src/research/cloudflare/resumable-batch.ts` | `7fef1649a37b0233196b9fff46c3c2c487266b960d5c03126fa946927325ffe7` |
| Orchestrator dispatch logic | `src/research/cloudflare/orchestrator-plan.ts` | `7a229a2d17d0113209fc6d4bd958ecb2d2103ac43ee377c416d62284cb0692c8` |

## Experiment version/schema

- `diffciVersion`: `0.6.0-phase6` (unchanged from the medium batch)
- `schemaVersion`: `diffci-research/stage0-2` (unchanged from the medium batch)
- `experimentId`: `stage0-full-2026-08-21` (new - distinct from both the medium batch's
  `stage0-medium-batch-2026-08-21` and the Gate 0 validation experiments, though `logicalDeltaKey`
  resumability works ACROSS experimentIds regardless, per its own design - see the medium-batch report)
- Since `diffciVersion`/`schemaVersion` are unchanged, deltas the medium batch already analyzed for a
  repository this full experiment re-includes (same repo, overlapping commit window) will legitimately
  resume rather than re-analyze - this is intended, not a shortcut: the medium batch's evidence is real,
  frozen-methodology evidence for the exact same product version.

## Exclusion rules (unchanged from the medium batch, restated for the record)

1. `sizeMb > 1024` → excluded (disk size).
2. `sourceFiles > 5000` → excluded (file count).
3. `primaryLanguage` not `typescript`/`javascript` → excluded (unsupported language).
4. No `tsconfig.json` at the repository root → excluded (tsconfig-less JS / monorepo-without-root-config).

None of these will be modified, loosened, or bypassed during this experiment. A repository hitting any
of them is excluded with the exact reason, exactly as the medium batch did for `vitest-dev/vitest` and
`remix-run/react-router`.

## Opportunity classifier (unchanged, restated)

- `MANDATORY_FALLBACK`: `fallback === true`.
- `BASELINE_ALREADY_OPTIMAL`: `fallback === false && testsSelectedByPath === 0`.
- `DISCRIMINATIVE_OPPORTUNITY`: everything else.

Depends only on `fallback` and PATH's own selection - never on `testsSelectedByDiffci` - so it cannot be
circular with the win/tie/loss comparison computed afterward. Unchanged from the medium batch; the
exhaustive non-circularity test (`opportunity-analysis.test.ts`) still passes at this commit.

## Aggregation formulas (unchanged, restated)

- Aggregate reduction vs FULL: `1 - sum(diffciSelected) / sum(total)`
- Aggregate PATH reduction vs FULL: `1 - sum(pathSelected) / sum(total)`
- Aggregate DiffCI reduction relative to PATH: `1 - sum(diffciSelected) / sum(pathSelected)`
- Conditional advantage (within DISCRIMINATIVE_OPPORTUNITY only): per-delta
  `(pathSelected - diffciSelected) / pathSelected`, then median/mean/percentiles across that subset.
- Median unconditional incremental advantage: per-delta `max(0, fullVsDiffci - fullVsPath)` at the task
  level (existing `buildStage0Report`), and the analogous test-level figure.

## Known capability gaps (preserved, not expanded during this experiment)

Restated from the medium batch, unchanged:
1. tsconfig-less JavaScript (`express`, `fastify`, `kleur` - excluded).
2. Monorepos without a root `tsconfig.json` (`vitest-dev/vitest`, `remix-run/react-router` - excluded).
3. AVA-style bare test filenames (`sindresorhus/ky` - included in the corpus, test-count metrics
   excluded from aggregate/opportunity calculations, as established in the medium batch).
4. Certain workspace/module-resolution structures producing `UNSAFE` graph confidence (`trpc/trpc` -
   included, kept as a valid negative-result corpus member, not removed or tuned around).

None of these will be fixed or worked around during this experiment unless a genuine, unambiguous
correctness bug is found that affects behavior the current implementation already claims to support
(exactly the standard the medium batch's two real bug fixes met, and Gate 0's `/v1/stop` fix just met).

## STOP conditions (restated, unchanged from the medium-batch spec, now also covering orchestration)

Evidence corruption, cross-repository contamination, impossible counts (`selected > total`), duplicate
`logicalDeltaKey`s entering aggregation, D1/R2 inconsistency, systematic test-discovery failure, a graph
falsely marked COMPLETE/usable, cache contamination, classifier circularity, historical evidence
misattribution, orchestration losing completed work, uncontrolled duplicate execution, systematic
unsafe false negatives, budget telemetry failure, projected budget breach. **A negative DiffCI result is
explicitly NOT a STOP condition** - `trpc/trpc`'s negative result stays in the corpus.

## Historical CI evidence collection (added before Gate 1, after this doc's initial freeze)

Step 6 of the execution sequence ("investigate authenticated GitHub Actions historical evidence
collection") was completed after this document's initial commit but still strictly before Gate 1 - no
Gate 1-4 evidence existed yet when this was added, so it is a completion of pre-registered preparation,
not a post-hoc methodology change. Recorded here for the audit trail rather than silently folded in.

- A `gh` CLI session in this environment carries an authenticated GitHub token (scopes: `gist`,
  `read:org`, `repo`, `workflow`) - sufficient to read Actions run/job data on the corpus's public
  repositories at the authenticated rate limit (5,000 REST calls/hour) instead of the unauthenticated
  60/hour that made this "NOT MEASURABLE" in both the small batch and medium batch.
- The collector itself (`src/research/historical/evidence-collector.ts`,
  `src/research/historical/rate-budget.ts`) already existed from the 2026-08-20 groundwork phase and is
  unchanged. What was missing was container-pipeline plumbing: `scripts/cloudflare-analyze-batch.ts` now
  reads `GITHUB_TOKEN` from its process environment and turns `collectHistoricalEvidence` on when
  present (`DEFAULT_AUTHENTICATED_CALLS_PER_HOUR = 4500`, scoped per-batch-process, not cumulative
  across a repository's batches - see that file's comment for why this granularity doesn't matter in
  practice at a max batch size of 25). `src/research/cloudflare/validation-worker.ts` forwards a
  `GITHUB_TOKEN` Worker secret into the container's `sandbox.exec()` **env option**, never as a CLI
  argument, so it never appears in the logged exec command or in `errorTail()` on failure.
  `GITHUB_TOKEN` was set via `wrangler secret put` directly (a personal token from `gh auth token`,
  never committed, never placed in D1/R2, never logged) and is not visible in this repository.
- Live-verified end-to-end 2026-08-20 against the real deployed Worker + container (not a mock): a
  3-commit `/v1/run-repo` call against `unjs/unstorage` (a corpus repository never previously analyzed
  by the medium batch, so guaranteed fresh work, not a resumed no-op) returned
  `historicalEvidenceStatus: "MEASURABLE"` for all 3 deltas. Recorded under the throwaway
  `historical-evidence-livetest-2026-08-20` experimentId; per `logicalDeltaKey`'s own cross-experimentId
  resumability design, these 3 deltas will legitimately resume (not re-analyze) if Gate 1-4 later reach
  the same commits for `unjs/unstorage` under `stage0-full-2026-08-21` - this is intended, not evidence
  contamination, matching how the medium batch's own evidence is allowed to resume into this experiment.
- Unchanged, still true and still binding: only JOB-level failure recall is collectable this way (which
  CI jobs failed), not individual TEST-level failure recall (no JUnit/test-report parsing exists in this
  codebase) - `matchFailedTaskIds()`'s job-name-to-task-id matching remains a best-effort heuristic, and
  a delta's `historicalEvidenceStatus` reflects only whether GitHub data was fetched, not match
  confidence. This does not change the frozen aggregation formulas or opportunity classifier at all; it
  only populates fields (`historicalEvidenceStatus`, `historicalFailedTargets`,
  `historicalUnsafeMissTargets`, `historicalPathUnsafeMissTargets`) that were previously always absent.

## Deviation log

This section will be appended to, not rewritten, if any deviation from the above becomes necessary
during Gates 1-4 - matching the medium batch's own precedent (two real bugs, both documented here-style
before being fixed). As of writing (before Gate 1), one deviation already occurred in Gate 0 (not part
of the frozen benchmark itself, but the orchestrator infrastructure it validates): `/v1/stop` was found
to silently no-op when called before the first `/v1/orchestrate` invocation for a new experimentId -
fixed in commit `5c9e936`, re-verified live, no benchmark evidence was affected (the bug was in the stop
mechanism, not in any analysis correctness).
