# DiffCI blind baseline — calcom/cal.diy (formerly calcom/cal.com) (2026-08-24)

Frozen DiffCI build (`gitHead` `8890e1a5`, `engineChecksum` `e0f20b722d880d59...`, verified MATCH before
and after this run). Run on `diffci-analysis-fanout`, `standard-4`, 6 shards / 6 concurrent, all 6
shards reached `done` with zero container-level errors, zero resource kills, zero timeouts - **but no
individual per-merge analysis in this run produced a DiffCI verdict.**

Manifest: `2026-08-23-calcom-blind-baseline-selection-manifest.json` (30 most recent merged PRs on
`main` as of 2026-08-23T00:00:00Z, all 30 verified merged via the GitHub API, `mergeListSha256`
recorded in the manifest; note `calcom/cal.com` now resolves/redirects to `calcom/cal.diy` on GitHub -
both names recorded). Raw rows: `2026-08-23-calcom-blind-baseline-rows.jsonl`.

## Headline

**No blind-baseline verdict was produced for this repository either**, for two DIFFERENT reasons:

| Cause | Merges | Category |
|---|---:|---|
| `createProgram`: "No tsconfig.json found in /workspace/calcom__cal.diy" | 25 | **General engine bug** (same as biomejs/biome - see below, this GENERALIZES) |
| `git checkout` failed: `.git/index.lock: File exists` | 5 | **Execution/environment limitation** (fan-out harness) |
| Real DiffCI verdicts produced | **0** | - |

## Finding 1 (25/30) - same root cause as biomejs/biome: GENERALIZES across repository types

Identical exception to the biome report (`2026-08-24-biome-blind-baseline-report.md`):
```
Error: No tsconfig.json found in /workspace/calcom__cal.diy
    at createProgram (/opt/diffci/src/repo/graph.ts:351:11)
    at buildDependencyGraph (/opt/diffci/src/repo/graph.ts:512:77)
```

This is a materially more important instance of the bug than biome's, because **cal.com is not a
thin-JS-wrapper-on-Rust repository - it is an 18 MB, overwhelmingly TypeScript, actively-developed
monorepo** (Next.js apps + shared packages, Turbo-orchestrated). Confirmed via GitHub code search: cal.com
has at least 10 `tsconfig.json` files, ALL inside `apps/*/tsconfig.json` and `packages/*/tsconfig.json`
- **none at the repository root**:
```
apps/web/tsconfig.json  apps/docs/tsconfig.json  apps/api/v2/tsconfig.json
packages/ui/tsconfig.json  packages/lib/tsconfig.json  packages/trpc/tsconfig.json
packages/types/tsconfig.json  packages/dayjs/tsconfig.json  packages/emails/tsconfig.json
packages/testing/tsconfig.json  ...
```

**This is now a confirmed cross-repository finding, not a repository-specific quirk**: 2 of the 4 blind
holdout repositories (biome, cal.com) - a Rust project with a thin JS layer AND a large mainstream
TypeScript monorepo - both fail 100% on this exact code path. A per-package (no root) `tsconfig.json`
layout is an extremely common real-world monorepo convention (it is, in fact, the layout deepseek-harness
and turborepo do NOT use, which is presumably why they were unaffected). Fixing `createProgram` to
either (a) fail gracefully into `FALLBACK` instead of throwing, and/or (b) search `apps/*/tsconfig.json`
/ `packages/*/tsconfig.json` when no root config exists, would very plausibly unlock a large fraction of
real-world monorepos DiffCI would otherwise be unable to analyze AT ALL. Not fixed here per the blind-
baseline rules; flagged as high-priority for the adapted-replay roadmap.

## Finding 2 (5/30) - git checkout race in the fan-out harness, NOT an engine or DiffCI finding

Five merges (#29857, #29673, #29695, #27634, #29593) failed with:
```
fatal: Unable to create '/workspace/calcom__cal.diy/.git/index.lock': File exists.
Another git process seems to be running in this repository...
```
The frozen `scripts/diffci-blind-baseline.ts` replay driver processes a shard's merges strictly
sequentially (one `git checkout` awaited before the next begins), so this is not a concurrency bug in
the replay driver itself. The most plausible explanation is a stale `.git/index.lock` left behind by an
earlier operation in the same container/workspace path (this run followed a large, failed 40-concurrent
burst attempt against different runIds, though sandbox IDs are runId-scoped and should not have been
reused) - not root-caused further in this pass. **Recorded honestly as `errorClass: "checkout-failure"`,
never converted into a DiffCI verdict**, per the task's validation rules. Flagged as an open fan-out
harness reliability item, separate from the tsconfig finding.

## Test-universe completeness: NOT ASSESSABLE

As with biome, no analysis completed, so cal.com's real test surface (Vitest unit tests, Playwright
E2E, database/service-dependent integration tests, the enterprise-surface tests visible in its many
`e2e-*.yml` / `cron-*.yml` workflows) could not be evaluated this pass despite this repository being
exactly the kind of large, realistic TypeScript monorepo the correctness-complete engine (test-runner
config discovery, fixture ownership) was built to handle well. This is the most consequential gap in
the whole blind-baseline run: the repository best positioned to exercise those Phase-2/3 improvements
never got the chance to.

## Not yet done for this repository

Everything downstream of a working analysis - unit/package/integration/E2E/db-dependent test-family
breakdown, native comparison (cal.com has no Turbo/Nx-equivalent single affected-graph command exposed
at the repo root the way turborepo/nx do), and the full Phase 1 feasibility write-up - is blocked on
Finding 1 above and not attempted.
