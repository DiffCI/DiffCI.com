# Commercial DiffCI boundary

DiffCI is an open-core project with two separate software boundaries.

## Open-source core

DiffCI Core is the installable observation-only package published as `@diffci.com/diffci`.

It is licensed AGPL-3.0-only and includes:

- the engine/client/action code shipped in the npm package;
- local analysis;
- local JSON reports;
- the basic GitHub Action;
- optional submission to a configured hosted endpoint.

The exact package boundary is recorded in [`docs/oss-boundary.md`](docs/oss-boundary.md).

## Commercial DiffCI

Commercial DiffCI is proprietary software. It includes code and services for:

- DiffCI Cloud;
- organization dashboards;
- private report access;
- historical analytics;
- enterprise policies;
- managed runners;
- team and organization features;
- billing, ledger, usage, and entitlement systems;
- deployment, research, operations, and control-plane infrastructure.

Commercial DiffCI is not licensed under the AGPL merely because it lives in the same repository. Files
outside the OSS package boundary remain proprietary unless a later change explicitly moves them into the
OSS package boundary.
