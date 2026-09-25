# DiffCI alpha readiness

**Date:** 2026-09-19

This is the working checklist for turning the current DiffCI codebase into a credible private alpha. The
goal is not selective CI enforcement. The alpha promise is narrower:

> Install DiffCI, keep CI unchanged, observe real runs, and show a trustworthy report of potential avoided
> test work.

The packaging model is open core: the local observer and basic Action remain useful without an account,
while DiffCI Cloud adds history, teams, policy, reports, managed operations, and support. See
[`open-core-packaging.md`](open-core-packaging.md).

## Current product shape

| Area | Status | Alpha bar |
|---|---|---|
| Analysis engine | Built and validated through historical and shadow pipelines. | No new engine work required for alpha unless live observation finds a blocker. |
| CLI | `diffci observe`, `diffci verify-workflow`, and `diffci version` exist in `src/client/cli.ts`. | Package smoke test passes and install docs use the published artifact. |
| GitHub Action | `action.yml` runs the observer as an inert job, writes a report, uploads an artifact, and optionally submits to DiffCI. | One copy-paste workflow works in a fresh repository. |
| GitHub App | Shadow and install paths exist as separate App flows. Read-only observation is the trust boundary. | App install lands the user on the right setup/report flow without operator intervention. |
| Hosted service | Product and research Workers exist with auth, ingest, reports, billing primitives, cron, retention, and shadow telemetry. | A design partner can sign in, connect a repo, install DiffCI, and see a report link. |

## Private alpha exit criteria

DiffCI is ready for a private alpha when all of these are true:

1. A new repository can be onboarded from public docs without a founder editing D1 by hand.
2. The generated workflow passes `diffci verify-workflow`.
3. A real GitHub Actions run produces a `diffci.observation.v1` report artifact.
4. If an ingest token is configured, the report is accepted by the hosted service and appears in the
   owning organization only.
5. The public/private report route explains one of these states clearly: observing, awaiting evidence,
   insufficient data, potential opportunity, or unsupported.
6. The report never claims realized savings, enforcement readiness, or billable value from shadow-mode
   observations.
7. Retention and uninstall behavior have been tested against a real installed repository, not only
   fixtures.
8. At least three repositories have seven calendar days of observation, with at least one repository
   producing discriminative opportunities and reconciled ground truth.

## Immediate work

### 1. Smoke-test the install loop

Use one disposable repository and run the full path as a user would:

```bash
npx "@diffci.com/diffci@latest" verify-workflow
npx "@diffci.com/diffci@latest" observe
```

Then install the GitHub Action with the hosted `api-url` and repository token. Capture:

- the workflow file used;
- the action run URL;
- the report artifact;
- the ingest response;
- the hosted report URL;
- the `verify-workflow` output.

Store the result under `docs/evidence/alpha-install-smoke-01/`.

### 2. Reconcile docs with the current implementation

Several phase documents are historical and intentionally describe the state when they were written.
Before external onboarding, every public-facing doc should point to the current install path:

- `README.md`;
- `docs/distribution.md`;
- `docs/open-core-packaging.md`;
- `docs/tidelift-package-support.md`;
- `docs/npm-adoption.md`;
- `docs/github-app-registration.md`;
- `docs/shadow-pilot-runbook.md`;
- `site/welcome.html`;
- `site/data-handling.html`.

Historical reports can remain historical, but they should not be the first thing a new installer reads.

### 3. Keep three trust boundaries crisp

- The observer runs in the customer's CI and changes nothing.
- The Shadow App is read-only and never shares permissions with the runner dispatcher.
- Hosted reports show potential opportunity from shadow evidence, not realized savings.
- The OSS core produces local observations; DiffCI Cloud stores and compares history across runs.

Any alpha copy, dashboard text, report title, or outreach message should preserve those boundaries.

### 4. Pick the first cohort

The alpha needs active repositories, not just compatible repositories. A good first cohort has:

- GitHub Actions running on the default branch;
- TypeScript or JavaScript at the repository root, with a root `tsconfig.json`;
- recent commits, ideally several per week;
- test jobs that are identifiable without custom founder knowledge;
- maintainers willing to share seven days of artifacts or use hosted ingest.

Start with three repositories. Do not grow the cohort until all three have one clean install-to-report
cycle.

## Stop conditions

Pause alpha onboarding if any of these happens:

- a DiffCI job changes another job's conclusion or required-check behavior;
- the hosted service accepts an observation into the wrong repository or organization;
- a report presents contaminated or unverified evidence as verified;
- an uninstall leaves active ingest credentials for the removed repository;
- the Shadow App or observer asks for write permissions.

These are product-trust failures, not ordinary bugs. Fix them before adding more repositories.
