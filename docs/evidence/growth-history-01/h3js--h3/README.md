# Maintainer review packet: h3js/h3

**Internal draft. No message sent, no pilot started, and no production savings established.**

Frozen at 2026-09-19T14:54:26.265Z: 20 first-parent default-branch deltas from 2026-09-03 to 2026-09-17.
9 deltas changed implementation files under src/.

## Decision

Keep as an integration-validation candidate, not a high-savings lead. Nine source-changing deltas propose smaller selections, unchanged by the graph fix. The latest successful test job lasted 43 seconds; its Vitest coverage step lasted only 17 seconds. Analysis and setup overhead may consume much of any benefit.

## Paired results

Counts are selected/discovered test files, not individual tests. FULL means full validation is required;
an empty selectedTests array under FULL is not permission to run nothing. Both arms used the same
revisions with each head checked out, without installing target dependencies or executing target code.

| Delta | Head | Source changed | Published 0.1.3 | Unreleased patch |
| --- | --- | --- | --- | --- |
| 1 | [b31898362a11](https://github.com/h3js/h3/commit/b31898362a111c526271989682aef54b2a15077f) | Yes | [59/71](01-b31898362a11.json) | [59/71](patched/01-b31898362a11.json) |
| 2 | [2d3605a0af7e](https://github.com/h3js/h3/commit/2d3605a0af7e01fc09d89b4bed4f4d07e85f88a6) | Yes | [59/71](02-2d3605a0af7e.json) | [59/71](patched/02-2d3605a0af7e.json) |
| 3 | [a8a803beb986](https://github.com/h3js/h3/commit/a8a803beb98613677317a2bc5fe0a3017fd98db8) | Yes | [59/71](03-a8a803beb986.json) | [59/71](patched/03-a8a803beb986.json) |
| 4 | [bce4ae8dbe41](https://github.com/h3js/h3/commit/bce4ae8dbe41dfae14e96aeed4255c060f19f46b) | No | [FULL](04-bce4ae8dbe41.json) | [FULL](patched/04-bce4ae8dbe41.json) |
| 5 | [60d883f4388c](https://github.com/h3js/h3/commit/60d883f4388c4bcf050ad9ddf97bc9477c754e2d) | No | [FULL](05-60d883f4388c.json) | [FULL](patched/05-60d883f4388c.json) |
| 6 | [ae529f1416a1](https://github.com/h3js/h3/commit/ae529f1416a11a5d7453212ee1a0c48701a8cca7) | Yes | [59/71](06-ae529f1416a1.json) | [59/71](patched/06-ae529f1416a1.json) |
| 7 | [516c2a0ad0e4](https://github.com/h3js/h3/commit/516c2a0ad0e4917ec71ba54fc3b2954d3078c9b4) | Yes | [54/71](07-516c2a0ad0e4.json) | [54/71](patched/07-516c2a0ad0e4.json) |
| 8 | [5e6603cd7507](https://github.com/h3js/h3/commit/5e6603cd7507bb94511de720a6dc2d584abbc494) | Yes | [46/71](08-5e6603cd7507.json) | [46/71](patched/08-5e6603cd7507.json) |
| 9 | [e6b726bb3552](https://github.com/h3js/h3/commit/e6b726bb35523693167d6c0deea059c8d14a4851) | Yes | [59/71](09-e6b726bb3552.json) | [59/71](patched/09-e6b726bb3552.json) |
| 10 | [b5d20d528d05](https://github.com/h3js/h3/commit/b5d20d528d05926c26fee414eecaa1d04abaaadb) | No | [FULL](10-b5d20d528d05.json) | [FULL](patched/10-b5d20d528d05.json) |
| 11 | [aa50e96a4a3d](https://github.com/h3js/h3/commit/aa50e96a4a3da1732aa54542c498b37e0f8e3508) | Yes | [59/71](11-aa50e96a4a3d.json) | [59/71](patched/11-aa50e96a4a3d.json) |
| 12 | [a5fdc86a6075](https://github.com/h3js/h3/commit/a5fdc86a6075506d71510aa5208739aa0b2bec29) | No | [FULL](12-a5fdc86a6075.json) | [FULL](patched/12-a5fdc86a6075.json) |
| 13 | [b6c7d083d8f4](https://github.com/h3js/h3/commit/b6c7d083d8f4123c77b7a7e35757bd0c63df7b1c) | Yes | [6/71](13-b6c7d083d8f4.json) | [6/71](patched/13-b6c7d083d8f4.json) |
| 14 | [7f5f106a0b5a](https://github.com/h3js/h3/commit/7f5f106a0b5a96d8f48adcc155ec6676fa35d55c) | No | [FULL](14-7f5f106a0b5a.json) | [FULL](patched/14-7f5f106a0b5a.json) |
| 15 | [bae31f320e4b](https://github.com/h3js/h3/commit/bae31f320e4b94e1613060a2aa74a590059f1a39) | No | [FULL](15-bae31f320e4b.json) | [FULL](patched/15-bae31f320e4b.json) |
| 16 | [df811cd87201](https://github.com/h3js/h3/commit/df811cd872015ced1cb21e30d42ec20c9f79cbc3) | No | [FULL](16-df811cd87201.json) | [FULL](patched/16-df811cd87201.json) |
| 17 | [6075f8a2fc8b](https://github.com/h3js/h3/commit/6075f8a2fc8b2dc30b4af5870db582ffcd68c948) | No | [FULL](17-6075f8a2fc8b.json) | [FULL](patched/17-6075f8a2fc8b.json) |
| 18 | [00c0d3f3c30f](https://github.com/h3js/h3/commit/00c0d3f3c30f93866822ab5cfb24bbb64bbaeacb) | No | [FULL](18-00c0d3f3c30f.json) | [FULL](patched/18-00c0d3f3c30f.json) |
| 19 | [21a26d9067c8](https://github.com/h3js/h3/commit/21a26d9067c86330a325e872624d771a7a19d42e) | No | [FULL](19-21a26d9067c8.json) | [FULL](patched/19-21a26d9067c8.json) |
| 20 | [1316ffbca776](https://github.com/h3js/h3/commit/1316ffbca77618d5377f526d6e00713b0525ec94) | No | [FULL](20-1316ffbca776.json) | [FULL](patched/20-1316ffbca776.json) |

## Existing CI and command parity

At [the frozen head](https://github.com/h3js/h3/blob/b31898362a111c526271989682aef54b2a15077f/.github/workflows/ci.yml), CI performs setup, lint, typecheck, build, Vitest with coverage, and coverage upload. Vitest configuration also enables typechecking. DiffCI's file-selection command has not been shown to preserve all of these semantics. Preserve the existing stages and coverage policy in any controlled comparison.

The 43-second job and 17-second step are GitHub timestamp differences from one successful run, not a runtime distribution or a savings estimate. See [job evidence](../h3-head-jobs.json).

## Reproduce a reported delta

```sh
git clone https://github.com/h3js/h3.git
cd h3
git checkout --detach b31898362a111c526271989682aef54b2a15077f
npx @diffci.com/diffci@0.1.3 observe --base 2d3605a0af7e01fc09d89b4bed4f4d07e85f88a6 --head b31898362a111c526271989682aef54b2a15077f --no-send
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
