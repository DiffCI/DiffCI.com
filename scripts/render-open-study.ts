// Renders the DiffCI Open Evidence Study 2026 - page, CSV, PDF and LICENSE - from the one findings
// module (src/open-study/diffci-open-evidence-2026.ts). Modelled on DentalPresence's
// render-study-{charts,csv,pdf,license}.ts, collapsed into one script because the study has one
// scope, not one per country.
//
// Outputs (all under site/, served by the static diffci-site Worker with no build step):
//   site/research/diffci-open-evidence-2026.html
//   site/research/2026/diffci-open-evidence-2026.csv
//   site/research/2026/diffci-open-evidence-2026.pdf
//   site/research/2026/LICENSE.txt
//
// tests/open-study/open-study.test.ts re-renders the HTML, CSV and LICENSE and asserts the files on
// disk are byte-identical, so an edit to the findings module that is not re-rendered fails CI.
//
// Usage: npm run study:render
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import {
  diffciOpenEvidenceStudy2026,
  type StudyChart,
  type StudyFindings,
  type StudySection,
  type StudyTable,
} from "../src/open-study/diffci-open-evidence-2026.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..");

export const SITE_ORIGIN = "https://diffci.com";

// Source paths stay in the findings module (the test suite requires each to exist) but are NOT
// published: the repository is private, so a path a reader cannot open is noise, not evidence.
// The public artefacts carry the report's label instead. Founder decision, 2026-09-03; the
// planned fix is an evidence bundle (frozen methodologies, aggregate inputs/results, manifests,
// checksums) published alongside the study - see docs/website/04-open-study.md.
export function sourceLabel(study: StudyFindings, sourcePath: string): string {
  const report = study.sourceReports.find((s) => s.path === sourcePath);
  if (!report) throw new Error(`figure cites a report not in sourceReports: ${sourcePath}`);
  return report.what;
}

export const EVIDENCE_LEVEL_KEY =
  "MEASURED, a clock or a counter produced the number in a real execution; PREDICTED, a frozen rule's prediction, committed before the measurement it predicted; PROCESS_FACT, something that happened rather than a measurement; ABSTAINED, DiffCI declined to produce a number and the abstention is the finding.";

/** Download files are named by the page slug, not the versioned study id, so links stay stable across versions. */
const slug = (study: StudyFindings) => path.posix.basename(study.pagePath);

export function outputPaths(study: StudyFindings) {
  return {
    html: path.join(repoRoot, "site", `${study.pagePath}.html`),
    csv: path.join(repoRoot, "site", study.downloadDir, `${slug(study)}.csv`),
    pdf: path.join(repoRoot, "site", study.downloadDir, `${slug(study)}.pdf`),
    license: path.join(repoRoot, "site", study.downloadDir, "LICENSE.txt"),
  };
}

export function publicUrls(study: StudyFindings) {
  return {
    page: `${SITE_ORIGIN}/${study.pagePath}`,
    csv: `/${study.downloadDir}/${slug(study)}.csv`,
    pdf: `/${study.downloadDir}/${slug(study)}.pdf`,
    license: `/${study.downloadDir}/LICENSE.txt`,
  };
}

export function citation(study: StudyFindings): string {
  return `${study.publisher}. (2026). ${study.studyName} (${study.studyId}): ${study.subtitle}. ${publicUrls(study).page}`;
}

// ---------------------------------------------------------------------------------------------
// Shared text helpers

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Paragraph strings carry deliberate inline <strong>/<em>/<code>; everything else is escaped. */
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");

const csvField = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// ---------------------------------------------------------------------------------------------
// CSV

