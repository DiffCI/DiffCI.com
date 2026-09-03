# EXTERNAL_ENGINE_BRIDGE_01 — deploy + rehearsal, real Cloudflare infrastructure

Implements the remaining steps of `docs/external-engine-bridge-01-plan.md`'s sequence: deploy, then
"end-to-end rehearsal ... on a repository under an account DiffCI's team does not otherwise use for
development." Steps 1-2 (graceful REFUSED on a missing reference plan; the container script + Worker
wiring into Shadow's push pipeline) were implemented and committed first (`b8e3c51`, `8a66d75`). This
freeze covers what came after: a small missing piece found while preparing to rehearse, the real deploy,
a fresh preflight check, and the actual rehearsal run.

## Step 3 — the missing piece: a manual rehearsal trigger (`517d317`)

The bridge as built only fires from a real GitHub push webhook (`scheduleCiReproductionBridge` in
`shadow-webhook.ts`, wired in `validation-worker.ts`). `eslint/eslint` is a legitimate first candidate
for this phase — it already has a hand-authored reference plan — but DiffCI's Shadow App is not
installed on it and never will be for a public rehearsal target like this, so no real webhook delivery
could ever reach it. `POST /v1/shadow/ci-reproduction-bridge` (bearer-gated, same
`RESEARCH_DISPATCH_TOKEN` convention as every other manual `/v1/shadow/*` route) closes that gap. It is
not a parallel code path: it calls the identical `loadVerifiedShadowSource` gate and
`executeCiReproductionBridge` function the real webhook trigger calls, just synchronously instead of via
`ctx.waitUntil`, so the rehearsal exercises production code, not a stand-in. 1911/1911 tests, typecheck
clean.

## Deploy

Canonical pipeline (`npm run shadow:deploy` / `scripts/deploy-research-sandbox.ts`), commit `517d317`:
typecheck + full suite clean → `wrangler deploy --var EXPECTED_SOURCE_SHA:517d317...` →
source packaged and uploaded to R2 → verified `sourceIntegrity.status: CURRENT` with
`expectedSha == archiveSha == 517d3174d212e621e68ec1937881de0c4f545105`. Worker:
`https://diffci-research-sandbox.damp-waterfall-0cd8.workers.dev`.

## Preflight qualification for eslint — checked fresh, not assumed from prior runs

Per direction: use eslint only if its existing (unmodified) reference plan is still valid for the
current engine and repository state.

1. **Engine validity, fresh R3 reference-only qualification**, run locally against the just-deployed
   code, at the plan's own pinned SHA (`2417cad57...`): `R3_QUALIFIED` — `npm install` (32.2s, exit 0)
   and `node Makefile mocha` (168.1s, exit 0, 38,647 tests / 0 failures) both ran to completion, matching
   the plan's two transcribed steps exactly. See `eslint/r3-preflight-qualification.json`.
2. **Repository-state validity, checked against eslint's real current state** (read-only GitHub API,
   not the plan's pinned commit): current default-branch HEAD is `87e0a082438264ad90b87fd74165ab4fd90f63ef`.
   `package.json` still has no `packageManager` field; `package-lock.json` still does not exist at the
   repo root — the same missing-pinned-dependency-basis condition the plan's `REFUSED` outcome has always
   rested on, still true today. The live `.github/workflows/ci.yml`'s `test_on_node` job still runs the
   plan's exact two steps (`npm install`, `node Makefile mocha`) on the exact matrix cell the plan targets
   (`ubuntu-latest`, node `22.x`) — unchanged since the plan was authored, though the job has since grown
   two additional steps (`Fuzz Test`, `Test EMFILE Handling`) the plan doesn't capture. Immaterial here:
   those steps sit after the one the causal graph already refuses.

Verdict: eslint passes. The plan was not modified.

## Rehearsal — real run, real infrastructure

`POST /v1/shadow/ci-reproduction-bridge {"repository":"eslint/eslint"}` against the deployed Worker.
Result: `HTTP 200`, `{"ok":true,"outcome":"REFUSED", headSha: "87e0a082438264ad90b87fd74165ab4fd90f63ef"}`.
Wall time ~5m09s (`environment.json`: 01:45:45 → 01:50:54 UTC) inside a real Cloudflare Sandbox
(`docker.io/cloudflare/sandbox:0.12.5`).

### The four required proofs

1. **Exact repo/commit traceable** — `reproduction.json.repository` = `eslint/eslint`,
   `.headSha` = `87e0a082438264ad90b87fd74165ab4fd90f63ef`, independently matching eslint's real
   `main` HEAD fetched from the GitHub API before the run — not the reference plan's pinned SHA, and not
   trusted from any caller-supplied value (derived inside the container from `git rev-parse HEAD` after
   an authenticated clone). `environment.json` corroborates with real `startedAt`/`completedAt` and the
   container image.
2. **Genuine engine execution, not Shadow's own analysis returned instead** — `reproduction.json` carries
   the full `src/ci-inference/` schema (`schema`, `jobs` [29], `testPlan`, `inferredOperations`,
   `referenceArm`, `inferenceArm`), structurally unlike anything Shadow's dependency-graph predictor
   produces (`logicalDeltaKey`/`planMode`/`testsSelectedDiffci`, none present here). `referenceArm.steps`
   has 2 real entries — `npm install` and `node Makefile mocha` genuinely executed inside the Sandbox
   against eslint's real current HEAD, each with its own step receipt; `inferenceArm.refused: true`
   records why the engine-derived path did not run.
3. **`reproduction.json` persisted and retrievable with provenance** — pulled back independently via
   `wrangler r2 object get diffci-research-evidence/shadow/ci-reproduction/eslint/eslint/87e0a08.../reproduction.json --remote`,
   not merely trusted from the HTTP response. `environment.json` at the same prefix carries the
   image/timestamps/repository/headSha provenance record.
4. **Refusal/unresolved outcomes survive unchanged** — `REFUSED`, for the identical structural reason
   this whole session's eslint runs have always produced: "a pinned dependency basis (lockfile or
   packageManager field)" could not be established for the causal prerequisite the inference path needs.
   Not coerced toward a generic success/failure, not a crash, not silently swapped for a different
   repository.

## What this does and doesn't establish

This proves the bridge's mechanics work end-to-end against a real, live, uninstrumented external
repository, through real deployed Cloudflare infrastructure: real clone, real Sandbox, real
`ci:reproduce` invocation, real R2 persistence, genuinely retrievable afterward. It does not establish a
`REPRODUCED` result — eslint has never produced one in this corpus, and this rehearsal's job was to prove
the pipe works, not to change what flows through it. The plan's own note on delivery surface still
applies unchanged: the result lands in R2, not as a GitHub check run or PR comment (Shadow's App manifest
has no write scopes; requesting them is out of scope here).

Not yet done: the plan's next step, "first genuine external repository ... the team is willing to
hand-transcribe a reference plan for beforehand" — eslint already has one and just served as this
rehearsal's subject, but the plan's sequence still treats "rehearsal" and "first genuine external repo"
as two distinct steps. Whether to treat this run as satisfying both, or to pick a second repository, is
a decision for the next session.
