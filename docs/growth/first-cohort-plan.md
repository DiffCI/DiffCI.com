# First external cohort

Started 2026-09-19. This is a working experiment, not a launch or a claim of customer adoption.

## Decision targets

1. Ten maintainer-useful reports: reproducible revisions, supported scope, limitations, and an actionable next step.
2. Three external maintainers complete a clean install-to-report cycle and seven calendar days of observation.
3. Record repeat usage and whether a maintainer wants continuing observation before expanding to 50 repositories.

These are targets, not achieved counts or conversion forecasts. Ten initial one-commit diagnostics are
recorded in [the evidence catalog](../evidence/growth-cohort-01/README.md). They are technical screening,
not ten validated opportunities, historical PR studies, or completed pilots. No maintainers were contacted.

## Initial findings and next decisions

- The documented `DiffCI/DiffCI.com@v1` reference did not resolve on GitHub. Current installation examples
  now pin the verified `v0.1.4` commit. Do not advertise a Marketplace listing until its actual page is verified.
- The [20-change studies of h3 and ky](../evidence/growth-history-01/README.md) are now available, with
  published-package results preserved separately from the then-unreleased correction. Both have recent CI
  activity. Ky's initial smaller selection was affected by missing test-import edges and is withdrawn
  as opportunity evidence. [Release 0.1.4 is now qualified](../evidence/release-0.1.4/README.md), including
  a fresh public npm install and a separate DiffCI-owned Action fixture. Real maintainer pilots and
  hosted-ingestion qualification remain open.
- Treat Immer's smaller selection as a test-only snapshot, not evidence of source-change reachability.
- ofetch selected its entire discovered test universe. There is no demonstrated opportunity in that snapshot.
- unenv, consola, ufo, Zod, and mitt require full validation for their sampled configuration changes.
  Do not turn their empty `selectedTests` arrays into a claim of zero required tests.
- Nano ID was refused by the project detector. Preserve that result instead of claiming broad JavaScript coverage.
- Several candidates' default-branch tips are old. Replace inactive candidates for prospective pilots;
  keep their screening outcomes in the denominator.

## Next historical study

### September 20 coordination update

The onboarding and growth evidence are committed. npm now publishes 0.1.6, adding the one-command
`pilot` flow after 0.1.5 introduced `verify-savings`. Both execute repository commands; observation
mode remains separate. The next milestone is qualified external runtime evidence, not another CLI wrapper.

Review of the timing path found that 0.1.6 accepted only the first proposed command, omitting remaining
commands in multi-command plans. The 0.1.7 release candidate refuses such reports before executing either
arm; an explicit complete selected command is required for these plans. Failed runs are labelled invalid
in the summary and Markdown.

Before preparing maintainer reports, qualify command coverage on frozen source-changing revisions,
execute in isolation, and collect repeated full/selected timings with cache conditions documented.
Do not count a one-pair self-serve result as production savings or as an independent maintainer pilot.

Freeze the latest 20 first-parent default-branch changes available at the start of each study, including
documentation and configuration changes. Record all outcomes and the number of source-changing deltas.
Do not describe commit deltas as PRs without mapping them to actual PRs. Check the existing workflow's
selection, cache, and setup behavior before calling anything an incremental opportunity.

For representative source changes with smaller selections, validate graph reachability and command
routing before controlled execution. Report full and selected execution times, analysis overhead,
setup cost, runner configuration, selection actually executed, and measurable regression checks.
Keep unknown runtime savings unknown. Do not execute arbitrary third-party code on the operator host.

## Maintainer review packet

Use each generated repository Markdown report as the starting point. Add a historical sample only
after it exists. A draft message for a qualified source-change case is:

> I ran DiffCI's observation-only analysis on [repository] at [exact commit]. It proposed [selected]
> of [discovered] test files for that change. This is a static finding, not measured savings or a
> safety guarantee. Here are the report, reproduction command, and limitations: [report link].
> Would a seven-day observation pilot be useful? It leaves your existing test execution unchanged.

This is draft copy only. No issue, PR, email, or other message has been sent. Use a channel the
maintainer welcomes and obtain explicit authorization before sending outreach from this task.

## Pilot acceptance and measurement

Follow [alpha readiness](../alpha-readiness.md) and the [pilot runbook](../shadow-pilot-runbook.md).
Capture the workflow revision, successful report artifact, reported status, and hosted report when
the maintainer opts into ingestion. Verify uninstall and report access. Record:

| Stage | Evidence |
| --- | --- |
| Screened | Frozen revisions, eligibility/refusal, recent activity, workflow identity |
| Report reviewed | Maintainer feedback and useful/actionable finding |
| Installed | External run URL and observation artifact |
| Retained | Seven-day observation window, coverage, repeat reports |
| Value | Potential opportunity separately from measured runtime change |
| Repeatability | Operator minutes per repository and analysis compute cost |

Use voluntary feedback and opt-in hosted reports. A successful local run is not telemetry consent.

## Distribution sequence

1. Verify the published CLI and pinned Action in a fresh repository; complete artifact and hosted
   ingestion checks before declaring the entire onboarding loop verified.
2. Publish the corrected Cal.com investigation after reviewing its exact evidence and denominators.
3. Prepare targeted maintainer packets from qualified analyses; review responses before scaling outreach.
4. Share relevant findings in ecosystem discussions. Compare against existing affected-task tooling.
5. Grow the evidence catalog without a cross-repository waste ranking. Generate Markdown before badges.
6. Build a bounded URL-based analyzer after the manual workflow repeatedly delivers useful reports.
   Scope its initial output to compatibility, fixed-sample selection, and explicit unknowns; use queues,
   caching, request limits, and isolated execution for later runtime validation.
7. Submit to directories once outside users consistently reach a useful first report.

Marketplace preparation remains open: verify listing status, review GitHub's Action-focused repository
guidance, and choose a dedicated wrapper only if necessary. Do not equate a release with a listing.
