# Tidelift outreach draft

Draft reviewed 2026-09-25. npm publication is complete; recheck the intended release's metadata,
support policies, and package-boundary checks before sending. No sending or acceptance confirmation
is recorded here. See [`distribution.md`](distribution.md) for the dated live status.

## Short ask

Subject: Supported npm package inquiry for `@diffci.com/diffci`

Hello Tidelift team,

We maintain `@diffci.com/diffci`, an AGPL-3.0-only npm package for change-aware CI analysis. We
would like to make it available as a supported open-source package through Tidelift.

The `observe` command and basic GitHub Action report proposed selections without changing required CI.
The CLI's explicitly invoked `check`, `pilot`, and `verify-savings` commands execute tests for runtime
comparison. DiffCI Cloud is a separate commercial hosted product outside the OSS package support boundary.

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
- current release qualification and install evidence (the `alpha-install-smoke-01` record is historical `0.1.3` evidence)
