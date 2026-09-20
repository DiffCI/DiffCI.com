# DiffCI observation: unjs/h3

Sampled: 2026-09-19T14:49:07.318Z. Observer: published npm package 0.1.3; Node.js v24.16.0; Windows.

Repository: [unjs/h3](https://github.com/unjs/h3). This is an independent analysis of public source; no adoption or endorsement is implied.

- Status: **OBSERVED / SELECTIVE**.
- Selection: 59 / 71 discovered test files.
- Runtime savings: **not measured**.
- Checkout unchanged: true.
- Head: [b31898362a111c526271989682aef54b2a15077f](https://github.com/unjs/h3/commit/b31898362a111c526271989682aef54b2a15077f).
- Base: 2d3605a0af7e01fc09d89b4bed4f4d07e85f88a6.
- Change: fix(cookie): include partitioned in the distinct-cookie key (#1553).
- Refusal/fallback: None reported.

## Scope

One default-branch HEAD-to-first-parent delta, selected before seeing the analysis. No target
dependencies were installed and no target code or tests were executed. These are discovered file
counts, not individual test cases. Discovery completeness, runner behavior, safety, historical
opportunity rate, and incremental value over the existing workflow are not validated here.
A FULL verdict requires full validation even when the raw selectedTests array is empty.

## Reproduce

```sh
git clone https://github.com/unjs/h3.git
cd h3
git checkout --detach b31898362a111c526271989682aef54b2a15077f
npx @diffci.com/diffci@0.1.3 observe --base 2d3605a0af7e01fc09d89b4bed4f4d07e85f88a6 --head b31898362a111c526271989682aef54b2a15077f --no-send
```

The report is written outside the checkout. [Raw report](unjs--h3.json); [cohort manifest](cohort.json).

## Shareable summary

```markdown
DiffCI observation of unjs/h3 at b31898362a11: 59 / 71 discovered test files; runtime savings not measured.
```

## Next step

Validate dependency reachability and actual runner selection on source-changing deltas, then measure a controlled comparison before claiming savings.

Maintainer contact: not sent. Pilot: not started.
