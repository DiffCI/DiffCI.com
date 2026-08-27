# Phase 2 preparation — routes, distribution, and the product App

> **SUPERSEDED IN PART, 2026-08-27.** Section 2 below planned a PUBLIC action repository. That decision
> was reversed: DiffCI is proprietary and source-private, is not distributed as a third-party `uses:`
> Action, and no public repository will be created. See [agent-distribution.md](agent-distribution.md)
> for what replaced it. Sections 1, 3 and 4 (routes, the product App, secrets) still stand, except that
> `DIFFCI_ACTION_REF` is now `DIFFCI_AGENT_ARTIFACT`.
>
> **"Creating a public GitHub repository" is no longer a blocker to external onboarding.** It was never
> a requirement - it was one way of satisfying a requirement, and we chose a different one.

**Date:** 2026-08-27 · **Status:** prepared, **nothing applied**. No DNS change, no route, no App
registration, no published repository, no secret, no commit.

This document is the input to three external actions that only the account owner can perform. Each
section states exactly what to create, why each value is what it is, and what must be true before it is
safe to do.

---

## 1. Production routes and origins

### The collision, and the resolution

`wrangler.product.jsonc` carries a commented-out `diffci.com/*` route, and `wrangler.site.jsonc` is the
static site with no route at all. Both were written expecting the apex. They cannot both have it.

| Host | Worker | Contents |
|---|---|---|
| `diffci.com` | `diffci-site` | Static marketing site. No D1, no R2, no App key, no secret of any kind. |
| `app.diffci.com` | `diffci-product` | Console, OAuth, ingest, webhooks, invoices. |

Splitting on hostname rather than path is the safer arrangement and should be kept even though a path
split would work: the site Worker holds no bindings at all, so the one surface that gets the most
untrusted traffic cannot reach anything. A path split on one Worker would give that up.

### Configuration to apply (not applied)

`wrangler.site.jsonc` — add:

```jsonc
"routes": [{ "pattern": "diffci.com/*", "custom_domain": true }]
```

`wrangler.product.jsonc` — replace the commented apex line with:

```jsonc
"routes": [{ "pattern": "app.diffci.com/*", "custom_domain": true }]
```

`www.diffci.com` is deliberately **not** claimed here. Decide it explicitly (redirect at the DNS/Rules
layer to the apex) rather than leaving a hostname that resolves to nothing.

### `DIFFCI_API_ORIGIN` must become `https://app.diffci.com`

This is not cosmetic. The value is baked into the `ingestUrl` inside every generated workflow
(`src/ingest/install.ts` builds `${apiOrigin}/v1/ingest/observations`), and those workflows are
committed into customer repositories. A workflow generated while this still says
`https://diffci-product.damp-waterfall-0cd8.workers.dev` will keep posting to the workers.dev hostname
forever, in someone else's repository, where we cannot edit it.

**Therefore: set the origin before the first external repository is onboarded, not after.** The
workers.dev hostname must keep resolving indefinitely regardless, because anything generated before the
switch will still be pointed at it.

### Every URL that changes with the origin

| Setting | Where | New value |
|---|---|---|
| `DIFFCI_API_ORIGIN` | `wrangler.product.jsonc` vars | `https://app.diffci.com` |
| `DIFFCI_APP_ORIGIN` | `wrangler.product.jsonc` vars | `https://app.diffci.com` — used to bound the post-login redirect; a stale value silently disables that check's usefulness |
| OAuth callback | GitHub OAuth app settings | `https://app.diffci.com/auth/github/callback` |
| App webhook | Product App settings | `https://app.diffci.com/v1/webhooks/github/installation` |
| App setup URL | Product App settings | `https://app.diffci.com/app/install/callback` |
| Site App link | `site/index.html` | the product App's install URL (currently points at `diffci-shadow` — see §3) |

### Order of operations

1. Add the DNS records / custom domains in Cloudflare for both hostnames.
2. Deploy `diffci-site` with its route. Verify `https://diffci.com` serves the site.
3. Update `DIFFCI_API_ORIGIN` and `DIFFCI_APP_ORIGIN`, deploy `diffci-product` with its route.
4. Verify `https://app.diffci.com/health` returns 200 and reports the new origin.
5. Only then register the App (§3), because its URLs point at `app.diffci.com`.

