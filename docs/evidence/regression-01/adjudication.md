# REGRESSION_01 — mechanical adjudication of webpack, babel, babel-loader

No engine change made in this pass — adjudication only, per direction. `git status` on this repo is clean
throughout; all verification ran against fresh shallow clones of the three target repos at their pinned
heads, in a scratch directory outside this repo.

## Method

`reproduction.json` never serialises the reference-graph node list (`InferredPipeline.references`,
`src/ci-inference/schema.ts:214`) — only operation-level `blockedBy` id arrays. So a cited id like
`script-83` cannot be read back out of the evidence artifact; it has to be re-derived. `resolveScript`
(`src/ci-inference/resolve.ts:24-33`) resets its id counter once per `inferPipeline()` call and is
otherwise a pure function of repository content, so re-running `collectEvidence` + `inferPipeline` — this
session's own unmodified source, current HEAD `a526993` — against a git clone pinned to the exact head SHA
reproduces byte-identical ids to what the container run saw. Did this for all three repos (plus a
confirmation run against jest, whose refusal reason has the same shape). No network calls except the git
clones themselves; no source or dependency was installed or built.

## Finding, stated once because it explains three of the four refusals

**`src/ci-inference/infer.ts:56`** gates when the engine treats a rendered command line as a script
invocation:

```ts
const SCRIPT_RUN = /^(npm run |yarn (run )?|pnpm (run )?|bun run )([A-Za-z0-9:_-]+)/;
```

For `yarn`, the `run` keyword is optional — correctly, since `yarn <script>` is real yarn shorthand. But
the regex does not exclude yarn's own CLI flags or built-in subcommands from the captured group, and
`[A-Za-z0-9:_-]+` matches all of them: `--frozen-lockfile`, `--immutable`, `install`, `link`. Every one of
those gets passed to `resolveScript()` (`resolve.ts:71`), which correctly reports "package.json declares
no script named X" — a true statement about an irrelevant question, because none of these lines were ever
invoking a script.

**This is not this file's only classifier.** `src/ci-inference/purpose.ts:150-156` already handles the
distinction correctly and explicitly, with a comment naming the exact commands this finding is about:

```ts
// A package manager with NO non-flag argument is a bare install: `yarn` and `yarn --immutable` both
// install, which is how jest and babel-loader begin. Requiring a subcommand missed them.
const sub = rest.find((t) => !t.startsWith("-"));
if (sub === undefined || INSTALL_SUBCOMMAND.test(sub)) { ... return purpose: "install" ... }
```

`INSTALL_SUBCOMMAND = /^(ci|install|i|add|up|upgrade)$/i` (`purpose.ts:75`) is consulted by the purpose
classifier and never by the reference-graph gate at `infer.ts:56`. Two call sites answer "is this a
script?" for the same line with two different, disagreeing rules. `purpose.ts` is right; `infer.ts:56` is
the one that produced every phantom `script-N` block below. `link` isn't even in `INSTALL_SUBCOMMAND` — a
bare `yarn link <pkg>` falls through purpose.ts to `unknown`/`NONE` (correctly, since purpose.ts never
calls `resolveScript` for it either) — so `infer.ts`'s gate is the only place that manufactures a "script
named link" question nobody asked.

### Confirmed identically in three repos

| repo | operation | line | phantom id | `resolveScript` verdict |
|---|---|---|---|---|
| jest | `test-leak-install-0` | `yarn --immutable` | `script-34` | `identifier: "--immutable"`, `package.json declares no script named "--immutable"` |
| webpack | `basic-install-0` | `yarn --frozen-lockfile` | `script-83` | `identifier: "--frozen-lockfile"`, same reason shape |
| webpack | `basic-unknown-2` | `yarn link webpack --frozen-lockfile` | `script-84` | `identifier: "link"`, `package.json declares no script named "link"` |
| babel | `test-node-version25-install-0` | `yarn install` | `script-32` | `identifier: "install"`, `package.json declares no script named "install"` |

Every one of these operations has `missingRequirements: []` and every one of its own
`requirementChecks` (`DEPENDENCY_BASIS_PINNED`, `COMMAND_RESOLVED`, `WORKING_DIRECTORY_KNOWN`) satisfied —
the block comes **only** from `blockedBy`, i.e. only from this one gate.

**Classification: `INCORRECT_REFUSAL`, but not the shape the mechanical table's existing rows describe.**
The table (`docs/ci-reproduction-sample-01.md`) asks "is the cited requirement present?" — here the cited
requirement ("a script named `--immutable`") is genuinely absent, exactly as claimed, so the citation is
technically true and still wrong: it is not a real prerequisite of the operation. The table's rows all
assume the citation is at least about a real dependency; this is a fabricated one. Worth a sixth row.

