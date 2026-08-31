# Chronology of defects in the validation laboratory

Every defect found in the measuring apparatus itself, in the order it was found. None of these were
bugs in DiffCI's selector — they were bugs in the machinery built to judge it, which is the more
dangerous category, because a broken selector produces a bad product and a broken laboratory produces a
*confident* bad product.

**The pattern worth noticing:** almost every one of these, left unfound, would have produced evidence
**stronger** than reality warranted. That asymmetry is not coincidence. A laboratory that fails toward
pessimism gets fixed immediately, because someone is unhappy with the result and goes looking. A
laboratory that fails toward optimism gets believed.

This file is kept as a record, not as a to-do list. Everything here is fixed **except #13 and #15**,
which are open: #13's correction is a decision rather than a patch, and #15 is deliberately left unfixed
until the experiment it interrupted has finished, so that an infrastructure repair cannot contaminate a
result.

## The safety phase

| # | Defect | What it would have produced |
|---|---|---|
| 1 | **Empty run reported as success.** The corpus was labelled with the pinned clone's *path*, so the mutation pass's `--repository` filter matched nothing and wrote a `COMPLETE` run with zero rows in 30 seconds. | A clean green bundle over no evidence at all. |
| 2 | **A parser that could not read its own runner in colour.** Every adapter anchors on `^\s*`; a coloured summary line starts with an escape sequence. | 22/22 `INVALID_RUN` on passing suites — and, in the dangerous direction, a *failing* summary hidden by colour would make a caught mutation look uncaught. |
| 3 | **No diagnostics on an unparseable run.** The harness recorded the parse failure and discarded the output. | Not a false result, but it cost four container runs to find defect #2. |
| 4 | **A bundle that misreported its own provenance.** The shard never set `DIFFCI_VALIDATION_IMAGE`, so a canonical container run froze carrying the caveat *"produced on a developer host"*. | A bundle that lies about where it came from is worse than no bundle. |
| 5 | **An ignored exit status.** `tanstack-qualify-02` parsed a passing summary out of a run that exited non-zero. | A **false green** — recorded permanently as `INVALID VERDICT`, not rewritten as "superseded". Fixed by `classifyExecution()` and the `CONTRADICTORY_EXECUTION_EVIDENCE` outcome: process exit status is authoritative and parsed output can never override it. |
| 6 | **An unbounded clone stage**, and **two divergent process environments inside the mutation harness**. | Hangs, and runs that were not like-for-like. |
| 7 | **An 800-character output tail** that landed inside hono's coverage table rather than its summary. | Diagnostics that showed nothing. Replaced with summary-shaped line extraction by content. |

See [safety-validation-milestone.md](safety-validation-milestone.md) and
[hono-cross-environment-reproduction.md](hono-cross-environment-reproduction.md).

## The economics phase

| # | Defect | What it would have produced |
|---|---|---|
| 8 | **`armArgs` omitted the test module**, so the DiffCI arm invoked `node run <files>`. | 22/22 compute-unmeasurable. Caught by a guard — but had the guard not existed, a near-zero DiffCI arm against a full comparator arm would have manufactured an enormous fake positive. |
| 9 | **The glob filter stripped `unit*`.** My first version keyed on `/`, which also removed vitest project names. | Vue measured against the wrong project set. Caught by a test I had written for `@vitest/test-*`. |
| 10 | **The symbol-precision diagnostic was tautological.** The changed file is in every closure by construction, so the first run returned 183/0/0. | It would have "confirmed" the conclusion the experiment eventually reached — *by construction*, proving nothing. Fixed by skipping the definition site and stripping `export ... from` lines. |

## The eligibility gate

