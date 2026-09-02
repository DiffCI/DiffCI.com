# Sample member 3 — `webpack/webpack` @ `ebd3be476` — **INCORRECT_REFUSAL**

R3 qualified handsomely. The reference arm ran the real pipeline clean:

| step | exit | wall |
|---|---|---|
| `corepack enable` | 0 | 0.1s |
| `yarn upgrade pkg-pr-new@0.0.66` | 0 | 36.8s |
| `yarn --frozen-lockfile` | 0 | 0.8s |
| `yarn link --frozen-lockfile` *(allowFailure)* | 0 | 0.2s |
| `yarn link webpack --frozen-lockfile` | 0 | 0.2s |
| `yarn cover:integration:a --ci --cacheDirectory .jest-cache` | 0 | 730.2s — **57,666 tests, 0 failures** |

Matching CI ground truth `integration (ubuntu-latest, 22.x, a)` = `success`.

The engine then refused. **The refusal is not correct**, and the reason it is not correct matters more
than the refusal itself.

## The engine planned the wrong job — again

```
testPlan.jobId = test.yml#runtimes-runtimedeno
jobs providing TEST = runtimes-runtimedeno, runtimes-runtimebun
integration job instances = 31, every one of them provides ["INSTALL"] only
```

All **31** expanded instances of the job that actually runs webpack's suite were inferred, and not one
was recognised as providing TEST. The engine planned a **Deno runtime job** instead.

## Why `integration` lost its TEST purpose — defect 31

Its test step is a compound line:

```
yarn cover:integration:${{ matrix.part }} --ci --cacheDirectory .jest-cache || yarn … -f
```

`argvOf` rejects shell metacharacters, so the line yields no command, so no `test` operation is derived,
so the job provides only `INSTALL`. **A job whose only test step is a compound `run:` line silently
becomes a non-test job.** Amendment 3 handled this for the reference arm by representing `|| true` as
data; the engine has no equivalent and simply drops the step.

## Why the Deno job won it — defect 28, again, with a new innocent string

The operations classified as TEST in `runtimes-runtimedeno`:

```
runtimes-runtimedeno-test-3   git apply test/patches/jest-worker+30.4.1.patch
runtimes-runtimedeno-test-4   git apply test/patches/jest-runner+30.4.2.patch
```

`git apply` is not a test. It was classified as one because `/\b(jest|vitest|mocha|ava)\b/` matched
**inside a patch filename**. On jest the same regex matched inside a URL in an issue comment. Two
repositories, two different innocent strings, same defect — which is evidence it is systematic rather
than a coincidence of one workflow.

## Defect 30 — a requirement label that does not describe what is checked

The refusal receipt says:

```
runtimes-runtimedeno-install-1 (a resolved package manager)
```

`src/ci-inference/infer.ts:135`:

```js
"a resolved package manager": command.length > 0,
```

The label says *package manager*. The condition tests whether the **command is empty**. They have
nothing to do with each other.

This is why the refusal grades incorrect. Applying the frozen table mechanically to the citation as
written — which is the only thing an operator or a customer can act on:

| | |
|---|---|
| `packageManager` field at the pinned head | **present** — `yarn@1.22.22+sha512…` |
| `yarn.lock` committed | **present** |

The cited requirement is **verifiably satisfied**. Under the frozen rule — *"if the cited requirement is
present, the outcome is `INCORRECT_REFUSAL`"* — this is `INCORRECT_REFUSAL`.

A receipt telling a maintainer "we could not resolve a package manager" about a repository that pins
`yarn@1.22.22` with a committed lockfile is not a safe refusal. It is a misleading one, and a maintainer
acting on it would go looking for a problem that does not exist.

## Classification

**`INCORRECT_REFUSAL`** — a defect against DiffCI under the frozen terminal rule.

Worth separating clearly: **nothing was executed, so nothing unsafe happened.** The execution boundary
held for the third time running. But the frozen vocabulary distinguishes *refusing for a true reason*
from *refusing for a false one* precisely so that "we executed nothing" cannot be reported as
understanding. webpack is the case that distinction was written for.

## Running distribution

| # | repository | outcome |
|---|---|---|
| 1 | eslint | `CORRECT_REFUSAL` |
| 2 | jest | `DIVERGED` |
| 3 | webpack | `INCORRECT_REFUSAL` |
| 4 | babel | pending, carries `REFERENCE_DEVIATION` |
| 5 | babel-loader | pending |

## Defects added — still not fixed, per the freeze

- **30** — requirement labels must describe the condition they check. A receipt that misnames why it
  refused is worse than one that gives no reason, because the reason is actionable and wrong.
- **31** — a compound `run:` line must not silently erase a job's purpose. Dropping an unparseable step
  is defensible; concluding *the job does not test* from that drop is not.
- **28 recurrence** — operation purpose from substring matching, now demonstrated on two repositories
  with two unrelated strings.
