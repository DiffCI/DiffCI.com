# GitHub organization setup and migration

Updated 2026-09-16. Organization, repository transfer, isolated Runner setup and read-only Shadow
installation are complete. Core extraction remains unfinished. Unchecked steps are not completed.

## Verified starting point

- Repository: [`DiffCI/DiffCI.com`](https://github.com/DiffCI/DiffCI.com), private, default branch `main`.
  Transferred from `adityankale190895/DiffCI.com` on 2026-09-16.
- Authenticated CLI account: `adityankale190895`, with repository admin rights.
- Organization `DiffCI` exists on GitHub Free; `adityankale190895` is an active owner.
- Default repository permission is `none`. The public `.github` repository contains the profile README.
- Engine, hosted services, website, research, and deployment configuration currently share a repository.
- Transfer checks confirmed no protected branches, Pages site, repository environments, Actions
  variables, repository webhooks, deploy keys, or registered runners. Rulesets were unavailable on
  the source private repository's plan. The `CLOUDFLARE_API_TOKEN` secret name remains present after transfer.
- PR #2 and its branch are preserved. The shared local `origin` now points to the organization URL.
- A separate private organization Runner app (`4961138`) is now installed only on `DiffCI/DiffCI.com`
  (installation `162092319`), with a separate Worker, queue, database and secrets. See
  [organization runner setup](github-app-registration-org-runner.md). The personal-account Runner app
  was neither transferred nor made public, preserving its DentalPresence installation.
  The read-only Shadow app is restored as installation `162093948`, only on `DiffCI/DiffCI.com`;
  its signed installation event auto-enrolled the private repository and identified its CI workflow.
  The obsolete personal-owner enrollment is paused with historical evidence retained. See
  [Shadow restoration](github-app-registration.md#organization-restoration-2026-09-16).
  CI uses ephemeral runners dispatched by
  the Runner app; zero registered runners at rest does not imply that no runner integration exists.
- Before transfer, PR #2's CI run `35053164610` failed at the Test step, while observation run
  `35053164643` succeeded. After restoring the runner, observation run `35054804932` succeeded;
  full CI run `35054804933` completed checkout, install and type-checking, then failed at Test.
  See [runner verification](github-app-registration-org-runner.md) for the execution evidence.

## Organization and repository layout

Name/handle: **DiffCI**. Website: `https://diffci.com`.
Description: **Change-aware CI: an open analysis engine and a managed cloud platform.**
Current plan: GitHub Free. Owner: `adityankale190895`. The owner completed signup in Chrome.

| Repository | Visibility | Purpose |
| --- | --- | --- |
| `.github` | Public, created | Published organization profile at `profile/README.md`; source copy in `docs/github-org/profile/README.md` |
| `DiffCI.com` | Private, transferred | Existing mixed repository with its history and pull requests |
| [`core`](https://github.com/DiffCI/core) | Public, created | Independent AGPL-3.0-only engine, tests, synthetic benchmark and measurement tools |
| `cloud` | Not created; possible future private rename/extraction | Hosted product currently remains in private `DiffCI.com` |
| `enterprise` | Not created, optional | Decide terms and scope before exposing any enterprise source |

Retain the existing repository name during the ownership move. Treat code extraction and any later
rename as separate operations so that deployment changes can be diagnosed independently.

## Execution checklist

- [x] Sign in at [organization setup](https://github.com/organizations/plan), select the free plan,
  validate the handle, and complete owner/contact details and any required verification/terms.
- [x] Verify organization ownership and least-privilege default membership permissions.
- [x] Create public `.github` with only the prepared organization profile; no private project history.
- [ ] Inventory branch protections/rulesets, Actions configuration, environments, secrets by name,
  variables, deploy keys, webhooks, GitHub App installations, runner registrations, and deployment integrations.
- [x] Check feature availability before transfer: moving a private repository to GitHub Free can remove
  features such as protected branches and GitHub Pages. Resolve any affected dependency first.
- [x] Transfer `adityankale190895/DiffCI.com` to the verified organization, preserving private visibility.
  Verify destination ownership, access, default branch, issues, and pull requests.
- [ ] Update local remotes and owner-qualified URLs in CI, action consumers, badges, documentation,
  app enrollment/allowlists, deployment systems, and external integrations using the actual destination.
  Do not blindly rewrite historical evidence or source attribution.
- [ ] Verify GitHub App access and webhook deliveries, runner access, deployment credentials, and an
  ordinary CI run. Git redirects do not validate those integrations.
- [x] Audit and extract Core according to [the licensing boundaries](licensing.md), with its own package,
  build, tests, CLI example, reproducible benchmark, full license, and third-party notices.
- [x] Check the complete proposed public content and history for credentials, customer/private data,
  proprietary code, fixture redistribution rights, and inherited third-party obligations.
- [x] Publish the audited Core and update profile links to the actual repositories.

Do not make the existing mixed repository public or add a blanket AGPL license as a shortcut to extraction.
Do not create a replacement repository at the old URL after transfer: that can break GitHub redirects.

References: [creating an organization](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/creating-a-new-organization-from-scratch),
[transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository).
