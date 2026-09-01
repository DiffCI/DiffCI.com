# CI_REPRODUCTION_03 — a blocking discovery, before execution

Matrix expansion is implemented and works: `html-webpack-plugin` expands to **28 concrete instances**,
each carrying its assignment and evidence. But the TEST path is **still non-executable**, and the reason
is not the expander.

## The repository's workflow references matrix axes it does not define

```yaml
strategy:
  matrix:
    node: [10.x, 12.x, 14.x, 16.x, 18.x, 20.x, 22.x]
    os: [ubuntu-latest, windows-latest, macOS-latest]
    webpack: [latest]

steps:
  - uses: actions/setup-node@v4
    with:
      node-version: ${{ matrix.node-version }}      # ← matrix defines `node`, not `node-version`
  - if: matrix.webpack-version != 'latest'          # ← matrix defines `webpack`, not `webpack-version`
    run: npm i webpack@${{ matrix.webpack-version }} --legacy-peer-deps
```

The matrix declares `node`, `os`, `webpack`. Three steps reference `node-version` and `webpack-version`,
**which do not exist**. The engine refuses those operations with *"references a matrix axis this instance
does not define"* — which is correct, and is a real finding about this repository rather than a gap in
DiffCI.

Under GitHub's semantics an undefined context evaluates to the **empty string**, so the real CI runs
`npm i webpack@ --legacy-peer-deps` and passes an empty `node-version` to `setup-node`. The workflow
works by accident.

## Two capabilities this exposes, neither of which I have implemented

**1. `if:` condition evaluation.** The first step is gated:

```yaml
- if: matrix.os == 'windows-latest'
  run: git config --global core.autocrlf input
```

On an `ubuntu-latest` instance real CI **skips** it. My engine includes it unconditionally — which is why
attempt 2's inference arm ran `git config` on Linux where CI would not. Harmless there; not harmless as a
general property, because a step included against its own condition is a step the pipeline does not have.

**2. Undefined-context semantics.** Faithfully reproducing this pipeline requires substituting the empty
string for `${{ matrix.webpack-version }}`, because that is what GitHub does. That is a deliberate choice
to **reproduce a repository's own defect faithfully**, and it is exactly the kind of semantic decision
that should be frozen deliberately rather than slipped in to make a benchmark pass.

## Why attempt 3 was not executed

The frozen protocol requires that the reference arm **no longer omit the matrix step**, and forbids
**human command repair**. Both cannot hold here:

- the engine refuses the step, so the inference arm executes nothing — a legitimate `REFUSED`;
- writing `npm i webpack@ --legacy-peer-deps` into the reference plan by hand *is* command repair, and
  would be me encoding GitHub's empty-context rule as a hand-written constant.

Running it would burn a container run to record a refusal I can already state precisely, and the
reference arm would be invalid under the protocol I just froze. So attempt 3 is **not executed**, and
this is recorded as the reason rather than as a result.

## The decision this needs

Reaching `REPRODUCED` on this target requires implementing, as frozen semantics:

1. **`if:` evaluation** for at least `matrix.<axis> <op> '<literal>'`, with anything unsupported making
   the step non-executable rather than silently included; and
2. **undefined-context → empty string**, matching GitHub, so the engine reproduces the workflow the
   repository actually runs — including its mistakes.

Both are pipeline semantics, not parser broadening. Neither is started.

The alternative is to accept `REFUSED` as attempt 3's outcome on the grounds that the repository's
workflow is internally inconsistent, and select a different reproduction target. I do not recommend that:
this inconsistency is not exotic, and an engine that cannot reproduce a workflow with a typo in it will
not reproduce much real CI.

## What stands regardless

- Matrix expansion: implemented, general, 28 instances with provenance, `include`/`exclude` represented.
- The execution boundary: enforced and tested — a refused plan executes zero operations.
- Reference arm GREEN on Linux, 161 tests / 4 files / 0 failures.
- `npm ci --legacy-peer-deps`: recovered from evidence, execution-confirmed on the canonical platform.
