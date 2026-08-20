# Stage 1A — Phase 9: theoretical improvement headroom

Per the task's explicit instruction: **addressable workload unlocked is reported separately from
predicted reduction, and predicted reduction is never fabricated from other repositories' observed
rates.** A fix's *reach* (how many currently-inert deltas it would make eligible for real analysis) is
factual and countable from Stage 0 data; how well DiffCI would actually perform on that newly-eligible
workload is genuinely unknown until it is re-measured, not assumed.

## If the 7 UNSAFE repositories' specific root causes (Phase 3) were resolved

**Addressable workload unlocked (factual, counted)**: 700 of 2,000 total Stage 0 deltas (7 repos × 100
commits, 35% of the corpus) are currently 100% fallback and would become eligible for real graph-driven
selective analysis. Of the corpus's `DISCRIMINATIVE_OPPORTUNITY`-eligible pool (1,899 test-count-valid
deltas, excluding `ky`), these 700 currently contribute **zero** opportunities and zero PATH-selected
tests get addressed by DiffCI's real logic on them at all - they run under the same "select everything"
policy DiffCI's fallback path always uses.

**Predicted reduction: NOT estimated.** It would be fabrication to assume these 700 deltas would show
the same ~30% opportunity frequency or ~95% median conditional reduction the other 13 repositories show
- these 7 repositories are structurally different in ways Phase 3 documented in detail (multi-package
monorepos, heavier build tooling, ORM/framework codebases), and their *actual* selectivity potential is
unknown until they can be analyzed for real. This is exactly the kind of extrapolation the task
explicitly prohibits.

## Ranked by estimated leverage (addressable reach ÷ engineering complexity)

1. **Confidence-policy reachability refinement** (Phase 3's cross-cutting finding: an unresolved import
   confined to a build script/generated-file/isolated test fixture unrelated to a delta's actual changed
   files currently disqualifies the ENTIRE repository graph). **Reach**: potentially all 4 repositories
   whose UNSAFE cause was confined to a tiny, isolated corner of an otherwise huge, well-resolved graph
   (`date-fns` 1/4,554 edges, `mikro-orm` 2/5,629, `typeorm` 2/11,619, `unocss` 6/1,053 - 400 deltas) -
   **with one policy change**, not four separate fixes. **Complexity**: medium-high (requires computing
   per-delta reachability from the changed files to the unresolved-import location - a bounded graph-
   traversal problem, not a new capability, but a real piece of engineering). **Highest leverage per
   unit of effort found in this investigation** - one change, four repositories, no safety weakening for
   the paths that matter (an unresolved import that IS reachable from the changed files would still
   correctly trigger UNSAFE).

2. **tsconfig-file-scope fallback** (Phase 3: `execa`'s tsconfig scopes the compiler Program to
   `"files": ["index.d.ts"]` only, so real `.js` source is never loaded into the graph at all - fall back
   to the independently-discovered source roots when the repo's own tsconfig doesn't cover them).
   **Reach**: 100 deltas confirmed (`execa`), but this is very plausibly an ecosystem-wide pattern (ESM-
   first packages shipping hand-written `.d.ts` validated via a narrow tsconfig) rather than an execa-
   specific quirk - real reach beyond this corpus is unknown but plausibly meaningful. **Complexity**:
   medium (a targeted fallback path in graph construction, not a new capability).

3. **Nested-tsconfig honoring** (Phase 3: `trpc`'s 67 unresolved `~/`-aliased imports, almost all from
   `examples/*` subdirectories each with their own local tsconfig/alias config not respected by the
   root-scoped resolver). **Reach**: 100 deltas confirmed (`trpc`), the single highest unresolved-import
   volume found (67 of ~85 total across all 7 repositories), but also the most architecturally invasive
   fix (supporting per-subdirectory tsconfig resolution is a genuine, non-trivial graph-construction
   capability, not a policy tweak) - and it remains an open, unconfirmed question whether `trpc`'s real
   test suite depends on `examples/*` code paths at all (if it doesn't, fixing this may have little
   practical effect on trpc's own selectivity even though it resolves the import cleanly).

4. **`package.json` field-level diffing** (Phase 8: 412 fallback instances triggered by any root
   `package.json` change, including metadata-only fields with zero behavioral effect). **Reach**: spans
   the whole corpus, not confined to the 7 UNSAFE repos - potentially the highest total delta-count
   reach of anything in this list, though each individual delta's marginal benefit (avoiding one
   unnecessary fallback) is smaller than unlocking a whole UNSAFE repository. **Complexity**: low-medium
   (parse and diff two JSON snapshots, well-scoped).

5. **Base-graph deleted-source handling** (Phase 8: 202 fallback instances from deleted files whose
   reverse-dependents cannot be determined from a HEAD-only graph). **Reach**: spans the whole corpus.
   **Complexity**: medium, with a real, non-trivial **cost tradeoff** - correctly solving this requires
   building a graph at `baseSha` in addition to `headSha`, roughly doubling per-delta graph-construction
   time. Worth pursuing only if that cost is acceptable relative to the benefit at production scale.

## What this ranking does NOT claim

This ranking is by *addressable reach and engineering tractability*, not by predicted benchmark-score
improvement - per the task's explicit instruction, no such prediction is made. Item 1 (confidence-policy
reachability) is flagged as highest-leverage because it unlocks the most currently-inert deltas for the
least architecturally invasive change, not because its eventual selectivity rate is assumed to match the
corpus average.
