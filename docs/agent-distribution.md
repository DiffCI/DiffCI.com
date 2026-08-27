# How DiffCI reaches a customer

**Decision date:** 2026-08-27 · **Status:** built, nothing published

DiffCI is proprietary and source-private. It is **not** distributed as a third-party `uses:` GitHub
Action, and no public repository is created. The customer's workflow installs an authenticated,
version-and-integrity-pinned package and runs it.

## Why not a GitHub Action

A `uses: owner/repo@sha` step is resolved by the runner using the *workflow's own* `GITHUB_TOKEN`,
which is scoped to the customer's repository. It has no credential for a private repository of ours,
so the job fails at resolution. GitHub's private-Action sharing works within one organization or
enterprise, not across arbitrary third-party customers.

The two ways around that are both worse than not using an Action at all:

- **Customer checks it out with a PAT.** Every customer then holds a token that clones our repository —
  they get the source *and* we have distributed credentials.
- **Public repository with a committed bundle.** Works, and is the standard commercial-Action shape,
  but publishes the compiled implementation to the world rather than to customers.

`uses:` is ergonomics, not a requirement. Dropping it costs a little polish and buys not needing a
public repository at all.

## What is honestly true about this

The customer **receives the compiled implementation**. It is downloaded onto their runner and executes
there. Registry access control governs *who may download it*; it does not make downloaded code secret,
and a sufficiently motivated customer can reverse-engineer it.

What this buys is real but narrower than "secret":

- DiffCI's TypeScript source, comments, tests and research are never distributed.
- Distribution happens under commercial terms, so copying is a breach with a remedy.
- Access can be revoked per customer by revoking a token.

Any claim stronger than that should not be built on this architecture.

## The artifact and its identity

Built by [`scripts/build-agent.ts`](../scripts/build-agent.ts) (`npm run build:agent`).

| | |
|---|---|
| Package | `@diffci/observer` |
| Contents | `index.mjs` (minified bundle), `package.json`, `LICENSE`, `README.md` — **nothing else** |
| Size | ~29 KB packed, ~80 KB unpacked |
| Runtime dependencies | `typescript`, `yaml` — installed by npm from the public registry, never redistributed by us |
| External executable | `git`, always via `execFile` with an argv array, never a shell |

The build **fails** rather than shipping something wrong:

- `assertPackageContents()` — an allowlist. A new file in `dist-agent/` is excluded by default.
- `assertNoSourceLeakage()` — scans the built bundle for private project names, research paths,
  control-plane module paths, internal programme vocabulary, infrastructure hostnames, and any
  `sourceMappingURL`. A source map beside a minified bundle would republish the source in full.
- `copyLicence()` — refuses to build a proprietary artifact with no terms attached.

## The invariant that replaced the Action-SHA rule

The old rule was: *no 40-character public Action SHA, no onboarding.* That was the right property
expressed through the wrong noun, and it became unsatisfiable when distribution changed. It is now:

> No customer credential or installation instruction may be generated unless it identifies an
> **immutable, integrity-verifiable** DiffCI agent artifact.

Implemented in [`src/ingest/agent-artifact.ts`](../src/ingest/agent-artifact.ts) as a branded type:
`buildInstallInstructions` accepts a `PinnedAgentArtifact` and nothing else, and the only producer is
`parseAgentArtifact`. Generating a workflow from a range is not discouraged — it is unrepresentable.

Configuration is one environment variable, `DIFFCI_AGENT_ARTIFACT`:

```
npm:@diffci/observer@1.4.2#sha512-<base64>
oci:ghcr.io/diffci/observer@sha256:<64 hex>
```

Rejected, with a distinct reason each: `@latest`, `@next`, `^1.4.2`, `~1.4.2`, `1.x`, `>=1.4.2`, `*`,
an exact version with no integrity hash, an image addressed by tag, and anything malformed. Nothing is
resolved or repaired — expanding `latest` to whatever it points at today would enshrine an answer that
can differ from the one the customer's runner gets later, which is the same mutability problem wearing
a different hat.

Token issuance remains coupled to this and is checked **before** the credential is minted: handing
someone a live secret and then refusing to say what to do with it would leave them holding it and leave
an unrevoked row in the database.

