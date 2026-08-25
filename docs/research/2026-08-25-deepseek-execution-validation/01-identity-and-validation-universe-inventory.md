> **Amendment (2026-08-25, Report 11):** §1.1's "DiffCI's static engine models the unit-test family only" is corrected there — the engine models and selects across unit, snapshot, and e2e; only this round's *execution harness* wired a unit-only command. See Report 11 §1.

# DeepSeek Harness execution validation — Phase 0/1: identity, evidence preservation, validation-universe inventory

**Repository:** `deepseek-ai/deepseek-harness`. **Mission:** DiffCI Execution & Mutation Validation — DeepSeek Harness, second cross-repository case study, following the Cal.com precedent (`docs/research/2026-08-24-calcom-execution-observability/`).

## 0. Preserved state and identity

### 0.1 Git status at mission start (preserved, not touched)

```
 M ops/runner-agent/workload-runner.cjs
 M src/product/cloudflare/product-worker.ts
 M src/runner/agent-api.ts
 M src/runner/cloudflare/synthetic-runner-worker.ts
 M tests/product/cloudflare/product-worker-r1.test.ts
 M tests/runner/agent-api.test.ts
 M tests/runner/workload-runner.test.ts
 M wrangler.synthetic-runner.jsonc
?? .scratch/
?? docs/funding/
?? docs/research/2026-08-23-r2-basic-diagnostic-preregistration.md
?? src/runner/r2-job-spec.ts
?? src/runner/repository-policy.ts
?? tests/runner/r2-job-spec.test.ts
?? tests/runner/repository-policy.test.ts
```

This is a separate, pre-existing R2/runner-agent workstream (product-worker, synthetic-runner, workload-runner, r2-job-spec, repository-policy) unrelated to the frozen selection engine or the analysis-fanout execution harness. It does **not** intersect the `engineFiles` set of the frozen build manifest (verified in §0.2) or any file this mission touches. No stash, discard, or isolation was needed — the identity check below is trustworthy with this state left exactly as found. Nothing in this directory was modified to do this work.

### 0.2 Selection-engine identity (distinct from execution-harness identity)

The **selection engine** (`src/repo/*.ts`, `src/git/*.ts`, `scripts/diffci-benchmark-external.ts`, `scripts/diffci-blind-baseline.ts`) is checksummed independently of the **execution harness** (`src/analysis-fanout/**`, the Cloudflare DO/Worker code used to run tests). They are frozen and verified separately:

- **Current frozen selection-engine manifest:** `docs/research/blind-baseline-2026-08-23/2026-08-24-diffci-adapted-build-manifest-v2.json`
  `engineChecksum f6fd3ec007181beb779c7f078ee52aa4017d44af71e1423e2cabf700c0d9ae87`, `basedOnGitHead 8890e1a51e`. This is the same engine identity used for every Cal.com execution run.
