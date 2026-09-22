# Language adapter candidate 0.1.3

This candidate addresses concrete blockers from the September 10 Cloudflare cohort.
It is an experiment, not a production promotion or authorization to skip CI.

Go now attaches `go list`'s `IgnoredGoFiles` to their owning package. An edit to an
inactive file conservatively selects the package and its dependents; inactive test
files do not enter the runnable test universe. Files unaccounted for by metadata
still block selection. Names excluded by Go discovery (`_`/`.` prefixes and
`testdata`) no longer block unrelated deltas merely by existing. Any change or
rename involving such a path still forces full validation, including non-Go data.
Go configuration changes, deleted unmodeled source, metadata errors, native code,
plugins, workspaces and cross-language uncertainty retain their existing guards.
See [Go command documentation](https://pkg.go.dev/cmd/go) for discovery semantics.

Vue compilation now supplies the compiler's filesystem interface, allowing imported
types used by macros such as `defineProps` to resolve. Files the compiler reads are
recorded as graph dependencies because these types can affect generated runtime
props even when their imports disappear. Source files retain source identity;
other dependencies are assets. Reads outside the repository fail closed. Dynamic
component registries, unsupported preprocessors, Nuxt conventions and unresolved
dependencies still require full validation. There is no blanket removal of those
guards and no unsupported claim that a missing edge is harmless.

Candidate.2 additionally includes compiler-reported dependencies and invalidates
imported-type cache entries after each component. Its regression case changes a
shared macro type between analyses and checks both consumers' generated runtime
types. Candidate.1 performance measurements remain identified separately; the Go
adapter implementation is unchanged between these two candidates.

Adapter versions and the graph cache schema advance to invalidate old graphs.
Regression tests exercise inactive-file ownership, transitive consumers, excluded
path edits and renames, deleted files and imported Vue macro types.

Validation uses Cloudflare containers exclusively. Each job builds the candidate
from the uploaded source after typechecking and focused tests. The Vue Test Utils
job also runs the complete DiffCI test suite; Go jobs execute native Go fixture
tests. The existing promoted artifact is verified only as the bootstrap artifact;
the benchmark report separately identifies the actual candidate build and hash.
Execution receipts' bootstrap integrity must not be confused with that candidate.

The same six repositories and eight historical deltas per repository are reused.
Timing pairs, stable baselines and preregistered fault sites follow the original
benchmark protocol. Diagnostic versions 1 and 2 were cancelled with evidence saved
while the graph identity and Go discovery guards were refined. They do not count
as final candidate measurements. Production remains unchanged.

The complete regression suite exposed a live GitHub API check failing under HTTP
403 with zero anonymous requests remaining. Those failures are retained. A retry
is allowed after the reported rate-limit reset, with the same assertion intact.
The benchmark records the API response metadata to distinguish this condition
from adapter regressions. During this development cycle, an additional isolated
regression/benchmark container can overlap the original three-job batch.
