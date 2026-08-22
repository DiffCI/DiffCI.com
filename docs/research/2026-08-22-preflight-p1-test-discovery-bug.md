# Real bug found and fixed: `npm test`'s glob never actually recursed (Preflight P1)

**Found**: 2026-08-22, while adding the first two-levels-deep test file this project has had
(`tests/preflight/cloudflare/d1-prediction-store.test.ts`) and noticing the reported test count didn't
move as much as expected.

**Root cause**: `package.json`'s `"test"` script was `tsx --test tests/**/*.test.ts` - an **unquoted**
glob. `npm run <script>` executes the command string through a shell (bash, on both this session's local
environment and the real GitHub Actions self-hosted runner - confirmed identical: `shell: /usr/bin/bash
-e {0}` in real CI logs). Non-interactive bash does not enable the `globstar` shell option by default, so
a bare `**` in an unquoted glob does **not** cross directory boundaries - it behaves like a single `*`
for that path segment. The shell pre-expanded the pattern into a flat, incomplete file list **before
tsx ever saw it**, silently dropping every test file more than one directory level below `tests/`.

**Real, measured impact**: 15 real test files, two or more directories deep, were never included in any
`npm run test` invocation - not this session's, and (since these files predate this session, e.g.
`tests/research/cloudflare/shadow-store.test.ts`) very likely never, in this project's history:

```
tests/preflight/cloudflare/d1-prediction-store.test.ts
tests/research/baseline/matcher.test.ts
tests/research/baseline/test-activity.test.ts
tests/research/baseline/workflow-parser.test.ts
tests/research/benchmark/opportunity-analysis.test.ts
tests/research/cloudflare/orchestrator-plan.test.ts
tests/research/cloudflare/resumable-batch.test.ts
tests/research/cloudflare/retry.test.ts
tests/research/cloudflare/session-id.test.ts
tests/research/cloudflare/shadow-cron.test.ts
tests/research/cloudflare/shadow-source-integrity.test.ts
tests/research/cloudflare/shadow-store.test.ts
tests/research/cloudflare/shadow-webhook.test.ts
tests/research/historical/flakiness-check.test.ts
tests/research/repository/collector.test.ts
```

Real test count before the fix: **579** (matching every real CI run's own reported count throughout
this session, confirmed against actual `gh run view --log` output, not just local reproduction). Real
test count after the fix: **734** - a 155-test, 15-suite gap that real CI's own green checkmark never
reflected.

**Fix**: quote the glob (`tsx --test "tests/**/*.test.ts"`), so the shell passes the literal pattern
string through to tsx/Node's own `--test` argument parser, which DOES implement real recursive glob
matching internally (verified directly: `npx tsx --test "tests/**/*.test.ts"` finds all 90 files; the
identical unquoted invocation finds only 75).

**Good news, verified**: every one of the 15 previously-unrun files was already genuinely passing - `npm
run check` after the fix reports **734/734 passing, 0 failures**, both locally and confirmed against
real GitHub Actions CI. This was a real coverage/trustworthiness gap, not a hidden regression - no test
had to be fixed, only discovered.

**Why this belongs in Preflight P1**: this is exactly the category of problem P1 exists to catch - "real
CI is not actually verifying what it appears to verify" - just a different failure shape (silent
under-collection, not a runtime mismatch) than the node:sqlite incident this Phase was originally built
to address. It reinforces the same lesson from a different angle: a green checkmark is only as
trustworthy as the thing generating it, and that is worth checking directly, not assumed.
