# Case Study: the real Node-runtime CI incident (Preflight P1, Part K)

**Status: organic production-development evidence, not a controlled experiment.** Everything in this
document happened as a real, unplanned side effect of building DiffCI's own SaaS-foundation features on
2026-08-22 - nobody injected this failure to produce a demonstration. It is presented here for exactly
that reason: it is the single clearest real-world case for Preflight's core thesis available in this
project's history, and its honesty depends on it never being confused with a designed experiment. Where
this document draws on counts/classifications, it defers to
[the P0 historical failure study](2026-08-22-preflight-p0-historical-failure-study.md)'s case study #1,
the authoritative source for the underlying dataset; nothing here re-derives or overrides those numbers.

## What happened, in order

1. **2026-08-22, 05:42:06 UTC** - commit `98b7790` ("feat(product): SaaS control-plane foundation...")
   pushed to `main`. Real GitHub Actions CI run failed in ~78s.
2. Five more commits landed over the next ~3.3 hours, each a genuine, unrelated feature addition to the
   SaaS foundation (auth, usage metering, the runner-provider abstraction, remaining product routes) -
   **every single one also failed CI**, for the same underlying reason, without anyone noticing the
   pattern at the time: `303fa11`, `091fec4`, `35388f4`, `400d37a`, `b05b480`.
3. **07:08:21 UTC**, commit `ddf69dd` (the Preflight P0 historical study itself) inspected real CI logs
   across the repo's history as part of its own data collection - and surfaced the pattern: all recent
   runs were failing with the identical error, `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module:
   node:sqlite`.
4. **Root cause**: the SaaS foundation's own test suite (`tests/**/store.test.ts`) started using
   `node:sqlite`'s `DatabaseSync` - stable only from Node 22.5.0 onward. Local development happened on
   Node 24, where it worked silently. The self-hosted CI runner's Docker image (`ops/github-runner/
   Dockerfile`) pinned Node 20. `package.json` declared no `engines.node` field at all, so nothing
   anywhere would have flagged the mismatch even if someone had thought to check. **Seven real,
   organic CI failures in a row, invisible locally, before anyone read a real log tail.**
5. **Fix committed** (`55f3d5f`, 2026-08-22): `package.json`'s `engines.node` set to `>=22.5.0`;
   `ops/github-runner/Dockerfile`'s Node install bumped from `setup_20.x` to `setup_22.x`.
6. **Deploying the fix was blocked for a real, separate reason**: rebuilding the custom runner Docker
   image needed a local Docker daemon (unavailable in this environment - confirmed by a real failed
   `wrangler deploy` attempt), and a GitHub-Actions-hosted build workflow hit a **pre-existing GitHub
   Actions billing hold** on the account (confirmed by a real failed `workflow_dispatch` run, annotation:
   "recent account payments have failed or your spending limit needs to be increased" - unrelated to
   this incident, a genuine separate account condition).
7. **Real fix, deployed**: `src/research/cloudflare/github-runner-worker.ts` and `wrangler.github-runner.jsonc`
   were rewritten to run the self-hosted runner on Cloudflare's own pre-published Sandbox image
   (`docker.io/cloudflare/sandbox:0.12.5`) instead of a custom-built Dockerfile - needing zero local
   Docker. Deployed and validated live: instance sizing mattered (`"lite"` was unreliably slow;
   `"standard-2"` completed the full runner-registration cycle in ~26s).
8. **Real CI green, commit `8450e08`** (2026-08-22, 09:24-09:26 UTC): a real `workflow_job` webhook
   drove a real Sandbox-based runner (`cf-job-97011858600`) through registration, execution, and clean
   deregistration. `tsc --noEmit` passed. **452/452 tests passed**, 111 suites, 0 failures. Real GitHub
   Actions conclusion: `success`. Confirmed environment: Node v22.23.2, npm 10.9.8, x86_64, Ubuntu
   22.04.5 LTS - genuinely satisfies `engines.node >=22.5.0`, not just incidentally.

## Why this is the case for Preflight

Every one of the seven failing pushes touched files completely unrelated to Node version or CI
infrastructure - product routes, auth wiring, usage metering. A **file-change-triggered** check would
have caught none of them; the actual break (an unpinned runtime requirement, a stale provisioning
image) had been sitting broken since before the first of the seven commits. This is exactly why
Preflight P1's `runtime_parity` check (`src/preflight/runtime-parity.ts`, `src/preflight/checks-registry.ts`)
is deliberately registered with `applicability: { trigger: "always" }`, not a changed-files rule - see
that file's own header comment, which cites this exact incident.

## What Preflight P1 would have said, verified against real test fixtures

The regression fixture in `tests/preflight/runtime-parity.test.ts` ("Node 20/22 regression fixture")
replays this incident's exact shape: the real declared requirement (`package.json#engines.node`,
`>=22.5.0`) evaluated against the pre-fix provisioned runtime (`ops/github-runner/Dockerfile`, Node
20.x) returns `CONFLICTING` - a declared-source disagreement detectable from the repository alone,
**before any of the seven commits needed to run real CI to discover it**. The equivalent
actual-runtime-only framing (declared `>=22.5.0` vs. an actual Node 20.9.0) returns `MAJOR_MISMATCH`.
Both verdicts feed `risk-model.ts` v1's `runtime_parity_confirmed_mismatch` signal (weight 7, the
single highest-weighted signal in the model - see that file's own header comment) and would have
produced a `HIGH_RISK` `computePreflightVerdict()` result (`src/preflight/verdict.ts`,
`highRiskAtOrAbove: 6`) on **every one of the seven commits**, not just the first.

Reconciled against real ground truth (`src/preflight/reconciliation.ts`), this incident classifies as a
`TP`: the actual failure class is `CONFIGURATION` (matching the P0 study's own classification), and
`runtime_parity` is registered as detecting `CONFIGURATION` (`checks-registry.ts`) - a prediction that
recommends `runtime_parity` for this commit is, by `isEligibleForPrevention()`'s own concrete
definition, eligible for prevention. `tests/preflight/reconciliation.test.ts` includes this exact
scenario as a named test case.

## What this incident does NOT prove

This is one real incident, not a controlled trial - it cannot by itself establish a false-positive rate,
a precision/recall number, or a generalizable "Preflight always works" claim. Those numbers come from
Part G's leakage-safe chronological replay across the full historical dataset, reported separately and
explicitly forbidden from being tuned to reproduce any particular target number (Preflight P1 Part G's
own instruction). This document's only claim is narrower and fully supportable: for this one real,
organic, unplanned incident, the mechanism now built would have flagged it immediately, from a source
of evidence available before any CI run - and the incident, once found, motivated exactly the
generalized (not node:sqlite-hardcoded) design `runtime-parity.ts` actually implements.
