# Release checklist

Use this checklist for releases of the `@diffci.com/diffci` npm package. The Core engine is
maintained in [DiffCI/core](https://github.com/DiffCI/core) and bundled from a pinned Git commit;
there is no separate Core npm release.

## Preconditions

- Working tree is clean except for the intended release changes.
- `release-manifest.json`, `package.json`, `package-lock.json`, and `server.json` match the intended tag.
- Every public Action example uses the release manifest's full commit SHA.
- DiffCI Core remains `AGPL-3.0-only` and the pinned commit has passed its CI checks.
- Commercial DiffCI remains proprietary and outside the OSS package boundary.
- `LICENSE`, `SECURITY.md`, `SUPPORT.md`, and `COMMERCIAL.md` are current.

## Local checks

```bash
npm run check
npm run check:oss-boundary
npm run package:smoke
npm run check:public-metadata
```

## Publish

Publishing is handled by `.github/workflows/release.yml` on a pushed Git tag.

```bash
git status --short
git tag v<version>
git push origin v<version>
```

The release workflow bundles Core, publishes the CLI with npm provenance, creates the matching GitHub
release, and verifies npm, GitHub About, the release, and Marketplace. A stable tag publishes to
`latest`; a prerelease tag such as `v<version>-alpha.1` publishes under the `alpha` dist tag without deleting the stable `latest` tag.
Use the version actually qualified for the release; do not reuse an existing tag.

After npm publication, run the protected `Publish MCP Registry listing` workflow from `main` and approve
its `mcp-registry-publish` environment deployment. Registry OIDC is intentionally main-only; tag workflows
must not attempt to enter that environment.

## Post-release verification

```bash
npm view @diffci.com/diffci version license dist-tags
npx "@diffci.com/diffci@latest" version
npx "@diffci.com/diffci@latest" observe --help
npm run check:public-metadata -- --remote
```

Record the release, npm URL, Git tag, and package smoke result in the release issue.
