# DiffCI search release checklist

Use this checklist after deploying changes under `site/`. Account-level steps are intentionally separate from the build so a local test cannot mutate search or package services.

## Before deployment

1. Run `npm run site:sitemap`.
2. Run `npx "@diffci.com/diffci@latest" check` and the repository's normal `npm run check` validation.
3. Confirm `site/sitemap.xml` contains every canonical, indexable HTML page and only meaningful `lastmod` dates.
4. Confirm the deployed response includes `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`.

## After deployment

1. Submit the sitemap with `npm run site:indexnow`.
2. In the Google Search Console Domain property for `diffci.com`, submit `https://diffci.com/sitemap.xml`.
3. Use URL Inspection on the homepage, primary guides, comparison page, and open evidence study. Request indexing after the live test succeeds.
4. Check Pages and Core Web Vitals after Google has recrawled the release.
5. Inspect Cloudflare request logs for Googlebot fetches and unexpected non-200 responses.

## Package metadata

The npm registry only receives `homepage`, `description`, and keyword changes when a new package version is published. Before the next release:

1. Confirm `package.json` points `homepage` to `https://diffci.com/`.
2. Confirm `package.json`, `release-manifest.json`, the lockfile, and server metadata use the intended new version.
3. Publish through the normal qualified release process.
4. Run `npm view "@diffci.com/diffci" homepage description version --json` and confirm the registry values.

Do not republish an existing npm version merely to change metadata; npm package versions are immutable.
