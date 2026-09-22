# Observer 0.1.2 candidate: implementation and Cloudflare verification

The candidate adds actionable adapter reasons to empty-graph refusals, explicit Go
root-module scoping, literal Vue Options API registrations, and empty-script SFC
handling. The CLI and JSON identify the Go scope. Cache and adapter versions were
advanced to separate the new semantics from earlier results.

Go scope is opt-in through `diffci.json`:

```json
{ "go": { "scope": "root-module" } }
```

It applies to root-module CI only. Changes inside excluded modules, including
renames out of them, force full validation. Workspaces and local replacements
remain blocked. Vue spreads, computed registrations, unresolved runtime components,
and unresolved directives remain blocked.

## Verification

Everything computational ran in Cloudflare: dependency installation, typecheck,
tests, candidate packaging, graph analysis, baselines, timings, and fault injection.
The desktop edited and uploaded source, deployed the validation Worker, and retrieved
evidence. Typecheck passed. The full suite recorded **2,142 passed, 3 skipped,
0 failed**. Focused regression checks also passed, including native Go execution.

Five initial failures were in an existing Git integration test which assumed the
source archive included `.git`. That test now creates its own committed repository;
no test was disabled. Initial failed runs remain separately recorded as v1 and v2.

Final run: `adapters-012-20260910-v3`, job `vue-go-qualification-v2`.
Source commit: `b3249b3`. Source archive SHA-256:
`b596498e2bb946e8e4b7548979d581b5de91090bf229fa81486609ea4923e936`.
Validation Worker version: `dcec5dbb-3d0b-4419-95f6-9093e2dc5efe`.
Candidate 0.1.2 was built and installed in Cloudflare, with integrity:

```
sha512-FiVDAHdmzEZKE1Gh0EzfyTv0LNxfzy6JsrcEGR52G41ErixoS7DOha9qr1m+D1fRwVk6o3j+UbXcRk+jupuQUg==
```

## Real repository results

The upstream pins and faults are unchanged from the earlier qualification.
Go has a declared root-module configuration committed before the observed change;
this configuration difference is recorded in the report.

| Repository | Improvement | Remaining result |
| --- | --- | --- |
| vuejs/test-utils | Reported fallback reasons decreased from 10 to 7; empty-script and direct-registration blockers removed | FULL: unresolved runtime behavior remains |
| go-chi/chi | With explicit root scope, the graph now contains 65 nodes instead of an empty-graph refusal | FULL: Go files outside the active build context remain |

Both repositories passed two clean baselines, three full/policy timing pairs, and
detected the injected fault in both arms. Vue's median net overhead was 2.316 seconds;
Go's was 0.896 seconds, including observer process time. Both arms executed full
suites, so these results establish neither selective savings nor broad selective
safety. Production skipping remains disabled. The candidate has **not been promoted
to the production observer**.

Evidence is in R2 bucket `diffci-validation-env`, prefix
`validation/adapters-012-20260910-v3/`, as `language-qualification.json`,
`language-qualification.log`, and `execution-receipt.json`. These include the exact
commands, environment, observation reports, fault outcomes, and timing samples.

The next qualification should use additional real repositories within the supported
scope and a broader set of commits. Remaining runtime Vue and inactive Go dependencies
must be modeled before relaxing their full-validation fallbacks.
