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
