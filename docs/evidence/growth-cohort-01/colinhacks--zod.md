# DiffCI observation: colinhacks/zod

Sampled: 2026-09-19T14:50:10.330Z. Observer: published npm package 0.1.3; Node.js v24.16.0; Windows.

Repository: [colinhacks/zod](https://github.com/colinhacks/zod). This is an independent analysis of public source; no adoption or endorsement is implied.

- Status: **OBSERVED / FULL**.
- Selection: Full validation required (202 discovered files).
- Runtime savings: **not measured**.
- Checkout unchanged: true.
- Head: [59bbc03e10c636b9eb3c393dfeb552819774ec21](https://github.com/colinhacks/zod/commit/59bbc03e10c636b9eb3c393dfeb552819774ec21).
- Base: 0f3f5ee3ca56c7574bf849e54f79e9a6e02562ee.
- Change: chore: re-pin the integration peers to the workspace zod after the 4.6.5 bump.
- Refusal/fallback: Configuration file(s) changed; full validation required; Lockfile changed; full validation required.

## Scope

One default-branch HEAD-to-first-parent delta, selected before seeing the analysis. No target
dependencies were installed and no target code or tests were executed. These are discovered file
counts, not individual test cases. Discovery completeness, runner behavior, safety, historical
opportunity rate, and incremental value over the existing workflow are not validated here.
A FULL verdict requires full validation even when the raw selectedTests array is empty.

## Reproduce

```sh
git clone https://github.com/colinhacks/zod.git
cd zod
git checkout --detach 59bbc03e10c636b9eb3c393dfeb552819774ec21
npx @diffci.com/diffci@0.1.3 observe --base 0f3f5ee3ca56c7574bf849e54f79e9a6e02562ee --head 59bbc03e10c636b9eb3c393dfeb552819774ec21 --no-send
```

The report is written outside the checkout. [Raw report](colinhacks--zod.json); [cohort manifest](cohort.json).

## Shareable summary

```markdown
DiffCI observation of colinhacks/zod at 59bbc03e10c6: Full validation required (202 discovered files); runtime savings not measured.
```

## Next step

Keep the full-run verdict. Sample source changes separately using a predeclared historical window.

Maintainer contact: not sent. Pilot: not started.
