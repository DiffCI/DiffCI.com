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
| vuejs/router | v4.5.1 | packages/router configured Vitest suite, including its type tests |
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
Nested-module CI is not claimed. Vue measurements cover the configured Vitest suite,
not browser or coverage-threshold CI. Vue Router's config enables type tests; its
documented build and declaration-build steps are prepared before observation and
timing. These type tests remain included, despite the initial harness's generic
scope label saying otherwise; the emitted command and test identities are authoritative.

Each candidate gets freshly reconciled dependencies from its own lock/manifests.
Freeze its observation, then run full/policy and policy/full pairs for a genuine
selection. When the policy is exactly the full suite, run only two full baselines
and report observer overhead: duplicate full-policy arms provide no selection
comparison. Likewise a full-policy fault has one actual full execution, explicitly
marked as identical policy behavior rather than two independent executions. Both full runs
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

Six independent Cloudflare jobs run in batches of at most three, each bounded to 45 minutes with
a 40-minute harness budget and a three-minute limit per suite execution. No job
accepts arbitrary commands. Per-run JSON, logs and execution receipts are stored
in private R2 bucket `diffci-validation-env`, beneath `validation/<runId>/`.
All setup failures, red baselines, unstable universes, refusals and full fallbacks
remain in the denominator. No production deployment or automatic skipping is part
of this experiment.

## Environment correction before the primary cohort

The first attempts ran as root. Cobra's permission tests intentionally require a
permission-denied error; root bypassed that restriction and caused baseline failures.
Their results are retained as diagnostic attempts, and unfinished root jobs were
cancelled after preserving partial evidence and destroying their containers. The
same candidate-selection rules are rerun as an unprivileged user. Neither Cobra's
tests nor its source were patched. Validator also had two container bootstrap
failures, retained separately. The primary reports record uid/gid and do not mix
these earlier attempts into the timing sample.
