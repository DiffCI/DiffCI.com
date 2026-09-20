# DiffCI observation: unjs/unenv

Sampled: 2026-09-19T14:49:25.940Z. Observer: published npm package 0.1.3; Node.js v24.16.0; Windows.

Repository: [unjs/unenv](https://github.com/unjs/unenv). This is an independent analysis of public source; no adoption or endorsement is implied.

- Status: **OBSERVED / FULL**.
- Selection: Full validation required (6 discovered files).
- Runtime savings: **not measured**.
- Checkout unchanged: true.
- Head: [f89b7ccb5c05da70b946319783acf1fa1f113e22](https://github.com/unjs/unenv/commit/f89b7ccb5c05da70b946319783acf1fa1f113e22).
- Base: ab9951988c2028b16d52770fbeb9d43c16f4df3b.
- Change: chore(deps): update actions/checkout action to v6 (#532).
- Refusal/fallback: Configuration file(s) changed; full validation required; GitHub workflow definition(s) changed; full validation required.

## Scope

One default-branch HEAD-to-first-parent delta, selected before seeing the analysis. No target
dependencies were installed and no target code or tests were executed. These are discovered file
counts, not individual test cases. Discovery completeness, runner behavior, safety, historical
opportunity rate, and incremental value over the existing workflow are not validated here.
A FULL verdict requires full validation even when the raw selectedTests array is empty.

## Reproduce

```sh
git clone https://github.com/unjs/unenv.git
cd unenv
git checkout --detach f89b7ccb5c05da70b946319783acf1fa1f113e22
npx @diffci.com/diffci@0.1.3 observe --base ab9951988c2028b16d52770fbeb9d43c16f4df3b --head f89b7ccb5c05da70b946319783acf1fa1f113e22 --no-send
```

The report is written outside the checkout. [Raw report](unjs--unenv.json); [cohort manifest](cohort.json).

## Shareable summary

```markdown
DiffCI observation of unjs/unenv at f89b7ccb5c05: Full validation required (6 discovered files); runtime savings not measured.
```

## Next step

Keep the full-run verdict. Sample source changes separately using a predeclared historical window.

Maintainer contact: not sent. Pilot: not started.
