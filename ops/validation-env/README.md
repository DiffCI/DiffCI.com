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

## Which image is canonical (changed 2026-08-28)

**The canonical environment is `docker.io/cloudflare/sandbox:0.12.5`, running on Cloudflare Containers
at `standard-4`** — driven by the `diffci-validation-env` Worker (`wrangler.validation-env.jsonc`,
`src/validation-env/`).

`Dockerfile` in this directory specifies `node:22.14.0-bookworm-slim` and was the original plan. **It
has never been built.** Docker Desktop on the development host does not start, which is the same
constraint that already pushed the analysis-fanout and github-runner Workers onto the public sandbox
image. It is kept here because it still documents the intended contract, and because a future CI
environment with a working Docker daemon could build it — but no evidence has ever been produced
inside it, and nothing should describe it as the environment that was used.

The sandbox image was not a compromise chosen for convenience. It is already proven in this account:
the analysis-fanout execution shards use it to clone, install and test real repositories, including
cal.com, whose install alone runs about twenty minutes.

### The trade-off, stated rather than hidden

This image's **Node version is Cloudflare's choice, not ours.** The original contract pinned Node
22.14.0; the sandbox image ships whatever it ships, and a future `0.12.6` could change it.

Two consequences, both of which the evidence records rather than assumes:

1. Every run captures `node --version`, `npm --version`, `git --version`, `uname -a` and
   `/etc/os-release` from **inside the container**, into `environment.json`.
2. The Windows evidence was produced on **Node v24.16.0**. The container will not be running v24.16.0.
   So the reproduction experiment changes the operating system **and** the Node version together. It
   tests *"does this evidence reproduce in the canonical environment"* — it does **not** isolate
   *"Windows versus Linux"*. Any classification difference has at least two candidate causes, and a
   report that names only one of them is overclaiming.

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

**This environment must not grow per-repository accommodations.** The moment it branches for one
project's quirk, the corpus stops measuring "can DiffCI validate real repositories" and starts
measuring "how much archaeology are we willing to do".

## What runs, and why both passes are required

The container runs the dogfood harness unmodified, in two passes: `dogfood-observe`, then
`dogfood-mutate`.

Running only the mutation pass would look like it worked and would mean nothing. `dogfood-mutate` reads
each candidate's observation report from disk and **silently skips** any candidate whose report is
missing. In a fresh container with no prior observation it therefore reports zero candidates and
produces a clean, empty, entirely meaningless funnel — a failure that looks exactly like a success.

## Pinning, and why the corpus would otherwise drift

`dogfood-observe` derives its candidate commits from `git log` at the clone's HEAD. Cloning a live
repository observes whatever landed on `main` that morning, so two runs a week apart examine different
commits and their funnels are not comparable.

Each job therefore pins a head SHA (`src/validation-env/validation-jobs.ts`), the container resets a
branch to it before observing, and `tests/validation-env/validation-jobs.test.ts` asserts the pinned
SHA, the agent integrity and the mutation commands still match the frozen bundle the job claims to
reproduce. A reproduction whose inputs have quietly drifted still produces a confident-looking number,
which is worse than no reproduction at all.

## Usage

```bash
npm run validation:deploy
```

The control token is a secret and is set by hand, never committed and never generated by tooling:

```bash
npx wrangler secret put VALIDATION_CONTROL_TOKEN --config wrangler.validation-env.jsonc
```

The control plane **fails closed**: with no token configured, every `/v1/*` route answers 401, so an
unconfigured deploy is unusable rather than open. `/health` is the only unauthenticated route and
returns nothing but the job allowlist.

Then, with `DIFFCI_VALIDATION_URL` and `VALIDATION_CONTROL_TOKEN` in the environment:

```bash
npm run validation:pack
```

```bash
npm run validation:start -- --run-id hono-linux-01 --job hono-reproduction --source-key <sourceKey> --source-sha256 <sourceSha256> --agent-key <agentKey>
```

```bash
npm run validation:status -- --run-id hono-linux-01
```

```bash
npm run validation:collect -- --run-id hono-linux-01
```

`collect` writes the run into `.dogfood/runs/<runId>/` in exactly the shape a local run produces, so
`npm run dogfood:freeze -- --run <dir>` reads it without knowing it came from a container.

## Why the agent is uploaded separately

`dist-agent/` is gitignored, so `git ls-files` never sees it and it is not in the source tarball. The
packed `.tgz` is uploaded to R2 on its own and its sha512 is checked **inside the container** against
the integrity string recorded in the frozen corpus. Rebuilding the agent in the container would give
"same agent version, rebuilt elsewhere"; shipping the bytes gives *same agent*, which is one of the four
things a reproduction experiment holds constant.

## Recording which environment produced the evidence

The chain safety evidence must identify is:

    repository SHA + agent digest + environment identity + commands + mutation + results

A manifest with `validationImage: null` records a run from a developer host. That is not a defect, but
those results are **not interchangeable** with results from the canonical environment, and the manifest
says so rather than leaving a reader to assume.

## What to run, in order

1. **`hono-reproduction`** — the same corpus, the same agent bytes, the same commands, in the canonical
   environment. Compare frozen funnels for **classification stability**, not timing: container and
   laptop wall-clock numbers are not comparable and no conclusion should rest on them.
2. `dogfood:qualify` for `colinhacks/zod`, then `TanStack/query`. Full clone is the default here, so
   the nx-needs-history blocker should not recur.
3. Whichever qualifies: observation pass, then mutation.
4. If **neither** qualifies in this environment, stop and report the limitation. That would be a real
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
