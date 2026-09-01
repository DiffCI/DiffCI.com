# CI_REPRODUCTION_03 attempt 4 — how to pick this up in a new session

Written so that nothing about this run depends on one conversation staying open.

## The run does not need a session

`ci-repro-04-linux` is a Cloudflare Durable Object driving a container. The DO reschedules its **own**
alarm (`validation-shard-do.ts`, `setAlarm(Date.now() + nextAlarmDelayMs)`) and advances itself through
`ciReproducing → collecting → preserving → done`, writing evidence to R2 at the `preserving` step.

Nothing in that chain calls back to a laptop, a terminal, or a chat session. Closing the session does
**not** stop, pause, or orphan the run.

What a closed session *does* lose: the local watcher process, and the notification when it finishes.
The run and its evidence are unaffected — they are simply waiting to be fetched.

The DO enforces its own ceiling: `maxRunMs: 4 hours` for this job. A run that overruns is killed
server-side with its log captured first, so an abandoned session cannot leave something running forever.

## Identifiers

```
runId       ci-repro-04-linux
jobId       ci-reproduce-html-webpack-plugin
worker      https://diffci-validation-env.damp-waterfall-0cd8.workers.dev
source key  sources/diffci-be23dee0f5c4cee2.tgz
source sha  be23dee0f5c4cee22f8cb1c1d4cf24261aa92d2309d7a45cf3a431e48182caec
agent key   agents/observer-ee639e1ac7e1a81b.tgz
agent integ sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==
```

The agent integrity is **byte-identical to generation C**, which is the evidence that attempt 4 changed
instrumentation and not inference.

## Checking on it later

Status, including the live operation (`progress.tail` now names the running step):

```
npx tsx scripts/diffci-validation-cli.ts status --run-id ci-repro-04-linux
```

Once `step` is `done`, pull the evidence:

```
npx tsx scripts/diffci-validation-cli.ts collect --run-id ci-repro-04-linux
```

`reproduction.json` carries the verdict; `progress.jsonl` carries the durable per-operation receipts
added after attempt 3 — `stepId`, `arm`, `commandIdentity`, start/end, exit, `terminatedByBound`,
`outcomeLayer`, cpu/wall.

## Reading the result correctly

**Check `terminatedByBound` before believing any negative verdict.** Attempt 3's harness reported
`DIVERGED` when its own 20-minute ceiling had killed both arms. The classifier is fixed — `INFRASTRUCTURE`
is checked first — but the habit of asking *why* a suite did not run is the durable part, not the code.

Expected duration is genuinely unknown: attempt 3 established the suite runs **longer than 20 minutes**
and was killed before revealing how much longer. The bound is now 90 minutes per arm, two arms, so the
run is somewhere between roughly 50 minutes and the 4-hour DO ceiling. The first honest estimate arrives
when the *reference* arm's suite completes.

## Standing rules for whatever comes next

- If attempt 4 reaches `REPRODUCED`: freeze it immediately, **stop extending CI inference**, and move to
  `CI_OPTIMIZATION_01`.
- Do not repair a command by hand to make an arm pass. That is a refusal or a divergence, not an edit.
- Attempts 1–3 stay preserved exactly as recorded, including attempt 2's protocol violation and attempt
  3's incorrect auto-assigned `DIVERGED` field.
