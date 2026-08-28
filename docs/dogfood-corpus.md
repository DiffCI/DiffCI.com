# The dogfood corpus

**Started 2026-08-27.** The packaged proprietary agent, run against real repositories, in observation
mode. Nothing is skipped; DiffCI records what it *would* have selected while full CI still decides.

## Method

    private source → build → npm pack → exact .tgz → clean install → real repository → observation

`npm run dogfood` installs the tarball into a fresh prefix and executes **that** binary. It never
imports `src/client`. This matters: the packaging exercise found four defects — a missing shebang, an
install that dirtied the observed worktree, unparseable generated YAML, and a guard that silently
checked nothing — none of which a source-tree run could have surfaced.

`npm run dogfood:report` summarises a corpus. It reports safety and refusals first and the flattering
efficiency number last, on purpose.

## The corpus constraint, stated plainly

**Two repositories are owned, both private, both TypeScript.** The five-way stress matrix (monorepo,
different framework, unusual CI, unsupported language) cannot be built from owned repositories alone.

The two halves of testing have different requirements, and separating them removes the blocker:

| | Needs ownership? | Why |
|---|---|---|
| Local `.tgz` observation | **No** | The agent analyses a checkout. With no `api-url` configured nothing is transmitted anywhere. Any clonable repository is valid corpus. |
| CI-integrated test on a real runner | **Yes** | Requires committing a workflow and holding secrets. Limited to the two owned repositories. |

So the stress matrix is built from public repositories analysed locally, and the runner-integration
test is done on an owned repository. Neither waits for the other.

## Run 1 — DiffCI.com, 12 commits, agent 0.1.0

| | |
|---|---|
| Safety violations | **0** — non-interference held, privacy boundary held, every report written outside the checkout |
| Decisions | 6 FULL, 6 SELECTIVE |
| Versus a path-rule comparator | 9 fewer, 3 identical, **0 worse** |
| Analysis overhead | median 3.2s, p90 3.6s, max 5.2s per commit |
| SELECTIVE decisions falsified | **0 of 6 — and none were falsifiable. See below.** |

Four SELECTIVE decisions selected zero tests. All four were checked by hand and are genuine: one
CSS-only commit and three docs-only commits. Correct behaviour, not a blind spot — but the harness
flags them every time, because "selected nothing" and "failed to see anything" look identical in a
summary table.

## Finding 1 — green history cannot falsify a selective decision

This is the most important result of the run, and it is methodological rather than a defect.

A SELECTIVE decision is falsified when a test *outside* the selection changes outcome between base and
head. On a green-to-green history no test changes outcome, so running the full suite at those commits
proves nothing: every non-selected test passes, exactly as it did before, whether or not DiffCI's
reasoning was sound.

**A corpus of clean merges therefore cannot support a safety claim, no matter how large it gets.**
Scaling to 10 repositories × 30 merges would produce 300 unfalsifiable rows.

Falsification needs one of:

1. **Real red commits.** Find history where CI genuinely failed, and check whether the failing test was
   inside DiffCI's proposed selection. Scarce, and biased toward the failures people commit.
2. **Deliberate mutation.** Introduce a change with a known blast radius, then check DiffCI selected the
   tests that detect it. This repository already has the machinery — `src/analysis-fanout/mutation.ts`
   and the differential-baseline gates — built for exactly this question.
3. **Execute the non-selected set on red commits only.** The narrow, cheap version of (1).

Recommendation: mutation is the only one that produces evidence on demand. The corpus should carry both
— observed decisions for coverage and cost, mutation for safety — and the report should never let the
first stand in for the second.

## Finding 2 — `.html` is unclassifiable, so a static-site change forces a full run

`ASSET_EXTENSIONS` in [`src/repo/impact.ts`](../src/repo/impact.ts) contains `.css`, `.scss`, `.svg`,
`.png`, `.md`, `.txt` and more — but not `.html`. A commit touching only `site/*.html` produces
`Unknown changed file` and falls back to FULL, while a commit touching only `site/styles.css` correctly
selects nothing. Two commits in this run hit it.

**This is not obviously a bug, and it should not be fixed reflexively.** On this repository HTML cannot
affect a TypeScript test, so FULL is over-conservative. On a static-site-generator repository with
snapshot tests over rendered HTML, treating `.html` as an inert asset would be exactly the kind of
unsafe assumption the repo-agnosticism guard exists to prevent. The safe generalisation is probably
"an asset is inert if nothing in the graph reads it", derived per repository, not a longer hardcoded
list.

