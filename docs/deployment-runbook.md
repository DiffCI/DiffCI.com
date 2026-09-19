# Deployment runbook — phases 02 to 05

**Date:** 2026-08-26 · **Covers:** everything built in phases 02–05, in the order it actually has to
happen. Each phase's own document explains *why*; this one is the sequence, the verification after each
step, and the point at which to stop.

Read the stop conditions before starting. Three of the eight stages depend on somebody else's
repository or somebody else's money, and the failure mode that matters is not a broken deploy — it is a
pilot participant discovering DiffCI changed something in their CI.

## Dependency order

```
0. Commit and push            ── nothing below is possible from an uncommitted tree
1. Control plane deployed     ── console, ingest endpoint, ledger, invoices
2. Observer GitHub App        ── repository discovery + erasure on uninstall
3. Action published + pinned  ── first real run of action.yml, on our own repo
4. Ingest wired end-to-end    ── our own observations reaching our own console
5. Third-party pilot, 7 days  ── Phase 02's exit criterion (needs consent)
6. A real month               ── Phase 04's exit criterion (needs stage 5 running)
7. An invoice                 ── Phase 05's exit criterion (needs stage 6)
```

Stages 0–4 are entirely under your control and can be done in an afternoon. Stage 5 is the one that
needs another human. Stages 6 and 7 are mostly waiting.

---

## Stage 0 — commit, push, and decide on visibility

Everything from phases 02–05 is currently uncommitted. Nothing else in this runbook works until it is
pushed, because `uses: DiffCI/DiffCI.com@v1` and SHA-pinned installs resolve against what GitHub has.

```bash
npm run check
```

Expect **1,555 passing, typecheck clean**. Then commit and push to `main`.

**Decision:** the public Action surface is `DiffCI/DiffCI.com@v1`. A third-party repository's runner
must be able to check out this repository. For security-sensitive pilots, replace `v1` with a full
commit SHA from this repository.

---

## Stage 1 — deploy the control plane

### 1.1 Apply the schema

```bash
npm run product:migrate -- --remote
```

Nine files in a fixed order; the last two are new (`src/ingest/cloudflare/schema.sql`,
`src/billing/cloudflare/schema-metered-invoices.sql`). Every statement is `IF NOT EXISTS`, so re-running
is safe.

**Verify:** the command exits 0 and names all nine files.

### 1.2 Set secrets

```bash
npx wrangler secret put CSRF_SECRET --config wrangler.product.jsonc
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID --config wrangler.product.jsonc
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET --config wrangler.product.jsonc
```

`CSRF_SECRET` is not optional here even though the code tolerates its absence: without it the CSRF check
is inert and every state-changing console button still works, which is fine locally and wrong in
production. Generate with `openssl rand -base64 32`.

The GitHub **OAuth App** (sign-in) is separate from the GitHub **App** in stage 2. Its callback URL is
`<origin>/auth/github/callback`.

### 1.3 Deploy

```bash
npm run product:deploy
```

### 1.4 Verify

```bash
curl -s https://<worker-origin>/health
```

Expect `productDbReachable: true`, `authConfigValid: true`, `csrfConfigured: true`,
`githubOAuthConfigured: true`, `environment: "production"`. `githubAppConfigured` and `actionRefPinned`
will still be `false` — that is stages 2 and 3.

**Stop if** `environment` is not `production`, or the Worker refuses all requests: `parseAuthConfig`
throws by design when `DIFFCI_ALLOW_DEV_HEADER_AUTH` is combined with production, and that is the one
misconfiguration that must never be worked around.

### 1.5 Walk the front door yourself

Open `https://<worker-origin>/app`, sign in with GitHub, create an organization. This is the first time
the self-serve path runs against real infrastructure rather than a test double.

**Verify:** you land on `/app/orgs/<id>`, and the page says the GitHub App is not configured in this
environment — correct, and stage 2's job.

---

## Stage 2 — register the observer GitHub App

This is a **third** App, separate from the read-only Shadow App and the write-scoped Runner Dispatcher.
Do not extend either of those: they exist to be separately revocable.

### 2.1 Create it

- **Permissions:** repository **Metadata: read-only**, and nothing else. Everything DiffCI analyses
  happens on the customer's own runner; the App exists to know which repositories exist and to hear when
  one is removed.
- **Subscribe to events:** `installation`, `installation_repositories`.
- **Setup URL:** `https://<worker-origin>/app/install/callback` — tick "Redirect on update".
- **Webhook URL:** `https://<worker-origin>/v1/webhooks/github/installation`, with a webhook secret.
- **Where can this be installed:** any account.

### 2.2 Convert the private key

GitHub downloads PKCS#1. Web Crypto only imports PKCS#8:

```bash
openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out diffci-app-key-pkcs8.pem
```

### 2.3 Configure and redeploy

