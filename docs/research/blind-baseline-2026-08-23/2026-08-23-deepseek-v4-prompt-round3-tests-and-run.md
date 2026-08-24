# Prompt for DeepSeek V4 — Round 3: add the missing tests, then deploy and run the fan-out (your session died mid-task; here is exactly where it left off)

You are continuing work in the DiffCI repository (`C:\Users\Swati Kale\OneDrive\Desktop\DiffCI.com`). Your previous session on this task was cut off before finishing. This prompt was written after independently re-verifying your actual code against the round-2 brief (`2026-08-23-deepseek-v4-prompt-fanout-fixes.md`, still binding — re-read it) — read the "already verified done" section below and do not redo that work; the remaining checklist is everything after it.

## Already verified done — do not redo

Run these two commands yourself first to confirm the baseline you're starting from:
```
node docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs   # must print MATCH
npm run check                                                            # must be 908/908, exit 0
```
Both currently pass. Confirmed present and correct by direct code inspection:

- **Item 1 (the fatal `waitUntil` bug) is fixed.** `src/analysis-fanout/cloudflare/analysis-fanout-worker.ts` has no `ctx.waitUntil` around long-running work (see its own comment at line ~270: "No ctx.waitUntil: the AnalysisRun DO's alarm-driven state machine does all long-running work"). `src/analysis-fanout/cloudflare/analysis-shard-do.ts` is a real `alarm()`-driven state machine: `fetch` seeds state into `this.state.storage` and calls `setAlarm`, `alarm()` reads persisted `ShardRecord`, advances one bounded step, persists, and re-schedules or deletes the alarm. No `while (true)`. Concurrency is enforced by `src/analysis-fanout/cloudflare/analysis-run-do.ts`'s `selectNextReleases(shards, maxConcurrentShards)` — a bounded release function, not an in-request `mapWithConcurrency` — and `maxConcurrentShards` is now a `POST /v1/run` body field (CLI flag `--max-concurrent`, default 16), not a hardcoded constant.
- **Item 2 (checksum gate) is fixed properly.** `src/analysis-fanout/checksum.ts` provides `sha256Hex`/`hexMatches`/`isSha256Hex` (Web Crypto). The Worker (`analysis-fanout-worker.ts` ~line 187) computes `sha256Hex(await tar.arrayBuffer())` on the **R2 object itself** and compares to the pack record's `tarballSha256` — not a client-supplied claim. In-container, `analysis-shard-do.ts` (~line 219) fetches the frozen manifest **from R2** (`bucket.get(record.frozenManifestKey)`) into `/opt/frozen-manifest.json` and runs `verify-frozen-engine.cjs --manifest /opt/frozen-manifest.json` against that trusted copy, not the tarball's own copy. `docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs` was extended with an additive, backward-compatible `--manifest <path>` flag (confirmed: without the flag it still defaults to the file beside it; this file is NOT part of the checksummed `engineFiles` set, so this change never affects `engineChecksum`).
- **Item 3 (tarball transfer)** — post-transfer `sha256sum /opt/diffci-source.tgz` is checked in-container (`analysis-shard-do.ts` ~line 201) against the pack record. The pre-signed-URL fallback was not built, but given the mandatory checksum re-check, corruption will be *detected* (shard fails with a clear error) even if not yet worked around — acceptable for now; revisit only if the `sandbox.writeFile(ReadableStream)` path actually proves unreliable in step 2 below.
- **Item 4, config/CLI parts** — `wrangler.analysis-fanout.jsonc` exists and is correct: `standard-2`, `max_instances: 32`, three DO bindings (`AnalysisRun`, `AnalysisShard`, `AnalysisShardContainer` — all three classes exist and are exported: `export { Sandbox as AnalysisShardContainer } from "@cloudflare/sandbox"`, `export { AnalysisShard }`, `export { AnalysisRun }` in the worker), R2 binding `ANALYSIS_BUCKET` → bucket `diffci-analysis-fanout`, SQLite migrations tag `v1`, var `FROZEN_MANIFEST_KEY`. `scripts/diffci-analysis-fanout-cli.ts` (279 lines) implements all four commands:
  - `pack --run-id <id>` — verifies the frozen engine locally, tars the working tree, uploads tarball + pack record (with `tarballSha256`) + frozen manifest to R2.
  - `start --run-id <id> --repos <aliases> --shards <n> --max-concurrent <n>` — uploads the selection manifests, `POST /v1/run` with `{ runId, repositories, shardsPerRepository, maxConcurrentShards }`.
  - `status --run-id <id>` — `GET /v1/run/:runId`.
  - `collect --run-id <id> [--out <dir>] [--retry-run-id <id> --retry-reason <text>]` — writes `2026-08-23-<repo>-blind-baseline-rows.jsonl` and `2026-08-23-<runId>-fanout-run-record.json`; **verified: refuses to overwrite an existing file**, and only writes `...-retry-<reason>.jsonl` when `--retry-run-id` is passed.
  - `sandbox-like.ts` provides an injectable `SandboxLike`/`R2BucketLike` structural interface so the shard DO can be unit-tested with a fake — use this, don't fight it.

