# DiffCI observation: immerjs/immer

Sampled: 2026-09-19T14:51:08.237Z. Observer: published npm package 0.1.3; Node.js v24.16.0; Windows.

Repository: [immerjs/immer](https://github.com/immerjs/immer). This is an independent analysis of public source; no adoption or endorsement is implied.

- Status: **OBSERVED / SELECTIVE**.
- Selection: 1 / 23 discovered test files.
- Runtime savings: **not measured**.
- Checkout unchanged: true.
- Head: [061c2425e1c9dff89e4e4189d42af1b7839dfe0a](https://github.com/immerjs/immer/commit/061c2425e1c9dff89e4e4189d42af1b7839dfe0a).
- Base: 955c5f5f3d5af150aab8b306de132c4411163ca4.
- Change: chore(test): pin draft prototype-inspection behavior restored by #1271 (#1272).
- Refusal/fallback: None reported.

## Scope

One default-branch HEAD-to-first-parent delta, selected before seeing the analysis. No target
dependencies were installed and no target code or tests were executed. These are discovered file
counts, not individual test cases. Discovery completeness, runner behavior, safety, historical
opportunity rate, and incremental value over the existing workflow are not validated here.
A FULL verdict requires full validation even when the raw selectedTests array is empty.

## Reproduce

```sh
git clone https://github.com/immerjs/immer.git
cd immer
git checkout --detach 061c2425e1c9dff89e4e4189d42af1b7839dfe0a
npx @diffci.com/diffci@0.1.3 observe --base 955c5f5f3d5af150aab8b306de132c4411163ca4 --head 061c2425e1c9dff89e4e4189d42af1b7839dfe0a --no-send
```

The report is written outside the checkout. [Raw report](immerjs--immer.json); [cohort manifest](cohort.json).

## Shareable summary

```markdown
DiffCI observation of immerjs/immer at 061c2425e1c9: 1 / 23 discovered test files; runtime savings not measured.
```

## Next step

Validate dependency reachability and actual runner selection on source-changing deltas, then measure a controlled comparison before claiming savings.

Maintainer contact: not sent. Pilot: not started.
