# Language and framework support

DiffCI now has an extensible repository-adapter boundary and initial Vue and Go support.
These additions propose selections in the existing observer; they do not enable production CI skipping.

| Surface | Implemented scope | Boundaries |
| --- | --- | --- |
| JavaScript / TypeScript | Existing dependency analysis and ten existing test-runner command mappings | Runner recognition is not a guarantee of complete framework semantics |
| Vue | SFC parsing with `@vue/compiler-sfc`; script imports, nested components, compiled template asset imports; propagation into importing JS/TS tests | Runtime component/directive resolution, preprocessors, external/custom SFC blocks, style URLs/imports, Nuxt conventions and glob imports require full validation |
| Go | One root module; native `go list` metadata; package-level transitive test selection, external test packages, embedded files; `go test -json` commands and result parsing | Workspaces/nested modules, inactive Go files, cgo/native objects, runtime plugins, generation/linkname, external local replacements and incomplete metadata require full validation |
| Mixed Go and JS/TS | Detected | Full validation until cross-language relationships are declared and modeled |
| Python, Svelte, Astro, Java/Kotlin, C#, Rust | No new semantic support in this release | Require additional adapters and qualification |

## Using the observer

Use the existing `observe` command and commit range options. The observer now admits a root
`go.mod` or Vue SFCs as well as a TypeScript project. Vue projects without a tsconfig have their
JS/TS files parsed alongside their components. Existing TS-only corpus eligibility remains separate:
this release does not silently enroll Go repositories in historical JS/TS research cohorts.

For Go, install a compatible Go toolchain on the **same host and build environment** used for analysis
and testing, and prepare the repository's dependencies first using its normal setup procedure.
DiffCI invokes `go list -mod=readonly -deps -test -json ./...` with `GOTOOLCHAIN=local`, `GOPROXY=off`,
`GOSUMDB=off`, and `GOWORK=off`. Missing toolchains or dependencies produce refusal/full fallback.
Go may populate its own build cache but must not modify the checkout. It does not run `go generate`.
Custom `GOFLAGS` currently require full validation. Discovered GOOS, GOARCH and CGO_ENABLED settings
are carried into the structured test command.

A selection such as `lib/value_test.go` becomes:

```sh
go test -mod=readonly -json -count=1 ./lib
```

It runs the entire package. Consumers must honor the emitted `CommandSpec.env`, preserve the build
context, and check fallback/command-synthesis status before execution. Commands are not portable
between different GOOS/GOARCH/GOFLAGS contexts. The controlled runner command policies accept `go`;
hosted images still need a Go installation before Go workloads can run. No deployment is performed
by these code changes.

Go result parsing counts failing **packages**, records failing test names, and rejects incomplete
JSON streams. It does not invent test-file counts from package counts, so file-based economics
qualification may still report an unsupported denominator for Go.

## Extension points

- `src/repo/adapters/types.ts`: adapter context and graph contribution contract.
- `src/repo/adapters/index.ts`: framework/language adapter registry and bounded file inventory.
- `src/repo/adapters/vue.ts`: Vue compiler integration.
- `src/repo/adapters/go.ts`: native Go package metadata and conservative dependency model.
- `src/repo/adapters/go-test.ts`: structured Go outcome parsing.
- `src/planner/test-command.ts`: runner command routing, including verified Go package targets.

Adapters contribute source and asset nodes, dependency edges, virtual JS/TS source, runnable test
identities and explicit blockers. Blockers persist into the profile and graph result and cannot be
removed by delta-specific reachability refinement. Go graphs bypass the disk cache until every cache
caller provides a complete toolchain/build-context identity. The cache schema was bumped to prevent
reuse of graphs created before adapter support.

## Validation and qualification

`tests/repo/language-adapters.test.ts` covers transitive Vue selection, unsupported-feature fallbacks,
Go package imports and embeds, metadata failures, command routing, and incomplete output.
When Go is on PATH, its native integration test runs the observer against a real Git fixture,
compares successful full/subset test runs, and verifies the subset catches an introduced fault.
Without Go, that native test is explicitly skipped.

These are implementation checks, not prospective customer safety or savings evidence. Each new
ecosystem still needs real repository shadow observations and economic qualification before broader
support or savings claims are made.
