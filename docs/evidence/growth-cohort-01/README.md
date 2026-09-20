# First-cohort evidence catalog

2026-09-19: ten public repository snapshots screened using the published DiffCI 0.1.3 package.
**Nine OBSERVED reports; one REFUSED; no observed checkout changed.**
Four SELECTIVE verdicts include one selecting all discovered files; five require FULL validation.
No runtime savings measured, no maintainers contacted, no pilots started.

**Follow-up correction:** ky's initial selection is not credible opportunity evidence: the published
observer omitted import edges from tests outside the compiler include list. Raw reports below are
preserved as historical output. See the [fixed-sample follow-up and correction](../growth-history-01/README.md).

| Repository | Sampled commit date | Status / verdict | Selection |
| --- | --- | --- | --- |
| [unjs/h3](unjs--h3.md) | 2026-09-17 | OBSERVED / SELECTIVE | 59 / 71 discovered test files |
| [unjs/ofetch](unjs--ofetch.md) | 2026-07-08 | OBSERVED / SELECTIVE | 1 / 1 discovered test files |
| [unjs/unenv](unjs--unenv.md) | 2025-11-24 | OBSERVED / FULL | Full validation required (6 discovered files) |
| [unjs/consola](unjs--consola.md) | 2026-03-01 | OBSERVED / FULL | Full validation required (1 discovered files) |
| [unjs/ufo](unjs--ufo.md) | 2026-04-29 | OBSERVED / FULL | Full validation required (13 discovered files) |
| [sindresorhus/ky](sindresorhus--ky.md) | 2026-09-14 | OBSERVED / SELECTIVE | 3 / 30 discovered test files |
| [ai/nanoid](ai--nanoid.md) | 2026-09-16 | REFUSED / — | Not available |
| [colinhacks/zod](colinhacks--zod.md) | 2026-09-13 | OBSERVED / FULL | Full validation required (202 discovered files) |
| [developit/mitt](developit--mitt.md) | 2023-07-04 | OBSERVED / FULL | Full validation required (2 discovered files) |
| [immerjs/immer](immerjs--immer.md) | 2026-08-19 | OBSERVED / SELECTIVE | 1 / 23 discovered test files |

## Method and limitations

The candidate list was fixed before running the analyses. Each clone used depth 2 and compared its
default-branch HEAD with its first parent, without filtering for favorable results. Several tips
are old, so this is not an active-pilot cohort. Dates above are commit dates, not analysis dates.
No dependencies of target repositories were installed; no target tests were executed. Static
selection is not verified safe execution or measured savings. FULL empty selections mean full
validation, never zero work. The manifest records exact revisions, sample timestamps, and timings.
Immer initially failed to clone with a connection reset, then succeeded on one retry.

## Installation verification

DiffCI was installed outside every observed checkout using:

```sh
npm install --prefix <temporary-runtime> --ignore-scripts --no-audit --no-fund @diffci.com/diffci@0.1.3
```

The installed CLI produced the linked reports with explicit base/head revisions and --no-send.
All ten reports have schema diffci.observation.v1. Independent git-status checks matched before
and after each observation. This verifies local install-to-report behavior including refusal;
it does not verify a fresh external Actions run, artifact download, hosted ingestion, or uninstall.

The README workflow was checked with the installed CLI: [verification output](workflow-verification.txt).
The previous documented @v1 ref returned 404. The replacement SHA is the commit behind v0.1.3:
[GitHub tag reference](https://api.github.com/repos/DiffCI/DiffCI.com/git/ref/tags/v0.1.3).

[Next decisions and pilot criteria](../../growth/first-cohort-plan.md).