Recorded and deliberately left unfixed: changing engine behaviour mid-corpus would contaminate the
evidence the corpus exists to collect.

## Finding 3 — the same shell-quoting bug, three times

`shell: true` on Windows concatenates arguments, and this repository's own path contains a space. It
broke the esbuild call in the agent build, the `tar` call in the package inspector, and the `npm
install` in this harness. Each was fixed at the point of use — the API instead of the CLI, an
in-process reader instead of `tar`, a relative filename instead of an absolute path.

Three occurrences is a pattern, not bad luck. Any future code spawning a process with a
path-containing argument on Windows should assume this until proven otherwise.

## What this run does not establish

- Nothing about repositories that are not this one. Same framework, same layout, same author.
- Nothing about safety, per Finding 1.
- Nothing about real CI: no runner, no network submission, no authentication, no platform differences.
- Nothing about economics beyond analysis overhead — no test durations were measured, so there is no
  saved-time figure and none should be quoted.

## Next

1. Broaden the corpus with public repositories analysed locally, chosen to stress the matrix: a
   monorepo, a jest repository, a `node:test` repository, an unusual CI layout, and a
   non-TypeScript repository that must return FULL rather than guess.
2. Add the mutation pass, so SELECTIVE decisions become falsifiable.
3. Then the runner-integration test on one owned repository: install from the registry, analyse,
   submit, full CI continues. That is where authentication, platform differences and non-interference
   under real CI get tested.
4. Only after all three are stable is selective execution worth enabling anywhere.

---

# The mutation-recall pass

**Added 2026-08-27**, in response to Finding 1: an observation corpus cannot support a safety claim,
so the corpus needed a second, falsifiable axis.

    historical merge → full baseline → controlled mutation → full mutated run
                     → DiffCI selection → selected mutated run → classification

`npm run dogfood:mutate -- --repo <scratch clone> --reports <dir>`

## The mutation

Whole-file revert of a source file the merge itself changed, back to its exact pre-merge content
(reusing [`src/analysis-fanout/mutation.ts`](../src/analysis-fanout/mutation.ts), which was built for
this question). "If this change were undone, would the suite notice?" is exactly the regression the
merge's own tests exist to catch. It needs no per-case authoring, generalises to any repository, and
cannot produce a syntactically invalid file because the base version was itself real.

## Classification

| Full mutated run | Selected mutated run | Class |
|---|---|---|
| detects | detects | `RECALL_CONFIRMED` |
| detects | misses | `FALSE_GREEN` |
| does not detect | — | `RECALL_UNMEASURABLE` |
| baseline already red | — | `ENVIRONMENT_DIRTY` |
| harness failed | — | `INVALID_RUN` |

The full mutated run is a **gate**, not a data point. A mutation the whole suite cannot see measures
nothing about DiffCI, and counting those as successes would inflate recall with cases where recall was
never at stake.

**Primary safety metric: false greens / recall-measurable selective decisions.** Not over all commits.

Selection correctness is kept separate from economics throughout. No mutation is chosen to make DiffCI
look good or to produce a large saving; its only job is to establish whether an affected behaviour is
detectable outside the proposed selection.

## Run 2 — DiffCI.com, 2 candidates, after Finding 4 was fixed

| | |
|---|---|
| RECALL_CONFIRMED | 2 |
| FALSE_GREEN | 0 |
| RECALL_UNMEASURABLE | 0 |
| ENVIRONMENT_DIRTY | 0 |
| INVALID_RUN | 0 |
| **False greens / measurable** | **0/2 = 0.0%** |

| Commit | Attempted | Measurable via | Full failures | Selected failures | Missed |
|---|---|---|---|---|---|
| `1d57eb33c` | 1 | `src/planner/path-baseline.ts` | 1 | 1 | 0 |
| `77685fe31` | 2 | `src/repo/graph.ts` | 4 | 4 | 0 |

In both cases DiffCI's selection caught **every** failure the full suite saw — `missedBySelection` is
empty, which is the specific evidence behind RECALL_CONFIRMED rather than an inference from a count.

**n = 2. The 0.0% is honest and statistically meaningless, and must not be quoted as a safety result.**
What runs 1 and 2 establish is that the pipeline works end to end, can produce every one of the five
classes, and now extracts the evidence a merge actually contains.

