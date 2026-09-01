# AMENDMENT 2 to CI_REPRODUCTION_SAMPLE_01 — environment provisioning is not command repair

**Written before any inference has been run against jest, webpack, babel or babel-loader.**

## The judgement call, stated rather than made quietly

jest's reference plan contains a step the workflow does not contain:

```
corepack enable
```

The frozen rule says *"a reference arm needing a command the workflow does not state is a qualification
failure, not something to hand-write."* Taken literally, that forbids the line above. Taken literally it
would also forbid the container having node 22 at all, since no `run:` step installs it — CI gets node
**and yarn** from `actions/setup-node`, and the canonical container already stands in for the node half
of that. This amendment says where the line is instead of leaving me to decide it case by case.

## The rule

A reference arm may include a command that stands in for what a `uses:` **setup** action provisions, if
and only if all three hold:

1. the tool **ships with the pinned runtime or the container image** — nothing new is fetched;
2. the command **only makes a toolchain available**; it does not touch the repository, its sources, or
   its dependency resolution;
3. it is recorded as an **explicit environment step**, distinguishable in the plan from a transcribed
   `run:` line.

`corepack enable` satisfies all three: corepack is bundled with node 22, it only creates shims, and it
is labelled as environment in the plan. This apparatus already treats corepack this way elsewhere — the
`mi2-mutate-target` job installs with `corepack yarn install --immutable`.

Anything failing any of the three remains a qualification failure. In particular: installing a missing
dependency, editing a config, pinning a version the repository does not pin, or adding a flag that
changes what the suite runs is **command repair** and is out of bounds.

## The same licence, withheld from the engine — again

As with `${CPU_CORES}`, this is a privilege the reference arm has and the inference engine does not. It
must not be enjoyed quietly:

- If the engine refuses because it cannot establish a package manager, that is graded on the frozen
  verification table on its merits — **not** counted against DiffCI because I could type `corepack
  enable` and it could not.
- The environment step is visible in the receipt, so anyone reading the evidence can see exactly what
  the reference arm was given that the engine was not.

## Why not just let jest fail R3

Because it would be false. Recording `ENVIRONMENT_INADEQUATE` for jest would assert *the canonical
environment cannot run jest's CI*, when the truth is narrower and duller: the container had not run the
one bundled command that exposes yarn. Publishing the broad claim when only the narrow one is supported
is the same error as attempt 4's `REPRODUCED` — a label that reads as a finding while resting on
something else entirely.