- **Verification note (found and resolved this session):** `verify-frozen-engine.cjs` defaults to a **different**, superseded manifest (`2026-08-23-diffci-frozen-build-manifest.json`, the original pre-adaptation v1) when run without `--manifest`. Running it bare against the current working tree reports `MISMATCH` — this is **not** engine drift, only the wrong reference file. Explicitly pointed at the v2 manifest:

  ```
  node docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs \
    --manifest docs/research/blind-baseline-2026-08-23/2026-08-24-diffci-adapted-build-manifest-v2.json
  → 11/11 files OK, engineChecksum now f6fd3ec007181beb frozen f6fd3ec007181beb MATCH
  ```

  **Result: MATCH, confirmed.** No safety blocker, no engine defect. (Documented here because a naive bare invocation would have produced a false "MISMATCH" — worth recording so it isn't rediscovered as a scare next time.)
- **Execution-harness identity:** current repo `HEAD` at mission start, `92508cb3` (`docs(research): PR #29940 median/variance + 5-merge predeclared batch results`), carrying every Cal.com-session harness fix (`getProcessLogs`, `killProcess`, max-step-duration safeguard, universal failure persistence, `testArgvOverride`, diagnostic-probe mode, `vitest-report.ts`'s `testResults.length` fix). This is a **different identity axis** from the engine checksum — the harness can gain features (new DO steps, new safeguards) without changing `engineChecksum`, which only covers analysis/classification/graph code. All Cal.com runs and this DeepSeek run share the exact same execution-harness commit lineage.

### 0.3 Existing DeepSeek artifacts located (all left unmodified)

| Artifact | Path | Note |
|---|---|---|
| Immutable 30-merge selection manifest | `docs/research/blind-baseline-2026-08-23/2026-08-23-deepseek-blind-baseline-selection-manifest.json` | `mergeListSha256 a5bd1c195389a057...`, 30 merges, PR #2908 newest → older |
| Original blind-baseline replay rows | `docs/research/2026-08-23-deepseek-harness-benchmark-replay-complete.jsonl` | pre-adaptation engine |
| Environment-parity report (Cloudflare fan-out reproduces local) | `docs/research/blind-baseline-2026-08-23/2026-08-23-deepseek-harness-environment-parity-report.md` | 30/30 match, container `standard-2` |
| **Adapted** replay (post directly-modified-test fix) | `docs/research/blind-baseline-2026-08-23/2026-08-24-deepseek-harness-adapted-replay-report.md` + `-rows.jsonl` | engine `c6cf10e6b047a195...` — **this is the v1-adapted engine, not the current v2** (see below) |

**Important discrepancy resolved, not assumed away:** the existing "adapted replay" (17/30 rows changed, 0 decreases) was run under `engineChecksum c6cf10e6...` (v1-adapted: only the directly-modified-test self-selection fix). The **current** frozen engine is v2 (`f6fd3ec...`), which additionally unions `profile.testFilePaths` into the graph node set (the tsconfig-exclude fix, built for biomejs/biome and calcom/cal.diy). The v1-adapted report itself states deepseek-harness has a root `tsconfig.json`, so the second fix's original stated purpose ("nested tsconfig discovery") shouldn't fire here — but the v2 manifest's actual description of the graph.ts change is broader ("unions `profile.testFilePaths` ... so a test file a package tsconfig excludes still becomes a graph node"), which is not guaranteed inert for deepseek-harness without checking. Per this mission's explicit instruction ("do not rely on this summary where repository artifacts provide more exact values"), the existing rows were **not** reused for the predeclared corpus. Instead, a fresh, canonical replay was run locally against the current v2 engine, using the same immutable manifest — see §0.4.

### 0.4 Canonical v2-engine replay (new artifact, this mission)

- **Working-tree clone:** fresh `git clone --filter=blob:none` of `deepseek-ai/deepseek-harness` into a session-scratch directory (not tracked in this repo) — needed because the existing cached clone (`%TEMP%/deepseek-harness.git`) is bare and the replay driver requires `git checkout`.
- **Command:** `scripts/diffci-blind-baseline.ts replay` against the existing immutable manifest, current `HEAD` (v2 engine), output to a **new** file under this directory — the original `-rows.jsonl` files were never opened for writing.
- **Output:** `2026-08-25-deepseek-v2-engine-canonical-replay-rows.jsonl` (30/30 rows), progress log `2026-08-25-replay-progress.log`, raw stdout `2026-08-25-replay-stdout.log`.
- This is now the **canonical** source of truth for static verdicts/selections under the exact engine identity used for every execution run in this mission — see Report 02 for the full comparison against the v1-adapted rows and the predeclared execution corpus derived from it.

## 1. Validation-universe inventory

Built from the repository's actual CI configuration at the manifest's head commit family (`.github/workflows/`, `package.json`, `vitest*.config.ts`, `scripts/run-gates.ts`, `pnpm-workspace.yaml`), not from memory or the mission brief's summary.

| Item | Finding |
|---|---|
| Package manager | `pnpm@11.7.0`, pinned via `"packageManager"` in root `package.json` (corepack-resolved) |
| Node requirement | `"engines": { "node": "^22.19.0 \|\| >=24.0.0" }`; CI's `PRIMARY_NODE_VERSION: '24'`; a separate `node-compat` PR job matrixes `22.19` and `26` |
| Workspace structure | `pnpm-workspace.yaml`; `workspaces` glob in `package.json`: `vendor/*`, `packages/*/*`, `native/landlock-run(/packages/*)`, `apps/*`, `website` |
| Install command | `pnpm install --frozen-lockfile` (every CI job) |
| Build/generation prerequisites | `pnpm run build` (`tsx scripts/build.ts`) required before the snapshot gate (`DSH_EXAMPLE_MODE=lib`) and the consumer/artifact gates; the plain unit-test gate (`pnpm test` / `pnpm run test:coverage:partitioned`) does **not** depend on a prior build |
| CI workflow files | `.github/workflows/ci.yml` (PR gate — 9 jobs: static, coverage, consumers, node-compat×2, python-sdk, python-runtime, windows, windows-native), `ci-master.yml` (post-merge, adds a self-hosted-standby lane), `e2e.yml` (separate, real-API), plus release/build/docs/issue-policy workflows out of scope for test validation |
| Exact CI test commands | Unit+coverage: `pnpm run check:ci:coverage` → `scripts/run-gates.ts ci-coverage` → `pnpm run test:coverage:partitioned` (or plain `vitest run --coverage <workers> <timeouts>` when unpartitioned) — **not** the plain `pnpm test` script, which is only used by the local `check-all` aggregate. Snapshot: `pnpm run check:ci:consumers` / `ci-primary`'s `snapshotGate()` → `pnpm run test:snapshot` → `vitest run --config vitest.snapshot.config.ts` with `DSH_EXAMPLE_MODE=lib`. E2E: `pnpm run test:e2e` → `vitest run --config vitest.e2e.config.ts`, **only** invoked from the separate `e2e.yml` workflow, not from `ci.yml` |
| Unit-test runner | Vitest, root `vitest.config.ts`. **Not a flat suite** — uses Vitest 4's native `projects: [...]` array (two named projects: `thread-safe` [pool: forks, default] and a narrow `processBoundTests` list pinned to forks for process-global-state suites). This is architecturally different from Cal.com, which had no `projects` array at all (the root cause of Cal.com's `--project` filter failure) — **whether `--project` filtering behaves correctly here is unverified and must be empirically probed (Phase 4), not assumed from this structural difference alone** |
| Snapshot-test runner | Separate Vitest config (`vitest.snapshot.config.ts`), include globs `scripts/**/*.snapshot.ts`, `apps/cli/tests/**/*.snapshot.ts`, `examples/*/tests/**/*.snapshot.ts` (+ `apps/web/tests/**/*.snapshot.ts` only under `DSH_EXAMPLE_MODE=lib`). **Keyless by default** (`DSH_SNAPSHOT` unset → `replay` mode: real subprocess paths replayed against recorded fixtures, no external API call) — genuinely executable without credentials |
| E2E runner | Separate Vitest config (`vitest.e2e.config.ts`), include globs `packages/*/*/tests/**/*.e2e.ts`, `apps/cli/tests/**/*.e2e.ts`, `examples/*/tests/**/*.e2e.ts`. **Requires `DEEPSEEK_API_KEY_EXTERNAL`** (mapped to `DEEPSEEK_API_KEY`), hits the real `https://api.deepseek.com`. Not available to this mission — **excluded from any full-suite or savings claim**, not silently dropped (see §1.1) |
| Fixture-based/custom runners | `test:issue-management` (`node .github/issue-management/policy.test.mjs`, no Vitest involvement), `test:web:ci` (`tsx scripts/run-web-snapshots.ts`), Python SDK suite (`pytest`, separate ecosystem entirely, out of scope) |
| Reporter capabilities | Default Vitest reporter for `vitest run`; a custom CJS `uncoveredLocationsReporter` is wired into the coverage path only (`scripts/coverage-uncovered-locations.cjs`), irrelevant to selection/execution verification. **No JSON reporter is configured by default** — matching Cal.com's starting state, a `--reporter=json --outputFile=...` (or equivalent) must be added for structured observability, per Phase 4 |
| Test-family invocation boundaries | Three genuinely separate Vitest **config files** (unit/snapshot/e2e), not just include-glob partitions of one config — each requires its own `vitest run --config <file>` invocation |
| Test IDs vs. file paths | DiffCI's static engine selects file paths (`affectedTests`/`totalTestsInGraph` counts test files in the dependency graph, per the existing manifests' shape); Vitest's own reporter distinguishes individual test IDs within a file — the harness must reconcile both, exactly as built for Cal.com (`parseVitestJsonReport`) |
| Environment variables | `DSH_TELEMETRY_DISABLED=1` (CI-wide, disables production telemetry), `PRIMARY_NODE_VERSION=24`, `DSH_GATE_CONCURRENCY` (per-job worker cap), `DSH_EXAMPLE_MODE=lib` (snapshot gate only), `DSH_SNAPSHOT` (unset/`replay` for keyless execution), `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` (E2E only, unavailable) |
| Services/external dependencies | **None** for unit or snapshot families (no docker/redis/postgres in any workflow) — E2E is the only family with a real external dependency (DeepSeek's own API) |
| Caches/artifacts | pnpm store cache (`actions/cache/restore`, restore-only per job — populated by a separate warm-up path not inventoried here); Playwright Chromium install for the consumer/web-snapshot gates only |
| Per-job timeout | Only two jobs set an explicit `timeout-minutes` (`windows`: 15, `windows-native`: 120); all Linux jobs (including coverage/static/consumers) rely on GitHub Actions' default 360-minute job timeout — **no repo-declared per-job timeout for the families this mission targets**, so this harness's own `maxTestRunMs` safeguard (Cal.com precedent: 10 min repo-specific cap) is the only bound that will actually apply here and must be set deliberately, not inherited |
| Compute shape | CI runs on `dsh-ubuntu-24-04-16core` (custom 16-core hosted runners) for the coverage/static/consumer jobs — meaningfully heavier than Cal.com's default GitHub-hosted runners. Relevant to the Phase 6 sandbox-shape decision (§ below) |
| Platform parity risk (found, not assumed) | `vitest.config.ts`'s `windowsUnsupportedTests`/`windowsUnsupportedPackages` conditionally **excludes** several packages' test suites (`bash-local`, `bash-sandbox`, `tool-bash`, `hooks/*`, `terminal-bash`, `sandbox-local`, plus several `subprocess`/`subprocess-local` spec files) when `process.platform === 'win32'`. Real CI runs on Linux, where this exclude list is empty. **Any execution done on a Windows host would silently under-count the real full-suite surface — this mission's actual test execution must run on Linux** (the Cloudflare sandbox containers, matching the Cal.com precedent, are Linux-based) to be CI-faithful; this report's own local inventory work stayed read-only/analysis-only for exactly this reason |

### 1.1 Completeness label

**`PARTIAL`**

Justification, using the repository's own CI configuration rather than the mission brief's ~1,015–1,031 modeled-test figure:

- DiffCI's static engine (as used for the existing manifests) models the **unit-test family's dependency graph** (`totalTestsInGraph` ≈ 1,015–1,031 depending on merge — root `vitest.config.ts`'s test surface). This is the largest single family but is explicitly **not** the whole repository-validation universe.
- **Modeled:** unit tests (`vitest.config.ts`, both `projects`).
- **Not modeled by the static engine, but executable and in scope for this mission's execution validation:** the snapshot family (`vitest.snapshot.config.ts`) — keyless, real command, real CI gate, not yet exercised in any prior DiffCI report for this repo.
- **Not modeled, and out of scope for this mission (credential-gated):** the E2E family (`vitest.e2e.config.ts`) — real external API dependency this mission does not have access to. Narrowed honestly per the mission's explicit rule, not silently excluded from the denominator.
- **Entirely unmodeled and out of scope for "test validation," inventoried separately in the full-CI-opportunity report:** typecheck, lint (oxlint), duplication (jscpd), build, publint, knip, doc-typecheck, module-graph verification, license/package-invariant checks, Windows/Wine gates, Python SDK suite, release/deployment workflows.

Calling ~1,015–1,031 "the complete repository validation universe" would be wrong on this repository's own evidence — it is one (the largest) of at least three test families, which are themselves a subset of a considerably larger CI surface (§ "Full-pipeline inventory", produced later in this mission).

## Next

Report 02: comparison of the fresh v2-engine canonical replay against the existing v1-adapted rows, and the predeclared 5-merge execution corpus (deterministic quantile rule per the mission spec, selected **before** any execution result is observed).