## What is genuinely missing — do this, in order

### A. Tests (blocking — do this before any deploy; `npm run check` currently shows 908/908, i.e. UNCHANGED from before this feature existed, meaning none of the required tests were added)

Create `tests/analysis-fanout/` (`node:test` style, matching the rest of the repo — see `tests/runner/*.test.ts` for the provider-stubbing convention). No network calls in tests. Required coverage, all still applicable from the round-2 brief:
1. `shard-slice.test.ts` — `buildShardSlices`/`assertExactCoverage` from `src/analysis-fanout/shard-slice.ts`: every merge `index` in a manifest appears in exactly one slice for various `(mergeCount, shardCount)` pairs including `shardCount > mergeCount`; each slice's `mergeListSha256` matches `computeMergeListSha256` computed independently; `parentManifestSha256` equals the parent's `mergeListSha256`.
2. `row-mapping.test.ts` — `src/analysis-fanout/row-mapping.ts`: `isResourceKill(137)` true, other codes false; `resourceKillRow`/`timeoutRow`/`exitFailureRow`/`mapExecFailureToRow` never produce a row `hasVerdict()` returns true for; correct `errorClass` selection for timeout vs OOM vs signal vs plain non-zero exit.
3. `checksum.test.ts` — `sha256Hex` matches a known vector; `hexMatches` is case/whitespace-insensitive; `isSha256Hex` rejects non-hex and wrong-length strings.
4. `analysis-run-do.test.ts` — `selectNextReleases`: never returns more than `maxConcurrentShards` minus currently-running shards; a shard-state reducer test proving the coordinator's `/init`, heartbeat-ingest, and terminal-state accounting are correct without a real DO runtime (call the exported pure functions directly — check what `analysis-run-do.ts` exports beyond the class; if the logic isn't separated into pure functions yet, that itself is fine to leave, but the pure functions that DO exist, like `selectNextReleases`, must be tested).
5. `analysis-shard-do.test.ts` — using `SandboxLike`/`R2BucketLike` stubs (no real Sandbox, no real R2): the state machine resumes correctly from a persisted mid-flight `ShardRecord` (simulate re-invoking `alarm()` after a fake eviction — no re-clone, no duplicate rows re-ingested); an `exitCode: 137` from the stub `getProcess` maps to a `resource-kill` row for the in-flight merge with prior rows preserved; a checksum mismatch (stub tarball hash != pack record) aborts the shard as `engine-drift`/`tarball-checksum-mismatch` before any clone happens.
6. `collector.test.ts` — `src/analysis-fanout/collector.ts`: rows from multiple shard JSONL blobs are ordered strictly by the original manifest `index`, never by shard or arrival order; duplicate `mergeSha` across shards (should not happen given exact coverage, but prove the collector doesn't silently pick one) is either impossible by construction (assert via the coverage test) or explicitly rejected here.
7. `cli-collect.test.ts` (or extend an existing file) — `cmdCollect`-equivalent overwrite refusal: given an existing output file, the CLI must fail without writing, and must accept `--retry-run-id`/`--retry-reason` to write a differently-named file instead. If the CLI's internals aren't unit-testable directly (they call `fetchJson`/`fetchText` against a live URL), extract the pure filename-decision logic (`retryRunId ? ...-retry-... : ...`) into a small exported function first and test that — don't skip this coverage.

Run `npm run check` after adding these; it must stay green and the test count must visibly increase from 908. Re-run `node docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs` and confirm it still prints `MATCH` (adding tests must not touch any checksummed engine file).

### B. Deploy
```
wrangler deploy --config wrangler.analysis-fanout.jsonc
wrangler r2 bucket create diffci-analysis-fanout   # if not already created
wrangler secret put ANALYSIS_CONTROL_TOKEN --config wrangler.analysis-fanout.jsonc
```
Export the same token as `ANALYSIS_CONTROL_TOKEN` locally for the CLI, and `DIFFCI_ANALYSIS_FANOUT_URL` to the deployed `workers.dev` URL (check `cmdStart`'s `baseUrl(args)` / `--base-url` for the exact env var names it reads — use those, don't guess).

### C. Prove the live shape before trusting any result
Before running anything real, get one shard to execute the probe step alone (a 1-merge, 1-shard smoke run is fine) and read back its recorded `nproc` / `MemAvailable` / disk numbers from the run state or logs. If they don't match `standard-2` (1 vCPU / 6 GiB / 12 GB), wait for propagation and re-probe — do not proceed on an unconfirmed shape (this exact confusion happened once already on this project's synthetic-runner Worker).

