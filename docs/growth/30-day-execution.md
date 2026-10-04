# DiffCI growth execution: 2–31 October 2026

Send open-source campaigns to https://github.com/DiffCI/core. Keep CLI/package metadata pointing at its actual source repository. Downloads are installations, not unique people; the pasted 2,736/week figure is historical and must be refreshed before publishing.

| Window | Work | Completion evidence |
| --- | --- | --- |
| 2–8 October | Short README opening, Core links, useful-result CLI prompt, contribution setup | Passing checks; Core PR reviewed; website/package changes released |
| 9–15 October | Recruit five assisted pilots; publish up to two completed studies | Maintainer consent, revision pairs and raw repeated-run reports |
| 16–22 October | Run “Test DiffCI on your repository”; triage ten bounded issues | Reproducible submissions, contributor PRs, documented fallbacks |
| 23–31 October | Publish benchmark roundup; prepare Show HN | All attempted pilots included, limitations reviewed, launch text approved |

Track weekly: Core stars, release/discussion subscribers where available, forks with actual contributions, opted-in pilots, completed measurements, merged external PRs, and repositories retaining the Action or dependency after 30 days. Do not infer npm-to-star attribution without consented evidence. Initial aspirations are 100–250 genuine stars, ten pilots, five external contributors, and ten retained installations; they are not forecasts.

## Pilot invitation draft

We're testing DiffCI, an open-source test-impact analysis engine. Would you like help measuring it on a public repository? Run `npx "@diffci.com/diffci@latest" check` from a checkout with Node.js 22.5+ and Git. It runs full and selected tests when safe to compare and sends nothing by default. Keep required CI in place. Share only reports you are comfortable making public; we will agree on revision pairs, cache preparation and limitations before publishing. Engine: https://github.com/DiffCI/core. Volunteer: https://diffci.com/#pilot.

## First evidence story draft

DiffCI measured 44.2% net job-equivalent runtime reduction in one controlled Cal.com sandbox replay. Full install + pretest + test took 657.7s; selected took 356.9s plus about 10.1s of analysis. Fixed install/pretest costs are included. This is not Cal.com's production savings or a forecast for your repository. Method: https://diffci.com/case-studies/calcom. Try your own revision pair with `npx "@diffci.com/diffci@latest" check`; repeated runs with controlled cache preparation are needed for stronger evidence. Star the engine or volunteer a pilot: https://github.com/DiffCI/core.

The recorded evidence graphic is `site/assets/calcom-runtime-evidence.svg`. It is a visualization of recorded timings, not a screenshot of a live CLI run.

## Case-study submission template

Repository and maintainer publication consent; base/head SHAs; engine and CLI versions; full and selected commands; test file counts; runner and dependency identities; analysis overhead; cache preparation; alternating order and at least three repetitions; raw reports; failure assessment; full fallback/refusal cases; limitations; retained installation status. Publish before/after measured runtime only when commands pass and provenance is valid. State whether the measurement is preliminary or controlled. Avoid “zero safety cases” claims unless the validation protocol supports them.

## Show HN draft

Title: Show HN: DiffCI – open-source test-impact analysis with measured CI comparisons

DiffCI follows code changes through dependency graphs, proposes affected tests, and compares their runtime with the full command when evidence supports execution. Uncertainty broadens to full validation. Try `npx "@diffci.com/diffci@latest" check` with Node.js 22.5+ and Git. One Cal.com sandbox comparison measured 44.2% net job-equivalent reduction including analysis overhead; we publish the method and limitations, and do not claim production savings. We're looking for maintainers willing to run reproducible pilots and contributors who can add small regression fixtures. https://github.com/DiffCI/core

Before posting, refresh the benchmark links, include all attempted pilots in the roundup, and confirm the CLI changes are released. Adapt technical detail to each community and its current rules. Publish to HN, Dev.to/Hashnode, LinkedIn/X, or relevant subreddits only when it fits the discussion. Contact participating-project maintainers before posting in their Discussions. No unsolicited bulk comments or fabricated pilots.

## Monthly benchmark outline

List all attempted repositories and revision pairs, completed comparisons, refusals, invalid provenance, command failures, regressions, and full fallbacks. Separate test-file selection from measured runtime. Include cache protocol, net analysis overhead, timing ranges and links to raw artifacts. End with supported-framework changes, next reproducible questions, and a Core star/pilot CTA.
