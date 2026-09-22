# Go and Vue Cloudflare benchmark results — 2026-09-10

All six primary Cloudflare runs completed: 48 historical source-changing commit deltas, eight per repository. All test execution, dependency installation, builds and observer analysis ran in Cloudflare Sandbox containers; the desktop only orchestrated runs and retrieved results.

44 cases had two passing baselines with a consistent test universe. Three cases had a red first baseline; one had a passing first baseline and failing repeat. All 48 policies were FULL. No selective-test savings were demonstrated; observer analysis adds overhead to the unchanged full suite.

| Repository | Stable baseline cases | Failed/unstable cases | Injected faults detected |
|---|---:|---:|---:|
| vue-test-utils | 8/8 | 0 | 3/3 |
| vue-router | 8/8 | 0 | 3/3 |
| reka-ui | 6/8 | 2 | 3/3 |
| chi | 6/8 | 2 | 2/2 |
| cobra | 8/8 | 0 | 3/3 |
| validator | 8/8 | 0 | 3/3 |

17 of 18 planned fault checks were attempted and detected. The remaining Chi fault was not attempted because its baseline failed. Every fault policy was identical to the full suite, so these checks verify full-suite fault detection, not selective-subset safety or a false-negative rate.

Baseline failures: Reka UI candidates 1 and 2 failed the Tree default snapshot. Chi candidate 3 failed TestThrottleCustomStatusCode; candidate 2 passed initially and failed on repetition in that same test. These cases were retained and excluded from stable measurements.

Fallback blockers: Go repositories contain files outside the active build context; some deltas also changed configuration/workflows or deleted source. Vue repositories include unresolved runtime components/directives, style dependencies and, in Reka UI, Nuxt implicit routes/auto-imports. Repository-wide docs and playground sources also trigger fallbacks. These are the next adapter/scoping issues to address before expecting savings.

The cohort uses fixed historical release pins and eight recent matching first-parent source changes per pin, selected before execution. It is not a representative random sample of either ecosystem. Go tests cover the root module on Linux amd64 with CGO disabled; Vue runs the configured Vitest suite, including Router type tests.

All reports record non-root uid/gid 1000 and the same promoted observer artifact integrity:
sha512-FiVDAHdmzEZKE1Gh0EzfyTv0LNxfzy6JsrcEGR52G41ErixoS7DOha9qr1m+D1fRwVk6o3j+UbXcRk+jupuQUg==

Benchmark source SHA256: 2d498f6df2416555117eff2c3710ccbceace1f861a416aa384d1ca0e4c17cc31. Cloudflare image: docker.io/cloudflare/sandbox:0.12.5.

Protocol corrections: initial root-user attempts were replaced with non-root runs because Cobra tests filesystem permissions. Router required its documented build and declaration build before tests. Vue fault messages were collected from structured Vitest JSON because console output omitted them. Cloudflare bootstrap failures were retried. Diagnostic attempts remain separate and are excluded from the primary 48 cases; no failing candidate was substituted.

Evidence: each repository folder contains language-qualification.json, language-qualification.log and execution-receipt.json; commit-results.csv lists all 48 deltas and fallback reasons. Private R2 retains the original run evidence under validation/<runId>/. Production behavior was not changed by this experiment.
