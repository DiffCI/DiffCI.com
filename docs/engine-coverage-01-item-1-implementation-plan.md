# FROZEN — ENGINE_COVERAGE_01 item 1: implementation plan for time-boxed dependency resolution

Scoped from `docs/engine-coverage-01-dependency-pinning-investigation.md` (commit `39412bf`). **This is a
plan. No engine code changes yet.** Traces exactly where each change lands, states the exact predicted
behavior change for the two regression fixtures before touching anything, and fixes the evaluation
boundary that follows implementation.

## The one sentence this whole plan protects

> Passing the new gate means **"DiffCI has a defensible historical dependency-resolution basis sufficient
> to attempt this operation."** It does not mean **"DiffCI has reconstructed exactly the dependency graph
> CI originally installed."**

Every design choice below exists to keep that distinction real in code, not just in prose — a separate,
weaker-labeled requirement, never a silent path into `DEPENDENCY_BASIS_PINNED` as currently defined.

## 1. A distinct concept, not a relaxed one

**New requirement id**: `DEPENDENCY_BASIS_TIME_BOXED`, added to `REQUIREMENT_PREDICATES` in
`src/ci-inference/reference-graph.ts` alongside — never replacing — the existing
`DEPENDENCY_BASIS_PINNED`:

```ts
DEPENDENCY_BASIS_PINNED: {
  label: "a pinned dependency basis (lockfile or packageManager field)",
  predicate: "the repository commits a lockfile or declares a packageManager field",
},
DEPENDENCY_BASIS_TIME_BOXED: {
  label: "a defensible time-boxed dependency basis (no committed lock, resolution bounded to the " +
         "repository's own historical CI run)",
  predicate: "an independently-sourced historical cutoff exists and the install path can be bounded to it",
},
```

`COMPLETENESS_REQUIREMENTS.install` becomes an **either/or**, not an added-on requirement:
`pinnedDependencyBasis()` (unchanged) is tried first; only when it returns `pinned: false` does a second,
new check — `timeBoxedDependencyBasis()` — get consulted. If *neither* is satisfied, behavior is
byte-identical to today. `computeCompleteness` (or its caller) needs a small, explicit "either A or B for
this one requirement family" shape, not a boolean OR baked silently into one field — the two checks stay
distinguishable in every receipt (`requirementChecks` must show which of the two, if either, held, per
DEFECT 30's own standard: a receipt asserting something never actually checked is the defect this project
has already paid to learn about once).

`resolve.ts` gains:

```ts
export function timeBoxedDependencyBasis(
  facts: ObservedFact[],
  cutoff: string | undefined,      // ISO-8601, or undefined if none was supplied
): { established: boolean; cutoff?: string; evidence?: EvidenceRef; detail: string } {
  if (!cutoff) return { established: false, detail: "no independently-sourced historical cutoff supplied" };
  if (Number.isNaN(Date.parse(cutoff))) return { established: false, detail: `cutoff "${cutoff}" is not a valid ISO-8601 timestamp` };
  // package manager gate — see §3
  ...
  return { established: true, cutoff, detail: `install bounded to versions published on or before ${cutoff}` };
}
```

Note what this function does **not** do: it never inspects whether an install *would* succeed. It only
answers "is there a defensible cutoff to bound resolution to." Whether the bounded install then actually
succeeds is §5's concern, at execution time, in the container — exactly where `DEPENDENCY_BASIS_PINNED`'s
own guarantee already stops short of promising a clean install (a genuine lockfile can still fail to
install for unrelated reasons; this basis has the same shape of promise, narrower).

## 2. Where the cutoff comes from — never "now," never "whatever resolves"

**Source: the reference plan's own `ciGroundTruth`, extended with one new structured field.** Every
existing reference plan already cites a specific job (`ciGroundTruth.source`, e.g. `"github actions job
99789022791, ..."`) as the source of the pinned commit's real CI conclusion. That job's own `started_at`
is exactly the cutoff this basis needs, and it comes from the **same evidence-gathering pass** that
already produced `source` — not new investigative work, one more fact recorded from a citation already
being made.

