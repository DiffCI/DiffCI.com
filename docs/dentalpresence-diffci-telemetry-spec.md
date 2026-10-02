# DentalPresence and DiffCI telemetry specification

Draft v1 — 2 October 2026. This specification makes DentalPresence a prospective validation partner for DiffCI while preserving separate brands and existing release gates. It defines proposed collection and benchmark requirements; it does not assert that the collection pipeline is implemented or that savings have been demonstrated.

Implementation includes DentalPresence's aggregate full-test collector, PR workflow extension, and separate paired experiment; DiffCI provides `evidence:dentalpresence` and `evidence:dentalpresence-pairs` artifact consumers. The DentalPresence repository documents these at `docs/operations/diffci-design-partner.md` and `docs/operations/paired-ci-evidence.md`. The pair protocol freezes same-commit predictions, runs fresh isolated checkouts, hashes per-test identities, and detects possible omitted failures. It does not yet establish classified regression recall, controlled multi-run economics, hosted learning, or production linkage. The checked-in workflow description below records the baseline inspected before those increments.

## Current repository evidence

The inspected DentalPresence checkout has `.github/workflows/diffci-observe.yml`, an independent, non-blocking observation workflow pinned to DiffCI 0.2.11. Observation runs no tests. Its Node 22 runtime is the observer runtime, not the application's Node 24.16.0 test environment.

`.github/workflows/cloudflare-staging-deploy.yml` runs `npm run check` and `npm run validate:aws` on eligible PRs. Its deployment job runs `npm test` on eligible non-PR events. Overflow can move main-branch work to Cloudflare Workers Builds. Consequently neither an observation success nor a PR check success establishes a completed full test suite. These facts describe checked-in configuration, not verified live operation.

DiffCI already separates predictions, ground truth, workflow identity, and economics. The historical investigation in [measurement integrity](research/2026-09-05-shadow-telemetry-measurement-integrity.md) documents contaminated workflow matches and incomplete attribution. Extend the existing stores and validity rules rather than creating a competing source of truth. Historical incident counts are not current health measurements.

## Experiment boundary

Start with shadow mode: retain all required checks, security tests, full-suite runs, deployment validation, and promotion controls. Selection is a prediction recorded before inspecting outcomes. It cannot authorize skipping required CI.

The unit of comparison is one repository, exact executed commit, baseline commit, test universe, selector build, environment, and pair of attempts. A PR head and GitHub's synthetic merge commit are different units. A deployed image must link to its built commit and digest, not merely its branch or PR number.

Register the cohort, selector version, eligibility rules, sampling seed, failure classification, and reporting window before collection. Freeze predictions and later append evidence; corrections retain their original value, reason, timestamp, and revision.

## Event contract

All records use `schema_version`, `event_id`, `event_type`, `occurred_at` and `received_at` in UTC, an opaque repository ID, and source provenance. IDs must be stable across retries. Distinguish an absent measurement (`null` plus reason) from a measured zero. Version metric definitions as well as the schema.

| Record | Required fields and meaning |
| --- | --- |
| Change | `change_id`, PR number when present, event kind, base SHA, head SHA, executed SHA, merge SHA when present, changed path count, additions/deletions, lockfile and workflow hashes; private artifact reference for paths and dependency edges |
| Prediction | `prediction_id`, `change_id`, immutable creation time, selector version and build digest, configuration hash, graph hash, test-universe hash, selected test IDs, always-run IDs, omitted IDs, full/fallback mode, reasons, analysis duration, selection hash |
| Execution | `execution_id`, `prediction_id`, full/selected role, pair ID, provider, workflow path and revision, run/job IDs and attempt, executed SHA, command and hash, runtime/toolchain/OS/image/lockfile hashes, cache policy and state, queue/setup/test/teardown durations, start/end, exit status, cancellation/timeout reason, artifact digest |
| Test outcome | execution ID, canonical test ID, pass/fail/skip/error, duration, retry index, failure fingerprint and classification; framework and adapter version defining discovery granularity |
| Resource usage | execution ID, measured CPU seconds, memory byte-seconds, runner/container duration, provider billable units and rounding rule, rate source/date/currency, gross cost, credits applied, net cash cost, measurement source and uncertainty |
| Deployment | deployment ID, environment, exact commit, image digest, build ID, linked execution IDs, start/end, outcome, smoke result, rollback time/reason, previous deployment ID |
| Production window | deployment ID, explicit window, request count, error count, latency histogram or quantiles with population, availability, rollback/incident reference, baseline window, instrumentation version, confounders |

