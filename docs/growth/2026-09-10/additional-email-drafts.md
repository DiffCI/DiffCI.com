# Additional DiffCI outreach drafts — September 10, 2026

From: aditya@diffci.com. All six saved as Gmail drafts; none sent. Publicly listed company addresses were verified through the linked official sources; mailbox deliverability is not verified.

## Trigger.dev

To: hello@trigger.dev

Subject: A read-only CI pilot for Trigger.dev

Contact source: https://github.com/triggerdotdev

Repository: https://github.com/triggerdotdev/trigger.dev

Gmail draft ID: r3263330472025146986

Hi Trigger.dev team,

I noticed your repository has separate unit-test workflows for packages, the web app, and other components. That made me curious about how you decide which tests a change needs.

I'm Aditya, building DiffCI Shadow. It observes default-branch changes, predicts which tests are relevant, and compares those predictions with GitHub Actions outcomes. It doesn't skip, cancel, or modify your CI.

Would you be open to a seven-day pilot on one public repository, starting with a compatibility check? I'd help with setup and review the report with you. The aim is to find out whether the evidence is useful—not to assume savings before measuring anything.

The App reads code in an ephemeral Cloudflare container; the permissions and handling details are at https://diffci.com/data-handling.

Is change-based test selection something your team is already using or evaluating?

Aditya Kale
DiffCI
https://diffci.com
aditya@diffci.com

## Formbricks

To: hola@formbricks.com

Subject: Could a shadow-mode CI report be useful to Formbricks?

Contact source: https://github.com/formbricks

Repository: https://github.com/formbricks/formbricks

Gmail draft ID: r-1680332228627589467

Hi Formbricks team,

I was looking at Formbricks' TypeScript package layout and GitHub Actions checks. I'd like to learn whether test selection is useful in a project with that structure, especially where package boundaries don't tell the whole story.

I'm Aditya, building DiffCI Shadow. Its read-only GitHub App observes default-branch changes and compares test-selection predictions with real CI outcomes. Your pipeline keeps running as usual.

Would you consider a seven-day pilot on one public repository? I'd first check the workflow fit, help with installation, and review the findings with you. A report may show little opportunity or insufficient evidence; I won't promise a percentage reduction upfront.

Because code access matters, the App's ephemeral Cloudflare analysis and data handling are explained here: https://diffci.com/data-handling.

Which CI stage currently causes the most waiting for your team?

Aditya Kale
DiffCI
https://diffci.com
aditya@diffci.com

## Documenso

To: hi@documenso.com

Subject: A CI test-selection pilot for Documenso

Contact source: https://github.com/documenso

Repository: https://github.com/documenso/documenso

Gmail draft ID: r-3360211518370811650

Hi Documenso team,

I noticed Documenso has both CI and Playwright workflows. I'm interested in how teams decide which test work a change actually needs when browser tests and other checks run alongside each other.

I'm Aditya, building DiffCI Shadow. It observes default-branch changes and compares change-based test predictions with GitHub Actions outcomes, without changing or cancelling your CI.

Would you be open to checking whether one of your public-repository test workflows is a suitable fit for a seven-day pilot? I'd help with setup and walk through the report. I haven't established compatibility with your browser-test setup, so that would come before any installation or savings claim.

The App reads repository code in an ephemeral Cloudflare container. Details: https://diffci.com/data-handling.

Is test runtime a problem worth investigating for your team right now?

Aditya Kale
DiffCI
https://diffci.com
aditya@diffci.com

## Activepieces

To: hello@activepieces.com

Subject: Evaluating change-based test selection for Activepieces

Contact source: https://github.com/activepieces

Repository: https://github.com/activepieces/activepieces

Gmail draft ID: r8626304426464899237

Hi Activepieces team,

I noticed your CI workflow uses Turbo caching and includes Postgres-backed integration tests. That raises an interesting question: beyond caching, would evidence about which tests a change affects help your team?

I'm Aditya, building DiffCI Shadow. It observes default-branch changes and compares test-selection predictions with actual GitHub Actions outcomes. It doesn't skip or modify your pipeline, and I wouldn't assume it improves on your current setup.

Would you be open to a short workflow-fit check, followed by a seven-day pilot if there's a suitable public-repository test stage? I'd help with installation and review the report with you. Database-dependent tests need an explicit compatibility check.

The App analyzes code in an ephemeral Cloudflare container: https://diffci.com/data-handling.

Are CI waits still a concern after your existing caching and selection rules?

Aditya Kale
DiffCI
https://diffci.com
aditya@diffci.com

## React Email

To: team@resend.com

Subject: A read-only test-selection pilot for React Email

Contact source: https://github.com/resend

Repository: https://github.com/resend/react-email

Gmail draft ID: r-4762987229108603070

Hi Resend team,

I looked at React Email's test workflow: it builds the packages before running tests and also checks the release script separately. I'd like to understand whether change-based test evidence would be useful alongside that setup.

I'm Aditya, building DiffCI Shadow. Its read-only GitHub App observes default-branch changes and compares test-selection predictions with CI outcomes. It doesn't skip, cancel, or modify any checks.

Would the React Email maintainers be open to a seven-day pilot on the public repository, after a compatibility check? I'd help with setup and review the findings. Your Playwright environment and service dependencies need checking first; I haven't validated the repository end to end.

Code is analyzed in an ephemeral Cloudflare container. Permissions and handling: https://diffci.com/data-handling.

Is unnecessary test work something the team wants to investigate?

Aditya Kale
DiffCI
https://diffci.com
aditya@diffci.com

## Twenty

To: contact@twenty.com

Subject: Could Twenty use a read-only CI pilot?

Contact source: https://twenty.com/terms

Repository: https://github.com/twentyhq/twenty

Gmail draft ID: r-5292920678782030559

Hi Twenty team,

I noticed your repository has separate CI workflows for the server, UI, shared code, and other packages. I'm curious how you handle test selection when a change crosses those boundaries.

I'm Aditya, building DiffCI Shadow. It observes default-branch changes, predicts relevant tests, and compares the predictions with GitHub Actions outcomes. Your existing CI continues unchanged.

Would your engineering team be open to a seven-day pilot on one public repository, starting with a workflow-fit check? I'd help with installation and review the report. The question is whether it adds useful evidence beyond your existing rules—not whether it can claim a savings percentage upfront.

The App reads code in an ephemeral Cloudflare container; details are at https://diffci.com/data-handling.

If this belongs with someone else, could you point me to the person responsible for CI?

Aditya Kale
DiffCI
https://diffci.com
aditya@diffci.com

