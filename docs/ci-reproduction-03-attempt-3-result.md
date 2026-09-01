# CI_REPRODUCTION_03 attempt 3 — INFRASTRUCTURE / EXECUTION_BOUND_EXCEEDED

Completed at **41 minutes**, four minutes inside the frozen 45-minute deadline. So it is evaluated
normally, per the frozen rule. Evaluating it normally is what exposed a defect in the evaluator.

## The harness said DIVERGED. The harness was wrong, not the engine.

`classify` returned:

> `DIVERGED — neither arm executed a suite, so no reproduction can be claimed`

Both arms' test steps show:

```
exit null    cpu 0.0s    wall 1_200_013 ms   (reference)
exit null    cpu 0.0s    wall 1_200_107 ms   (inference)
```

`1_200_000 ms` is **20 minutes**: the harness's own `timeoutMs` default in `scripts/ci-reproduction.ts`.
Both suites were killed by *my* execution ceiling. Nothing about the engine's graph was shown to be
wrong. Calling that `DIVERGED` charges a harness limit to the graph — `unknown ≠ negative`, the rule this
project keeps re-learning, this time **compiled into the scorer**, where it is worse than a human slip
because it would apply silently to every future run.

The correct classification is **`INFRASTRUCTURE / EXECUTION_BOUND_EXCEEDED`**. Not `DIVERGED`, not
`REFUSED`, not a repository failure.

## What attempt 3 did establish — and it is not nothing

Both arms were constructed independently: the reference arm from my transcription of the workflow, the
inference arm from the frozen `ExecutionGraph`, with the engine never consulted for the former. They
produced **identical command sequences**:

| # | command | reference | inference |
|---|---|---|---|
| 1 | `npm ci --legacy-peer-deps` | exit 0, 22.7s cpu | exit 0, 13.9s cpu |
| 2 | `npm i webpack@ --legacy-peer-deps` | exit 0, 4.9s cpu | exit 0, 4.5s cpu |
| 3 | `npm run test:coverage -- --ci` | killed at 20 min | killed at 20 min |

The engine independently derived, with no per-repository patching:

- `npm i webpack@` — the **`UNDEFINED_CONTEXT`** rendering, because the workflow reads
  `matrix.webpack-version` while the matrix declares `webpack`. The engine reached GitHub's coercion
  from its own semantics rather than from a special case.
- the omission of `git config --global core.autocrlf input`, whose `if:` evaluates **FALSE** on
  `ubuntu-latest` — declared, evaluated, not executed, and recorded as such rather than deleted.
- `build-node22.x-osubuntu-latest-webpacklatest` as the TEST-providing job, via `planForPurpose`, with
  no `primaryJob` collapse.

Install succeeded in both arms. The TEST path was executable and executed. **Reproduction itself remains
unproven** — no suite verdict exists in either arm, so no reproduction claim is made.

## The suspect is exonerated

I recorded `npm i webpack@ --legacy-peer-deps` as a *suspect, not a cause*, and said the instrumentation
should settle it rather than me. It did: **4.88s and 4.54s**. It is not responsible. Had I asserted that
hypothesis when I formed it, I would have written a confident and wrong explanation into the record.

The real cause is mundane: `html-webpack-plugin`'s suite compiles webpack repeatedly and needs more than
20 minutes. It was **alive and emitting test output** when killed — not hung.

## Defects recorded

**Defect 23 — the scorer charges harness limits to the graph.** `classify` asked *whether* a suite ran
and never *why not*, so a timeout kill and a graph that genuinely never runs a suite produced the same
label. Fixed: `INFRASTRUCTURE` is a fifth outcome, checked **first**; `terminatedByBound` and
`outcomeLayer` are recorded structurally at the step rather than inferred later from `exitStatus === null`
(which also means "signalled for some other reason"). `tests/scripts/infrastructure-not-divergence.test.ts`
is behavioural — it calls `classify` — and was verified to **fail without the fix**, with two control
tests confirming genuine `DIVERGED` and `REFUSED` still survive.

**Defect 24 — receipts existed only after the child exited.** For 41 minutes there was no way to tell
which of six operations was live. The one situation where progress mattered was the one with no record.
Fixed: `ProgressLog` appends a JSONL line at every operation boundary — `stepId`, `arm`,
`commandIdentity`, `startedAt`, `endedAt`, `exitStatus`, `terminatedByBound`, `outcomeLayer`, cpu/wall —
using `appendFileSync` per line, deliberately, since a buffered writer would hold exactly the records
that matter when a run has to be killed.

Both belong to the failure class this laboratory has now recorded several times: **controls that are
correct code in an unreachable or unexamined position.** Defect 19, the misplaced collector, and now a
scorer that never asked why.

## What changes for attempt 4, and what must not

Changed — **harness infrastructure only**:

- the execution bound: 20 → 90 minutes
- durable per-operation receipts
- the corrected classifier

Unchanged, deliberately: **inference, commands, matrix scope, environment, protocol.** The reference plan
is byte-identical. Attempt 4 asks the same reproduction question attempt 3 asked; only the instrument
changed. Touching any of those would confound reproduction with instrumentation.

Attempt 3 is preserved exactly as recorded, including its incorrect auto-assigned `DIVERGED` field — the
evidence file is not edited to match the corrected verdict.