export function renderCsv(study: StudyFindings): string {
  const header = ["category", "metric", "value", "unit", "scope", "evidence_level", "source_report", "note", "study_id"];
  const lines = [header.join(",")];
  for (const fig of study.figures) {
    lines.push(
      [fig.category, fig.metric, fig.value, fig.unit, fig.scope, fig.level, sourceLabel(study, fig.source), fig.note ?? "", study.studyId]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// LICENSE.txt - same shape as DentalPresence's public/research/2026/LICENSE.txt

export function renderLicense(study: StudyFindings): string {
  const urls = publicUrls(study);
  return `${study.studyName}
Licence: ${study.license.name}

The findings, prose, tables, charts and data files in this study are published under ${study.license.name}. You may reproduce, adapt, and republish them, including commercially, provided you credit ${study.publisher} and link to the study page. This licence covers the study materials only; the DiffCI software, service, GitHub Apps and trademarks are not covered by it.

This licence covers only the study findings, prose, tables and charts at ${urls.page}, and the PDF, CSV and LICENSE files in this directory. It does not cover the DiffCI product, source code, analysis engine, trademarks, or any other page or asset on the site.

The repositories named in the study are public open-source projects analysed from their public source. Their code remains under their own licences. None of them is affiliated with, a customer of, or an endorser of DiffCI.

Full attribution:
${citation(study)}

CC BY 4.0 deed:
${study.license.url}
`;
}

// ---------------------------------------------------------------------------------------------
// HTML page - hand-matched to site/case-studies/*.html so it uses the same stylesheet and chrome

function divergingBarsSvg(chart: StudyChart): string {
  // Horizontal diverging bars with a zero line. Polarity is carried by the site's two validated
  // data-viz slots (--series-tests for a reduction, --series-setup for worse-than-baseline) plus a
  // legend and the table that follows, so identity is never colour-alone.
  const rowH = 22;
  const labelW = 170;
  const valueW = 56;
  const plotW = 420;
  const pad = 8;
  const width = labelW + plotW + valueW + pad * 2;
  const height = chart.data.length * rowH + pad * 2 + 18;
  const maxAbs = Math.max(...chart.data.map((d) => Math.abs(d.value)));
  const negExtent = Math.max(0, -Math.min(...chart.data.map((d) => d.value)));
  const posExtent = Math.max(0, Math.max(...chart.data.map((d) => d.value)));
  const scale = plotW / (negExtent + posExtent || maxAbs || 1);
  const zeroX = pad + labelW + negExtent * scale;

  const rows = chart.data
    .map((d, i) => {
      const y = pad + i * rowH;
      const w = Math.max(2, Math.abs(d.value) * scale);
      const x = d.value >= 0 ? zeroX + 1 : zeroX - 1 - w;
      const fill = d.value >= 0 ? "var(--series-tests)" : "var(--series-setup)";
      const valueText = `${d.value > 0 ? "+" : ""}${d.value.toFixed(1)}${chart.unit}`;
      const valueX = d.value >= 0 ? x + w + 6 : x - 6;
      const anchor = d.value >= 0 ? "start" : "end";
      const title = `${d.label}: ${valueText}${d.note ? ` (${d.note})` : ""}`;
      return `<g class="bar" tabindex="0"><title>${escapeHtml(title)}</title>
<text x="${pad + labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" class="lbl">${escapeHtml(d.label)}</text>
<rect x="${x.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" rx="3" fill="${fill}"></rect>
<text x="${valueX.toFixed(1)}" y="${y + rowH / 2 + 4}" text-anchor="${anchor}" class="val">${escapeHtml(valueText)}</text>
</g>`;
    })
    .join("\n");

  const axisY = pad + chart.data.length * rowH + 12;
  return `<svg class="diverging" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${chart.id}-title" xmlns="http://www.w3.org/2000/svg">
<title id="${chart.id}-title">${escapeHtml(chart.title)}</title>
<style>
.diverging .lbl { font: 500 11.5px var(--mono); fill: var(--ink-2); }
.diverging .val { font: 500 11px var(--mono); fill: var(--ink-2); }
.diverging .axis { stroke: var(--rule-2); stroke-width: 1; }
.diverging .axis-lbl { font: 11px var(--sans); fill: var(--ink-3); }
.diverging .bar:hover rect, .diverging .bar:focus rect { opacity: 0.8; }
</style>
<line class="axis" x1="${zeroX.toFixed(1)}" y1="${pad}" x2="${zeroX.toFixed(1)}" y2="${axisY - 6}"></line>
<text class="axis-lbl" x="${zeroX.toFixed(1)}" y="${axisY + 4}" text-anchor="middle">0 = same as the path rule</text>
${rows}
</svg>`;
}

function tableHtml(t: StudyTable): string {
  const num = new Set(t.numericColumns);
  const head = t.columns.map((c, i) => `<th${num.has(i) ? ' class="num"' : ""}>${escapeHtml(c)}</th>`).join("");
  const body = t.rows
    .map((r) => `<tr>${r.map((cell, i) => `<td${num.has(i) ? ' class="num"' : ""}>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("\n      ");
  return `  <div class="table-scroll">
    <table id="${t.id}">
      <tr>${head}</tr>
      ${body}
    </table>
  </div>
  <p class="fine">${escapeHtml(t.caption)}</p>
`;
}

function sectionHtml(s: StudySection): string {
  const parts: string[] = [`  <h2 id="${s.id}">${escapeHtml(s.title)}</h2>`];
  for (const p of s.paragraphs) parts.push(`  <p>${p}</p>`);
  for (const c of s.charts ?? []) {
    parts.push(`  <figure>
    <div class="chart">
      <div class="legend">
        <span><i class="swatch swatch-tests"></i> Fewer tests than the path rule</span>
        <span><i class="swatch swatch-setup"></i> More tests than the path rule</span>
      </div>
      ${divergingBarsSvg(c)}
    </div>
    <figcaption>${escapeHtml(c.caption)}</figcaption>
  </figure>`);
  }
  for (const t of s.tables ?? []) parts.push(tableHtml(t));
  if (s.bullets?.length) parts.push(`  <ul>\n${s.bullets.map((b) => `    <li>${escapeHtml(b)}</li>`).join("\n")}\n  </ul>`);
  return parts.join("\n");
}

export function renderHtml(study: StudyFindings): string {
  const urls = publicUrls(study);
  const description = `${study.subtitle}. Every number with its evidence level, under CC BY 4.0.`;

  const figuresHtml = study.headlineFindings
    .map((h) => `    <div><b>${escapeHtml(h.value)}</b><span>${escapeHtml(h.label)}</span></div>`)
    .join("\n");

  const sectionsHtml = study.sections.map(sectionHtml).join("\n\n");

  const notEstablished = study.notEstablished.map((n) => `    <li>${escapeHtml(n)}</li>`).join("\n");

  const toc = study.sections.map((s) => `    <li><a href="#${s.id}">${escapeHtml(s.title)}</a></li>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(study.studyName)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="DiffCI">
<meta property="og:title" content="${escapeHtml(study.studyName)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${urls.page}">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="${urls.page}">
<link rel="license" href="${study.license.url}">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='5' y='5' width='22' height='22' rx='4' fill='none' stroke='%23146b5a' stroke-width='3'/><path d='M16 5 L27 5 L27 27 L16 27 Z' fill='%23146b5a'/></svg>">
<script type="application/ld+json">
${JSON.stringify(
  {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: study.studyName,
    description,
    url: urls.page,
    identifier: study.studyId,
    version: study.version,
    dateModified: study.asOf,
    temporalCoverage: `${study.windowStart}/${study.windowEnd}`,
    license: study.license.url,
    creator: { "@type": "Organization", name: study.publisher, url: SITE_ORIGIN },
    distribution: [
      { "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: `${SITE_ORIGIN}${urls.csv}` },
      { "@type": "DataDownload", encodingFormat: "application/pdf", contentUrl: `${SITE_ORIGIN}${urls.pdf}` },
    ],
  },
  null,
  2,
)}
</script>
</head>
<body>

<header class="masthead">
  <div class="wrap">
    <a class="wordmark" href="/">DiffCI</a>
    <nav>
      <a href="/#evidence">Evidence</a>
      <a href="/#limits">Limits</a>
      <a href="/#pilot">Pilot</a>
    </nav>
  </div>
</header>

<main>
<article class="wrap">

  <a class="backlink" href="/#evidence">← All evidence</a>

  <p class="eyebrow">Open study · ${escapeHtml(study.license.name.replace(/ \(.*\)$/, ""))} · ${escapeHtml(study.studyId)}</p>
  <h1>${escapeHtml(study.studyName)}</h1>
  <p class="lede">${escapeHtml(study.subtitle)}.</p>

  <div class="disclaimer">
    <strong>None of the repositories named here is a DiffCI customer.</strong> ${escapeHtml(study.disclaimer.replace(/^Every repository named in this study is a public open-source project with public CI, analysed from its public source and replayed in DiffCI's own sandbox\. None of them is a DiffCI customer, partner or user\. /, "Each is a public open-source project with public CI, analysed from its public source and replayed in DiffCI's own sandbox. "))}
  </div>

  <h2 class="no-rule">The short version</h2>
  <p>${escapeHtml(study.lede)}</p>

  <div class="figures">
${figuresHtml}
  </div>

  <p class="fine">
    Evidence window ${escapeHtml(study.windowStart)} to ${escapeHtml(study.windowEnd)}. Every figure on this page is in the
    <a href="${urls.csv}">CSV</a> with its evidence level and the report that produced it.
    Download the <a href="${urls.pdf}">PDF</a>, or read the <a href="${urls.license}">licence</a>.
  </p>

  <ul class="toc">
${toc}
    <li><a href="#not-established">What this study does not establish</a></li>
    <li><a href="#cite">Download and cite</a></li>
  </ul>

${sectionsHtml}

  <h2 id="not-established">What this study does not establish</h2>
  <p>This section is part of the study, not a footnote to it.</p>
  <ul class="limits">
${notEstablished}
  </ul>

  <h2 id="cite">Download and cite</h2>
  <p>
    The study is published under the <a href="${study.license.url}">${escapeHtml(study.license.name)}</a>.
    Reproduce, adapt or republish any of it, including commercially, with credit to ${escapeHtml(study.publisher)} and a link to this page.
    The licence covers the study materials only, not the DiffCI software or the named repositories' code.
  </p>
  <ul>
    <li><a href="${urls.csv}">All ${study.figures.length} figures as CSV</a> - category, metric, value, unit, scope, evidence level, source report, note.</li>
    <li><a href="${urls.pdf}">Full report as PDF</a> - the same content as this page, rendered from the same data.</li>
    <li><a href="${urls.license}">LICENSE.txt</a></li>
  </ul>
  <p>
    Evidence levels used in the CSV: <strong>MEASURED</strong>, a clock or a counter produced the number in a real execution;
    <strong>PREDICTED</strong>, a frozen rule's prediction, committed before the measurement it predicted;
    <strong>PROCESS_FACT</strong>, something that happened rather than a measurement;
    <strong>ABSTAINED</strong>, DiffCI declined to produce a number and the abstention is the finding.
    Each row names the internal report that produced it; those reports are not yet public, and an evidence
    bundle of the frozen methodologies, aggregate inputs and results, manifests and checksums is the planned
    next release under this licence.
  </p>
  <p>Suggested citation:</p>
  <pre class="cite">${escapeHtml(citation(study))}</pre>

</article>
</main>

<footer>
  <div class="wrap">
    <p><strong>DiffCI</strong> — deterministic, change-aware CI planning.</p>
    <nav>
      <a href="/case-studies/calcom">cal.com</a>
      <a href="/case-studies/deepseek-harness">deepseek-harness</a>
      <a href="/case-studies/diffci-own-ci">our own CI</a>
      <a href="/${study.pagePath}">Open study</a>
      <a href="/data-handling">Data handling</a>
    </nav>
    <p class="fine">
      DiffCI currently ships under its founder's personal GitHub account,
      <a href="https://github.com/adityankale190895">@adityankale190895</a>. A company identity and a
      contact address for this site are not yet published; they will appear here when they are.
    </p>
  </div>
</footer>

</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// PDF - pdf-lib, standard fonts, no headless browser (same constraint DentalPresence hit)

const INK = rgb(0x17 / 255, 0x16 / 255, 0x14 / 255);
const INK2 = rgb(0x56 / 255, 0x53 / 255, 0x4c / 255);
const INK3 = rgb(0x8a / 255, 0x85 / 255, 0x7b / 255);
const ACCENT = rgb(0x14 / 255, 0x6b / 255, 0x5a / 255);
const RULE = rgb(0xe6 / 255, 0xe1 / 255, 0xd7 / 255);
const WASH = rgb(0xe8 / 255, 0xf2 / 255, 0xee / 255);
const WARN_WASH = rgb(0xfd / 255, 0xf4 / 255, 0xe0 / 255);
const SERIES_POS = rgb(0x1b / 255, 0xaf / 255, 0x7a / 255);
const SERIES_NEG = rgb(0xeb / 255, 0x68 / 255, 0x34 / 255);

const PAGE: [number, number] = [612, 792]; // US Letter
const MARGIN = 56;
const CONTENT_W = PAGE[0] - MARGIN * 2;

/** Helvetica in pdf-lib is WinAnsi: map the few non-Latin-1 glyphs the prose uses, drop the rest. */
function pdfSafe(text: string): string {
  return stripTags(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/→/g, "->")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/−/g, "-")
    .replace(/×/g, "x")
    .replace(/[^ -ÿ–—‘’“”…•]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawParagraph of text.split("\n")) {
    const words = rawParagraph.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

class Doc {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  constructor(
    readonly pdf: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly footerText: string,
  ) {}

  newPage() {
    this.page = this.pdf.addPage(PAGE);
    this.pageNo += 1;
    this.y = PAGE[1] - MARGIN;
    const footer = `${this.footerText}  ·  page ${this.pageNo}`;
    this.page.drawText(footer, { x: MARGIN, y: 28, size: 7.5, font: this.regular, color: INK3 });
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.newPage();
  }

  text(text: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; leading?: number; x?: number; width?: number; after?: number } = {}) {
    const size = opts.size ?? 9.5;
    const font = opts.font ?? this.regular;
    const leading = opts.leading ?? size * 1.42;
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? CONTENT_W - (x - MARGIN);
    const lines = wrap(pdfSafe(text), font, size, width);
    for (const line of lines) {
      this.ensure(leading);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: opts.color ?? INK });
      this.y -= leading;
    }
    this.y -= opts.after ?? 6;
  }

  heading(text: string, level: 1 | 2 = 2) {
    const size = level === 1 ? 20 : 13.5;
    this.ensure(size * 3);
    this.y -= level === 1 ? 6 : 10;
    if (level === 2) {
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + CONTENT_W, y: this.y }, thickness: 0.6, color: RULE });
      this.y -= 12;
    }
    this.text(text, { size, font: this.bold, leading: size * 1.25, after: 8 });
  }

  bullets(items: readonly string[]) {
    for (const item of items) {
      const lines = wrap(pdfSafe(item), this.regular, 9.2, CONTENT_W - 14);
      this.ensure(lines.length * 13);
      this.page.drawText("•", { x: MARGIN + 2, y: this.y - 9.2, size: 9.2, font: this.regular, color: ACCENT });
      for (const line of lines) {
        this.page.drawText(line, { x: MARGIN + 14, y: this.y - 9.2, size: 9.2, font: this.regular, color: INK });
        this.y -= 13;
      }
      this.y -= 3;
    }
    this.y -= 4;
  }

  table(t: StudyTable) {
    const size = 8;
    const pad = 4;
    const cols = t.columns.length;
    // First column gets extra room; the rest share what is left.
    const firstW = Math.min(CONTENT_W * 0.34, 190);
    const otherW = (CONTENT_W - firstW) / Math.max(1, cols - 1);
    const widths = t.columns.map((_, i) => (i === 0 ? firstW : otherW));
    const num = new Set(t.numericColumns);

    const drawRow = (cells: readonly string[], font: PDFFont, shade: boolean) => {
      const wrapped = cells.map((c, i) => wrap(pdfSafe(c), font, size, widths[i]! - pad * 2));
      const lines = Math.max(1, ...wrapped.map((w) => w.length));
      const h = lines * (size * 1.35) + pad * 2;
      this.ensure(h);
      if (shade) this.page.drawRectangle({ x: MARGIN, y: this.y - h, width: CONTENT_W, height: h, color: WASH });
      let x = MARGIN;
      wrapped.forEach((w, i) => {
        w.forEach((line, li) => {
          const tw = font.widthOfTextAtSize(line, size);
          const tx = num.has(i) && i > 0 ? x + widths[i]! - pad - tw : x + pad;
          this.page.drawText(line, { x: tx, y: this.y - pad - size - li * size * 1.35, size, font, color: INK });
        });
        x += widths[i]!;
      });
      this.y -= h;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + CONTENT_W, y: this.y }, thickness: 0.4, color: RULE });
    };

    this.ensure(60);
    drawRow(t.columns, this.bold, true);
    t.rows.forEach((r) => drawRow(r, this.regular, false));
    this.y -= 6;
    this.text(t.caption, { size: 7.6, color: INK3, leading: 10.5, after: 10 });
  }

  chart(c: StudyChart) {
    const rowH = 15;
    const labelW = 150;
    const valueW = 48;
    const plotW = CONTENT_W - labelW - valueW;
    const negExtent = Math.max(0, -Math.min(...c.data.map((d) => d.value)));
    const posExtent = Math.max(0, Math.max(...c.data.map((d) => d.value)));
    const scale = plotW / (negExtent + posExtent || 1);
    const zeroX = MARGIN + labelW + negExtent * scale;
    const total = c.data.length * rowH + 40;
    this.ensure(total + 30);
    this.text(c.title, { size: 9.5, font: this.bold, after: 4 });
    // legend
    this.page.drawRectangle({ x: MARGIN, y: this.y - 8, width: 8, height: 8, color: SERIES_POS });
    this.page.drawText("fewer tests than the path rule", { x: MARGIN + 12, y: this.y - 7.5, size: 7.5, font: this.regular, color: INK2 });
    this.page.drawRectangle({ x: MARGIN + 150, y: this.y - 8, width: 8, height: 8, color: SERIES_NEG });
    this.page.drawText("more tests than the path rule", { x: MARGIN + 162, y: this.y - 7.5, size: 7.5, font: this.regular, color: INK2 });
    this.y -= 18;
    const top = this.y;
    for (const d of c.data) {
      const w = Math.max(1.5, Math.abs(d.value) * scale);
      const x = d.value >= 0 ? zeroX + 1 : zeroX - 1 - w;
      this.page.drawText(pdfSafe(d.label), { x: MARGIN, y: this.y - 10, size: 7.8, font: this.regular, color: INK2 });
      this.page.drawRectangle({ x, y: this.y - 12, width: w, height: 9, color: d.value >= 0 ? SERIES_POS : SERIES_NEG });
      const v = `${d.value > 0 ? "+" : ""}${d.value.toFixed(1)}${c.unit}`;
      const vw = this.regular.widthOfTextAtSize(v, 7.5);
      const vx = d.value >= 0 ? x + w + 4 : x - 4 - vw;
      this.page.drawText(v, { x: vx, y: this.y - 10, size: 7.5, font: this.regular, color: INK2 });
      this.y -= rowH;
    }
    this.page.drawLine({ start: { x: zeroX, y: top }, end: { x: zeroX, y: this.y + 2 }, thickness: 0.6, color: INK3 });
    this.page.drawText("0 = same as the path rule", { x: zeroX - 45, y: this.y - 8, size: 7, font: this.regular, color: INK3 });
    this.y -= 18;
    this.text(c.caption, { size: 7.6, color: INK3, leading: 10.5, after: 10 });
  }
}

export async function renderPdf(study: StudyFindings): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(study.studyName);
  pdf.setAuthor(study.publisher);
  pdf.setSubject(study.subtitle);
  pdf.setKeywords(["CI", "test selection", "dependency graph", "open study", "CC BY 4.0"]);
  pdf.setProducer("scripts/render-open-study.ts (pdf-lib)");
  pdf.setCreator("DiffCI");
  const fixed = new Date(`${study.asOf}T00:00:00Z`);
  pdf.setCreationDate(fixed);
  pdf.setModificationDate(fixed);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const doc = new Doc(pdf, regular, bold, `${study.studyName} (${study.studyId}) · CC BY 4.0 · ${publicUrls(study).page}`);

  // Cover
  doc.newPage();
  doc.page.drawRectangle({ x: 0, y: PAGE[1] - 120, width: PAGE[0], height: 120, color: WASH });
  doc.y = PAGE[1] - 52;
  doc.text("DiffCI  ·  Open study  ·  CC BY 4.0", { size: 9, font: bold, color: ACCENT, after: 14 });
  doc.y -= 30;
  doc.text(study.studyName, { size: 24, font: bold, leading: 28, after: 10 });
  doc.text(study.subtitle, { size: 12, color: INK2, leading: 16, after: 18 });
  doc.text(`Published by ${study.publisher}. Evidence window ${study.windowStart} to ${study.windowEnd}. Version ${study.version}, as of ${study.asOf}.`, { size: 9, color: INK2, after: 16 });

  const boxLines = wrap(pdfSafe(study.disclaimer), regular, 9, CONTENT_W - 24);
  const boxH = boxLines.length * 12.6 + 20;
  doc.page.drawRectangle({ x: MARGIN, y: doc.y - boxH, width: CONTENT_W, height: boxH, color: WARN_WASH });
  doc.y -= 10;
  doc.text(study.disclaimer, { size: 9, x: MARGIN + 12, width: CONTENT_W - 24, leading: 12.6, after: 24 });

  doc.text(study.lede, { size: 10, leading: 14.5, after: 16 });

  doc.heading("Headline findings");
  const colW = CONTENT_W / 2;
  study.headlineFindings.forEach((h, i) => {
    const col = i % 2;
    if (col === 0) doc.ensure(44);
    const x = MARGIN + col * colW;
    const yTop = doc.y;
    doc.page.drawText(pdfSafe(h.value), { x, y: yTop - 16, size: 15, font: bold, color: ACCENT });
    const lines = wrap(pdfSafe(h.label), regular, 8, colW - 16);
    lines.forEach((l, li) => doc.page.drawText(l, { x, y: yTop - 28 - li * 10, size: 8, font: regular, color: INK2 }));
    if (col === 1 || i === study.headlineFindings.length - 1) doc.y -= 30 + Math.max(2, lines.length) * 10;
  });
  doc.y -= 8;

  // Sections
  for (const s of study.sections) {
    doc.heading(s.title);
    for (const p of s.paragraphs) doc.text(p, { size: 9.5, leading: 13.5, after: 7 });
    for (const c of s.charts ?? []) doc.chart(c);
    for (const t of s.tables ?? []) doc.table(t);
    if (s.bullets?.length) doc.bullets(s.bullets);
  }

  doc.heading("What this study does not establish");
  doc.text("This section is part of the study, not a footnote to it.", { size: 9.5, after: 6 });
  doc.bullets(study.notEstablished);

  doc.heading("Download and cite");
  const urls = publicUrls(study);
  doc.text(`Published under the ${study.license.name}. Reproduce, adapt or republish any of it, including commercially, with credit to ${study.publisher} and a link to the study page. The licence covers the study materials only, not the DiffCI software or the named repositories' code.`, { size: 9.5, leading: 13.5, after: 6 });
  doc.text(`CSV of all ${study.figures.length} figures: ${SITE_ORIGIN}${urls.csv}`, { size: 9, color: INK2, after: 2 });
  doc.text(`Study page: ${urls.page}`, { size: 9, color: INK2, after: 2 });
  doc.text(`Licence: ${study.license.url}`, { size: 9, color: INK2, after: 10 });
  doc.text(`Evidence levels used in the CSV: ${EVIDENCE_LEVEL_KEY} Each row names the internal report that produced it; those reports are not yet public, and an evidence bundle of the frozen methodologies, aggregate inputs and results, manifests and checksums is the planned next release under this licence.`, { size: 9, color: INK2, leading: 12.5, after: 8 });
  doc.text("Suggested citation:", { size: 9.5, font: bold, after: 3 });
  doc.text(citation(study), { size: 9, color: INK2, leading: 12.5, after: 10 });

  return pdf.save();
}

// ---------------------------------------------------------------------------------------------

export async function renderAll(study: StudyFindings = diffciOpenEvidenceStudy2026) {
  const out = outputPaths(study);
  await mkdir(path.dirname(out.html), { recursive: true });
  await mkdir(path.dirname(out.csv), { recursive: true });
  await writeFile(out.html, renderHtml(study), "utf8");
  await writeFile(out.csv, renderCsv(study), "utf8");
  await writeFile(out.license, renderLicense(study), "utf8");
  await writeFile(out.pdf, await renderPdf(study));
  return out;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  renderAll()
    .then((out) => {
      for (const p of Object.values(out)) process.stdout.write(`wrote ${path.relative(repoRoot, p)}\n`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
