# AMENDMENT 5 to CI_REPRODUCTION_SAMPLE_01 — no shell, rather than no command

**Written after reading babel-loader's workflow and before any inference has been run against it.**

## The situation

babel-loader's in-environment cell contains:

```yaml
- name: Downgrade to Babel 7
  if: matrix.babel-version == '7'
  run: yarn up @babel/*@^7
```

For this cell `matrix.babel-version == '7'` is **TRUE**, so the step runs. The argument
`@babel/*@^7` contains `*` and `^`, both in `SHELL_METACHARACTERS`, so `assertShellSafeArgs` throws and
the run aborts before producing any verdict.

That is a **harness limitation, not a property of the repository**. `yarn up @babel/*@^7` is a single
well-formed command. The glob is not shell syntax here at all — bash finds no matching file, passes the
string through untouched, and **yarn** interprets it. It is exactly the kind of literal argument that
argv exists to carry.

## The rule

The invariant is unchanged and remains absolute:

> **Repository-derived strings must never cross an implicit shell boundary.**

The harness has been satisfying it by *refusing metacharacters while still spawning through a shell*.
There is a stricter way to satisfy it:

| argv | spawn |
|---|---|
| free of shell metacharacters | `shell: true` — unchanged, as members 1–4 ran |
| contains a metacharacter | **`shell: false`** — no shell is involved, so nothing can be re-parsed |

Passing `@babel/*@^7` as an argv element with **no shell** honours the invariant *more* strictly than
rejecting it did, because no shell ever sees the string. Loosening `SHELL_METACHARACTERS` would have been
the wrong fix and is not what this does — the character set is untouched.

The receipt records `spawnedWithoutShell: true` on any step taking this path, so the execution mode is
visible rather than inferred.

## Why this does not contaminate members 1–4

The no-shell path applies **only** when argv contains a metacharacter. Every step in members 1–4 was
metacharacter-free and therefore took the `shell: true` path — the identical code path they already ran.
Their receipts cannot change. This is verified rather than assumed: their recorded commands are all
plain tokens.

## Why not simply fail babel-loader

Recording a qualification failure would assert *babel-loader's pipeline cannot be reproduced*, when the
truth is *my harness spawned through a shell it did not need*. That is the same category error as
attempt 4's `REPRODUCED` and member 4's original `R3_QUALIFIED`: a label that reads as a finding about
the subject while actually describing the instrument.

babel-loader is also the last member and the only remaining candidate for a clean `REPRODUCED`. Failing
it for a harness reason would leave the sample with **no member that ever tested the question**, which
is a worse outcome than fixing the instrument.

## Scope

Harness only. The engine is untouched and the agent digest stays `sha512-eQGRE3ep…`. Amendment 3's rule
for genuinely compound `run:` lines — pipes, `&&`, `;`, redirects, substitution — is unchanged: those
remain untranscribable, because they change what is computed rather than merely how one argument is
spelled.
