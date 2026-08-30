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
| 15 | **Sharding had never been executed.** `MAX_SHARDS`, `assignShard()` and the merge guards were built and unit-tested, but every real run to date used `shards: 1`. The first live use was a 6-way and a 4-way run launched together. All ten shards failed, fighting over identical paths: `could not lock config file /workspace/target-src/.git/config: File exists`, `rm -rf /opt/diffci /workspace` failing, `ENOTEMPTY` on rmdir, `npm ci` racing in `/opt/diffci/node_modules`. | Ten wasted containers, and - worse in principle - a sharded run that partly succeeded could have merged a short candidate list into a plausible funnel. The merge guards exist for exactly that and were never reached here, because every shard failed loudly. **Not repaired inside the experiment**: prettier and ts-jest were re-run unsharded under the unchanged apparatus instead, so an infrastructure fix cannot contaminate the two repositories carrying most of the economic information. The inference that shards of one run share a container filesystem is supported by the three unsharded runs executing concurrently without trouble, but it is an inference and no run was spent proving it. |

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