Cost: roughly 2 minutes per measurable candidate, plus about 40 seconds for each unmeasurable file
tried along the way.

## Finding 4 — fixed: the harness gave up on the first mutation target

An earlier version stopped at the merge's first changed source file. For `77685fe31` that was
`scripts/screen-shadow-eligibility.ts`, a script with no test coverage, so the case died as
RECALL_UNMEASURABLE. Trying the next file — `src/repo/graph.ts` — produced 4 failures and a clean
RECALL_CONFIRMED.

**Measurable yield went from 1/2 to 2/2 on the same corpus.** The old number said more about the
harness than about DiffCI.

Every row now records `attemptedFiles`, so the search is visible rather than implicit, and the search
is capped (`--max-attempts`, default 5) with capped cases saying so in their reason instead of looking
like merges with nothing measurable in them.

**The sampling shift, stated rather than buried.** This moves the population from "a merge's first
changed file" to "any measurable file in a merge". It is not cherry-picking — only files the merge
itself changed are eligible, and the full-suite gate is unchanged, so nothing can be counted that the
suite cannot see. But it is a different question being answered, and results should say which.

## Finding 5 — `.html` frozen as a known conservative fallback

Recorded and deliberately unfixed for the duration of this corpus:

    SAFE_CONSERVATIVE_FALLBACK / HTML_DEPENDENCY_UNKNOWN

FULL is safe. The eventual fix is not a longer hardcoded extension list but a graph-derived answer to
"does anything in this repository read this file?" — which belongs to the intelligence layer, not to
`ASSET_EXTENSIONS`.

## Engineering invariant, promoted

> **No child process receiving repository-controlled or path-derived arguments may execute through a
> shell.**

Four occurrences: three found by failure (agent build, package inspector, dogfood harness) and one by
audit — [`scripts/diffci-execution-validation.ts`](../scripts/diffci-execution-validation.ts) passed
test file paths discovered inside a cloned repository straight through `shell: true` on Windows, which
would corrupt silently for any repository with a space in a path.

Enforced by [`tests/scripts/shell-invocation-invariant.test.ts`](../tests/scripts/shell-invocation-invariant.test.ts):
any file in `src/` or `scripts/` that spawns through a shell must also call `assertShellSafeArgs`.
The guard cannot tell which arguments are path-derived, so it enforces the procedure instead — a new
shell spawn fails the suite until someone has thought about it.

Where a shell is genuinely unavoidable (npm, npx and corepack are `.cmd` shims that Node refuses to
spawn directly since CVE-2024-27980), the split is: fixed literals may go through a shell after
assertion; repository-derived arguments may not, and are invoked through the runner's real JS entry
under `node` instead.

## Order from here

1. ~~Mutation harness~~ — done, end to end.
2. Raise measurable yield (Finding 4), then re-run to get n above 1.
3. Diverse public corpus — 4–6 repositories chosen to attack different assumptions: Vitest, Jest,
   `node:test`, monorepo/workspaces, unusual layout, and one unsupported ecosystem expected to FULL.
4. Owned-repo real CI with the packaged agent.
5. Only then selective execution anywhere.

Two independent evidence axes, kept separate: **safety** is mutation recall on measurable cases;
**generalisation** is how often an unseen repository can be understood without adaptation.

---

# The public corpus — 5 repositories, 50 observations

**2026-08-27.** Framework adapters for the failure parser, per-repository install and test commands,
and the first run against repositories nobody here wrote.

## Safety held everywhere

**Zero** non-interference violations, zero privacy-boundary violations, zero reports written inside a
checkout — across 50 observations on 5 unseen repositories.

## Decisions

| | | |
|---|---|---|
| SELECTIVE | 24 | 48% |
| REFUSED | 20 | 40% |
| FULL | 6 | 12% |

Analysis overhead: median 1.1s, p90 2.9s, max 3.2s.

## Finding 6 — refusal works, and the harness was hiding it

`expressjs/express` and `pallets/flask` produced `status: REFUSED` at `stage: eligibility` on all 20
commits, with the reason:

> DiffCI can only analyse TypeScript/JavaScript projects today: no `tsconfig.json` anywhere in the
> repository — there is no TypeScript project to build a graph from

That is the single most important result in the run: pointed at a Python project and a plain-JS
project, DiffCI declined, said why, and did not guess.

