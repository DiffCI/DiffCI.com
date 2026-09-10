# Cloudflare language qualification

## Observer 0.1.2 candidate

`vue-go-qualification-v2` runs the full DiffCI test suite and builds the candidate
observer inside Cloudflare before installing it. Its report records both the verified
bootstrap artifact integrity and the newly built candidate integrity. The repository
pins and faults are unchanged. For Go only, a committed `diffci.json` declaring
`go.scope: root-module` is added before baselines and observation; both the upstream
pin and the resulting baseline commit are recorded. This qualifies that declared CI
scope, not every module in the repository. The candidate is not automatically promoted
to production by the job.

## Original observer 0.1.1 protocol

The `vue-go-qualification-v1` validation job runs only in a Linux Cloudflare
validation container. The desktop performs source editing, archive upload,
Worker deployment, and evidence retrieval. No desktop test workloads are needed.

Inputs are fixed in `scripts/qualify-language-adapters.mjs`:

* Vue: vuejs/test-utils, commit `93321272b33fe931da71d636654b41f45058ed0c`.
* Go: go-chi/chi, commit `b1c9ab47626cc46b34393ad4d35779c4363c4e1e`.
* Observer: deployed 0.1.1 archive, exact SHA-512 required by the allowlist.
* Go: 1.27.1 linux/amd64, official archive SHA-256 checked before extraction.

The job first runs DiffCI's typecheck and validation tests in Cloudflare, installs
the observer and each repository, and requires two green full-suite baselines.
It observes a whitespace-only commit touching a preregistered source file. The
selection is frozen before fault injection. Three alternating full/policy pairs
measure elapsed time and child CPU time; observation overhead is included in net
elapsed savings. Go test result caching is disabled. Vue uses two workers and a
fixed shuffle seed.

The Vue fault changes the Hello component's returned message. The Go fault makes
NewRouteContext panic. A fault counts only when the command exits unsuccessfully
without infrastructure failure and emits the mutation marker. Full fallback
executes the full suite and provides no evidence of selective savings or selective
safety. Two mutations cannot establish a general safety rate. Timings are measured
container timings, not estimated customer bills.

Each run is bounded to thirty minutes of harness execution, in addition to
bootstrap. JSON evidence and logs are collected into R2 under
`validation/<runId>/`, alongside `execution-receipt.json`. Failed setup and
baseline results are retained as inconclusive outcomes, never converted to passes.
Earlier harness revisions remain separate run IDs; source archives are hashed.
