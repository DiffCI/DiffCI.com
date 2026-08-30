# External validation target #2: `date-fns/date-fns`

**Recorded before the repository was cloned, and before any DiffCI observation, comparator selection,
calibration result, eligibility prediction, or economics data existed for it.**

## The selection

`date-fns/date-fns`, named by ChatGPT and relayed by the user, after target #1 closed as
[`NOT_QUALIFIED`](external-target-01-result.md).

Its provenance is worth stating precisely, because it is not identical to Fastify's:

> This is deliberately the fallback that was named **before the Vue experiment** — in the repository #3
> selection, whose fallback order was Vitest → Vue core → date-fns. But **no DiffCI selection ratios or
> economics have ever been seen for it.**

So date-fns was named as a candidate earlier than Fastify was, and has been examined exactly as little.
The property that matters for out-of-sample validity is that no Fastify- or date-fns-specific DiffCI
data has ever informed the rule, the criteria, or the choice. That holds.

**Selection does not imply eligibility.** The frozen criteria at [`04750a3`](external-validation-protocol.md)
decide that independently, and the assessment implementation remains `910969f`, unchanged.

## Repository configuration, determined at eligibility time

All of this is repository metadata and build configuration, read before any DiffCI analysis existed.
Recording it here is what makes "no commands were invented" checkable.

| | |
|---|---|
| Pinned commit | `18cbd436f1428d0f45f89f710df65f62546c42f0` |
| Shape | pnpm monorepo, `@date-fns/root`, workspace `pkgs/*` — core, tz, utc, docs, dev |
| Lockfile | **`pnpm-lock.yaml` committed.** Unlike hono and fastify, this repository pins its dependency tree. |
| Runner | vitest ^4.1.6 — back on a runner the harness supports |
| Install | `corepack pnpm install --frozen-lockfile`, matching CI's documented `pnpm install` |
| Build | **None.** `pkgs/core`'s `exports` map points at `./src/index.ts`, so workspace consumers resolve TypeScript source and vitest transpiles it. Same situation as vue. |
| Test invocation | `node node_modules/vitest/vitest.mjs run` at the clone root |

### Why the root invocation, with no project filter

The root ships its own `vitest.config.ts` declaring `projects: ["pkgs/*"]`. Running bare `vitest run`
against it is **the repository's own declaration of its test surface**, and is the identical uniform
non-interactive invocation applied to hono. No project filter, no exclusion, no include glob was
invented; each package's own committed config decides its file set.

There is no root `test` script to point at — the root `package.json` has no `scripts` block at all, and
CI drives tests through `mise` tasks. Where vue offered a choice between two documented scripts and one
was selected, date-fns offers no root script, so the root config is the only repository-authored
statement of "all the tests" available. Narrowing to `pkgs/core` alone was **considered and rejected**:
it would be pre-screening the repository into a friendlier shape, which is a form of tuning.

### One thing checked in advance, and why that was legitimate

`pkgs/core/vitest.config.ts` imports `@vitest/browser-playwright`, and the validation contract forbids
launching a browser. The browser instance is **commented out** in that config — `// Enable it via
--browser` — and a separate `test/browser` mise task supplies the flag. So `vitest run` without
`--browser` runs in node.

This was checked because vue's selection turned on the same question, and the answer determines which
documented command is even runnable under the contract. It is a fact about the repository's
configuration, not about DiffCI's behaviour on it.

## What has NOT been looked at

No commits enumerated, no selection counts, no comparator counts, no analysis CPU, no calibration, no
prediction. **No sign has been predicted.**

## The reporting rule for this target

At the user's direction, the observation ratios are **not to be reported before the prediction is
frozen**. The next message about date-fns will be either a refusal outcome, or exactly:

> `date-fns qualified; prediction frozen: POSITIVE` / `NEGATIVE`

with the measured result following later. This removes any opportunity — mine or the reader's — to
form an expectation from the inputs and then read the prediction as confirming it.

## The rules that apply unchanged

- If date-fns is red, its runner unsupported, its test surface not file-addressable, or calibration
  cannot obtain a trustworthy denominator: **preserve the outcome and stop.** Do not modify anything to
  admit it.
- If observation yields fewer than 15 of 25 usable candidates: insufficient evidence. The threshold does
  not move.
- If the outcome is `FALSE_POSITIVE_ELIGIBILITY`: date-fns becomes development-set evidence and the
  corrected predictor faces a new target. The predictor is not repaired against date-fns and re-run on
  date-fns.
