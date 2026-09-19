# First three external DiffCI Shadow pilots

Checked September 10, 2026. Target: three external installations, each with a useful report and a maintainer reply. This is a target, not an adoption claim.

## Live readiness

- Current installation baseline: one owner account, two private repositories, zero external repositories recorded via the App webhook.
- Homepage, welcome, contact, and data-handling pages return HTTP 200. HTTP and www redirect to the HTTPS apex.
- The App is reachable and requests read access to actions, checks, contents, and metadata. Recent GitHub push/workflow deliveries return 200.
- **Fixed during this audit:** the Worker expected commit `42d43c086c3f44a79c2cc5e0e41e48e8bda1b2e2`, but its analyzer archive contained `5c3c40e`. The cron refused analyses. Restored a git archive of the exact expected commit; live integrity now reports CURRENT. See `archive-restoration.json`. No Worker deployment or local in-progress code was included.
- The two own-repository public report URLs return 404 because both repositories are private. Authenticated dashboard/report retrieval was not tested here.
- A fresh install from a second account and a subsequent successful analysis/report remain unverified. A passing source-integrity check does not prove successful analysis.
- Contact page availability was checked; form submission and replies were not tested.

## Audience and first wave

TypeScript projects using GitHub Actions with frequent default-branch changes and a substantial test workload. Start with a public repository the maintainer controls. Ask about CI time and existing affected-test tools before claiming economic fit. Root-tsconfig projects have a simpler initial qualification path; nested layouts need extra inspection because merged compiler options can reduce confidence.

Ten prospects were checked through GitHub's live API. These are preliminary structural candidates, not proven runtime-compatible or paying prospects. Recent runs can include administrative checks; their existence does not demonstrate an expensive test workload. Source URLs, workflow paths, dates, and verdicts are in `readiness.json`.

