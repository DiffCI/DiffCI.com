# Report 10 — full-CI opportunity inventory, limitations, and next steps

## Full-CI opportunity inventory

From `scripts/run-gates.ts`'s real gate graph and `.github/workflows/*.yml` (Report 01), classified per the mission's taxonomy. No deployment or release operation was executed or is proposed for execution.

| Surface | Classification | Notes |
|---|---|---|
| Unit tests (`vitest run`, root config) | **Already modeled** | This mission's subject; validated end-to-end |
| Snapshot tests (`vitest.snapshot.config.ts`) | **Potentially selectively executable** | Keyless, real command exists, DiffCI doesn't select for this family yet - the natural next extension |
| E2E tests (`vitest.e2e.config.ts`) | **Unsupported (this mission)** | Requires `DEEPSEEK_API_KEY_EXTERNAL`, real external API cost - explicitly out of scope, not silently dropped |
| `test:issue-management` (`node .github/issue-management/policy.test.mjs`) | **Candidate for a future task/job adapter** | No Vitest involvement at all - a distinct runner shape |
| Typecheck (`typecheck:contracts-ready`, `tsc -b`) | **Inherently broad** | A single project-reference build graph; file-level selection is not how `tsc -b` works |
| Lint (`oxlint`) | **Potentially selectively executable** | Oxlint supports path arguments; would need its own runtime-selection-invariant validation, not assumed to work like Vitest |
| Duplication (`jscpd`) | **Inherently broad** | Whole-corpus analysis by design |
| Build (`tsx scripts/build.ts`, `tsc -b` + `tsdown`) | **Inherently broad** | Full dependency graph compiled as a unit |
| `publint`, `verify-*` package-invariant scripts (license, path, invariant checks) | **Inherently broad**, mostly fast | Whole-package-set checks; likely cheap enough that selective execution isn't worth the complexity |
| `knip` (unused-export detection) | **Inherently broad** | Whole-graph analysis by construction |
| `module-graph`/`doc-typecheck`/`doc-sync` verification | **Inherently broad** | Cross-file consistency checks |
| Coverage (`test:coverage:partitioned`) | **Unsupported (this mission)**, candidate for future work | The real CI unit-test gate; partitioned multi-process architecture has no simple per-file selective shape (Report 01) - this mission deliberately used the plain, uninstrumented `vitest run` instead |
| Windows/Wine gates (`check:ci:windows-*`) | **Unsafe to skip without separate validation** | Platform-specific test surface (Report 01's own platform-parity finding: some suites are Windows-excluded/included differently) - needs its own investigation, not an extension of this mission's Linux-sandbox results |
| Python SDK suite (`pytest`) | **Unsupported (this mission)**, candidate for a future task/job adapter | Entirely separate ecosystem/toolchain |
| `test:web:ci` (`tsx scripts/run-web-snapshots.ts`) | **Unsupported (this mission)** | Needs built client bundles + Playwright Chromium (Report 01) |
| Release/deployment workflows (`release.yml`, `release-publish.yml`, `python-release.yml`, etc.) | **Unsafe to skip / out of scope entirely** | Never executed, never proposed for execution, per the mission's explicit boundary |

## Bounded follow-up plan: from test-stage to total CI/CD compute savings

1. **Snapshot family**: extend `RepoExecutionProfile` to a per-family command map (a genuine harness generalization, not a deepseek-specific hack); have DiffCI's static engine actually select snapshot tests (currently unit-only); re-run the same canary→batch discipline for that family alone.
2. **E2E family**: blocked on a real `DEEPSEEK_API_KEY_EXTERNAL` credential decision - a cost/access question for the user, not an engineering one.
3. **Lint**: validate oxlint's own path-argument semantics with the same Phase-4 probe discipline (never assume it matches Vitest's).
4. **Coverage-partitioned unit gate**: investigate whether the partition coordinator (`scripts/coverage-partitions.ts`) can accept an explicit file list per partition, or whether coverage and selective execution are fundamentally in tension for this repository's architecture.
5. **Windows/Wine surface**: a separate mission-scale investigation, not an incremental add-on, given the confirmed platform-parity risk.
6. Everything in "inherently broad" stays full-execution by design - selective execution is the wrong tool for whole-graph analyses regardless of future harness investment.

## Remaining limitations, stated plainly

- **Modeled-universe completeness stays `PARTIAL`.** This mission validated one family (unit) of at least three test families, which are themselves a fraction of the total CI surface (table above).
- **No repository-wide safety claim.** 5 merges, however carefully predeclared, is not a claim about every historical or future deepseek-harness merge.
- **`#2844`'s family-scope gap is unresolved, not just documented.** DiffCI proposes a multi-family selection this harness cannot yet execute end-to-end; that gap is real until item 1 above is done.
- **Job-level economics used a narrower definition than Cal.com's** (install+test only; deepseek-harness has no separate `pretest` step) - directly comparable, but worth restating so the two missions' job-level numbers aren't read as measuring identically-scoped things beyond that.
- **No carbon/electricity/water, cost-in-currency, or "superior to another CI product" claim is made anywhere in this mission**, consistent with the mission's explicit claim-discipline rules.
- **Production readiness is not claimed.** This is a validation exercise on historical merges in an isolated sandbox, not a deployed, customer-facing capability.

## Does the result generalize the Cal.com evidence to a second repository?

**Yes, on the dimensions this mission tested**: runtime selection can be honored (4/5, with the 1 exception correctly attributable to a scope limitation, not a false selection), net savings can be positive and substantial (4/4 measurable merges), and mutation recall can be exact and reproducible (3/3 confirmed, 0 misses) on a repository with a materially different package manager, test-runner configuration (real Vitest `projects`), and baseline test-health profile (real pre-existing flakiness, unlike Cal.com) than the first case study. The `--` argument-forwarding lesson generalized in *pattern* (verify empirically per repository) but not in *direction* (pnpm's bare form works, yarn's needed the flag dropped) - exactly the caution the mission asked to preserve.

**What remains unproven**: multi-family selective execution (only unit was end-to-end validated), any claim beyond these 5 merges, and whether this generalizes to a third, architecturally different repository (e.g., a monorepo with no per-package manifests, or a non-JS ecosystem).

## Whether another repository should be tested

**Yes**, per the mission's own item 7 (Nx native-affected comparison) and item 6 (a third case study, e.g. DeepSeek Harness's own snapshot family first, then a genuinely different repository) - both remain open and are the natural next experiments, in that order (cheaper/closer extensions before a new repository).

## Exact next recommended experiment

**Extend `RepoExecutionProfile` to support a family-aware command map** (unit + snapshot at minimum), re-run DiffCI's static selection with snapshot-family awareness enabled, and repeat the canary→batch discipline for the snapshot family alone on 2-3 of the same predeclared merges that had snapshot files in their selection (e.g., `#2844`, `#2776`, `#2725` from Report 02's eligible-but-not-chosen rows) - this directly closes the `IGNORED_OR_BROADENED` gap found in this mission rather than opening a new, unrelated investigation.