`GITHUB_APP_SLUG` goes in `wrangler.product.jsonc` `vars` (it is public — it is in the install URL). The
other three are secrets:

```bash
npx wrangler secret put GITHUB_APP_ID --config wrangler.product.jsonc
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config wrangler.product.jsonc   # paste the PKCS#8 PEM
npx wrangler secret put GITHUB_APP_WEBHOOK_SECRET --config wrangler.product.jsonc
npm run product:deploy
```

**Verify:** `/health` reports `githubAppConfigured: true`, `githubAppWebhookConfigured: true`.

### 2.4 Install it on your own repositories first

From `/app/orgs/<id>`, click **Install the GitHub App**, grant it `DiffCI.com` only.

**Verify:** you are returned to the organization page and `DiffCI.com` is listed as `active` with its
default branch. Nothing about this flow has ever touched GitHub before — `connectInstallation` is tested
against injected repository lists — so this is where a real App JWT gets minted for the first time. If it
fails, the two known-real causes are a PKCS#1 key (step 2.2) and a missing `User-Agent` header, which
`github-app.ts` and `github-installation.ts` both already set.

### 2.5 Prove the erasure path before anyone relies on it

Uninstall the App from `DiffCI.com`, then re-install it.

**Verify:** the repository's status goes to `removed` (and any observations for it are deleted, though
there are none yet), then back to `active` on re-install. If the webhook never arrives, check GitHub's
"Recent Deliveries" tab — a 401 there means the webhook secret does not match, and DiffCI is correct to
refuse it: that route's whole purpose is to erase data.

---

## Stage 3 — publish and pin the action

### 3.1 Pin

Take the commit SHA of `main` after stage 0 and set it:

```jsonc
// wrangler.product.jsonc, vars
"DIFFCI_ACTION_REF": "DiffCI/DiffCI.com@<40-hex sha>"
```

```bash
npm run product:deploy
```

**Verify:** `/health` reports `actionRefPinned: true`, and a repository's set-up page no longer shows the
"not pinned" warning.

### 3.2 First real run of `action.yml`

The self-observation workflow (`.github/workflows/diffci-observe.yml`) already exists and uses `./`, so
this happens on the next push to `main`. **`action.yml` has never executed on a runner** — its steps were
reproduced locally, but `setup-node`, the artifact upload and the composite wiring have not run.

**Verify, on that run:**
- the `Observe this repository` job is green (or, if it fails, the `check` job is still green and the
  workflow conclusion is unaffected — that is `continue-on-error` doing its job);
- the job summary shows `DiffCI observation: OBSERVED`, a selection, a comparator, and
  `non-interference: worktree unchanged`;
- an artifact named `diffci-self-observation` is attached;
- total job time is roughly `npm ci` (~11s) + build (~3s) + analysis (a few seconds for this repo).

**Stop if** the job summary reports `worktree CHANGED` or `report written INSIDE the checkout`. Both mean
the observer touched something it must not, and neither should ever be seen.

---

## Stage 4 — wire ingest end-to-end, on your own repository

1. In the console, open `DiffCI.com` → **Create token**. Copy it once.
2. Add it to `DiffCI.com` as an Actions secret named `DIFFCI_TOKEN`.
3. Add the two inputs to `.github/workflows/diffci-observe.yml`:

```yaml
      - uses: ./
        with:
          artifact-name: diffci-self-observation
          api-url: https://<worker-origin>/v1/ingest/observations
          api-token: ${{ secrets.DIFFCI_TOKEN }}
```

**Verify:** the next run's summary ends with `delivery: sent`, and the observation appears at
`/app/orgs/<id>` within seconds. Re-run the same job: the summary should say
`sent (already recorded — a re-run or retry of the same observation)`, and the console must still show
**one** observation for that commit.

**Stop if** delivery reports `rejected (repository_mismatch)` — that means the numeric repository id the
token was issued for does not match the one the runner reported, and the token is pointed at the wrong
repository.

At this point every mechanical part of phases 02–05 has run at least once against real infrastructure.
Everything after this needs other people.

---

## Stage 5 — the third-party pilot (Phase 02's exit criterion)

**Seven days in a repository that is not ours, with its owner's agreement.** Not a fork, not a public
repository observed from outside.

### Before the window opens

1. **Get explicit consent**, in writing, naming: what leaves their runner (one JSON document per run —
   show them a real one from stage 4), where it goes, how long it is kept (90 days maximum), and how to
   stop (revoke the token, or uninstall the App, which deletes everything for that repository).
2. **They install the App** themselves and mint their own token from their own console session. You
   should never hold their credential.
3. **Check their workflow before it runs:**

```bash
git clone <their repo> /tmp/pilot && npm run verify-workflow -- --repo /tmp/pilot
```

Must exit 0. A `BLOCKING` finding means the installation as written *can* affect the rest of their CI —
fix the workflow, not the checker.

