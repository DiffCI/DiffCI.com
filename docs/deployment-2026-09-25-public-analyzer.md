# Public analyzer deployment — September 25, 2026

Live URL: https://app.diffci.com/analyzer

## Release identity

Deployed from isolated branch `codex/hosted-analyzer-release`. Unrelated website and adoption edits in the original checkout were excluded. The branch is local; it has not been pushed.

| Component | Source commit | Cloudflare version |
| --- | --- | --- |
| Research Worker and source archive | `cbefc2e01e0aebb4453757ce5c0c0602efe0e2a7` | `c3ac894f-c0a4-48f3-a945-92aae2ad4efe` |
| Product Worker | `a140a602364012095cb0ac464b6ae564c5058338` | `cc3ede77-34e3-49f0-9aab-958cb2b0c37e` |

The product follow-up fixes add bounded error logging and Cloudflare-compatible redirect rejection. Workers does not implement `redirect: "error"`; the deployed analyzer uses `manual` and explicitly refuses 3xx responses. The research source remains the exact committed archive identified above.

## Completed

- Applied the ordered product migrations, including hosted jobs/rate counters and evidence policies.
- Added `ANALYZER_RATE_SECRET`; confirmed the existing `CSRF_SECRET` configuration.
- Enabled `DIFFCI_PUBLIC_ANALYZER_ENABLED` and deployed both Workers.
- Published the committed research archive using authenticated Wrangler R2 commands. Downloaded it again and verified SHA-256 `e22c2bccc11a3fa5d534870a9c0fb00e7e7efe3a95c2826c3de3dfdf3750a0f2`. Verified the remote metadata pointer and the deployed `EXPECTED_SOURCE_SHA` match the research commit.
- Corrected a pre-existing mismatch between the old research Worker's expected source and the previous R2 archive pointer.

The authenticated research HTTP dispatch token was not available locally. Consequently, archive verification used Cloudflare's authenticated control plane and R2 readback; the protected `/v1/shadow/cron-status` HTTP endpoint was not queried.

## Validation

Release snapshot: `npm run check` passed with 2,278 tests passing, seven skipped, and zero failures. Follow-up analyzer/HTTP tests passed (12 tests), and final TypeScript checking passed. The duplicate DiffCI paired runtime run was interrupted to relieve memory pressure; it supplies no valid runtime-savings claim.

Live checks passed:

- Analyzer page: HTTP 200, restrictive CSP, `no-store`.
- Product/research health: HTTP 200; product database, auth, CSRF and queue checks healthy.
- Unauthenticated fleet access: HTTP 401.
- Missing diagnostic consent: HTTP 400.
- Wrong result token: HTTP 404.
- Public diagnostic of `microsoft/TypeScript`: completed at commit `cecc44acba99418857eb7ebda55b8f5e326e0d05`, honestly classified `needs_local_diagnosis`.
- Result deletion: succeeded, followed by HTTP 404 on retrieval.
- Submission limit: HTTP 429 with `Retry-After: 3600`. Test traffic used two egress identities, so the initial smoke harness's assumption of one identity across every request was corrected during verification.
- Unknown report access: HTTP 404 with `no-store`, through both the product proxy and research endpoint.

Deployment test jobs were deleted. Temporary request-tail logs were removed; no bearer tokens or secret values are recorded here.

## Limits of this deployment verification

No real customer installation was removed. Uninstall races, expiry, cross-tenant ownership and runner lifecycle regressions were exercised by automated tests, not destructive production smoke tests. General customer CI execution, hostile-code sandbox validation, billing configuration, and a production SLA are not certified by this release. Product health still reports the pre-existing `agentArtifactPinned=false` and `billingConfigured=false` conditions.

Prior product version: `629fdde9-57c3-4a1e-a178-4cfec496b72e` (before the added analyzer secret). Prior research version: `04356cae-c2b0-44b7-a7f2-faa7d6ad9d4f`. The old archive pointer named `b3249b37eb3ce0076636fce40acf662fcd99ecc0`, while the old Worker expected `22fc8f073d7ae9ce4b47fa66eb27f621607d786e`; those prior artifacts must not be assumed to form a healthy rollback pair.