**The harness rendered all 20 as `unknown`.** A REFUSED report carries no `result`, so every column
read empty and the best outcome the corpus can produce looked like missing data. Fixed: REFUSED is now
a first-class decision with its reason recorded.

## Finding 7 — the package README overclaims support

The README says DiffCI supports "TypeScript and JavaScript repositories". Express is JavaScript, and
it is refused, because eligibility keys on the presence of a `tsconfig.json`. A JS-only project with
no tsconfig gets nothing.

The behaviour is defensible — refusing beats guessing — but the documentation promises something the
product does not do, and a customer would find out only after installing. **Fix the README, not the
engine**, unless JS-without-tsconfig becomes a supported case deliberately.

## Finding 8 — DiffCI is WORSE than a path rule on a monorepo

On `colinhacks/zod`, DiffCI selected **more** tests than the simple path-rule comparator on 5 of 10
commits:

| Commit | DiffCI | Path rule |
|---|---|---|
| `24cdb7fdc` | 124 | 24 |
| `8d896186c` | 124 | 113 |
| `43f729db4` | 120 | 105 |
| `97edaf7dc` | 124 | 112 |
| `9d5b20ef6` | 124 | 112 |

DiffCI selects roughly 124 of 192 tests — about 65% of the suite — on nearly every zod commit,
because a change almost anywhere in a tightly-coupled monorepo reaches most packages through the
graph. The path rule, knowing less, sometimes scopes better.

Run 1 on DiffCI.com reported "0 worse" and that reading did not survive contact with an unseen
repository. **On monorepos of this shape the value proposition is unproven at best.** This is exactly
what the corpus was built to find, and it should not be smoothed over in any customer-facing number.

## Mutation on a vitest repository

The parser adapters (node:test, vitest, jest, mocha) and per-repository commands were built for this.
`unjs/h3`, installed with `corepack pnpm` and tested through `node node_modules/vitest/vitest.mjs run`:

| | |
|---|---|
| RECALL_CONFIRMED | 1 — `baef4b94a`, via `src/utils/static.ts` |
| RECALL_UNMEASURABLE | 1 — neither revertible file was covered |
| INVALID_RUN | 1 — the merge changed no non-test source file |
| **False greens / measurable** | **0/1** |

The pipeline now works on a second runner, a second package manager, and a repository nobody here
wrote. Combined with DiffCI.com: **0 false greens out of 3 measurable cases.** Still far too small to
mean anything.

## Two harness defects found by using it

- **Corpus rows were not filtered by repository.** Pointing the mutation pass at one checkout while
  handing it a five-repository corpus attempted every other repository's commits against the wrong
  tree: 18 spurious INVALID_RUNs burying 3 real classifications. Added `--repository`.
- **The default install command lost its executable** in the per-repo refactor, so the harness tried
  to run a program called `install` and reported INVALID_RUN for everything. Caught by re-running the
  known-good DiffCI.com case as a regression before trusting the new path.

## Next

1. Mutation on zod — the monorepo where Finding 8 says selection is weakest, and therefore where a
   false green is most likely.
2. More measurable candidates. Target: 30-50 recall-measurable mutations across at least 3 unfamiliar
   supported repositories, with baseline qualification reported separately - NOT a historical-commit
   count, which Finding 9 shows optimises for the wrong thing.
3. Owned-repo real CI with the packaged agent.

---

# zod mutation — no measurement, and why that is the result

**2026-08-27.** All 9 candidates: `ENVIRONMENT_DIRTY`. 43–44 tests already failing before any mutation
was applied, so nothing after it could be attributed to DiffCI.

**The harness refusing to measure is the correct outcome, not a failure.** Had it scored these, every
row would have been noise dressed as evidence.

## Root cause

Two causes, both environmental:

1. **A missing build step.** zod's treeshaking tests fail outright with `Run \`pnpm build\` first` —
   the workspace packages must be built before the suite is meaningful. The harness ran
   `pnpm install --ignore-scripts` and went straight to tests. `RepoCommands` now takes an optional
   `build`, run between install and the first test.
2. **Historical commits do not stay green.** At HEAD with `CI=1` the suite shows 4 failures. At the
   nine historical commits it shows 43–44. Old code resolved against today's dependency versions and
   today's Node does not reproduce the environment those commits were green in.

## Finding 9 — green baselines are the real scaling constraint