| # | Defect | What it would have produced |
|---|---|---|
| 11 | **`FULL` decisions counted at `selected: 0`.** A `FULL` decision did not select a small subset — it declined to narrow and runs the entire universe. Summing the raw field records DiffCI's *most* expensive outcome as its *cheapest*. | **The worst defect in this file.** vuejs/core has 8 such candidates of 25. Counting them at zero moves the prediction from **−861.01 (NEGATIVE)** to **≈ +281 (POSITIVE)** — a sign flip, in DiffCI's own favour, entirely silently. The eligibility product would have recommended deployment on precisely the repository where DiffCI performed worst of the three. Fixed by `effectiveSelection()`, which exists as a named function so the reasoning has one home, and the FULL count now prints with every observation-path verdict. |
| 12 | **`resolve("")` is the current directory.** A missing `--repo` passed `existsSync` and calibrated against DiffCI.com itself. | A calibration attributed to a repository that was never examined. Found by running the script with no arguments; the guard now checks the flag, not the resolved path. |
| 13 | **Qualification could declare success without verifying coverage of the intended test universe.** Green + exit 0 + zero failures + repeatable does not establish that the intended suite actually ran. Triggered by the root invocation chosen for `date-fns/date-fns`, which collected **14 test files** while `pkgs/core` alone collects **262**, but the dangerous property is generic and not date-fns-specific. | **The most dangerous shape in this file: a PASSING result over almost none of the subject.** `datefns-qualify-01` reported MUTATION-QUALIFIED, green on two consecutive runs, exit 0, in 3 seconds - every conventional signal excellent. Believed, every later observation, prediction and economics figure would have described a fraction of the repository named. Caught by arithmetic against an independently established file count, not by a wrong answer, and later reproduced on a different host. No generic coverage invariant has been built: turning this into new qualification functionality during an external assessment is what the protocol forbids. For this target the frozen record showing 14 against an independently counted 262 was enough. |

## The survey and its economics

| # | Defect | What it would have produced |
|---|---|---|
| 14 | **The `/v1/result` allowlist omitted the survey's own artefacts.** `survey-summary.json`, `survey.log` and the per-entry facts were written to R2 and then unreadable through the only route that can read them. | Not a false result - the run completed and the data was safe - but it is **defect #4 recurring identically**, three months on. A write path and a read allowlist edited separately will keep diverging. Fixed, and the facts endpoint is now a constrained prefix rule rather than 40 more names to forget. |
| 15 | **Sharding has never been executed successfully.** `MAX_SHARDS`, `assignShard()` and the merge guards were built and unit-tested, but every real run to date used `shards: 1`. The first live use was a 6-way and a 4-way run launched together, and all ten shards failed fighting over identical paths. | Ten wasted containers. **CORRECTED 2026-08-30, and the correction matters more than the defect.** I first reported this as "shards of one run share a container filesystem", inferred from the three unsharded runs succeeding alongside. That inference did not survive: the next round had no sharding at all and four of five unsharded runs died at bootstrap with `The sandbox container stopped while the operation was pending`, including a run launched entirely alone. Every one of those failures clustered within minutes of a `validation:deploy`, and a probe run well clear of a deploy succeeded in 43 seconds. So sharding is **untested, not proven broken** - the sharded attempt may have failed for the same transient reason as everything else that evening. Left open, and not to be diagnosed until the experiment it interrupted has finished. |

| 16 | **A failed run destroyed the evidence explaining why it failed.** `fail()` terminated immediately, so `collect` never ran and everything the container had produced went with it. | **It cost the single measurement the Prettier experiment existed to make.** 25 observations completed over 4h11m; `locate` refused because none was selective; the corpus carrying the REFUSED / FULL / SELECTIVE-empty distribution was discarded with the container. The worst case for the product was also the case where the harness threw away the evidence - the same shape as defect #3, and flagged in advance here without being fixed in time. **FIXED**: failures now route through a `preserving` step that best-effort copies logs, the observed corpus, any survey summary and any run directories into R2 under `failed/`, then terminates. Preservation is strictly additive - it cannot change a verdict, cannot rescue a run, and cannot fail one twice. Two further fixes shipped with it: `observeOnly` no longer routes through `locate` at all (an observation-only job could previously only reach collection when selectable candidates existed - the one case it is FOR was the one case it could not report), and the read allowlist was extended in the same commit rather than lagging behind the writer, which is how #4 and #14 happened. |

## The 2026-08-30 container incident, and three wrong inferences

Kept because the pattern is worse than any single defect: **I proposed a cause three times and was
wrong three times**, each time on evidence that looked sufficient.

