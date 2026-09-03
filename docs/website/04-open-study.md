# The Open Evidence Study 2026 (workstream W, item 4)

**Status:** built and rendered, NOT deployed. Deploying it publishes it; that is a founder decision
(see "Before publishing" below).

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
| Findings module (the only copy of every number) | [`../../src/open-study/diffci-open-evidence-2026.ts`](../../src/open-study/diffci-open-evidence-2026.ts) | 100+ figures, each with category, value, unit, scope, evidence level and a source path that must exist; plus the section prose, tables, one chart, the not-established list and the sources table |
| Renderer | [`../../scripts/render-open-study.ts`](../../scripts/render-open-study.ts) | `npm run study:render` writes the page, CSV, PDF (pdf-lib, no headless browser) and LICENSE.txt into `site/` |
| Study page | `site/research/diffci-open-evidence-2026.html` | Same stylesheet and chrome as the three case studies; inline SVG diverging-bar chart using the site's two validated data-viz slots |
| Data release | `site/research/2026/diffci-open-evidence-2026.csv` | One row per figure: `category,metric,value,unit,scope,evidence_level,source,note,study_id` |
| Report | `site/research/2026/diffci-open-evidence-2026.pdf` | Rendered from the same module; creation date pinned to `asOf` |
| Licence | `site/research/2026/LICENSE.txt` | Same shape as DentalPresence's, with the extra paragraph that named repositories keep their own licences |
| Guards | [`../../tests/open-study/open-study.test.ts`](../../tests/open-study/open-study.test.ts) | Every source path exists; every cited report is in the sources table; rendered files on disk are byte-identical to a fresh render; chart equals table; disclaimer, licence and the unflattering numbers are present |
| Homepage | `site/index.html` | A fourth card in the evidence section and a footer link |

Evidence levels in the study: `MEASURED` (a clock or counter produced it), `PREDICTED` (a frozen
rule's prediction, committed before the measurement), `PROCESS_FACT` (something happened), `ABSTAINED`
(DiffCI declined to produce a number; the abstention is the finding). These map onto the ledger's
MEASURED / ESTIMATED / UNKNOWN axis; there is no ESTIMATED figure in the study by construction.

## Rules it follows

The four in [`README.md`](README.md), plus:

5. **A figure without a source path that exists on disk fails the test suite.** Not a ledger row this
   time: the module *is* the ledger for the study, and `03-evidence-ledger.md` points at it.
6. **The rendered files are a build output, not a source.** Never hand-edit `site/research/*`; edit
   the module and re-render. The drift test enforces this.
7. **The named repositories are described, not endorsed by.** The disclaimer is on the page, in the
   PDF cover, and in the licence.

## Before publishing (founder-only decisions)

Nothing below has been done. The site deploy command is `npm run site:deploy`; running it publishes
the study at `https://diffci.com/research/diffci-open-evidence-2026`.

1. **Deploy or not.** The study is public content the moment the site is deployed. Read the page
   first, including the "not established" list, and decide whether every sentence is one you would
   defend to a maintainer of the named repositories.
2. **"Open source" needs the sources reachable.** DentalPresence's study cited a public crawl. This
   one cites 23 reports by path in a repository that is private. The page currently says so, in a
   sentence that reads honestly but weakly. Options: make the repository public; publish `docs/` (or
   just the cited reports) somewhere public; or leave it and accept that "ask for the report by name"
   is the access route. Flip `SOURCE_REPORTS_PUBLIC` in the renderer and re-render when that changes.
3. **Byline.** The study is attributed to "DiffCI", like DentalPresence's was to "DentalPresence". The
   DentistryIQ piece carried a personal byline. Decide whether the study page should name an author,
   and whether the footer's "no company identity yet" line is acceptable next to a citable study.
4. **The press angle.** The DentistryIQ article worked because it turned the study into a self-check
   a reader could act on in fifteen minutes. The equivalent here is the finding that install cost, not
   selection quality, decides the number: a reader can look at their own CI's install-to-test ratio
   and know which of 44% and 90% is closer to their ceiling before installing anything. That is a
   contributed-article pitch for developer press, not a press release. No outreach is authorised by
   this document; outreach of any kind is still gated on the founder go recorded in
   [`../yc/README.md`](../yc/README.md).
5. **Contact.** A citable study invites replies. There is still no contact route on the site.

## What must not be implied

Everything in [`README.md`](README.md)'s "What does not exist yet" applies. In addition:

- The 32-of-32 mutation figure is a sum across corpora with different harness generations. It is a
  count, never a rate, and the page says so.
- The immer result is one sign match. It is not "the predictor works".
- The 96.4% historical recall is job-level, from Stage 0's own harness, and has 10 real misses in it.
  It is not a safety guarantee and is not to be quoted without the 10.
