# Vue and Go qualification — September 10, 2026

**Decision: retain observer-only behavior. Neither repository qualified for selective savings.**

All installs, builds, analysis, tests, and injected faults ran in Cloudflare
Containers. The desktop only edited/uploaded source and retrieved evidence.
The qualification Worker was deployed as version
`a7b8492c-6e4c-4649-9217-814e024a3c54`; production observer behavior was not changed.

Final run: `vue-go-qualification-20260910-v4`. Source commit: `03e0947`.
The source archive SHA-256 was
`ff4cd7e8d8537cc8a2d70a90d272047c8c73386d9b9a070a7367618b408d8bd6`.
The existing observer archive was reused without rebuilding it, SHA-256
`aa712e7ff63ed00e3aa5d7be2e8037aad6543186a72abcd7d34135de37508224`.
Cloudflare ran Node 22.23.2 and checksum-verified Go 1.27.1, linux/amd64,
CGO_ENABLED=0. DiffCI typecheck passed; validation tests: 74 passed, 3 skipped.

| Repository | Observer behavior | Clean baselines | Injected fault | Median net elapsed change |
| --- | --- | --- | --- | --- |
| vuejs/test-utils | FULL fallback | Both passed; 55 test files, 484 tests passed, 1 todo | Detected by full and policy runs | 1.697 seconds slower |
| go-chi/chi | REFUSED; full suite retained | Both passed | Detected by full and policy runs | 0.558 seconds slower |

The median full-suite timings across three pairs were 9.014 seconds for Vue and
26.698 seconds for Go. Observer process elapsed time was 2.101 seconds and 0.612
seconds respectively. Net change includes observation overhead. Differences
between identical full-suite arms are timing noise, not selective savings.
These are container measurements, not customer billing estimates.

Vue's blockers include an empty-script fixture that fails parsing and runtime
component/directive resolution, including auto-imports and dynamic components.
Go's adapter diagnostic confirmed zero graph nodes and the explicit blocker:
one root go.mod is required; nested modules/workspaces require full validation.
The observer's public refusal only says the graph is empty, losing the more useful
adapter reason. Both observations left their worktrees unchanged.

The fault experiment ran the same full suite in both arms. Detecting both faults
confirms the full-run behavior for these cases; it does not validate selective
safety, broad language support, or a general false-negative rate.

## Next work justified by these results

1. Preserve adapter blocker reasons in empty-graph refusals, so users see an
   actionable explanation instead of only “empty graph.”
2. Add explicit Go module scope and map it to the actual CI command. Keep nested
   modules conservative until their scope and cross-module dependencies are modeled.
3. Handle valid Vue empty-component fixtures and statically resolvable component
   registrations. Retain full fallback for unresolved runtime component resolution.
4. Repeat Cloudflare qualification on repositories within the supported scope,
   then expand to real commits and more faults before enabling skipping.

Evidence is retained in R2 bucket `diffci-validation-env`, prefix
`validation/vue-go-qualification-20260910-v4/`:
`language-qualification.json`, `language-qualification.log`, and
`execution-receipt.json`. Authenticated retrieval uses the validation Worker's
`/v1/result` endpoint. The receipt's `done` status means the job completed;
qualification outcomes are in the JSON report.

Earlier runs remain separate: v1 stopped on the wrong test runner; v2 stopped on
the allowlist invariant needing the new mode; v3 completed Vue and recorded Go's
refusal as inconclusive. V4 explicitly measures the full-run policy on refusal,
without changing the agent or bypassing any blocker.
