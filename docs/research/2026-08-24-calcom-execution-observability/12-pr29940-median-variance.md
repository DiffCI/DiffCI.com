# Report — PR #29940 median/variance across 3 samples

**Runs:** `exec-calcom-29940-isolated1`, `-isolated2`, `-isolated3` - identical shape (`testArgvOverride: ["test"]`, default isolation, same 2 selected files, same merge/base), 3 independent full-pipeline executions on Cloudflare. `engineChecksum` unchanged across all three.

## Raw samples

| Sample | Full (ms) | Selected (ms) |
|---|---:|---:|
| 1 | 320,853 | 20,045 |
| 2 | 341,303 | 20,088 |
| 3 | 321,467 | 20,072 |

## Statistics

| | Full suite | Selected suite |
|---|---:|---:|
| Median | 321,467 ms | 20,072 ms |
| Mean | 327,874.3 ms | 20,068.3 ms |
| Std. dev. | 9,498.8 ms (~2.9% of mean) | 17.7 ms (~0.09% of mean) |
| MAD | 614 ms | 16 ms |

The selected-suite timing is extremely tight (sub-0.1% relative variance) - expected, since it's dominated by fixed Vite/environment bootstrap cost for exactly 2 files every time. The full-suite timing has real but modest variance (~3%), consistent with normal Cloudflare container scheduling noise across 406 files - not a red flag, and nowhere near the anomaly magnitude from Report 9.

## Activation decision with real medians (`decideActivation()`, 3 samples)

```
predictedFullDurationMs:      321,467  (median)
predictedSelectiveDurationMs:  20,072  (median)
predictedGrossSavingsMs:      301,395
analysisOverheadMs:            10,089
uncertaintyMarginMs:           16,073  (5% of predicted full duration)
requiredSavingsMs:             26,162
netSavingsMs:                 275,233
lowConfidence:                  false   <- for the first time: 3+ samples clears the gate's own threshold
decision:            EXECUTE_SELECTIVELY
```

**This is the first result in the entire mission where the activation gate reports `EXECUTE_SELECTIVELY` without a `lowConfidence` caveat.** All three inputs to this decision are now real, repeated, independently-measured Cloudflare executions - not a single point estimate.

## Recall consistency across all 3 samples

Identical in every sample: `fullSuiteCaughtMutant: true`, `selectedSuiteCaughtMutant: true`, `recallMeasurable: true`, and the exact same single failing test in every run:

> `packages/lib/getReplyToHeader.test.ts :: getReplyToHeader with hideOrganizerEmail and customReplyToEmail uses customReplyToEmail even when hideOrganizerEmail is true`

Zero variance in mutation attribution across 3 independent runs - the result is reproducible, not a one-off.

## What this still doesn't claim

This is 3 samples on **one merge**. It confirms the measurement is stable and repeatable for PR #29940 specifically, under this exact command shape. It is not a claim about cal.com's savings in general - Report 13 covers that with 5 genuinely different merges.
