# unknown ≠ negative

A standing invariant for every DiffCI outcome label, and for anything later trained on them.

## The labels, and what each means

| label | meaning | what it is NOT |
|---|---|---|
| `NOT_REACHED` | a declared control never executed | not "the control passed", not "no control existed" |
| `NO_VERDICT` | the run produced no repository outcome | not RED |
| `INFRASTRUCTURE` | platform, container, harness or registry failure | not a property of the repository |
| `UNREGISTERABLE` | the rule could not determine commands, and refused | not RED, not "the suite failed" |
| `RECALL_UNMEASURABLE` | the mutation did not change suite behaviour | not "DiffCI missed it", not "DiffCI caught it" |
| `REFUSED` | DiffCI declined to propose a selection | not a failed analysis |
| `RED` | the repository's own install, build or suite failed | — |

**Each stays distinct. None collapses into another for convenience.**

## Why this is load-bearing rather than tidy

Every near-miss in the frame-continuation traversal was a collapse of exactly this kind, and each would
have removed an eligible repository for a reason with no substance:

- `lint-staged` was `UNREGISTERED` because the registry had no entry — an apparatus gap that would have
  read as RED.
- Five repositories looked to have "absent" head shas; the evidence existed and the allowlist assumed a
  two-digit rank (defect 21).
- Rank 116 looked unresolvable because *I* used the wrong filename separator.
- `jest-dom` then failed four times before executing any repository code — `INFRASTRUCTURE`, four times,
  and never RED.

A retry-count-based exclusion would have converted that last one into ineligibility through exhaustion.
It does not exist and must not be added.

## The consequence for the learning system

A model trained on collapsed labels learns false causation: that a repository is unsafe because a
container was updated mid-run, or that work was unnecessary because a lockfile was missing. Those rows
are labelled by layer (`outcome.layer` on every execution receipt) and either trained separately or
excluded from impact modelling entirely.

`NOT_REACHED` is **data**. An empty field is not.

Reliability data and impact data are both worth learning from — with different models and different
objectives. They are never worth merging.
