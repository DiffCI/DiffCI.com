# Historical cohort validation and test-import correction

Date: 2026-09-19. Forty frozen commit deltas, each analyzed with the published observer and an
unreleased corrected build: 80 reports total. No target tests were run and no savings were measured.

Follow-up 2026-09-20: both corrections are released in [0.1.4](../release-0.1.4/README.md), with a fresh
public npm install and a commit-pinned Action installation verified. The historical raw reports and
their then-unreleased build identities below remain unchanged.

## Decision

**Do not use ky's original 3/30 selection as an outreach claim.** The graph omitted imports from tests
outside the compiler's include list. Correctly parsing those imports broadens the latest selection
to 28/30 test files. The same correction broadens all 19 source-changing ky deltas in this sample.

h3 remains useful for integration validation, but is a weak lead for a large savings claim: the latest
successful test job lasted 43 seconds, with 17 seconds in the Vitest coverage step. Those are existing
GitHub run timestamps, not a controlled full/selected comparison. Analysis overhead was measured on a
different host, partly under concurrent test load, and must not be subtracted from those timings.

| Repository | Frozen deltas | Source-changing deltas | Published / patched SELECTIVE verdicts | Changed selections | FULL verdicts after fix |
| --- | ---: | ---: | ---: | ---: | ---: |
| [h3js/h3](h3js--h3/README.md) | 20 | 9 | 9 / 9 | 0 | 11 |
| [sindresorhus/ky](sindresorhus--ky/README.md) | 20 | 19 | 20 / 20 | 19 | 0 |

SELECTIVE is an engine verdict, not a demonstrated runtime saving or safety guarantee. In particular,
counting SELECTIVE verdicts alone would hide this defect: ky's verdict stayed SELECTIVE while most of
its test files returned to the selection. Both repositories have recent Actions activity, recorded in
the metadata and Actions JSON files here. h3's canonical repository is now h3js/h3; the initial study
used the redirecting unjs/h3 URL.

## Sampling and provenance

- [Manifest](manifest.json): latest 20 first-parent default-branch deltas per repository, frozen for
  both repositories before the historical analysis began. Documentation, tests, and configuration
  changes remain in the denominator. These are commit deltas, not a count of historical PRs.
- Each head was checked out before analysis. Both commits were present locally. No target dependencies
  were installed and no target code, build scripts, or tests were executed.
- Published arm: installed npm package @diffci.com/diffci@0.1.3; Node v24.16.0 on Windows; --no-send.
- Corrected arm: this working tree compiled with npm run build:client. [Identity](patched-identity.json)
  includes source and compiled-graph hashes. The embedded package version still says 0.1.3; it is not
  a second published release. Reports under each patched/ directory belong only to this arm.
- Every report is OBSERVED with the expected schema and frozen base/head. Independent before/after
  git-status checks matched for all 80 observations. Raw reports are preserved rather than overwritten.
- Source-changing means a JS/TS implementation path under src/ (h3) or source/ (ky), not a generic
  inference that all other changed files are irrelevant.

## Root cause and correction

Ky's tsconfig includes source/. Its tests import source/index.js, but the observer's TypeScript program
did not load those tests. A later graph-building step added discovered tests as disconnected nodes,
allowing the graph to report COMPLETE confidence while excluding real dependent tests.

The [edge audit](ky-edge-audit.json) records the failure at the frozen ky head:

| Check | Published 0.1.3 | Unreleased correction |
| --- | --- | --- |
| Dependencies of test/main.ts | None | source/index.ts and two test helpers |
| Test paths reachable from source/core/Ky.ts | None | 28 |
| Graph edges | 90 | 155 |
| Latest proposed selection | 3/30 | 28/30 |

The graph now adds discovered JavaScript/TypeScript tests to the parser's root files before import
extraction. Compiler exclusions no longer remove their dependency edges. JavaScript tests and imported
helpers are parsed too; unresolved imports remain confidence blockers. The graph cache schema changes
so previously cached disconnected graphs are not reused.

Two regression tests failed before the fix: a source-only compiler configuration omitted its dependent
test, and a nested package's excluded test had no import edge. They pass after the fix. Additional
coverage checks excluded JavaScript tests/helpers and unresolved imports from excluded tests.

Validation: typecheck passed; full test suite **2,150 passed, 1 skipped, 0 failed**; client build,
OSS package boundary, and tarball install-to-observation smoke passed. See [test summary](test-summary.txt)
and [package smoke](package-smoke.txt). This proves the tested correction, not general safety on these
repositories. Native Go execution was not established on this host.

## Actual workflow parity

The review packets link the workflows at the exact sampled heads. h3 runs lint, typecheck, build,
Vitest coverage, and coverage upload. Ky installs Playwright and runs a compound npm test script
containing lint, build, typechecking, and AVA across three Node versions on macOS. A proposed test-file
command cannot replace either entire pipeline. No execution-selection invariant or mutation recall
was measured in this study. Full coverage collection may intentionally need tests outside a change's
proposed selection.

## Onboarding evidence and remaining gaps

Downloaded the artifact from the existing [DiffCI self-observation run](https://github.com/DiffCI/DiffCI.com/actions/runs/35446235675).
It contains an OBSERVED diffci.observation.v1 report from Linux/Node 22, with matching before/after
checkout hashes. [Artifact metadata](diffci-self-artifacts.json) and [report summary](diffci-self-artifact-summary.json)
are retained. This run uses the repository's local ./ Action, not a fresh external installation of
the pinned release, and predates this correction.

Its workflow audit reports blocking findings for the npm release job. That job contains a registry
dist-tag command mentioning the DiffCI package, rather than an observation command. A regression test
reproduced this false positive. The guard now ignores literal registry tag-removal lines while retaining
inspection of actual observer commands on another line, after a semicolon, or as an OR fallback.
The release workflow's failure behavior is unchanged. The local corrected CLI audits all four repository
workflows with no findings; see [local workflow verification](workflow-verification.txt). The downloaded
artifact is preserved with its original findings and still predates both corrections.

Release qualification is complete; still open before describing hosted onboarding or savings as verified:

1. Verify opt-in hosted ingestion, organization-scoped report access, retention, and uninstall. The new
   separate-repository Action fixture is DiffCI-owned, sends no hosted reports, and does not establish these.
2. Validate representative source changes in an isolated execution environment before making savings claims.

The two review packets are internal drafts. No messages, installations in maintainer repositories,
enrollment, deployments, npm releases, or GitHub releases were performed by this study.
