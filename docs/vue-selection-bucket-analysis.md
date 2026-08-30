# vuejs/core: are the repeated selection sizes the same files?

**Raw result, frozen before asking why.** Artifact: `docs/evidence/vue-selection-buckets.json`,
sha256 `dc5042a11c715f496eaff00646fd16bb06a474d50c86f5f7f57a70c941c29280`.

This interrogates the frozen selector's **output**. It does not inspect selector internals, and nothing
about selection behaviour was changed. Diagnosis, not optimisation.

## Fidelity check first

The analysis ran locally, so it is only meaningful if it reproduces the container run it explains. All
sixteen candidates match the frozen `vue-observe-01` / `vue-economics-01` counts exactly — DiffCI's
selection **and** the comparator's, candidate for candidate:

```
b8543dcf0 162/20   38577161c 162/20   31da934fc  57/16   f8d42e1cf  97/44
cd1974562  98/57   8654f3511  97/44   ef82a2677 183/10   6eaecc14d  57/16
b535917d4  97/44   a72036f66  97/44   6e1814aa3  97/44   a2b40db9a 183/23
4e467d7ae 183/95   22b53eafe  57/16   02421cdbc 162/38   246846479  57/60
```

Agent B, `vuejs/core@d63616ca`, 25 commits observed, 16 SELECTIVE candidates.

## The result

```
 size   n  uniqSets  inter  union  int/size   jaccard min/med/max
   57   4         1     57     57     1.000    1.000 / 1.000 / 1.000
   97   5         1     97     97     1.000    1.000 / 1.000 / 1.000
   98   1         1     98     98     1.000    (single member)
  162   3         1    162    162     1.000    1.000 / 1.000 / 1.000
  183   3         1    183    183     1.000    1.000 / 1.000 / 1.000
```

**Every bucket contains exactly one unique selection set. Pairwise Jaccard is 1.000 everywhere.**

Five different commits produce **byte-identical** 97-file selections. Four different commits produce
byte-identical 57-file selections. There is no fringe: `filesVarying` is 0 in every bucket.

## This is the fixed-region outcome, not stable-core-plus-fringe

The pre-registration named three possible outcomes. The third — a stable core with a small
commit-specific fringe — would have explained the buckets while leaving the selector genuinely
responsive. It is ruled out: within a bucket the sets are identical, not merely similar.

Two further facts about the structure:

- **The 57-file set is selected on every one of the sixteen candidates.** The intersection across all
  candidates is exactly 57, equal to the smallest bucket — so there is an unconditional core, and the
  larger buckets are supersets of it.
- **Union across all candidates is 184 of 196 files.** Only 12 files in the universe were never selected
  by any commit.

So sixteen commits across a 196-file repository produced **five distinct selections**, all containing a
common 57-file core, together touching 184 of 196 files.

## What this does and does not establish

**Establishes:** the repeated cardinalities are repeated *regions*, not coincidence. The "coarse bucket"
reading is now supported by set identity rather than inferred from equal counts.

**Does not establish:** *why* those regions are pulled. Dependency closure, a package or configuration
boundary, an unresolved-import fallback, a graph component, or something else — this analysis cannot
distinguish them, and deliberately did not look.

It also does not establish that the selections are *wrong*. If Vue's dependency structure genuinely
requires 183 files when `packages/runtime-core` changes, then DiffCI is correct and Vue is simply a
repository where it is not economically useful. The economics already say that plainly: −1163.33 CPU-s
incremental, 0 of 16 candidates positive, three costing more than the entire suite.

## Stopping here

Next question, not yet asked: **what pulls each region, and does every selected file have an auditable
dependency or impact reason for being included?**

That requires tracing the graph for one representative candidate per bucket, and it is deferred until
this raw result is reviewed. Repository #4, carbon conversion and selector changes all remain deferred.
