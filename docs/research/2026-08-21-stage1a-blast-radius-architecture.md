# Stage 1A — Phase 11: full CI blast-radius architecture proposal (design only, not implemented)

Whether the existing dependency graph could eventually drive affected builds/typechecks/lint scopes/
integration/E2E suites, not just test selection - a Stage 1 roadmap item, explicitly not implemented in
Stage 1A.

## What the current graph already provides, reusable as-is

- **A real, bidirectional dependency graph** (`forward`/`reverse` adjacency, `DependencyGraphImpl`) -
  the same reachability computation that drives `impact.affectedTests` already generalizes to "affected
  X" for any node-classifiable artifact, not just tests. `graph.reverse[changedFile]` (transitively) is
  the general primitive; test selection is one specific consumer of it today.
- **Entry-point classification** (`affectedEntryPoints`, `isEntryPoint`) - already distinguishes
  structurally significant files (pages, API routes, scripts) from ordinary source, a natural basis for
  "affected build targets" (an entry point whose transitive dependencies changed needs rebuilding).
- **The task registry** (`buildGenericTaskRegistry`) already models CI as a set of typed tasks with
  dependencies on file categories - lint/typecheck/build tasks already exist in this model, just not
  yet driven by the SAME graph-reachability logic tests are.

## What would need new evidence or new capability, not just reuse

- **Typecheck blast radius**: TypeScript's own incremental-build info (`.tsbuildinfo`) already encodes
  exactly this - which files' types depend on which - for project-references-enabled repos. For repos
  without project references, DiffCI's own graph (already TypeScript-compiler-driven) is a reasonable
  proxy, but "affected by a *type* change" is not identical to "affected by a *value* change" (a type-
  only change to an exported interface has a different, sometimes broader, blast radius than a
  same-signature implementation change) - this is a real, new semantic distinction, not free reuse.
- **Lint blast radius**: usually closer to "did the ruleset or the file itself change" than genuine
  dependency-driven blast radius (most lint rules are per-file, not cross-file) - the graph mostly
  doesn't help here; a lint task's own file-level diff (already partially covered by the existing
  config-file fallback rules) is more directly relevant than graph reachability.
- **Build blast radius**: closest to what the graph already models (entry points + their transitive
  dependencies), but bundler-specific concerns (code-splitting boundaries, dynamic-import chunk
  assignment - directly related to Phase 3's finding that dynamic imports already break DiffCI's static
  resolution in some cases) mean a real implementation would need bundler-aware boundary detection this
  codebase does not currently have.
- **Integration/E2E blast radius**: the hardest case. These suites typically exercise cross-cutting,
  multi-file, sometimes multi-service behavior that a single-repository static dependency graph
  structurally cannot fully capture (an E2E test might depend on runtime configuration, environment
  variables, or a separate backend service's behavior that never appears as an import edge at all).
  Phase 4's forensic findings are directly relevant here: several of the "historical misses" investigated
  turned out to be environment-dependent (flaky network calls, timing-sensitive assertions) precisely
  the kind of behavior a dependency graph cannot see. Full E2E blast-radius analysis would need
  substantially new evidence sources beyond what static graph analysis alone can ever provide.

## Proposed architecture sketch

```
change (git delta)
  → dependency graph (existing, reused as-is)
    → affected source files (existing: impact.affectedSourceFiles)
    → affected tests (existing: impact.affectedTests)
    → affected entry points (existing: impact.affectedEntryPoints)
      → affected build targets (NEW: entry points + bundler-boundary awareness)
    → affected typecheck scope (NEW: reuse graph reachability + .tsbuildinfo where available;
      explicitly distinguish type-surface changes from implementation-only changes)
  → affected lint scope (NEW, graph-independent: primarily file-level diff + config-file fallback rules
    already largely in place)
  → affected integration/E2E scope (OUT OF SCOPE for static graph analysis alone - would need new
    evidence: service dependency manifests, environment/config-variable usage tracking, or explicit
    developer-authored test-to-feature mapping - none of which this codebase currently has)
```

## What Stage 1A's own findings say about sequencing this work

Per Phase 3/8/9's findings, extending blast-radius analysis onto the CURRENT graph before addressing the
known UNSAFE-confidence gaps (35% of the Stage 0 corpus) would inherit the exact same blind spots -
any repository that's UNSAFE for test selection today would be equally UNSAFE for build/typecheck
blast-radius analysis, for the identical underlying reasons (unresolved imports, tsconfig-scope
mismatches). **The graph-confidence and reachability-policy work identified in Phase 9 as highest-
leverage is a prerequisite for blast-radius expansion to be worth as much as it could be, not an
independent, parallel track.**
