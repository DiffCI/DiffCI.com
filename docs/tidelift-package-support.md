# Tidelift package support readiness

**Date:** 2026-09-19

Tidelift support belongs to the open-source core. It should support the npm package
`@diffci.com/diffci` as a maintained dependency, while DiffCI Cloud remains the hosted commercial
product.

## Scope

The supported package is the observation-only OSS core:

- `diffci observe`;
- `diffci verify-workflow`;
- the basic GitHub Action;
- local report generation;
- optional report submission to a configured endpoint and token.

Tidelift support does not include hosted dashboards, organization management, managed runners, billing,
private report access, or enterprise policy features. Those belong to Commercial DiffCI.

## Package readiness checklist

Before applying for or announcing Tidelift support:

1. Keep the explicit AGPL-3.0-only license notice in `LICENSE`.
2. Keep `"license": "AGPL-3.0-only"` in `package.json`.
3. Keep `private: false` in `package.json`.
4. Publish from a clean tag with npm provenance.
5. Run `npm run check:oss-boundary`.
6. Run `npm run package:smoke`.
7. Confirm the package contains only the OSS observer surface listed in `docs/oss-boundary.md`.
8. Confirm the package does not include Cloudflare configs, product code, billing code, runner code,
   research evidence, site assets, secrets, or private operational docs.
9. Document the support policy for security fixes and compatibility.
10. Keep hosted-service features out of Tidelift package claims.

## Current blockers

- The package needs a tagged release process that always runs `check:oss-boundary` and `package:smoke`
  before publish.
- Tidelift/Sonar has not yet accepted or recognized the package.
- The first public install-to-report smoke test still needs to be recorded under
  [`evidence/alpha-install-smoke-01/`](evidence/alpha-install-smoke-01/).

## License

DiffCI Core is AGPL-3.0-only. The AGPL applies to the OSS package boundary recorded in
[`oss-boundary.md`](oss-boundary.md): the engine/client/action surface shipped as `@diffci.com/diffci`.
Commercial DiffCI remains the hosted/control-plane product around that package.

This is compatible with the Tidelift positioning: Tidelift supports the OSS dependency, while DiffCI
Cloud sells hosted history, dashboards, managed operations, policy, and team workflows.

Public policy files:

- [`../SECURITY.md`](../SECURITY.md)
- [`../SUPPORT.md`](../SUPPORT.md)
- [`../COMMERCIAL.md`](../COMMERCIAL.md)
- [`tidelift.md`](tidelift.md)
- [`release-checklist.md`](release-checklist.md)
- [`tidelift-outreach.md`](tidelift-outreach.md)
## Support positioning

Use this phrasing:

> DiffCI's open-source observer is available as a supported npm package. DiffCI Cloud is optional and
> adds hosted reports, shared history, team access, and managed operations.

Avoid this phrasing:

> Tidelift includes DiffCI Cloud.

> Tidelift enables advanced CI optimization.

> The supported package can skip CI.

The supported package observes. Commercial DiffCI operates the hosted product around those observations.
