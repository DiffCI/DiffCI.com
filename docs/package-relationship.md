# DiffCI packages and repositories

## Choose an entry point

| If you want to... | Start here |
| --- | --- |
| See what tests DiffCI would select in an existing checkout | `npx @diffci.com/diffci@latest observe --no-send` |
| Observe pull requests without changing required CI jobs | The dedicated GitHub Action job in [the README](../README.md#observe-in-github-actions) |
| Measure a full and selected test command locally | The opt-in [`pilot` or `verify-savings` workflow](npm-adoption.md#self-serve-runtime-pilot) |
| Use engine APIs or inspect the extracted implementation | [DiffCI/core](https://github.com/DiffCI/core), cloned and built locally |

`@diffci.com/diffci` is the published CLI from this repository. Its npm package includes the
client, Git, repository-analysis, and planner code selected by this repository's package boundary.
The GitHub Action in this repository wraps that observer. `@diffci.com/core` names the separate
standalone Core source package. It is being prepared for npm publication and is not published yet.
Core is public AGPL source with a library entry point and a local planning CLI.

The currently published npm CLI still uses its bundled engine. This migration branch imports its
observer engine from a pinned Core Git commit while the `@diffci.com/core` npm release is prepared.
The Core package does not include this repository's hosted services, research infrastructure, or
product control plane. Until the new CLI release is published, a download of
`@diffci.com/diffci` is not a download of `@diffci.com/core`.

## Path to one engine

The Core repository now carries the observer's current Git, graph, impact, baseline, command-planning,
Vue, and Go modules. The CLI imports those modules through Core's package exports. Its existing
observer report and non-interference behavior remain in this repository. The next release steps are
to publish `@diffci.com/core`, replace the temporary Git dependency with an npm version, pass the
script-disabled package smoke test, and release `@diffci.com/diffci`. After that, remove redundant
engine copies from this repository once remaining internal callers have migrated.
