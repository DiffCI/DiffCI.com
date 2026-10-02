# Commercial repository onboarding

Deployed on 2026-09-25 in product Worker version `31a24449-ec46-4a4b-914b-1c26d3e20cf6`
from release commit `b425aa6`. This is an incremental commercial console feature,
not a declaration that the full commercial product is ready.

The authenticated repository setup page now explains progress through the observer upload path:

| Status | Meaning and next action |
| --- | --- |
| Repository is not active | Check installation/access before setup. |
| Setup status is unavailable | Credential or observation reads failed; reload rather than assuming no data exists. |
| Create a repository credential | No unrevoked, unexpired repository token exists; create one and save the secret. |
| Waiting for the first report | A usable token exists, but no report has arrived; install the workflow and check its run. |
| Latest analysis did not complete | The newest report is refused, errored, or incomplete; inspect its details and rerun. |
| Review the latest report | Identity, checkout integrity, or workflow findings need attention. |
| Observation received | A completed report with verified identity and non-interference evidence arrived. |

Status uses only matching organization/repository records. The latest received report wins even if an
older report succeeded. Expired and revoked credentials cannot establish upload readiness. Receipt
confirms a past upload; it does not establish freshness, prospective safety, realized savings, or
permission to change required CI. Fleet reporting handles longer-term observation quality separately.

No new schema or migration is needed. The own-repository credential-to-report smoke test passed.
Automated coverage exercises tenant scoping, expired
credentials, failure precedence, incomplete evidence, and rendered setup states.

Commercial work still requiring validation includes the complete external customer onboarding loop,
billing-provider integration, and real retention/uninstall behavior.
Managed execution and production savings require their own evidence; this panel does not enable them.

## Public observer installation and deployment evidence

- Production pins `@diffci.com/diffci@0.2.13` with the npm-published SHA-512 integrity value.
  Downloaded package bytes were independently verified against that value.
- Generated workflows use Node 22, download the exact package outside the checkout, verify its
  integrity before installation, and disable package lifecycle scripts. The public observer needs
  only the repository ingest secret; private npm artifacts still use a registry credential.
- Product health confirms `agentArtifactPinned: true` on both app.diffci.com and workers.dev.
- `npx @diffci.com/diffci@latest check` completed the full and selected test commands successfully.
  TypeScript checking and 49 focused onboarding, installer, UI and ingest tests passed.
- A fresh installation of the verified public tarball using `--ignore-scripts` completed a local
  `observe --no-send` run with an unchanged checkout. This is not evidence of a hosted upload.
- Signed-in organization creation succeeded for DiffCI. After the owner confirmed GitHub access,
  the existing App installation was verified as read-only and limited to `DiffCI/DiffCI.com`.
  Its older installation had no pending product webhook record, and GitHub's configuration page did
  not return to setup. Connection therefore used an assisted authenticated callback with fresh state;
  this does not prove unattended existing-installation discovery/reconnection works.
- Created a repository-scoped ingest credential through the console and stored it as the repository's
  `DIFFCI_TOKEN` Actions secret. No credential value is recorded here.
- Draft PR https://github.com/DiffCI/DiffCI.com/pull/10 adds the generated workflow under
  `.github/workflows/diffci-onboarding.yml`, preserving the existing observer workflow.
- Run https://github.com/DiffCI/DiffCI.com/actions/runs/36167933369 succeeded: package installation
  and verification passed, analysis completed, the checkout stayed unchanged, and `delivery: sent`
  was logged. The dashboard independently showed `Observation received` at
  `2026-09-25T17:34:16.539Z` for commit `7545c13c6`.
- The workflow remains in a draft PR, not merged into main. Other required CI checks were still
  pending when this smoke-test evidence was recorded. This report proves upload operation, not
  runtime savings or completion of the entire commercial roadmap.

## Self-service reconnection follow-up (2026-09-25)

The earlier assisted-reconnection gap is addressed by release commit `39a689b`, deployed as product
Worker version `3e889b7e-b344-481a-a62d-c35ae39c0b93`. Organization pages now offer
“Already installed? Connect a repository”. Entering owner/name verifies the app installation, current
GitHub admin permission, and immutable GitHub user identity before connecting only that repository.
The POST requires an authenticated session, CSRF, and DiffCI organization membership. Unknown GitHub
responses fail closed, and repositories belonging to another tenant are not moved.

Validation: the DiffCI check completed both full and selected test commands; TypeScript checking and
18 focused reconnection/UI tests passed. Live browser submission for DiffCI/DiffCI.com succeeded and
preserved the same repository, its one live credential, and both received observations. Anonymous POST
returned 401. Negative authorization cases were tested locally rather than by changing live permissions.

PR #10 is merged after all its checks passed. The observer also passed on main in run
https://github.com/DiffCI/DiffCI.com/actions/runs/36168243245 and the dashboard received the main-branch
report for commit d7179de12. No manual callback is needed for the new reconnect form.

## Delivery-health alerts and second repository (2026-10-01)

DentalPresence is connected as the second repository. PR #114 is merged, and main-branch Actions run
https://github.com/adityankale190895/DentalPresence.in/actions/runs/36899594427 completed successfully,
including the non-blocking DiffCI observation job and a live upload.

Product Worker version `a5bdccad-3077-431f-9e03-a36baf01eaeb` adds repository delivery-health
alerts. A new or replacement credential gets a one-hour grace period; after that, the repository page
flags that no report has arrived. A last successful report older than 48 hours is marked stale and
points the operator to the workflow and Actions log. Failed and unsafe reports retain their more
specific diagnostics.

The observer-side GitHub warning annotation is prepared in PR
https://github.com/DiffCI/DiffCI.com/pull/11 as version 0.2.12. It remains non-blocking. Publishing and
updating the hosted package pin follow that PR's merge and release because this workstation has no npm
authentication.