| Order | Repository | Evidence / reason for consideration | Remaining qualification | Outreach |
|---|---|---|---|---|
| 1 | [statelyai/xstate](https://github.com/statelyai/xstate) | Root tsconfig; recent successful Node CI | Test-stage time, maintainer contact, willingness | Not sent |
| 2 | [resend/react-email](https://github.com/resend/react-email) | Root tsconfig; separate tests.yml and e2e.yml | Successful test runs, stage time, contact | Not sent |
| 3 | [inngest/inngest-js](https://github.com/inngest/inngest-js) | Nested TypeScript configs; recent successful PR checks | Default-branch test evidence, nested-layout behavior, contact | Not sent |
| 4 | [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev) | Nested configs and multiple unit-test workflows | Service needs and applicable test stage | Not sent |
| 5 | [novuhq/novu](https://github.com/novuhq/novu) | Root tsconfig and multiple CI workflows | Isolate test workload from deployment jobs | Not sent |
| 6 | [formbricks/formbricks](https://github.com/formbricks/formbricks) | Nested configs; recent successful Check PR | Test coverage, infrastructure needs | Not sent |
| 7 | [twentyhq/twenty](https://github.com/twentyhq/twenty) | Nested configs; separate server/UI/shared CI workflows | Existing selection baseline, setup overhead | Not sent |
| 8 | [activepieces/activepieces](https://github.com/activepieces/activepieces) | Nested configs; CI and e2e workflows | Test-stage mapping and service requirements | Not sent |
| 9 | [documenso/documenso](https://github.com/documenso/documenso) | Nested configs; CI and Playwright workflows | Browser/e2e fit before proposing installation | Not sent |
| Hold | [heyform/heyform](https://github.com/heyform/heyform) | Root tsconfig; screen did not establish a relevant recent CI run | Establish observable test workload first | Not sent |

Verify a business contact on each project's official site before sending. The pre-existing outreach tracker contains email addresses, but this audit has not validated them. Do not use bug issues as an unsolicited sales channel.

## First three invitation drafts

### XState

Subject: Seven-day read-only CI pilot for XState

Hi XState team,

I saw XState's Node CI workflow and TypeScript project setup. I'm building DiffCI Shadow and looking for three maintainers to help assess whether its change-based test predictions are useful in a real development workflow.

Would you be open to a seven-day pilot on one public repository? The GitHub App observes default-branch changes and compares its predictions with CI outcomes. It does not skip, cancel, or modify your CI. The report distinguishes observed timings from estimated opportunities and may find insufficient evidence or no useful opportunity.

It reads repository contents into an ephemeral Cloudflare container for analysis. Permissions and handling details: https://diffci.com/data-handling. App: https://github.com/apps/diffci-shadow.

Which part of your CI currently takes the most time, and do you already use affected-test selection? Happy to establish fit before you install.

[Sender name]

### React Email

Subject: Could React Email help evaluate a read-only CI report?

Hi React Email team,

I noticed React Email has separate test and e2e workflows. I'm building DiffCI Shadow to compare change-based test predictions with real CI outcomes, and I'd like to understand whether that evidence would be useful to your maintainers.

Would you consider a seven-day pilot on one public repository after a quick compatibility check? It observes default-branch changes without changing, skipping, or cancelling CI. I would not assume the e2e workload is supported or promise savings; the first step is identifying a suitable test workflow.

The App reads code in an ephemeral Cloudflare container. Details: https://diffci.com/data-handling. App: https://github.com/apps/diffci-shadow.

Is test runtime currently a concern, or is another stage the main bottleneck?

[Sender name]

### Inngest

Subject: Read-only CI pilot for the Inngest JS repository

Hi Inngest team,

I saw the TypeScript package layout and PR checks in inngest-js. I'm building DiffCI Shadow and recruiting three early maintainers to evaluate its reports on change-based test predictions.

Would a seven-day pilot on one public repository be useful? The App observes default-branch changes and compares predictions with CI results without skipping or modifying your pipeline. Your nested TypeScript layout needs a compatibility check first; I don't want to promise savings before seeing evidence.

It reads code in an ephemeral Cloudflare container. Details: https://diffci.com/data-handling. App: https://github.com/apps/diffci-shadow.

Do you currently select affected tests, and which CI stage causes the most waiting?

[Sender name]

## Acceptance check before invitations

1. Use a second account or maintainer-controlled test repository to install the App; record the real installation ID and successful setup redirect. Do not count internal test installs as customers.
2. Confirm the repository is enrolled with github-app-webhook, then make an ordinary eligible default-branch change in that test repository.
3. Verify a new prediction, real CI outcome, and report. Confirm the report says insufficient data when appropriate. For a private repository, verify owner access and anonymous denial.
4. Repeat after uninstall: confirm no further observation and verify the documented deletion behavior.
5. Send the first three invitations only after the check passes and sender/contact details are established. Expand to the next six candidates after learning from the initial responses. Keep Heyform on hold.

## Measurement and follow-up

Record for each prospect: verified contact/source, sent timestamp, reply, install timestamp/account/repository, first prediction, first usable report, report reviewed confirmation, feedback, uninstall, and next action. Blank means unknown; never infer a read from an accessible URL.

Day 0: invitation and optional assisted install. Day 2: verify observation and resolve failures. Day 7: inspect the actual report and ask the maintainer whether it changed their understanding of CI. Extend the observation period if evidence is thin. Reports are available by URL; do not promise automatic email delivery.

One optional follow-up after five business days: “Following up on the DiffCI Shadow pilot invitation. If CI analysis isn't a priority, no problem. If it is, I can first check whether a suitable test workflow exists.” Stop after a decline; no automated outreach was scheduled.

Ask report reviewers: Was the report understandable? Did it identify anything new? What would prevent adoption? What evidence would justify allowing selection? Do not turn hypothetical savings into measured savings or a payment claim.

## Current unresolved inputs

- A second account/test repository for the real installation check.
- Sender identity and a verified reply channel for the outreach drafts.
- Verified recipient addresses and explicit authorization for the final addressed messages.

No messages sent and no external repositories enrolled by this task.
