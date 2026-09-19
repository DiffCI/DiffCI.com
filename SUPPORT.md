# Support policy

## Open-source core

Supported package:

```text
@diffci.com/diffci
```

Supported surfaces:

- `diffci observe`
- `diffci verify-workflow`
- `diffci version`
- the basic GitHub Action in `action.yml`
- local JSON observation reports
- optional report submission to a configured endpoint and token

Supported runtime:

```text
Node.js >=22.5.0
```

The open-source support commitment is limited to the latest published npm release unless a security
advisory says otherwise.

## Commercial DiffCI

Commercial DiffCI is separate proprietary software. It includes:

- DiffCI Cloud;
- hosted dashboards and private report access;
- organization/team management;
- historical analytics;
- enterprise policies;
- managed runners;
- billing, ledger, and support operations;
- deployment and control-plane infrastructure.

Those features are not included in Tidelift package support for the OSS dependency.

## Tidelift boundary

Tidelift support, if accepted, should cover the open-source npm package as a dependency. It should not be
used to represent DiffCI Cloud, managed runners, or enterprise policy features as open source.
