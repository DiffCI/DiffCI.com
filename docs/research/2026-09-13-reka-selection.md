# Reka test discovery and component analysis — 2026-09-13

This experiment repairs Reka's test inventory and Vue macro dependency analysis before attempting a selective-execution claim. It preserves full-suite execution for dependencies the analyzer cannot prove.

## Changes

- Normalize leading `./` in test globs. Reka's pinned Vitest configuration declares `./**/*.test.{ts,js}`; matching against repository-relative paths previously lost the suite. [Pinned configuration](https://raw.githubusercontent.com/unovue/reka-ui/f950796b9a3760cb4db1052687587365cc5e3293/packages/core/vitest.config.ts).
- Register TypeScript with Vue's SFC compiler so imported macro types can resolve aliases and extended compiler configurations. Use a file-only existence check so directory imports resolve their index files instead of attempting to read a directory as source. Refresh compiler configuration state between graph builds.
- Preserve component-specific blocker metadata. In an explicit, verified Vue suite, ignore only blockers in components unreachable from every parsed test, setup and configuration root. Unknown reachable components, unresolved imports, package-boundary violations and global configuration blockers still require full CI.
- Keep compiler-assisted components that probe JSON configuration out of the persistent Vue cache: the compiler can read extended configurations outside the custom filesystem callbacks. Rebuilding these components is conservative until all compiler inputs are tracked. Adapter and graph cache versions invalidate old entries.
- Report exact discovered-versus-executed test inventories, remaining blocker categories and repeated observer costs.

