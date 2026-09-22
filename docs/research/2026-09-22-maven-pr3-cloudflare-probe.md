# PR #3 Maven support: five repository Cloudflare probe

Date: 2026-09-22. All clones, installation, graph analysis, and impact planning ran inside a Cloudflare Sandbox Container (`docker.io/cloudflare/sandbox:0.12.5`, `standard-2`) through a temporary Worker. The desktop only deployed the Worker and retrieved its JSON responses. The container cloned `DiffCI/core` after PR #3 merged and ran `npm ci` before each probe.

Each row analyzes the latest commit against its first parent at the time of the probe. “Tests” means discovered test **files**, not test methods. A fallback means the selective command is not usable; the effective plan is full validation. No Maven test command was executed, so compute, wall time, and money savings are **unmeasured**.

| Repository | Head | Discovered tests | Actual commit result | Actionable test-file reduction |
| --- | --- | ---: | --- | ---: |
| [jitsi/jicofo](https://github.com/jitsi/jicofo) | `6ed82c9` | 70 | Full-validation fallback: unmodeled languages; 32 files identified but no selective command | 0 verified |
| [apache/maven-resolver](https://github.com/apache/maven-resolver) | `a90b7f7` | 206 | 1 file selected; `mvn -pl maven-resolver-tools -am test`; no fallback | 205 files (99.5% of discovered files) potentially excluded |
| [apache/maven-surefire](https://github.com/apache/maven-surefire) | `54522a7` | 726 | Workflow change forces full validation | 0 verified |
| [google/guava](https://github.com/google/guava) | `2a11c2a` | 0 | Unsupported nonstandard Maven source and test paths; unsafe graph and full-validation fallback | 0 verified |
| [apache/commons-text](https://github.com/apache/commons-text) | `00be782` | 103 | Workflow changes force full validation | 0 verified |

The resolver result is a **planning** reduction only. Maven's `-am` also builds required upstream modules, and this probe did not measure which test goals run there. Thus 99.5% is neither runtime nor compute savings. Across these five actual commits, the only usable selective command was for resolver; measured execution savings remain unknown.

The additional one-file scenarios showed that PR #3 can produce a command for Surefire (`mvn -pl maven-failsafe-plugin,surefire-its -am test`, 238 of 726 discovered test files) but the sampled latest commit changed CI configuration and correctly fell back. For Commons Text, a source-only scenario selected all 103 test files and `mvn test`, giving no test-file reduction. Jicofo still fell back. These scenarios were diagnostic and are excluded from the actual-commit table.

Findings for follow-up:

- Guava uses paths such as `guava/src/...` and `guava-tests/test/...`, outside the adapter's conventional `src/main` and `src/test` matching.
- Surefire's adapter scan counted 229 directories as modules because it includes POMs under `surefire-its/src/test/resources`; this count includes fixture projects, so it must not be used as the real reactor size or as a savings denominator.
- The temporary Cloudflare probe had intermittent Sandbox startup and interruption errors; failed attempts were retried. The five table rows are completed Cloudflare analyses, not desktop fallbacks.

Raw responses and the probe source are in `.scratch/maven-cloud-probe/` in this checkout. The dedicated temporary Cloudflare Worker and container application were deleted after the run.
