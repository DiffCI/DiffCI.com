# Note — `deepseek-2808-canary1` preserved as off-target-mutation evidence, not discarded

**Raw record:** `raw-deepseek-2808-canary1-final-record.json`. Preserved unmodified; not deleted or overwritten despite superseding it with a corrected canary run.

## What this run proves cleanly (Phase 6's canary requirements, all met)

- Install worked (`installMs: 23,038`).
- Runtime selection: `HONORED_EXACTLY` (4/4 files requested and executed, 16/16 tests).
- Reporter complete on every step (`observabilityStatus: "complete"`).
- No timeout triggered (full baseline 461,989ms, well under the 15-minute `maxTestRunMs` cap).
- Full baseline (864 files, 14,426 tests, 17 pre-existing failures - unrelated to this merge, a real repository baseline state) and selected baseline (4 files, 16 tests, 0 failures) both completed.
- Mutation applied and reverted cleanly (no corrupted final repository state).
- Economics: 93.2% net reduction (461,989ms full vs 20,027ms selected, 11,343ms analysis overhead).

## What it does NOT prove: recall for PR #2808

`mutation.path: "packages/host/frontend-static/package.json"` - **not** `src/index.ts`, the target Report 03 (committed before this run, before this bug was found) already predeclared. Root cause: a second, distinct pathspec-exclusion gap in `mutate()` (fixed immediately after, see `execution-shard-do.ts` commit following this one) - nested workspace `package.json` files were not excluded, and this one happened to sort alphabetically before `src/index.ts` in `git diff --name-only`'s output.

The consequence is visible directly in the result: reverting this `package.json` to its base content broke **16 tests scattered across completely unrelated packages** (`subagent-acp`, `subprocess-local`, `terminal-bash`, `storage-sqlite`, `settings-file`, `bash-sandbox`, ...) - none of them anywhere near `frontend-static` or `web-app`, the packages DiffCI's selected tests actually target. `recall.selectedSuiteCaughtMutant: false` against `recall.fullSuiteCaughtMutant: true` is technically a "confirmed miss" by the mission's own scoring rule, but it is a miss caused by an off-target mutation (a dependency-version change with monorepo-wide blast radius), not evidence that DiffCI's file selection failed to catch a regression relevant to the merge it was actually selecting for.

## Why this is not "resampling after an inconvenient result"

The mutation policy itself (Phase 3, Report 03) was predeclared and committed **before** this canary ran, and it already said "exclude... manifests." The bug was in this session's own *implementation* of that already-declared rule (a pathspec gap), not a change to the rule made after seeing the result. The corrected canary (`deepseek-2808-canary2`) targets the exact same, already-declared file (`src/index.ts`) that Report 03 named - it is not a new, more-favorable target chosen after the fact.

## Disposition

This result is **excluded from PR #2808's official recall figure** in the aggregate report, with this note as the reason. It remains available as evidence of a real harness limitation found and fixed, and as a caution: whole-file-revert mutation on a monorepo needs manifest exclusion to stay on-target, a lesson worth carrying into any future repository this harness is pointed at.
