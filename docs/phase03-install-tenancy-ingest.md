# Phase 03 — install, tenancy, ingest

**Date:** 2026-08-26 · **Exit criterion:** a stranger self-serves; org A provably can't read org B.

Phase 02 produces a report on somebody else's runner. Phase 03 is the machinery for that report to
arrive somewhere, be attributed to exactly one repository, and be readable by exactly the people who own
it. The control plane it plugs into already existed — GitHub OAuth login, organizations, memberships,
repositories, usage metering, audit log. What did not exist was any way for a machine with no session to
authenticate, anywhere for an observation to land, or a proof that a query could not cross tenants.

## What shipped

| File | What it is |
|---|---|
| [`src/ingest/cloudflare/schema.sql`](../src/ingest/cloudflare/schema.sql) | `ingest_tokens` and `observations`, in the existing `diffci-product` D1 database. |
| [`src/ingest/token.ts`](../src/ingest/token.ts) | Repository-scoped machine credentials. `dci_`-prefixed, SHA-256 at rest, revocable, `last_used_at`. |
| [`src/ingest/store.ts`](../src/ingest/store.ts) | Observation persistence. Every read/delete takes `organizationId` and puts it in the SQL. |
| [`src/ingest/ingest.ts`](../src/ingest/ingest.ts) | The accept path: credential → repository identity check → schema check → idempotent insert → metering + audit. |
| [`src/ingest/routes.ts`](../src/ingest/routes.ts) | Organization-scoped routes: issue/list/revoke credentials, install instructions, read and erase observations. |
| [`src/ingest/install.ts`](../src/ingest/install.ts) | The workflow and secret a stranger is handed at the end of signup. |
| [`src/ingest/retention.ts`](../src/ingest/retention.ts) | The 90-day sweep the data-handling page promises and did not have. |
| [`src/client/submit.ts`](../src/client/submit.ts) | The client half: https-only, token never logged, one retry, a failed send never fails a build. |
| [`src/install/github-installation.ts`](../src/install/github-installation.ts) | Repository discovery from a real App installation. Refuses a repository another organization already claimed. |
| [`src/install/webhook.ts`](../src/install/webhook.ts) | Uninstall and repository-removal deliveries: signature-verified, then immediate erasure. |
| [`src/ui/render.ts`](../src/ui/render.ts), [`src/ui/pages.ts`](../src/ui/pages.ts) | The console. Server-rendered HTML, escaped by construction, no build step. |
| [`src/product/cloudflare/product-worker.ts`](../src/product/cloudflare/product-worker.ts) | Routes wired in, plus the retention sweep on the existing 10-minute cron. |

`action.yml` gained `api-url` and `api-token`. Both empty by default: with no token configured the
observer behaves exactly as Phase 02 shipped it and nothing leaves the runner.

## "Org A provably can't read org B", four ways

**1. The credential names the repository.** An ingest token is scoped to one repository, not to an
organization. Which repository a report belongs to is therefore a property of the credential, never a
claim in the payload — and a claim is exactly what an attacker controls.

**2. A contradicting claim is rejected, not reconciled.** Reports also carry GitHub's numeric repository
id. When it disagrees with the token's repository the report is refused with `repository_mismatch`. That
disagreement is what a workflow copied into another repository looks like, and it is the one signal
separating ordinary use from one tenant writing into another's account.

**3. Tenancy is a predicate, not a convention.** Every read and delete in `src/ingest/store.ts` puts
`organization_id = ?` in the SQL. "The query returned nothing" is a safe failure; "the caller forgot to
filter afterwards" is not.

**4. A machine checks 3 on every run.** [`tests/ingest/tenancy.test.ts`](../tests/ingest/tenancy.test.ts)
reads the ingest modules' own SQL and fails if a statement against a tenant table lacks an
`organization_id` predicate. Four statements genuinely cannot have one — the retention sweep (twice, it
crosses tenants by definition) and the token lookup (it is *how* an organization is established) — so
they are listed individually with their reason. Adding to that list is a deliberate act.

That structural guard earned its place immediately: its first version silently checked only 6 of the 10
statements it should have, because the regex extracting SQL required a closing parenthesis that four
call sites do not have. The floor assertion ("this guard must have checked several statements") is what
caught it.