1. *"Shards of one run share a container filesystem."* Refuted by unsharded runs failing the same way.
2. *"Concurrent container capacity."* Refuted by a single run, launched alone, failing identically.
3. *"The container platform is down."* The probe I called decisive was **malformed** - it passed a
   nonexistent agent tarball key, so its failure was evidence of nothing. A correctly-formed probe
   completed cleanly minutes later.

What the evidence actually supports, stated no wider: the container application is healthy (0 failed,
5 healthy, no errors); every bootstrap failure fell within minutes of a `validation:deploy`; the
container application shows `version: 2` updated at 15:02:40; runs launched clear of a deploy succeed.
A rollout window is the most consistent explanation and **causation is not established.**

The lesson is not about containers. Each inference was offered with a supporting observation, and each
supporting observation was consistent with a cause I had not considered. The correct output on the
first failure was "cause unknown, here is what is established" - the same discipline already applied to
`zod-qualify-01` and to fastify's two red tests, and not applied here.

## One hypothesis of mine that was wrong, kept for the same reason

I proposed that `spawnSync`'s timeout fails to bound a process *tree*, which would have explained
`zod-qualify-01`'s 180-minute run. A direct probe refuted it on Windows, and calibration in the
canonical Linux environment refuted it there too.

`zod-qualify-01` therefore remains `QUALIFICATION_TIMEOUT / cause unknown`. No cause has been
established and none is claimed. A plausible mechanism that survives only because nobody tested it is
the same failure mode as everything above, one level up.

## Why this matters for the external phase

The external validation protocol ([external-validation-protocol.md](external-validation-protocol.md))
freezes the predicted sign before economics run, and forbids changes to the predictor in between.
Defect #11 is the argument for that rule: it was found by reading the corpus schema carefully, *not* by
noticing a wrong answer — because the wrong answer would have looked like good news.

## Defect 17 — test discovery ignores the runner's own configuration

Found 2026-08-31 closing M2 on the ts-jest mutation result.

DiffCI reported a test universe of **40** for `kulshekhar/ts-jest`. The repository's `jest.config.ts`
sets `testMatch: ['<rootDir>/src/**/*.spec.ts']`, which matches **20**. The other 20 are `e2e/` and
`examples/` spec files that this configuration never executes.

Discovery enumerates test-suffixed files in the tree and never intersects that set with the runner's
configured `testMatch` / `roots` / `testPathIgnorePatterns`.

