# Observer 0.1.2 hosted promotion

Promoted September 10, 2026 from the exact Cloudflare-tested source commit
`b3249b37eb3ce0076636fce40acf662fcd99ecc0`, tagged `observer-v0.1.2`.
Builds and qualification ran in Cloudflare. Promotion reused the tested source
archive and the exact candidate bytes; it did not rebuild the observer locally.

* Research Worker: `b07a1e85-f32a-4caa-b359-1cb0fa8695e2`.
* Product Worker: `0d650e13-c477-4fc1-8ea2-ff425f8e9d20`.
* Live research source integrity: CURRENT, with expected/archive SHAs equal to
  the tested commit. Cron remains enabled.
* Product health: worker, database, auth configuration, and queue checks passed.
* Source archive SHA-256:
  `b596498e2bb946e8e4b7548979d581b5de91090bf229fa81486609ea4923e936`.

The exact qualified archive was exported directly from its Cloudflare container
into private R2 bucket `diffci-validation-env`, key
`agents/observer-efa76324b970c7e6.tgz`. Export required a match to the previously
recorded qualification integrity. A subsequent remote download matched SHA-256
`efa76324b970c7e65d665210607f114e5f6a6f8ecf6bf59fc634dabeb51a8369`.

Release metadata is retained at `releases/observer/0.1.2.json`; the verified hosted
release pointer is `releases/observer/production.json` in that bucket.

This promotes the hosted engine and preserves the private observer release. It
does not configure customer package distribution: onboarding requires a private
npm or OCI source, which is still absent, and health correctly reports
`agentArtifactPinned: false`. No unusable npm pin was configured. Automatic
production skipping remains disabled because qualification demonstrated full-run
fallback behavior, not selective savings.

Rollback references: research Worker `afbbbc05-f46f-4db4-9ecd-eded5976be22`,
product Worker `0636aebf-c67a-4b08-88ca-a2b49b9ab04d`, source commit
`b8734a43e9b86d1d794697d4a04ffd51ae3008f1`. A rollback must restore the matching
source archive and expected SHA together.
