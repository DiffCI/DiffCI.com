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

No new schema or migration is needed. An authenticated install-to-report smoke test remains pending.
Automated coverage exercises tenant scoping, expired
credentials, failure precedence, incomplete evidence, and rendered setup states.

Commercial work still requiring validation includes the complete external customer onboarding loop,
billing-provider integration, and real retention/uninstall behavior.
Managed execution and production savings require their own evidence; this panel does not enable them.

## Public observer installation and deployment evidence

- Production pins `@diffci.com/diffci@0.2.11` with the npm-published SHA-512 integrity value.
  Downloaded package bytes were independently verified against that value.
- Generated workflows use Node 22, download the exact package outside the checkout, verify its
  integrity before installation, and disable package lifecycle scripts. The public observer needs
  only the repository ingest secret; private npm artifacts still use a registry credential.
- Product health confirms `agentArtifactPinned: true` on both app.diffci.com and workers.dev.
- `npx @diffci.com/diffci@latest check` completed the full and selected test commands successfully.
  TypeScript checking and 49 focused onboarding, installer, UI and ingest tests passed.
- A fresh installation of the verified public tarball using `--ignore-scripts` completed a local
  `observe --no-send` run with an unchanged checkout. This is not evidence of a hosted upload.
- Signed-in organization creation succeeded for the DiffCI organization. GitHub shows an existing
  DiffCI App installation for the DiffCI account, but entering its configuration requires the owner's
  passkey/authenticator confirmation. Repository connection, credential creation, the CI upload and
  the dashboard's first observation have not yet been verified. No new ingest secret was created.
