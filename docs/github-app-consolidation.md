# GitHub App consolidation

DiffCI uses one public read-only App named **DiffCI** for repository discovery, installation lifecycle,
push observation, workflow reconciliation, and reports. Its permissions are Metadata, Contents,
Actions, and Checks, all read-only. Its events are installation, installation repositories, push, and
workflow run. The single webhook endpoint is `https://app.diffci.com/v1/webhooks/github`.

The product Worker handles installation lifecycle events itself. It forwards push and workflow-run
deliveries, including the original body and GitHub signature, through the existing `RESEARCH_WORKER`
service binding. The research Worker remains responsible for signature verification and analysis.

The former **DiffCI Shadow** App is a legacy installation only. Do not create new installations from
its manifest. Migration order:

1. Configure the unified App and product Worker with one App ID, private key, and webhook secret.
2. Configure the research Worker with the same `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and
   `GITHUB_APP_WEBHOOK_SECRET` so forwarded signatures verify and installation tokens come from the
   same App. The old `SHADOW_GITHUB_*` names remain temporary migration aliases.
3. Install the unified App on the repositories currently covered by DiffCI Shadow.
4. Confirm installation, push, and workflow-run deliveries reach their respective handlers.
5. Uninstall the legacy Shadow App only after those checks pass.

The write-scoped DiffCI Adoption App and runner-management Apps remain separate. Their permissions
must never be added to the unified read-only App.
