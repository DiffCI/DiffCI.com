# FROZEN — EXTERNAL_ENGINE_BRIDGE_01

**Written before a single line of the repair**, per the same discipline every phase in this thread has
used. Scoped from `docs/external-installation-01-plan.md`'s finding (no path connects an external install
to `src/ci-inference/`) and the user's choice of option A: extend the Shadow App's already-proven
pipeline, narrowly — `real Shadow push → existing repository identity → existing Sandbox → exact DiffCI
artifact/commit → ci:reproduce → persisted reproduction result`. Shadow stays the transport/orchestration
layer; `ci-inference` stays an independent analysis engine. No PR support, no App redesign, no product-App
registration, no classification-semantics changes.

## The trace, mechanically, before any design

**1. Injection safety — two existing conventions, one to follow.** Shadow's own container calls
(`execShadowPoll`, `validation-worker.ts:613-619`) build a **template-string shell command**, safe only
because `owner`/`name`/`language` are pre-validated against a strict allowlist regex
(`validateShellSafeIdentifiers`) before interpolation. `validation-env`'s `ci:reproduce` invocation
(`ciReproduceArgv()`, `validation-jobs.ts:1893-1906`) builds a **real argv array** first, and only
`shq()`-quotes each element when it later crosses one shell boundary (`validation-shard-do.ts:523`) — and
`job.repository`/`job.pinnedHeadSha` are validated by `isRepositorySlug()`/`isPinnedSha()` BEFORE that
array is even built (`validation-shard-do.ts:447-448`). **The bridge follows the second convention, not
the first**: build the argv array from `ciReproduceArgv()` (or a near-identical function), validate
`repository`/`headSha` against the same two predicates before any command is constructed, never
template-interpolate either value into a string. Per direction: structured inputs to a fixed entrypoint,
not concatenation.

**2. Repository/SHA trust — Shadow already does this right; reuse it, don't reinvent it.** Shadow never
trusts `payload.after`. `handleShadowWebhook`'s `push` case discards the webhook's SHA entirely
(`shadow-webhook.ts:105-118`) and re-derives HEAD *inside the container*, from a live, authenticated
`git rev-parse HEAD` after `cloneOrUpdateRepo` fetches and hard-resets to `origin/<defaultBranch>`
(`collector.ts:68-108`, `cloudflare-shadow-poll.ts:98-107`). This is stronger than re-verifying a claimed
SHA via a second API call — it's a live fetch, not a check. **The bridge derives the SHA to reproduce the
identical way**, never from the webhook payload directly.

**3. Persistence — no generic table exists; imitate `validation-env`'s R2-only shape.** Shadow's two D1
tables (`shadow_predictions`, `shadow_ground_truth`) have prediction-model-specific columns
(`opportunity_category`, `tests_selected_diffci`, …) that a `reproduction.json` result does not fit
without distortion. `validation-env`'s own `ci:reproduce` mode persists **no D1 rows at all** — only R2,
via `collectCiReproduction()` (`validation-shard-do.ts:1141-1185`). **The bridge writes to R2 only**, via
the already-generic `R2EvidenceStore` (`r2-store.ts`), under a new key shape:
`shadow/ci-reproduction/${repository}/${headSha}/reproduction.json` (+ `environment.json` + log),
mirroring `validation-env`'s `validation/${runId}/...` convention closely enough that both are
recognisable as the same artifact family without merging their stores.

**4. Toolchain — same image, different bootstrap; route through the one that's already proven.** Shadow's
and `validation-env`'s containers are the byte-identical `cloudflare/sandbox:0.12.5` image, but
`prepareContainer()` (`validation-worker.ts:147-170`) never provisions `make`/`python3`/build-essential —
only `validation-shard-do.ts:281-310`'s `bootstrap()` does, precisely the step `SEMANTIC_REPAIR_02`
already diagnosed and fixed for babel's `make: not found`. **The bridge ports that exact provisioning
block** (check `make --version && python3 --version && cc --version`; install if missing; record the
result) into whatever container invocation actually runs `ci:reproduce` — it does not modify Shadow's
existing dependency-graph poll path, which needs no such toolchain and stays as-is.

**5. The hard, methodological blocker — not a wiring gap.** `ci:reproduce` requires a hand-authored
`--reference` plan file and crashes uncaught (`ENOENT`, no try/catch, `ci-reproduction.ts:623,706`) without
one. Only six exist (`docs/evidence/ci-reproduction-05-{eslint,babel-loader,babel,webpack,jest}-reference-
plan.json` + the `ci-reproduction-01` default). This is not an oversight to automate away — it is the
mechanism `semantic-repair-01-plan.md` froze deliberately: *"Reference plans are hand-transcribed from
each workflow after this freeze, as R3 requires; that transcription is the only workflow inspection
permitted before a repository's inference runs."* Automating reference-plan generation from the
repository's own workflow would make the "reference" arm derived by the same kind of reading the
inference arm does, collapsing the two-independently-constructed-arms design `DEFECT 25`'s own comment
exists to protect — a `REPRODUCED` verdict would stop meaning what it currently means. **This phase does
not build that automation.** What it does: fix `ci:reproduce`'s crash-on-missing-plan into an honest,
persisted refusal (below), and require any repository this bridge actually reproduces past a refusal to
already have a hand-transcribed plan, exactly like the existing five.

