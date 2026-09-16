# Registering the DiffCI Runner Dispatcher GitHub App

> **Organization migration (2026-09-16):** `DiffCI.com` now belongs to the `DiffCI` organization.
> Keep this existing personal-account app for DentalPresence; the new organization fleet is documented
> in [DiffCI organization runner](github-app-registration-org-runner.md). The historical status below
> describes the setup before the repository transfer.

> **Status: DONE (2026-08-21).** The App is registered and installed on both `DiffCI.com` and
> `DentalPresence.in` (installation id `155363973`), its three secrets are on the `diffci-github-runner`
> Worker, and the webhook is active - end to end verified: pushes to `main` dispatch a fresh Cloudflare
> Container per queued job, register as `[self-hosted, cloudflare]`, run `npm run check`, and deregister.
> The last 8 consecutive `CI` runs on `DiffCI.com` are green (~1 min each once warm, ~$0.004/job, zero
> GitHub Actions billing consumed). Do not confuse this App with the **DiffCI Shadow** App (see
> [`docs/github-app-registration.md`](github-app-registration.md)) - that one is a separate, read-only
> registration and cannot do anything described here. The checklist below is kept for registering the
> App again elsewhere (e.g. transferring to an org) and as the reference for what was granted.

Everything code-side is already written: `src/shadow/github-app.ts` (App-JWT signing, installation-token
exchange, webhook HMAC verification - shared with the Shadow App, not duplicated) and
`src/research/cloudflare/github-runner-worker.ts` (the webhook route + Container dispatch). Registration
itself is an outward-facing, account-tied action that a human performs once in the GitHub UI. The
manifest the steps below reproduce lives at
[`ops/github-app/diffci-runner-app-manifest.json`](../ops/github-app/diffci-runner-app-manifest.json).

## One App per trust level - do not merge with the Shadow App

| App | Purpose | Permissions | Who installs it |
|---|---|---|---|
| DiffCI Shadow (already registered) | Observe-only shadow validation | Read-only, exactly 5 scopes | Design partners + own repos |
| **DiffCI Runner Dispatcher** (this doc) | Ephemeral self-hosted Actions runners | `Administration:write`, `Actions:write` | Own repos ONLY (DiffCI.com, DentalPresence.in) |

The Shadow App's entire design-partner pitch is "this App cannot touch anything in your repository."
Reusing its credentials or folding write permissions into it would make that claim false. Keep the two
Apps, their private keys, and their webhook secrets completely separate - this App should never be
installed anywhere except your own two repos.

## Steps

1. **Create the App.** GitHub -> Settings -> Developer settings -> GitHub Apps -> *New GitHub App*
   (personal account, same as the Shadow App).
   - Name: `DiffCI Runner Dispatcher` - Homepage URL: `https://diffci.com`
   - Webhook URL: `https://runner.diffci.com/webhook` - **Active** checked (unlike the Shadow App, the
     route is already live - `github-runner-worker.ts` is deployed and waiting). Set a webhook secret
     (`openssl rand -hex 32`) and keep it for step 3.
     (Originally registered against `https://diffci-github-runner.damp-waterfall-0cd8.workers.dev/webhook`;
     cut over to the `runner.diffci.com` custom domain on 2026-08-22 once that zone went active - see
     wrangler.github-runner.jsonc's `routes` comment. Live-verified post-cutover: a real `workflow_job`
     delivery to the new URL got a 202 and the underlying CI job ran to completion. The old workers.dev
     URL is left deployed but is no longer what GitHub calls.)
   - Repository permissions - exactly these two:
     - **Administration: Read and write** (required to mint runner registration tokens via
       `POST /repos/{owner}/{repo}/actions/runners/registration-token`)
     - **Actions: Read and write**
   - Subscribe to events: **`workflow_job`** only. (Metadata:read is implicit on every App - nothing
     else to check.)
   - "Where can this App be installed?" -> **Only on this account** - this App must never be installable
     by anyone else, unlike the Shadow App.
2. **Generate a private key** (App settings page -> "Generate a private key"). GitHub downloads a
   **PKCS#1** PEM; `github-app.ts`'s Web Crypto usage only imports **PKCS#8**. Convert immediately:

   ```bash
   openssl pkcs8 -topk8 -nocrypt -in diffci-runner-dispatcher.*.private-key.pem -out diffci-runner-pkcs8.pem
   ```

3. **Store the three secrets on the github-runner Worker** (note the App ID shown at the top of the App
   settings page - these names must match exactly what `github-runner-worker.ts`'s `RunnerEnv` interface
   expects, and are deliberately NOT prefixed `SHADOW_*` since they belong to a different App/Worker):

   ```bash
   wrangler secret put GITHUB_APP_ID --config wrangler.github-runner.jsonc
   wrangler secret put GITHUB_APP_PRIVATE_KEY --config wrangler.github-runner.jsonc < diffci-runner-pkcs8.pem
   wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler.github-runner.jsonc
   ```

   Then delete the local key files - the Worker secret store is their home now.
4. **Install it on both repos**: the App's public page is `https://github.com/apps/<app-slug>` ->
   Install -> select DiffCI.com and DentalPresence.in (both, since both need CI unblocked). Note the
   **installation ID** shown in the URL of Settings -> Installations -> Configure - if it differs per
   repo (unlikely for a single personal-account installation covering both), `github-runner-worker.ts`
   already reads `installation.id` straight off each webhook payload, so no code change is needed either
   way; the env fallback (`GITHUB_APP_INSTALLATION_ID`) is only for manual/local testing.
5. **Verify end to end**: push a commit (or re-run a queued job) and watch
   `gh api repos/adityankale190895/DiffCI.com/actions/runners` - a runner named `cf-DiffCI.com-<id>`
   should appear briefly, the queued `ci.yml` run should move from `queued` to `in_progress` to
   `completed`, and the runner entry should disappear again afterward (ephemeral - it deregisters itself
   per job). Repeat the check against DentalPresence.in.

## What NOT to do

- Do not request any permission beyond `Administration:write` + `Actions:write` - in particular, no
  `Contents` permission is needed here; `actions/checkout` inside the workflow uses the run's own
  auto-generated `GITHUB_TOKEN`, not this App's installation token.
- Do not reuse the Shadow App's private key or webhook secret for this App, or vice versa.
- Do not install this App anywhere except DiffCI.com and DentalPresence.in - unlike the Shadow App,
  which is meant to be installable by design partners, this one can write to a repo's runner
  configuration and should stay scoped to accounts you control.