4. **Record the before-state**: for the last ~20 runs of their main workflow, the set of jobs, their
conclusions and their durations. This is the baseline the byte-identity claim is checked against.

### During

Check daily for the first three days, then every other day:
- every observation's `worktreeUnchanged` is true (visible per row in the console);
- no observation has blocking workflow findings;
- their build jobs' conclusions and durations are unchanged against the before-state;
- refusals are refusals, not errors — `REFUSED (context)` with `fetch-depth: 0` in the message means
  their checkout is shallow, which is a configuration fix, not a defect.

### Stop conditions — pull the plug, do not debug in place

Revoke the token first (immediate, one click), then investigate:
- any run where `worktreeUnchanged` is false;
- any change to another job's conclusion that correlates with the DiffCI job;
- any complaint about CI slowdown that is not explained by the observation job's own isolated runtime;
- an ERROR rate above roughly one in ten runs — an observer that crashes regularly is not one to leave
  installed for a week.

---

## Stage 6 — a real month (Phase 04's exit criterion)

Let stage 5 keep running. At month end, open `/app/orgs/<id>/ledger`.

**Expect, and do not be surprised by:**
- `countTier: MEASURED`, `timeTier: UNKNOWN` — counts are real, money is not, and cannot be while DiffCI
  only observes;
- possibly a **negative** total. On the four-commit sample across `h3`, `immer` and `execa`, the net was
  −106 against the honest comparator while "vs full suite" would have read +161;
- at least one repository showing `nothing to skip`. That is the honest zero, and it is a result.

**Verify:** every observation in the month is accounted for — `comparable` plus `notComparable` equals
`observations` on every row, and the not-comparable reasons are ones you recognise.

---

## Stage 7 — an invoice (Phase 05's exit criterion)

```bash
curl -s -X POST https://<worker-origin>/v1/organizations/<id>/invoices \
  -H 'Content-Type: application/json' -b '<session cookie>' -d '{"month":"YYYY-MM"}'
```

or the **Prepare this month's invoice** button in the console.

**Expect $0.00.** Every line will say why: either the money basis is not MEASURED, or there were no net
savings, or DiffCI would have run more. Reconcile it (`Reconcile line by line`) and confirm it reports
`Reconciled: every line recomputes to exactly what was invoiced`. Issue it. Send it to the pilot
participant as what it is — a statement of a measured month that charges nothing.

**A non-zero invoice requires a MEASURED money figure, which requires executing the selected subset and
timing it — that is, leaving observation-only mode.** That is a product decision with a safety case
attached, and it is not in any of these phases. Until then, `$0.00` is the honest output, and issuing it
is still worth doing: it exercises the whole path and gives the customer something to check.

---

## Rollback, per stage

| Stage | To undo | Effect |
|---|---|---|
| 4–5 | Revoke the ingest token in the console | Their CI keeps observing locally; nothing more is sent. Artifacts still attach. |
| 4–5 | They delete the workflow file | Observation stops entirely. Nothing else in their CI changes. |
| 2–5 | They uninstall the App | Repositories marked `removed`, their observations **deleted**, their tokens revoked. Irreversible. |
| 6 | `DELETE /v1/organizations/:id/observations` | Erases the organization's observations. An issued invoice survives and will then report `ledgerChanged` on reconciliation. |
| 7 | Void the invoice | Only possible while unpaid. A paid invoice cannot be voided — issue a correcting one. |
| 1 | Redeploy the previous Worker version | Schema changes are additive `IF NOT EXISTS`; no down-migration exists or is needed. |

## Things that have actually bitten this project

Not hypotheticals — each of these cost a debugging session already, and every one is now handled in code:

- **PKCS#1 vs PKCS#8.** GitHub's downloaded key will not import. Convert it (2.2).
- **Missing `User-Agent`.** GitHub's API firewall returns 403 with no useful message for any request
  without one.
- **`fetch-depth: 1`.** The base commit simply is not in the checkout, and the resulting error reads like
  a DiffCI bug. The observer refuses with the fix in the message instead.
- **Anything written into the workspace** changes `git status` and can fail a repository's clean-tree
  check. The report goes to `RUNNER_TEMP`; an in-tree `--out` is refused.
- **This account's GitHub Actions billing is blocked.** Own-repo CI runs on the Cloudflare-backed
  self-hosted fleet (`[self-hosted, cloudflare]`); a pilot participant's repository will use their own
  runners, which is unaffected.
- **A Worker cannot `fetch()` another Worker's `workers.dev` URL** (error 1042). Service bindings only.

## What is still unproven, going in

- `action.yml` has never run on a runner (stage 3 is the first time).
- The App flow has never talked to GitHub (stage 2.4 is the first time).
- The 90-day retention sweep has never run against real data, because no real observation has been
  ingested yet.
- No invoice has ever been paid, because none has ever been non-zero.
