# AMENDMENT 1 to CI_REPRODUCTION_SAMPLE_01

**Written after reading jest's workflow, and BEFORE running any inference against jest or any other
sample member.** No engine output for jest, webpack, babel or babel-loader exists at the time of writing.

Reading a workflow is what the frozen protocol requires in order to transcribe a reference plan. Reading
it revealed two structures the frozen verification table does not cover. Extending the table **now**,
from workflow structure alone, keeps the grading rule prospective. Extending it *after* seeing a refusal
would be grading my own engine's output after the fact, which is the thing the table exists to prevent.

## What jest's ground-truth cell actually contains

`nodejs.yml`, job `test-runtime-vm-modules`, node 22.x, ubuntu-latest:

```yaml
- name: Get number of CPU cores
  id: cpu-cores
  uses: SimenB/github-actions-cpu-cores@9733087…      # third-party action

- name: run jest-runtime tests with --experimental-vm-modules
  uses: nick-fields/retry@ad98453…                    # third-party action
  with:
    command: yarn jest-runtime-vm-modules-ci --max-workers ${{ steps.cpu-cores.outputs.count }}
```

The test command is **not a `run:` line**. It is a string argument to a third-party action, and its
`--max-workers` value is the **output of a different third-party action**. Neither is resolvable by
reading the repository.

## Table extension — two new verifiable rows

| cited requirement | verification |
|---|---|
| **step-output reference** (`steps.<id>.outputs.<name>`) | the workflow declares step `<id>` with a `uses:` the engine cannot execute, so the value cannot be derived from the repository |
| **command nested in a third-party action** | the step has no `run:`; its command appears under `with:` of a `uses:` step |

Both are mechanically checkable against the workflow file, so a refusal citing either is **falsifiable**
and can be graded `CORRECT_REFUSAL` on the same terms as the original rows. The default-to-
`INCORRECT_REFUSAL` rule still applies to anything neither table can check.

## Reference-arm substitution, disclosed rather than hidden

The reference arm must be an *independent transcription of what CI runs*. CI runs
`yarn jest-runtime-vm-modules-ci --max-workers <cores>`, where `<cores>` is the runner's CPU count —
the sole documented function of `SimenB/github-actions-cpu-cores`.

So the reference plan substitutes the **container's own core count** and records that substitution
explicitly, with this justification, in a `substitutions` field.

**This is a privilege the engine does not have**, and it must not be quietly enjoyed:

- The substitution is recorded in the plan, not buried in a command.
- If the engine refuses on `steps.cpu-cores.outputs.count`, that refusal is graded against the table row
  above — **`CORRECT_REFUSAL`** — and is *not* counted against DiffCI merely because I could resolve by
  hand what the engine correctly would not.
- A reference arm that needs a substitution **not** justifiable this way (a value the workflow neither
  states nor derives from a documented action) remains a qualification failure, not something to invent.

## Why not simply drop jest

Declaring jest unusable would quietly shrink the sample to four and remove a member specifically because
it is hard — the same selection pressure the whole-sample freeze exists to eliminate. jest stays in, with
its difficulty recorded rather than avoided.

That difficulty is itself a product finding: **jest's test command is not reachable by reading the
repository.** Any tool promising to optimise jest's CI has to solve that, and a tool that pretends
otherwise is guessing.