Mutation recall requires a green baseline. Cause 2 above is not specific to zod: **any actively
maintained repository's older commits are liable to fail in a current environment**, and the further
back the corpus reaches, the worse it gets.

That has a direct consequence for the target of 30–50 measurable cases:

- Prefer **recent** commits. Depth into history is actively harmful here, which is the opposite of the
  intuition that a bigger corpus means more evidence.
- Expect `ENVIRONMENT_DIRTY` to be a large fraction of any historical corpus, and report it rather
  than quietly dropping those rows — the denominator is measurable mutations, and this is precisely
  what makes a commit unmeasurable.
- Reproducing a commit's original toolchain (its Node, its lockfile, its package manager version) is
  the only real fix, and it is a substantial piece of work in itself.

## A methodological error of my own, recorded

The zod output file contains **13 rows for 9 candidates**, four of them with `baselineFailures`
undefined. A first attempt at this run was killed at a 10-minute foreground limit; its Node process
outlived the kill and kept appending while the backgrounded second run had already truncated and was
writing the same `--out` path. Two processes, one file.

The classification summary quoted above comes from the second run's own in-memory counts and is
sound, but **the JSONL is contaminated and must not be aggregated**. The harness should take a lock,
or refuse to write to a path another run is holding. Recorded rather than quietly deleted, because a
corpus whose provenance cannot be trusted is worth less than no corpus.

## What zod did NOT tell us

The two questions it was chosen to answer are both still open:

- Does DiffCI preserve recall when its graph gets broad?
- Why does knowing more about the dependency graph sometimes cause it to execute more than a path rule?

The observation data still says selection is overbroad there — 124 of 192 on nearly every commit,
against a comparator that managed 24 on one. But **overbroad-and-safe versus overbroad-and-unsafe is
exactly what the mutation pass exists to separate, and on zod it has not yet run.**

## Next

1. Re-run zod with `--build "corepack|pnpm|build"`, restricted to the most recent commits where a
   green baseline is plausible.
2. If baselines still will not go green, drop zod as a mutation target and keep it as observation-only
   evidence for Finding 8 — a repository can be informative about efficiency without being measurable
   for safety.
3. Broaden measurable candidates from repositories whose recent history is green.

---

# zod qualification — abandoned, per the decision tree

**2026-08-28.** `--qualify-only`, recent commits, build step requested. Result: **0 qualified, 9
`ENVIRONMENT_DIRTY`**, 43–44 failures.

## The run was invalid, and the manifest is how that was discovered

The failure counts came back *identical* to the previous run — 43, 44, 44, 44, 43, 43. Identical
counts across a supposedly different configuration is not a result, it is a smell, and the run
manifest settled it in one look:

```json
"commands": { "install": ["corepack","pnpm","install","--frozen-lockfile"],
              "testModule": "node_modules/vitest/vitest.mjs", "testArgs": ["run"] }
```

No `build`. **`--build` was never wired into `main()`** — the flag was accepted on the command line,
silently ignored, and the "qualification run with a build step" was byte-identical to the run it was
meant to differ from. Now fixed.

This is the provenance mechanism paying for itself on its first outing. Without the manifest the
obvious conclusion — "zod is dirty even with a build" — would have been recorded as a finding and was
simply false.

## Why zod is being abandoned anyway

With the flag fixed, the build still does not work here. zod's build script is:

    pnpm run -r --filter zod build

Invoked as `corepack pnpm build`, the outer command succeeds and the script fails inside, because it
calls bare `pnpm` and nothing on PATH answers to that name. Making it work means provisioning
package-manager shims into a directory and prepending that to every child's PATH.

**That is historical environment reconstruction, which is explicitly out of scope.** It is also
unbounded: the next repository will need a different toolchain, a different manager version, and its
own set of assumptions about what is on PATH.

## Decision, per the agreed tree

**zod contributes ZERO safety evidence.** It is removed as a mutation target.

**Its efficiency evidence stands.** Finding 8 — DiffCI selecting 124 of 192 tests where a path rule
selected 24 — came from the observation pass, which needs no green baseline, no install and no
toolchain. That finding is unaffected by anything here.

The two questions zod was chosen to answer remain open, and will have to be answered by a
tightly-coupled monorepo whose recent commits build with a mainstream toolchain:

- Does DiffCI preserve recall when its graph gets broad?
- Why does knowing more about the dependency graph sometimes cause more execution than a path rule?

