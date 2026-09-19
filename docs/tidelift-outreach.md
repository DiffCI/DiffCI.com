# Tidelift outreach draft

Use this after publishing the next npm release with AGPL metadata, support policies, and package-boundary
checks.

## Short ask

Subject: Supported npm package inquiry for `@diffci.com/diffci`

Hello Tidelift team,

We maintain `@diffci.com/diffci`, an AGPL-3.0-only npm package for observation-only CI analysis. We
would like to make it available as a supported open-source package through Tidelift.

DiffCI Core runs in a customer's own CI environment, keeps source code local, and reports what DiffCI
would have selected. It does not skip, cancel, reorder, block, or modify CI. DiffCI Cloud is a separate
commercial hosted product and is not part of the OSS package support boundary.

Package and project details:

- npm package: `@diffci.com/diffci`
- ecosystem: npm / JavaScript / TypeScript
- license: AGPL-3.0-only
- supported surfaces: CLI, local observation report, workflow verifier, basic GitHub Action
- package boundary: enforced by `npm run check:oss-boundary`
- release smoke: `npm run package:smoke`
- security policy: `SECURITY.md`
- support policy: `SUPPORT.md`
- commercial boundary: `COMMERCIAL.md`

We are looking for guidance on whether this package can be recognized or onboarded for Tidelift support,
and what further maintainer metadata or process evidence you need.

Thank you,

DiffCI maintainers

## Attach or link

- `docs/tidelift.md`
- npm package URL
- GitHub repository URL
- latest release tag
- install evidence under `docs/evidence/alpha-install-smoke-01/`
