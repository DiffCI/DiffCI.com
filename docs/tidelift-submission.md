# Tidelift submission packet

Use this packet when submitting `@diffci.com/diffci` to Tidelift/Sonar for package recognition.

**Draft reviewed 2026-09-25; sending and acceptance are unconfirmed.** Recheck the release and
package scope before sending. Live distribution status is tracked in [`distribution.md`](distribution.md).

## Short ask

Subject: Supported npm package inquiry for `@diffci.com/diffci`

Hello Tidelift team,

We maintain `@diffci.com/diffci`, an AGPL-3.0-only npm package for change-aware CI analysis. We would like to make it available as a supported open-source package through Tidelift.

The `observe` command and basic GitHub Action report proposed test selections without changing required CI. The CLI also offers explicitly invoked `check`, `pilot`, and `verify-savings` commands that execute tests for runtime comparison. DiffCI Cloud is a separate commercial hosted product and is not part of the OSS package support boundary.

Package and project details:

- npm package: https://www.npmjs.com/package/@diffci.com/diffci
- releases: https://github.com/DiffCI/DiffCI.com/releases (confirm the intended release before sending)
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

## Release evidence

- A direct npm registry query on 2026-09-25 returned `0.2.11` for `latest`.
- This checkout's release manifest targets `0.2.9`; see [`distribution.md`](distribution.md).
- `docs/evidence/alpha-install-smoke-01/README.md` records a historical `0.1.3` install smoke,
  not validation of the current release or the full hosted onboarding loop.
- Before sending, attach the intended release's workflow results, provenance, package-boundary checks,
  and smoke evidence using [`release-checklist.md`](release-checklist.md).
