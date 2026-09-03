# The Open Evidence Study 2026 (workstream W, item 4)

**Status:** built and rendered, NOT deployed. Deploying it publishes it; that is a founder decision
(see "Before publishing" below). Founder review of 2026-09-03: keep the PDF as the primary public
evidence; derive the editorial article ([`05-editorial-path-rule.md`](05-editorial-path-rule.md)) from
it; drop the Sources section, because paths into a private repository are noise to an external reader;
keep "What this study does not establish" exactly as it is.

## Why this exists

DentalPresence's CC BY 4.0 *U.S. Dental Website SEO Readiness Study 2026* did three jobs at once: a
citable artefact for pitching, a data release anyone could reuse with attribution, and the hook that
earned a contributed article in DentistryIQ. This is the DiffCI equivalent, built from the experiments
already in this repository rather than from a new crawl: one study page, one CSV of every figure, one
PDF, one LICENSE.txt, all under CC BY 4.0.

The claim it makes is deliberately the position in
[`../position-and-next-phase.md`](../position-and-next-phase.md): large compute reduction with
preserved detection, demonstrated; graph causality, not demonstrated. It leads with the 4.2% aggregate
next to the 94.3% conditional win rate, keeps the hono loss and the 0.696 recall on the page, and has
a "what this study does not establish" section that the test suite refuses to let disappear.

## What was built

| Piece | Path | Notes |
|---|---|---|
| Findings module (the only copy of every number) | [`../../src/open-study/diffci-open-evidence-2026.ts`](../../src/open-study/diffci-open-evidence-2026.ts) | 100+ figures, each with category, value, unit, scope, evidence level and an internal source path that must exist; plus the section prose, tables, one chart and the not-established list |
| Renderer | [`../../scripts/render-open-study.ts`](../../scripts/render-open-study.ts) | `npm run study:render` writes the page, CSV, PDF (pdf-lib, no headless browser) and LICENSE.txt into `site/` |
| Study page | `site/research/diffci-open-evidence-2026.html` | Same stylesheet and chrome as the three case studies; inline SVG diverging-bar chart using the site's two validated data-viz slots |
| Data release | `site/research/2026/diffci-open-evidence-2026.csv` | One row per figure: `category,metric,value,unit,scope,evidence_level,source_report,note,study_id`. `source_report` is the report's label, not its path |
| Report | `site/research/2026/diffci-open-evidence-2026.pdf` | Rendered from the same module; creation date pinned to `asOf`. **The primary public evidence artefact** |
| Licence | `site/research/2026/LICENSE.txt` | Same shape as DentalPresence's, with the extra paragraph that named repositories keep their own licences |
| Guards | [`../../tests/open-study/open-study.test.ts`](../../tests/open-study/open-study.test.ts) | Every internal source path exists; every cited report has a label; rendered files on disk are byte-identical to a fresh render; chart equals table; disclaimer, licence and the unflattering numbers are present; no internal path or `.md` reference leaks into any published artefact |
| Editorial article, text draft | [`05-editorial-path-rule.md`](05-editorial-path-rule.md) | 1,800–2,500-word contributed-article draft derived from the study. Not on the site |
| Editorial article, published PDF | `site/research/2026/diffci-path-rule-article.pdf` | Founder's typeset version (five figures) with three figure-label corrections applied to the chart images, 2026-09-03. **Permanent URL** `https://diffci.com/research/2026/diffci-path-rule-article.pdf`, registered in [`permalinks.md`](permalinks.md); linked from the study's "Download and cite" and the study PDF. Founder decision: one plain URL, replaced in place on revision (the `-v1`/`-v2` scheme was retired before first deploy) |
| Permalink registry | [`permalinks.md`](permalinks.md) + `tests/open-study/permalinks.test.ts` | Every URL external citations may depend on; versioned files are hash-pinned so a silent overwrite fails CI |
| Homepage | `site/index.html` | A fourth card in the evidence section and a footer link |

Evidence levels in the study: `MEASURED` (a clock or counter produced it), `PREDICTED` (a frozen
rule's prediction, committed before the measurement), `PROCESS_FACT` (something happened), `ABSTAINED`
(DiffCI declined to produce a number; the abstention is the finding). These map onto the ledger's
MEASURED / ESTIMATED / UNKNOWN axis; there is no ESTIMATED figure in the study by construction.

## Rules it follows

The four in [`README.md`](README.md), plus:

5. **A figure without an internal source path that exists on disk fails the test suite.** Not a ledger
   row this time: the module *is* the ledger for the study, and `03-evidence-ledger.md` points at it.
6. **The rendered files are a build output, not a source.** Never hand-edit `site/research/*`; edit
   the module and re-render. The drift test enforces this.
7. **The named repositories are described, not endorsed by.** The disclaimer is on the page, in the
   PDF cover, and in the licence.
8. **Nothing published points into the private repository.** The CSV names the report that produced
   each row; the path stays internal. A test enforces this too.

## The evidence-chain gap, and the planned fix

The study says every figure traces to a report, and an external reader cannot open those reports.
The CSV and the licence are good; the chain behind them is not yet auditable from outside. The fix is
not to open-source DiffCI. It is to publish an **evidence bundle** under the same licence: the frozen
methodologies, the aggregate inputs and results, the experiment manifests and checksums, the scripts
where they expose nothing proprietary, and enough reproduction instructions to audit the major claims.
Open-source the evidence, not necessarily the product. The page and the PDF now say this is the planned
next release. It is not built and not scheduled; it should be scoped as its own item.

## Before publishing (founder-only decisions)

Nothing below has been done. The site deploy command is `npm run site:deploy`; running it publishes
the study at `https://diffci.com/research/diffci-open-evidence-2026`.

1. **Deploy or not.** The study is public content the moment the site is deployed. Read the PDF
   first, including the "not established" section, and decide whether every sentence is one you would
   defend to a maintainer of the named repositories.
2. **Byline.** The study is attributed to "DiffCI", like DentalPresence's was to "DentalPresence". The
   DentistryIQ piece carried a personal byline. Decide whether the study page should name an author,
   and whether the footer's "no company identity yet" line is acceptable next to a citable study.
3. **The article.** The draft in `05-editorial-path-rule.md` is written for a developer publication as
   a contributed piece. It needs a byline, a target publication, and the founder go on outreach
   recorded in [`../yc/README.md`](../yc/README.md) before it is sent anywhere.
4. **Contact.** A citable study invites replies. There is still no contact route on the site.
5. **The evidence bundle.** Decide whether it is worth doing before or after the first external reader
   asks for it.

## What must not be implied

Everything in [`README.md`](README.md)'s "What does not exist yet" applies. In addition:

- The 32-of-32 mutation figure is a sum across corpora with different harness generations. It is a
  count, never a rate, and the page says so.
- The immer result is one sign match. It is not "the predictor works".
- The 96.4% historical recall is job-level, from Stage 0's own harness, and has 10 real misses in it.
  It is not a safety guarantee and is not to be quoted without the 10.
