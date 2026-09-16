# DiffCI organization runner

The transfer to `DiffCI/DiffCI.com` requires a separate organization-owned private Runner app.
The existing private `DiffCI GitHub Runner` app belongs to `adityankale190895` and also serves
DentalPresence. GitHub warns that transferring that app would uninstall it from the personal account.
The organization fleet therefore uses separate credentials and infrastructure.

## Deployment boundaries

| Resource | Organization fleet | Existing personal fleet |
| --- | --- | --- |
| GitHub App | DiffCI Organization Runner (`4961138`) | DiffCI GitHub Runner |
| Worker config | `wrangler.github-runner-org.jsonc` | `wrangler.github-runner.jsonc` |
| Worker | `diffci-org-github-runner` | `diffci-github-runner` |
| Queue | `diffci-org-runner-dispatch` | `diffci-runner-dispatch` |
| Lifecycle database | `diffci-org-runner` | `diffci-research` |
| App installation scope | Only `DiffCI/DiffCI.com` | Existing personal-account installation |

The organization Worker, queue, database schema, and container application were deployed on
2026-09-16. The initial deployment version is `33efb974-e219-4cfe-bc9c-8a43c5bb5c79`.
The private app is registered under DiffCI, all four Worker secrets are stored, and installation
`162092319` grants access only to `DiffCI/DiffCI.com`. GitHub's signed installation event received
HTTP 202. The authenticated Worker app diagnostic confirms the new app identity and intended
permissions. Unauthenticated diagnostics, token requests, and unsigned webhooks each return HTTP 401.
End-to-end execution is verified at commit `e5ff6c7`: [observation run 35054804932](https://github.com/DiffCI/DiffCI.com/actions/runs/35054804932)
passed on `cf-job-104662610822`. [CI run 35054804933](https://github.com/DiffCI/DiffCI.com/actions/runs/35054804933)
completed on `cf-job-104662610924`, passed checkout, dependency installation and type-checking, and
failed at the application Test step. Runner provisioning and application-test outcomes are separate.

Both Workers run the same dispatcher implementation, but have separate queues, lifecycle records,
container namespaces and credentials. The new reconciler cannot enumerate the old fleet's database.
The five-container ceiling bounds concurrent execution; containers are started on demand.

## App configuration

Use [`diffci-org-runner-app-manifest.json`](../ops/github-app/diffci-org-runner-app-manifest.json)
with GitHub's [manifest registration flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
Registration owner must be **DiffCI** and visibility must be **private**.

- Repository permissions: Administration read/write, Actions read/write, Metadata read.
- Events: `workflow_job` only.
- Webhook: `https://diffci-org-github-runner.damp-waterfall-0cd8.workers.dev/webhook`.
- Install only on `DiffCI/DiffCI.com`; do not select all repositories.
- No user OAuth flow, account permissions, or organization permissions are required.

The manifest callback must validate a random `state`, convert the generated RSA key to PKCS#8,
and avoid printing private keys, webhook secrets, client secrets, or installation tokens.
Store credentials in an ignored, access-restricted temporary location, upload to Worker secrets,
then remove local credential copies after successful verification. Never commit credentials.

## Worker secrets and deployment

The new Worker needs its own `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8),
`GITHUB_WEBHOOK_SECRET`, and `RUNNER_DISPATCH_TOKEN`. Do not reuse or overwrite the personal fleet's secrets.
The installation ID comes from each webhook; no personal-account fallback installation ID is configured.

```powershell
npx wrangler deploy --config wrangler.github-runner-org.jsonc
```

For a new database, apply only the standalone runner lifecycle schema:

```powershell
npx wrangler d1 execute diffci-org-runner --remote --config wrangler.github-runner-org.jsonc --file src/research/cloudflare/schema-migration-2026-09-05-runner-job-lifecycle.sql
```

The authenticated diagnostics use `RUNNER_DISPATCH_TOKEN`. Leave `/installation-token` and diagnostics
inaccessible without that token. Unsigned webhook calls must be rejected.

## Verification

The existing 13 runner dispatch, batching and lifecycle-store tests pass. The runs above demonstrate
signed deliveries, assignment to the new fleet and execution completion; lifecycle records also show
the observation runner's `exec-succeeded` disposal. The personal installation `155363973` was inspected
after setup and remains active with only `adityankale190895/DentalPresence.in` selected.

Jobs queued before installation may not receive a fresh `workflow_job.queued` delivery. Re-run a chosen
workflow or redeliver its queued event to seed the new lifecycle store; the reconciler only knows
repositories it has observed. Do not bulk replay unrelated historical jobs.

The read-only Shadow App is a separate integration. Registering the Runner app does not restore shadow
observation or grant the Runner permission to read repository contents through its installation token.
