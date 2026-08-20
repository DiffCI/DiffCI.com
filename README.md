# DiffCI

DiffCI is a shadow-mode CI optimization tool for the DentalPresence repository. It analyzes Git diffs and repository structure to propose which CI tasks may be safely skipped, without ever modifying production CI behavior.

## Phase 2: Git Delta Analyzer

The Git Delta Analyzer is the first implemented component. It consumes a Git commit range and produces a structured, serializable `GitDelta` object.

### Key capabilities

- Parses `git diff-tree` output with `-z` to handle spaces and unusual filenames.
- Detects added, modified, deleted, renamed, and copied files.
- Distinguishes binary from text files via `--numstat`.
- Computes affected directories.
- Flags changes to configuration, dependency manifests, lockfiles, workflows, infrastructure, and database migrations.
- Represents analysis failures explicitly via `GitDeltaResult`.

### Project invariant

> Failure to analyze must never be interpreted as permission to skip CI.

`analyzeGitDelta` returns `{ success: false, error }` whenever SHA validation, Git commands, or parsing fails. It never silently returns an empty affected set.

### Commands

```powershell
# Type-check and run tests
npm run check

# Generate an example delta for the current repo's latest commit
npx tsx scripts/example-delta.ts
```
