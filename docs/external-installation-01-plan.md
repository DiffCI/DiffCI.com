# FROZEN — EXTERNAL_INSTALLATION_01

**Written before a single line of the repair**, per the same discipline every phase in this thread has
used — but this freeze's first job is different from every phase before it. The prior six phases each
traced a defect inside a mechanism already wired into a running system. This one starts by tracing whether
the *wiring itself* exists at all, because the success criterion — a repository DiffCI's team does not
own can install, trigger analysis from its genuine CI configuration, and receive a truthful result without
manual intervention — presupposes a path from "external install" to "the CI-reproduction engine runs."

## The trace — done, and it changes the shape of this phase

**There are three GitHub Apps. None of them is the CI-reproduction engine.**

| App | Live? | Installable by | What it actually does |
|---|---|---|---|
| DiffCI Runner Dispatcher | yes, registered | DiffCI.com + DentalPresence.in only | Spins up ephemeral self-hosted Actions runners for DiffCI's own two repos' CI. Unrelated to analysing anyone's code. |
| DiffCI Shadow | yes, registered, real webhooks flowing | "any account" | On `push`, clones the repo in a Cloudflare Sandbox container, builds a dependency graph, predicts a CI-skip plan, reconciles it against real CI outcome on `workflow_run`. This is the change-aware impact/skip predictor (`src/client/observe.ts`'s engine — `src/repo/graph.js`, `src/repo/impact.js`, `src/planner/test-command.js`) - a **different engine** from `src/ci-inference/`. `pull_request` events are explicitly acknowledged and dropped ("PR-delta shadow support is a designed-but-not-built follow-up"). |
| "DiffCI" (product/observer App) | **never registered** — no `GITHUB_APP_ID`/private key configured anywhere | `public: true` in its manifest, but nothing to install | `product-worker.ts` has a real, tested-in-isolation OAuth install flow, org/tenancy model, and an ingest API behind it — genuinely well-built. Its own design doc states plainly: "The App flow has never touched GitHub... no App is registered, so no App JWT has been minted, no installation token exchanged, and no real delivery received." Every route that needs `GITHUB_APP_ID` returns `503` today. |

**`src/ci-inference/` and `scripts/ci-reproduction.ts` — the engine every phase in this thread has been
repairing — has no webhook, no GitHub App, no public API route, and no wiring from `product-worker.ts` at
all.** `analysis-fanout` and `validation-env` (the two Cloudflare systems that actually run it) are both
explicitly bearer-token-gated internal control surfaces with "no custom-domain route... not a public
product surface" stated in their own `wrangler*.jsonc` comments. The only caller of either, anywhere in
the repo, is a CLI script invoked by hand — precisely the harness this entire thread's testing has used
all along (`scripts/diffci-validation-cli.ts`, driven by curl commands with a bearer token, exactly as
every `REGRESSION_*`/`ACTION_INPUT_MODELING_01`/`TAP_PARSING_01`/`GROUND_TRUTH_CONSISTENCY_01` verification
in this thread was actually run).

**This is the installation-level blocker the budget explicitly allowed for** ("assuming no
installation-level blocker appears"). It appeared at the very first step. Restated plainly: there is
currently no path by which any external repository's install/webhook event could ever reach the engine
this thread has spent six phases hardening. One has to be built — not merely unblocked.

## What this means for the plan

The original five-line budget table assumed "trace the path" would surface friction inside an existing
pipeline (an auth scope, a missing permission, a webhook that drops an event type — the same *shape* of
finding as `ACTION_INPUT_MODELING_01`'s `nick-fields/retry` gap). It does not: the pipe does not exist.
The remaining budget has to build the minimum real connection, not repair one.

**Two candidate ways to build it, weighed against each other rather than assumed:**

- **(A) Extend the Shadow App's existing pipeline.** Already registered, already "any account"
  installable, already receiving real signed webhook deliveries from real installs, already running a
  Cloudflare Sandbox container per enrolled repo on `push`. Add a new step to that SAME container run
  (or a new triggered path alongside it) that invokes `ci:reproduce` against the repo's real HEAD and
  its real `.github/workflows/`, and surfaces the result. The install click, the webhook signature
  verification, the container mechanics, and the "any external account can do this" property are all
  already proven — nothing about them needs revalidating.
- **(B) Finish and register the unregistered "DiffCI" product App.** Real, well-tested code, but has
  *never* exchanged a byte with real GitHub — no App JWT minted, no installation token exchanged, no
  signed delivery received, ever. Registering it and discovering what breaks on first real contact is
  itself a materially sized, currently-unbounded task, on top of still needing to wire the engine into it
  afterward (`product-worker.ts` has zero references to `ci-inference`/`ci-reproduction` today).

**(A) is the recommended path.** It reuses infrastructure already proven against real, external GitHub
installs — the exact kind of "demonstrated" blocker-fixing the budget calls for — instead of validating a
second, larger, never-touched-real-GitHub system for the first time under a 2-4 day budget. (B) remains
the eventual home for a self-serve multi-tenant product; it is not a precondition for a truthful first
external pilot. This is a recommendation, not a decision made unilaterally here — flagged for confirmation
before any implementation begins, per this thread's own established rhythm.

## Redefined success criterion, exactly as directed

The pilot succeeds if the *path* is truthful, not if the *verdict* is flattering:

- `REPRODUCED`, `PARTIAL_REPRODUCTION`, `UNVERIFIABLE`, `GROUND_TRUTH_CONTRADICTED`, `REFUSED`,
  `ENVIRONMENT_INADEQUATE`, or an explicit "this repository's shape is not yet supported" refusal are all
  legitimate, acceptable outputs.
- What cannot happen: silent misclassification, hidden execution substitution (running something other
  than what the repository's own workflow declares and reporting as if it were faithful), or requiring the
  DiffCI team to touch the external repository to make the analysis appear successful.
- The external repository owner must be able to see the result themselves — a check run, a PR/issue
  comment, or at minimum an API/dashboard URL they were given — without asking the DiffCI team to relay it
  by hand. Exactly which of these is in scope for the pilot is a decision for the implementation step
  below, not this freeze; the constraint is "the installer sees it unassisted," not a specific UI.

## Sequence, matching the user's own budget table

```
trace/freeze the installation path end-to-end                          (done, above — 0.5 day)
  → decide and confirm: extend the Shadow App pipeline (A), or
    register+wire the product App (B) — recommendation: A
    → fix only the demonstrated blockers this decision exposes:
      - wire ci:reproduce (or the analysis-fanout equivalent) into the Shadow container run
      - decide and implement the minimum result-delivery surface (check run / comment / API)
      - confirm the container has what ci:reproduce needs (network egress for git clone + npm install,
        matching validation-env's own environment-equivalence prerequisite from `5539155`)
                                                                          (0.5-1.5 days)
    → rehearse against a clean account/repo boundary — a throwaway repo under an account DiffCI's team
      does not otherwise use for development, proving the full path with zero implicit access before any
      real stranger's repo is involved                                  (0.5 day)
      → the first actual external repository                            (0.5 day)
        → freeze evidence                                                (buffer: 0-1 day)
```

## What this phase does not attempt

- Does not register or wire the separate product/observer App (option B) unless the confirmation step
  above chooses it instead of (A).
- Does not build the self-serve org/billing/tenancy console further — `product-worker.ts`'s existing work
  there is untouched, neither relied upon nor extended.
- Does not change `src/ci-inference/` or `scripts/ci-reproduction.ts` themselves — every phase through
  `GROUND_TRUTH_CONSISTENCY_01` already hardened the engine; this phase is exclusively about the path to
  reach it.
- Does not pre-select which external repository is first. That is a decision for the rehearsal/first-pilot
  steps, made with the same "no target named in advance by me" discipline
  `diffci-external-validation-authorized-2026-08-30` already established for a different research thread.
