# Report 13 — non-root CI-parity experiment (PR #2808, merge SHA)

Per the recommended resolution order: reproduce real CI conditions more closely (non-root) on one representative merge before running more base-SHA controls in the dirty (root) environment.

## Harness change: opt-in non-root execution mode

New `ExecutionSpec.runAsNonRoot` (default `false`, every existing profile/run unaffected). `docker.io/cloudflare/sandbox:0.12.5` runs as root by default with no pre-built unprivileged user (`/etc/passwd`: only `root` and a shell-less `sync`, confirmed via a live probe) - `useradd -m -u 1001 ciuser` creates one fresh per run. Corepack's global activation stays root (needs to); the actual install and every test-run command (`full-baseline`/`selected-baseline`/`full-mutant`/`selected-mutant`) run via `su - ciuser -c '...'`.

**Three real bugs found and fixed getting this working, each caught by an actual failed/degraded run, not anticipated in advance:**
1. `deriving-selection` failed outright (`derive-selection-failed`) on the first real attempt (`deepseek-2808-nonroot1`). Reproduced standalone (`deepseek-ownerprobe1`) before fixing: `fatal: detected dubious ownership in repository` - git's own ownership-safety check refusing root's git calls against a directory now owned by `ciuser`. Fixed: `git config --global --add safe.directory <dir>` for both root and `ciuser`.
2. Second attempt (`deepseek-2808-nonroot2`) completed the actual test run successfully as `ciuser` (real output, real summary line) but its own JSON reporter crashed with `EACCES` opening `/workspace/full-baseline.json` - `reportPath()` writes one directory level *above* the cloned repo, which was never chowned (only the repo subdirectory was). Preserved as evidence, not discarded. Fixed: `chown ciuser:ciuser /workspace` (non-recursive) alongside the existing recursive repo chown.
3. Third attempt (`deepseek-2808-nonroot3`) completed cleanly end-to-end - full pipeline, parseable reports throughout.

## Result: real, substantial, but partial confirmation

| | Root (`canary2`) | Non-root (`nonroot3`) |
|---|---:|---:|
| `baseline.full` failures | 16 | **8** |
| `baseline.selected` failures | 0 | 0 |
| Runtime selection | `HONORED_EXACTLY` | `HONORED_EXACTLY` |
| Mutation target | `frontend-static/src/index.ts` | same (identical) |
| `mutant.full` new failure | 1 (`frontend-static.spec.ts`) | 1 (identical test) |
| `mutant.selected` | 1 (identical) | 1 (identical) |
| Recall | confirmed | confirmed (replication of the same case, not a new unique one) |
| Net economics | 93.4% | 93.6% |

**10 of the 16 root-only failures vanish entirely under non-root**: `subagent-acp`, `agent-instructions`, `settings-file`×2, `bash-sandbox`, `storage-sqlite`, `subagent/out-of-process`, `subagent-claude-code`×3 - every one of these is either a permission-denial test (expects a real POSIX permission failure, which root bypasses) or an external-SDK-fixture test. This is now **confirmed by direct execution**, not just pattern inference from Report 11.

**6 persist regardless of root/non-root**: `subprocess-local/process-exit.spec.ts`×4, `install-lefthook.spec.ts`, `terminal-bash/local.spec.ts`. None of these are permission-themed - they involve process/signal handling (`SIGINT` cancellation, process-tree cleanup "on host exit", a real `git`-hook installer). **Working hypothesis, not confirmed**: these may be sensitive to container/namespace/process-group differences the sandbox environment has regardless of UID, not to root privilege specifically. Genuinely unresolved.

**2 failures appeared under non-root that were never seen under root** (`subagent/continuation.spec.ts`×2, "continuable durability and teardown...") - and then **disappeared again within the same run** (present in `baseline.full`, absent in `mutant.full` moments later) - directly demonstrating these 2 are flaky in the ordinary sense (unstable within a single environment, not root-attributable either way).

## Does this reach the "ideal outcome"? No - stated plainly

The ideal outcome specified was `base full: green, merge full: green, merge selected: green, full mutant: attributable failure, selected mutant: same failure`. **This run does not reach that bar.** `baseline.full` is still red (8 failures) under non-root - the false-green condition (`baseline.full` exit 1, `baseline.selected` exit 0) still occurred, just with substantially less noise than under root. Non-root execution is a real, confirmed *partial* explanation for the dirty baseline (10/16 failures resolved), not a complete one.

## What this does and does not establish

**Does**: directly confirms (not just infers) that root-vs-non-root execution is a real, substantial contributor to this repository's recurring baseline failures - a majority of them. Confirms the mutation-recall result replicates identically under a materially different execution environment (same mutation target, same failing test, same selected suite catching it).

**Does not**: fully resolve absolute CI-outcome preservation for `#2808` or any other merge. The 6 persisting + 2 flaky failures remain a genuinely open question, not attributed to root/non-root, and not yet attributed to anything else with evidence.

## Next: base-SHA non-root control

Launched (`deepseek-2808-nonroot-basecontrol1`) to complete the requested 5-stage table (`base full` under non-root, to check whether the remaining 8 failures - or some subset - also predate this merge, same as the root-mode `#2760` control in Report 12). Result to follow.
