# DiffCI open-core packaging

**Date:** 2026-09-19

DiffCI should be packaged as an open-source core with a commercial hosted layer. The core earns trust by
being inspectable, local, and inert. The commercial product sells memory, coordination, policy, and
operations around that core.

## Product split

```text
DiffCI
|
├── Open-source core
|   ├── DiffCI engine
|   ├── CLI / npm package
|   ├── Local analysis
|   └── Basic GitHub Action
|       |
|       └── Tidelift package
|
└── Commercial DiffCI
    ├── Hosted service / DiffCI Cloud
    ├── Organization dashboard
    ├── Historical analytics
    ├── Advanced CI/CD optimization
    ├── Enterprise policies
    ├── Managed runners
    ├── Team features
    └── Support / enterprise services
```

## Open-source core

The open-source core is the AGPL-3.0-only adoption path. It should stay useful without DiffCI Cloud.

Core capabilities:

- run `diffci observe` locally or in CI;
- analyze a checkout without sending source code to DiffCI;
- write a local JSON report;
- verify that a GitHub Action installation is non-interfering;
- install as a basic GitHub Action job;
- optionally submit a report to a configured endpoint and token.

The open-source promise is narrow and durable:

> DiffCI observes your CI and reports what it would have selected. It does not skip, cancel, reorder,
> block, or modify real CI.

That promise should be true with no account, no dashboard, no hosted endpoint, and no sales process.

## Tidelift package

Tidelift belongs under the open-source core, not the hosted product. It is a procurement and maintenance
channel for teams that want supported open-source dependencies.

The Tidelift offer should map to the package:

- supported npm package;
- security and maintenance assurances;
- dependency health metadata;
- license and supply-chain comfort for enterprises;
- no hosted DiffCI account required.

Tidelift should not become the feature boundary. It supports the OSS package; DiffCI Cloud is the hosted
product.

## Commercial DiffCI

The commercial product should sell the things a local observer cannot do well:

- remember history across runs;
- aggregate observations by repository, organization, team, and time window;
- explain trends and regressions;
- apply organization policy;
- coordinate team access;
- operate managed analysis and runner infrastructure;
- provide support, onboarding, and enterprise assurance.

Commercial features should be framed as operational value, not as hidden correctness. If correctness
lives only in the paid service, the open-source trust story gets weaker.

## Boundary rules

Keep these boundaries clear:

- The engine and basic observer stay open-source.
- The GitHub Action stays safe and inert by default.
- Hosted submission stays opt-in.
- DiffCI Cloud stores and compares history; the core produces a single-run observation.
- Enterprise policies can approve, require, retain, route, and audit reports, but should not silently
  change CI behavior.
- Managed runners are a commercial operations feature, separate from the read-only Shadow App.
- The AGPL-3.0-only license applies to the OSS package boundary, not to every commercial/control-plane
  file in this mixed repository.

## Near-term packaging

For private alpha, ship only the boundary that is already true:

| Surface | Alpha packaging |
|---|---|
| OSS | npm CLI, basic GitHub Action, local report, workflow verifier |
| Hosted | ingest, organization dashboard, report links, historical shadow observations |
| Enterprise | manual support and onboarding, not a separate feature tier yet |
| Tidelift | prepare as a supported-package channel after license, release, and package-boundary hardening |

The first external users should understand this in one sentence:

> Start with the open-source observer; connect DiffCI Cloud when you want shared history, team access, and
> hosted reports.

Tidelift preparation is tracked in [`tidelift-package-support.md`](tidelift-package-support.md).
