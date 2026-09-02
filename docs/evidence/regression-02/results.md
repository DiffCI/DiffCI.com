# SEMANTIC_REPAIR_02 phase 1 — real regression checks (jest, babel) + webpack side-effect check

Executed 2026-09-02 against `878c470` (the shared package-manager command classifier,
`docs/semantic-repair-02-plan.md`). Source repacked fresh (`sources/diffci-c63731bb516512d4.tgz`,
sha256 `c63731...9fb8ba`) — different from `REGRESSION_01`'s tarball by design, since the source changed;
agent tarball unchanged (`agents/observer-ee639e1ac7e1a81b.tgz`), confirming again that the agent bundle
does not include `src/ci-inference` and is not evidence of engine identity by itself (per the
`a526993` CORRECTION). Raw artifacts under `docs/evidence/regression-02/<repo>/`, fetched before this
summary was written, same discipline as `REGRESSION_01`.

## Babel — the negative-regression check, confirmed exactly as pre-registered

```
inference  REFUSED - executed nothing: TEST EXISTS but 1 causal prerequisite(s) could not be established:
  artifact-0-actions/download-artifact@v8 (babel-artifact) (this step uses actions/download-artifact@v8,
  which this engine does not model, so what it contributes is unknown)
```

The phantom `script-32` edge (`yarn install` misread as a script call) is gone from the reason string
entirely. The refusal persists, citing only the genuine, previously-identified cross-job artifact
dependency. This is the exact outcome `semantic-repair-02-plan.md` pre-registered: **fewer blockers, same
refusal** — not a regression, the correct result.

## Jest — not a clean confirmation. A real execution surfaced a second, distinct defect.

The plan's own language anticipated this honestly: "genuine outcome — `REPRODUCED`, `DIVERGED`, or a
*different* refusal — determined by execution, not assumed." The phantom block did clear and the plan did
execute — but the result is `PARTIAL_REPRODUCTION`, not a clean pass:

```
OUTCOME  PARTIAL_REPRODUCTION
both arms ran a suite but they are not equivalent: reference 581/0 vs inference 746/0
```

`testPlan.jobId` is `nodejs.yml#test-leak`; `referenceArm.source` names job `test-runtime-vm-modules`
(the job the reference plan transcribes and the one CI ground truth measures). **DiffCI ran the wrong
job** — it executed cleanly (746 tests, 0 failures) and reported an honest, correctly-labelled
`PARTIAL_REPRODUCTION` rather than a false `REPRODUCED`, so nothing here is a safety failure — but the
plan does not correspond to what was asked.

Traced why `test-runtime-vm-modules-node-version22.x` shows `provides: ["BUILD", "INSTALL"]` — no
`TEST` — while `test-leak` correctly shows `TEST`: the reference job's real command is
`yarn jest-runtime-vm-modules-ci --max-workers 4`, whose script body is itself another script
(`jest-runtime-vm-modules`), whose body is:

```
NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn jest packages/jest-runtime
```

This line has a leading `KEY=value` assignment before the package-manager invocation, and **neither path
in `purposeOfLine` currently handles it**:

- `executableChain` skips the `NODE_OPTIONS=...` token correctly (`ASSIGNMENT` test), reaches `yarn` —
  but `yarn` is not itself in `EXECUTABLE_PURPOSE`, and unlike `nyc`/`node`/etc. it is not in
  `COMMAND_WRAPPER` or `INTERPRETER` either, so the chain stops there without a purpose.
- The package-manager branch (`packageManagerCommand`, keyed on `firstCommandTokens(line)[0]`) never
  gets a chance — `head` is the raw first token of the line, which is `NODE_OPTIONS="..."` itself, not
  `yarn`. Assignment-prefix stripping only happens inside `executableChain`, not before the
  package-manager check.

This is a genuinely new, distinct, third defect from anything `regression-01/adjudication.md` named —
call it the **assignment-prefixed package-manager invocation gap**. It is not the phantom-script defect
(already fixed and confirmed absent here), not babel-loader's naming-policy question (a different file,
a different mechanism), and not quite webpack's `WRONG_JOB_TARGETED` either: webpack's planner picked the
wrong job from among several *valid* TEST-providing candidates via a tie-break heuristic; here the
*correct* job never becomes a candidate at all, because its TEST step is invisible to purpose
classification. The visible *effect* — a plan aimed at a job other than the one being measured — is the
same shape as webpack's, but the cause is a purpose-recognition gap, structurally closer to
babel-loader's finding than to webpack's.

**Not fixed here.** This is reported, not repaired, per the same discipline `semantic-repair-02-plan.md`
applied to babel-loader: state what's actually broken before changing anything. Whether to fold this into
the still-open naming-policy design work, treat it as a fourth prerequisite question, or scope it
separately is a decision for the next freeze, not this one.

## Webpack — side effect check (not scored, reported as required)

Re-ran the same local classification pass against webpack's pinned head. `basic-install-0` and
`basic-unknown-2`'s phantom blocks (`script-83`, `script-84`) are both gone. `planForPurpose` still
selects `test.yml#basic` — blocked-operation counts dropped roughly proportionally across every
in-environment `TEST` job (e.g. `basic` 3→1, `integration-*-22.x-parta` 10→4), so the tie-break outcome
did not change. `basic` still refuses — now for exactly one reason, the genuine `||` in
`yarn link --frozen-lockfile || true` that `argvOf` correctly can't turn into safe argv. No job-selection
side effect occurred; `WRONG_JOB_TARGETED` remains untouched, as the frozen plan required.

## Reading this phase

The classifier fix did exactly what it was built to do — verified twice, once locally and once for real:
babel's negative-regression check passed without qualification. Jest's did not pass cleanly, and that is
useful, not a failure of the fix: fixing the phantom block was a precondition for jest's plan to execute
at all, and only by letting it execute did the wrong-job problem become visible. Before this phase, jest
was uniformly `REFUSED`, which is safe but uninformative about what else might be wrong. This is the same
pattern the plan predicted for babel in the other direction (a refusal that should *survive* a fix) —
here, execution that should *not* yet be trusted, surfacing a defect that could not have been found any
other way with this harness.
