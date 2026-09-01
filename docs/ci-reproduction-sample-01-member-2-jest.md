# Sample member 2 — `jestjs/jest` @ `9ab14fecc` — **DIVERGED**

R3 qualified. The reference arm ran clean: `corepack enable` → `yarn --immutable` (70.6s) → `yarn build:js`
(16.4s) → **581 tests, 0 failures** (38.1s), matching CI ground truth `success`. `${CPU_CORES}` resolved
to `4` and is recorded in the receipt.

Then the engine, on first exposure, produced:

```
DIVERGED — the engine claimed executability but its graph never runs the suite:
reference executed a suite (581 tests in 40 files) and the inference arm executed none

testPlan.jobId      = issues.yml#bug-without-repro
testPlan.executable = true
inference arm steps = 0
```

It selected an **issue-closing workflow** as jest's test pipeline, declared the plan **executable**, and
executed **nothing**. This is a real DiffCI defect — three of them, chained — not an artefact of the
experiment.

## Why the real test job was invisible

`nodejs.yml#test-runtime-vm-modules-node-version22.x` **was** inferred, and the matrix expanded correctly
into all six node versions. But it reports `provides: ["INSTALL"]` — no TEST.

The reason is the one Amendment 1 anticipated before this ran: jest's test command is not a `run:` line.
It is a string under `with:` of `nick-fields/retry`. `workflowFacts` collects `workflow.step.run` facts,
so the command never becomes an operation, so the job never provides TEST. **Of 34 inferred jobs, exactly
one provided TEST — and it was the wrong one.**

## Defect 28 — operation kind matched a substring inside prose

`src/ci-inference/infer.ts:63`

```js
if (/\b(jest|vitest|mocha|ava)\b/.test(line)) return "test";
```

applied to the whole command line, including a URL inside a `--comment` argument:

```
gh issue close $ISSUE --comment "As noted in the [Bug Report template](https://github.com/jestjs/jest/…)"
```

Verified directly: the regex matches, on the `jest` in `jestjs/jest`. **An issue-closing command was
classified as a TEST operation because its comment text links to the project's own repository.**

For a product this is not a curiosity. It means DiffCI can mistake a triage workflow for the test
pipeline of the repository it is being paid to optimise.

## Defect 29 — `UNRESOLVED` collapsed into `FALSE`

`src/ci-inference/infer.ts:223`

```js
const willExecute = condition ? condition.result === "TRUE" : true;
```

`expression.ts` is explicit that this must not happen:

> `if:` evaluates to TRUE / FALSE / UNRESOLVED. **UNRESOLVED is not FALSE.** Treating an unreadable
> condition as "step does not run" would silently drop operations from a pipeline, which is the same
> unknown-as-negative error this project has recorded repeatedly.

The module that defines the three-valued result is careful. The consumer one file away collapses it to
two. **The invariant is documented in one file and violated in the next** — which is worse than never
having stated it, because the statement makes the code look checked.

Here the step's `if:` is `github.event.label.name == 'Needs Reproduction'`. The `github` context is not
modelled → `UNRESOLVED` → silently `willExecute = false`.

## Defect 27 — a plan of entirely non-running steps called executable

`src/ci-inference/jobs.ts`

```js
const blocked = path.filter((o) => !o.executable && o.willExecute !== false);
return { executable: blocked.length > 0 ? false : path.length > 0, … };
```

The single operation in the path was `executable: false, willExecute: false, command: []`. Because
`willExecute === false` excludes it from `blocked`, `blocked` was empty, and `path.length > 0` made the
plan **executable**.

So a plan every one of whose steps will not run is reported as executable. The `willExecute` exclusion
was correct for *skipping a step*; it was never checked against *a path with nothing left*.

This is the mirror image of the attempt-2 boundary violation. There, a refused plan executed operations.
Here, an executable plan executes none. `assertBoundaryHonoured` catches only the first direction.

## Classification

**`DIVERGED`**, per the frozen vocabulary: executability was claimed and execution showed the graph wrong.

Not `CORRECT_REFUSAL` — the engine did not refuse. It asserted. That distinction is the whole point of
separating the two labels: a system that says "I cannot account for this" is safe, and a system that says
"I have a plan" and then runs nothing is not.

## The defects are recorded and NOT fixed yet — deliberately

Fixing the engine now would mean members 1–2 ran against a different engine from members 3–5, and the
distribution would no longer be a distribution of anything. The sample completes on the **frozen** engine.

Per the frozen terminal rule, `DIVERGED` is an engine defect to be fixed **before any optimisation
claim** — after the sample, not during it.

## What member 2 contributes

- jest's CI is **not addressable by reading the repository**: its test command lives inside a third-party
  action's arguments. Amendment 1 predicted this before the run.
- The engine does not merely fail to find that command; it **substitutes a wrong job and asserts
  confidence**. Refusal would have been the safe behaviour and did not happen.
- Two of the three defects (27, 29) are *unknown-as-negative* again, in new clothes.
