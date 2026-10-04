# GitHub Actions observation job

Add DiffCI as a separate, non-blocking job. The Action analyzes the commit range and uploads an observation artifact; it does not execute or skip your existing tests.

```yaml
name: DiffCI observation
on: [push, pull_request]
permissions:
  contents: read
jobs:
  diffci:
    runs-on: ubuntu-24.04
    continue-on-error: true
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # immutable checkout pin
        with:
          fetch-depth: 0
      - uses: DiffCI/DiffCI.com@9b21094e99f8e0860c9d66f7b28dd3ac7def75c4
```

This example pins the Action at the verified `v0.3.3` feature commit. Verify the installed workflow locally:

```sh
npx "@diffci.com/diffci@latest" verify-workflow
```

Keep the DiffCI job out of required checks and other jobs' `needs` lists. The Action uploads the `diffci-observation` artifact by default. Sending a report to DiffCI's hosted service requires an explicitly configured endpoint and token. See the [distribution guide](../distribution.md) for the installation contract.
