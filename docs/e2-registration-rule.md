# FROZEN — E2 corpus registration rule

**Written before any continuation repository was registered or qualified.**

## Why this needs a rule at all

`dogfood:qualify` qualifies repositories that exist in the corpus registry. The ten continuation
repositories do not, so `e2-01-lint-staged` failed with *"the collected corpus has no entry for
lint-staged/lint-staged"*. That is an **apparatus gap, not a repository property**: lint-staged is
`UNREGISTERED`, not RED. Recording it RED would be a false exclusion of exactly the kind defect 20
nearly produced.

Registration requires an install command, an optional build, and a test-runner entry point. **Choosing
those per repository is where bias enters** — a repository can be made green by picking friendlier
commands, and "which commands did you use?" is unanswerable after the fact unless the rule is fixed in
advance. So the rule is mechanical, uniform, and frozen here.

## The rule

Derived from the repository's own manifest at the **pinned E1 tree**. Nothing is chosen per repository.

```
INSTALL  pnpm-lock.yaml        -> corepack pnpm install --frozen-lockfile
         yarn.lock             -> corepack yarn install --immutable
         package-lock.json     -> npm ci --no-audit --no-fund
         none of the above     -> npm install --no-audit --no-fund

BUILD    scripts.build exists  -> npm run build       (via the detected package manager)
         otherwise             -> no build

RUNNER   devDependencies.vitest -> node_modules/vitest/vitest.mjs   (args: ["run"])
         devDependencies.jest   -> node_modules/jest/bin/jest.js    (args: [])
         neither                -> REFUSE to register
```

**The build is included whenever a `build` script exists**, uniformly. Omitting it is what produced the
J1 defect, where a registration mistake was nearly recorded as a qualification failure. Including it
uniformly costs time on repositories that did not need it; that is the cheaper error.

**REFUSE rather than guess.** A repository whose runner cannot be determined is recorded
`UNREGISTERABLE` with the reason. It is *not* silently defaulted to vitest, and *not* recorded RED.

## Outcomes E2 can produce, and what each means

| outcome | meaning | counts as |
|---|---|---|
| `GREEN` | suite green on two consecutive runs, exit 0 both | an eligible repository |
| `RED` | install, build or suite failed, or baselines disagreed | attempted, retained in the funnel |
| `UNREGISTERABLE` | runner undeterminable under the rule above | attempted, retained, NOT red |

All three are retained in the funnel. **No outcome removes a repository from the history.**

## What registration may not do

It may not run `observe`, `mutate` or density analysis; may not inspect selection; may not look at
commit history; and may not be retried with different commands because the first attempt was RED.
**One attempt per repository under the frozen rule.** A second attempt with adjusted commands would be
tuning until green, which is the thing this rule exists to prevent.

If a repository is RED under its own documented commands, that is a fact about running it in the
canonical environment, and the traversal simply continues to the next rank.