Schema addition to `diffci.ci.reference-plan/v2`'s `ciGroundTruth`:

```json
"ciGroundTruth": {
  "cell": "...",
  "conclusion": "success",
  "source": "github actions job 99789022791, ...",
  "jobStartedAt": "2026-09-01T08:25:03Z"
}
```

Hand-transcribed by whoever authors the plan, from the same GitHub Actions job page `source` already
cites — **not fetched live by the engine, not derived from the pinned commit's push time, and never
defaulted to the current execution date.** This keeps the reference plan's independence intact: the
cutoff is a historical fact about a specific, already-cited CI run, recorded once, frozen with everything
else in the plan, never touched again.

`ci-reproduction.ts`'s `main()` reads `referencePlan.ciGroundTruth?.jobStartedAt` and threads it through
to wherever the inference arm's completeness gets computed (see §5) — **only when present**. A reference
plan authored before this schema addition (i.e., every existing plan today) simply has no cutoff
available, and the new basis is unavailable for it — exactly the same refusal as today, not a silent
default.

**Explicitly rejected as a cutoff source:** the pinned commit's own push/author timestamp. A commit can be
pushed long before its CI actually ran (queued runners, re-runs, manual dispatch) — the *job's own*
`started_at` is what actually bounds which package versions existed at the moment resolution happened,
which is the only thing this basis is trying to reconstruct.

## 3. npm only, this phase — no inferred equivalence for other managers

`timeBoxedDependencyBasis()` must check the *same* facts `pinnedDependencyBasis()` already inspects
(`package.packageManager`, presence/absence of `yarn.lock`/`pnpm-lock.yaml`) and **refuse to establish a
time-boxed basis whenever the operation's actual package manager is not npm** — including the case where
no `packageManager` field exists but a `yarn.lock`/`pnpm-lock.yaml` is nonetheless present (already
`pinned: true` via the existing check, so this basis is never reached) or where the resolved command is
`yarn`/`pnpm`/`bun` without any lock evidence at all. In that last case: `established: false, detail:
"time-boxed resolution is implemented for npm only in this phase; <manager> has no equivalent flag verified here"`.
This is a mandatory negative-case test (§7.5), not an aspiration — silently treating `npm install
--before` as if it generalizes to `yarn --before` (no such flag exists) would be exactly DEFECT 30's
mistake repeated with a new name.

## 4. Provenance — persisted on every affected receipt, not just logged

Two places, both already receipt-shaped:

