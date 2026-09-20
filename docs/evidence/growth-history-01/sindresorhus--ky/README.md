# Maintainer review packet: sindresorhus/ky

**Internal draft. No message sent, no pilot started, and no production savings established.**

Frozen at 2026-09-19T14:54:26.265Z: 20 first-parent default-branch deltas from 2026-09-12 to 2026-09-14.
19 deltas changed implementation files under source/.

## Decision

Hold the savings pitch. The published observer omitted test-import edges, making its smaller selections misleading. The patch broadens all 19 source-changing selections. The remaining file-count reduction has not been timed or checked against actual execution.

## Paired results

Counts are selected/discovered test files, not individual tests. FULL means full validation is required;
an empty selectedTests array under FULL is not permission to run nothing. Both arms used the same
revisions with each head checked out, without installing target dependencies or executing target code.

| Delta | Head | Source changed | Published 0.1.3 | Unreleased patch |
| --- | --- | --- | --- | --- |
| 1 | [0d59458a0a58](https://github.com/sindresorhus/ky/commit/0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47) | Yes | [3/30](01-0d59458a0a58.json) | [28/30](patched/01-0d59458a0a58.json) |
| 2 | [071a9b97d3d1](https://github.com/sindresorhus/ky/commit/071a9b97d3d149a576c91e0b92532f11aab456c5) | Yes | [0/29](02-071a9b97d3d1.json) | [27/29](patched/02-071a9b97d3d1.json) |
| 3 | [d6e049a690c7](https://github.com/sindresorhus/ky/commit/d6e049a690c7562a72e22d0b1eb57a2d4d19745e) | Yes | [1/29](03-d6e049a690c7.json) | [27/29](patched/03-d6e049a690c7.json) |
| 4 | [323b98f0a326](https://github.com/sindresorhus/ky/commit/323b98f0a326f3967dc16acd34f2755da3ebd63a) | Yes | [1/29](04-323b98f0a326.json) | [27/29](patched/04-323b98f0a326.json) |
| 5 | [a8753dcc9a4e](https://github.com/sindresorhus/ky/commit/a8753dcc9a4e8771d4226f9b6d196064325a0fbc) | Yes | [2/29](05-a8753dcc9a4e.json) | [27/29](patched/05-a8753dcc9a4e.json) |
| 6 | [b28ba903c322](https://github.com/sindresorhus/ky/commit/b28ba903c322b84b5d9cf47a6fc0af6a61d5954f) | Yes | [0/29](06-b28ba903c322.json) | [27/29](patched/06-b28ba903c322.json) |
| 7 | [cd1dba0e4502](https://github.com/sindresorhus/ky/commit/cd1dba0e4502d95be93846e6c77bf0479dc0e385) | No | [8/29](07-cd1dba0e4502.json) | [8/29](patched/07-cd1dba0e4502.json) |
| 8 | [e58817d490cb](https://github.com/sindresorhus/ky/commit/e58817d490cba99c97820a39f239272ffdb92881) | Yes | [1/21](08-e58817d490cb.json) | [20/21](patched/08-e58817d490cb.json) |
| 9 | [52b8f93e076e](https://github.com/sindresorhus/ky/commit/52b8f93e076e1614a3f62162052a8723b10ca5ac) | Yes | [1/21](09-52b8f93e076e.json) | [20/21](patched/09-52b8f93e076e.json) |
| 10 | [f4886ca8f58c](https://github.com/sindresorhus/ky/commit/f4886ca8f58c1f9f950124d9edef6bb0f60bb6ef) | Yes | [2/21](10-f4886ca8f58c.json) | [20/21](patched/10-f4886ca8f58c.json) |
| 11 | [51b31777058c](https://github.com/sindresorhus/ky/commit/51b31777058c13f24b640a0ef1a47565f011e080) | Yes | [11/21](11-51b31777058c.json) | [20/21](patched/11-51b31777058c.json) |
| 12 | [481f6f731b0c](https://github.com/sindresorhus/ky/commit/481f6f731b0c311bc2f677604aca3595558b22d1) | Yes | [1/19](12-481f6f731b0c.json) | [18/19](patched/12-481f6f731b0c.json) |
| 13 | [96a25cce552a](https://github.com/sindresorhus/ky/commit/96a25cce552a0128653ca8833e95291ae5082509) | Yes | [1/19](13-96a25cce552a.json) | [18/19](patched/13-96a25cce552a.json) |
| 14 | [e4269f070384](https://github.com/sindresorhus/ky/commit/e4269f070384e60e1c3fd3be4de9e199c07814c9) | Yes | [1/19](14-e4269f070384.json) | [18/19](patched/14-e4269f070384.json) |
| 15 | [82fa84c7d114](https://github.com/sindresorhus/ky/commit/82fa84c7d114f7987ed019be61417288ccc0876e) | Yes | [3/19](15-82fa84c7d114.json) | [18/19](patched/15-82fa84c7d114.json) |
| 16 | [d636438b2dde](https://github.com/sindresorhus/ky/commit/d636438b2dde678f153af2c21f37116f4d064271) | Yes | [1/19](16-d636438b2dde.json) | [18/19](patched/16-d636438b2dde.json) |
| 17 | [87a96db81480](https://github.com/sindresorhus/ky/commit/87a96db81480f1cb71e2cd51bce8c454d32b29ee) | Yes | [2/18](17-87a96db81480.json) | [17/18](patched/17-87a96db81480.json) |
| 18 | [06ebf18e1927](https://github.com/sindresorhus/ky/commit/06ebf18e1927b3772726037bda5a78d4b7eb6dba) | Yes | [2/18](18-06ebf18e1927.json) | [17/18](patched/18-06ebf18e1927.json) |
| 19 | [f87efe6f5d8d](https://github.com/sindresorhus/ky/commit/f87efe6f5d8d6067756a80c5120e7782f4ed847e) | Yes | [2/17](19-f87efe6f5d8d.json) | [16/17](patched/19-f87efe6f5d8d.json) |
| 20 | [8cf26e0e78d7](https://github.com/sindresorhus/ky/commit/8cf26e0e78d7a734f5e2846bdd65b66a936c13b3) | Yes | [1/17](20-8cf26e0e78d7.json) | [16/17](patched/20-8cf26e0e78d7.json) |

## Existing CI and command parity

At [the frozen head](https://github.com/sindresorhus/ky/blob/0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47/.github/workflows/main.yml), CI installs npm dependencies and Playwright browsers, then runs npm test on macOS for Node 22, 24, and latest. The package test script includes lint, build, test typechecking, and AVA. DiffCI proposes AVA file arguments only; that is not a replacement for the whole npm test pipeline. Browser and build setup remain necessary.

The latest successful matrix jobs lasted 171–209 seconds; npm test steps lasted 100–134 seconds, including lint/build/typechecking. These GitHub timestamp differences are baseline durations, not measured savings or pure AVA durations. See [job evidence](../ky-head-jobs.json).

## Reproduce a reported delta

```sh
git clone https://github.com/sindresorhus/ky.git
cd ky
git checkout --detach 0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47
npx @diffci.com/diffci@0.1.3 observe --base 071a9b97d3d149a576c91e0b92532f11aab456c5 --head 0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47 --no-send
```

That reproduces the published baseline, including its known limitation. To reproduce the corrected
arm, build this DiffCI working tree with npm run build:client and use its compiled CLI with --repo
pointing to the same detached checkout, the same base/head, and --no-send. The package version field
still reads 0.1.3; [patched identity hashes](../patched-identity.json) distinguish the unreleased build.

## Maintainer discussion points

- Confirm the intended runnable test universe and which setup/coverage stages must remain unchanged.
- Validate actual execution selection in an isolated environment before measuring any benefit.
- Invite a seven-day observation pilot only after a corrected release and a clean external installation.
- State potential opportunities separately from measured runtime savings; request no endorsement.

[Study overview](../README.md).
