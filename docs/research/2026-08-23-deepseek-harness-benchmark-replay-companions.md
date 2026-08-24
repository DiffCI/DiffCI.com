# DiffCI x deepseek-harness — replay under the translated-doc-companion rule (2026-08-23)

Follow-up to `2026-08-23-deepseek-harness-benchmark.md` (baseline). Same 30 PR-merge SHAs (list
md5-verified identical), same engine, same graph build; the ONLY difference is the new classification
rule below. Raw per-merge output: `2026-08-23-deepseek-harness-benchmark-replay-companions.jsonl`
(baseline raw output untouched in `...-benchmark-results.jsonl`).

**Still static.** No full or selected test suite was executed. Actual CI-time savings and
false-negative (missed-failure) safety remain UNMEASURED.

## Headline

Under the updated conservative policy, DiffCI authorized selective execution on **10 of 30**
historical merges, compared with **2 of 30** under the baseline. Engine-inferred affected-test sets
were identical on all 30 merges (the rule reclassifies one file kind; it never touches traversal).
No merge flipped SAFE -> FALLBACK.

| | Baseline | Replay |
|---|---|---|
| SAFE_TO_PROPOSE | 2 | 10 |
| FALLBACK | 28 | 20 |
| Merges with "Unknown changed file" | 26 | 6 |
| Unknown-file instances (files) | 943 | 168 |
| Config / Lockfile / Workflow / Manifest / Graph-UNSAFE triggers | 12 / 5 / 5 / 1 / 8 | 12 / 5 / 5 / 1 / 8 (unchanged) |
| Analysis wall median (graph build dominated) | 37 s | 25 s (warm disk cache; not a code change) |
| Impact step median | 46 ms | 39 ms |

Newly authorized (engine-selected / total tests): #2847 2/865 · #2862 0/864 · #2844 173/864 ·
#2808 4/864 · #2708 14/864 · #2725 206/857 · #2776 142/857 · #2730 309/857. Already authorized:
#2760 0/865 · #1373 6/864. Across the 10 authorized merges the engine selected 856 of 8,621 test-file
slots (median 1.6% per merge) — but note #2730/#2725 select 24-36%: "authorized" is not "large reduction".

Hypothesis check: the baseline predicted ~10/30 if `*.i18n.yaml` were reclassified. Observed: 10/30.
This was not targeted — the rule was fixed before the replay and no policy was weakened to reach it.

## The rule (src/repo/impact.ts `isTranslatedDocumentationCompanion`)

Evidence from the repo (HEAD b150a551): 1,146 `*.i18n.yaml`; 100% have a sibling `<stem>.md`; content
is a bilingual-pair consistency record (blob hashes of `<stem>.md` / `<stem>.zh.md`), not a
translation. Consumers: lefthook hook, `scripts/verify-translation-pairing.ts` via `run-gates`
(not vitest), a git merge driver; spec tests use string/temp-git fixtures. No `packages/`/`apps/`
runtime code reads them. => a change cannot alter any vitest outcome.

Rule (relationship-based, repo-agnostic, conservative):
1. basename matches `<stem>.<tag>.yaml|yml` with tag in {i18n, l10n, translation, translations} —
   locale codes (`guide.en.yaml`) are deliberately NOT accepted (plausible runtime content);
2. `<stem>.md` or `<stem>.mdx` exists beside it at HEAD (caller passes `repositoryFiles`);
3. config/infra/database classification runs first (`.github/README.i18n.yaml` stays config).
Without `repositoryFiles` the rule is inert -> all existing callers (Stage 2F shadow, Preflight,
CLI) behave byte-identically. Only `scripts/diffci-benchmark-external.ts` passes it today.
Deleting a doc together with its record keeps the record "unknown" (companion gone at HEAD) —
observed twice in the replay (#2676, #2903), as intended.

Tests: tests/repo/impact.test.ts, 8 new cases (accepted companion; other tags/.mdx/root; inert
without file list; missing/wrong-dir companion; ordinary YAML config; locale-code tag; config/infra
precedence; mixed delta with lockfile and with snapshot .jsonl). `npm run check`: typecheck clean,
881/881 pass.

## What still blocks (replay)

- Root config / lockfile / workflow / manifest: 12 merges — legitimate, unchanged.
- Graph confidence UNSAFE only: #2814 #2749 #2820 #2794 #2796 (5 merges) — now the leading
  non-config blocker; next policy frontier is graph resolution, not file classification.
- Unknown only: #2702 (157 snapshot .jsonl) #2726 (.cordis.yml) #1798 (.py/.sh) — see below.

## Snapshot `*.jsonl` — investigation only (NOT implemented, NOT docs)

277 at HEAD. Paths: `examples/acp-agent/tests/snapshots/<case>/*.jsonl` (188),
`examples/headless-agent/tests/{snapshots,*-snapshots}/` (30), `apps/web/tests/snapshots/` (20),
`packages/test-support/acp-snapshot/tests/fixtures/` (21), `examples/jsonrpc-agent/tests/snapshots/` (9),
`scripts/snapshots/` (3). Owner: the sibling `<pkg>/tests/<suite>.snapshot.ts`, which builds the dir
at runtime (`join(dirname(fileURLToPath(import.meta.url)), 'snapshots')`) — a filesystem read, not an
import, so the dependency graph cannot represent it. Two further caveats: (a) these suites run under
`vitest.snapshot.config.ts` (`pnpm test:snapshot`), a separate CI job from `vitest run`; (b) DiffCI's
test detection (`.test.`/`.spec.`) does not recognise `*.snapshot.ts` (22 files) or `*.e2e.ts` (136)
at all, so it currently models 752 `*.spec.ts` + a few `.test.` files of a larger real test universe.
Smallest safe future implementation: "test-fixture ownership" — a non-source file whose nearest
ancestor directory named `tests|test|__tests__` contains >=1 graph-known test file maps to ALL test
files in that directory (conservative over-selection), else stays unknown; gated on the caller's
`repositoryFiles`, covered by tests, and only after `*.snapshot.ts` is recognised as a test kind.
Not speculative ownership by filename.

## Unresolved risks

- No execution: selection correctness on these 10 merges is unvalidated against real CI outcomes.
- Test-universe gap above (snapshot/e2e suites unmodelled) means "0 affected of 865" can be true for
  `vitest run` yet a snapshot/e2e job could still be relevant.
- `repositoryFiles` is HEAD-only; a companion present at HEAD but added in the same PR as the record
  is accepted (correct — both are docs), but the rule trusts the HEAD tree, not the delta.