## jest — the phantom block is the *only* thing wrong

`test-leak-install-0`, `-build-1`, `-test-2` — install is blocked solely by `script-34`; build and test
are both already `executable: true`, `blockedBy: []`. This is the cleanest case: nothing else on the path
is broken. `INCORRECT_REFUSAL`, single cause, fully identified.

## babel — one phantom block, one separately legitimate one

`test-node-version25-install-0` is blocked solely by the same phantom (`script-32`). But the refusal names
a *second*, independent prerequisite: `artifact-0-actions/download-artifact@v8 (babel-artifact)`, "this
engine does not model." Checked against `.github/workflows/ci.yml` at the pinned head: a separate `build`
job (`needs: prepare-yarn-cache`) runs `make -j build-standalone-ci` and does
`actions/upload-artifact@v7 name: babel-artifact` (line ~100); `test-node-version25`
(`needs: build`, confirmed by job structure) downloads that same artifact via `actions/download-artifact@v8`
before running `jest`. The artifact is genuinely `lib/**` — babel's compiled packages — which the test
suite imports. **This citation is real and correctly scoped**: DiffCI infers one job at a time and has no
model of a cross-job `upload-artifact`/`download-artifact` handoff, so it cannot claim to know the test
job's tree is complete without that hop. `CORRECT_REFUSAL`-shaped, though — like the marketplace-action row
already missing from the mechanical table — not one of the table's five existing rows (those cover *local*
actions and reusable workflows, not a third-party marketplace action's cross-job artifact contribution).
Recommend a row for it rather than adjudicating by analogy.

Net effect: fixing the `infer.ts:56` gate removes the false half of babel's refusal, but babel would very
likely still correctly refuse — for the one legitimate reason — afterward. The reference arm's own
transcription (`docs/evidence/ci-reproduction-05-babel-reference-plan.json`) sidesteps this by hand-
flattening `build` and `test-node-version25` into one linear script, which is a fine way to ask "would
these steps in sequence reproduce the outcome" but is a different question from what the engine's
job-respecting model is answering. Worth naming, not fixing here.

## webpack — same gate defect, but not sufficient by itself, and not even the right job

Three things are true at once and need to stay distinguishable:

**1. Defect 31 (the compound-`||`-erases-purpose defect this regression exists to test) does not
reproduce.** All 39 `integration-*` job instances now correctly carry `provides: ["INSTALL", "TEST"]` — a
year — a run before the repair they lost TEST entirely (`docs/ci-reproduction-sample-01-member-3-webpack.md`).
Re-confirmed locally: `integration-osubuntu-latest-node-version22.x-parta` (the specific cell the reference
plan reproduces, matching CI ground truth `integration (ubuntu-latest, 22.x, a)`) now shows
`10 blockedOps / 17 totalOps` — blocked, but present, structured, and carrying TEST purpose. Layer 3/4
repaired what they targeted.

**2. The plan does not target that job.** `planForPurpose` (`src/ci-inference/jobs.ts:104-116`) is
explicitly, deliberately not a ground-truth matcher:

> "Deterministic: among jobs that provide the purpose, the one with the fewest blocked operations wins;
> workflow-then-job order breaks ties. Preferring the least-blocked job is not a quality judgement about
> the repository — it is choosing the path this engine can actually account for."

Among 39 `TEST`-providing in-environment jobs, `test.yml#basic` has the fewest blocked operations
(3 of 4) and wins. The reference arm — and CI ground truth — ran `integration`, never `basic`. This is not
a bug in the sense the other three findings are; it's a documented policy that was never designed to
answer "does DiffCI's plan match the specific job this comparison measures," and this regression is the
first time that gap has been exercised end to end. It does not fit `CORRECT_REFUSAL` / `INCORRECT_REFUSAL`
at all — the refusal is about the wrong job entirely, so adjudicating whether *its* citation is correct is
answering a question the ground-truth comparison never asked. Flagging as its own category:
**`WRONG_JOB_TARGETED`**, distinct from a requirement-correctness question.

