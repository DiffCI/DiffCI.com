# ENGINE_COVERAGE_01, item 1 — dependency-pinning gate: investigation, not a fix

Scoped from `docs/engine-coverage-01-plan.md`. **This document is a decision artifact. It changes no
engine code.** It exists to answer one question:

> Under what independently observable conditions, if any, can DiffCI execute an install path without a
> committed lockfile or `packageManager` field while preserving its existing fail-closed reproducibility
> guarantee?

Primary regression evidence: **eslint and chalk** — the only two repositories in DiffCI's whole
validation history to hit this exact refusal, independently selected (chalk by mechanical rank, not by
me), which is what turned this from a theoretical edge case into a repeated mechanism worth investigating
at all. rimraf/lodash/husky are outside this investigation's core scope; referenced only where their
machinery is directly relevant.

## 1. The current invariant, traced precisely

`src/ci-inference/resolve.ts`'s `pinnedDependencyBasis()`:

```ts
export function pinnedDependencyBasis(facts: ObservedFact[]): { pinned: boolean; evidence?: EvidenceRef; detail: string } {
  const lock = facts.find((f) => f.kind === "lockfile.present");
  if (lock) return { pinned: true, evidence: lock.evidence, detail: `lockfile ${lock.value}` };
  const pm = facts.find((f) => f.kind === "package.packageManager");
  if (pm) return { pinned: true, evidence: pm.evidence, detail: `packageManager ${pm.value}` };
  return { pinned: false, detail: "no lockfile and no packageManager field" };
}
```

Feeds `DEPENDENCY_BASIS_PINNED`, one of three requirements every `install`-purpose operation must satisfy
(`reference-graph.ts`'s `COMPLETENESS_REQUIREMENTS.install`, alongside `COMMAND_RESOLVED` and
`WORKING_DIRECTORY_KNOWN`) before it counts as executable. Its own comment states the invariant directly:

> Without one, "install" is not reproducible: the same command resolves differently over time [...]

**Aside, noted but out of this investigation's scope:** the current check treats a bare `packageManager`
field as sufficient on its own, equivalent to a real lockfile, even though `packageManager` alone only
pins the *tool* version (e.g. `npm@10.2.4`), not the resolved dependency graph. Whether that's a real gap
is a separate question from "no lockfile and no packageManager field at all" — this investigation's two
regression repositories (eslint, chalk) have neither, so this asymmetry doesn't bear on the conclusion
below, but it's recorded so it isn't rediscovered as a surprise later.

### Why the invariant exists — not asserted, demonstrated

`docs/ci-reproduction-sample-01-member-5-babel-loader.md`: `babel/babel-loader`'s CI passed on
**2026-08-04** at the pinned commit `778e7c54d`. Its workflow runs `yarn add -D webpack@5` — a floating
range, no lockfile. Re-running that exact command **today** resolved `webpack@5.110.3`, published
**2026-09-01** — 28 days *after* the commit whose CI went green — and produced two new test failures
entirely explained by a change in webpack's own build-log format between those versions, nothing about
the pinned commit. This is not a hypothetical: it is the concrete, dated, empirically observed failure
mode `DEPENDENCY_BASIS_PINNED` exists to refuse before it can happen silently. The invariant it protects,
stated plainly: **a classification must be explained by the pinned source, not by which day the
reproduction attempt happened to run.**

## 2. The observed population failure, characterized concretely

Both regression repositories were checked against their real `package.json`, at their pinned commits, not
assumed:

| | total deps | floating (`^`/`~`/`*`/`latest`) | exact-pinned |
|---|---|---|---|
| eslint @ `2417cad57...` | 88 | 85 | 3 (2 `file:` self-refs, 1 exact `prettier`) |
| chalk @ `661317e6f9...` | 11 | 11 | 0 |

Neither repository has a lockfile or a `packageManager` field. This is not a marginal edge case for
either: for chalk, literally every dependency floats. The refusal is doing exactly what it's built to do
— it just also excludes two otherwise fully-executable CI pipelines (chalk's reference arm ran both
`npm install` and `npm test` to completion, exit 0, in the real canonical container).

