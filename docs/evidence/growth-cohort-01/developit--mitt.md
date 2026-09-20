# DiffCI observation: developit/mitt

Sampled: 2026-09-19T14:50:35.949Z. Observer: published npm package 0.1.3; Node.js v24.16.0; Windows.

Repository: [developit/mitt](https://github.com/developit/mitt). This is an independent analysis of public source; no adoption or endorsement is implied.

- Status: **OBSERVED / FULL**.
- Selection: Full validation required (2 discovered files).
- Runtime savings: **not measured**.
- Checkout unchanged: true.
- Head: [6b41670516ed8e8b738612f60491995470aa63b3](https://github.com/developit/mitt/commit/6b41670516ed8e8b738612f60491995470aa63b3).
- Base: b240473b5707857ba2c6a8e6d707c28d1e39da49.
- Change: added github template for PRs (#172).
- Refusal/fallback: Configuration file(s) changed; full validation required.

## Scope

One default-branch HEAD-to-first-parent delta, selected before seeing the analysis. No target
dependencies were installed and no target code or tests were executed. These are discovered file
counts, not individual test cases. Discovery completeness, runner behavior, safety, historical
opportunity rate, and incremental value over the existing workflow are not validated here.
A FULL verdict requires full validation even when the raw selectedTests array is empty.

## Reproduce

```sh
git clone https://github.com/developit/mitt.git
cd mitt
git checkout --detach 6b41670516ed8e8b738612f60491995470aa63b3
npx @diffci.com/diffci@0.1.3 observe --base b240473b5707857ba2c6a8e6d707c28d1e39da49 --head 6b41670516ed8e8b738612f60491995470aa63b3 --no-send
```

The report is written outside the checkout. [Raw report](developit--mitt.json); [cohort manifest](cohort.json).

## Shareable summary

```markdown
DiffCI observation of developit/mitt at 6b41670516ed: Full validation required (2 discovered files); runtime savings not measured.
```

## Next step

Keep the full-run verdict. Sample source changes separately using a predeclared historical window.

Maintainer contact: not sent. Pilot: not started.
