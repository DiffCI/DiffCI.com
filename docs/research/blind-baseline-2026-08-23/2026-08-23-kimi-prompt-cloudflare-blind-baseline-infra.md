# Prompt for Kimi 2.7 — Build DiffCI's Cloudflare Sandbox analysis fan-out and run the blind multi-repository baseline on it

You are working in the DiffCI repository (`C:\Users\Swati Kale\OneDrive\Desktop\DiffCI.com`, TypeScript, Node 24, npm). DiffCI is a CI test-selection engine: `git diff → TypeScript dependency graph → affected tests → safety policy → SAFE_TO_PROPOSE | FALLBACK`. It is deployed on Cloudflare (Workers + Durable Objects + D1 + Sandbox/Containers). Your job is to build the infrastructure that runs DiffCI's **static analysis inside Cloudflare Sandboxes, horizontally across many containers**, and then use it to execute an already-prepared, frozen, blind benchmark. You are building product-path infrastructure, not a one-off script: the same fan-out will later analyze customer pull requests concurrently.

Read this whole prompt before touching anything. Where it says "must", it is not negotiable.

## 1. What already exists — reuse, do not reinvent

| Piece | Where | What it gives you |
|---|---|---|
| Run DiffCI inside a Sandbox from a source tarball | `src/research/cloudflare/validation-worker.ts` (functions that `tar -xzf /opt/diffci-source.tgz`, `npm ci`, then `npx tsx scripts/...` via `sandbox.exec`) | The proven bootstrap pattern: public image `docker.io/cloudflare/sandbox:0.12.5`, no custom Dockerfile (there is **no local Docker daemon** on this machine — a custom image deploy already failed for that reason). |
| Sandbox Worker skeleton with control token, exec timeouts, async termination | `src/runner/cloudflare/synthetic-runner-worker.ts`, `wrangler.synthetic-runner.jsonc` | `getSandbox(...)`, `exec` with `timeout`, `destroy()`, `instance_type`, `max_instances`, `RUNNER_CONTROL_TOKEN` secret pattern. |
| Job queue / claim / heartbeat model (R1/R2) | `src/runner/agent-api.ts`, `src/product/cloudflare/product-worker.ts`, `src/runner/r2-job-spec.ts` | How jobs are enqueued, claimed, and terminated asynchronously. |
| Deterministic benchmark driver (harness) | `scripts/diffci-blind-baseline.ts` (`select` and `replay` modes), `scripts/diffci-benchmark-external.ts` (one merge → one JSON row) | **This is the unit of work per container.** `replay --clone <dir> --manifest <json> --out <rows.jsonl>` is resumable (skips merges already in the output), refuses a manifest whose SHA-256 drifted, passes only full SHAs (never `~`/`^` through a shell), and records errors as rows (`errorClass`: checkout-failure, timeout, base-head-mismatch, unsupported-repository-root, ...). |
| Frozen build + integrity check | `docs/research/blind-baseline-2026-08-23/2026-08-23-diffci-frozen-build-manifest.json`, `docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs` | SHA-256 of every engine/harness file, git HEAD `8890e1a5`, working-tree diff checksum, 908/908 tests, engineChecksum `e0f20b722d880d59...`. `node verify-frozen-engine.cjs` exits 1 on drift. |
| Immutable 30-merge selection manifests (all 30 merges verified merged via GitHub API) | same dir: `2026-08-23-{turborepo,biome,calcom,nx}-blind-baseline-selection-manifest.json` | repository (note `calcom/cal.com` resolved to `calcom/cal.diy`), default branch, cutoff `2026-08-23T00:00:00Z`, per merge: PR number, merge SHA, base (first-parent) SHA, timestamp, changed-file count, `mergeListSha256`. |
| Prior single-repo benchmark (development repo, NOT a holdout) | `docs/research/2026-08-23-deepseek-harness-three-way-comparison.md` and the `...-replay-complete.jsonl` next to it | Shows the exact row shape and the reporting standard expected (verdicts, per-family test counts, fallback reasons, unknown files, graph-confidence causes, timing split). |