## 3. Candidate alternative bases

For each: what independently observable evidence establishes it, what can change between runs, whether
identical inputs imply stable resolution, what provenance DiffCI would persist, and when the engine must
still `REFUSE`.

### Candidate A — engine-generated lockfile, no time bound ("resolve today, pin that")

Run `npm install --package-lock-only` (or equivalent) at reproduction time and treat the resulting
lockfile as this attempt's pin.

- **Evidence establishing it:** none from the original CI run. It is invented at reproduction time.
- **What can change between runs:** everything a floating range can resolve to. Re-running the identical
  reproduction attempt a week later can silently produce a different lockfile.
- **Identical inputs → stable resolution:** **no.** This is precisely the babel-loader/member-5 failure
  mode, just made explicit rather than accidental.
- **Verdict: rejected outright.** This is the exact trap named in the brief — it converts "npm install
  happened to succeed today" into an artifact that *looks* like a pin without being one. Recorded only
  because it's the obvious first idea and needs an explicit, on-record rejection, not a silent skip.

### Candidate B — time-boxed install via npm's native `--before <date>` ★ leading candidate

npm CLI has a first-class, documented config option (`workspaces/config/lib/definitions/definitions.js`
in `npm/cli`, confirmed against the running `npm@11.13.0`): `npm install --before=<date>` restricts
resolution to versions published on or before the given date, and **errors (`ETARGET`/`notarget`) rather
than resolving something else** if no version in range qualifies.

**Verified empirically, against the exact babel-loader scenario**, not merely read from docs:

```
$ echo '{"dependencies":{"webpack":"^5.0.0"}}' > package.json
$ npm install --before=2026-08-04 --package-lock-only
$ node -e "console.log(require('./package-lock.json').packages['node_modules/webpack'].version)"
5.109.2          # NOT 5.110.3 (published 2026-09-01) — the exact drift that broke member 5, excluded.

$ echo '{"dependencies":{"webpack":"^99.0.0"}}' > package.json   # a range with nothing eligible
$ npm install --before=2026-08-04 --package-lock-only
npm error code ETARGET
npm error notarget No matching version found for webpack@^99.0.0 with a date before 4/8/2026, 5:30:00 am.
```

- **Evidence establishing it:** the pinned commit's own CI run start timestamp (`started_at` on the
  GitHub Actions job) — already fetched by `src/shadow/github-baseline.ts` as part of collecting
  `ciGroundTruth`. Not a new external dependency; a new use of data DiffCI already retrieves.
- **What can change between runs:** in principle nothing, if npm's registry `time` metadata for
  already-published versions is itself immutable (it is, under normal operation) and the resolver
  algorithm doesn't change. In practice, two residual sources of drift remain (below) — smaller than
  Candidate A's, not zero.
- **Identical inputs → stable resolution:** **mostly**, with two named exceptions:
  1. **Resolver-algorithm drift.** `--before` narrows the *eligible* version pool by publish date; which
     version *within* that pool gets chosen is still today's npm resolver's decision (dedup strategy,
     peer-dependency handling), which is not guaranteed byte-identical to whatever npm major version the
     original CI run actually used. Smaller than Candidate A's exposure — it can no longer choose a
     version that didn't exist yet — but not eliminated.
  2. **Unpublish.** npm permits unpublishing a version within 72 hours of release, and rare registry-level
     removals happen. A version that existed at the original CI run's moment but was later pulled is
     invisible to `--before` today; resolution could silently fall to an older eligible version. Rare, but
     real, and **not self-detecting** from `--before` alone.
- **Provenance to persist:** the cutoff timestamp used (and its source: the specific GitHub Actions job
  `started_at`), plus the actual resolved version set (`npm ls --json` after install) as an inspectable
  artifact — not just "it succeeded."
