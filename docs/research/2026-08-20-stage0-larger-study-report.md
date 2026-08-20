# Stage 0 larger study — report (2026-08-20)

Requested as two things: (1) exclusion handling for the tsconfig-less-JS gap found while smoke-testing
the retry policy, and (2) a larger study. Both are done, but getting to a trustworthy larger study took
two real debugging passes first - reported here in full rather than only the final clean numbers,
because the bugs found along the way are as much the finding as the aggregate result.

## Part 1: exclusion handling

`collectMetadata()` (and, for the common case, `cloneOrUpdateRepo()` itself - see the fast-path below)
now excludes a repository up front, with an exact reason, whenever DiffCI's graph builder could never
analyze it - not just the originally-reported tsconfig-less-JS case, but the same failure mode for
every non-TS/JS corpus language (Python/Go/Rust/Java), which was silently hitting the identical
`"No tsconfig.json found"` error per-commit before this fix (`diffciGraphCapable` was computed but
never actually consulted anywhere in the analysis path - confirmed by grep, zero hits).

Two real correctness bugs were caught and fixed while getting this right, both surfaced by actually
running it against the real corpus rather than trusting synthetic unit tests alone:

1. **tsconfig detection false positive.** The first version walked the whole repo tree for any
   `tsconfig.json`, but `createProgram()`'s `ts.findConfigFile()` only ever starts at the repo root and
   walks *up* - never down into subdirectories. `fastify/fastify` (and others) have a `tsconfig.json`
   nested in an `examples/` subdirectory but none at the root, so they were wrongly reported as
   graph-capable, then failed every sampled commit anyway. Fixed to check the repo root only, matching
   what the real analyzer actually looks at.
2. **Wasted clone cost.** `pallets/flask` took 210 seconds and `spf13/cobra` took 42 seconds just to
   clone+walk before being excluded on language alone - the exclusion decision never depended on
   anything the clone would reveal. `junit-team/junit5` (a large repo) timed out entirely at 240s doing
   the same wasted work. `cloneOrUpdateRepo()` now checks `primaryLanguage` (already known from the
   corpus config) before touching git or the filesystem at all for a known-unsupported language -
   confirmed live: all three repos now exclude in `containerDurationMs: 0-1` instead of 42-210+ seconds.

## Part 2: the larger study

19 of the 20 corpus repositories run through the real deployed Cloudflare pipeline (`honojs/hono` is
covered separately by the 2026-08-19 local pilot, not re-run here). 3-4 commits requested per repository.

### What broke on the first attempt, and what that revealed

Running all 15 not-yet-tested repos back-to-back surfaced four distinct real bugs - stopped and fixed
all four before trusting any aggregate number built on top of them:

1. **Systemic container-slot contention.** `max_instances: 1` caused repeated `"the sandbox container
   stopped while the operation was pending"` failures across many different repos when fired
   back-to-back - not the single isolated case the retry policy was built for, but 9 of 15 requests,
   several exhausting all 3 retry attempts. Raised to 5, plus explicit pacing between sequential
   dispatches. Confirmed fixed: 14 of 15 succeeded cleanly on the retry (`attempts: 1` for nearly all).
2. **Sandbox session-id length overflow.** `spring-projects/spring-petclinic` failed outright with
   `"Sandbox ID must be 1-63 characters long"` - the session-id string overflowed Cloudflare's limit for
   long owner/name combinations. Replaced with a fixed-length SHA-256-prefix hash
   (`src/research/cloudflare/session-id.ts`, dependency-free like `retry.ts` for plain-Node
   testability, 7 new tests), provably bounded regardless of repository name length.
3. **Hardcoded `primaryLanguage: "typescript"`.** Every repository was validated as if it were
   TypeScript regardless of its real language - meaning the just-shipped non-JS/TS exclusion fix had
   never actually been exercised live, only in local unit tests, and non-JS/TS repos reported the
   misleading "no tsconfig.json found" reason instead of the correct "does not yet support
   `<language>`" one. Fixed by threading the real language through explicitly. Fixing this also closed
   a real (auth-gated, but real) shell-injection gap: `owner`/`name`/`language` now pass a strict
   allowlist regex before ever reaching a shell command.