Known hazards from earlier work, all real: a Sandbox `exec` capped at 580 s; a `curl` with no client timeout hung forever; `pnpm install` on the `lite` shape (256 MiB) was SIGKILLed (exit 137) after 474 s; `cmd.exe` eats `^` in `sha^1` (hence full SHAs only); a deploy-propagation lag produced a confounded first run once — verify the live shape before trusting a run.

## 2. Hard constraints (must)

1. **Do not modify the engine.** `src/repo/*`, `src/git/*`, `scripts/diffci-benchmark-external.ts`, `scripts/diffci-blind-baseline.ts` are frozen. Before every analysis run, inside the container, run `node docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs` and abort the shard if it exits non-zero. Record the engineChecksum in every output row's metadata.
2. **Do not touch the Stage 2F shadow worker** (`diffci-research-sandbox`, `wrangler.research-sandbox.jsonc`, `src/research/cloudflare/validation-worker.ts`, anything under `src/research/cloudflare/`, its D1 database or cron). It is frozen in a 14-day observation window until 2026-09-04. Create a **new** Worker and Sandbox class. Do not redeploy `diffci-product`, `diffci-synthetic-runner`, or `diffci-github-runner` either — another workstream owns them; read them, copy patterns, but deploy only your new Worker.
3. **Do not commit or push** unless the user explicitly asks. Check `git status` before editing and preserve all unrelated uncommitted work (there is a lot of it).
4. **The benchmark is blind.** No repository-specific rules, no test-pattern expansion, no unknown-file suppression, no graph-confidence weakening, no reruns that silently replace rows. A failed row is a result. Retries go in a separate file with a reason.
5. **Honesty in reporting.** Never convert an environment failure (checkout error, OOM/exit 137, timeout, disk full) into a DiffCI verdict. Separate warm-cache from cold-cache timings. Do not claim CI savings or failure-detection correctness — this phase executes no tests. A `SAFE_TO_PROPOSE` against an incomplete test universe is "policy-safe within modeled tests", not production-safe.
6. **Secrets.** Use `wrangler secret put` for the control token; never write it into config, logs, or output rows. Never put credentials inside the source tarball.
7. Account id is pinned in existing wrangler configs (`571ba9bf90457be28a492d139c055e54`); reuse it. Use `workers.dev`, no custom route.

## 3. What to build

### 3.1 `diffci-analysis-fanout` Worker + `AnalysisShard` Sandbox class
- New `wrangler.analysis-fanout.jsonc` modeled on `wrangler.synthetic-runner.jsonc`: image `docker.io/cloudflare/sandbox:0.12.5`, `instance_type` **`standard-2`** initially (1 vCPU, 6 GiB, 12 GB disk — cal.com is 18 MB of TypeScript and nx 32 MB; a TS program build over those will not fit `basic`), `max_instances` ≥ 32, Durable Object binding, D1 or R2 binding for results (R2 preferred: one object per shard `runs/<runId>/<repo>/shard-<n>.jsonl`), observability on.
- Control surface (bearer token, same pattern as the synthetic runner):
  - `POST /v1/run` — body: `{ runId, repositories: [{ name, manifestKey }], shardsPerRepository }`. Uploads nothing itself; manifests and the source tarball are put in R2 beforehand (see 3.3). Returns immediately; work continues asynchronously (do **not** hold an HTTP request open for hours).
  - `GET /v1/run/:runId` — per-shard status: `pending | bootstrapping | cloning | analyzing | done | failed`, rows completed, last error, peak memory if known, timings.
  - `POST /v1/run/:runId/cancel`.
