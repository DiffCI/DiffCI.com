# Registering the DiffCI Shadow GitHub App

## Organization restoration (2026-09-16)

The existing **DiffCI Shadow** app is installed on the DiffCI organization as installation
`162093948`, scoped only to `DiffCI/DiffCI.com`. Its permissions remain read-only: Actions, Checks,
Contents and Metadata; its subscriptions remain `push` and `workflow_run`. The existing app credentials,
Worker and webhook are reused. No Runner permissions or credentials are involved.

The signed `installation.created` delivery `3842992105785974784` received HTTP 200 at
2026-09-16T04:24:11Z. The existing research Worker automatically enrolled the new repository identity
as private, recorded the new installation ID, and identified `.github/workflows/ci.yml` as the evidence
workflow. Initial state is `VALIDATING`; enrollment does not mean a new prediction has completed.

The old `adityankale190895/DiffCI.com` enrollment is `PAUSED`, with a migration note. Its historical
predictions and evidence remain under their original repository identity; they have not been relabeled
as observations of the new installation. DentalPresence retains installation `155368612` and its
`SHADOW_ACTIVE` state.

The status API confirms cron enabled, the push-poll queue bound, and matching deployed/archive source
SHA `b3249b37eb3ce0076636fce40acf662fcd99ecc0` (`CURRENT` integrity). This is an integrity check, not a
claim that the analyzer is deployed from the latest repository commit.

The registration instructions below describe the original setup. The webhook route is already live;
restoring access to the same app requires installation on the new owner, not new credentials or a
Worker redeployment. Private reports remain access-controlled.

> **Status: DONE (2026-08-21).** The App is registered, its three `SHADOW_GITHUB_*` secrets are on the
> research Worker, the webhook is active against `/v1/shadow/webhook`, and the first installation
> (id 155368612) auto-enrolled `adityankale190895/DiffCI.com` and `adityankale190895/DentalPresence.in`
> into shadow observation - this repository observes itself. The checklist below is kept for
> registering the App again elsewhere (e.g. transferring to an org) and as the reference for what was
> granted.

Everything code-side is already written and tested (`src/shadow/github-app.ts`: App-JWT signing,
installation-token exchange, webhook HMAC verification — see
`docs/research/2026-08-21-stage2-architecture.md`, Phase 3/4). Registration itself is an
outward-facing, account-tied action that a human performs once in the GitHub UI. This document is the
exact checklist for that ~10-minute task. The manifest the steps below reproduce lives at
[`ops/github-app/diffci-shadow-app-manifest.json`](../ops/github-app/diffci-shadow-app-manifest.json).

## One App per trust level — do not merge with the runner App

There are two prospective GitHub Apps in this repository, and they must stay **separate**:

| App | Purpose | Permissions | Who installs it |
|---|---|---|---|
| **DiffCI Shadow** (this doc) | Observe-only shadow validation | Read-only, exactly 4 scopes (pull_requests dropped 2026-09-03, unused) | Design partners + own repos |
| GitHub-runner dispatcher (`src/research/cloudflare/github-runner-worker.ts`) | Ephemeral self-hosted Actions runners | Administration:write, Actions:write | Own repos ONLY |

The entire design-partner pitch for shadow mode is "this App cannot touch anything in your
repository." Folding the runner dispatcher's write permissions into the same App would make that
claim false for every future installer. Register the runner App separately when its time comes; its
manifest shape is noted in `wrangler.github-runner.jsonc`'s comments.

## Steps

1. **Create the App.** GitHub → Settings → Developer settings → GitHub Apps → *New GitHub App*
   (personal account is fine for now; transferable to an org later).
   - Name: `DiffCI Shadow` — Homepage URL: `https://diffci.com`
   - Webhook: enter the URL from the manifest but leave **Active** unchecked for now — the
     `/v1/shadow/webhook` route isn't wired in the Worker yet (deliberate: polling covers observation
     today; the webhook route is a small follow-up once the App exists). Set a **webhook secret**
     anyway (e.g. `openssl rand -hex 32`) and stash it — you'll enable Active later without re-visiting
     secrets. Installation-token API access (the part the pipeline can use immediately, e.g. for
     private design-partner repos) works fine with the webhook inactive.
   - Repository permissions — exactly these four, **all Read-only**, nothing else:
     Metadata, Contents, Actions, Checks. (Pull requests was requested until 2026-09-03 and dropped
     because nothing used it; re-add it only when PR-delta analysis actually ships.)
   - Subscribe to events: `push`, `workflow_run`.
   - "Where can this App be installed?" → **Any account** (design partners and the DiffCI organization
     must be able to install it; public installation availability does not require a Marketplace listing).
2. **Generate a private key** (App settings page → "Generate a private key"). GitHub downloads a
   **PKCS#1** PEM; Web Crypto (which `github-app.ts` uses, identically in Node and Workers) only
   imports **PKCS#8**. Convert immediately:

   ```bash
   openssl pkcs8 -topk8 -nocrypt -in diffci-shadow.*.private-key.pem -out diffci-shadow-pkcs8.pem
   ```

3. **Store the three secrets on the research Worker** (note the App ID shown at the top of the App
   settings page):

   ```bash
   wrangler secret put SHADOW_GITHUB_APP_ID --config wrangler.research-sandbox.jsonc
   wrangler secret put SHADOW_GITHUB_APP_PRIVATE_KEY --config wrangler.research-sandbox.jsonc < diffci-shadow-pkcs8.pem
   wrangler secret put SHADOW_GITHUB_WEBHOOK_SECRET --config wrangler.research-sandbox.jsonc
   ```

   Then delete the local key files — the Worker secret store is their home now.
4. **Install it on the first repositories**: the App's public page is
   `https://github.com/apps/<app-slug>` → Install → select repositories (start with your own; that
   link is also what you hand a design partner). Each installation has an **installation ID** (visible
   in the URL of Settings → Installations → Configure) — `exchangeInstallationToken` needs it
   per-installed-account.
5. **Tell this repo it happened**: after registering, the follow-up engineering (wiring
   `/v1/shadow/webhook` to `verifyWebhookSignature` + the existing prediction path, and using
   installation tokens in `reconcile.ts` where `GITHUB_TOKEN` is used today) is a small, purely
   config-driven change — the architecture doc's "config/secrets change, not a new engineering
   effort" promise.

## What NOT to do

- Do not request any write permission "while we're in there." Read-only is the product.
- Do not reuse this App's private key or webhook secret for the runner dispatcher App.
- Do not enable the webhook Active flag before the Worker route exists — failed deliveries pile up in
  the App's Advanced → Recent Deliveries log and just add noise.
