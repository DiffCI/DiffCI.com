# DiffCI static impact benchmark — deepseek-ai/deepseek-harness (2026-08-23)

**What was measured.** DiffCI's generic impact engine (`scripts/diffci-benchmark-external.ts`:
git delta -> dependency graph -> affected tests -> policy) over the last 30 PR merges into `master`
(merge~1 -> merge, 2026-08-20..21, HEAD b150a551). Static analysis only: no dependency install, no test
execution, no runner. Raw per-merge output: `2026-08-23-deepseek-harness-benchmark-results.jsonl`.

**Harness notes (so this is reproducible and not over-read).** Run locally on Windows. Two invalid
earlier batches were discarded: (1) `--first-parent --no-merges` walked back to the repo's June-2026
bootstrap commits (master is all PR merges); (2) `sha^1` lost its `^` to cmd.exe escaping, so base
resolved to head and produced false SAFE/0-change results. Final batch uses `sha~1` on merge commits.

## Results (n=30)

| Metric | Value |
|---|---|
| SAFE_TO_PROPOSE (selection allowed) | 2 / 30 (6.7%) |
| FALLBACK (full run forced) | 28 / 30 |
| Engine-traced affected tests, median | 0.7% of ~860 test files (17/30 merges <= 10 tests) |
| Engine-traced affected tests, mean | 9.6% (8/30 merges > 100 tests) |
| Analysis wall time per merge | median 37 s (30-158 s), ~all graph build; impact step 1-100 ms |
| Median files changed per merge | 22 |

Fallback reasons (merges, non-exclusive): Unknown changed file(s) 26 · Configuration file 12 ·
Graph confidence UNSAFE 8 · Lockfile 5 · GitHub workflow 5 · Dependency manifest 1.

Unknown-file instances by kind (files): `*.i18n.yaml` 777 · snapshot `*.jsonl` 160 · `*.cordis.yml` 4 ·
`.py`/`.sh` 2. **11/28 fallbacks are caused ONLY by unknown files**; 8 of those only by
`.i18n.yaml`/`.jsonl`. Every "Configuration file" veto had a legitimate root-level trigger (root
`package.json`, `pnpm-lock.yaml`, `tsconfig.*`, `.github/workflows/*`) — that rule is not the problem.

## Interpretation

- Effective CI savings DiffCI would deliver on this repo today: ~0% (2 of 30 merges selectable).
- The engine's blast-radius tracing is doing its job (median <1% of tests); the loss is entirely in the
  *unknown-file* policy, which treats doc-translation YAML and recorded test-snapshot fixtures as
  "could affect anything".
- If `*.i18n.yaml` were classified as documentation, 8 more merges become selectable (10/30) at the
  engine-traced rates above. Snapshot `.jsonl` are genuine test inputs and need mapping to their
  owning test package, not a blanket doc classification.
- Graph-build latency (~37 s median for ~860 tests) is a per-run cost to keep in the runner economics.

Not measured here: actual test runtime saved, prediction correctness vs. real CI outcomes (that is
Stage 2F's job and requires executing the selected tests), or runner/container cost.