This does not exclude story directories by name. Reka tests import story fixtures, including [the Accordion fixture](https://raw.githubusercontent.com/unovue/reka-ui/f950796b9a3760cb4db1052687587365cc5e3293/packages/core/src/Accordion/Accordion.test.ts). Reachable fixtures retain their dependencies and safeguards.

## Protocol

The final run uses the same eight frozen held-out Reka commits, oldest first. No failing commit is replaced. Each commit has two uncached and two incremental-cache observer measurements, with alternating arm order and an independent cache directory for each repetition. Incremental directories persist across commits; both begin empty. Status, result details, graph counts/confidence and commands must match across all four observations. Every observation must preserve the checkout and report the requested commit range.

Full-suite execution supplies an independent test inventory. If selection is permitted, execute full then selected, followed by selected then full. When the policy is full, reuse the identical full execution for the policy arm; timing noise cannot manufacture test savings. Per-repetition net time is full execution minus policy execution minus that repetition's observer process duration. Failed or unstable baselines remain in the report and are excluded from stable economics. Fault injection uses the frozen pre-mutation selection on cohort indices 0, 3 and 7.

All builds, regression tests and target-repository execution run on Cloudflare. Desktop operations only edit/archive source, orchestrate jobs and aggregate downloaded evidence. Cache results include local cache I/O on the Cloudflare runner, but do not measure transfer to a different job or checkout path.

## Diagnostic probes

Probe v1 discovered exactly the same 62 test files as Vitest. It exposed 43 macro extends failures, 27 directory-read failures and 161 runtime-resolution blockers. Its full regression suite passed 2,158 tests with five skips, and its fault was detected by the full policy.

Probe v2 removed the component-analysis errors and retained 11 runtime-resolution blockers reachable from the suite. The inventory still matched 62/62. The observer took 10,560 ms on this diagnostic commit; resolving previously failed macro types adds real work, so the older cache experiment's timings are not representative of this candidate. Graph construction took 8,796 ms, including 7,050 ms of adapter work and 5,821 ms of Vue script compilation. The graph verified 65 suite roots, reached 667 paths and excluded 150 out-of-suite component blockers.

Probe v2 passed type checking, the focused adapter/scope/economics tests (25 passed, two skipped), cache tests, and the full regression suite (2,160 passed, five skipped). Its injected fault was detected by the full policy. Both diagnostic containers were released after collecting their reports.

The eleven remaining components are CheckboxGroupRoot, CheckboxRoot, ComboboxContentImpl, ListboxVirtualizer, PopoverTrigger, SelectContentImpl, SliderRoot, ToggleGroupItem, ToggleGroupRoot, TooltipContent and TreeVirtualizer. These are effective suite blockers, not merely unused examples found during a repository walk.

Some remaining dynamic components choose between explicit imports, such as [SliderRoot](https://raw.githubusercontent.com/unovue/reka-ui/f950796b9a3760cb4db1052687587365cc5e3293/packages/core/src/Slider/SliderRoot.vue). Others construct components from supplied slot content, such as [TreeVirtualizer](https://raw.githubusercontent.com/unovue/reka-ui/f950796b9a3760cb4db1052687587365cc5e3293/packages/core/src/Tree/TreeVirtualizer.vue). A blanket waiver for dynamic components would exceed the evidence. Modeling finite imported choices and runtime-provided components remains separate work.

## Final evidence

Final Cloudflare run: `reka-selection-20260913-final`; source commit `8772abe`; source object `sources/reka-selection-20260913-final.tgz`; SHA-256 `69461385ef45c11042f78db6eb52aa0b11d4e9cdb8eabc9c02fe4436e3eed095`. Candidate version: `0.1.8-candidate.2`.

The final artifact exactly matches probe v2: `sha512-4iPxo/lJZwBKeKGfTZ01+9A6z+91ijNCUmhKUTOIVAG8PCwUwazMoml3R2l8PPeAfMEALwKOsxR3hofG8yXoXQ==`. The final run changes benchmark repetition/cohort handling only.

**No CI savings were demonstrated.** All eight commits retained full execution. All 32 observations matched decisions across cache modes and repetitions, and every inventory audit matched Vitest's 62 files. Six commits passed both normal full executions; two repeated the pre-existing Tree snapshot failure. All three injected faults were detected under the full policy. These fault results validate the retained full policy, not a selective subset.

Type checking and focused tests passed again. The full regression suite passed 2,160 tests with five skips. The final Cloudflare container and both diagnostic containers were released after collection.

### Observer overhead and net time

Median and nearest-rank p95 below describe 16 fresh-process observations per arm, including the observations on failing baseline commits. These are descriptive measurements, not confidence intervals.

| Arm | Median overhead | p95 overhead | Net, repetition 1 | Net, repetition 2 |
| --- | ---: | ---: | ---: | ---: |
| Uncached | 7.746 s | 8.608 s | −46.944 s | −45.473 s |
| Incremental cache | 9.243 s | 9.885 s | −55.355 s | −56.174 s |

Net totals include only the six stable commits in each repetition. Full execution and policy execution are identical, so gross test savings are exactly zero. Across these 12 executions, uncached analysis adds **92.417 seconds**, while incremental caching adds **111.529 seconds** to 883.905 seconds of full test work—approximately **10.5%** and **12.6%** extra wall time respectively.

Incremental caching is **19.3% slower by median** in this candidate. It records 3,234 hits and 6,334 misses across 9,568 lookups, with no write failures. The conservative JSON-input guard prevents reuse of compiler-assisted components; the cache still incurs probe/fingerprint work for those misses. On the last commit, 366 of 598 components are rebuilt even with the previous-commit cache. Median Vue script compilation is 4.683 seconds uncached and 6.117 seconds in the cache arm. The cache result is a regression, not a repeat of the earlier candidate's warm-cache gain.

| Commit | Baseline result | Cached net, repetition 1 / 2 |
| --- | --- | ---: |
| `f950796b` | Both pass; fault detected | −9.610 / −8.748 s |
| `b9125cfd` | Both pass | −9.239 / −9.615 s |
| `e0343918` | Both pass | −9.494 / −9.314 s |
| `97fd052a` | Both pass; fault detected | −9.885 / −9.615 s |
| `7567e33b` | Both pass | −8.950 / −9.636 s |
| `1593f678` | Tree snapshot failure; excluded from stable totals | — |
| `764f0781` | Tree snapshot failure; excluded from stable totals | — |
| `c06c994d` | Both pass; fault detected | −8.177 / −9.246 s |

The failing test in both excluded commits is `packages/core/src/Tree/Tree.test.ts::given default Tree should render snapshot`. In addition to the 11 runtime blockers, commit `764f0781` retains the package-boundary fallback and `c06c994d` retains the unknown changed snapshot-file fallback.

The correctness repairs are useful, but this candidate fails the positive-net-savings gate in both repetitions and is **not promoted**. Further work must model runtime component dependencies safely and track all compiler inputs before restoring cache reuse. Reducing overhead alone still cannot save time on a full-execution policy.

### Evidence locations

- [All 32 observer rows](2026-09-13-reka-selection-observations.csv), including failed baselines.
- Raw local evidence: `.diffci/reka-selection-20260913/{probe-v1,probe-v2,final}/` in the original workspace, including reports, logs, execution receipts and container-release confirmations.
- Durable Cloudflare R2 evidence: bucket `diffci-validation-env`, keys `validation/reka-selection-20260913-final/language-qualification.json`, `language-qualification.log`, and `execution-receipt.json` under the same prefix; equivalent prefixes exist for both probes.
- Final report SHA-256: `7fb4a211cf532cef0832fbe577c900a261699545d79965f7ea778da471d9d096`.