On top of all four, the route layer checks membership *and* that the repository named belongs to the
organization — and answers `not_found` rather than `unauthorized` for another tenant's object, because
the difference between those two answers is itself a disclosure.

## The App installation flow and the console

Both were added after the first pass of this phase, which shipped the whole self-serve path as an
authenticated JSON API and none of it as a screen.

**Repository discovery** ([`src/install/github-installation.ts`](../src/install/github-installation.ts)).
`POST /v1/organizations/:id/repositories` still exists, but nobody has to use it: after someone installs
the GitHub App, GitHub itself says which repositories the installation covers, and exactly those get
connected — with GitHub's own numeric ids, so a later rename is not a new repository. Paginated, because
"install on all repositories" on a large account is thousands and a first page would silently connect a
subset.

The rule that matters here: **a repository already connected to another organization is refused, never
moved.** GitHub happily lets two accounts install an App on repositories they each control (a transfer, a
shared org, an outside collaborator with admin). Re-parenting the row would move that repository's
observations, credentials and history into whoever installed most recently, so the claim stands with
whoever connected first and the newcomer is told plainly.

**Erasure on uninstall** ([`src/install/webhook.ts`](../src/install/webhook.ts)). The other half of the
data-handling promise, which a cron cannot keep because elapsed time is not the trigger. Uninstalling, or
dropping one repository from an installation, deletes that repository's observations immediately and
revokes its ingest credentials so a workflow left in place cannot re-create them. Credentials die before
the data does, so a failure part-way leaves the safe state. Every delivery's signature is verified first:
this is the one route in DiffCI whose whole purpose is to erase data, and the signature check is the
entirety of its authentication.

**The console** ([`src/ui/`](../src/ui/)). Five screens, server-rendered from the Worker: sign in → pick
or create an organization → install the App → mint a token and copy a workflow → watch observations
arrive. No build step, no framework, no bundle. Its one piece of client-side JavaScript exists because
the API is CSRF-protected by a signed double-submit token, which requires echoing a cookie value in a
request *header* — something a plain HTML form cannot do. Rather than weaken the CSRF check to accept a
form field, the console reads the (deliberately non-HttpOnly) CSRF cookie the way every other API client
does; the session cookie stays HttpOnly and is never touched by script.

Every page reads through the same organization-scoped route functions the JSON API uses. There is no
separate "UI query" path, so there is no second place for a tenancy check to be forgotten — and
`/app/orgs/<another org>` is refused exactly as its API is.

## What a stranger actually does

Sign in with GitHub → create an organization → install the App on the repositories they choose → click
**Create token**. That last action returns, once, a `dci_…` token and a complete installation: the
workflow file to commit, the secret name to set, the endpoint reports go to, and — when the server's
configured action reference is not pinned to a commit SHA — a warning saying so. Every step is a screen;
the same steps remain available as JSON for anyone who prefers `curl`.

The generated workflow is checked by DiffCI's own Phase 02 non-interference guard in
[`tests/ingest/install.test.ts`](../tests/ingest/install.test.ts): its own job, `continue-on-error: true`,
`contents: read`, pinned action, `fetch-depth: 0`. Onboarding cannot emit an installation that
`verify-workflow` would reject.

## Retention and erasure

[`site/data-handling.html`](../site/data-handling.html) carries a banner saying the page must not be
published because the automated deletion path does not exist. For observations it now does:

- **90 days maximum, regardless** — a sweep on the product Worker's existing 10-minute cron, deleting by
  elapsed time rather than waiting for a webhook, a session, or anyone remembering.
- **Ask, and it goes sooner** — `DELETE /v1/organizations/:id/observations`, optionally per repository,
  scoped by construction to the caller's own organization.