**6. Clone auth — proven in production for private repos; `ci:reproduce`'s own clone currently has
none.** `contents: read` (Shadow's manifest) is sufficient for authenticated `git clone`/`fetch` — already
running in production against DiffCI.com's own private repo via `githubTokenForRepo()` →
`GITHUB_CLONE_TOKEN` env var → `gitAuthEnv()` (`collector.ts:19-29`; token never touches argv). But
`ci-reproduction.ts`'s own clone (`ci-reproduction.ts:605-608`, `execFileSync("git", ["clone", ...])`) has
**no authentication at all** today — it only works against public repositories. For the first pilot, using
a public external repository sidesteps this entirely; wiring `gitAuthEnv()`-equivalent auth through
`ci-reproduction.ts`'s clone step for private repos is real but deferred, not required for a truthful
first result.

## Design

```
Shadow push webhook (existing, unchanged)
  → existing installation/repository identity (existing, unchanged)
    → NEW: derive headSha via authenticated git fetch (reusing collector.ts's cloneOrUpdateRepo pattern)
      → NEW: validate repository (isRepositorySlug) and headSha (isPinnedSha) - fail closed, no command
        built on failure
        → does docs/evidence/ci-reproduction-05-<repo>-reference-plan.json exist?
            NO  → NEW: persist a REFUSED-shaped reproduction.json ("no reference plan available for this
                  repository") - no ci:reproduce invocation attempted, no crash, an honest, inspectable
                  result exists
            YES → NEW: port validation-shard-do.ts's toolchain bootstrap into the container run
                  → build ciReproduceArgv()-equivalent argv, shq()-quote, invoke ci:reproduce
                    → persist reproduction.json + environment.json + log to R2
                      (shadow/ci-reproduction/<repo>/<sha>/...)
```

`scripts/ci-reproduction.ts`'s own `main()` gets one small, generally-useful hardening as part of this:
check the reference-plan path with `existsSync` before either `readFileSync` call, and on absence, write
a `reproduction.json` with `outcome: "REFUSED"` and an explicit reason instead of throwing — this benefits
every future caller, not only the bridge, and is exactly the kind of small, load-bearing, honestly-scoped
fix this thread's discipline favours over a crash nobody downstream can distinguish from an infrastructure
failure.

## Delivery surface — constrained by "don't redesign GitHub Apps"

Posting a GitHub check run needs `checks: write`; a PR/issue comment needs `pull_requests: write` or
`issues: write`. Shadow's manifest has neither — only read scopes. Requesting new write permissions IS
redesigning the App, which is explicitly out of scope here. **This phase delivers the result as a
retrievable R2 artifact** (a URL or API response the installer can be given), not as a GitHub-native
surface. Posting directly to GitHub is real, valuable, future work — deliberately not this phase's job.

## The four required proofs, mapped to concrete checks

1. **Exact repo/commit traceable** — `reproduction.json`'s own `repository`/`headSha` fields, plus the
   R2 key path itself, both derived from the authenticated fetch in step 2 of the design, never from the
   webhook payload directly.
2. **Genuine execution, not Shadow's existing analysis returned instead** — verified by the presence of
   `referenceArm`/`inferenceArm` step receipts (real `startedAt`/`endedAt`/`exitStatus`/`outputTail`
   per step) in the persisted `reproduction.json` — Shadow's own prediction output has no such shape, so
   the two are structurally unconfusable, not merely differently labelled.
3. **`reproduction.json` persisted and retrievable with provenance** — the R2 key scheme above, checked by
   actually fetching it back after a run, the same "verify by re-reading, not by assuming the write
   succeeded" discipline this thread has used for every evidence commit.
4. **Refusal/unresolved outcomes survive unchanged** — the new missing-reference-plan path returns
   `REFUSED`, never coerced toward a generic success/failure; `PARTIAL_REPRODUCTION`/`UNVERIFIABLE`/
   `GROUND_TRUTH_CONTRADICTED`/`ENVIRONMENT_INADEQUATE` all pass through `classify()` completely
   unmodified — this phase adds a caller, not a new classification path.

## Sequence and revised budget

```
this trace (done)
  → bridge design + implementation: derive-SHA step, validation, argv/shq construction,
    reference-plan existence check + graceful REFUSED path in ci-reproduction.ts,
    toolchain bootstrap ported into the container run                          (~1 day)
    → artifact/container/result plumbing: R2 key scheme, persistence, retrieval verification (~1 day)
      → end-to-end rehearsal through a REAL Shadow installation on a throwaway repo under an
        account DiffCI's team does not otherwise use for development                (~0.5-1 day)
        → first genuine external repository - PUBLIC (sidesteps clone-auth wiring), and one
          the team is willing to hand-transcribe a reference plan for beforehand, exactly the
          same prep already done for eslint/jest/webpack/babel/babel-loader                (~0.5 day)
          → freeze evidence
```

Buffer: 1-2 days for the first real integration defect, per direction — this is a genuinely new
connection between two systems that have never run together, and the reference-plan requirement alone
means the FIRST external repository's reproduction quality is bounded by how well that hand-transcription
was done, not only by the bridge's own correctness.

## What this phase does not attempt

- Does not merge Shadow's dependency-graph/impact engine with `ci-inference` conceptually or in code.
- Does not add `pull_request` handling to Shadow's webhook.
- Does not register or wire the dormant product/observer App.
- Does not change `classify()` or any other classification semantics — `GROUND_TRUTH_CONSISTENCY_01`'s
  work stands untouched.
- Does not automate reference-plan authoring from a repository's own workflow file — see §5.
- Does not add GitHub write scopes or post results back to GitHub natively — see "Delivery surface."
- Does not select the first external repository. That decision belongs to the rehearsal/pilot steps, with
  the same "no target named in advance by me" discipline this thread has already established for a
  different research program.
