# OSS Boundary

DiffCI has two source boundaries:

- **OSS core**: the installable observation-only GitHub Action and npm CLI, published as
  `@diffci.com/diffci`. This is the public dependency surface for third-party repositories and is
  licensed AGPL-3.0-only.
- **Proprietary/control-plane source**: hosted product, research, shadow orchestration, runner,
  billing/ledger/usage, installation, auth, site, and operational deployment code.

The npm package must contain only the OSS core:

- `action.yml`
- `dist-client/src/client/`
- `dist-client/src/git/`
- `dist-client/src/planner/`
- `dist-client/src/repo/`
- `LICENSE`
- `SECURITY.md`
- `SUPPORT.md`
- `COMMERCIAL.md`
- public README/distribution docs

It must not contain source or build output from `src/product`, `src/research`, `src/shadow`,
`src/usage`, `src/ledger`, `src/install`, `src/runner`, `src/auth`, `src/analysis-fanout`,
`src/validation-env`, `ops`, `site`, `wrangler.*`, private research/evidence docs, or any secret,
token, customer, billing, ledger, or proprietary material.

The boundary is enforced by:

```bash
npm run check:oss-boundary
npm run package:smoke
```

Release CI runs both checks before `npm publish`. Any future code movement must preserve this split:
shared code may move into the OSS core only when it is safe to publish, has no private control-plane
dependencies, and is intended to be part of the public dependency surface.