**3. Within `basic` itself, one of its two blockers is the phantom (`script-83`), the other is real.**
`basic-install-0` is blocked only by `script-83` — same phantom defect as jest and babel.
`basic-unknown-2` is blocked by `script-84` (`identifier: "link"`) — also phantom.
`basic-unknown-1` (`yarn link --frozen-lockfile || true`) is blocked by a **genuine** `COMMAND_RESOLVED`
failure: the line contains `||`, which `argvOf` (`infer.ts:70-77`) correctly refuses to interpret without
a shell. Real CI treats this exact step as `allowFailure: true`
(`docs/ci-reproduction-sample-01-member-3-webpack.md`) — webpack's own `|| true` is its guard for that. The
engine does not model shell control flow at all, so it cannot see that the failure branch is intentionally
harmless; this is a known, stated scope limitation, not a bug, and `path` in `planForPurpose` (`jobs.ts:120-122`)
includes every operation up to the last TEST-purpose operation in job order regardless of whether it is
truly a causal predecessor — so `basic-unknown-1` blocks the plan even once the phantom blocks are
subtracted. **Fixing the `infer.ts:56` gate would not, by itself, make `basic` executable**, and even if it
did, reaching `REPRODUCED` there would be exactly the plan's stated worse-than-refusal failure condition
("a plan that still names the wrong job"), because `basic` is not `integration`.

## babel-loader — a third, independent, previously unadjudicated defect

Not the same defect as the other three, and not downstream of `FLOATING_DEPENDENCIES` either — this one
is prior to and independent of the determinism question. `yarn test-only` (babel-loader's real test step,
`package.json`: `"test-only": "node --test test/**/*.test.js"`) classifies as `kind: "unknown"`, so **no
job in the pipeline provides `TEST` at all** (`provides: ["BUILD", "INSTALL"]` on every job) — exactly
matching the refusal `"no workflow job provides TEST"`.

Traced why, in `purpose.ts`: `purposeOfLine("yarn test-only", ...)` resolves the script, gets its body
(`node --test test/**/*.test.js`), and tries that body first (`SCRIPT_BODY` basis) — `node` isn't in
`EXECUTABLE_PURPOSE` and neither is `--test` handled as marking Node's built-in test runner, so the body
resolves to `unknown`. It then falls back to the script's own declared **name** (`SCRIPT_NAME` basis,
`purpose.ts:75-81`):

```ts
const SCRIPT_NAME_PURPOSE: Array<[RegExp, OperationPurpose]> = [
  [/^test(:|$)/i, "test"],
  ...
```

`/^test(:|$)/i` matches `test` and `test:anything` — the colon-namespace convention — but not
`test-only`, `test-unit`, or any hyphen-namespaced name, an equally common npm convention. No test in
`tests/ci-inference/purpose.test.ts` exercises a hyphenated test-script name (colon form is covered at
line 59-66); this reads as an untested gap rather than a deliberate exclusion.

**Classification: `INCORRECT_REFUSAL`, and it is entirely orthogonal to the determinism-gate finding.**
Even if `webpack@5`'s range resolution were pinned and the reference arm passed clean today, DiffCI would
still refuse babel-loader, for this reason alone. Fixing either half independently would resolve it:
broadening `SCRIPT_NAME_PURPOSE`'s test pattern to match hyphenated names, or adding Node's native
`--test` runner to `EXECUTABLE_PURPOSE`.

## Summary

| repo | refusal driven by | classification |
|---|---|---|
| jest | `infer.ts:56` phantom script gate (sole cause) | `INCORRECT_REFUSAL` |
| webpack | phantom gate (2 of 3 blockers) + one genuine shell-metachar block + wrong job targeted | `INCORRECT_REFUSAL` on the phantom component; `WRONG_JOB_TARGETED` as a separate, undecided axis; not adjudicable as simply correct or incorrect until job selection is addressed |
| babel | phantom gate (install) + genuine unmodeled cross-job artifact dependency | `INCORRECT_REFUSAL` on the phantom component; the artifact citation is `CORRECT_REFUSAL`-shaped but not covered by the existing table rows |
| babel-loader | untested gap in test-script-name recognition (hyphenated names) | `INCORRECT_REFUSAL`, independent of the `FLOATING_DEPENDENCIES` finding, which remains correct and separate |

One regex gate (`infer.ts:56`) is responsible for the dominant share of "new" refusal reasons across three
repositories — a single, precisely located, cheaply verifiable defect, not four unrelated ones. It was not
introduced by SEMANTIC_REPAIR_01's six layers (`purpose.ts`'s correct handling of the same inputs predates
this regression and was not touched by it) — it predates the repair and was simply never on a path that
got exercised until this rerun reached these repositories' real `yarn` install lines.

No fix applied. This document is adjudication evidence only, per the instruction that changing inference
before classifying these refusals would destroy the value of the frozen run.
