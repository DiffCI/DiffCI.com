# DiffCI packages and repositories

## Choose an entry point

| If you want to... | Start here |
| --- | --- |
| See what tests DiffCI would select in an existing checkout | `npx "@diffci.com/diffci@latest" observe --no-send` |
| Observe pull requests without changing required CI jobs | The dedicated GitHub Action job in [the README](../README.md#observe-in-github-actions) |
| Measure a full and selected test command locally | The opt-in [`pilot` or `verify-savings` workflow](npm-adoption.md#self-serve-runtime-pilot) |
| Study or improve the engine | [DiffCI/core](https://github.com/DiffCI/core) on GitHub |

`@diffci.com/diffci` is the only npm package users need. The CLI keeps the pilot-facing `npx`
commands and the GitHub Action wraps its observer. The npm tarball bundles a pinned GitHub revision
of DiffCI/core, so installing or running the CLI does not fetch Core separately from npm or GitHub.

Core provides Git analysis, dependency graphs, impact analysis, path baselines, and selected-command
planning. The CLI imports these modules from Core. The report format, pilot workflow, and GitHub
Action remain here. The Core repository is public AGPL source for the engine; its standalone npm
package is no longer part of the supported installation path.