- Each shard, inside its Sandbox:
  1. `tar -xzf` the DiffCI source tarball from R2 into `/opt/diffci`; `npm ci`; run `verify-frozen-engine.cjs` — abort on drift.
  2. `git clone --filter=blob:none https://github.com/<repo>.git /workspace/<repo>` (blob-less; blobs arrive on checkout). Record clone wall time and bytes.
  3. Write the shard's slice of the manifest (merges `k, k+N, k+2N, ...` for shard `k` of `N` — deterministic, so a re-run shards identically) and execute `npx tsx scripts/diffci-blind-baseline.ts replay --clone ... --manifest <slice> --out /workspace/rows.jsonl`. The slice must keep the parent manifest's `mergeListSha256` in a `parentManifestSha256` field so rows can be traced to the immutable manifest; the driver validates a manifest's own checksum, so compute the slice's checksum the same way (`sha256(merges.map(m => base+".."+merge).join("\n"))`).
  4. Wrap every `exec` with an explicit timeout and treat timeouts/exit 137 as **row-level** results where possible (the driver already has a 30-min per-merge cap); a shard-level kill becomes a shard `failed` status with the partial `rows.jsonl` still uploaded.
  5. Capture per merge: `/proc/meminfo` MemAvailable before/after, peak RSS of the analysis process if obtainable (`/usr/bin/time -v` if present, else `ps` sampling), disk free, wall times. Add them under a `container` key on each row — do not change the engine's own fields.
  6. Upload `rows.jsonl` (append-style: upload after every row or every 60 s so a kill loses at most one row) and a `shard-summary.json` to R2, then `destroy()`.
- A collector endpoint `GET /v1/run/:runId/rows?repository=...` that concatenates shard objects into one JSONL stream ordered by manifest index. Rows from different shards must never be merged by anything smarter than "sort by index".

### 3.2 Resource-kill and timeout discipline
- Shard exec timeouts must be per-step (bootstrap ≤ 10 min, clone ≤ 20 min, each merge ≤ 30 min) and enforced on both sides: Sandbox `exec({ timeout })` **and** a Durable Object alarm that marks the shard `failed: watchdog` if no heartbeat for 35 min.
- On exit 137 / OOM: record `{ errorClass: "resource-kill", exitCode: 137, shape: "standard-2", memAvailableBeforeMb, ... }` for the merge, continue with the next merge. If two consecutive merges in a shard are killed, mark the shard `failed: repeated-resource-kill` and stop — do not silently escalate shape. Shape escalation is a human decision; expose the evidence.

### 3.3 Local CLI to drive it (harness, new file `scripts/diffci-analysis-fanout-cli.ts`)
- `pack` — builds the source tarball of the **current working tree** (tracked + untracked, excluding `node_modules`, `.git`, `docs/research/**/*.jsonl`), writes its SHA-256, uploads to R2 via `wrangler r2 object put`, and refuses if `verify-frozen-engine.cjs` fails locally.
- `start --run-id <id> --repos turborepo,biome,calcom,nx --shards 8` — uploads the four selection manifests to R2, calls `POST /v1/run`.
- `status --run-id <id>` — prints the shard table.
- `collect --run-id <id> --out docs/research/blind-baseline-2026-08-23/` — writes `2026-08-23-<repo>-blind-baseline-rows.jsonl` per repository (immutable once written: the CLI must refuse to overwrite an existing file; use `--retry-run-id` to write `...-retry-<reason>.jsonl` instead), plus `2026-08-23-<runId>-fanout-run-record.json` with shard shapes, timings, failures, and R2 keys.
- Every CLI call must use a client-side HTTP timeout (the earlier hang was a `curl` with none).

### 3.4 Tests (DiffCI's own suite: `npm run check` must stay green — currently 908/908)
- Shard slicing is deterministic and covers every manifest index exactly once; slice checksum computed as the driver expects; `parentManifestSha256` propagated.
- Exit-137 and timeout mapping to row-level `errorClass` without a verdict.
- Collector ordering and refusal to overwrite.
- A test that the Worker rejects a run whose tarball checksum does not match the frozen manifest's `engineChecksum`.
Use the existing test style (`node:test`, `tests/**/*.test.ts`). No network in tests; stub the Sandbox like `tests/runner/*.test.ts` do.