## Finding 10 — a repository can be observable but not measurable

These are separate qualifications and should be tracked separately:

| | Needs | zod |
|---|---|---|
| **Observation** — decisions, efficiency, refusal behaviour | a checkout | qualifies |
| **Mutation** — safety, recall | install + build + green baseline + toolchain | does not qualify |

A corpus entry should carry both verdicts. Reporting "5 repositories in the corpus" without saying how
many are mutation-qualified would overstate the evidence considerably — today it is 5 observable and
2 mutation-qualified.

---

# Corpus schema: two independent qualifications

**2026-08-28.** Finding 10 is now part of the corpus schema rather than a note, because the failure
mode it prevents is a claim nobody would make deliberately: *"tested on 20 repositories"* implying
twenty repositories contributed safety evidence.

Every corpus entry carries two independent capabilities:

| Capability | Requires | Yields |
|---|---|---|
| **observation-qualified** | a checkout | decisions, efficiency versus the comparator, refusal behaviour |
| **mutation-qualified** | install + build + a green baseline + a working toolchain | **safety evidence, and nothing else does** |

`npm run dogfood:qualify` establishes the second, cheaply and at HEAD: clone shallow, run the
documented install, run the documented build, run the suite once, ask whether it is green. A
repository that cannot pass at HEAD will not pass at ten historical commits, and learning that here
costs one install instead of ten mutation loops.

Unreadable runner output is treated as **not qualified**, never as zero failures — the same rule the
mutation classifier follows, for the same reason.

## Current corpus

| Repository | Observation | Mutation | Why |
|---|---|---|---|
| `unjs/h3` | yes | **yes** | Produced a RECALL_CONFIRMED |
| `sindresorhus/ky` | yes | unknown | Uses ava; no adapter yet |
| `colinhacks/zod` | yes | **no** | Build shells out to a bare `pnpm` this harness does not put on PATH |
| `expressjs/express` | yes | no | Refused at eligibility — no selection to measure |
| `pallets/flask` | yes | no | Refused at eligibility — nothing to mutate |

**zod is mutation-unqualified under this harness environment, not intrinsically unsuitable.** The
failure is environmental, and the harness was deliberately not expanded to reproduce it. That
distinction is recorded in the corpus entry itself so a future reader does not mistake a scope
boundary for a property of the repository.

## How the standing evidence must be stated

> **Safety validation: 3 recall-measurable mutation cases across 2 mutation-qualified repositories;
> 0 observed false greens.**

Not "DiffCI has a 0% false-green rate". The first is evidence. The second is a reliability estimate
that 3 cases cannot support, and the difference is the whole discipline of this exercise.

## The next experiment, and what each outcome means

One tightly coupled TypeScript monorepo on a mainstream toolchain — the structural class zod
identified — chosen for its ability to **disprove** the selector rather than to flatter it.

Target: **10 measurable mutations on a third repository.** Not 30–50 yet.

| Outcome | Meaning |
|---|---|
| 0/10 false greens, mostly efficient selections | Expand the corpus |
| 0/10 false greens, overbroad selections | Safety and economics have cleanly separated. Investigate graph explosion — this is the intelligence-layer question |
| ≥1 reproducible false green | **Stop scaling.** That failure becomes the highest-priority engine problem |
| Almost nothing measurable | Candidate selection is still the bottleneck; fix that before adding repositories |

Candidates queued: `TanStack/query`, `vuejs/core` (both tightly coupled pnpm/vitest monorepos with
heavy cross-package imports) and `honojs/hono` as a less-coupled control.

---

# Finding 11 — flakiness is a worse threat than dirtiness

**2026-08-28.** `honojs/hono` failed qualification with **one** failing test. A re-run was completely
green: 147 files, 4,961 tests, nothing failing.

hono is not dirty. It has a flaky test — and that is the more dangerous condition:

| Baseline state | What the harness produces | Is the answer trustworthy? |
|---|---|---|
| Dirty | `ENVIRONMENT_DIRTY` | Yes — an honest refusal to measure |
| **Flaky** | **a classification** | **No — and nothing downstream can tell** |

A flake during the *mutated* run reads as "the mutation was detected" and manufactures a
`RECALL_CONFIRMED`. A flake during the *selected* run reads as detection where the selection actually
missed. Either way the safety number is fiction, and it is fiction that looks exactly like evidence.

Dirtiness costs a measurement. Flakiness costs the truth of one.

