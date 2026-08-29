# TanStack/query qualification record

Two separate experiments against the same pinned commit
`2969edf32f7e0c48e2a108d84712d6e01edfde21`, in the canonical Linux environment
(`docker.io/cloudflare/sandbox:0.12.5`, node v22.23.2, Ubuntu 22.04.5).

Neither overwrites the other. Each has its own immutable artefacts in R2 under its own run id.

---

## Run 1 — `tanstack-qualify-01` — NOT QUALIFIED under generic bare-Vitest invocation

**Command:** `node node_modules/vitest/vitest.mjs run`

**Verdict:** `1413 test(s) failing at HEAD on every run (1413, 1413)` — deterministic, not flaky.

**Clone, install and build all succeeded.** The harness reports `could not clone`, `install failed` and
`build failed` as distinct reasons and produced none of them, so the full clone worked,
`corepack pnpm install --frozen-lockfile` worked, and `corepack pnpm build:all` worked.

**What this establishes:** the canonical environment removed both of the blockers that disqualified this
repository on the developer host. The earlier chain was *shallow history → nx cannot compute a build →
workspace outputs unavailable → 59 failures*. Full history, install and a complete workspace build all
now succeed.

**What this does NOT establish:** that TanStack's documented CI test surface is dirty. The harness ran
bare Vitest across the entire workspace, **including `examples/**` and `integrations/**`, which the
project's own CI explicitly excludes**, and outside the nx per-package orchestration those tests expect.
1413 failures is consistent with running tests the project never runs that way. The 1413 is also not
comparable to the previously recorded 59: different test surfaces entirely.

This verdict is preserved permanently and is not reinterpreted by Run 2.

---

## Run 2 — `tanstack-qualify-02` — documented CI test semantics

**Command:** `node node_modules/nx/bin/nx.js run-many --target=test:lib --exclude=examples/**`

### Why this command, and why not `nx affected`

The repository's per-package test target is `test:lib`. Its PR script is
`test:pr = nx affected --targets=…,test:lib,…`.

`affected` cannot be reproduced honestly here. `nx.json` sets `defaultBase: main` with no `affected`
override, and `.github/workflows/pr.yml` supplies the range through `nrwl/nx-set-shas`, which derives
`NX_BASE`/`NX_HEAD` from a **pull request diff**. A qualification run clones the repository and checks
out `main` unmodified, so `HEAD == main`, and `affected` legitimately computes **zero** projects and runs
no tests at all. Manufacturing a base/head range to make it run something would be choosing a convenient
base to obtain a verdict, which is precisely the thing that must not be done.

`run-many` is the base-independent form of the same targets, and it is **TanStack's own choice for
non-PR CI**: `test = pnpm run test:ci` and `test:ci = nx run-many --targets=…`. This is the identical
relationship already accepted for the build step, where `build` is `nx affected --target=build` and
`build:all` is `nx run-many --target=build` — and `build:all` appears verbatim in TanStack's own
`pr.yml` and `release.yml` jobs.

### Why `--target=test:lib` rather than `pnpm test`

`pnpm test` expands to `test:ci`, which runs `test:sherif`, `test:knip`, `test:docs`, `test:eslint`,
`test:lib`, `test:types`, `test:build` and `build` together. A lint, knip or docs-link failure would then
produce a "test surface is dirty" verdict for a reason that has nothing to do with the test surface.
`test:lib` is the repository's own test target, and it is what the question is about.

### What is deliberately NOT done

No hand-written Vitest exclusion list. nx decides project boundaries, configuration and execution
semantics; constructing a "should be equivalent" Vitest invocation would insert another DiffCI
interpretation layer between the repository and the verdict. The command above is nx's own CLI entry
point, invoked directly.

### Known risk to the verdict, stated in advance

The output parser reads the **first** `Tests …` summary line it finds. An nx run emits one such line per
project, so a `qualified` verdict from this run must not be accepted on the parser's word alone — it
would undercount failures if an early project passed and a later one failed. Any green result here will
be checked against nx's own aggregate summary in the collected log before being recorded. A red result
is not exposed to this risk.

### Structural limitation, independent of the verdict

Even a green baseline here would **not** by itself make TanStack mutation-measurable in this harness.
The mutation pass runs a selected subset by appending test **file paths** to the test command. `nx
run-many --target=test:lib` takes project names, not file paths, so DiffCI's selection cannot be
expressed through it. Qualification answers whether the documented test surface is green; making the
repository mutation-measurable would additionally require a way to run an arbitrary subset of test files
within nx's project context. That is a real limitation of the harness against orchestrated monorepos, and
it is recorded here rather than discovered later.
