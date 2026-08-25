# Report 14 — the complete 5-stage non-root comparison for PR #2808

Completes the requested table: base full, merge full, merge selected, full mutant, selected mutant, all under `runAsNonRoot: true`.

## The 5-stage table

| Stage | Result |
|---|---|
| base full | exit 1, **8 failures** |
| merge full | exit 1, **8 failures** |
| merge selected | exit 0, 0 failures |
| full mutant | exit 1, 7 failures (see below) |
| selected mutant | exit 1, 1 failure |

**Not the specified ideal outcome** (base/merge full both green) - stated plainly, not reframed as success. Non-root did not produce a clean baseline for PR #2808.

## What the base-vs-merge comparison actually proves

Exact `failedTests` diff between the base-SHA and merge-SHA non-root full runs:

```
common to both (6):      subprocess-local/process-exit.spec.ts x4, install-lefthook.spec.ts, terminal-bash/local.spec.ts
base-only (2):            oxlint-contract.spec.ts, ui-primitives/code-block.client.spec.tsx
merge-only (2):           subagent/continuation.spec.ts x2
```

**The 6 common failures are now directly proven, not inferred, to predate PR #2808's own change** - identical test IDs, present at the base commit before the merge's diff was applied. Exactly satisfies the user's own stated condition (*"if base and merge exhibit identical environmental failures, you can claim: no change-induced baseline failure was missed"*) for these 6, for PR #2808 specifically - the second merge (after `#2760`) with this exact confirmation now on record.

**The base-only-2 and merge-only-2 are different tests each time** - not the same flaky pair recurring, but genuinely different tests firing on different runs. This is consistent with ordinary, low-level test flakiness in this repository/environment, independent of root/non-root and independent of which merge is checked out. Not confirmed as flaky in the strict sense (would need repeated runs to establish a stable/unstable fingerprint, per the recommended resolution order's step 2, not done here) - reported as "consistent with," not "proven to be."

## Combined with the merge-run's own mutant comparison (Report 13)

`mutant.full`'s 7 failures = all 6 stable/common failures (`subprocess-local`×4 + `install-lefthook` + `terminal-bash`, unchanged) **plus** `frontend-static.spec.ts` (the real, attributable mutation failure). The 2 `subagent/continuation` merge-only flakes from `baseline.full` did **not** reappear in `mutant.full` of the same run - consistent with them being unstable rather than a deterministic property of the merge SHA.

## Updated classification for PR #2808

```
Raw CI outcome preservation (root):      0/1 (baseline.full red, baseline.selected green)
Raw CI outcome preservation (non-root):  0/1 (same - 8 failures remain, not 0)
Change-attributable false green:          NO - all 6 stable failures proven to predate the merge
Root-attributable failures:               10/16 (confirmed by direct execution, root mode)
Non-root-persistent failures:              6/16 (confirmed stable across base AND merge, non-root mode)
Unattributed flaky observations:           4 (2 root-mode 1/5-merge singles from Report 11/12,
                                             2 non-root subagent/continuation - none repeat across runs)
Differential mutation recall:              confirmed, replicated identically under both root and non-root
```

## Product-policy implication (adopted, not modified)

Per the reviewer's own stated default:

```
if baseline full suite is red
and no trusted quarantine/base-failure set exists:
    do not activate selective execution
```

This mission's evidence is consistent with that default remaining correct for deepseek-harness as currently observed: the baseline is not clean under either execution mode, and while a majority of its failures are now well-explained (root permissions) or shown to predate the specific merges tested, a residual, unexplained category (6 stable + a handful of flaky) remains. **No repository-specific quarantine is proposed or built from these five experiments** - consistent with the explicit instruction not to.

## What remains open

- Steps 3-4 of the resolution path (reproducing exact CI UID/environment beyond root-vs-non-root; comparing against real GitHub Actions logs) are not attempted - both need access this mission doesn't have.
- The 6 stable non-root failures' actual cause (process/namespace/signal behavior hypothesis) is not confirmed, only distinguished from the root-permission explanation by elimination.
- Base-SHA controls for the other 4 merges (`#1373`, `#2814`, `#2844`) remain not run, per the explicit instruction to prioritize the non-root experiment first.

## Snapshot expansion status

Still deferred. The non-root experiment materially improves the evidence base (10/16 explained, 6/16 isolated as a distinct unresolved category, 0 net new confirmed misses) but does not clear the bar for declaring absolute CI-outcome preservation solved - awaiting direction on whether to proceed to snapshot work with this now-more-precise caveat, pursue steps 3-4 further, or run the remaining base-SHA controls.
