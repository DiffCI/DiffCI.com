# DiffCI packages and repositories

## Choose an entry point

| If you want to... | Start here |
| --- | --- |
| See what tests DiffCI would select in an existing checkout | `npx @diffci.com/diffci@latest observe --no-send` |
| Observe pull requests without changing required CI jobs | The dedicated GitHub Action job in [the README](../README.md#observe-in-github-actions) |
| Measure a full and selected test command locally | The opt-in [`pilot` or `verify-savings` workflow](npm-adoption.md#self-serve-runtime-pilot) |
| Use engine APIs or inspect the extracted implementation | [DiffCI/core](https://github.com/DiffCI/core), cloned and built locally |

`@diffci.com/diffci` is the published CLI from this repository. It retains the pilot-facing `npx`
commands and installs `@diffci.com/core` as its observer engine dependency.
The GitHub Action in this repository wraps that observer. `@diffci.com/core` is the published
standalone Core engine package.
Core is public AGPL source with a library entry point and a local planning CLI.

The CLI observer imports its engine from the published `@diffci.com/core` package.
The Core package does not include this repository's hosted services, research infrastructure, or
product control plane. Installing the CLI installs Core as a dependency.

## Path to one engine

The Core repository carries the observer's Git, graph, impact, baseline, command-planning, Vue, and
Go modules. The CLI imports those modules through Core's package exports. Its observer report and
non-interference behavior remain in this repository. The script-disabled package smoke test verifies
installation from npm. Remaining internal callers still use local engine copies and should be
migrated before those copies are removed.
