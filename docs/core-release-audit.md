# DiffCI Core initial release audit — 2026-09-16

Public destination: https://github.com/DiffCI/core

Initial public commit: `61efdc88843ad6414210b057805edcb6bbdac999` (one fresh root commit).

The initial release was extracted from committed `origin/main` (`42d43c0`) into a new repository.
No private Git history or uncommitted working-tree changes were copied. `DiffCI/DiffCI.com` remains
private; `.github` contains only the public organization profile.

## Published content

35 engine source files were allowlisted from `src/git`, `src/repo`, `src/planner`, `src/ci-inference`,
`src/cache` and `src/research/baseline`. Their static relative imports close entirely inside this
selection. Runtime external dependencies are TypeScript and YAML. The source history for these paths
attributes commits to the repository owner; no third-party source trees or private datasets were
copied. Git authorship is evidence of provenance, not independent proof of copyright ownership.

The standalone package adds a local CLI/high-level API, package entry point, process measurement,
explicit-input environmental/cost estimates, synthetic benchmark, boundary audit, build metadata,
AGPL-3.0-only text/notices and documentation. It carries 26 portable test files from the original
repository plus two new API/measurement test files. The public manifest enumerates 82 release files.

The private `planner.test.ts` depended on a product-specific task-registry fixture; it was not copied.
The production Shadow wiring test and original repository/history test were also excluded. Public
API tests independently cover selection, workflow fallback, always-run security policy and invalid,
dirty or mismatched checkouts. The repository-agnostic test was adjusted to omit private Shadow code.

## Verification

- Build and TypeScript checking passed on Windows/Node 24.16.0.
- All 303 portable tests passed, with no skips.
- [Public CI](https://github.com/DiffCI/core/actions/runs/35056388629) passed on Ubuntu and Windows,
  each on Node 22 and Node 24; every job ran all 303 tests, build, typecheck, boundary audit and benchmark.
- Synthetic benchmark built 200 graph nodes and 199 edges with COMPLETE confidence.
- Import/file boundary audit passed for all 82 files.
- Gitleaks 8.30.1 scanned the release directory and initial Git history: no findings. Binary checksum
  was matched to the upstream release checksums. Pattern scanning is not an exhaustive security audit.
- npm archive content was inspected: public Core source/build output and metadata only. No npm
  publication was performed. `private: true` prevents accidental npm publication; it does not control
  GitHub visibility.
- Full license text retrieved from https://www.gnu.org/licenses/agpl-3.0.txt. Runtime dependency
  notices identify TypeScript (Apache-2.0) and yaml (ISC).
- Unauthenticated GitHub API access returned 200 for public `DiffCI/core` and 404 for private
  `DiffCI/DiffCI.com`; authenticated metadata independently confirmed PRIVATE for the latter.

## Remaining migration boundary

Cloud billing, authentication, dashboard, tenant management, hosted runners, Shadow service/storage,
deployment configuration, research datasets, agent bundles and enterprise code remain private and
were not included. This is an independent Core release, not a rewrite of the running Cloud product.
The private product still uses its existing engine snapshot. Replacing internal imports with the
public package is a separate integration change; it must preserve current production behavior and
review licensing rights for future third-party contributions. Do not describe unpublished Cloud code
as AGPL merely because it shares this private repository with an engine snapshot.

The public CLI is advisory-only. It never authorizes automatic skipping. Lower-level static analysis
has documented coverage limitations. Measured process timings and modeled carbon/cost estimates are
separate claims. No grant acceptance or production/environmental-savings claim is implied.
