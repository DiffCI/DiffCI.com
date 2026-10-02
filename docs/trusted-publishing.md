# npm Trusted Publishing

The release workflow is ready to publish `@diffci.com/diffci` through npm's GitHub OIDC trusted
publisher support. It runs on a GitHub-hosted runner, grants only `contents: write` and
`id-token: write`, uses Node 24, installs the current npm CLI, and publishes with provenance.

The remaining activation is an npm package setting rather than repository code. Configure the
trusted publisher for:

- organization/user: `DiffCI`
- repository: `DiffCI.com`
- workflow filename: `release.yml`
- environment: none

After one tagged release succeeds through OIDC, remove the `NODE_AUTH_TOKEN` environment entries
from both publish steps and delete the `NPM_TOKEN` GitHub Actions secret. Until then, npm prefers OIDC
when the trust relationship exists and falls back to the narrowly scoped token.

Do not use `npm whoami` as an OIDC readiness check. npm validates the trust relationship only during
the supported publish operation.
