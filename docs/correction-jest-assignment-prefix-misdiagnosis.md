# CORRECTION — the assignment-prefix gap was never jest's wrong-job cause

`docs/evidence/regression-02/results.md` (commit `f818354`) claimed `nodejs.yml#test-runtime-vm-modules`
never receives `TEST` purpose because its real command, traced through jest's own `package.json` script
chain, bottoms out in `NODE_OPTIONS="..." yarn jest packages/jest-runtime` — a `KEY=value`-prefixed
package-manager invocation neither `executableChain` nor `packageManagerCommand` handled. That diagnosis
is **wrong**, and the fix built on top of it (`normalizeExecutable`, this session, before this file) does
not do what it was believed to do.

## What actually happens

Read the real workflow this time instead of only the reference plan's transcription. The step is not a
`run:` line at all:

```yaml
- name: run jest-runtime tests with --experimental-vm-modules
  uses: nick-fields/retry@ad984534de44a9489a53aefd81eb77f87c70dc60
  with:
    timeout_minutes: 10
    max_attempts: 3
    retry_on: error
    command: yarn jest-runtime-vm-modules-ci --max-workers ${{ steps.cpu-cores.outputs.count }}
```

`nick-fields/retry` is a third-party composite action; the actual test command is its `command:` INPUT,
not a `run:` step. `infer.ts` only turns `workflow.step.run` facts into operations — a command living
inside a `with:` block for an unmodelled action is never seen by `purposeOfLine` at all, so no amount of
fixing that function could have changed this job's purpose. `nick-fields/retry` correctly becomes a
declared prerequisite instead ("this step uses nick-fields/retry@..., which this engine does not model,
so what it contributes is unknown") — confirmed locally: `job.prerequisites` for this exact job lists it.
This is not a new finding — `infer.ts`'s own `declaredPrerequisites` docstring already names this exact
case: "jest's test command is an input to `nick-fields/retry`."

The `NODE_OPTIONS="..." yarn jest packages/jest-runtime` chain I traced through
`jest-runtime-vm-modules-ci` → `jest-runtime-vm-modules` → the `jest` script is real — that text genuinely
exists in jest's `package.json` — but it is the *reference arm's* hand-transcription reading through the
action wrapper to what the action would eventually run, not something DiffCI's inference ever receives as
a `run:` line for this job. Confirmed empirically: `grep -rnE "run: *[A-Za-z_][A-Za-z0-9_]*="` across all
four cloned repositories' `.github/workflows/` finds **zero** matches. The pattern
`normalizeExecutable` was built to fix does not occur anywhere in any of the five REGRESSION_01/02
targets' actual workflow files.

## What survives this correction

`normalizeExecutable` itself is not wrong, and is not reverted. Re-verified after this correction:

- `packageManagerCommand` still takes normalised tokens, never a raw line, and `executableChain` and it
  now provably agree on the same input, closing the exact architectural gap requested (the earlier commit
  message's own framing of *why* to build it, "leading shell environment assignments modify the execution
  environment, they do not determine the executable identity," is a correct, defensible invariant on its
  own terms, independent of whether jest exercises it).
- Full suite green (1885/1885), `tsc --noEmit` clean, and the synthetic three-level test replaying jest's
  real script bodies (`tests/ci-inference/purpose.test.ts`, "jest's real three-level script chain resolves
  to TEST through an assignment prefix") is a true statement about what `purposeOfLine` does with that
  exact text *if it ever reaches it as a `run:` line* — genuinely useful for the next repository that
  writes CI this way, e.g. `KEY=value` prefixes are common outside jest too.

What does **not** survive: the claim that this fix explains, causes, or fixes anything about jest's
`PARTIAL_REPRODUCTION` result in `REGRESSION_01`/`REGRESSION_02`. It does not. `test-runtime-vm-modules`
still shows `provides: ["BUILD", "INSTALL"]` after the fix — reconfirmed directly, not assumed — and
`test-leak` still wins by being the only real `TEST`-providing candidate. Jest's wrong-job problem is
**unaddressed** and requires a different repair: either modelling `nick-fields/retry`'s `command:` input
(a real capability gap, not a defect — the engine correctly declines rather than guessing) or accepting
that this specific job is out of reach without that capability.

## Why this happened

I diagnosed from the reference plan's transcribed steps and jest's `package.json`, and never opened the
actual workflow YAML for the job before writing `regression-02/results.md`. The reference arm's
transcription is written by reading the repository closely enough to know what a retry-wrapped action
*eventually runs* — that is its job. Reading only the transcription and reasoning backward to "therefore
this must be what the workflow's `run:` step says" skipped the one check that would have caught this:
opening the workflow file itself, the same discipline `REGRESSION_01`'s adjudication used correctly for
every other repository in this thread. This correction exists because that check, done now instead of
before, changes the conclusion.
