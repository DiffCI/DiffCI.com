# Unstorage runtime validation 2026 10 03

Unstorage shows **50.9% net local runtime savings** in three alternating comparisons of a **patched evaluation checkout**, using unpublished DiffCI, Linux, a local S3 emulator and one test worker. This establishes a local result for the recorded configuration; it does not establish savings for the unmodified upstream revision or its default parallel CI.

| Median measurement | Time |
| --- | ---: |
| Full build and validation | 49.216 s |
| Selected build and validation | 15.344 s |
| DiffCI startup, analysis and planning | 8.819 s |
| Selected including DiffCI overhead | 24.163 s |
| Net time saved | 25.053 s, **50.9%** |

Full measurements ranged from 47.538 to 75.348 seconds; selected measurements ranged from 14.538 to 18.244 seconds. All six measured commands and all cache-reset commands passed. Checkout bytes and dependency fingerprints remained stable. The saved report passed the additional elapsed-time validity guard.

## Resolved validation issues

The apparent missing file was `test/storage.test-d.ts`: Vitest runs it as a separate type suite, while DiffCI's runtime universe contains all 40 runtime files. The selected pipeline explicitly retains all four assertions in that type suite.

Linux passed the filesystem and Netlify suites that failed on Windows. The installed Netlify test server encodes filenames on Windows but returns those encoded names when listing them. The isolated Linux runner needed MongoDB's `libcurl` dependency, a readable `/sys`, and a `/proc` mount for its current process namespace.

All 34 selected S3 tests ran and passed against local S3rver with synthetic credentials. The hostname used by the signing test maps to localhost inside the isolated runner. S3rver's filesystem bulk-delete cleanup was serialized to avoid its own concurrent directory-removal race. This is an emulator qualification, not a live AWS benchmark. S3rver configuration follows its [upstream documentation](https://github.com/jamhall/s3rver).

Repeated upstream baselines exposed a timeout in the database fixture's teardown. That teardown opens a fresh in-memory database after the tested database has been disposed, solely to drop a table in the new empty database. The supplied [fixture patch](db-fixture-cleanup.patch) avoids reopening ephemeral databases and retains the persistent MySQL cleanup. It changes no test cases, assertions or timeouts. MySQL remains environment-gated, with its cleanup implementation unchanged.

## Conservative selection

Import edges do not capture two checks: one reads every driver source file from disk, and another validates the generated declarations. The supplied [DiffCI configuration](diffci.json) always retains both, plus the database suite while evaluating its fixture fix. Unpublished DiffCI reproduces a **5/40 runtime-file selection** with a complete graph. All four Vitest type assertions run separately.

Each full run reports **567 passed and 204 environment-dependent skipped tests** across 41 files. Each selected run reports **119 passed and 17 environment-dependent skipped runtime tests** across five files, plus **four passed type assertions**. The 34 S3 tests have no credential skips in this experiment. Both measured pipelines retain build, lint, TypeScript checks and coverage.

Analysis runs before the build. Analysing the built checkout resolves generated declarations outside the source inventory and conservatively falls back to full validation. This experiment uses explicit matched commands; automatic `check` support for this coverage pipeline remains unimplemented.

## Measurement protocol

The [validated machine report](linux-safe-validated-savings.json) and [generated report](linux-safe-validated-savings.md) contain exact commands, all trial outputs, snapshots and dependency fingerprints. Three trials alternate full/selected and selected/full order. Both use `--maxWorkers=1`. Before each arm, the same fixed Vitest cache directories are reset. Dependency, MongoDB and operating-system caches remain available; the report's `cold` label refers to the reset Vitest caches, not a cold machine. Dependency installation, emulator startup and cache preparation are outside both measured validation pipelines.

The source commit range remains the recorded S3 change. Its evaluation overlay consists of the fixture patch and `diffci.json`; both are captured by the stable worktree digest `9e8a24f268744edd18aea1afe682845f4638576f70d71bd24687a9af56ee57d8`. No changes were pushed to Unstorage.

Earlier attempts are retained for audit. Default-worker cache warm-up and the unpatched single-worker repetition each hit the database cleanup timeout, making their evidence invalid. A later passing trial crossed a roughly 77-minute wall-clock discontinuity despite about 60 seconds reported by Vitest. The new local DiffCI guard rejects that report as invalid. These attempts are not used in the headline result; the initial estimated savings did not establish a reliable claim.

## Reproduction and artifacts

The manifest records source revisions, the local CLI package hash and the official Node image digest. Scripts preserve the evaluation configuration, fixture patch, S3 emulator, cache reset and matched commands. The owned Linux disk image and initial package tarball remain under `C:\Users\Swati Kale\.codex\diffci-evidence\2026-10-03`. `run-linux.sh` remounts that image and its required pseudo-filesystems after WSL shuts down. The updated timing guard and its regression tests are saved as `elapsed-timing-guard.patch`.

The timing guard passes DiffCI's exact-snapshot verification (`safe_to_continue: true`, 32 selected tests), the normal full suite (2,334 passed, seven existing skips), TypeScript checking and the client build. It also preserves the existing zero-timeout behavior. The guard is a local, uncommitted change in the owned CLI worktree; no DiffCI release or upstream fixture change was published during this task.
