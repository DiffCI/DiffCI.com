# Apparatus qualification — analyser generation C

**PASSED**, run `apparatus-qualify-genc-01`, 2026-08-31. This is the frozen identity of the apparatus
permitted to generate new product evidence.

`89fc236` remains frozen and untouched: it is evidence about **generation B**. Generation C did not
inherit that verdict — it earned its own.

## Apparatus identity

| | |
|---|---|
| DiffCI commit | `0beb661` (defect 17 + defect 18 fixed) |
| source tarball | `sources/diffci-3ed8fc1e0800336d.tgz` — sha256 `3ed8fc1e…c8` |
| **agent digest (generation C)** | `sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==` |
| generation B, for contrast | `sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==` |
| container image | `docker.io/cloudflare/sandbox:0.12.5` |
| node / npm / git | `v22.23.2` / `10.9.8` / `2.34.1` |
| OS | Ubuntu 22.04.5 LTS, Linux 6.18.36 firecracker |
| qualifier version | `2.0.0` |
| target | `kulshekhar/ts-jest` @ `b1a97ac485711377e01e72bac8b115e41a1c17ba` |

The agent digest reproduced **identically across two independent rebuilds** before the run.

## The chain, in the order it was proved

```
clean pinned analyser -> canonical environment -> universe sanity -> install -> 2 green baselines
```

Universe sanity runs FIRST. There is no point measuring how reliably a suite goes green if DiffCI models
the wrong set of executable tests — which is exactly what generation B did, invisibly, for the whole of
MECHANISM_PROOF_01.

### Universe sanity — 4 of 4 PASS

Discovered patterns: `["src/**/*.spec.ts"]`

| check | result |
|---|---|
| universe resolves to exactly **20** executable tests | PASS — found 20 |
| no `e2e/`, `examples/`, `presets/`, `scripts/`, `website/` path enters it | PASS — none |
| repeated discovery yields **identical paths**, not merely the same count | PASS — identical |
| a half-understood config **fails wide** rather than narrowing | PASS — kept the wide universe |

It exits non-zero on any mismatch and the harness fails the run on a non-zero exit, so a discrepancy
fails the RUN rather than being recorded as a finding. An apparatus defect must never become an
experimental result.

### Suite qualification — MUTATION-QUALIFIED (394s)

```
install      18.9s
baseline 1   exit=0  parsedFailures=0  cpu=314.71s  wall=189632ms
baseline 2   exit=0  parsedFailures=0  cpu=304.16s  wall=185393ms
             Test Suites: 20 passed, 20 total
             Tests:       358 passed, 358 total
             Snapshots:   137 passed, 137 total
```

## M2 independently confirmed by the runner itself

**jest printed `Test Suites: 20 passed, 20 total`.**

M2 was closed by static reasoning — reading `jest.config.ts` and enumerating what its `testMatch`
matches. This is the runner's own count, from direct execution, and it agrees: **20**. Generation C's
modelled universe is 20. The analyser and the runner now state the same number, confirmed by execution
rather than by my inference.

Generation B modelled 40.

## A caution this run also produced

The same suite on the same tree measured **314.71 and 304.16 CPU-s** here, against **260.22** recorded
at generation-B qualification and 269–320 across the MECHANISM_PROOF_01 full arms.

The analyser cannot affect this — the suite executes jest, not DiffCI — so this is host and load
variance, roughly ±20% across runs. It is recorded because it bounds what cross-run CPU comparison is
worth: **only WITHIN-run arm comparison is sound**, which is how the economics were already measured.
A savings figure derived by comparing CPU from two different runs would be inside the noise.

## What this permits, and what it does not

**Permits:** generation C may generate new product evidence.

**Does not establish** anything about DiffCI's selection quality, safety or economics. This is apparatus
fitness — that the instrument reads correctly — not a result. The next independent draw is what tests
the Candidate-5 thesis, and it has not been made.
