# Public analyzer and hosted runtime hardening

Implemented September 25, 2026. This describes code in the checkout, not a production deployment or an arbitrary-repository execution guarantee.

## Public diagnostic

The product Worker serves `/analyzer`. Its versioned consent form submits to `POST /v1/public-analyzer/jobs`. This is a bounded compatibility check: public GitHub root metadata and up to three manifests at a pinned commit. It never clones a repository, installs dependencies, runs commands, uses GitHub credentials, or claims measured savings. Nested projects, dependency graphs and CI correctness require local diagnosis.

The service accepts only GitHub owner/repository identifiers. Redirects are refused, reads share a 20-second deadline, responses are capped at 128 KiB, decoded manifests at 64 KiB, and each attempt makes at most six upstream requests. Unknown/private repository visibility fails closed. Untrusted commands are neither executed nor reflected into the report.

Admission requires explicit `public-metadata-v1` consent. Durable SQLite jobs have 60-second leases and at most two attempts. Limits are shared across Worker instances: three submissions per anonymous client per hour, eight admissions and eight upstream attempts globally per hour, ten active jobs, and twenty authorized polls per job per minute. The low global limit is intentional for the initial pilot. GitHub's shared unauthenticated quota can still cause upstream refusal.

Job access and deletion require a random bearer token; only its hash is stored. The page keeps the token in memory. Refreshing loses access. Results are never publicly listed or cached, expire logically after 24 hours, and are physically purged by the next successful ten-minute scheduled sweep. Cleanup continues when new admissions are disabled. Expired leases recover through the same sweep; late completions cannot recreate deleted jobs. Client counters use daily rotating keyed identifiers, not stored raw IP addresses.

## Runtime changes

- Observation uploads use streaming byte caps and authenticated per-repository shared rate limits (120/minute). Invalid, future or older-than-90-day analysis timestamps are refused. Retention considers both arrival and analysis time.
- Database inserts recheck repository ownership and active state atomically. Uninstall marks repositories inactive before revocation/deletion so concurrent uploads cannot recreate evidence.
- Unknown repository privacy is private by default, without an accessible token until classification. Removed repositories are denied report access. Reports use `no-store` and `no-referrer` headers.
- GitHub removal webhooks await research erasure before acknowledgment. Individual removals are restricted to repositories attributed to that installation. Failed deletion keeps attribution for retry; research evidence writes and automatic state updates are fenced after removal. Late R2 uploads are deleted when their database write is refused by removal.
- Runner scheduling atomically claims organization capacity, counts attempts at claim time, stops at its retry limit, and scopes HTTP-triggered scheduling to the authenticated organization. Assignments abandoned for fifteen minutes become terminal timeouts; late provisioning cannot revive them. Known late allocations are terminated, and failed termination stays eligible for orphan cleanup. Cleanup failures do not block observation retention.
- Session mutations require configured CSRF verification. Existing runner tokens, command policy and synthetic-only execution scope remain in force.

## Deployment sequence

1. Apply product migrations, including `src/hosted/schema.sql` and the fleet evidence-policy schema, using `npx tsx scripts/migrate-product-db.ts --remote` with the intended Cloudflare account.
2. Configure an independent random `ANALYZER_RATE_SECRET` using Wrangler secret management; ensure `CSRF_SECRET` is configured. Never put secret values in source control.
3. Deploy the research Worker and product Worker together so removal forwarding reaches an implementation that awaits erasure. Preserve the existing research deployment/source-integrity procedure. Product configuration leaves `DIFFCI_PUBLIC_ANALYZER_ENABLED=false` until readiness is checked.
4. Enable `DIFFCI_PUBLIC_ANALYZER_ENABLED=true` for the intended environment and verify a consenting public test repository end to end: result retrieval, wrong-token denial, deletion, expiry/cron recovery, throttling, and removal/retry behavior. Verify private report cache headers and unrelated-tenant denial. Verify container teardown in the real provider.
5. Monitor scheduled cleanup failures and failed GitHub deliveries; replay failed removals after resolving storage failures. Disable analyzer admissions with the flag if needed; cleanup continues.

These changes do not certify general hostile-code sandboxing, production load capacity, a support SLA, or achieved user adoption. Arbitrary customer CI execution needs its own execution-consent and sandbox validation before being offered. R2/D1 are separate services, so crash recovery and object-lifecycle policy must also be verified in deployment; unit tests cannot prove infrastructure erasure or provider termination.
