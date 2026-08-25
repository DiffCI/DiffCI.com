# Report 03 — deterministic mutation policy for the predeclared corpus

Per the mission's rule: for each merge, consider changed paths categorized as `source` (DiffCI's own `changedFileCategories` classification, already used throughout this mission — `docs`, `asset`, `config`, `test`, `snapshot`, `generated`, `manifest`, `lockfile` are distinct categories and are excluded by construction, not just by name-pattern), sort candidates lexicographically by repo-relative path, select the first that exists in both base and merge, replace the merge version with the exact base version. Chosen **before** any execution result is observed - the same commit that predeclares the corpus (Report 02) established which merges have zero eligible candidates (#2760).

## Mutation targets

| PR | Candidate `source` files (lexicographic order) | Chosen target | Base blob | Merge blob |
|---:|---|---|---|---|
| #2760 | *(none — only file changed is `test` category)* | **N/A — mutation unavailable**, declared in Report 02 §3 | — | — |
| #2808 | `packages/host/frontend-static/src/index.ts` (only candidate) | `packages/host/frontend-static/src/index.ts` | `ad516f1c79ca0e24d10e4cd6fcd1409da4805295` | `1afd319906e87632d2e784ea444776226480f8bc` |
| #1373 | `packages/typert/generator/src/cordis-catalog.ts` (only candidate — the diff's other file, `.../tests/cordis-catalog.spec.ts`, is `test` category) | `packages/typert/generator/src/cordis-catalog.ts` | `14a80f29eac9cd038725d6fb6308768fde6b202f` | `8ce666b96c67cfc41fe8350e32d92463e6328ca9` |
| #2814 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` (only candidate — `apps/web/tests/reference-composer.e2e.ts` is `test`, `apps/web/tests/snapshots/.../caret-edits.expected.md` is `snapshot`, `.../input-bar.client.spec.tsx` is `test`) | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` | `2d96e3bf3335080bb37b0d780f523af163c98639` | `4e5d52617641f79babc4660b81034e06f10a63bc` |
| #2844 | `apps/web/tests/scaffold.ts`, `packages/client/runtime/src/client/sessions/conversation.ts`, `packages/client/ui-conversation/src/client/conversation-nodes/turn-error.ts` (3 candidates — DiffCI's classifier reports `source:3` for this merge; `apps/web/tests/scaffold.ts` sits inside a `tests/` directory but is a shared test *scaffold/helper*, not itself a test file matched by any include glob (`*.spec.ts`/`*.e2e.ts`/`*.snapshot.ts`), so DiffCI's own category classifier — the same classifier this entire mission's `SAFE_TO_PROPOSE`/`affectedTests` numbers are built on — correctly places it in `source`, not `test`. Deferred to consistently, not special-cased) | **`apps/web/tests/scaffold.ts`** (`a` sorts before `p`) | `ac3a0292ec212c6f4a50e75da08faca68f07de40` | `83334e13d30714e2effa48d75d70c12711251968` |

## Why each target satisfies the rule

- **#2808**: PR fixes a 404 on static asset paths ("frontend-static-miss-404"). The sole source file is exactly the fix's own implementation — expected to produce an observable behavior difference (the merge's own selected tests target this package: `frontend-static.spec.ts` + 3 `web-app`/`browser-open`/`trusted-hosts` specs).
- **#1373**: PR removes line numbers from a generated catalog ("remove-cordis-catalog-line-numbers"). The sole source file (`cordis-catalog.ts`, the generator itself, not its output) is the direct implementation — expected to be observable via `cordis-catalog.spec.ts`, which DiffCI selected.
- **#2814**: PR fixes composer edit-range attribution from a text selection. `InputBar.tsx` is the component directly implicated by the PR subject — expected to be observable via the selected `input-bar.client.spec.tsx` (a unit spec; the e2e and snapshot files in this diff are out of this round's executable scope per Report 01).
- **#2844**: PR fixes a turn-error surviving same-turn retry exhaustion. The chosen target (`scaffold.ts`) is a shared test-infrastructure file, not the two directly-named fix files (`conversation.ts`, `turn-error.ts`) — **this is a case where the deterministic rule's lexicographic tiebreak does not pick the "obviously right" file**, which is exactly why the rule is deterministic and declared in advance rather than hand-picked: a favorable-looking mutation was available (`turn-error.ts`, matching the PR subject almost exactly) and the rule did not choose it. This is stated plainly, not smoothed over. If the resulting mutation turns out unmeasurable, that is an honest `recallMeasurable: false`, not a reason to substitute `turn-error.ts` after the fact.

## Discipline notes

- No mutation was changed after seeing any execution outcome — none had been run yet when this report was written (see Report 02, committed first; this report follows the same commit that already declared #2760 unavailable).
- No merge was swapped for a better-looking mutation target.
- #2844's lexicographic pick landing on the less-obviously-relevant file is preserved as evidence that the rule is genuinely mechanical, not a rationalized hand-pick.

## Next

Live execution: canary run on #2808 (Phase 6/7) — full baseline, selected baseline, mutant full, mutant selected, using this mutation target — gated on the argument-forwarding probe (Report 04, in progress) confirming file-filter enforcement first.
