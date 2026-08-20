# Stage 1A safety-case fixtures

Self-contained, deterministic ground-truth records for the 8 historical "unsafe miss" deltas (Phase 4)
and the `pmndrs/valtio` impossible-count anomaly (Phase 6), found during the Stage 1A forensic
investigation (`docs/research/2026-08-21-stage1a-*.md`). Each fixture is readable and useful on its own
(no network access required) - it captures what was actually found: the delta identity, the real
GitHub Actions evidence (job/step/error where available), DiffCI's actual historical selection decision,
and the forensic classification reached.

**Not a live network dependency**: these are frozen snapshots of investigation results, not fragile
tests that re-fetch GitHub state on every run (external repositories can force-push, get renamed, or go
private - a fixture that depended on live re-fetching to even be readable would be exactly the fragility
the Stage 1A task explicitly warned against). `scripts/replay-safety-fixtures.ts` can optionally
**replay** a fixture against a live clone (when network access and a git checkout are available) to
check whether current graph/impact code still reproduces the same classification - but the fixture data
itself needs no such access to be read, audited, or used as a reference.

## Schema

```jsonc
{
  "repository": "owner/name",
  "baseSha": "...", "headSha": "...",
  "logicalDeltaKey": "...",
  "changedFiles": ["path", ...],
  "stage0Recorded": { "fallback": bool, "graphConfidence": "...", "testsTotal": n, "testsSelectedByPath": n, "testsSelectedByDiffci": n },
  "historicalEvidence": { "failingJob": "...", "failingStep": "...", "errorMessage": "...", "confirmedUnrelatedToCode": bool },
  "classification": "BENCHMARK_MAPPING_ERROR | ENVIRONMENT_DEPENDENCY | UNKNOWN | CHECKOUT_SEQUENCING_BUG",
  "notes": "one-line summary of the finding"
}
```

## Index

- `h3-docs-only.json`, `h3-event-ts.json` - both `BENCHMARK_MAPPING_ERROR` (lint bundled into the
  "tests" job name).
- `unstorage-oxfmtrc.json` - `ENVIRONMENT_DEPENDENCY` (GitHub API rate limit in a live-network test).
- `unstorage-utils-ts.json`, `unstorage-vite-config.json` - `UNKNOWN` (GitHub log retention expired).
- `zustand-readme.json` - `UNKNOWN` (structurally implausible, logs expired).
- `tanstack-query-contributing.json` - `ENVIRONMENT_DEPENDENCY` + non-test-job mapping error (GitHub
  infrastructure outage on a `Release` job).
- `valtio-readme-docs.json` - `ENVIRONMENT_DEPENDENCY` (flaky timing-threshold performance assertion).
- `valtio-impossible-count.json` - the Phase 6 anomaly: `CHECKOUT_SEQUENCING_BUG`, root-caused and fixed
  (see `docs/research/2026-08-21-stage1a-valtio-anomaly.md`) - the only fixture with a confirmed,
  structural (not per-delta) root cause and a real code fix (the `testCountInvariantViolation` guard).
