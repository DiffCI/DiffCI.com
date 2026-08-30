# Addressability survey — frame resolution

**Recorded before any repository's configuration was inspected.** The frame is now fixed and cannot
change.

## The source had to be substituted, and why

The pre-registration named the frame as *"npm 'most depended upon' packages, in rank order"*. Resolving
that to a concrete, fetchable list exposed a problem worth recording in full, because it is the kind of
thing that silently dates an experiment.

**The obvious source is dead.** The widely-cited npm-rank gist
(`anvaka/8e8fa57c7ee1350e3491`) advertises itself as *"updated daily via cron job"* and its GitHub API
metadata reports `updated_at: 2026-08-28`. Both are misleading. Its newest content revision is
**`b6f3ebeb`, committed 2019-08-16**, and the file itself is stamped `Date: Fri, 16 Aug 2019`. The cron
job evidently stopped seven years ago. Its top entries include `request`, deprecated in 2020.

`npmjs.com/browse/depended` returns **403** to non-browser clients, and the CouchDB
`/-/_view/dependedUpon` view returns **404**.

A 2019 ranking would not answer the question as posed — *"within a reproducibly selected slice of the
npm ecosystem"*, present tense. It would also amplify the pre-registered "skews old" bias far past what
that caveat anticipated, since it would be measuring an ecosystem that no longer exists.

## The frame, as fixed

| | |
|---|---|
| Source | **`npm-high-impact@1.13.0`**, export `topDependent` |
| Published | 2026-06-08 |
| Tarball | `https://registry.npmjs.org/npm-high-impact/-/npm-high-impact-1.13.0.tgz` |
| Entries in source | 4,687, rank-ordered by dependent count |
| Frame entries taken | **ranks 1–40**, in source order |

It satisfies every property the pre-registration required of a frame: externally maintained, not curated
by me, rank-ordered by someone else's criterion, enumerable, and reproducible by a third party from a
pinned version.

The 40 names are committed verbatim at
[`docs/evidence/survey/frame-ranks-1-40.json`](evidence/survey/frame-ranks-1-40.json).

## Disclosure: what I had already seen when choosing the source

Stated plainly, because the substitution was a decision made after looking at something:

- I fetched the 2019 gist and saw its top three entries (`lodash`, `chalk`, `request`).
- I read the first ~24 names of `npm-high-impact`'s `topDependent` while confirming the export existed.
- **No repository configuration, `package.json`, runner config, or test layout was inspected** for any
  candidate.

The substitution was made on a criterion fixed in advance — *reproducible, externally determined,
rank-ordered* — plus a defect discovered in the first source that is independent of any expected outcome:
it stopped updating in 2019. It was **not** made because one list looked more favourable than the other.

**A consequence I can already anticipate, and must not act on:** the names alone imply some outcomes.
`mocha` sits at rank 4, and this harness reads mocha's failure count but not its test-*file* count, so it
will fail gate 2. Anticipating a result changes nothing — the gates, their order, and the taxonomy were
frozen at `af3b355`, and no repository is treated differently for being predictable.

## Selection rule: the discrepancy, settled

The pre-registration said *"take ranks in ascending order until 40 repositories are admitted"* (yielding
40 **eligible**, with more than 40 frame entries consumed). The reporting chain agreed afterwards says
*"40 frame entries → X excluded → N survey-eligible"* (yielding fewer than 40 eligible), and the
authorisation said *"begin resolving ranks 1–40 in order"*.

These are not the same rule. **Settled in favour of the explicit instruction: the frame is ranks 1–40.**
Exclusions come out of that 40, so the eligible N will be smaller.

The cost is stated openly: this gives a smaller sample than the alternative reading, and a wider
confidence interval on the reach rate. It is settled here, before inspection, rather than after seeing
how many exclusions fall out — which is the only property that matters.

## Known exclusions already visible from names alone

Three of the 40 are repositories this project has already examined and are excluded under
pre-registered rule 1: **`chalk`** (rank 22), **`axios`** (rank 36), **`vue`** (rank 37).

That they appear at all is worth noting: the earlier external targets, selected by an entirely different
mechanism, overlap the top of an independently ranked list.

## Status

**Frame FROZEN. Ranks 1–40 recorded. No repository inspected.**

Apparatus and protocol boundary: `af3b355`.
