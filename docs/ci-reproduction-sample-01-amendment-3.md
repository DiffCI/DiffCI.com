# AMENDMENT 3 to CI_REPRODUCTION_SAMPLE_01 — compound `run:` lines

**Written after reading webpack's workflow and before any inference has been run against webpack, babel
or babel-loader.**

## The problem

webpack's in-environment cell (`ubuntu-latest`, `22.x`, `part: a`) contains two `run:` lines that are not
single commands:

```yaml
- run: yarn link --frozen-lockfile || true

- run: yarn cover:integration:${{ matrix.part }} --ci --cacheDirectory .jest-cache
    || yarn cover:integration:${{ matrix.part }} --ci --cacheDirectory .jest-cache -f
```

A reference plan is an **argv array**, and the standing security invariant is that *repository-derived
strings must never cross an implicit shell boundary*. Passing either line to a shell to get its `||`
would break that invariant on exactly the input it exists to guard. Silently dropping the operator would
change what the step means.

## The rule, by construct

| construct | representation | why |
|---|---|---|
| `cmd \|\| true` | structured `"allowFailure": true` on the step | the operator's whole meaning is "this step may fail, continue" — that is control flow, expressible as data, with no shell involved |
| `cmd \|\| cmd <retry-flags>` | run the **first** command **once** | the second invocation is flake tolerance, identical in kind to jest's `nick-fields/retry`, which member 2 already treats this way |
| anything else compound — pipes, `&&`, `;`, redirects, command substitution | **not transcribable → qualification failure** | these change what is computed, and no structured equivalent exists |

Representing `|| true` as data rather than as a shell string is the point: the semantics are preserved
**and** the invariant holds. No repository text is handed to a shell to be re-parsed.

## Why the retry branch is not reproduced

`yarn cover:integration:a … -f` re-runs only the failures (`-f` is jest's `--onlyFailures`). Reproducing
it would make the reference arm's result depend on how many attempts it was permitted — a suite that
fails once and passes on retry would be recorded as passing. The reference arm must report what the
suite did, not what it did after being given another chance. Member 2 (jest) is treated identically, so
this is consistent rather than webpack-specific.

**Consequence, stated plainly:** if the real CI cell passed only because of its retry, the reference arm
may fail where CI succeeded. That would be a genuine `DIVERGED`-shaped signal about the *experiment*, not
about DiffCI, and it must be reported as such rather than smoothed over by adding the retry back.

## Steps skipped in this cell, by the workflow's own conditions

Recorded because "skipped" and "never existed" must stay distinguishable:

- four `yarn upgrade` blocks gated on node `10.x`/`12.x`/`14.x`, `16.x`, `18.x`, `20.x` → **FALSE**
- `yarn upgrade enhanced-resolve@…#main …` gated on `matrix.use_main_branches == '1'` → the base matrix
  does **not** declare `use_main_branches` (only the `include:` rows do), so it is `UNDEFINED_CONTEXT`,
  renders empty, and `'' == '1'` is **FALSE**
- `yarn --frozen-lockfile` gated on node being none of 10/12/14/16/18/20/**22** → **FALSE** for 22.x
- `yarn report:cover:merge` and Codecov follow the suite and are not on the TEST path

The `22.x` branch — `yarn upgrade pkg-pr-new@0.0.66` then `yarn --frozen-lockfile` — is **TRUE** and is
transcribed as two steps, since a multi-line `run:` is several commands.

`steps.calculate_architecture.outputs.result` feeds `setup-node`'s `architecture:` input. It is
environment configuration, not a repository command; the canonical container is x64 and no reference
step corresponds to it.

## The licence, and who does not have it

As with amendments 1 and 2, `allowFailure` is something the reference arm gets and the engine does not.
If the engine refuses on a compound `run:` line it cannot decompose, that refusal is graded on the frozen
verification table on its merits — **not** counted against DiffCI because I could read `|| true` and
encode its meaning by hand.
