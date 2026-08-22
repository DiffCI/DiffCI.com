# Stage 2D — pre-registered failure-diversity experiments

Written and committed **before** any of D1-D4's real commits, predictions, or CI results exist - this is
the immutable record Stage 2D's own task spec requires ("must exist before the real DiffCI prediction and
CI result... prevent post-hoc experiment redesign"). Do not edit the expectations below after seeing a
real result; append findings to `2026-08-22-stage2d-final-report.md` instead.

## Repository selection

All four experiments run on **`adityankale190895/DiffCI.com`, `main`**, per the same safety reasoning
already established and re-verified for Stage 2B/2C: we control it, CI is fast (~75-90s), no auto-deploy
exists on push (`ci.yml` only runs `npm run check`), the branch is unprotected, and it is already
Shadow-App-enrolled with a proven live pipeline.

**Repository diversity considered and rejected for D1-D4 specifically:**
- `unjs/h3`, `unjs/unstorage`, `unjs/defu` - real, third-party, currently third-party-owned repositories.
  Pushing deliberately-failing controlled commits to someone else's public repository (even reverted
  immediately) is not something we control the consequences of (their own CI minutes, their own commit
  history, their own contributors seeing red commits) - explicitly out of bounds per this task's own
  safety constraints ("do not fork or alter third-party infrastructure ... unless clearly justified").
  Not used for any of D1-D4.
- `DentalPresence.in` - a real production application repository whose CI is currently billing-blocked for
  its own dedicated `check` job, and whose `deploy` job (the one that actually runs `npm test`) also
  deploys to a real Cloudflare staging environment on the same run. Introducing a deliberate test failure
  there risks a genuinely more complex blast radius (partial deploy states, a repo we're separately
  auditing read-only in Part 9) for no diversity benefit `DiffCI.com` doesn't already provide. Not used.

All four experiments therefore run on `DiffCI.com` - repository diversity was genuinely considered, not
skipped by default, and rejected for concrete, stated reasons each time.

## A note on why touching "core" DiffCI source files is safe here

The Cloudflare Worker's own bundled reconciliation code (`reconcile.ts`, `task-mapping.ts`,
`evidence-collector.ts`, etc., all statically bundled by `wrangler deploy`) and the R2-uploaded analysis
engine snapshot the Sandbox Container runs against target repositories are **both** frozen at whatever
commit `npm run shadow:deploy` last ran against - currently `e9b90c9`. None of D1-D4's commits are
followed by a redeploy, so a bug introduced into `DiffCI.com`'s own git history for these experiments
exists only in the **target repository being observed**, never in the **engine doing the observing**. This
is what makes it safe to target real `src/` files here, unlike a change to the deployed measurement fix
itself would have been.

## D1 — direct dependency failure

- **Target file:** `src/shadow/failure-classification.ts`
- **Change:** swap the `build` entry in `CATEGORY_BY_TASK_CATEGORY` from `"BUILD_FAILURE"` to
  `"LINT_FAILURE"` (a realistic copy-paste/mapping-table typo).
- **Expected failing test:** `tests/shadow/failure-classification.test.ts` - `"classifies by DiffCI's own
  task category when known"` (`assert.equal(classifyFailure({ taskCategory: "build" }), "BUILD_FAILURE")`).
- **Dependency shape:** `tests/shadow/failure-classification.test.ts` → `src/shadow/failure-classification.ts`
  (direct import, single hop). NOT the Stage 2C `cost-model.ts` file or bug shape (a mapping-table value
  swap, not a boundary-comparison operator).
- **Expected DiffCI behavior:** SELECTIVE prediction whose selected-test set includes
  `tests/shadow/failure-classification.test.ts`.
- **False negative would look like:** SELECTIVE prediction that does NOT include that test file.
- **Evidence value:** the baseline direct-dependency control every other experiment is compared against.

## D2 — transitive dependency failure

- **Target file:** `src/shadow/task-mapping.ts`
- **Change:** invert the failure check inside `failedTaskIds()` - `if (stepFailed(item.step))` becomes
  `if (!stepFailed(item.step))`. Deliberately scoped to `failedTaskIds`'s own function body only, not the
  shared helpers (`flattenSteps`/`stepFailed`/`taskIdsForStep`) it calls, which `buildTaskTimings`/
  `computeMeasuredMetrics` also use - keeping the blast radius to exactly the one function this experiment
  targets.
- **Expected failing test:** `tests/shadow/failure-recall.test.ts` - `"flags unsafe task miss when failed
  task is a skip candidate"` (expects `records[0].target === "typecheck"`; with the bug it becomes
  `"test:scripts"`, an untouched task with a different SKIP_CANDIDATE status, changing the assertion).
- **Dependency shape:** `tests/shadow/failure-recall.test.ts` → `src/shadow/failure-recall.ts` →
  `src/shadow/task-mapping.ts` (two hops). `failure-recall.test.ts` does **not** import `task-mapping.js`
  directly - confirmed by reading its import list before choosing this pair.
- **Expected DiffCI behavior:** SELECTIVE prediction whose selected-test set includes
  `tests/shadow/failure-recall.test.ts`, proven via the real dependency graph (not a direct import) that
  `task-mapping.ts`'s change reaches it.