Test IDs must include project, normalized file, and framework identity sufficient to distinguish parametrized cases. If only file-level selection is available, report files; never call file counts test-case counts. Freeze discovery before selection. Newly discovered tests or a changed universe invalidate the pair until reconciled.

Use the existing prediction and ground-truth records as primary entities. Add execution, per-test outcome, resource, and deployment references as versioned extensions. Before implementation, map each field to the current store, identify missing fields, and review migration and erasure behavior.

## Ground truth and pairing

For the initial prospective cohort, run the authoritative full suite on every enrolled PR revision and main push head with an eligible prediction. This requires an explicit CI extension for DentalPresence PRs; the present check job is insufficient. Intermediate push commits without CI remain `NO_MATCHING_EXECUTION`, not passes. Keep overflow-provider evidence separate unless its exact commit, command, outcomes, and environment can be verified.

Persist the prediction before either paired test execution begins. Independently generated observations that arrive after full-suite start are `LATE_PREDICTION` for this stricter benchmark, even if the existing store accepts predictions before completion. Do not relabel historical evidence as prospective.

Run selected and full commands in isolated clean workspaces at the same executed SHA with the same dependencies and test data. Preserve application-required conditions such as `react-server`. Neither arm inherits files or cache warmed by the other. Assign full-first versus selected-first with a recorded deterministic random seed; record cache policy and runner contention. Collect per-test full results even when the suite fails; missing coverage remains incomplete evidence.

Authoritative evidence must match a configured workflow path, revision, executed SHA, provider, run ID, and attempt. Observation, CodeQL, build-only, and promotion-only workflows do not substitute for full tests. Retries are separate attempts and cannot erase the first failure.

After the initial cohort, any optional reduction in experimental full runs must be preregistered and independent of selector outcomes. Continue all required CI full runs, plus mandatory full runs for selector/configuration/universe changes and unknown dependency impact. Only sampled pairs have recall labels; report the sampling fraction and missingness. No unsampled run may be counted as a true negative.

## Evidence states and classification

Keep lifecycle state separate from evaluation eligibility. Records may be predicted, awaiting execution, collecting, paired, or terminal. Terminal reasons include verified, late prediction, workflow mismatch, commit mismatch, universe mismatch, environment mismatch, incomplete artifacts, no matching execution, infrastructure failure, cancelled, timed out, and expired.

Classify failing tests as application regression, flaky, infrastructure, or unknown using recorded evidence. Show unknown and flaky outcomes separately; do not silently remove them. A full-suite timeout or setup failure supplies no complete regression ground truth. A selected suite passing while an omitted test reproducibly fails in the full suite is a selector miss. A selected test failing only in the full run is an execution discrepancy requiring investigation.

Set a proposed reconciliation target of 30 minutes after execution completion and expire unresolved records after seven days with a reason. Retries use bounded backoff and cannot let old unmatched commits block new records. Emit internal health alerts for missing artifacts, oldest pending age, workflow drift, and incomplete coverage.

## Metrics and publication rules

