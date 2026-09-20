# DiffCI Distribution

DiffCI has three install surfaces with the same initial contract: observe CI, write a report, and do
not change what the host repository runs.

The product model is open core. The npm CLI and basic GitHub Action are the open-source adoption path;
DiffCI Cloud adds hosted history, organization dashboards, policies, managed operations, and support.
See [`open-core-packaging.md`](open-core-packaging.md).

## GitHub App

The DiffCI Shadow GitHub App is the lowest-friction research and design-partner path. It receives
repository events, runs shadow analysis outside the repository's CI jobs, and reconciles predictions
against real CI outcomes. Use it when a maintainer wants observation without adding a workflow step.

## GitHub Action

The GitHub Action is the OSS dependency-graph path. A repository installs DiffCI as its own
continue-on-error job:

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
      - uses: DiffCI/DiffCI.com@v0.1.4
```

For the strongest supply-chain posture, pin the Action to a full commit SHA. `npx @diffci.com/diffci@latest verify-workflow`
checks that the job is dedicated, read-only, not required by other jobs, and unable to alter the rest
of CI.

## npm CLI

The CLI is the standalone npm package surface. The package name is `@diffci.com/diffci`:

```bash
npx @diffci.com/diffci@latest observe
npx @diffci.com/diffci@latest verify-workflow
```

`observe` writes a JSON report outside the checkout by default. It never runs, skips, cancels, or
reorders tests. A hosted endpoint is opt-in: reports are sent only when both `DIFFCI_API_URL` and
`DIFFCI_TOKEN` are set, or when equivalent CLI flags are passed.

## Report Shape

A shadow report should answer the adoption question before it asks for operational trust:

```text
DiffCI - last 30 days

CI runs observed                 423
Compute time                    18,240 min
Potentially avoidable           6,810 min
Potential reduction             37.3%

Estimated compute avoided       xxx CPU-hours
Estimated electricity           xxx kWh
Estimated CO2                   xxx kg
Estimated water                 xxx L
```

That makes the open-source proposition explicit: install DiffCI Shadow, change nothing in CI, and learn
how much compute may be wasted.

## Future Package Managers

npm plus the GitHub Action are enough to establish the pattern. Later package surfaces can wrap the
same observer contract:

```bash
pip install diffci
cargo install diffci
brew install diffci
```

Those should ship only after the npm CLI and Action have signed releases, provenance, pinned build
workflows, and repeatable package verification.

## Supported OSS Channel

Tidelift belongs to the open-source package channel. It can provide maintenance, security, license, and
supply-chain assurance for the npm package without requiring a hosted DiffCI account. It should support
the OSS core rather than define a separate feature tier. The readiness checklist lives in
[`tidelift-package-support.md`](tidelift-package-support.md).