- **False negative would look like:** SELECTIVE prediction that omits `failure-recall.test.ts` despite the
  real two-hop import chain existing.
- **Evidence value:** proves DiffCI's graph reasons about real transitive imports, not just files a test
  literally names in its own `import` statements.

## D3 — shared utility / fan-out failure

- **Target file:** `src/shadow/event-identity.ts`
- **Change:** in `predictionPrecededGroundTruth()`, flip the comparison from `predictedAtMs < observedAtMs`
  to `predictedAtMs > observedAtMs` (a realistic operator-direction bug - the exact inverse of what Phase 5
  requires, silently reversing what counts as "prospective").
- **Expected failing tests (TWO, in two separate modules' test files):**
  - `tests/shadow/event-identity.test.ts` - `"is true when the prediction timestamp is strictly before the
    real workflow completion timestamp"` (direct consumer).
  - `tests/shadow/reconcile.test.ts` - `"reports the prospectiveness proof as true when the prediction
    genuinely preceded the real completion"` (indirect consumer, via `reconcile.ts`'s import of
    `predictionPrecededGroundTruth` - `reconcile.test.ts` does not import `event-identity.js` directly,
    confirmed by reading its import list).
- **Dependency shape:** the fan-out shape - `event-identity.ts` is used directly by its own test AND
  indirectly by `reconcile.ts` → `reconcile.test.ts`. A real shared utility with two independent
  consumer-test chains, not a single linear chain.
- **Expected DiffCI behavior:** SELECTIVE (or a wider selection than D1/D2) prediction whose selected-test
  set includes **both** `event-identity.test.ts` and `reconcile.test.ts` - a genuine test of whether the
  impact radius correctly widens for a two-consumer shared dependency, not just a single-consumer one.
- **False negative would look like:** either test file missing from the selected set.
- **Evidence value:** tests fan-out reasoning specifically, distinct from D2's single transitive chain.

## D4 — boundary/unknown-risk failure

- **Target file:** `tsconfig.json`
- **Change:** `compilerOptions.noUncheckedIndexedAccess`: `false` → `true`.
- **Verified locally before registering this record:** this produces exactly 5 real `tsc` errors across 3
  files (`src/git/git-diff.ts` ×2, `src/repo/graph.ts` ×2, `src/research/repository/sampler.ts` ×1) - a
  bounded, real, deterministic **typecheck** failure. Deliberately NOT chosen to guarantee a FULL fallback
  or a SELECTIVE pass - the actual prediction is genuinely unknown to me at registration time.
- **Load-bearing caveat, stated in advance per Part 8's explicit instruction:** `npm run check` is
  `npm run typecheck && npm run test` - if typecheck fails, `test` **never runs at all** (`&&` short-
  circuits). Because DiffCI.com's single `check` job is `hasTestCommand: true` (Stage 2C's own fix, since
  the job's compound command resolves through `npm run test`), a typecheck-only failure here is expected to
  be counted by the automated pipeline as `relevant_failures_evaluable >= 1` even though **no test ever
  executed**. This is registered in advance as expected, not discovered after the fact: **this
  experiment's failure, however the automated system classifies it, will NOT be counted toward the ≥5
  automated-evaluable-failure gate**, because it cannot be genuinely attributable to test execution by
  construction (test never ran). It is registered anyway because it is real, valuable evidence of exactly
  the compound-job measurement limitation Stage 2C documented but did not fix.
- **Expected DiffCI behavior:** unknown in advance (that is the point) - could be SAFE_CONSERVATIVE_FULL
  (if `tsconfig.json` is treated as a global-risk config file), a narrow/wrong SELECTIVE prediction (if the
  graph doesn't recognize `tsconfig.json` as relevant to files it didn't statically analyze as changed),
  or something else. All three documented outcomes in the task spec (understands / falls back safely /
  false negative) are treated as valid, reportable results.
- **False negative would look like:** a SELECTIVE prediction whose selected-test set does NOT include ANY
  of the 3 files' associated tests (git-diff, graph, or repository/sampler-adjacent tests) despite those
  files having real, newly-introduced typecheck errors.
- **Evidence value:** genuinely uncertain-outcome boundary test of a repo-wide config file, distinct from
  Stage 2B's already-explored "unrecognized file extension" (`.sql`) case - `tsconfig.json` IS a `.json`
  file DiffCI's graph plausibly does model (unlike `.sql`), making the outcome here a different, real
  question rather than a repeat of already-known behavior.

## Ordering and gating

Run strictly D1 → D2 → D3 → D4, each preceded by: clean working tree, HEAD recorded, latest CI green,
Shadow Worker's `sourceIntegrity.status == CURRENT`, previous experiment's prediction fully reconciled and
its deliberate bug reverted. One bug per commit, never stacked. Stop immediately and report
`STAGE 2D SAFETY FAILURE` if any experiment shows `failures_preserved_by_diffci < relevant_failures_evaluable`
for a SELECTIVE prediction - do not proceed to the next letter, do not fix the algorithm first.
