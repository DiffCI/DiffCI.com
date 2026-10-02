# Diagram code-completeness boundary

The product architecture represented by the DiffCI open-core/commercial diagram has an implemented
code path for every software-owned capability. This statement concerns repository and deployed-system
capability. It does not claim customer adoption, revenue, a contractual SLA, accelerator acceptance,
or a Linux Foundation/OpenSSF/LFX relationship.

| Diagram capability | Implemented surface |
| --- | --- |
| Shadow / analyzer | Local observer, prospective shadow pipeline, reconciliation and public bounded analyzer |
| CI waste detection | Affected-test selection, full/path comparison and paired runtime measurement |
| Impact estimation | Git delta, dependency graph, language adapters, confidence and fallback |
| Local execution | `verify`, `check`, `pilot` and `verify-savings` |
| Basic integrations | npm CLI, GitHub Action/App, MCP and coding-agent instructions |
| Hosted service | Cloudflare product Worker, organization/repository tenancy, authenticated report ingest and Lemon Squeezy Merchant-of-Record billing |
| Acceleration | Structured ephemeral-runner execution, immutable commit policy, bounded commands and fail-closed repository authorization |
| Dashboards | Organization, repository onboarding, reports, delivery health and fleet windows |
| Enterprise policy | Revision-checked evidence policy, append-only managed-execution consent and audit history |
| Fleet analytics | Current/previous evidence windows, safety totals, availability and freshness findings |
| Support / SLA readiness | Health endpoints, audit records, lifecycle diagnostics, retention, uninstall and runbooks |
| Advanced optimization | Safety budgets, audit sampling, always-run cohorts, economic gates and controlled runtime comparisons |

Managed repository execution stays `observation_only` by default. Enabling verification requires an
owner/admin, a repository-scoped append-only consent revision, an active same-tenant repository, a full
immutable commit SHA, a configured runner provider and a pinned agent artifact. The scheduler refuses
every repository job unless its caller supplies a successful authorization decision. Reporting policy
alone cannot authorize execution.

Code completion does not turn experimental evidence into a production-savings claim. External pilot
evidence decides when a consented repository should use the managed verification path. Lemon Squeezy is
the sole Merchant of Record in the code contract; billing becomes live only after its credentials,
products, variants and webhook are configured. Formal support response times become
an SLA only after DiffCI offers and staffs the contract.

The remaining diagram branches are external outcomes:

- independent users, maintainers and ecosystem distribution;
- npm trusted-publisher registration (the workflow is OIDC-ready);
- Lemon Squeezy account, product, variant, webhook and payout configuration;
- paid support commitments and revenue;
- YC/VC funding;
- Linux Foundation, OpenSSF and LFX participation or acceptance.