### D. Deepseek environment-parity gate (mandatory before any holdout)
Build a 30-merge selection manifest for `deepseek-ai/deepseek-harness` from `docs/research/2026-08-23-deepseek-harness-benchmark-replay-complete.jsonl` (each row's `mergeSha`/base = first parent of `mergeSha`; reuse `scripts/diffci-blind-baseline.ts select`'s manifest shape and `mergeListSha256` formula so your fan-out's `computeMergeListSha256` matches it — or write the manifest by hand from the JSONL and verify the checksum function agrees). Run it through:
```
diffci-analysis-fanout-cli pack --run-id deepseek-parity-1
diffci-analysis-fanout-cli start --run-id deepseek-parity-1 --repos deepseek --shards 4 --max-concurrent 4
diffci-analysis-fanout-cli status --run-id deepseek-parity-1   # poll to completion
diffci-analysis-fanout-cli collect --run-id deepseek-parity-1
```
(You will need to add `deepseek` to the CLI's `REPO_ALIASES`/`SHORT_BY_NAME` maps and its selection manifest to the expected local path — small, allowed addition, not an engine change.)

Diff every resulting row's `analysisStatus` and `affectedTests`/`totalTestsInGraph` against the corresponding row in `docs/research/2026-08-23-deepseek-harness-benchmark-replay-complete.jsonl`. **All 30 must match exactly.** Write `docs/research/blind-baseline-2026-08-23/2026-08-23-deepseek-harness-environment-parity-rows.jsonl` and a short `...-parity-report.md` stating match/mismatch per row. If anything differs — stop, report exactly which rows and why, and do not proceed to holdouts. A mismatch means the container environment is changing the frozen engine's behavior, which is a finding in itself, not something to work around.

### E. The four holdouts
Only after D passes 30/30:
```
diffci-analysis-fanout-cli pack --run-id blind-2026-08-23
diffci-analysis-fanout-cli start --run-id blind-2026-08-23 --repos turborepo,biome,calcom,nx --shards 8 --max-concurrent 16
diffci-analysis-fanout-cli collect --run-id blind-2026-08-23
```
This writes the four `2026-08-23-<repo>-blind-baseline-rows.jsonl` files (already correctly named by the CLI's `REPO_ALIASES`) into `docs/research/blind-baseline-2026-08-23/`. If a repo shows repeated resource kills (two consecutive merges killed in one shard, per the shard state machine's own escalation-stop rule), treat that as the result for that repository at `standard-2` — do not silently bump the instance type and rerun; a rerun at a larger shape is a separate, labeled run (`--retry-run-id`).

### F. Reports (per the original brief's section 6, unchanged) — produce all of:
- One Markdown report per repository (turborepo, biome, calcom, nx) with the full field list from the original brief section 3 (recognized tests by family, SAFE/FALLBACK, unknown-file frequency and dominant paths, graph-UNSAFE causes, timing split cold/warm, failures).
- Native Turbo comparison (`turbo ls --affected` / `turbo run test --dry-run=json --affected` with `TURBO_SCM_BASE`/`TURBO_SCM_HEAD`) per turborepo merge, saved as `2026-08-23-turborepo-native-affected.jsonl`; keep package/task-level and file-level comparisons visually separate in the report.
- Native Nx comparison (`nx show projects --affected`, `nx affected -t test --graph=stdout`) per nx merge if the container can install nx's own dependencies within its step budget; otherwise record "native comparison unexecuted: <reason>" per merge — do not fake it.
- One cross-repository aggregate report using the exact wording rules from the original brief section 5 (e.g. "Using a frozen DiffCI build with no repository-specific adaptation, DiffCI authorized selection on X of Y historical merges across N repositories. Test-universe modeling was complete for A repositories and incomplete for B…"). Never write "DiffCI saves X% CI".
- The limitations & capability-gap matrix (categorize every discovery as: general engine bug / missing language support / missing test-family discovery / missing fixture-ownership / unsupported build-system semantics / legitimate conservative fallback / execution-environment limitation / repository-specific convention).
- The proposed adapted-replay roadmap (do not implement it).
- The fan-out run record (shard shapes, per-shard timings, failures, R2 keys, an estimated container-minutes/cost figure) and a container-resource report (peak memory, clone time, graph-build time per repository on `standard-2`, any resource kills) — you already have the raw data for this in each shard's heartbeats/summary; just aggregate and present it.

## Constraints, restated because they still apply
- Never edit `src/repo/*`, `src/git/*`, `scripts/diffci-benchmark-external.ts`, `scripts/diffci-blind-baseline.ts`. `verify-frozen-engine.cjs` MUST print `MATCH` before and after everything you do.
- Never touch `diffci-research-sandbox`, `wrangler.research-sandbox.jsonc`, `src/research/cloudflare/**`, or redeploy `diffci-product` / `diffci-synthetic-runner` / `diffci-github-runner`.
- No commits, no pushes, unless explicitly asked. `git status` first; the working tree has a lot of unrelated uncommitted work from other tasks — preserve every bit of it.
- Secrets only via `wrangler secret put`, never logged or committed.
- Blind-baseline honesty rules: environment failures are rows with `errorClass`, never a verdict; no silent reruns overwriting a completed baseline file (the CLI already enforces this — use it, don't bypass with `rm`).

## Report back with
- New test count from `npm run check` (must exceed 908) and confirmation `verify-frozen-engine.cjs` still prints `MATCH`.
- The live-shape probe output.
- Deepseek parity result: 30/30 matched, or the exact rows that didn't and why — this gates everything after it.
- Holdout results in the mandated wording, plus every report file's path.
- Every Cloudflare resource created (Worker name, DO classes, R2 bucket, secret name) for teardown.
