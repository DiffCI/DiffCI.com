# Shadow pilot runbook

Everything needed to operate the external shadow pilot without reconstructing it from source. Written for
someone who did not build it.

## What the shadow pilot does

For each enrolled repository, DiffCI watches the default branch, and when the head moves it analyses that
commit to work out which tests it *would* have selected. It never changes the repository's CI — nothing is
skipped, cancelled, or modified. Afterwards it reads the real GitHub Actions timings and reports how much
compute could *potentially* have been avoided.

Everything it produces is **potential opportunity**, never realized savings. See
`src/usage/economics-estimator.ts` for why that distinction is enforced in the schema rather than in
wording.

## Prerequisites

```bash
export RESEARCH_DISPATCH_TOKEN="$(cat .research/dispatch-token)"   # Worker admin token
export GITHUB_TOKEN="<a PAT>"                                       # optional, but 60 req/hour without it
```

`.research/` is gitignored and holds local operator tokens. `RESEARCH_DISPATCH_TOKEN` must match the
Worker secret of the same name.

## Daily operation

```bash
npm run shadow:status
```

Shows launch budget used against the ceiling, per-repository liveness, capture coverage, and economics.
This is the one command to run if you only run one.

## Enrolling a repository

**Always screen first.** A repository DiffCI cannot analyse still costs a container on every sweep, which
is how `vitest-dev/vitest` burned launches before anyone noticed.

```bash
npm run shadow:screen -- vitejs/vite withastro/astro
```

`ELIGIBLE` requires a `tsconfig.json` at the repository root, active GitHub Actions, and recent commits.
A repository that is eligible but **dormant** is reported as such — it will never produce evidence, which
is a different problem from being unanalysable.

Enroll only what passes:

```bash
npx wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc \
  --command "INSERT OR IGNORE INTO shadow_repositories (repository, state, observation_source, enrolled_at, language) VALUES ('owner/name', 'SHADOW_ACTIVE', 'cloudflare-poll', strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'typescript')"
```

Record an ineligible repository with `state='UNSUPPORTED'` and a reason rather than skipping it silently —
the coverage gap should stay visible in the cohort.

## Generating a report

```bash
npm run shadow:report -- --repository unjs/h3 --days 7 --out report.txt
```

Every number traces to a `shadow_economics_observations` row. The report leads with observation coverage,
declines to recommend anything below the evidence threshold, and never says "saved".

## Deploying a change

```bash
npm run shadow:deploy -- --url https://diffci-research-sandbox.damp-waterfall-0cd8.workers.dev --label "what changed"
```

Refuses a dirty working tree, runs typecheck and tests, stamps `EXPECTED_SOURCE_SHA`, uploads the source
archive, and verifies `sourceIntegrity=CURRENT`. A deploy that cannot prove the invariant fails.

```bash
npm run shadow:freshness      # is the deployed analyzer still equal to main?
```

## Two states people confuse

| | Means | Does it stop observation? |
|---|---|---|
| `sourceIntegrity != CURRENT` | The running analyzer does not match its own uploaded archive | **Yes** — analysis fail-closes deliberately |
| `freshness = STALE_DEPLOYMENT` | The deployed SHA is behind `main` | **No** — ordinary lag |

A commit to `main` does **not** pause observation. Only a mismatch between the deployed Worker and its
archive does.

## Repository liveness states

| State | Meaning |
|---|---|
| `LIVE` | Observing, upstream has unanalysed commits |
| `IDLE_UPSTREAM` | Observing normally; the repository has no new commits. **Not** an outage |
| `DEGRADED` | Checks run, analysis keeps failing |
| `PAUSED_SOURCE_INTEGRITY` | Deliberately fail-closed |
| `STALE` | No polling where polling was expected — the real outage case |

`IDLE_UPSTREAM` exists because a healthy poller against a quiet repository and a dead poller produce
identical symptoms. That ambiguity caused a real misdiagnosis; do not collapse the two.

## Cost controls

- **60 analysis launches per UTC day** (`maxPollsPerDay`), reserved atomically immediately before each
  container starts. Every launch spends a slot regardless of outcome — success, clone-exclusion, timeout,
  or crash. Work refused before a launch spends nothing.
- **3 launches per sweep** (`maxPollsPerRun`).
- **Auto-pause after 5 consecutive failed polls**, with the reason recorded. Resets on any success.

Head checks are never suppressed by the ceiling. After the budget is spent DiffCI keeps observing heads
and records what it could not analyse, so a spent ceiling never makes a repository look idle.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No predictions for days | Check `shadow:status` — probably `IDLE_UPSTREAM`, i.e. the repository is quiet |
| Repository suddenly `PAUSED` | Auto-refusal after 5 consecutive failures; read `notes` for the reason |
| `clone-excluded` errors | Monorepo without a root `tsconfig.json` — a known engine gap, not a bug |
| Report says "insufficient data" | Correct behaviour; below the evidence threshold it will not recommend |
| Launch budget exhausted | Expected under load; observation continues, analysis resumes next UTC day |

## Known limitations

- **Monorepos without a root `tsconfig.json` cannot be analysed.** Screened for and refused, not fixed.
- **The estimator is linear-cost.** It assumes uniform per-test cost and models no fixed per-invocation
  overhead, so it overstates avoidable compute at small selection ratios. Never invoice from it.
- **Only the `test` stage is classified.** Build, lint, typecheck and e2e are reported `UNKNOWN`.
- **Intermediate commits are not individually analysed.** When several land between sweeps only the newest
  is analysed; `npm run shadow:missed-commits` measures the gap after the fact.
