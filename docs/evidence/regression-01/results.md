# REGRESSION_01 — same-five rerun, raw results

Executed 2026-09-02, against the pre-registered plan in `docs/semantic-repair-01-plan.md` and the
prerequisites frozen at `5539155`. Inference under test: `7999e92` (SEMANTIC_REPAIR_01 layer 6, the last
inference-touching commit before this run — `a526993` on top of it is a doc-only correction, confirmed by
`git show --stat a526993` touching only `docs/`).

## Harness identity across all five

Every run shares the identical inputs, confirmed from each `execution-receipt.json`:

- `sourceTarballSha256: be3252efb6c14381c3c57ea4690dd16a237ede3ff27e7dd7e0b7d0b846da16e4`
- `agentTarballKey: agents/observer-ee639e1ac7e1a81b.tgz`
- container image `docker.io/cloudflare/sandbox:0.12.5`, `node v22.23.2`

Per the CORRECTION commit (`a526993`), the agent digest (`sha512-eQGRE3ep...`, also identical across all
five) is **not** evidence the inference engine is frozen — it only proves the observer/analyser CLI is
unchanged. The `sourceTarballSha256` identity is what actually establishes that all five ran the same
engine. No repository was repaired against another between runs; all five ran back-to-back against the
one packed source tree.

## ESLint tripwire — PASS, run continued

`eslint/eslint @ 2417cad57` stayed `REFUSED`, citing the identical missing requirement as
`CI_REPRODUCTION_SAMPLE_01` member 1: **a pinned dependency basis (lockfile or `packageManager` field)**.
Independently verified against the pinned head via the GitHub contents API just now:

- `package.json` at `2417cad57d7d1bc4cf3ecf0f0575cfb10ff2011c` has no `packageManager` field
- `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `npm-shrinkwrap.json` all `404`

Per the mechanical table in `docs/ci-reproduction-sample-01.md`, a cited "pinned dependency basis" is
`CORRECT_REFUSAL` iff no committed lockfile **and** no `packageManager` field — both hold. **Reason and
verdict both unchanged.** No stop, no diagnosis needed; the remaining four ran as planned.

## Per-repository raw outcome

| repo | pinned head | before (`CI_REPRODUCTION_SAMPLE_01`) | after (this run) | expected movement | met? |
|---|---|---|---|---|---|
| eslint | `2417cad57` | `CORRECT_REFUSAL` | `REFUSED`, same cited requirement, verified absent | must NOT move | ✅ |
| jest | `9ab14fecc` | `DIVERGED` | `REFUSED` | `REFUSED` or `REPRODUCED` | ✅ |
| webpack | `ebd3be476` | `INCORRECT_REFUSAL` | `REFUSED` | `REFUSED` or `REPRODUCED` | ✅ (category); refusal correctness itself unclassified — see below |
| babel | `3fbcec1cc` | `ENVIRONMENT_INADEQUATE` (engine NOT reached — `make: not found`) | `REFUSED` (engine reached) | qualification becomes *possible* | ✅ |
| babel-loader | `778e7c54d` | `REFERENCE_NON_DETERMINISTIC` | `REFUSED`; reference arm's own `yarn test-only` exited **1** this run | reproducible state, or historical reproduction correctly declared unavailable | see below |

All five raw artifacts (`environment.json`, `reproduction.json`, `execution-receipt.json`,
`ci-reproduce.log`) are preserved unmodified under `docs/evidence/regression-01/<repo>/`, fetched directly
from R2 via `/v1/result` before any of this summary was written.

## Reason changes worth reading in full (not just the verdict)

**jest** — old reason (`docs/ci-reproduction-sample-01-member-2-jest.md`): the engine *claimed*
executability but never ran the suite, because jest's test command is not a `run:` line (an
executable-representation defect). New reason: `REFUSED — test-leak-install-0 (script-34)` is not
executable, a causal-prerequisite gap on an *install* step. This is not the same defect recurring with new
words — it is a different layer of the pipeline now doing the refusing, and the engine no longer claims
false executability for jest.

**webpack** — old reason (`docs/ci-reproduction-sample-01-member-3-webpack.md`, defect 31): the engine
planned the **wrong job entirely** (`test.yml#runtimes-runtimedeno`, a Deno matrix leg) because the real
test job's compound `run:` line (`yarn cover:integration:${{ matrix.part }} ... || yarn ... -f`) has shell
metacharacters `argvOf` rejected, silently erasing the job's TEST purpose. New reason: `basic-install-0`,
`basic-unknown-1`, `basic-unknown-2` — operation ids in what reads as the **correct** job family, refused
for a specific missing script/command resolution rather than mis-attributed to Deno. The job-selection
defect this regression exists to test (defect 31) does not appear to be reproducing; the new refusal has
not yet been classified `CORRECT_REFUSAL` vs `INCORRECT_REFUSAL` against the mechanical table — that
requires reading what `script-83`/`script-84`/the unresolved command actually are in webpack's
`package.json` at `ebd3be476`, not done in this pass.

**babel** — previously never reached the engine (`ENVIRONMENT_INADEQUATE`, `make: not found` at step 3/9).
This run's log shows `reference make -j build-standalone-ci  exit 0  137.4s` — prerequisite 1 (build
toolchain) holds. The engine was reached and refused, citing `test-node-version25-install-0 (script-32)`
plus `actions/download-artifact@v8`, an action this engine does not model. Whether `script-32` is
verifiably absent (`CORRECT_REFUSAL`) or present (`INCORRECT_REFUSAL`) is not yet checked against babel's
`package.json` at `3fbcec1cc`.

**babel-loader** — the determinism gate's verdict for this plan, computed at `5539155` and stated in that
commit's message, is `FLOATING_DEPENDENCIES` (`yarn add -D webpack@5` is a range, not pinned). This run's
own reference arm reproduces the predicted failure live: `yarn test-only` exited `1` today, where the
original historical CI run passed — the gate's prediction held empirically, not just in principle. The
engine's refusal reason (`no workflow job provides TEST`) is a separate, purpose-recognition gap unrelated
to determinism. So this member currently shows *both* things the plan asked to distinguish: the
determinism gate correctly flags the reference arm itself as non-reproducible today, **and** the engine
separately fails to recognize the job's TEST purpose. Neither the "reproducible state" nor a
harness-recorded "historical reproduction unavailable" outcome is fully established — the gate verdict
lives in the `5539155` commit message and `scripts/determinism-gate.ts`, not yet written into
`reproduction.json` or this evidence directory as a first-class field.

## Adjudication — done in a follow-up pass

`CORRECT_REFUSAL` / `INCORRECT_REFUSAL` classification for webpack's, babel's, and babel-loader's new
refusal reasons is complete: [adjudication.md](adjudication.md). Headline: one precisely located regex
defect (`src/ci-inference/infer.ts:56`, confirmed by re-running this session's own inference engine
against fresh pinned-head clones of all three repos) drives the dominant share of jest's, webpack's, and
babel's refusals; babel-loader's refusal traces to a separate, independent gap in test-script-name
recognition. No engine code was changed — adjudication only.

## Not done in this pass

- Recording the babel-loader determinism-gate verdict as data alongside its `reproduction.json`, rather
  than only in prose and the `5539155` commit message.
- Any engine fix. Per direction, changing inference before classifying these refusals would have destroyed
  some of the value of the frozen run; adjudication came first.
