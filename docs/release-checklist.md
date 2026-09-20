# Release checklist

Use this checklist for releases of the DiffCI Core npm package, especially any release used for
Tidelift recognition.

## Preconditions

- Working tree is clean except for the intended release changes.
- `package.json` version matches the intended tag.
- DiffCI Core remains `AGPL-3.0-only`.
- Commercial DiffCI remains proprietary and outside the OSS package boundary.
- `LICENSE`, `SECURITY.md`, `SUPPORT.md`, and `COMMERCIAL.md` are current.

## Local checks

```bash
npm run check
npm run check:oss-boundary
npm run package:smoke
```

## Publish

Publishing is handled by `.github/workflows/release.yml` on a pushed Git tag.

```bash
git status --short
git tag v0.1.4
git push origin v0.1.4
```

The release workflow publishes with npm provenance. A stable tag publishes to `latest`; a prerelease tag
such as `v0.1.4-alpha.1` publishes under the `alpha` dist tag without deleting the stable `latest` tag.
Use the version actually qualified for the release; do not reuse an existing tag.

## Post-release verification

```bash
npm view @diffci.com/diffci version license dist-tags
npx @diffci.com/diffci@latest version
npx @diffci.com/diffci@latest observe --help
```

Record the release, npm URL, Git tag, and package smoke result in the release issue.
