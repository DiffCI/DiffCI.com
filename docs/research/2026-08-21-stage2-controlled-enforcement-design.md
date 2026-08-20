# Stage 2 Phase 18 — controlled enforcement design (DESIGN ONLY, not activated)

**Nothing in this document is implemented or enabled.** No code path in this repository can currently
cause DiffCI to skip, cancel, or alter any real CI work. This is a design for the step *after* Stage 2's
evidence thresholds are met and a human has explicitly approved moving a specific repository forward -
not a plan this session executes.

## Enforcement levels

**Level 0 — Shadow (current state, all of Stage 2).** Skip nothing. Predict, record, compare. This is
the only level any code in this repository can reach today.

**Level 1 — Ultra-high-confidence selective execution.** Enforce *only* on the narrowest, highest-
confidence case: `effectiveGraphConfidence === "COMPLETE"` (never `PARTIAL`), `opportunityCategory ===
"DISCRIMINATIVE_OPPORTUNITY"` (never a `MANDATORY_FALLBACK` delta - those never skip anything anyway) or
`"BASELINE_ALREADY_OPTIMAL"`, and only for a repository already in `READY_FOR_ENFORCEMENT_REVIEW` with
zero open unsafe misses. Everything else - every `PARTIAL`/`UNSAFE` confidence, every fallback, every
repository not individually approved - runs FULL. This is deliberately conservative to the point of being
commercially marginal on its own; its purpose is proving the enforcement *mechanism* (kill switch,
rollback, audit trail) is safe before Level 2 exercises it more broadly.

**Level 2 — Standard selective execution.** The same selection logic Stage 0/1B already validate, applied
broadly with the same fallback rules already in place (any `UNSAFE` confidence, any global-risk trigger,
still falls back to FULL exactly as today). The difference from Level 1 is scope, not new logic - Level 2
is "trust the same decision engine on more of its own decisions," not a new decision engine.

**Level 3 — Full CI blast radius (future).** Build/typecheck/lint/package-graph-aware selection beyond
tests - explicitly out of scope for this design; Phase 19 below is what Stage 2 collects evidence for
*deciding whether Level 3 is worth building at all*, not a plan to build it now.

## Required safety mechanisms (must all exist before Level 1 can be proposed for any repository)

- **Kill switch**: a single global flag (`ENFORCEMENT_KILL_SWITCH`, a Worker secret/var, checked first in
  every enforcement decision path) that forces every repository back to Level 0 behavior regardless of
  its individual state. No deploy required to flip it - a config change only.
- **Repository-level disable**: `shadow_repositories.state = 'PAUSED'` already exists in the schema
  (Phase 14) and already means "don't do anything for this repository" for shadow observation; enforcement
  reuses the identical field rather than adding a second disable mechanism to keep in sync.
- **Per-run override**: a magic PR label (e.g. `diffci:force-full`) or commit-message trailer that forces
  that one specific run to FULL, checked before any enforcement decision - for a human who wants full
  confidence on one specific change without touching the repository's overall enforcement level.
- **Automatic FULL fallback**: exactly the fallback logic that already exists and is already validated
  (Stage 1A/1B) - `effectiveGraphConfidence !== "COMPLETE"` or any global-risk signal already forces FULL
  today in shadow mode; enforcement changes nothing about when fallback fires, only what happens when it
  *doesn't*.
- **Emergency bypass**: a documented, logged, human-triggered one-off command (not a standing config
  change) for "this specific commit, right now, ignore the enforcement level" - distinct from per-run
  override in that it's meant for an active incident, not a routine "I want to be careful" case.
- **Audit trail**: every enforcement decision (what level was active, what was actually selected, whether
  a bypass/override applied) is a durable, immutable record - the exact same `shadow_predictions`-shaped
  row Stage 2 already writes, with an added `enforcementLevel`/`enforcementApplied` field, so an
  enforcement-era prediction is auditable with the identical tooling already built for shadow-era ones.
- **Rollback**: reverting a repository from Level 1 back to Level 0 must be a single state-field write
  (`shadow_repositories.state`), never a deploy or a data migration - the same reason `PAUSED` already
  works this way.
- **Policy versioning**: the enforcement level and its exact trigger conditions (which confidence/
  opportunity combinations qualify) are versioned data, not hardcoded logic, so a policy change is
  auditable and reversible independent of code deploys.

## What Stage 2 actually leaves ready for this

Nothing beyond the schema fields and the shadow-prediction pipeline itself - the enforcement mechanisms
above are unbuilt. What Stage 2 *does* leave ready: every prediction already carries
`effectiveGraphConfidence` and `opportunityCategory`, which is exactly the data Level 1's trigger
condition needs; the repository state machine already has the field enforcement would reuse; and the
audit-trail shape (immutable, R2-backed, D1-indexed) is already the pattern the rest of this codebase
uses, so extending it is additive, not a new subsystem.

## Explicitly not done in this design

No timeline, no specific repository targeted for Level 1, no code written. This document exists so that
*when* a repository clears the enforcement-review thresholds and a human decides to proceed, the shape of
what needs building is already known - not so that it happens automatically or soon.
