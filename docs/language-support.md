# Language and framework support

DiffCI now has an extensible repository-adapter boundary and initial Vue and Go support.
These additions propose selections in the existing observer; they do not enable production CI skipping.

| Surface | Implemented scope | Boundaries |
| --- | --- | --- |
| JavaScript / TypeScript | Existing dependency analysis and ten existing test-runner command mappings | Runner recognition is not a guarantee of complete framework semantics |
| Vue | SFC parsing with `@vue/compiler-sfc`; script imports, literal Options API component registrations, empty script fixtures, compiled template asset imports; propagation into importing JS/TS tests | Unresolved runtime component/directive resolution, preprocessors, external/custom SFC blocks, style URLs/imports, Nuxt conventions and glob imports require full validation |
| Go | One root module; optional explicit root-module scope in a repository containing nested modules; native metadata, package-level transitive selection, embeds and Go test commands | Workspaces, changes inside excluded modules, inactive Go files, cgo/native objects, plugins, generation/linkname and incomplete metadata require full validation; root scoping rejects local replacements |
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

For CI that runs only the root module's `go test ./...`, a repository containing nested
modules can explicitly declare that scope in a committed root `diffci.json`:

```json
{ "go": { "scope": "root-module" } }
```

This does not cover nested-module CI jobs. Keep their validation unchanged. Without the
declaration, nested modules still block selection. With it, nested module trees are
excluded from the root test universe, but any change there (including a rename out of
the tree) forces full validation. Scope/configuration changes also force full validation.
Go workspaces and local replacements still block scoped selection. Reports identify the
declared `goScope`; the structured commands continue to run root-relative packages.

Empty-graph refusals now include the adapter's reason. Vue recognizes only direct imported
component identifiers in literal `components` registrations; spreads, computed registrations,
dynamic components and unresolved directives remain conservative.

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
