# Case study — DiffCI's own CI

**Status:** draft, not published. Numbers traced in [`../03-evidence-ledger.md`](../03-evidence-ledger.md).

> This is the one case study where the repository being analyzed is ours, so nothing here needs a
> permission disclaimer — and nothing here should be read as evidence about anyone else's repository.
> Its value is different: it is the part of the story where the tool was pointed at its authors.

---

## What runs where

DiffCI's test suite is **1,342 tests across 286 suites, currently green**, about 36 seconds locally. It
does not run on GitHub-hosted runners.

Instead, a `workflow_job` webhook reaches a Cloudflare Worker, which starts a fresh ephemeral container
running the GitHub Actions runner agent. The runner registers, executes the job, deregisters and
terminates. Roughly **$0.004 per job**, about **a minute of wall time** per run once warm, and **zero
GitHub Actions minutes billed**.

The blunt reason this exists: this account's GitHub Actions billing was blocked by a payment hold that
had nothing to do with the code. The choice was to wait, or to build the runner fleet. Building it turned
out to be the more useful outcome anyway — a CI-economics product that cannot measure its own CI's cost
is not in a strong position.

## Six real bugs between "it works" and "it keeps working"

Getting to a steady green state required fixing, in sequence:

1. A missing `User-Agent` header — GitHub's API 403'd every call from the Worker.
2. A CRLF-mangled shebang in the container entrypoint, courtesy of a Windows checkout.
3. Missing `libicu74` / `libssl3` on Ubuntu 24.04.
4. A runner agent fifteen releases out of date.
5. A container `sleepAfter` setting that killed idle containers while they waited in the queue.
6. The one that actually blocked steady state: **every Cloudflare container reports the same
   `HOSTNAME=cloudchamber`**, so every runner registered under the same name and each new registration
   silently killed the previous runner's connection.

The sixth is the interesting one, because it fails in the shape that matters: jobs completed, the
dashboard looked fine, and the fleet quietly could not sustain more than one runner. It was found by
looking at the runner registrations, not the job results.

## The bug our own green CI was hiding

While building the preflight work, a check of what CI was actually executing turned up this in
`package.json`:

```
tsx --test tests/**/*.test.ts
```

Unquoted. Bash without `globstar` does not recurse — `**` behaves as a single `*`, so the glob matched
one directory level and stopped. **Fifteen test files had, in all probability, never run in CI at any
point in the project's history.** The suite count went from 579 to 734 the moment it was quoted. Every
one of the newly-discovered tests passed, which is the only reason this is a story about measurement
rather than a story about a shipped defect.

CI had been green throughout. It was green because it was not looking.

This is on the website deliberately. A company selling "run fewer tests, safely" has to be visibly
serious about the difference between *a suite that passes* and *a suite that ran*. The runtime-selection
invariant in the case studies — the check that the test runner executed exactly the files that were
selected — exists because of exactly this class of failure, found here first, in our own repository.

## What our own preflight replay actually scored

The same discipline applied to our own failure history produces a number that is not flattering.

Replaying the preflight checks against **24 real historical CI failures of this repository**, in strict
chronological order with no access to future information: **16 true positives, 7 misses, 1 not
evaluable — a prevention recall of 0.696.**

The composition matters more than the number. Every one of the 16 catches is a `TYPECHECK` or
`CONFIGURATION` failure, the two classes the deterministic-tier checks can genuinely claim to cover.
**Every unit-test failure in the dataset — nine of them — was a miss.**

The first version of that replay scored 0.958, and it was wrong. It was crediting checks that are
declared for every commit regardless of whether any real risk signal fired, which meant a bare registry
entry was being counted as predictive evidence. Fixing that dropped the score to 0.667; correctly
excluding one failure whose class could not be determined at all brought it to 0.696. Both fixes are
permanent and covered by tests, and neither was made to reach a target number — the investigation started
because 0.958 was implausible.

## What this case study is for

**It shows:** the project measures its own infrastructure with the same instruments it points at other
repositories, and publishes the results when they are bad. It also shows that DiffCI runs its analysis
workloads on infrastructure whose per-job cost is known to four decimal places, which is a prerequisite
for ever netting its own overhead out of a savings claim.

**It does not show:** anything generalizable about savings. This is a single repository, it is ours, and
a sample of one is a sample of one.

## Sources

- [`../../CURRENT_STATE.md`](../../CURRENT_STATE.md) §5 — runner fleet, cost, and the six bugs.
- [`../../research/2026-08-22-preflight-p1-replay-results.md`](../../research/2026-08-22-preflight-p1-replay-results.md) —
  the 0.696 replay, including both corrections that produced it.
- [`../../research/2026-08-22-preflight-p1-test-discovery-bug.md`](../../research/2026-08-22-preflight-p1-test-discovery-bug.md) —
  the unquoted glob.
