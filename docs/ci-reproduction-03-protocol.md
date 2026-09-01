# FROZEN — INFERENCE_04 / CI_REPRODUCTION_03

**Written before the surviving matrix instances were computed, and before any attempt-3 execution.**

Subject: `jantimon/html-webpack-plugin` @ `cf9c7012`. The other five repositories stay frozen.

## What changed since attempt 2

1. **The execution boundary is enforced** (`885b899`). A non-executable plan now runs **zero** repository
   operations, records a refusal receipt carrying the blocking nodes, and `assertBoundaryHonoured` throws
   if a refused plan is ever seen with execution receipts. Attempt 2's violation cannot recur silently.
2. **Matrix expansion exists** as a general construct:
   `strategy.matrix → concrete assignments → expression substitution → expanded job instances`, with
   `include`/`exclude` represented and unsupported constructs making the affected path non-executable
   rather than being ignored. Each instance keeps its exact assignment and evidence.

## The reference arm no longer omits the matrix step

Attempt 1 and 2 declared an omission of `npm i webpack@${{ matrix.webpack }}`. **That omission is
withdrawn.** If repository CI says the TEST path installs a matrix-selected webpack, faithful
reproduction must instantiate it. Comparing two approximations that drop the same step is what made
attempt 2's agreement near-tautological.

Both arms now execute the **same declared matrix cell**. The arms remain independently constructed: the
*step list* comes from my transcription of the workflow versus the engine's graph. Only the *cell* is
shared, because reproducing a different cell in each arm would compare two different pipelines.

## Which instances count — decided mechanically, before looking

An expanded instance is **IN-ENVIRONMENT** when both hold:

```
its matrix `os` (or the job's runs-on) names ubuntu-*        — the canonical container is Linux
its matrix `node` is absent, or matches the container's major version
```

Everything else is **`OUT_OF_ENVIRONMENT`**: recorded with its assignment, never executed, and **never
counted as a failure**. A `windows-latest` cell is not a defect in DiffCI or in the repository; it is a
cell this environment cannot run. Marking those RED would be the same error as scoring an infrastructure
failure against a repository.

**Reproduction means: every IN-ENVIRONMENT instance reaches an equivalent outcome in both arms.** Not a
selected instance, not the first that works. If no instance is in-environment, the outcome is
`INSUFFICIENT_EVIDENCE` and no reproduction claim is made.

I have deliberately **not** yet computed which of the 28 expanded instances survive this filter. The rule
is fixed first so it cannot be shaped around what happens to pass.

## Outcomes, unchanged

| outcome | meaning |
|---|---|
| **REPRODUCED** | every in-environment instance: both arms materially equivalent, no human repair |
| **PARTIAL_REPRODUCTION** | the known failure is avoided, but the causal path or outcome is not equivalent |
| **REFUSED** | an unresolved causal dependency remains; the inference arm executes nothing |
| **DIVERGED** | executability was claimed and execution shows the graph was wrong or incomplete |

## Fixed in advance

- **Zero human command repair.** If an instance needs a command the engine did not derive, that is a
  refusal or a divergence, not something to hand-write.
- Attempts 1 and 2 are preserved exactly as recorded, including attempt 2's protocol violation.
- If attempt 3 reaches `REPRODUCED`, it is frozen immediately and **inference capability work stops**;
  the next step is `CI_OPTIMIZATION_01` against that baseline.
- Nothing is optimised in this attempt.
