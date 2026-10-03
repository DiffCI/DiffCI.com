# Tidelift one-pager

**Reviewed 2026-09-25:** proposed support scope, not an accepted Tidelift offering. See
[`tidelift-package-support.md`](tidelift-package-support.md) for readiness and
[`distribution.md`](distribution.md) for current distribution status.

## Package

`@diffci.com/diffci`

## License

AGPL-3.0-only for DiffCI Core.

Commercial DiffCI is separate proprietary software and is not part of the supported OSS dependency.

## Ecosystem

npm / JavaScript / TypeScript

## What the package does

DiffCI analyzes changed files and reports proposed test selections. `observe` and the basic GitHub
Action are observation-only. The CLI also provides explicitly invoked `check`, `pilot`, and
`verify-savings` commands that execute tests for runtime comparison without replacing required CI.

Proposed support surfaces (to agree with Tidelift):

- `diffci observe`
- `diffci verify-workflow`
- `diffci version`
- basic GitHub Action wrapper
- local JSON observation report
- optional report submission to a configured endpoint and token

## Why enterprises care

DiffCI gives teams a low-risk way to measure potential CI waste before adopting any CI optimization
policy. The package runs in the customer's own CI environment, keeps source code local, and produces a
report that can be reviewed before any hosted or commercial workflow is used.

## What Tidelift support should cover

- maintenance of the npm package;
- security fixes for the OSS observer;
- license clarity for AGPL-3.0-only;
- package boundary assurance;
- compatibility with supported Node.js versions;
- release and provenance hygiene.

## What Tidelift support should not cover

- DiffCI Cloud;
- hosted dashboards;
- organization management;
- private report access;
- managed runners;
- billing or invoices;
- enterprise policy configuration;
- custom commercial onboarding.

Those belong to Commercial DiffCI.

## Release checks

Run before each supported release:

```bash
npm run check
npm run check:oss-boundary
npm run package:smoke
```

Publish with npm provenance from a clean Git tag.

Use [`release-checklist.md`](release-checklist.md) and [`tidelift-outreach.md`](tidelift-outreach.md)
for release and recognition tracking.
