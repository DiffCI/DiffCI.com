# DiffCI observation: unjs/consola

Sampled: 2026-09-19T14:49:32.238Z. Observer: published npm package 0.1.3; Node.js v24.16.0; Windows.

Repository: [unjs/consola](https://github.com/unjs/consola). This is an independent analysis of public source; no adoption or endorsement is implied.

- Status: **OBSERVED / FULL**.
- Selection: Full validation required (1 discovered files).
- Runtime savings: **not measured**.
- Checkout unchanged: true.
- Head: [c47faac1738b7383971c6c20b5a34ffa15e7cc3b](https://github.com/unjs/consola/commit/c47faac1738b7383971c6c20b5a34ffa15e7cc3b).
- Base: 512d570b3f99a27b6766a885cae2730aa3dc0ed4.
- Change: chore(deps): update autofix-ci/action digest to 7a166d7 (#409).
- Refusal/fallback: Configuration file(s) changed; full validation required; GitHub workflow definition(s) changed; full validation required.

## Scope

One default-branch HEAD-to-first-parent delta, selected before seeing the analysis. No target
dependencies were installed and no target code or tests were executed. These are discovered file
counts, not individual test cases. Discovery completeness, runner behavior, safety, historical
opportunity rate, and incremental value over the existing workflow are not validated here.
A FULL verdict requires full validation even when the raw selectedTests array is empty.

## Reproduce

```sh
git clone https://github.com/unjs/consola.git
cd consola
git checkout --detach c47faac1738b7383971c6c20b5a34ffa15e7cc3b
npx @diffci.com/diffci@0.1.3 observe --base 512d570b3f99a27b6766a885cae2730aa3dc0ed4 --head c47faac1738b7383971c6c20b5a34ffa15e7cc3b --no-send
```

The report is written outside the checkout. [Raw report](unjs--consola.json); [cohort manifest](cohort.json).

## Shareable summary

```markdown
DiffCI observation of unjs/consola at c47faac1738b: Full validation required (1 discovered files); runtime savings not measured.
```

## Next step

Keep the full-run verdict. Sample source changes separately using a predeclared historical window.

Maintainer contact: not sent. Pilot: not started.