4. **The tsconfig/clone-cost bugs described in Part 1**, both caught specifically because this larger
   run exercised repositories the earlier small batch and cloud-validation runs never touched.

### Final result (all 19 repositories, independently re-verified via R2/D1, not just the responses)

| | |
|---|---|
| Repositories attempted | 19 |
| Repositories analyzed (real TS/JS graph analysis) | 6 - axios, jotai, zustand, ky, h3, ofetch |
| Repositories excluded (clean, explicit reasons) | 13 |
| &nbsp;&nbsp;- no tsconfig.json at root (JS) | 3 - express, fastify, kleur |
| &nbsp;&nbsp;- language unsupported | 10 - 3 Python, 2 Go, 2 Rust, 3 Java |
| Unique commit deltas | 19 (0 duplicates) |
| Reliability failures in the final run | 0 |

Every exclusion reason is specific and correct - verified by reading all 13 back directly, not just
trusting the summary counts. No repository was silently dropped or misreported.

### Real aggregate (via the actual `buildStage0Report` aggregator)

| Metric | Value |
|---|---|
| Median task reduction vs FULL | 14.3% |
| Median test reduction (DiffCI) | 98.6% |
| Median test reduction (PATH) | 0.0% |
| **DiffCI incremental test advantage over PATH (median)** | **0.0%** |
| Tests selected across all deltas: DiffCI / PATH / total | 293 / 777 / 910 |
| Aggregate-sum test reduction (DiffCI) | 67.8% (293/910 selected) |
| Unsafe misses | 0 |
| Proceed to Stage 1 | STOP (correctly - 6 analyzed repos is still below the 10-repo/500-delta floor) |

**Report the gap plainly, don't pick the flattering number:** median DiffCI test reduction is a striking
98.6%, but the aggregate-sum reduction across all 910 tests is a more modest 67.8%. That gap means the
distribution is skewed - most individual deltas got a near-total reduction, but a small number of
FULL-fallback deltas (which correctly select every test) dominate the sum because they occurred on the
larger-test-suite repositories. Both numbers are real and both are reported, rather than leading with
whichever looks better.

**The 0% median incremental advantage persists at this larger sample, for the same structural reason
identified in the small-batch report:** of 19 deltas, several are ties by construction (mandatory
fallback → both DiffCI and PATH correctly select everything; docs-only → PATH's own rule already
selects nothing) where DiffCI cannot possibly show an advantage over an already-optimal or
already-forced baseline. The real advantage - visible in the 2026-08-19 pilot's 16.3% median and in
individual deltas within this run - keeps showing up in genuine cross-file dependency changes, which
remain a minority of any deterministically-sampled commit window that also includes routine CI/config/
docs churn. This is not yet resolved by 19 deltas; it needs the real medium/full batch's higher delta
count per repository (100 commits/repo, not 3-4) to stop being median-swamped by tie-heavy categories.

### Cost

Real Cloudflare container time for all three attempts combined (first broken run + second run + the
three-repo re-verification) stayed in the tens of dollars-of-a-cent range at published rates - the
fast-path fix alone eliminated ~250 seconds of wasted container time across just 3 repositories, which
matters more at the 20-repo/2000-delta scale than it does here.

## GO / NO-GO

**GO for the medium batch.** All four infrastructure bugs found here are fixed and verified live, not
just patched and hoped-for. The exclusion-handling gate from the original small-batch report is closed.
The one remaining open item before the medium batch is the same one flagged before: cross-container-
instance resumability (checking R2/D1 before a container starts analyzing) is still not built - each
validation call today is self-contained. That's real orchestrator-level work, appropriately scoped for
whenever the medium batch is authorized to actually run at higher commits-per-repository, not something
this ad-hoc validation Worker needs to solve for a handful of commits per repo at a time.