---

## 2. The public action repository — SUPERSEDED, kept for the reasoning

> Not being done. Retained because the dependency-closure analysis below is still accurate and is what
> the private agent build now bundles.

### What it must contain

The action's real transitive closure, computed from `tsconfig.client.json` (`tsc --listFiles`), is
**21 files, ~5,900 lines**:

```
src/client/     cli.ts  context.ts  observe.ts  report.ts  submit.ts  workflow-guard.ts
src/git/        git-diff.ts  types.ts
src/planner/    path-baseline.ts  test-command.ts  types.ts
src/repo/       analyzer.ts  graph.ts  impact-types.ts  impact.ts  layout.ts
                repo-config.ts  test-discovery.ts  test-fixture-ownership.ts
                test-framework.ts  types.ts
```

Plus: `action.yml`, `tsconfig.json` + `tsconfig.client.json`, a `package.json` carrying only
`typescript` and `@types/node` as production dependencies, `examples/diffci-observe.yml`, a licence, and
a README. Nothing else.

**Verified: there are no imports from any private module.** Nothing in the closure reaches
`src/research/`, `src/shadow/`, `src/billing/`, `src/product/`, `src/ingest/`, or `src/analysis-fanout/`.
The extraction is mechanical.

### The tension in Decision 1, stated plainly

The instruction was to keep the engine private and publish only the customer-side integration. **Those
are the same thing.** `graph.ts`, `impact.ts`, `analyzer.ts` and the planner *are* the customer-side
integration — the whole architecture is that selection runs on the customer's runner, so the selection
engine has to be on that runner.

There is no version of this where a stranger's CI executes the engine and the engine stays unpublished.
The realistic options are:

1. **Publish the engine source** — accept that the selection algorithm is public. It is auditable,
   which is the actual selling point of running client-side at all, and it is the smallest honest
   surface.
2. **Ship a prebuilt bundle** — the code still ships to every customer, just harder to read. It buys
   very little (anyone can read a bundle) and costs the audit story that justifies the architecture.

**Recommendation: option 1.** What stays private is everything that is genuinely private and is *not*
in this list: the research corpus, the reports, the economics and ledger logic, the ingest and tenancy
code, the billing model, and the business material. That is the great majority of the repository.

If option 1 is not acceptable, say so before the repository is created — the architecture question has
to be reopened rather than worked around, because a private action cannot be `uses:`-referenced by a
third-party workflow at all.

### Must be scrubbed before publishing

Five files carry prose comments naming DentalPresence and describing internal measurements. No code
depends on them, but they name a private project and reference internal research:

- `src/repo/repo-config.ts:6`
- `src/repo/impact.ts:200`
- `src/planner/path-baseline.ts:10`
- `src/planner/test-command.ts:7`

Rewrite each to state the rule without naming the project it was learned from.

### Repository conventions

- **Name:** `diffci/diffci-action` (or `<owner>/diffci-action`). Not `DiffCI.com` — the public repo is
  the action, and its name is what customers read in their own workflow file forever.
- **Branch protection and required review on `main`.** This repository is executable code in every
  customer's CI; a push to it is a push into their pipeline.
- **Tag releases, but pin by SHA.** Tags are for humans reading a changelog. `DIFFCI_ACTION_REF` takes
  the SHA, and `src/ingest/action-ref.ts` refuses anything else.
- **Verify before pinning:** the SHA set in `DIFFCI_ACTION_REF` must be a commit that is actually on
  `main` of the public repository and has been reviewed. Nothing in DiffCI can check that for you —
  the parser proves the ref is immutable, not that it is *the right* immutable thing.

---

## 3. The product GitHub App

Manifest prepared at [`ops/github-app/diffci-product-app-manifest.json`](../ops/github-app/diffci-product-app-manifest.json).
**Not registered.**

### Permissions — least privilege

| Permission | Level | Why |
|---|---|---|
| Metadata | Read | Mandatory for any App. It is also all that is needed. |

