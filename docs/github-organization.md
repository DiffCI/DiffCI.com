# GitHub organization setup and migration

Prepared 2026-09-16. This document records intended setup; unchecked steps are not completed.

## Verified starting point

- Source repository: `adityankale190895/DiffCI.com`, private, default branch `main`.
- Authenticated CLI account: `adityankale190895`, with repository admin rights.
- No organizations were returned by the authenticated account's organization listing.
- The public account lookup for `DiffCI` returned 404. Availability remains unconfirmed until the
  organization signup form accepts the name; a 404 does not reserve a handle.
- Engine, hosted services, website, research, and deployment configuration currently share a repository.
- Browser organization setup currently requires GitHub sign-in.

## Intended organization

Name/handle: **DiffCI**, if available. Website: `https://diffci.com`.
Description: **Change-aware CI: an open analysis engine and a managed cloud platform.**
Start with GitHub Free unless an identified repository feature requires another plan.
Use the authenticated account as initial owner. The owner must supply the appropriate contact/billing
email and whether the organization belongs to an individual or a legal entity during signup.

| Repository | Visibility | Purpose |
| --- | --- | --- |
| `.github` | Public | Organization profile at `profile/README.md`; copy the prepared profile from `docs/github-org/profile/README.md` |
| `DiffCI.com` | Private initially | Transfer the existing mixed repository with its history, issues, and deployment context |
| `core` | Public only after release audit | Extracted, independently buildable AGPLv3 engine, tests, benchmarks, and measurement tools |
| `cloud` | Private | Extracted hosted product and operational infrastructure |
| `enterprise` | Private initially, optional | Enterprise code; decide terms and publication scope before exposing it |

Retain the existing repository name during the ownership move. Treat code extraction and any later
rename as separate operations so that deployment changes can be diagnosed independently.

## Execution checklist

- [ ] Sign in at [organization setup](https://github.com/organizations/plan), select the free plan,
  validate the handle, and complete owner/contact details and any required verification/terms.
- [ ] Verify organization ownership and least-privilege default membership permissions.
- [ ] Create public `.github` with only the prepared organization profile; no private project history.
- [ ] Inventory branch protections/rulesets, Actions configuration, environments, secrets by name,
  variables, deploy keys, webhooks, GitHub App installations, runner registrations, and deployment integrations.
- [ ] Check feature availability before transfer: moving a private repository to GitHub Free can remove
  features such as protected branches and GitHub Pages. Resolve any affected dependency first.
- [ ] Transfer `adityankale190895/DiffCI.com` to the verified organization, preserving private visibility.
  Verify destination ownership, access, default branch, issues, and pull requests.
- [ ] Update local remotes and owner-qualified URLs in CI, action consumers, badges, documentation,
  app enrollment/allowlists, deployment systems, and external integrations using the actual destination.
  Do not blindly rewrite historical evidence or source attribution.
- [ ] Verify GitHub App access and webhook deliveries, runner access, deployment credentials, and an
  ordinary CI run. Git redirects do not validate those integrations.
- [ ] Audit and extract Core according to [the licensing boundaries](licensing.md), with its own package,
  build, tests, CLI example, reproducible benchmark, full license, and third-party notices.
- [ ] Check the complete proposed public content and history for credentials, customer/private data,
  proprietary code, fixture redistribution rights, and inherited third-party obligations.
- [ ] Publish the audited Core and update profile links to the actual repositories.

Do not make the existing mixed repository public or add a blanket AGPL license as a shortcut to extraction.
Do not create a replacement repository at the old URL after transfer: that can break GitHub redirects.

References: [creating an organization](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/creating-a-new-organization-from-scratch),
[transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository).
