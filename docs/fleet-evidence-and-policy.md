# Fleet evidence and organization reporting policy

The signed-in organization console now includes a fleet evidence panel. It compares each connected,
non-removed repository over two equal rolling windows, lists evidence gaps and keeps failed reads
explicitly unavailable. This is a commercial reporting capability, outside the npm OSS package.

## What the panel measures

- Prediction counts and SELECTIVE/FULL counts for the current and preceding windows.
- Distinct predictions with at least one verified, prospective CI outcome. Retry attempts cannot
  inflate the verification percentage above 100%.
- Evaluable, preserved and missed failures across verified prospective attempts. These are attempt
  counts, not deduplicated unique test failures.
- Measured analysis overhead and the latest prediction timestamp in each window through the API.
- Change in selective percentage, in percentage points; absent comparison data remains unknown.

Window membership uses prediction creation time with an inclusive start and exclusive end. Outcomes
must match prediction repository, commit and logical delta. Unverified, contaminated and retrospective
outcomes are excluded. A failed repository read is excluded from totals and listed as unavailable.
Repository names come from the authenticated organization's product records, never caller-supplied
research scopes. Removed repositories are not read.

Meeting reporting policy means only that these reporting thresholds were met. It does not authorize
selective CI execution, establish production savings or constitute an SLA. Policies cannot disable the
missed-failure warning. Changing policy never changes CI jobs, runners or required checks.

## Policy and audit history

Members can read the fleet and policy. Owners/admins can change the five numeric thresholds in the
organization console. Defaults are a seven-day window, maximum observation age of 48 hours, ten
predictions, five verified predictions and one evaluable failure. These are configurable reporting
defaults, not statistically qualified enforcement thresholds.

The API requires the current revision when saving. A stale editor receives HTTP 409 and must reload.
Each save atomically appends a revision containing the complete policy, actor and timestamp; the
application has no update/delete operation for these records. The API/UI return the latest 100
revisions. This is application-level history, not a tamper-proof external audit archive.

## API

- `GET /v1/organizations/:id/fleet`: current/previous evidence, findings, totals and unavailable repos.
- `GET /v1/organizations/:id/evidence-policy`: current policy, history and edit permission.
- `PUT /v1/organizations/:id/evidence-policy`: `{ "expectedRevision": 0, "policy": { "windowDays": 7,
  "maxObservationAgeHours": 48, "minimumPredictions": 10, "minimumVerifiedPredictions": 5,
  "minimumEvaluableFailures": 1 } }`.

All routes require authentication and organization membership. PUT requires owner/admin role and
signed session CSRF protection; missing CSRF configuration fails closed. Unknown policy fields,
non-integers and out-of-range values are rejected. Responses use `Cache-Control: no-store`.

## Deployment

Apply the additive product migration before deploying the product Worker:

```powershell
npx tsx scripts/migrate-product-db.ts --remote
npm run product:deploy
```

The migration list includes `src/product/cloudflare/schema-evidence-policy.sql`; rerunning it is
idempotent. Research schema changes are not needed. No remote migration or deployment is performed
by the code change itself. If the policy table is missing, the console shows unavailable and API
requests return 503, rather than silently using defaults for an unreadable saved policy.

The existing dashboard also now sums safety across its own repositories, never the global research
database for an empty organization. Savings lookups reject foreign or removed repository names;
recent prediction activity is ordered across repositories before applying its display limit.