- **`requirementChecks`** (already exists, `infer.ts:195`'s neighborhood): the `DEPENDENCY_BASIS_PINNED`
  and `DEPENDENCY_BASIS_TIME_BOXED` entries both appear, `satisfied`/`observed` filled in honestly for
  each — a reviewer sees "pinned: false (no lockfile and no packageManager field), time-boxed: true
  (bounded to 2026-09-01T08:25:03Z, sourced from the reference plan's ciGroundTruth)" rather than one
  opaque "executable: true".
- **The step receipt itself** (`runArm`'s `StepReceipt`, `scripts/ci-reproduction.ts`): the actual argv
  used (`command`, already recorded) will show the `--before=<cutoff>` flag verbatim — no separate field
  needed, the existing "record exactly what was spawned" discipline already carries this once the flag is
  actually part of the command array. Additionally, capture the resolved dependency versions as a
  distinct artifact: `npm ls --all --json` (or equivalent) run immediately after the time-boxed install,
  persisted as `dependency-resolution.json` alongside `reproduction.json` — so "what did this specific
  attempt actually resolve" is inspectable later without re-running anything.

## 5. Command construction — exactly where `--before` is appended, and why it survives

Traced against the real execution path (`scripts/ci-reproduction.ts`):

1. `inferPipeline` → `planForPurpose` (line ~731) already computes `plan.executable` from
   `computeCompleteness`. This is where the new either/or from §1 is consulted.
2. `inferenceSteps` (line 735) is built by mapping `plan.operations` to `{ command: o.command, environment: o.environment }`.
   **`o.command` for an install-kind operation is built inside `src/ci-inference/infer.ts`, at the same
   site that currently computes `basis` and feeds `DEPENDENCY_BASIS_PINNED` (`infer.ts:195`'s
   neighborhood).** The `--before=<cutoff>` flag must be appended to `command` **at that same site**,
   conditioned on `DEPENDENCY_BASIS_PINNED.satisfied === false && DEPENDENCY_BASIS_TIME_BOXED.satisfied === true`
   — never for a genuinely pinned repository (which needs no flag and shouldn't carry one), never for a
   repository where neither basis holds (which never reaches command construction at all, since
   `plan.executable` stays false).
3. This means the flag is baked into `o.command` **before** `ci-reproduction.ts` ever sees it — it is not
   bolted on downstream in the CLI script, which has no independent way to know which basis was used.
   `inferenceSteps`'s existing `.map()` needs no change at all; it already forwards whatever `o.command`
   contains.
4. **Survival through the shell-safety layers** (`runArm`, `scripts/ci-reproduction.ts:333-357`): `resolveTokens`
   (only substitutes the one whitelisted `steps.cpu-cores.outputs.count` token — untouched by this),
   then `findShellUnsafeArgument`/`assertShellSafeArgs`. **Verified, not assumed**: `SHELL_METACHARACTERS`
   (`scripts/shell-safety.ts:28`) is `/[\s&|<>^"'`$();!*?[\]{}~#\\]/` — an ISO-8601 timestamp
   (`--before=2026-09-01T08:25:03Z`, containing only letters, digits, `-`, `:`, `=`) matches none of it,
   so the flag takes the ordinary shell-safe path, `assertShellSafeArgs` passes, exactly like every other
   argument this harness already spawns. Still worth one explicit unit test asserting this stays true (a
   regex a future change could tighten without noticing this case), but it is not an open question this
   plan is leaving unresolved.
5. **The reference arm is never touched.** `referencePlan.steps` (line 746) has no relationship to this
   change at all — it stays a literal, zero-repair transcription of the real workflow, exactly as every
   existing plan already is. Only the *inference* arm's own engine-derived install command gains the
   flag, and only when the engine itself determined it needed to.

## 6. Fail-closed cases — never fall through to an ordinary floating install

All six from the investigation, restated as the mandatory acceptance tests for this implementation
(§7 makes them concrete):

1. No cutoff available (plan predates this schema addition, or omits `jobStartedAt`) → `established: false`, behavior identical to today.
2. `npm install --before=<cutoff>` itself errors (`ETARGET`) → the step fails exactly as any other failing
   step does today (recorded, not swallowed, not retried without the flag). **Explicitly forbidden:** any
   retry path that drops `--before` and re-attempts an unbounded install.
3. A dependency's registry `time` metadata can't be confirmed to have constrained the actual resolved
   version → after install, verify every resolved version's own registry-reported publish time is `≤`
   cutoff (cross-checking `npm ls --json`'s resolved versions against the registry, not merely trusting
   that passing `--before` was sufficient) — mismatch is treated as a failed step, not a warning.
4. §7's regression run should also attempt, where feasible, a cross-check against any independently
   recoverable original-CI-log version evidence (Candidate C from the investigation) — if both exist and
   disagree, that disagreement is recorded as its own finding, not silently resolved in either direction.
   (No current tooling recovers this automatically; this is "check if it's available and note it," not
   new infrastructure this plan is committing to build.)
5. Non-npm package manager → `established: false` per §3, unconditionally, this phase.
6. Non-deterministic postinstall/native-build side effects → explicitly out of scope; this basis makes no
   claim about them and the acceptance criteria must not imply it does (documented in the receipt/label
   text itself, not just this plan).

## 7. Eslint and chalk as regression fixtures — predicted behavior, stated before implementation

**Pre-registered now, verified empirically against the real manifests before writing this plan (not
predicted blind):**

| | job cutoff (from the real GitHub Actions job, to be added to each plan's `ciGroundTruth`) | `npm install --before=<cutoff> --package-lock-only` against the real manifest |
|---|---|---|
| eslint @ `2417cad57...` | `2026-09-01T08:25:03Z` (job `99789022791`) | succeeds, exit 0, 1133 packages resolved |
| chalk @ `661317e6f9...` | `2026-07-26T14:51:09Z` (job within run `30206948620`) | succeeds, exit 0, 492 packages resolved |

**Predicted change in `classify()`'s outcome for both, stated honestly as a prediction, not a
foregone conclusion:** both should move from `REFUSED` (blocked before the inference arm could attempt
anything) to the inference arm actually executing its install-and-test path. **What outcome results after
that is explicitly not predicted here** — `REPRODUCED`, `PARTIAL_REPRODUCTION`, `DIVERGED`,
`GROUND_TRUTH_CONTRADICTED`, or a different `REFUSED` reason entirely (e.g. eslint's inference arm could
still hit an unrelated completeness gap, same as `SCRIPTS_RESOLVED`/`COMMAND_RESOLVED` might) are all
legitimate results. **The regression check is: did the refusal reason change from
"a pinned dependency basis" to something else (or to a real comparison), and did every other repository
in the five-repo + four-repo corpora stay byte-identical?** Not "did these two now say REPRODUCED."

## 8. Acceptance criteria for this implementation (checklist form)

- [ ] `DEPENDENCY_BASIS_TIME_BOXED` added to `reference-graph.ts`, distinct label/predicate, never merged
      into `DEPENDENCY_BASIS_PINNED`.
- [ ] `timeBoxedDependencyBasis()` in `resolve.ts`, taking facts + an optional cutoff, npm-only per §3.
- [ ] `ciGroundTruth.jobStartedAt` added to the reference-plan schema (`v2` extended in place — additive,
      optional field; existing plans without it simply have no time-boxed basis available).
- [ ] `--before=<cutoff>` appended to the install operation's `command` inside `src/ci-inference/infer.ts`,
      at the site that already computes `basis`, conditioned exactly as in §5 — never for a genuinely
      pinned repository.
- [ ] Verified (unit test) that `--before=<ISO-8601 timestamp>` passes `findShellUnsafeArgument` cleanly
      (or, if not, that the no-shell spawn path handles it correctly) — §5.4.
- [ ] `dependency-resolution.json` persisted alongside `reproduction.json` for any run that used the
      time-boxed basis.
- [ ] All six negative cases (§6) covered by real tests — synthetic fixtures constructing each condition,
      not solely the eslint/chalk regression run.
- [ ] `eslint`'s and `chalk`'s reference plans updated with the real `jobStartedAt` values from §7 (an
      additive, factual edit — not a regeneration of `steps`/`cellSelection`/`constructedIndependently`).
- [ ] Regression: full five-repo (`CI_REPRODUCTION_05`) + four-repo (`external-engine-bridge-01-first-pilot`)
      corpora re-run. Byte-identical everywhere except eslint and chalk's `DEPENDENCY_BASIS_PINNED`/
      `DEPENDENCY_BASIS_TIME_BOXED` receipts and whatever downstream outcome that unlocks for those two
      specifically.
- [ ] Typecheck + full unit suite clean, same bar as every other change in this project.

## 9. Post-fix evaluation boundary — fixed now, before implementation exists

1. Implement, exactly as scoped above.
2. Run the six negative-case tests (§6/§8) — mandatory, not optional coverage.
3. Run the eslint/chalk regression (§7) and the full old-corpus regression (§8's checklist item) —
   confirm the *predicted* change (refusal reason changes or resolves) against what actually happens, and
   report both, whatever they are.
4. **Freeze the implementation** — a commit explicitly declaring this item of `ENGINE_COVERAGE_01` done,
   before looking at anything past this point.
5. Only then, separately, resume the mechanical `CI_REPRODUCTION_05` ranking at the next untouched rank
   (23 onward) as a genuine holdout — never re-selecting from rimraf/lodash/husky/chalk/rollup/eslint.
6. **No additional coverage work is authorized based on that holdout's outcome until the outcome itself
   has been recorded and reported** — whatever it is. This plan does not pre-approve item 2 or item 3 of
   `ENGINE_COVERAGE_01`'s queue starting automatically once the holdout result comes in; that is a
   decision for after the result exists, not before.
