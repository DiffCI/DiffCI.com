# Tidelift submission packet

Use this packet when submitting `@diffci.com/diffci` to Tidelift/Sonar for package recognition.

## Short ask

Subject: Supported npm package inquiry for `@diffci.com/diffci`

Hello Tidelift team,

We maintain `@diffci.com/diffci`, an AGPL-3.0-only npm package for observation-only CI analysis. We would like to make it available as a supported open-source package through Tidelift.

DiffCI Core runs in a customer's own CI environment, keeps source code local, and reports what DiffCI would have selected. It does not skip, cancel, reorder, block, or modify CI. DiffCI Cloud is a separate commercial hosted product and is not part of the OSS package support boundary.

Package and project details:

- npm package: https://www.npmjs.com/package/@diffci.com/diffci
- latest release: https://github.com/DiffCI/DiffCI.com/releases/tag/v0.1.3
- repository: https://github.com/DiffCI/DiffCI.com
- ecosystem: npm / JavaScript / TypeScript
- license: AGPL-3.0-only
- supported surfaces: CLI, local observation report, workflow verifier, basic GitHub Action
- package boundary: enforced by `npm run check:oss-boundary`
- release smoke: `npm run package:smoke`
- security policy: `SECURITY.md`
- support policy: `SUPPORT.md`
- commercial boundary: `COMMERCIAL.md`
- public install evidence: `docs/evidence/alpha-install-smoke-01/README.md`

We are looking for guidance on whether this package can be recognized or onboarded for Tidelift support, and what further maintainer metadata or process evidence you need.

Thank you,

DiffCI maintainers

## Boundaries to preserve

Tidelift support should apply only to DiffCI Core, the public npm dependency. It should not include DiffCI Cloud, hosted dashboards, organization management, private report access, historical analytics, enterprise policies, managed runners, billing, or commercial onboarding.

## Current release evidence

- `@diffci.com/diffci@0.1.3` is published on npm under the `latest` dist-tag.
- The release was published from GitHub Actions with npm provenance.
- The release workflow passed `npm run check`, `npm run build:client`, `npm run check:oss-boundary`, and `npm run package:smoke`.
- Public install evidence is recorded under `docs/evidence/alpha-install-smoke-01/README.md`.
