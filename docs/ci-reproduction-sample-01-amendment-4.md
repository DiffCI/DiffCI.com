# AMENDMENT 4 to CI_REPRODUCTION_SAMPLE_01 — cross-job artifact dependencies

**Written after reading babel's workflow and before any inference has been run against babel or
babel-loader.**

## The new structure

Every reference plan so far described **one job**. babel's TEST path cannot:

```yaml
test:
  name: Test on Node.js ${{matrix.node-version}}
  needs: build
  steps:
    - run: yarn install
    - uses: actions/download-artifact@v8      # <- consumes `babel-artifact`
      with: { name: babel-artifact }
    - run: node ./node_modules/.bin/jest --ci
```

```yaml
build:
  steps:
    - run: make -j build-standalone-ci
    - run: node ./scripts/pack-script.ts
    - …
    - uses: actions/upload-artifact@v7
      with: { name: babel-artifact, path: "packages/*/lib/**/*" … }
```

The suite runs against **compiled output produced by a different job** and shipped as an artifact. Run
the test job's steps alone and the tree has no `lib/` directories at all.

## The rule

1. **Reconstruct only jobs whose artifacts the TEST path actually consumes** — those named in a
   `download-artifact` the path depends on. A bare `needs:` is ordering, not a file dependency:
   `build` itself `needs: prepare-yarn-cache`, which ships no artifact, and is **not** reconstructed.
2. **Run the producing job's `run:` steps in declaration order — all of them.** No selective omission.
   Dropping a step because I judge it "only verification" would be me choosing which parts of a build to
   reproduce, and a step I omit is a step whose failure I have hidden. If `assert-dir-git-clean` fails,
   that is a genuine finding about reproducing babel's build here, recorded as such.
3. **Dependency provisioning is performed once, first.** In CI each job installs for itself — `build`
   through `setup-node`'s restored yarn cache, `test` through its explicit `yarn install`. A single tree
   cannot have two independent installs, and building without dependencies is not what CI does either.
   So `yarn install` runs once at the top and is recorded as a **reconstruction step**, not as a
   transcribed line in its original position.
4. Artifact transfer itself is **not** reproduced. `upload-artifact` / `download-artifact` between jobs
   on one commit is a file transfer; running both jobs in a single tree leaves the same files in place.
   Nothing is copied, and nothing needs to be.

## Verification table — one more row

| cited requirement | verification |
|---|---|
| **cross-job artifact dependency** | the TEST job declares `needs:` a job that `upload-artifact`s a name the TEST job `download-artifact`s |

Mechanically checkable from the workflow, so a refusal citing it is falsifiable and grades as
`CORRECT_REFUSAL`.

## What I expect, said before the run rather than after

The engine has **no artifact-graph capability whatsoever**. It does not model `upload-artifact`,
`download-artifact`, or the file dependency between jobs. So one of two things happens with babel:

- it **refuses** — correct, and gradeable against the row above; or
- it **plans the test job alone** and runs `jest --ci` against a tree with no compiled output, which
  would be `DIVERGED` of exactly the kind member 2 produced: confident construction of a path that
  cannot produce the outcome.

Writing this down now means the result cannot later be described as anticipated when it was not, and
cannot be dismissed as a surprise when it was.

## The licence, again withheld from the engine

Reconstructing a producing job across an artifact boundary is something the reference arm does and the
engine cannot. As with amendments 1–3, that is recorded rather than quietly enjoyed: a refusal citing the
artifact dependency is graded on its merits and **not** counted against DiffCI because I could read two
jobs and it could only read one.