## The gate now requires consecutive green runs

Qualification runs the suite **twice** (`--baseline-runs`, default 2) and demands green on both. Green
once and red once is reported as `FLAKY` by name rather than folded into "dirty", because the remedy
differs: a dirty repository needs its environment fixed; a flaky one needs its unstable tests
identified and excluded, or it must not contribute safety evidence at all.

Two runs do not prove stability — they detect the flakiest cases cheaply. A repository that passes
twice can still flake on the fifth run, and the mutation pass remains exposed to that. The honest
statement is that this raises the bar, not that it closes the hole.

## What this implies for the existing evidence

The three standing recall-measurable cases were measured **without** a flakiness gate. Neither h3 nor
DiffCI.com showed differing counts across the runs they did get, but neither was checked for it
deliberately.

> **Safety validation: 3 recall-measurable mutation cases across 2 mutation-qualified repositories;
> 0 observed false greens; flakiness not controlled for at the time of measurement.**

That last clause is not hedging. A `RECALL_CONFIRMED` obtained over a flaky suite is exactly the
false-confidence this corpus exists to prevent, and the qualification that would have ruled it out did
not yet exist when those three cases were run.

---

# hono qualifies — and contradicts the graph-explosion hypothesis

**2026-08-28.** `honojs/hono` passed the two-run gate (green on both), confirming its earlier single
failure was a flake. Second mutation-qualified repository.

Then the observation pass over 25 commits produced a result that undercuts a hypothesis I had already
half-adopted.

## The hypothesis, and why it is now in doubt

After zod, the working explanation for overbreadth was **transitive reachability exploding in tightly
coupled monorepos**: a change anywhere reaches most packages through the graph, so DiffCI selects most
of the suite. It predicted that a loosely coupled single-package library would not show the problem.

hono is that control. It is not a monorepo. And DiffCI selected **more tests than the path-rule
comparator on 14 of 25 commits — 56%, worse than zod's 5 of 10.**

| | hono |
|---|---|
| Mutation candidates available | 22 |
| Overbroad vs path rule | 14 / 25 |
| DiffCI selection ratio | 1% min, **15% median**, 67% max |
| Path-rule comparator | **median 8** of 136 |

## What the numbers actually say

DiffCI's median selection here is 15% of the suite — in absolute terms, good. The comparator's median
is **8 tests**. hono's directory layout maps so cleanly onto its tests that a rule knowing nothing
about imports scopes better than a dependency graph does, most of the time.

So the pattern is not "monorepos break the graph". It is closer to:

> **DiffCI's value depends on whether a simple path rule already scopes well — and where a repository
> has clean directory-to-test correspondence, it usually does.**

That is a harder problem than graph explosion, because it is not a bug to fix. On h3 DiffCI won (46
against 70). On DiffCI.com it won 9 of 12. On hono and zod it lost. The differentiator is a property
of the repository, not of the algorithm — which suggests the product question is *which repositories
is this worth running on*, and that DiffCI should be able to answer it from a repository's own
structure before anyone pays for it.

**This is efficiency evidence only.** Nothing here says DiffCI is unsafe on hono; safety is what the
mutation pass measures, and on hono it has 22 candidates waiting.

## Method note: the mutation run is deliberately NOT started yet

A tightly-coupled-monorepo qualification (`TanStack/query`) is already running. Starting hono's
mutation pass alongside it would put two full test suites on one machine at once.

That is not merely slow — **it risks inducing the exact flakiness Finding 11 was written about.**
Timing-sensitive tests fail under CPU contention, a flake during a mutated run manufactures a
`RECALL_CONFIRMED`, and the corpus would record fiction. Heavy runs are serialised for the same reason
the flakiness gate exists.

---

# Finding 12 — the interesting repositories are the expensive ones

**2026-08-28.** `TanStack/query` installs cleanly once corepack stops prompting, and then fails
**59 tests at HEAD on both runs** — deterministically dirty, not flaky. The gate answered cleanly.

The cause is not Windows and not the repository being broken:

    Failed to resolve entry for package "@tanstack/svelte-query"

Workspace packages are not built. **Exactly the same class as zod.**

Its documented build is `nx affected --target=build`, which computes what changed relative to a git
base — and qualification uses a shallow clone, which has no history to compute against. Making it work
means a deeper clone, an nx base ref, and a full monorepo build. That is environment engineering, and
the boundary says stop.

