# Stage 0 full experiment — Gate 4 report (full ~2,000-delta target reached)

**Result: GATE 4 PASSED. The full Stage 0 corpus is complete.**

## Final orchestration state (verified via direct D1 query, not the Worker's own claims)

- **Global unique deltas: exactly 2,000** (`COUNT(DISTINCT logical_delta_key) = COUNT(*) = 2000`) - zero
  duplicates across the entire dataset.
- **All 20 corpus repositories: `status = COMPLETE`, `commits_analyzed = 100`** - every single
  repository hit its exact 100-commit target, no partial/short repositories, no over-collection.
- **Per-repository verification**: every one of the 20 repositories independently shows
  `unique_deltas = total_rows = 100` - not just a global count coincidence, but confirmed clean at the
  repository level too.
- **4 repositories required a second `orchestrator_attempts`** (`pmndrs/valtio`, `pmndrs/zustand`,
  `typeorm/typeorm`, `unocss/unocss`) after real transient failures (container connection interruption,
  platform runtime update, and a container-instance-limit error at concurrency=5 - see the Gate 2 and
  Gate 3 reports). Every one of these recovered cleanly: zero corrupted evidence, zero duplicate rows,
  zero lost progress, correct resumption of exactly the remaining commits each time.
- **Zero repositories were excluded** (all 20 pre-selected corpus repositories turned out to be
  graph-analyzable TS/JS with a root `tsconfig.json` - no exclusion-rule repository was needed from the
  2 documented backups, `sindresorhus/got` / `remeda/remeda`).

## Final budget

Real measured Cloudflare spend: **$0.3955** for the complete ~2,000-delta run (`budget_ledger`,
wall-clock-based Container cost model - a conservative, over- not under-estimate per its own design).
This is **≈0.02% of the $2,000 ceiling**, confirming the pre-Gate-1 projection's conclusion that budget
was never the real constraint for this experiment - reliability and wall-clock time were, and both are
now fully documented across Gates 0-4.

## What this gate does NOT yet cover

Per the frozen methodology, Gate 4 is an integrity gate - it confirms the dataset is real, complete,
duplicate-free, and uncorrupted. It does not itself constitute the final Stage 0 analysis. Still
required before the final report: full-corpus opportunity-conditioned analysis (all 2,000 deltas, not
the 1,300-delta partial snapshot already reported informally), the full repository-level breakdown
table, statistical stability analysis (repository-aware comparisons / bootstrap CIs), runtime and safety
evidence synthesis, and the 26 required final questions.

## Decision

Proceeding directly to full-corpus aggregation and the final Stage 0 report - no further data collection
is needed; the corpus is complete and verified.
