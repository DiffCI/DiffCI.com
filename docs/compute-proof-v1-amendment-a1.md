# COMPUTE_PROOF_V1 — amendment A1, and the comparator question

```
COMPUTE_PROOF_V1 amendment A1

Discovered after mechanical commit selection, before any DiffCI observation.

Problem:
  The selected commit modifies only implementation belonging to a package
  explicitly excluded from the experiment's full-suite test command.

Amendment:
  A qualifying change must modify implementation within the declared
  execution scope of the full-suite comparator.

Reason:
  Changes outside comparator scope have zero optimization opportunity by
  construction and cannot test the registered compute-savings hypothesis.

Previous draw:
  6f5bf24d — retained in record, disqualified by A1.

DiffCI result inspected:
  NO
```

The amendment is deliberately **general**, not `packages/website`-specific. The precondition it encodes:

```
Opportunity = C_full(code potentially affected by the change) > 0
```

If the comparator executes no tests for a package, there is no test compute for DiffCI to avoid, and
running the experiment there measures nothing about DiffCI.

This is the same class of correction as widening `path.startsWith("src/")`: a defect in the
experimental eligibility definition, found from repository configuration, with **no outcome observed**.
The disclosure trail is `1b84b07` sealed rule → mechanical selection → scope mismatch discovered → no
DiffCI observation → amendment → re-selection. It is experimental-design housekeeping and counts as
evidence neither for nor against DiffCI.

## The comparator command is NOT resolved, and substitution is not warranted

Before drawing another commit, the repository must pass `twoGreenBaselines`. That requires knowing what
the full suite *is* — and for typescript-eslint the two candidate commands are **not semantically
equivalent**.

**Documented command:** `nx run-many -t test --exclude integration-tests website website-eslint`

**Direct alternative:** root `vitest.config.mts`, whose `projects` are
`packages/*/vitest.config.mts`, minus `website`, `website-eslint`, `types`, plus `tools/vitest.config.mts`.

Measured from the repository:

| | nx `test` target | root `vitest run` |
|---|---|---|
| packages with a `test` script | 16 | — |
| packages with a `vitest.config.mts` | — | 16 |
| `integration-tests` | **excluded** | **included** |
| `types` | included | **excluded** |
| `tools/` | not a `packages/` project | **included** |
| effective projects | **15** | **16** |

They differ in **three** places, in both directions. `integration-tests` is the material one: the
repository deliberately excludes it from `test`, and the root vitest config pulls it in.

So substituting `vitest run` would **redefine the full suite for convenience** — precisely what must not
happen, since the comparator's cost is the denominator of the entire economic claim. Inventing a
`--project` exclusion list to reconcile them is equally disallowed: the corpus rule is that no file
filters or exclusions are invented, and each earlier target used a command the repository itself
documents.

## What happens next, mechanically

1. Qualify typescript-eslint against its **own documented command**, `nx run-many`, in the canonical
   container. Not a substitute chosen because an orchestrator is inconvenient.
2. If it produces two green baselines, the repository is fully qualified and the amended selector draws
   the first in-scope change.
3. If it does not, it **fails the registered requirement and the rule advances to `jestjs/jest`** — no
   debugging to keep it selected, unless the failure is clearly a harness defect already covered by the
   qualification rules.

An orchestrator is a known hazard here rather than a novel one: defect #5 was `tanstack-qualify-02`
parsing a passing summary out of a non-zero nx run and producing a **false green**, which is why
`classifyExecution()` and `CONTRADICTORY_EXECUTION_EVIDENCE` exist. That machinery is frozen and will
decide this on its own terms.

## Denominator bookkeeping, to be recorded in the proof run

`99.7%` is repository-level structural mapping. If the comparator covers only part of the repository,
the mapped-test numerator and the executed-test denominator describe different populations. The proof
run therefore records all of:

```
repository test universe
comparator test universe

repository mapped tests
comparator-scope mapped tests

mapping density within comparator scope
```

No new eligibility threshold is introduced — the pre-registration does not require one. The measurement
is preserved so the eventual denominator is unambiguous.
