# Promoting the DiffCI npm Package

DiffCI's npm package should be promoted as a low-risk CI observer:

> DiffCI observes your CI and reports which tests it would have selected, without skipping, cancelling,
> or changing any job.

## Install

For a pinned project dependency, run the initializer from the repository root. It detects npm, pnpm,
Yarn, or Bun, adds the current DiffCI version as an exact development dependency, and updates the
corresponding lockfile:

```bash
npx "@diffci.com/diffci@latest" init --install
```

Add `--workflow` to also create the separate, non-blocking GitHub Actions observation job. Installation
is explicit: plain `init` never changes `package.json` or a lockfile.

Use the npm CLI when someone wants to try DiffCI locally or inside an existing CI step:

```bash
npx "@diffci.com/diffci@latest" observe
npx "@diffci.com/diffci@latest" verify-workflow
```

Use the GitHub Action when someone wants the normal non-blocking CI installation:

```yaml
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: DiffCI/DiffCI.com@82c6e024e62d854fb3094949a8009b63eeda31eb
```

## Outreach Copy

Short version:

> I built DiffCI as an observation-only CI dependency. It looks at a PR diff and reports which tests it
> would have selected, but it never skips, cancels, or changes CI. You can run it with
> `npx "@diffci.com/diffci@latest" observe` or as a non-blocking GitHub Action. I am looking for OSS
> repos willing to run it in shadow mode for a week.

Issue/PR version:

> Would you be open to running DiffCI in shadow mode for a week? It adds one non-blocking job that
> observes each PR/push and writes a report artifact. It does not alter required checks, skip tests,
> cancel jobs, or send data anywhere unless you explicitly configure an endpoint/token.

## Pilot Ask

Ask maintainers for a small, reversible experiment:

- Run one non-blocking DiffCI job for seven days.
- Keep all existing CI behavior unchanged.
- Share the report artifacts or a summary of whether DiffCI found avoidable test work.
- Remove the job at any time if it is noisy, slow, or unhelpful.

## Self-Serve Runtime Pilot

Use this when a maintainer asks whether selecting fewer tests would actually make their CI faster.
This is a paired local measurement, not a production-savings claim.

For one command that infers the full test command and prints the measured percentage when both runs
pass, use `npx "@diffci.com/diffci@latest" check` from the repository root. For Maven, `check` reads
the goal and profiles from `diffci.json` when present; otherwise it uses `mvn test` and says that
the default may differ from CI. Run it on the intended CI runner: timings from another machine are
not CI savings. A full-validation fallback runs the full command once and reports 0% reduction.

Step 1: create an observation report without sending it anywhere.

```bash
npx "@diffci.com/diffci@latest" observe --no-send --out ../diffci-output/diffci-observation.json
```

Step 2: run the paired pilot.

```bash
npx "@diffci.com/diffci@latest" verify-savings \
  --label owner/repo \
  --repo /path/to/their/repo \
  --full "npm test" \
  --selected-from-report ../diffci-output/diffci-observation.json \
  --out ../diffci-output/diffci-verify-savings.json \
  --markdown ../diffci-output/diffci-verify-savings.md
```

What the report means:

Run both steps from the same repository root with the same checked-out revision. These commands
execute repository code. The full run can warm caches for the selected run, so repeat comparisons
with controlled cache state before drawing conclusions. A passing pair does not establish selection safety.

- Full runtime is measured from `--full`.
- Selected runtime is measured from DiffCI's proposed command in the observation report.
- DiffCI analysis overhead is imported from `timings.totalMs` in the observation report unless
  `--analysis-overhead-ms` is provided.
- Net selected runtime is selected runtime plus analysis overhead.
- If the full command fails while the selected command passes, the report is a safety warning, not a
  savings result.
- The savings report binds the pair to the observation's base/head SHAs and SHA-256 digest, and records
  the checked-out HEAD plus a worktree-status digest before, between, and after the two commands. A
  missing identity, SHA mismatch, or worktree change invalidates the comparison even when both commands
  pass.

Before sharing a Markdown report with a maintainer, check that it answers these review questions:

- Which exact repository, base SHA, head SHA, DiffCI version, full command, and selected command were
  measured?
- Did the selected command cover the complete DiffCI selection, or was an explicit command override
  required?
- Were cache conditions controlled or repeated, and if not, is the report labelled as one preliminary
  paired run?
- Did both commands pass, did checkout provenance stay stable, and are invalid runs clearly labelled
  diagnostic only?
- What should the maintainer do next: inspect a fallback/refusal, repeat with controlled cache state,
  run a seven-day observation job, or ignore the result because the repository is unsupported?

If the proposed command needs adjustment for the repository's runner, pass the selected command
manually:

```bash
npx "@diffci.com/diffci@latest" verify-savings \
  --label owner/repo \
  --repo /path/to/their/repo \
  --full "pnpm test" \
  --selected "pnpm test packages/a/src/a.test.ts packages/b/src/b.test.ts" \
  --analysis-overhead-ms 1200 \
  --out ./diffci-verify-savings.json \
  --markdown ./diffci-verify-savings.md
```

Common command shapes:

```bash
--full "npm test"
--full "pnpm test"
--full "yarn test"
--selected "npx vitest run path/to/file.test.ts"
--selected "npx jest path/to/file.test.ts"
--selected "node --test path/to/file.test.mjs"
```

## Trust Points

- Published as `@diffci.com/diffci` on npm.
- Stable `latest` release is signed with npm provenance.
- The package boundary is checked by `npm run check:oss-boundary`.
- The default observer writes a local report and sends nothing without both `DIFFCI_API_URL` and
  `DIFFCI_TOKEN`.
