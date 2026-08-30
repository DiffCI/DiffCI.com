# External validation target #3: `chalk/chalk` — `NOT_ADDRESSABLE` (unsupported runner)

**Outcome: `NOT_ADDRESSABLE`**, failing the mechanical check at step 3. **No container job was run.**
No clone was qualified, no observation, no prediction, no economics.

## The mechanical check, in the order it was frozen

`chalk/chalk@661317e6f91fe7c90306c2c48ea9354562ee9146`, chalk 6.0.0.

| # | Criterion | Result |
|---|---|---|
| 1 | Single package | ✔ no `workspaces`, one `package.json`, `files: ["source"]` |
| 2 | Root runner | ✔ the documented `test` script runs from the repository root |
| 3 | **Supported runner** | **✘ AVA** |
| 4 | Explicit-file addressability | not reached |
| 5 | Canonical green qualification | not reached |

```json
"test": "xo && c8 ava && tsc --noEmit --types node source/index.d.ts"
```

The selector's concern about `sindresorhus/p-map` — that it might use AVA and be immediately
unsupported — turned out to apply to chalk. It was raised as a reason to *avoid* a target and was
explicitly not treated as knowledge about this one; chalk was chosen for structural fit and its runner
was discovered by inspection, in order, after the selection was committed at `36d5dac`.

## Step 3, measured rather than assumed

AVA was run against a synthetic three-test, two-file project — characterising the *tool*, not chalk —
and its real output fed through the harness's actual parsers:

```
SUPPORTED_RUNNERS: node:test, vitest, jest, mocha

AVA passing  failures = undefined  framework = undefined  fileCount = undefined
AVA failing  failures = undefined  framework = undefined  fileCount = undefined
```

AVA's summary is `3 tests passed` / `1 test failed`. No adapter matches it: mocha's looks for
`N passing`, and node:test's for `# fail N`. So **every run would be `INVALID_RUN`**, and calibration
would separately return `NO_ASSESSMENT` for want of a test-file count.

Two limits, both real, and they are not the same limit — `parseTestOutput` reads four runners,
`parseTestFileCount` reads two.

## The apparatus fails safe here, which is worth recording

`classifyExecution(exitStatus, undefined)` returns `UNREADABLE` before it examines the exit status at
all. So chalk could not have produced a false green: qualification would refuse rather than mis-pass.

AVA's own exit codes are correct — verified directly, 1 with a failing test and 0 with none. The
failure is purely that this harness cannot read AVA's summary, not that AVA is ambiguous about success.

Contrast with defect #5, where `tanstack-qualify-02` produced a false green by ignoring exit status.
That path is closed, and this target exercised the closure.

## What was deliberately not done

**No AVA adapter was written.** It would be perhaps twenty lines, and writing it now — with chalk named,
after two refusals — is adding support to admit a target. That was ruled out in advance, in the
selection record and by explicit instruction. If AVA support is worth having, it is worth having chosen
on its own merits, with no target waiting on it.

No command was substituted. `c8 ava` was not replaced, the `xo` and `tsc` stages were not stripped, and
no alternative runner was introduced.

**chalk closes with zero information about its sign**, exactly as date-fns did.

## Three targets, three refusals, three distinct causes

| # | Repository | Outcome | Cause |
|---|---|---|---|
| 1 | `fastify/fastify` | `NOT_QUALIFIED` | suite not green in the canonical environment |
| 2 | `date-fns/date-fns` | `NOT_ADDRESSABLE` | monorepo; real test surface only reachable from a subdirectory |
| 3 | `chalk/chalk` | `NOT_ADDRESSABLE` | runner unsupported — AVA output unreadable by every adapter |

**The eligibility rule has still not run once out of sample.** None of these three is a failure of the
predictor, and none is evidence about its accuracy.

## The finding that is now the important one

Three repositories selected before inspection, three stopped before the predictor. That is no longer a
run of bad luck; it is a measurement.

> **The assessment's addressable surface, not its prediction accuracy, is the binding constraint.**

A predictor that is rarely reached cannot be sold on being right. The commercially significant question
has moved from *"is the rule accurate out of sample?"* to *"on what fraction of real repositories can
the assessment run at all?"* — and the current answer, on a sample of three, is zero.

Three is a small sample and the selection was not random, so this is a signal, not a rate. But the
direction is consistent and each cause is different, which is worse than one repeated cause: it suggests
breadth of limitation rather than a single fixable gap.

### What would widen it, in the order the evidence suggests

Recorded as observation, **not started, and not to be started against a named target**:

1. **More runner adapters**, failure count and file count both. AVA is the second runner in three targets
   the harness could not read; borp was the first.
2. **Per-package execution scope** for monorepos, with DiffCI's universe scoped to match.
3. **Nothing about the predictor.** It remains untested out of sample, and no evidence here bears on it.

## Status

`chalk/chalk` — **`NOT_ADDRESSABLE` (unsupported runner)**. Permanent. Target #4 is the user's to name.
