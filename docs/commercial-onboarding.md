# Commercial repository onboarding

Implemented in the checkout on 2026-09-25. This is an incremental commercial console feature,
not a production deployment or a declaration that the full commercial product is ready.

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

No new schema or migration is needed. Deployment requires the normal product Worker release and
an authenticated install-to-report smoke test. Automated coverage exercises tenant scoping, expired
credentials, failure precedence, incomplete evidence, and rendered setup states.

Commercial work still requiring validation includes the complete external customer onboarding loop,
deployed fleet/policy migrations, billing-provider integration, and real retention/uninstall behavior.
Managed execution and production savings require their own evidence; this panel does not enable them.