## What the generated workflow does

Everything happens **outside the checkout**. `npm install --prefix "$RUNNER_TEMP/diffci"` and an
`.npmrc` written to `$RUNNER_TEMP`, never into the workspace — an install into the repository being
observed would create `node_modules` inside it and leave a credential file there, which changes the
thing DiffCI is measuring. The registry token is written by the shell from an environment variable, not
passed as an argument, because an argv is readable by every other process on the runner.

`verify-workflow` now recognises DiffCI invoked by `run:` as well as `uses:`, and checks the `run:`
form for mutable version specifiers. Without that it reported "no job runs DiffCI" for the product's
own generated installation — a clean result from a check that had examined nothing.

## Next: replace the long-lived registry token

A permanent `NPM_TOKEN` per customer should not be the permanent architecture. The intended flow:

```
DiffCI GitHub App installation
        → short-lived, installation-authenticated download
        → signed / checksummed agent
        → execute
```

The installation identity DiffCI already establishes (Phase 03) authorises the download, so the
customer manages one credential rather than two, and revocation follows uninstall automatically.

Sketch, in the order it would be built:

1. **Ingest token gains a scope** permitting `GET /v1/agent/download`. No new customer credential.
2. **The endpoint returns a short-lived signed URL** plus the artifact's digest, both derived from the
   installation, both expiring in minutes.
3. **A tiny bootstrap step** in the generated workflow fetches it, verifies the digest against the value
   in the workflow file, and executes. The digest stays in their repository, so the pin is still
   theirs to review — the invariant above is unchanged, only the `oci`/URL artifact kind is exercised.
4. **npm remains the fallback** for customers whose runners cannot reach the endpoint.

`parseAgentArtifact` was written as a discriminated union so this is a new artifact kind rather than a
rewrite of every call site.

## Registry: private npm. Decided 2026-08-27.

GitHub Packages may eventually give nicer identity integration — one GitHub identity authorising both
App installation and agent download. It is not worth waiting for. Changing the registry *and* the
authentication architecture at once is work that validates nothing, and the question that needs
answering first is whether a stranger can install DiffCI and get value from it.

Private npm with a granular, read-only, short-expiry token per customer answers that. The invariant
above is registry-neutral, so moving later costs a new artifact kind rather than a redesign.

## Gates before publishing anything

The package inspection is automated (`npm run inspect:agent`) and **currently fails**, which is the
correct state. It reads the packed tarball rather than the staging directory, because `npm pack` sits
between the two and those four files are literally the product.

| Gate | Owner | Status |
|---|---|---|
| Proprietary licence reviewed by a lawyer | you | **blocked** — `ops/agent/LICENSE` is a draft, and the inspector refuses to bless it |
| Real support and security contacts | you | **blocked** — placeholders in the package README |
| Final inspection of the `.tgz`, not the source tree | done | `npm run inspect:agent` |

## Sequence to first customer

1. Legal terms reviewed, into `ops/agent/LICENSE`.
2. Support and security contacts, into `ops/agent/README.md`.
3. `npm run build:agent && npm run inspect:agent` — must exit 0.
4. Register the npm organisation and the `@diffci` scope. Unregistered today: `npm view` returns 404.
5. Publish the exact version, restricted access.
6. Read the registry's integrity value for that published version.
7. Set `DIFFCI_AGENT_ARTIFACT` on the product Worker.
8. Register the product GitHub App ([manifest](../ops/github-app/diffci-product-app-manifest.json)).
9. Set the remaining Worker secrets.
10. Point `diffci.com` and `app.diffci.com` at their Workers, and update `DIFFCI_API_ORIGIN` **before**
    any customer workflow is generated — that value is baked into files in their repositories.
11. Dogfood the whole onboarding path as a stranger would.
12. First external repository.

**Not in this sequence: the server-side intelligence migration.** The client-side architecture has just
survived a packaging exercise that found four real defects. Get one end-to-end customer installation
working first, so the intelligence layer is designed against a real product protocol rather than an
imagined one.

## Also dead

No `diffci-action`. No public engine repository. No open-source DiffCI requirement. Customers receive
the proprietary compiled agent; the source stays private.