### 3.5 First real run = environment-parity check, then the blind baseline
1. Deploy the new Worker. Confirm the live `instance_type` via a probe exec (`cat /proc/meminfo`, `nproc`) **before** trusting results — record it.
2. Run **deepseek-ai/deepseek-harness** first (the development repo, not a holdout) using the 30-merge list in `docs/research/2026-08-23-deepseek-harness-benchmark-replay-complete.jsonl` (build a manifest from its `sha`/`base` fields; base = first parent). Every verdict and every `affectedTests/totalTestsInGraph` pair must match that file **row for row**. If anything differs, the environment changed the engine's behaviour — stop and report; do not proceed to holdouts.
3. Then run the four holdouts from their immutable manifests. Default 8 shards per repository (30 merges → ~4 per shard); total concurrent instances ≤ your `max_instances`.
4. Produce, per repository, the row file and a Markdown report, and one cross-repository aggregate, following the structure and wording rules in section 5. Also produce the container-resource report: per-repo peak memory, clone time, graph-build time on `standard-2`, and whether any shard was resource-killed.

## 4. Repository-specific notes (read-only findings so far; do not act on them by changing the engine)
- **turborepo** (`main`): majority Rust (the `turbo` CLI) + pnpm JS packages + `turbo.json`. The frozen engine models only the JS/TS side. Also collect native Turbo output per merge where feasible without installing the world: `npx turbo ls --affected` with `TURBO_SCM_BASE=<base> TURBO_SCM_HEAD=<merge>` (and `turbo run test --dry-run=json --affected`), saved as `2026-08-23-turborepo-native-affected.jsonl`. Keep package/task-level (Turbo) and test-file-level (DiffCI) comparisons separate.
- **biome** (`main`): ~90% Rust, Cargo workspace, `insta` snapshots, `justfile`; tiny pnpm JS layer. Expect the engine to see almost nothing — **that is a valid result** ("missing language support"), not something to fix now.
- **cal.com** (resolved to `calcom/cal.diy`, `main`): Yarn + Turbo + Vitest/Playwright, 60+ workflows (many e2e/cron/db jobs). Report unit / package / integration / e2e-browser / db-service / enterprise surfaces separately; do not call the universe complete.
- **nx** (`master`): pnpm + Jest + `nx.json`, plus Rust/Kotlin/Gradle/Maven parts. Native comparison: `npx nx show projects --affected --base <base> --head <merge>` and `nx affected -t test --graph=stdout` — requires nx's own dependencies installed in the container (heavy; if install fails or exceeds the shard budget, record "native comparison unexecuted: <reason>" rather than faking it).

## 5. Reporting rules (copy these into your final report)
Lead with the blind generalization result, not the best case. For each repository: merges analyzed, SAFE/FALLBACK counts, median & mean selected %, median recognized tests, test-universe completeness (complete / incomplete, with which families are unrecognized), fallback-reason frequency, unknown-file frequency with dominant extensions/paths, graph-UNSAFE frequency and causes, median graph-build / impact / total wall time (cold vs warm marked), failures/resource kills, native affected-system comparison where valid. Categorize every discovery as one of: general engine bug · missing language support · missing test-family discovery · missing fixture/companion ownership · unsupported build-system semantics · legitimate conservative fallback · execution/environment limitation · repository-specific convention. Use this sentence shape: "Using a frozen DiffCI build with no repository-specific adaptation, DiffCI authorized selection on X of Y historical merges across N repositories. Test-universe modeling was complete for A repositories and incomplete for B, so only the former are candidates for execution-level safety validation." Never write "DiffCI saves X% CI". End with: whether the evidence supports proceeding to executed validation, and the recommended shape/cost for production analysis based on the measured container resources.

## 6. Deliverables checklist
- `wrangler.analysis-fanout.jsonc`, `src/analysis-fanout/cloudflare/analysis-fanout-worker.ts` (+ helpers), `scripts/diffci-analysis-fanout-cli.ts`, tests under `tests/analysis-fanout/`.
- In `docs/research/blind-baseline-2026-08-23/`: deepseek parity rows + parity report; four `...-blind-baseline-rows.jsonl`; four per-repo reports; native Turbo/Nx outputs; cross-repo aggregate; limitations & capability-gap matrix; adapted-replay roadmap (proposed, not implemented); fan-out run record with shapes, timings, cost estimate; container-resource report.
- `npm run check` green; `verify-frozen-engine.cjs` still MATCH at the end (prove the engine did not drift).
- A short handover note listing every Cloudflare resource you created (Worker, DO class, R2 bucket/keys, secrets) so it can be torn down.
