# Explicit Vue package suites

A repository can declare one package's default Vitest suite in its root diffci.json:

```json
{
  "vue": {
    "packageRoot": "packages/router",
    "testConfig": "vitest.config.ts"
  }
}
```

This declaration identifies a CI job's universe, not the repository's entire CI.
The root may be `.` for a single-package project. The first implementation requires
pnpm, a package.json, exactly one recognized default Vitest config, and a nonempty
discovered test universe. Unsupported declarations produce a full fallback.

Analysis uses the package's source/config context. Unrelated documentation and
playgrounds outside it no longer make its graph unsafe merely by existing. Any
changed path outside the package, including a rename's old path, still forces
full validation. Cross-boundary source, asset or macro dependencies also force
full validation, as do unresolved imports. Third-party node_modules dependencies
remain external; manifest and lockfile changes retain full validation.

The config must be a literal object, optionally wrapped in imported defineConfig.
Only the default Vue compiler plugin is supported. Unknown plugins/config helpers,
spreads, computed properties, alternate roots, projects/workspaces and unverifiable
test patterns keep full fallback. Setup files must be literal package-local files.
Changes to setup files or their transitive dependencies force the full suite.
Dynamic Vue component/directive resolution and Nuxt conventions remain blockers.

Proposed commands pin both the package working directory and the exact config:

```text
pnpm --dir packages/router exec vitest run --config vitest.config.ts tests/example.spec.ts
```

The selected paths in reports retain repository-relative identity. Commands convert
them to package-relative paths and refuse paths outside the verified test inventory.
Reports expose vueScope; cache schema and Vue adapter version are advanced.

Cloudflare qualification reuses the same eight historical deltas and three fault
sites for each Vue repository. A fixed untracked scope declaration is recorded in
each case and removed afterward, without overwriting existing repository config.
Both full and selected benchmark arms now use the explicit pnpm package/config
invocation. Therefore these timings are a new paired experiment, not a subtraction
against the earlier direct-node runs. The baseline still independently reports its
actual test universe, including Vue Router type tests.

The candidate also loads compiler-sfc on first Vue use rather than at process
startup, avoiding that dependency initialization in Go/TS-only observations. Go
selection semantics are unchanged; separate Cloudflare runs measure the overhead.
No production skipping or promotion is part of this candidate qualification.
