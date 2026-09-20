# DiffCI observation: unjs/ofetch

Sampled: 2026-09-19T14:49:20.871Z. Observer: published npm package 0.1.3; Node.js v24.16.0; Windows.

Repository: [unjs/ofetch](https://github.com/unjs/ofetch). This is an independent analysis of public source; no adoption or endorsement is implied.

- Status: **OBSERVED / SELECTIVE**.
- Selection: 1 / 1 discovered test files.
- Runtime savings: **not measured**.
- Checkout unchanged: true.
- Head: [1dbc37fd1ceab832fc7c90cad81b1091c95ba563](https://github.com/unjs/ofetch/commit/1dbc37fd1ceab832fc7c90cad81b1091c95ba563).
- Base: 9102908aeecaec29801d67fdd4f4f6f73a2d76d2.
- Change: chore: fix typos in readme (#608).
- Refusal/fallback: None reported.

## Scope

One default-branch HEAD-to-first-parent delta, selected before seeing the analysis. No target
dependencies were installed and no target code or tests were executed. These are discovered file
counts, not individual test cases. Discovery completeness, runner behavior, safety, historical
opportunity rate, and incremental value over the existing workflow are not validated here.
A FULL verdict requires full validation even when the raw selectedTests array is empty.

## Reproduce

```sh
git clone https://github.com/unjs/ofetch.git
cd ofetch
git checkout --detach 1dbc37fd1ceab832fc7c90cad81b1091c95ba563
npx @diffci.com/diffci@0.1.3 observe --base 9102908aeecaec29801d67fdd4f4f6f73a2d76d2 --head 1dbc37fd1ceab832fc7c90cad81b1091c95ba563 --no-send
```

The report is written outside the checkout. [Raw report](unjs--ofetch.json); [cohort manifest](cohort.json).

## Shareable summary

```markdown
DiffCI observation of unjs/ofetch at 1dbc37fd1cea: 1 / 1 discovered test files; runtime savings not measured.
```

## Next step

This snapshot does not demonstrate a smaller selection. Check a fixed historical sample before proposing a pilot.

Maintainer contact: not sent. Pilot: not started.
