# DiffCI observation: sindresorhus/ky

**Withdrawn as opportunity evidence.** The following is preserved output of published 0.1.3, which
missed import edges from tests excluded by this repository's compiler configuration. Do not share the
3/30 count as a validated opportunity. See the [follow-up](../growth-history-01/README.md).

Sampled: 2026-09-19T14:49:49.627Z. Observer: published npm package 0.1.3; Node.js v24.16.0; Windows.

Repository: [sindresorhus/ky](https://github.com/sindresorhus/ky). This is an independent analysis of public source; no adoption or endorsement is implied.

- Status: **OBSERVED / SELECTIVE**.
- Selection: 3 / 30 discovered test files.
- Runtime savings: **not measured**.
- Checkout unchanged: true.
- Head: [0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47](https://github.com/sindresorhus/ky/commit/0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47).
- Base: 071a9b97d3d149a576c91e0b92532f11aab456c5.
- Change: Add `maxResponseSize` option.
- Refusal/fallback: None reported.

## Scope

One default-branch HEAD-to-first-parent delta, selected before seeing the analysis. No target
dependencies were installed and no target code or tests were executed. These are discovered file
counts, not individual test cases. Discovery completeness, runner behavior, safety, historical
opportunity rate, and incremental value over the existing workflow are not validated here.
A FULL verdict requires full validation even when the raw selectedTests array is empty.

## Reproduce

```sh
git clone https://github.com/sindresorhus/ky.git
cd ky
git checkout --detach 0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47
npx @diffci.com/diffci@0.1.3 observe --base 071a9b97d3d149a576c91e0b92532f11aab456c5 --head 0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47 --no-send
```

The report is written outside the checkout. [Raw report](sindresorhus--ky.json); [cohort manifest](cohort.json).

## Shareable summary

```markdown
DiffCI observation of sindresorhus/ky at 0d59458a0a58: 3 / 30 discovered test files; runtime savings not measured.
```

## Next step

Validate dependency reachability and actual runner selection on source-changing deltas, then measure a controlled comparison before claiming savings.

Maintainer contact: not sent. Pilot: not started.
