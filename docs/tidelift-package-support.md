# Tidelift package support readiness

**Reviewed:** 2026-09-25

Tidelift support belongs to the open-source core. It should support the npm package
`@diffci.com/diffci` as a maintained dependency, while DiffCI Cloud remains the hosted commercial
product.

## Scope

The proposed support scope covers the OSS package; Tidelift acceptance is not confirmed:

- `diffci observe`;
- `diffci verify-workflow`;
- the basic GitHub Action;
- local report generation;
- optional report submission to a configured endpoint and token.

The current CLI also includes `check`, `pilot`, and `verify-savings`, which execute test commands.
Agree the support scope for these commands during onboarding. Only `observe` and the basic Action
should be described as observation-only; required CI remains unchanged.

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

## Current status

- The live npm `latest` version was `0.2.11` when queried on 2026-09-25. See the dated
  [distribution status](distribution.md) for the distinction between live and checkout versions.
- Publishing is handled by `.github/workflows/release.yml` from a Git tag with npm provenance.
- Release CI runs `npm run check`, `npm run build:client`, `npm run check:oss-boundary`, and
  `npm run package:smoke` before publish.
- Historical public install evidence for `0.1.3` is recorded under
  [`evidence/alpha-install-smoke-01/`](evidence/alpha-install-smoke-01/).
- No submission confirmation or Tidelift/Sonar acceptance is recorded here. Preparation is complete
  enough to maintain a draft; recheck current package contents and release evidence before sending it.

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

> DiffCI's open-source CLI and observer Action are publicly available. Tidelift support is proposed
> and not yet confirmed. DiffCI Cloud is a separate commercial hosted product.

Avoid this phrasing:

> Tidelift includes DiffCI Cloud.

> Tidelift enables advanced CI optimization.

> The supported package can skip CI.

The observer reports potential selections; explicitly invoked CLI runtime checks execute tests.
Commercial DiffCI operates the hosted product around those observations.
