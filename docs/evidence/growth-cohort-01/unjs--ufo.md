# DiffCI observation: unjs/ufo

Sampled: 2026-09-19T14:49:39.984Z. Observer: published npm package 0.1.3; Node.js v24.16.0; Windows.

Repository: [unjs/ufo](https://github.com/unjs/ufo). This is an independent analysis of public source; no adoption or endorsement is implied.

- Status: **OBSERVED / FULL**.
- Selection: Full validation required (13 discovered files).
- Runtime savings: **not measured**.
- Checkout unchanged: true.
- Head: [f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6](https://github.com/unjs/ufo/commit/f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6).
- Base: 5cd9e676711af3f4e4b5398ddf6ca8d52c1c7e1f.
- Change: chore(release): v1.6.4.
- Refusal/fallback: Configuration file(s) changed; full validation required.

## Scope

One default-branch HEAD-to-first-parent delta, selected before seeing the analysis. No target
dependencies were installed and no target code or tests were executed. These are discovered file
counts, not individual test cases. Discovery completeness, runner behavior, safety, historical
opportunity rate, and incremental value over the existing workflow are not validated here.
A FULL verdict requires full validation even when the raw selectedTests array is empty.

## Reproduce

```sh
git clone https://github.com/unjs/ufo.git
cd ufo
git checkout --detach f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6
npx @diffci.com/diffci@0.1.3 observe --base 5cd9e676711af3f4e4b5398ddf6ca8d52c1c7e1f --head f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6 --no-send
```

The report is written outside the checkout. [Raw report](unjs--ufo.json); [cohort manifest](cohort.json).

## Shareable summary

```markdown
DiffCI observation of unjs/ufo at f06c800d0c59: Full validation required (13 discovered files); runtime savings not measured.
```

## Next step

Keep the full-run verdict. Sample source changes separately using a predeclared historical window.

Maintainer contact: not sent. Pilot: not started.