- **When REFUSE still applies:** (a) the original run's `started_at` cannot be independently established
  (no baseline evidence, deleted run, private history unavailable) — no cutoff to set, refuse exactly as
  today; (b) the `--before` install itself errors — refuse, loudly, and **do not retry without the
  flag** (retrying unbounded would silently reintroduce Candidate A); (c) see §4 for further negative
  cases this candidate must not paper over.

### Candidate C — recover exact versions from the original CI run's own logs

If the original workflow's install step logged resolved versions (uncommon unless the workflow explicitly
ran something like `npm ls`), and GitHub still retains that run's logs (default retention ~90 days,
configurable up to 400 on GitHub-hosted runners — not guaranteed for an arbitrarily old pinned commit),
this is the *strongest possible* evidence: the actual historical record, not a reconstruction.

- **Evidence establishing it:** the original run's own log output, when both preserved and sufficiently
  verbose.
- **What can change between runs:** nothing — it's a historical fact, not a live query.
- **Identical inputs → stable resolution:** yes, when available — this isn't a resolution scheme at all,
  it's direct observation.
- **Verdict: not a general-purpose primary basis** — too narrow (most workflows don't log resolved
  versions; most retention windows won't reach an arbitrarily old pinned commit) to replace Candidate B
  as the main mechanism. **Valuable as corroboration when it happens to be available**: if Candidate B's
  time-boxed resolution and Candidate C's log-derived versions (when both exist for the same repository)
  agree, that's real, additional confidence Candidate B's residual risks (above) didn't bite this time. If
  they disagree, that is itself a genuine, reportable finding, not something to silently prefer one over.

### Candidate D — GitHub's Dependency Graph / SBOM API

Rejected. For a repository with no lockfile, GitHub's own dependency graph is itself a best-effort static
resolution computed against the registry state *at whatever time GitHub last processed the manifest* —
not guaranteed to reflect what was resolved at the original CI run's moment either. It inherits the same
problem it would be recruited to solve.

### Candidate E — a custom, hand-built point-in-time resolver

Rejected as unnecessary and higher-risk than Candidate B. npm's own `--before` already does exactly this,
built and maintained by the people who own the actual resolution algorithm. Reimplementing semver-range
resolution (including peer-dependency handling) independently would introduce a new, separate correctness
surface — a DiffCI-authored resolver silently choosing something npm itself would never have chosen is a
worse failure mode than refusing, not a better one.

### Candidate F — execute unconditionally, relabel the outcome instead of gating pre-execution

Run today's floating install regardless, but attach a distinct, lower-confidence outcome label instead of
refusing beforehand.

- **Verdict: rejected**, on methodological grounds specific to this project rather than technical ones.
  This project's whole vocabulary discipline (DEFECT 25, `GROUND_TRUTH_CONSISTENCY_01`'s
  `GROUND_TRUTH_CONTRADICTED`) exists specifically to prevent a result whose evidentiary basis is weaker
  than it appears from being interpreted as strong. A new "reduced-confidence" label is exactly the kind
  of surface most likely to erode into "REPRODUCED, but with an asterisk nobody reads" over time. Refusing
  until a genuinely stable basis exists (Candidate B) is safer than executing and hoping the label holds
  the line.

## 4. Threat / counterexample analysis — required negative cases

The eventual implementation must not let "the `--before`-boxed install happened to succeed" become "this
dependency basis is reproducible" any more than Candidate A would have. Explicit cases any implementation
of Candidate B must handle, not silently pass through:

1. **No independently-established cutoff timestamp exists.** REFUSE — this is not a relaxation of the
   invariant, it's the same refusal, just now conditioned on a fact instead of a blanket check.
2. **`--before` install errors (`ETARGET`).** REFUSE, loudly, with the actual npm error as evidence. Never
   fall back to an unbounded install to "make it work" — that silently reintroduces Candidate A.
3. **A dependency's registry `time` metadata is missing or unreliable** (private/scoped registries,
   vendored packages) such that `--before` cannot be verified to have actually constrained that package.
   The implementation must be able to detect this (e.g., by cross-checking that every installed version's
   own publish time is ≤ the cutoff, not merely trusting that `--before` was passed) and REFUSE if it
   can't confirm the constraint held, rather than assume npm enforced it everywhere.
