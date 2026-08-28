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
2. More measurable candidates. 62 observations have produced 3 measurable cases; candidate supply is
   the binding constraint, not harness capability.
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
