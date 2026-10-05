# DentalPresence evidence collection

The paired-evidence importer accepts explicitly reviewed selector version/integrity pins, preserves historical versions, and exposes separate version cohorts. Unknown versions, mismatched integrity, local engines, seeded experiments, conflicting identities, incomplete executions and unverified provenance remain excluded. Producer assessment flags are never used to authorize inclusion.

The matching DentalPresence integration archives paired and seeded JSON evidence inside its private repository's `diffci-evidence` branch, after each experiment and nightly. Workflow artifacts are 90-day recovery copies; the Git archive has no Actions expiry. It stores compressed pair, prediction and receipt bytes with GitHub artifact provenance and recomputes cumulative summaries. Full aggregate test artifacts retain their separate existing collector/consumer and now have a 90-day artifact window; they are not included in this paired archive.

The dependency-free DentalPresence importer is generated from `scripts/lib/dentalpresence-pairs.ts`:

```powershell
node scripts/sync-dentalpresence-importer.mjs C:\path\to\DentalPresence.in\scripts\ci-pair-import.mjs
node scripts/sync-dentalpresence-importer.mjs C:\path\to\DentalPresence.in\scripts\ci-pair-import.mjs --check
```

Keep the producer package pin and this consumer's allowlist synchronized through reviewed changes. Both the exact version and SHA-512 integrity are required. The archive runs trusted main scripts only and parses downloaded artifacts as bounded data, never executable source. The scheduled collector becomes active after the DentalPresence PR merges; opening a PR alone does not activate it.

The weekly seeded cohort has three fixed public-content mutations (SEO URL fallback, Organization postal markup, practice Maps place ID). Each requires a passing original targeted control, prospective selection on an identical synthetic committed delta across isolated clones, a full-arm failure, and targeted reproduction of the same failing case. Seeded detection and possible misses are reported separately. They do not establish natural regression recall and cannot contribute to savings.

On 3 October 2026, a read-only backfill fetched 16 paired artifacts from DentalPresence: seven complete selective passing pairs and nine FULL fallbacks. Six accepted pairs used 0.2.11 and one used 0.3.2. The latter had previously been excluded by the obsolete single-version importer. Three PR artifacts were verified through authenticated GitHub merge-parent metadata because their artifact head SHAs differ from the executed merge SHAs. This is a small internal cohort sharing a founding team; no accepted pair contained a failed case, and natural regression recall remains unestimated. Runtime measurements exclude installation and provider billing; the shadow experiment adds work by running both arms.

## Telemetry-driven diagnostics, 5 October 2026

The pair consumer now validates both execution arms of FULL predictions before admitting fallback diagnostics. FULL predictions must execute the complete file universe in both arms; their observer's selective-file list is not an execution claim. Incomplete, mismatched, or conflicting records cannot contribute diagnostic counts. Valid FULL pairs remain excluded from selective performance metrics.

The additive `diagnostics` summary groups fallback reasons into stable categories without repository paths or arbitrary producer prose. A pair counts once per category; category counts may overlap. It reports validated fallback counts by selector version, unique accepted commits, median analysis time, analysis's fraction of selected-plus-analysis runtime, and performance pairs whose selected-plus-analysis time is no better than full time. Performance diagnostics use only the same passing pairs admitted to runtime metrics. Empty timing cohorts report null.

A read-only replay of the 16 archived artifacts preserved seven accepted performance pairs and nine FULL exclusions. All nine fallbacks involved configuration changes; six also involved dependency manifests, five workflows, four lockfiles, two infrastructure, one database definitions, and one an unknown changed file. These changes support retaining the conservative full-suite safeguards rather than broadening selection.

The seven accepted pairs represent seven unique commits. Median paired analysis time was 8.01 seconds, and analysis accounted for 49.23% of selected-plus-analysis runtime. None of the seven had a non-improving net runtime. These measurements identify analysis as a profiling target; they do not identify a cache optimization or prove billing savings. The seven passing pairs still provide no natural regression-recall estimate.
