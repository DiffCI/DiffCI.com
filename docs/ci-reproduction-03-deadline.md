# CI_REPRODUCTION_03 attempt 3 — deadline, frozen while the run is still opaque

Frozen at ~30 minutes elapsed, **before** knowing whether the run is about to finish.

```
At 45 minutes elapsed, if the run has neither COMPLETED nor produced externally
verifiable progress, terminate it and classify the attempt as

    INFRASTRUCTURE / OBSERVABILITY_INSUFFICIENT

never DIVERGED, REFUSED, or a repository failure.
```

**The deadline is not extended again at minute 45.** Writing it down now is the point: at minute 44 the
argument "it might be seconds away" will be exactly as available as it is now, and exactly as unfounded.

## What counts as externally verifiable progress — and what does not

**Does not count: the heartbeat.** It advances on every alarm regardless of whether the child process is
doing anything, so it is evidence the DO is alive, not that the run is progressing.

**Does not count: `timings`.** Those fields are written when a *step* completes, and the whole execution
is inside one step, so they cannot move until it ends.

**Would count:** a captured log, or a per-operation receipt. Neither exists, because the harness collects
its log only when the child exits. That is precisely the gap this deadline exists to expose.

Realistically, then: **complete by 45 minutes, or be terminated.** Said plainly rather than left as a
condition that sounds satisfiable and is not.

## If termination is necessary

Attempt 3 is preserved as `INFRASTRUCTURE / OBSERVABILITY_INSUFFICIENT`. It is **not** evidence about
`html-webpack-plugin`, about the inference engine, or about reproduction.

Then, before attempt 4, fix observability only:

```
step ID → arm → command identity → START ts → END ts → exit → CPU/wall → outcome.layer
```

emitted durably **as execution happens**, not assembled after the child exits. A four-hour execution
with no indication of which operation is active is not adequate infrastructure for the eventual product
either — a customer cannot be told "your pipeline is running somewhere in these six steps".

**Attempt 4 differs from attempt 3 in observability ONLY.** Not inference, not commands, not matrix
scope, not environment, not protocol. Changing any of those would confound the reproduction question
with the instrumentation question.

## A hypothesis that is not a conclusion

The only structural difference from attempt 2 is the added `npm i webpack@ --legacy-peer-deps` per arm.
That makes it a suspect, **not a cause**. The same command took 7 seconds when it ran locally, and this
project has a documented run of confident explanations that were later refuted. The instrumentation
should answer it; I should not.
