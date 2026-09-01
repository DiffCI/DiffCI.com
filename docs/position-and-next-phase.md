# DiffCI — the position as of 2026-09-01, and the next phase

## The claim, in the only form that should be repeated

> DiffCI has demonstrated **large compute reduction while preserving detection** on a blinded, measurable
> case, and has **independently demonstrated graph-based reach beyond changed files**. It has **not**
> demonstrated that graph reach was **causally necessary** for detection.

This wording holds for investor, customer and technical audiences alike. The third sentence is not a
caveat to be dropped when the audience is friendly — it is the part that makes the first two credible.

**Do not say:** "13.4× smarter CI", "AI-powered test intelligence proven", or anything implying the
dependency graph caused the saving. On the one measured safety-plus-savings case, it demonstrably did
not: `GRAPH_REACHED` was 0 and a changed-file rule would have tied.

## The evidence, closed

| | detection | graph contribution | economics |
|---|---|---|---|
| **GENERATION_C_01** | ✅ `RECALL_CONFIRMED`, no false green | **0** graph-reached | **+71.48 CPU-s** incremental |
| **MI-01** | ⬜ unmeasurable | ✅ 1 graph-reached | +43.81 (replication only) |
| **MI-02** | ⬜ unmeasurable | ✅ 1 graph-reached | +53.56 (replication only) |

- **One** measured safety-plus-savings result. Not three.
- **Two** independent demonstrations of graph reach, drawn blind under different precommitted rules.
- **Zero** false greens across every measurable candidate in the project.
- Costs: DiffCI 4–6 CPU-s where the comparator costs 52–77 and the full suite 59–85, on one repository.

## THE NEW BASELINE STANDARD

**Beating FULL no longer counts as a result.** From here, a selection must be measured against, at
minimum:

```
1. FULL                  — the whole suite
2. the path-rule comparator — DiffCI's existing frozen baseline
3. DIRECT-ONLY           — just the files the change touched   ← the cheap heuristic that has tied twice
```

Direct-only is the honest opponent. It is nearly free, requires no analysis, and on
GENERATION_C_01 it would have matched DiffCI's selection, detection and cost exactly. **Any claim that
proprietary intelligence earns its compute must show it beating that**, not merely beating running
everything.

This is the standard by which the moat is real or is not.

## The next milestone — bigger than "prove the graph"

> Given a real repository's **actual CI configuration**, can DiffCI reconstruct the pipeline, predict the
> minimum safe work, execute it, and produce **auditable savings receipts**?

That moves the product from *test selector* to *CI/CD optimisation system*. Tests stop being the product
boundary and become nodes in a larger execution graph.

## Engineering sequence

1. **Repository CI inference** — parse real GitHub Actions workflows, package scripts, matrices,
   services, environment, and the build/test/lint/typecheck dependency relationships.
   *The RED corpus (`docs/red-qualification-corpus.md`) is the evaluation set for this*: six repositories
   whose real configuration defeated generic command derivation, each with the derivation record showing
   exactly what evidence produced the failing command.
2. **Pipeline execution graph** — jobs, steps, artifacts, dependencies, and their CPU/wall/cost.
3. **Shadow decision engine** — for every change emit the FULL plan, the existing-CI/comparator plan and
   the DiffCI proposed plan, **without controlling customer CI**.
4. **Savings receipts** — gross and incremental CPU/wall/cost per step and per pipeline, retaining the
   refusal and FULL fallback, with counterfactual verification.
5. **Learning dataset from day one** — what DiffCI knew, what it predicted, why it selected or skipped
   each unit, what actually happened, costs, counterfactuals, and `outcome.layer`. This is the
   proprietary training substrate, and it must be correct from the first row: retrofitting causality is
   the one thing that cannot be done honestly later.
6. **Continuous evaluator** — the Generation C and MI machinery lives here, carrying
   `DIRECT_CHANGED`/`GRAPH_REACHED` attribution and the direct-only arm.

## Effort allocation

```
80–90%  product, optimisation, learning infrastructure
≤10–20%  maintaining and expanding safety evaluation
```

Safety infrastructure is not finished, but it is **sufficient**. Two years of it would not make the
product exist.

## The detection question is re-homed, not abandoned

Two prospective experiments could not produce a behaviour-visible mutation under the isolation shape —
and MI-02 showed why: on a repository with message- and fixture-driven tests, *"changed no test file"*
and *"behaviour-visible"* are close to mutually exclusive.

Continuous evaluation will meet naturally occurring behaviour-visible mutations across many repositories
without anyone designing an experiment to find one. The `direct-only` arm already exists to answer it the
moment one appears. **No further bespoke mechanism experiment is authorised or planned.**

## What must not regress

- `unknown ≠ negative` — `NOT_REACHED`, `NO_VERDICT`, `INFRASTRUCTURE`, `UNREGISTERABLE`,
  `RECALL_UNMEASURABLE`, `REFUSED` and `RED` stay distinct labels.
- **No DiffCI decision without an execution receipt**, and `outcome.layer` recorded at write time.
- Repository outcome ≠ infrastructure outcome; infrastructure rows never train impact models.
- Sealing before measuring; one attempt per candidate; results reported as measured, including negative
  and unflattering ones.
