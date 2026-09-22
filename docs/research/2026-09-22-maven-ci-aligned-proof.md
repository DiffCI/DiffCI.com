# CI-aligned Maven selection proof on Cloudflare

Date: 2026-09-22. This follows the [PR #3 probe](./2026-09-22-maven-pr3-cloudflare-probe.md) and [runtime diagnosis](./2026-09-22-maven-pr3-cloudflare-runtime.md). Both commands ran in the same Cloudflare `standard-4` Sandbox Container with OpenJDK 21 and Maven 3.9.11. The checkout was reset and cleaned between runs; the Maven dependency cache remained shared. Selected ran first, so it had the colder cache. These are single observations, not repeated performance estimates.

## Apache Maven Resolver: valid candidate saving

The analyzed source-only commit was [`a90b7f7`](https://github.com/apache/maven-resolver/commit/a90b7f7f8a05b961c2880ac48ca880b3640b3545), which changed one production source file and its test in `maven-resolver-tools`. Core selected that module without a graph fallback. Resolver's [CI workflow](https://github.com/apache/maven-resolver/blob/a90b7f7f8a05b961c2880ac48ca880b3640b3545/.github/workflows/maven-verify.yml) uses the Apache shared workflow, whose [default verification goal](https://github.com/apache/maven-gh-actions-shared/blob/v5/.github/workflows/maven-verify.yml) is `-P run-its verify`.

| Command | Cloudflare wall time | Result |
| --- | ---: | --- |
| `mvn -pl maven-resolver-tools -am verify -P run-its` | 339.224 s | Pass |
| `mvn verify -P run-its` | 371.154 s | Pass |

**Observed candidate saving: 31.930 s, or 8.6% of the full command's wall time.** Maven's selected reactor contained 26 modules because `-am` brought in upstream dependencies. The earlier 1-of-206 test-file result was not a runtime-savings estimate.

This is **not a saving delivered by PR #3 as merged**. Its planner currently emits `mvn -pl maven-resolver-tools -am test`; that command failed on this repository because a reactor artifact needed packaging. The passing selected command above manually substituted the repository's CI verification goal. The benchmark used Maven 3.9.11 and the Java 21 CI matrix member, while the shared workflow may choose a different Maven version. The single pair is enough to demonstrate a viable candidate, not enough to estimate stable savings across commits or CI runners.

## Jicofo: faster manual command was unsafe

For Jicofo commit [`076a4c7`](https://github.com/jitsi/jicofo/commit/076a4c79cc6907f7db740e4da96ed8d58a8fee68), manual `mvn -pl jicofo-selector -am verify -Pcoverage` passed in 232.654 s and full `mvn verify -Pcoverage` passed in 256.548 s. **Do not count the 23.894 s difference as DiffCI savings.** A subsequent core graph analysis selected tests in both `jicofo-selector` and downstream `jicofo`. The manual command omitted the latter. Core also required fallback because of an unrelated Python script and an unclassified changed `reference.conf` resource. A safe command would have to include the downstream module, erasing this apparent module reduction.

## Consequence for core

The Maven planner needs to derive or accept the repository's validated CI goal and options before it can emit a selective command. It should refuse selection when it cannot prove execution parity. Module-level coverage must include downstream tests; benchmark denominators must reflect the modules and tests actually run by Maven with `-am`.

The dedicated Cloudflare Worker and container application were deleted after the run. Raw Resolver status responses are in `.scratch/maven-proof/` in this checkout.
