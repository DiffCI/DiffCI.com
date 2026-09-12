# Bypassing analysis when historical savings are too small

This opt-in observer feature can decline analysis and retain a full CI job. It
never approves test skipping, executes a test command, or changes a workflow.
Without matching history the observer performs normal analysis.

Record a stable job identity when gathering observations:

```text
diffci observe --economics-job router-unit-linux-node22-vitest --out /tmp/observation.json --no-send
```

The report's `economics.contextKey` fingerprints the platform, architecture, Node
version and a fixed set of root manifests, lockfiles and configs, plus an explicitly
declared Vue package's package.json, tsconfig and Vitest config. It does not scan
source files or hash every possible configuration dependency. Include other runner
and toolchain distinctions (for example the Go version, flags or browser) in the job
key. A matching GitHub origin is required.

The CI history producer can store the following artifact **outside the checkout**:

```json
{
  "schema": "diffci.economics.v1",
  "repository": "owner/repository",
  "jobKey": "router-unit-linux-node22-vitest",
  "contextKey": "digest-from-the-observation",
  "observerVersion": "exact-observer-version",
  "recordedAt": "2026-09-12T12:00:00Z",
  "samples": [
    {
      "headSha": "40-character-commit-sha",
      "stable": true,
      "fullMs": 20000,
      "policyMs": 19800,
      "observerMs": 2000
    }
  ]
}
```

The example shows one sample for readability; acceptance requires 5–100 samples
covering at least five distinct commits, all ancestors of the requested base.
Use actual stable green paired full/policy measurements from the same job and
observer. Never mark failed, unreadable or changing-universe runs as stable.
Times must be finite positive milliseconds. The artifact must be no older than
48 hours and cannot be future-dated. Repository, job key, context fingerprint and
observer version must match. The caller remains responsible for producing truthful
history; it is a cost heuristic, not a security or correctness certificate.

Pass the artifact on subsequent observations:

```text
diffci observe --economics-job router-unit-linux-node22-vitest --economics-history /tmp/history.json --out /tmp/observation.json --no-send
```

The bypass requires even the **largest historical gross saving**, multiplied by
1.25 and increased by 250 ms, to be less than the **smallest historical observer
cost**. Its report says `REFUSED`, `ECONOMICS_FULL_BYPASS`, and
`economics.decision: BYPASS_FULL`. It emits no selective result or command. A
consumer must retain the complete CI job when observation is refused.

Use `--force-analysis` to resample despite qualifying history. Expired history
also resumes analysis; refresh it from real measurements rather than merely
rewriting its timestamp. The history artifact is read only and is not automatically
updated or uploaded by this feature. Do not infer that a bypass guarantees the
next commit would have been unprofitable: changed workloads can create new savings.

## Profiling and qualification

Observation timings include phases for engine loading, eligibility, delta work,
graph building, impact/command planning and finalization. Graph timings separate
repository/scope discovery, adapter inventory, adapter execution, TypeScript
program creation, import extraction/resolution and graph finalization.
`preObserveMs` is process uptime before the observation starts, not exclusively
module-loading time. The benchmark also measures the complete observer process.

Explicit Vue suites already inventory their implementation files. Their optimized
TypeScript program parses those inputs without automatic library/type loading;
explicit import resolution still uses the original compiler options. Reachable
generated implementation files are parsed on demand, including their transitive
imports. Unreadable/invalid files, excluded paths, more than 500 additional files,
files above 5 MiB, cross-package dependencies and triple-slash file references
retain full fallback. Required type-test files always remain selected.

The Cloudflare comparison rebuilds the previous qualified observer from a
checksum-verified source archive and verifies its known artifact integrity. Each
commit gets two fresh-process old/new observation pairs in reversed order, with the
first order alternated across commits. When policies match exactly, both engines
share the measured full/selected test executions. Baseline and candidate economics
subtract their respective first-pair observer costs from that same test work.
Both observation repetitions are retained to expose order/cache variability.
No automatic production activation is part of this qualification.

The benchmark source upload includes an ignored `scripts/performance-baseline.tgz`
created with `git archive` from commit `7f4a272`. Its SHA256 is pinned in
`scripts/language-benchmark-experiment.json`; ordinary source archives must add
that file explicitly for comparison jobs. The archive is only source material:
both agents are built inside Cloudflare.
