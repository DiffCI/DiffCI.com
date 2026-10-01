# GitHub Actions observation job

Add DiffCI as a separate, non-blocking job. The Action analyzes the commit range and uploads an observation artifact; it does not execute or skip your existing tests.

```yaml
name: DiffCI observation
on: [push, pull_request]
permissions:
  contents: read
jobs:
  diffci:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: DiffCI/DiffCI.com@e1d7bab271c5d83899bda0034d70d3e34c10c1f7
```

This example pins the Action at the verified `v0.2.11` feature commit. Verify the installed workflow locally:

```sh
npx "@diffci.com/diffci@latest" verify-workflow
```

Keep the DiffCI job out of required checks and other jobs' `needs` lists. The Action uploads the `diffci-observation` artifact by default. Sending a report to DiffCI's hosted service requires an explicitly configured endpoint and token. See the [distribution guide](../distribution.md) for the installation contract.
