# Historical Vue and Go benchmark protocol

The September 10, 2026 expansion uses six open-source repositories, up to eight
historical source-changing commits each. All repository discovery, installation,
analysis, test execution, timing and mutation work runs in Cloudflare Containers.
The desktop is used only for authoring, uploads, deployment and evidence retrieval.

The committed cohort file is `scripts/language-benchmark-cohort.json`. Its stable
release pins intentionally define a reproducible historical cohort, not a sample
of the latest HEADs or a representative random sample of either ecosystem.

| Repository | Pinned release | Measured suite |
| --- | --- | --- |
| vuejs/test-utils | v2.4.6 | Root Vitest unit suite |
| vuejs/router | v4.5.1 | packages/router Vitest unit suite |
| unovue/reka-ui | v2.2.0 | packages/core Vitest unit suite |
| go-chi/chi | v5.2.1 | Root-module go test ./... |
| spf13/cobra | v1.9.1 | Root-module go test ./... |
| go-playground/validator | v10.26.0 | Root-module go test ./... |

Within the first 250 first-parent commits at each pin, take the eight most recent
whose parent-to-head delta touches a source path matched by the committed rule.
Merge commits use the first parent. Tests, declarations, stories, documentation,
examples and testdata are excluded from source selection; Test Utils' Vue fixtures
are explicitly included. The exact candidate list is frozen in each report before
installing target dependencies or observing any candidate. No failed candidate is
replaced with another one. Historical commits are real upstream changes, not
synthetic whitespace commits.

The promoted observer 0.1.2 archive is reused, with exact SHA-512 verified at
bootstrap and again in the harness. No engine changes or candidate rebuilds occur.
Go 1.27.1's Linux archive is checksum verified. Each Go checkout receives the same
declared root-module scope as an explicitly recorded untracked configuration
overlay, outside the historical delta. Existing DiffCI config is never overwritten.
Nested-module CI is not claimed. Vue measurements cover the named unit suite,
not browser, type, build or coverage-threshold CI.

Each candidate gets freshly reconciled dependencies from its own lock/manifests.
Freeze its observation, then run full/policy and policy/full pairs. Both full runs
must pass and report the same test universe before timing results count. Go test
result caching is disabled; Vue runs two workers with a fixed seed. Child CPU,
elapsed time, peak RSS, actual commands and structured test outcomes are recorded.
Net elapsed savings include observer process overhead but exclude one-time install
cost. A refusal or unsupported command keeps the full suite; an explicit empty
selection is recorded separately. Vue selected paths outside the independently
observed unit suite also retain the full suite.

Attempt a fault on candidate indexes 0, 3 and 7 after green baselines. The first
surviving changed source file supplies the mutation site: the first Go function
body receives a panic; a Vue script receives a runtime throw; a TS function body
receives a throw. If no supported site exists or the full suite does not detect
the marker with a structured failing result, record an inconclusive fault. Never
search for a more favorable fault after seeing the outcome. Selection is frozen
before mutation. Full and selected outcomes are retained, including unreadable
policy runs. Fault injection establishes only bounded detection evidence; it is
not a false-negative rate estimate or proof of general safety.

Six independent Cloudflare jobs run concurrently, each bounded to 45 minutes with
a 40-minute harness budget and a three-minute limit per suite execution. No job
accepts arbitrary commands. Per-run JSON, logs and execution receipts are stored
in private R2 bucket `diffci-validation-env`, beneath `validation/<runId>/`.
All setup failures, red baselines, unstable universes, refusals and full fallbacks
remain in the denominator. No production deployment or automatic skipping is part
of this experiment.
