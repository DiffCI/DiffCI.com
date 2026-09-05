# GitHub OAuth App registration for the dashboard (done 2026-09-05)

The dashboard at `https://app.diffci.com/app` signs users in with a GitHub **OAuth App** (login only,
scopes `read:user user:email`). This is separate from the `diffci-shadow` GitHub **App**, which is the
installation that observes repositories. Registered by the founder on 2026-09-05; recorded here so the
steps are reproducible for another environment.

## Registration (GitHub UI, once)

1. https://github.com/settings/developers → OAuth Apps → **New OAuth App**.
2. Application name `DiffCI`; Homepage URL `https://diffci.com`;
   Authorization callback URL `https://app.diffci.com/auth/github/callback`; Device Flow off.
3. Register, copy the **Client ID**, generate and copy a **client secret** (shown once).

## Secrets on the product Worker (terminal, values never pasted into chat or committed)

```bash
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID --config wrangler.product.jsonc
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET --config wrangler.product.jsonc
npx wrangler secret put CSRF_SECRET --config wrangler.product.jsonc   # value from: openssl rand -base64 32
npx wrangler secret put RESEARCH_DISPATCH_TOKEN --config wrangler.product.jsonc   # same value as the research Worker's
```

`RESEARCH_DISPATCH_TOKEN` authenticates the dashboard's call to the research Worker's
`/v1/shadow/report-access` route over the `RESEARCH_WORKER` Service Binding (wrangler.product.jsonc).

## What sign-in unlocks

After sign-in the dashboard home lists every enrolled repository GitHub confirms the user can access
(collaborator check with the Shadow App's installation token - `src/research/cloudflare/shadow-report-access.ts`),
with a private repository's tokenised report link. GitHub's answer decides; an unanswered check is shown
as "could not check", never as access and never as "no repositories".