Uninstall-triggered erasure is still not implemented (it needs the GitHub App's uninstall webhook), and
this only covers Phase 03's own tables. The banner stays.

## Verified

1,507 tests pass (was 1,420 at the end of Phase 02), typecheck clean. 87 new, of which the ones that
carry weight:

- **The whole loop through the real Worker** ([`tests/product/cloudflare/product-worker-ingest.test.ts`](../tests/product/cloudflare/product-worker-ingest.test.ts)):
  connect a repository → read install instructions → mint a credential → post a report with it → post it
  again (200, `duplicate: true`, same id) → read it back. Then the same routes from another
  organization: read 403, mint 404, erase 403, and their data still there afterwards.
- **The copied-workflow case**: a valid credential carrying a report from a different repository is
  refused with 403 `repository_mismatch`.
- **Four deliveries of one observation is one analysed run** — and the repeats do not re-meter or
  refresh `last_used_at`, so a retrying workflow cannot inflate usage or make a dead credential look
  live.
- **A genuine re-run is a second observation** — same run id, new attempt number, stored separately.
- **The token never appears** in storage, in a listing response, in the audit log, in any rendered page
  (only its prefix, and only for live credentials), or in any value `submitObservation` returns -
  including the error paths where a thrown fetch stringifies the request.
- **An unsigned uninstall delivery deletes nothing**, and a real one deletes exactly the repositories of
  that installation - a second organization sharing neither is untouched.
- **A repository claimed by another organization is refused**, its owning organization, installation id
  and observations all unchanged, while the repositories nobody had claimed still connect.
- **A repository name from GitHub cannot become markup**: the console renders `"><img src=x onerror=…`
  as text, and every page value goes through the same escaping template.

Beyond the suite, the real CLI was pointed at a local HTTP server: a 1,605-byte report was delivered with
`Authorization: Bearer dci_…` and the step printed `delivery: sent`.

## Yours

- **Apply the schema**: `npx tsx scripts/migrate-product-db.ts --remote` (the ingest file is appended to
  the existing ordered list). Nothing is deployed by this phase.
- **Set `DIFFCI_ACTION_REF`** on the product Worker to `owner/DiffCI.com@<40-hex sha>` once the action is
  published. Until then, generated instructions correctly carry the "not pinned" warning.
- **Decide whether the product Worker is public.** It deploys to workers.dev today and
  `wrangler.product.jsonc` deliberately has no `diffci.com` route; ingest needs a stable, public origin
  before anyone's CI can post to it.
- **Register the observer GitHub App and configure four values** on the product Worker:
  `GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM — GitHub downloads PKCS#1;
  convert with `openssl pkcs8 -topk8 -nocrypt`), and `GITHUB_APP_WEBHOOK_SECRET`. Its Setup URL must be
  `<origin>/app/install/callback` and its webhook URL `<origin>/v1/webhooks/github/installation`. This is
  a *third* App, separate from the read-only Shadow App and the write-scoped Runner Dispatcher; it needs
  no permissions beyond repository metadata, because everything DiffCI reads happens on the customer's
  own runner. With any of the four absent, the console says the App is not configured here rather than
  offering a button that cannot work.
- **Set `CSRF_SECRET`.** Without it the CSRF check is inert (by existing design) and the console's
  state-changing buttons work anyway — which is fine locally and wrong in production.

## Not done, stated so it is not discovered later

- **No rate limiting on ingest.** A valid credential can post as fast as it likes; the only bounds today
  are the 1 MiB payload cap and idempotency. Fine for a seven-day pilot with a handful of repositories,
  not for an open endpoint.
- **Ingest is unauthenticated at the network edge.** Anyone can reach the endpoint; only a valid token
  gets past it. That is intended, and it is also why the rate-limiting gap above matters.
- **The 90-day sweep has never run against real data**, because no real observation has been ingested
  yet. It is covered by tests against the real schema, not by production evidence.
- **The App flow has never touched GitHub.** `connectInstallation` and the webhook handler are tested
  against injected repository lists and hand-signed deliveries; no App is registered, so no App JWT has
  been minted, no installation token exchanged, and no real delivery received. The same is true of the
  console's OAuth sign-in, which uses the pre-existing, separately-tested login flow.
- **The console has five screens and no more.** No member management, no billing screen, no observation
  detail view, no pagination beyond a fixed recent-N, and no way to rename or delete an organization.
- **Suspension is treated as removal.** An `installation.suspend` delivery erases the same as a delete.
  That is the safe direction, but un-suspending will not bring the observations back.