| Metric | Definition and limits |
| --- | --- |
| Selection fraction | Selected canonical tests divided by frozen full-universe tests. Report fallback/full plans and file-level cohorts separately. This is not runtime savings. |
| Omitted-test miss rate | Eligible pairs where full fails on an omitted regression test and selected passes, divided by eligible pairs with a complete full result. Also publish the numerator and denominator of full-failing pairs. |
| Failure preservation | Full-regression-failing pairs where selected catches at least one corresponding regression divided by all eligible full-regression-failing pairs. Report failure-level coverage separately; a different selected failure is not preservation. Zero failing pairs means unestimated recall. |
| Paired test runtime reduction | `1 - sum(selected_test_seconds) / sum(full_test_seconds)` over comparable passing pairs. Also show median per-pair reduction, spread, count, and negative savings. Failing pairs are reported separately. |
| Net compute reduction | `1 - (selected resource units + incremental DiffCI resource units) / full resource units` for a declared resource type and boundary. Never sum unlike CPU seconds and billable minutes. |
| Cost reduction | Comparable gross full cost minus gross selected and incremental DiffCI cost using dated provider rates. Separate actual billed cost, modeled counterfactual cost, credits, and net cash spend. |
| Actual pilot overhead | Resources consumed by both shadow arms, analysis, collection, storage, and reconciliation. A shadow pilot typically adds work; a counterfactual reduction is not realized pilot savings. |
| Deployment observations | Lead time, smoke failures, rollbacks, and production error/latency changes linked to exact deployments. These are associations; they do not establish that DiffCI caused product growth or reliability improvements. |

Publish the complete flow: changes observed, predictions created, full/fallback plans, executions found, valid pairs, failing pairs, excluded pairs by reason, and missing resource evidence. Report provider/cache cohorts separately. For clustered commits, use commit/day-aware uncertainty rather than treating every test as an independent sample. Zero observed misses does not establish zero risk; include an appropriate uncertainty bound and its method.

Every public case study must disclose: “DentalPresence is developed by the same founding team and is an early production deployment of DiffCI.” Publish methodology, selector/configuration versions, date range, aggregation code revision, exclusions, sanitized aggregates, and reproducible commands. Do not publish the pasted hypothetical 18,000 runs or any savings figure without matching evidence. Release the frozen report only after a provenance and privacy review.

## Data boundaries and retention

Proposed defaults: retain raw diagnostic artifacts for 30 days, sanitized event/outcome records for 12 months, and approved aggregates longer. Document actual deployed retention before enabling collection; implement deletion across primary storage, artifacts, exports, and backup expiry. Reuse existing repository erasure controls.

Keep patient, dentist, tenant, lead, billing, authentication, session, request-body, and production database contents outside this dataset. Strip secrets and personal data from logs and failure messages before upload. Restrict raw code paths, dependency graphs, commands, and test names to the private experiment. Public aggregates use opaque IDs and minimum cohort sizes reviewed for disclosure risk.

Use separate least-privilege observation credentials and deployment credentials. Telemetry collection must not confer promotion or production-write access. Production linkage uses sanitized metrics and deployment identifiers only.

## Delivery sequence and acceptance

1. Map the contract to current stores and audit both repositories' actual evidence configuration and overflow path. Produce one exact-commit trace from prediction through authoritative test result. Historical records remain separate.
2. Add the missing authoritative PR full-test evidence and per-test artifacts without weakening required checks. Split install and test timing in the current combined staging step for attribution. Validate observer and application runtimes independently.
3. Implement isolated paired execution, immutable prediction capture, ingestion deduplication, bounded reconciliation, erasure, and resource accounting. Use a proposed 30-day cohort; duration alone cannot establish reliability when failures are scarce.
4. Verify adverse cases: duplicate delivery, retry, merge-SHA mismatch, late prediction, wrong workflow, cancellation, timeout, overflow, missing artifact, new test discovery, negative savings, and an omitted failing test. Demonstrate each gets the correct state and metric treatment.
5. Generate a private benchmark with all denominators, exclusions, overhead, and uncertainty. Public promotion requires complete provenance and disclosure; wider selector rollout requires a separately defined risk threshold and sufficient failure evidence. Any confirmed miss blocks that selector version's rollout pending investigation.

The first reviewable milestone is a verified trace and a field-gap map, followed by an implemented collector. This document changes no workflows, runs no deployments, and makes no public benchmark claims.