## The pattern across five qualification attempts

| Repository | Shape | Mutation-qualified | Blocker |
|---|---|---|---|
| `unjs/h3` | single package | **yes** | — |
| `honojs/hono` | single package | **yes** | — (one flake, caught) |
| `colinhacks/zod` | monorepo | no | needs a build; build shells to bare `pnpm` |
| `TanStack/query` | monorepo | no | needs a build; build needs git history |
| `expressjs/express` | single package, JS | no | DiffCI correctly refuses it |

**Both single-package repositories qualified. Both monorepos did not, for the same reason.**

Tightly coupled monorepos require their workspace packages to be built before tests run, and the build
is where reproducibility gets expensive. This is a structural bias in the methodology, and it points
the wrong way:

> **The repositories most interesting for the graph-explosion question are precisely the ones whose
> baselines are hardest to reproduce.**

Safety evidence is therefore currently obtainable only from the class of repository where the question
is least pressing. That is worth stating plainly rather than letting a corpus of single-package
libraries stand in for the general case.

## What this does not change

The efficiency finding does not depend on any of this. Observation needs only a checkout, so zod and
TanStack still contribute — and zod already showed DiffCI selecting 124 of 192 where a path rule
selected 24. Efficiency evidence from monorepos is available; safety evidence from monorepos is not.

## The honest options

1. **Accept the bias and state it.** Safety evidence from single-package repositories; efficiency
   evidence from both. Say so wherever the numbers appear.
2. **Run the corpus on Linux with a warm toolchain.** Not per-commit reconstruction — just a normal
   Linux environment where these builds are routine. Bounded, and it would likely unlock both monorepos.
3. **Build environment reproduction.** Explicitly rejected: unbounded, and unnecessary to answer the
   immediate question.

Option 2 is the only one that removes the bias, and it is a one-time cost rather than a per-repository
one. It is not being done now; it is recorded as the decision point.

---

# The validation environment, and two consequences of Finding 12

**2026-08-28.** Finding 12's bias is being removed rather than accepted:
[`ops/validation-env/`](../ops/validation-env/) defines one canonical Linux environment — fixed Node,
corepack enabled, npm/pnpm/yarn available by name, git with full history, a native-module toolchain.

The contract is deliberately narrow. **Permitted:** a full clone with real history, the repository's
declared package manager, its documented install, its documented build, two green baseline runs.
**Not permitted, ever:** databases, external services, credentials, historical Node versions, or
patching a repository to make its suite pass. A repository needing any of those is reported unqualified
with the reason — a finding about reproducibility, not a task.

Qualification now does a **full clone by default**. TanStack's build is `nx affected --target=build`,
which asks git what changed; shallow-cloning it produced a disqualification that described the harness
rather than the repository. Giving a git-dependent build git history is a property of that build.

## Consequence 1 — a product feature the corpus argues for

hono made this concrete: DiffCI's median selection was 15% of the suite, which sounds good, while the
path-rule comparator's median was 8 tests, which is better. DiffCI lost on 14 of 25 commits.

The pattern across four repositories is that **DiffCI's value is a property of the repository**, not of
the algorithm — clean directory-to-test correspondence means a cheap rule already wins. Shadow mode is
already computing both numbers on every observation, so the product can say so before anyone pays:

    Optimization opportunity: HIGH
    Graph-based selection materially outperforms this repository's own path-rule baseline.

    Optimization opportunity: LOW
    This repository's structure already permits inexpensive path-based selection.

That is a better product than applying one optimisation strategy everywhere, and it is honest in a way
a savings pitch is not. It also needs no new measurement — only reporting what the comparator already
records.

## Consequence 2 — the climate model must not extrapolate past this

`src/usage/climate-model.ts` converts avoided compute into avoided CO₂e. Finding 8 and the hono result
say plainly that **avoided compute is not uniform across repository structures**, and on some
repositories a trivial path rule captures most of the same benefit at no cost.

Extrapolating DiffCI's gross reduction to a population of repositories would therefore overstate the
*incremental* saving — the part attributable to DiffCI rather than to an optimisation the customer
could have had for free. Any climate or cost figure must be computed against the path-rule comparator,
not against running everything, exactly as the ledger already insists for money.

This is not a new rule. It is the existing "never invoice from an ESTIMATED figure" discipline applied
to carbon, and it needs stating before any external claim is made.