4. **Candidate C evidence (when available) disagrees with Candidate B's resolution.** This is a genuine
   contradiction, not noise to average away — REFUSE or flag distinctly, don't silently prefer B.
5. **Non-npm package managers.** `--before` is npm-specific. A repository with `packageManager: yarn@...`
   but no `yarn.lock` (already a narrower case than eslint/chalk, since a `packageManager` field alone
   currently satisfies the existing gate — see the aside in §1) is not solved by this candidate at all.
   Do not silently extend the "pinned" verdict to yarn/pnpm on the assumption an npm-shaped fix covers
   them; that would be exactly the same class of mistake DEFECT 30 already caught once (a label asserting
   something the code never checked).
6. **A package with time-boxed resolution still resolves successfully, but its `postinstall`/native-build
   step is itself non-deterministic** (compiled binaries, node-gyp, platform-specific artifacts).
   Time-boxing the dependency *graph* says nothing about whether every dependency's install-time side
   effects are themselves reproducible. This is a real, separate concern this candidate does not claim to
   solve — it must not be allowed to look solved by proximity.

## 5. Conclusion

**A safe, principled relaxation exists, but it is narrower than the current invariant's binary
pinned/not-pinned check, and it must be represented as a new, distinctly-labeled requirement — not as
satisfying `DEPENDENCY_BASIS_PINNED` as currently defined.**

Recommended basis: **time-boxed install via npm's native `--before <original-CI-run-started_at>`**,
sourced from evidence DiffCI already collects, verified empirically above against the exact drift case
that motivated the existing gate. It is explicitly **weaker than genuine lockfile pinning** (residual
resolver-algorithm and unpublish risk, §3B) and must never be conflated with it in either code or
reporting — a new requirement (tentatively `DEPENDENCY_BASIS_TIME_BOXED` or similar; naming is an
implementation decision, not this document's) alongside, not replacing, `DEPENDENCY_BASIS_PINNED`.
Whatever outcome results from an install executed this way should carry that provenance visibly
(§3B's persisted cutoff + resolved-version artifact) so a reviewer can always tell a time-boxed
reproduction from a lockfile-pinned one.

This conclusion is not structurally forced — the investigation could have ended at "no safe alternative
exists" and that would have been an equally acceptable outcome per the brief. It didn't, because the
evidence (a real npm feature, empirically verified against the exact case that motivated the original
gate, sourced from data already collected, failing loudly rather than silently on every tested negative
case) genuinely supports it.

## 6. Implementation acceptance criteria (for a future, separate, narrower frozen plan — not this one)

Any implementation proposal for Candidate B must, at minimum:

- Introduce a distinctly-named, distinctly-labeled requirement — never silently satisfy
  `DEPENDENCY_BASIS_PINNED` as it exists today.
- Source the cutoff timestamp only from independently-collected `ciGroundTruth` evidence, never invented
  or defaulted to "now."
- Persist the cutoff and the resolved-version manifest as first-class evidence on every result produced
  this way.
- Cover all six negative cases in §4 with real tests, not just the happy path this document verified.
- Be validated against eslint and chalk specifically as **regression fixtures** — confirming the change
  moves exactly these two candidates and nothing else, per `ENGINE_COVERAGE_01`'s own methodology, not
  a general "looks better" check.
- Explicitly not attempt to extend coverage to non-npm package managers (§4.5) as part of the same change.

## 7. Untouched-holdout protocol — unchanged

Per `docs/engine-coverage-01-plan.md`: implementing this (or any) item does not itself validate the
engine-coverage phase. After regression passes against the existing corpora, the mechanical ranking
resumes at the next untouched rank (23 onward) as a genuine, never-seen holdout — not a re-run of
rimraf/lodash/husky/chalk/rollup, all of which stay closed, frozen evidence.
