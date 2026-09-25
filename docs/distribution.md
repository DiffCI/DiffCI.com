# DiffCI Distribution

DiffCI has three install surfaces with the same initial contract: observe CI, write a report, and do
not change what the host repository runs.

The product model is open core. The npm CLI and basic GitHub Action are the open-source adoption path;
DiffCI Cloud adds hosted history, organization dashboards, policies, managed operations, and support.
See [`open-core-packaging.md`](open-core-packaging.md).

## Channel strategy

Reviewed 2026-09-22. These channels have different jobs in the same adoption path:

| Channel | Role for DiffCI | Next step |
| --- | --- | --- |
| npm | Developer discovery and local evaluation of `@diffci.com/diffci` | Lead with `observe`, a sample report, and the observation-only contract. |
| GitHub Action | Repeatable CI adoption | Use the dedicated, non-blocking job below and verify the workflow before a pilot. |
| GitHub Marketplace | CI-specific discovery of the same Action | [DiffCI observer is live](https://github.com/marketplace/actions/diffci-observer); keep the installation example and release pin current. |
| MCP directories | Discovery for agents that install stdio tools | Publish matching npm and registry metadata, then submit to the official MCP Registry and Glama. |
| Tidelift | Potential package maintenance assurance and maintainer income | Pursue package acceptance using the existing submission packet; do not present support as active. |
| Commercial DiffCI | Paid hosted history, analytics, team workflows, and managed operations | Validate demand with design partners and distinguish available services from future acceleration capabilities. |

The Action is the integration; Marketplace is a discovery channel for that integration. See
[GitHub's publishing requirements](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).

Prioritize npm and Action activation, then Marketplace discovery. Keep Tidelift outreach in parallel
without making adoption dependent on acceptance or expected payments. Defer PyPI, Cargo, and Homebrew
until user demand and a maintained installation experience justify each additional surface.

Measure successful first reports, repositories with repeat observations, completed pilot reviews,
and qualified commercial interest. Downloads and listing views alone do not demonstrate adoption.
Use voluntary pilot feedback or explicitly configured hosted reporting for these measurements;
local observation does not imply permission to collect telemetry.

Suggested positioning:

> Install DiffCI through npm or GitHub Actions to inspect what your CI could avoid running while
> leaving CI execution unchanged. Explore hosted reports and shared history with the DiffCI team.

Acceleration and managed infrastructure remain product directions unless a specific capability is
available and validated. Potential savings in shadow reports are not realized customer savings.

Tidelift's published payment policy allows individuals, for-profit organizations, and nonprofits to
receive payments with a signed agreement. A nonprofit recipient is therefore not inherently required.
Payment depends on factors including subscriber usage and package importance; this does not establish
DiffCI's eligibility, acceptance, or income. See [Tidelift's payment policy](https://support.tidelift.com/hc/en-us/articles/4406294816916-How-we-pay-lifters)
and the [DiffCI submission packet](tidelift-submission.md).

## GitHub App

The unified read-only DiffCI GitHub App is the lowest-friction research and design-partner path. It receives
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
      - uses: DiffCI/DiffCI.com@82c6e024e62d854fb3094949a8009b63eeda31eb
```

The example pins release `v0.2.8` to its qualified feature commit SHA. `npx "@diffci.com/diffci@latest" verify-workflow`
checks that the job is dedicated, read-only, not required by other jobs, and unable to alter the rest
of CI.

## npm CLI

The CLI is the standalone npm package surface. The package name is `@diffci.com/diffci`:

```bash
npx "@diffci.com/diffci@latest" observe
npx "@diffci.com/diffci@latest" verify-workflow
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

That makes the open-source proposition explicit: install DiffCI, change nothing in CI, and learn
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

## Release metadata invariant

`release-manifest.json` is the source of truth for the npm, MCP, directory, workflow, Action, website,
and documentation versions. Prepare a future release with:

```bash
npm run release:sync -- 0.2.9 <qualified-40-character-action-sha>
npm run check:public-metadata
```

The sync command updates every managed surface. The metadata check runs inside `npm run check` and the
tag-release workflow, so version or immutable Action-pin drift blocks both pull requests and releases.
