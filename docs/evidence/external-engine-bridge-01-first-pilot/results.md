# EXTERNAL_ENGINE_BRIDGE_01 — first newly-prepared external-repository pilot

Answers the claim eslint's rehearsal explicitly could not: *can DiffCI deliberately onboard a brand-new
external repository — selected without regard to likely outcome, its reference plan independently
hand-transcribed and frozen before any engine run — and carry it through the deployed bridge to an
honest, immutable result?* Chain: **unknown external repo → independent human reference transcription →
frozen plan → live HEAD → deployed bridge → engine → immutable result.**

## Selection — mechanical, not mine

Continued the exact frame `CI_REPRODUCTION_05` used (`npm-high-impact@1.13.0 topDependent`, ascending
rank), starting from the next unscreened rank (12), rather than picking a repository. Full trail in
`docs/evidence/external-engine-bridge-01-first-pilot-screening.json`:

| rank | repo | verdict |
|---|---|---|
| 12 | import-js/eslint-plugin-import | rejected — not transcribable (Node-matrix and install resolved by third-party reusable actions, not stated in the repo's own workflow) |
| 13 | isaacs/rimraf | rejected — `R3_FAILED`, but genuinely: both steps ran exactly as transcribed and the real suite passed (17/17, 782/782 asserts); the harness's evidence parser just doesn't recognize `node-tap`'s own CLI reporter format as a completed suite. Plan frozen before R3, per protocol. |
| 14 | chaijs/chai | rejected — no node-22 cell in its matrix at all (`[20, 25, 'latest']`) |
| 15 | @types/jest → DefinitelyTyped/DefinitelyTyped | deduped against rank 5 |
| **16** | **lodash/lodash** | **qualified** — single job, static matrix including node 22, two plain commands, zero-repair transcribable |

Plan hand-transcribed from `.github/workflows/ci-node.yml` and frozen (`e2cb004`, before rimraf's outcome
was even known it was ranked as a fallback; lodash's own plan frozen at `e4a2a95`) **before running R3 or
looking at any engine output for it** — including while its test runner (QUnit via plain `node
test/test`) was unfamiliar to this corpus. That was deliberate: skipping a candidate because its output
format seems less likely to parse cleanly would itself be outcome-based selection.

## A local false negative, caught and corrected

The first R3 check (run locally, as eslint's and rimraf's were) reported `R3_FAILED`: `npm run validate`
exited 1, tracing to `jscs fp/*.js` — `Error: Path fp/*.js was not found`. Investigating rather than
accepting this at face value: `ci-reproduction.ts` invokes commands with `shell: true`, which means real
POSIX glob expansion on Linux but **not** on Windows (`cmd.exe` doesn't expand `*` for a program that
doesn't glob itself). Every local preflight check this whole phase has run on Windows — harmless for
eslint and rimraf, whose commands don't depend on shell-specific expansion, but not a trustworthy signal
here. A local Docker/WSL attempt to get a real Linux check stalled (daemon wouldn't come up in reasonable
time) and was abandoned rather than fought further — the deployed bridge itself runs inside the real
canonical container, so the correct fix was to just run the actual thing.

**Caveat for future candidate screening, generalized from this:** a local Windows `R3_FAILED` is not
authoritative on its own when the failing step could plausibly depend on shell-specific behavior (glob
patterns, brace expansion, POSIX-only syntax). Confirm in the canonical container before rejecting.

## The real run

`POST /v1/shadow/ci-reproduction-bridge {"repository":"lodash/lodash"}` against the deployed Worker
(after redeploying to `e4a2a95` — the first attempt hit a stale packaged source that predated the plan's
own commit, caught by an honest `REFUSED: no reference plan exists`, not a false success). lodash's live
default-branch HEAD is still `a666ba591064c8011988275790ad7d625279f09c` — the same commit the ground
truth was pinned to; no plan-age mismatch to caveat here, unlike eslint's rehearsal.

**Result:**
```
outcome: REFUSED
reason: the engine did not mark the path executable, so the inference arm executed nothing:
        1 operation(s) in the TEST path are not executable: test-docs-unknown-4 (a resolved command)
```

`referenceArm.reachedEnd: true`, both steps exit 0 (`npm install`, `npm run validate` — confirming the
canonical Linux container genuinely does glob-expand `fp/*.js` correctly, unlike my local Windows check).
Neither reference step yields a `tests`/`failures` count — QUnit's own console output (invoked via plain
`node test/test`), like `node-tap`'s CLI reporter for rimraf, isn't a format the harness's evidence parser
currently recognizes. `inferenceArm.refused` names a *different*, engine-derived cause entirely: the
engine's own independent read of lodash's real CI (not consulting my reference plan) found a test-purpose
operation (`test-docs-unknown-4` — plausibly the `test:doc` script, `markdown-doctest doc/*.md`, which
`validate` never actually calls, but the workflow-derived graph apparently associates with the TEST path)
it could not resolve to a concrete, executable command. `classify()` correctly reports `REFUSED` rather
than either arm's shortfall being papered over into a false `REPRODUCED` or a crash.

### The four required proofs

1. **Exact repo/commit traceable** — `repository: lodash/lodash`, `headSha:
   a666ba591064c8011988275790ad7d625279f09c`, independently matching the ground-truth commit recorded
   during screening (fetched from the GitHub API before any engine run).
2. **Genuine engine execution** — full `src/ci-inference/` schema present (`jobs`, `testPlan`,
   `inferredOperations`, `referenceArm`, `inferenceArm`), structurally unlike Shadow's own prediction
   output. `referenceArm.steps` carries 2 real receipts with genuine exit codes from a real run inside the
   Sandbox; `inferenceArm.refused` carries a real, specific, engine-derived reason.
3. **Persisted and retrievable with provenance** — pulled independently via
   `wrangler r2 object get diffci-research-evidence/shadow/ci-reproduction/lodash/lodash/a666ba59.../reproduction.json --remote`,
   not trusted from the HTTP response. `environment.json` at the same prefix carries
   image/timestamps/repository/headSha.
4. **Refusal outcomes survive unchanged** — `REFUSED`, for a specific, well-formed, engine-derived
   reason. Not coerced toward success, not a crash.

## What this establishes

This is the "first newly-prepared external-repository pilot" step eslint's rehearsal could not stand in
for: a repository chosen by a mechanical, external, bias-free process; a reference plan independently
authored and frozen before any engine output existed for it; carried through the real deployed
infrastructure to an honest, persisted, immutable result. The result is `REFUSED`, for a reason genuinely
emergent from the engine's own analysis — not engineered, not expected, not adjusted after the fact.

Two real, narrow parser-coverage gaps surfaced along the way (node-tap's CLI reporter at rimraf; QUnit's
plain-script output at lodash) — both real findings, both explicitly out of scope to fix as part of this
pilot (extending the evidence parser is new engine work, not a bridge/rehearsal concern), recorded here
for whoever picks that up next.
