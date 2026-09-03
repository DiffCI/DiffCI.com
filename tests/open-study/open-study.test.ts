// Guards for the Open Evidence Study 2026.
//
// 1. Every figure has a source path that exists in this repository - a number nobody can trace
//    does not ship (docs/website/README.md rule 2).
// 2. The rendered HTML, CSV and LICENSE on disk are byte-identical to what the findings module
//    renders now - editing the module without `npm run study:render` fails here, so the published
//    files can never drift from the data. (The PDF is checked for existence and header only; its
//    bytes depend on pdf-lib's object ordering, not on anything worth asserting.)
// 3. The chart's numbers are the table's numbers.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { diffciOpenEvidenceStudy2026 as study } from "../../src/open-study/diffci-open-evidence-2026.js";
import { outputPaths, renderCsv, renderHtml, renderLicense, repoRoot } from "../../scripts/render-open-study.js";

test("every figure has a unique id, an evidence level and a source that exists", () => {
  const ids = new Set<string>();
  for (const fig of study.figures) {
    assert.ok(!ids.has(fig.id), `duplicate figure id ${fig.id}`);
    ids.add(fig.id);
    assert.ok(fig.value.length > 0, `${fig.id} has no value`);
    assert.ok(["MEASURED", "PREDICTED", "PROCESS_FACT", "ABSTAINED"].includes(fig.level), `${fig.id} level`);
    assert.ok(existsSync(path.join(repoRoot, fig.source)), `${fig.id}: source not found: ${fig.source}`);
  }
  for (const s of study.sourceReports) {
    assert.ok(existsSync(path.join(repoRoot, s.path)), `source report not found: ${s.path}`);
  }
});

test("every source report cited by a figure is listed in the sources table", () => {
  const listed = new Set(study.sourceReports.map((s) => s.path));
  for (const fig of study.figures) assert.ok(listed.has(fig.source), `${fig.source} (from ${fig.id}) is not in sourceReports`);
});

test("rendered files on disk match the findings module (run `npm run study:render` if this fails)", () => {
  const out = outputPaths(study);
  // Line endings are normalised so a Windows checkout with core.autocrlf does not fail the guard.
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  assert.equal(lf(readFileSync(out.html, "utf8")), renderHtml(study), "site HTML is stale");
  assert.equal(lf(readFileSync(out.csv, "utf8")), renderCsv(study), "CSV is stale");
  assert.equal(lf(readFileSync(out.license, "utf8")), renderLicense(study), "LICENSE.txt is stale");
  assert.ok(existsSync(out.pdf), "PDF missing");
  assert.equal(readFileSync(out.pdf).subarray(0, 5).toString("latin1"), "%PDF-", "PDF header");
});

test("CSV has one row per figure and a stable header", () => {
  const lines = renderCsv(study).trimEnd().split("\n");
  assert.equal(lines[0], "category,metric,value,unit,scope,evidence_level,source_report,note,study_id");
  assert.equal(lines.length - 1, study.figures.length);
});

test("published artefacts do not cite internal repository paths", () => {
  // The repository is private; a path a reader cannot open is noise, not evidence. Source paths
  // stay in the module for the existence check above and are replaced by report labels on output.
  for (const [name, text] of [["html", renderHtml(study)], ["csv", renderCsv(study)], ["license", renderLicense(study)]] as const) {
    assert.doesNotMatch(text, /\bdocs\/(research|evidence|website|yc)\//, `${name} cites an internal path`);
    assert.doesNotMatch(text, /\.md\b/, `${name} cites a markdown file`);
  }
});

test("chart data agrees with the per-repository table", () => {
  const section = study.sections.find((s) => s.id === "where-the-advantage-lives");
  const chart = section?.charts?.find((c) => c.id === "stage0-per-repository");
  assert.ok(chart && section?.tables?.[0]);
  const table = section.tables[0];
  for (const d of chart.data) {
    const row = table.rows.find((r) => r[0] === d.label);
    assert.ok(row, `chart label ${d.label} is not in the table`);
    assert.equal(Number.parseFloat(row[3]!.replace("%", "")), d.value, `${d.label}: chart ${d.value} vs table ${row[3]}`);
  }
});

test("every chart value that names a figure equals that figure", () => {
  let checked = 0;
  for (const s of study.sections) {
    for (const c of s.charts ?? []) {
      for (const d of c.data) {
        if (!d.figure) continue;
        const fig = study.figures.find((f) => f.id === d.figure);
        assert.ok(fig, `${c.id}: unknown figure ${d.figure}`);
        assert.equal(Number.parseFloat(fig.value), d.value, `${c.id} / ${d.label}: chart ${d.value} vs figure ${fig.value}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 12, `expected the figure-backed charts to be checked, got ${checked}`);
});

test("stacked charts sum to 100 and the economics chart is the economics table", () => {
  for (const s of study.sections) {
    for (const c of s.charts ?? []) {
      if (c.kind !== "stacked-single") continue;
      const total = c.data.reduce((sum, d) => sum + d.value, 0);
      assert.ok(Math.abs(total - 100) < 0.15, `${c.id} segments sum to ${total}`);
    }
  }
  const section = study.sections.find((s) => s.id === "against-a-path-rule");
  const chart = section?.charts?.find((c) => c.id === "compute-economics-chart");
  const table = section?.tables?.find((t) => t.id === "compute-economics");
  assert.ok(chart && table);
  const tableValues = new Set(table.rows.map((r) => Number.parseFloat(r[5]!)));
  for (const d of chart.data) assert.ok(tableValues.has(d.value), `${d.label}: ${d.value} is not in the economics table`);
  assert.equal(chart.data.length, table.rows.length);
});

test("the page carries the disclaimer, the licence and the unflattering numbers", () => {
  const html = renderHtml(study);
  assert.match(html, /None of the repositories named here is a DiffCI customer/);
  assert.match(html, /creativecommons\.org\/licenses\/by\/4\.0/);
  assert.match(html, /4\.2%/, "the aggregate figure must stay on the page");
  assert.match(html, /-80\.90/, "the hono loss must stay on the page");
  assert.match(html, /0\.696/, "the preflight recall must stay on the page");
  assert.match(html, /production CI runs ever skipped/);
});
