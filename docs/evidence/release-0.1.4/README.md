# DiffCI 0.1.4 release qualification

Date: 2026-09-20. Source commit: `dee4f7b938a7720d077c1124ef2ea050aa2625d6`.

## Status

**Released and verified.** The source commit is on main and tagged v0.1.4, npm latest resolves to
0.1.4, and the [GitHub release](https://github.com/DiffCI/DiffCI.com/releases/tag/v0.1.4) is published.
An initial public-registry read returned the previous version; a later fresh install of 0.1.4 passed
the regression fixture. No duplicate publication was attempted.

The fresh registry install produced an OBSERVED report selecting alpha.test.js only (1/2), with an
unchanged checkout and no workflow findings. See [npm observation](npm-observation.json),
[registry metadata](npm-metadata.json), [dist-tags](npm-dist-tags.json), and
[workflow verification](npm-workflow-verification.txt). npm audit signatures verified signatures for
all 22 installed packages and attestations for 13; [verification output](npm-signatures.txt).
The installed tarball's integrity matches the registry metadata: [identity](installed-tarball-identity.json).
The ordinary [main-branch CI run](https://github.com/DiffCI/DiffCI.com/actions/runs/35488113015)
also completed successfully after the release commit was pushed.

## What changed

- Discovered tests outside the compiler include list now have their imports parsed, restoring
  dependency edges. JavaScript test helpers and unresolved imports are covered by regression tests.
- Graph cache identity changed so disconnected test graphs cannot be reused.
- The workflow guard distinguishes literal npm registry tag removal from an observer invocation.
- Prerelease publishing no longer removes the stable latest tag; publishing with --tag alpha is sufficient.
- The installed-tarball smoke fixture now excludes tests from compiler scope and checks their selection.

## Qualification evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Clean Windows checkout: typecheck and full suite | 2,147 passed, 4 skipped, 0 failed | [Summary](local-check-summary.txt) |
| Linux preflight: typecheck, tests, boundary and package smoke | 2,151 passed, 3 skipped, 0 failed; package smoke passed | [Run](https://github.com/DiffCI/DiffCI.com/actions/runs/35488007560), [excerpts](preflight-log-excerpts.txt) |
| Tag-triggered release | Passed including signed provenance publication | [Run](https://github.com/DiffCI/DiffCI.com/actions/runs/35488114776), [excerpts](publish-log-excerpts.txt) |
| Separate repository, commit-pinned Action | OBSERVED; 1/2 tests selected; unchanged checkout; no workflow findings | [Run](https://github.com/DiffCI/observer-install-smoke/actions/runs/35487994565), [artifact](action-artifact/diffci-observation-35487994565-1.json) |
| Ordinary fixture test job | Both tests passed, independently of the observer job | [Run metadata](action-run.json), [log excerpts](action-log-excerpts.txt) |
| Fresh public npm installation | Version 0.1.4; expected 1/2 selection; clean workflow audit | [Observation](npm-observation.json), [audit](npm-workflow-verification.txt) |

Skip counts reflect unavailable platform/corpus checks; the raw summaries are preserved. The Linux
run also exercises available native tooling. These are software qualification checks, not economic
or production safety measurements on third-party repositories.

## Separate-repository installation

[DiffCI/observer-install-smoke](https://github.com/DiffCI/observer-install-smoke) is a new, public,
DiffCI-owned synthetic fixture. It is not an independent maintainer pilot. Its compiler includes src/
only. The second commit changes src/alpha.js while leaving both tests unchanged. The observed range is:

- Base: `913665c81d7b9aede14cb260aa35ea3edbf5f9d6`
- Head: `372e682f713902437d5865fa58c41e80ba23166f`
- Selected: `test/alpha.test.js`
- Discovered: alpha.test.js and beta.test.js

The [workflow](fixture-workflow.yml) gives the observer a dedicated non-blocking job with contents:read,
fetch-depth:0, explicit HEAD^/HEAD revisions, and the full release commit pin. The separate test job runs
both tests. The workflow has only workflow_dispatch, so it creates no recurring workload.

GitHub downloads Actions as archives without .git. Accordingly, the report omits observer.engineSha;
the [download log](action-log-excerpts.txt) and pinned workflow establish the Action's actual commit.
The report's own version is 0.1.4. It reports no checkout changes and no workflow findings.

No DiffCI endpoint, token, or hosted enrollment was configured. The report is stored as a GitHub artifact.
This does not qualify hosted ingestion, organization access, retention, or token revocation. Those remain
separate checks before describing the complete hosted onboarding loop as verified.

## Remaining adoption work

Use the corrected published version for future observations and revalidate source-only-tsconfig cases
from earlier versions. The historical ky 3/30 claim remains withdrawn. Recruit real maintainers only
with supported evidence and complete the seven-day observation milestone separately. No maintainer
messages were sent during release qualification.