**Consequence on this repository: reporting only.** Every selection fraction was stated against a
denominator roughly twice the real one (candidate 5's headline `2/38` is truly `2/20`). Checked
explicitly: no selected test fell outside `testMatch` on any of the five candidates, so no measurement
and no recall verdict is invalidated.

**Consequence in general: not confined to reporting.** A change under a directory the runner ignores
could lead DiffCI to select files that never execute — selection that looks like coverage and detects
nothing. Nothing in the current design prevents that.

Not fixed at the time of recording: the analyser is frozen against the MECHANISM_PROOF_01 result, and
changing discovery now would mean two results measured by two analysers. It is the first item for the
next apparatus change.

**FIXED 2026-08-31**, after `89fc236` was frozen and never by amending it. `src/repo/runner-universe.ts`
now reads the runner declared universe: `<rootDir>/` is stripped, an authoritative DEFAULT config
REPLACES the conventional globs instead of being unioned with them, and `testPathIgnorePatterns` and
`roots` are honoured. Verified against the real ts-jest tree at `b1a97ac4`: **20, not 40**, with zero
files outside `src/`.

The narrowing is gated on COMPLETE understanding of the config, because wrong-narrow can hide a test the
runner executes and that is the shape of a false green - a spread, an unresolved identifier, an
interpolated template or a call all leave the wide universe in force. A NAMED variant config
(`vitest.e2e.config.ts`) never speaks for what the bare runner executes. Regression suite:
`tests/repo/runner-universe.test.ts`.

## Defect 18 — `validation:pack` uploads a stale agent under a fresh label

Found 2026-08-31, immediately after the defect-17 fix, while preparing apparatus qualification.

`pack` selects whatever `.tgz` already sits in `dist-agent/` and never rebuilds it. After changing
`analyzer.ts`, `test-discovery.ts` and adding `runner-universe.ts`, packing reported the **unchanged
generation-B digest** `sha512-mlNTeKlr…`.

Had that gone unnoticed, the generation-C qualification would have run the **old** analyser while every
artefact — `environment.json`, the manifest, the corpus rows — recorded the new one. The defect-17 fix
would then have been "inherited" by results that never contained it, and the frozen `89fc236` analyser
identity would have propagated forward invisibly. That is the precise failure the qualification step
exists to prevent, and the apparatus itself was set up to cause it.

Caught by checking the digest against the previous one rather than by any automated guard.

**Fixed in the same session.** `pack` now REFUSES when the packaged agent is older than any file under
`src/` that it is built from, naming the offending files and the command to run. It refuses rather than
silently rebuilding: an operator who believes the wrong analyser is under test needs to be told, not
quietly corrected. Verified in both directions — a clean tree packs, and touching one source file
produces the refusal.

Generation C is `sha512-eQGRE3ep…`, and `tests/validation-env/apparatus-qualification-gen-c.test.ts`
asserts it differs from generation B.

## Defect 19 — a declared safety control that never executed

Found 2026-08-31, immediately after `survey-continuation-01` completed.

`requiresApparatus: "gen-c"` refuses to run a job unless the container is the qualified apparatus. The
check was placed at the **tail of `prepare()`** — but `calibrate`, `survey` and `density` all return
from `prepare()` *before* that point. For those three modes the control **silently never ran**.

`survey-continuation-01` declared `requiresApparatus: "gen-c"` and completed with the guard never
executing. I had stated in the same session that the guard would run for it. It did not.

**Actual exposure was small**, and only by luck of a second, older control: `expectedAgentIntegrity` is
enforced during bootstrap for every mode, so the agent digest — the thing defect 18 threatened — *was*
verified as generation C. What went unchecked was the image and node version, and E1 screening does not
use the analyser's selection logic in any case.

**The class of failure is the serious part.** The code was correct and unreachable. A declared control
that does not execute is worse than no control, because it is reported as protection — by the job
definition, by the documentation, and by me.

**Fixed:** the guard moved into `bootstrap()`, immediately after `record.environment` is populated,
which every mode passes through. `tests/validation-env/apparatus-identity.test.ts` now asserts
*structurally* that the guard's position precedes each early-return branch, because the defect was
structural rather than logical — no test of the guard's own behaviour could have caught it.

## Defect 20 — an E3 screen that excluded on a bogus match

Found in the same pass, before it affected anything.

The first E3 implementation searched evidence files for the repository name and excluded on any hit.
`testing-library/jest-dom` was flagged EXCLUDED — because the hit was **my own continuation frame file**,
which lists the package name. A frame listing is not a DiffCI measurement.

Left uncorrected it would have dropped an eligible repository from the population for a reason with no
substance, silently shrinking the draw. E3 now matches only artefacts that carry measurement structure
and explicitly ignores frame and population files. Result: 10 of 10, not 9 of 10.

## Defect 21 — the result allowlist assumed a two-digit rank

Found 2026-08-31 while pinning E2 to the trees E1 screened.

Survey per-entry evidence is served under `facts/<rank>-<name>.json`, matched by
`/^facts\/[0-9]{2}-.../`. **Exactly two digits.** The frame continuation runs to rank 140, so every fact
from rank 100 onward was written to R2 and then unreadable through the only route that can read it.

It presented as five repositories with "absent" head shas — evidence that looked missing but existed.
Had I trusted that reading, five eligible repositories would have been dropped from the population for a
reason with no substance, in the same way defect 20 nearly dropped one.

This is the third instance of one failure: defect 4 and defect 14 were both the allowlist lagging behind
a writer. The rank bound is now `[0-9]{1,5}`, taken from the frame rather than from a literal.

**Recovered:** 9 of 10 head shas now read back. `@testing-library/jest-dom` (rank 116) remains
unresolved — a scoped-name filename question, not an allowlist one — and its E2 job was REMOVED rather
than registered unpinned. The sequence stops at the fifth GREEN from rank 46, so it is unlikely to be
reached; if it is, the sha is resolved then.
