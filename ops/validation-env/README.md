# The DiffCI validation environment

One canonical Linux environment in which every corpus repository is qualified and mutated. A
repository either works here or it does not, and that verdict *is* the qualification.

## Why this exists

Qualification on the development host (Windows) excluded **both** monorepos attempted and admitted
**both** single-package libraries:

| Repository | Shape | Verdict on Windows | Blocker |
|---|---|---|---|
| `unjs/h3` | single package | qualified | — |
| `honojs/hono` | single package | qualified | — |
| `colinhacks/zod` | monorepo | not qualified | build calls `pnpm` by name; not on PATH |
| `TanStack/query` | monorepo | not qualified | build is `nx affected`; shallow clone has no history |

Neither blocker is a property of the repository. Both are properties of the host. And the bias points
exactly the wrong way — **monorepos are where the graph-explosion question lives**, so safety evidence
was becoming available only from the class of repository where the question matters least.

Left alone, a future claim of *"0 false greens across 50 measurable mutations"* would rest mostly on
easy single-package repositories. That is a much weaker statement than it sounds, and the corpus
schema's whole purpose is to stop weak statements from wearing strong clothes.

## The contract

**Permitted:**

- a full git clone with real history — some builds ask git what changed, which is a normal property of
  those builds
- the repository's own declared package manager, through corepack
- the repository's documented install
- the repository's documented build
- two full baseline runs, both of which must be green

**Not permitted, for any repository:**

- databases, message queues, or any external service
- credentials, tokens, or network access beyond a package registry and the git remote
- historical or per-repository Node versions
- bespoke patching of a repository's source or configuration to make its suite pass

A repository needing anything on the second list is reported unqualified **with the reason**. That is
a finding about reproducibility, not a task to take on.

**This image must not grow per-repository accommodations.** The moment it branches for one project's
quirk, the corpus stops measuring "can DiffCI validate real repositories" and starts measuring "how
much archaeology are we willing to do".

## Usage

```bash
docker build -t diffci-validation ops/validation-env

docker run --rm \
  -v "$PWD:/work" \
  -v diffci-validation-cache:/root/.cache \
  diffci-validation \
  npm run dogfood:qualify -- --only TanStack/query --write
```

The named cache volume keeps corepack downloads and package-manager stores warm between runs — the
difference between a four-minute qualification and a twenty-minute one.

## What to run, in order

1. `dogfood:qualify` for `colinhacks/zod` and `TanStack/query`. Full clone is now the default, so the
   nx-needs-history blocker should not recur.
2. Whichever qualifies: observation pass, then mutation.
3. If **neither** qualifies in this environment, stop and report the limitation. That would be a real
   finding — that tightly coupled monorepos are not reproducible under a reasonable modern CI
   environment — and it is worth more than quietly narrowing the corpus to what happens to work.

## The result that would matter most

A monorepo that qualifies lets the corpus finally test the combination the single-package repositories
cannot produce:

- `RECALL_CONFIRMED` **+** `SELECTION_OVERBROAD` on a monorepo — safe but not worth running, the
  economics problem in its clearest form; or
- **`FALSE_GREEN` on a monorepo** — which would stop corpus scaling immediately and become the
  highest-priority engine problem.

Either teaches more than five more easy single-package repositories.