That is the entire list, and it is worth dwelling on. The product App does **not** need Contents,
Actions, Checks, or Pull requests — because DiffCI never reads the customer's code from GitHub. The
observer runs on their runner, against a checkout they already have, and pushes a report. The App exists
only to establish *which repositories an organization owns* and to be told when that changes.

This is a strictly smaller permission set than the Shadow App's five read scopes, and it is the concrete
payoff of the client-side architecture. If a future feature needs Contents, that is a re-consent event
for every installation and should be treated as a significant decision, not a settings tweak.

### Events

| Event | Why |
|---|---|
| `installation` | `created` parks a new installation (B3); `deleted`/`suspend` triggers the erasure promised on the data-handling page. |
| `installation_repositories` | Repositories added to or removed from an existing installation. |

No `push`, no `pull_request`, no `workflow_run`. DiffCI learns about CI runs from the report its own
action sends, not by watching the repository.

### URLs

| Field | Value |
|---|---|
| Homepage | `https://diffci.com` |
| Webhook | `https://app.diffci.com/v1/webhooks/github/installation` |
| Setup URL | `https://app.diffci.com/app/install/callback` |
| Callback (OAuth) | `https://app.diffci.com/auth/github/callback` |

`setup_on_update: false` — the setup URL fires on install, not on every permission change.
`request_oauth_on_install: false` — login is a separate OAuth app flow; combining them would ask for
more at install time than the install itself needs.

### Registration steps (for the account owner)

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**. Use the manifest above as
   the source of truth for every field.
2. "Where can this App be installed?" → **Any account**.
3. Generate a private key. GitHub downloads **PKCS#1**; Web Crypto needs **PKCS#8**:
   ```bash
   openssl pkcs8 -topk8 -nocrypt -in diffci.*.private-key.pem -out diffci-product-pkcs8.pem
   ```
4. Set the webhook secret to a fresh random value — **not** the Shadow App's.
5. Store the secrets on the product Worker (see §4), then delete the local key files.
6. Note the App **slug** from its public URL; it becomes `GITHUB_APP_SLUG` and the site's install link.

### Keep it separate from Shadow

The Shadow App stays exactly as it is, pointed at the research Worker. Do not add product permissions to
it, do not repoint its webhook, and do not reuse its key or webhook secret. The two Apps have different
blast radii and different data-deletion semantics, and an incident in one should never require reasoning
about the other.

---

## 4. Secrets and configuration to set (values never handled here)

Run each and paste the value at the prompt:

```bash
npx wrangler secret put GITHUB_APP_ID --config wrangler.product.jsonc
npx wrangler secret put GITHUB_APP_SLUG --config wrangler.product.jsonc
npx wrangler secret put GITHUB_APP_WEBHOOK_SECRET --config wrangler.product.jsonc
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID --config wrangler.product.jsonc
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET --config wrangler.product.jsonc
npx wrangler secret put CSRF_SECRET --config wrangler.product.jsonc
```

The private key comes from a file rather than a prompt:

```bash
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config wrangler.product.jsonc < diffci-product-pkcs8.pem
```

`DIFFCI_AGENT_ARTIFACT` is **not** a secret — it is a plain var in `wrangler.product.jsonc`, and it must name an
exact version with an integrity hash. Anything else and onboarding refuses.

Verify without exposing anything:

```bash
curl -s https://app.diffci.com/health
```

Every flag should read true: `githubOAuthConfigured`, `csrfConfigured`, `githubAppConfigured`,
`githubAppWebhookConfigured`, `agentArtifactPinned`. `billingConfigured` may stay false — nothing in
onboarding depends on it (see `src/billing/repository-admission.ts`).

---

## 5. What is still blocked after all of the above

- **`DIFFCI_ENVIRONMENT_LABEL` is `"staging"`** while `DIFFCI_ENVIRONMENT` is `"production"`. Confirmed
  presentation-adjacent only: its single use is `buildRunnerResourceTags`, tagging Cloudflare runner
  containers for cost attribution. It never renders in the console and gates nothing. Fix it for
  accurate cost attribution, not for safety.
- **Shadow mode is observation-only and must stay that way** until an execution phase exists with its
  own consent surface. Nothing in this phase changes that, and nothing should.
- **The first external repository is still the binding constraint.** All of the above is preparation for
  a conversation with a person, which is the actual next step.
