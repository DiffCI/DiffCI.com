/**
 * Seamless install (2026-09-05): the automatic identification job against real SQLite (real migrations)
 * and a fake GitHub, plus the store rules it relies on - explicit precedence, withdrawal on
 * none_found/shape_mismatch, report privacy tokens, and the launch-budget fairness caps.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1ShadowStore, type D1Binding } from "../../../src/research/cloudflare/shadow-store.js";
import { identifyRepository, type IdentificationGitHub, type RepositoryFacts } from "../../../src/research/cloudflare/shadow-identification-job.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../src/research/cloudflare");
const MIGRATIONS = [
  "schema-migration-2026-08-21-stage2-shadow.sql",
  "schema-migration-2026-08-21-shadow-cron.sql",
  "schema-migration-2026-08-21-shadow-webhook.sql",
  "schema-migration-2026-08-21-shadow-source-integrity.sql",
  "schema-migration-2026-08-21-shadow-reconcile-diagnostics.sql",
  "schema-migration-2026-08-25-shadow-economics.sql",
  "schema-migration-2026-08-26-head-transitions.sql",
  "schema-migration-2026-08-26-launch-slots.sql",
  "schema-migration-2026-08-26-shadow-liveness.sql",
  "schema-migration-2026-09-04-shadow-push-polls.sql",
  "schema-migration-2026-09-05-shadow-reconcile-terminal.sql",
  "schema-migration-2026-09-05-shadow-evidence-workflow.sql",
  "schema-migration-2026-09-05-shadow-stage-economics.sql",
  "schema-migration-2026-09-05-shadow-auto-identification.sql",
];

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync(join(SCHEMA_DIR, f), "utf8"));
  return db;
}

function makeD1(db: DatabaseSync): D1Binding {
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              const result = db.prepare(query).run(...(values as never[]));
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T = unknown>() {
              return { results: db.prepare(query).all(...(values as never[])) as T[] };
            },
            async first<T = unknown>() {
              return (db.prepare(query).get(...(values as never[])) ?? null) as T | null;
            },
          };
        },
      };
    },
  };
}

const CI = `name: CI
on:
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Test
        run: npm test
`;

function fakeGitHub(overrides: Partial<RepositoryFacts> = {}, files: Record<string, string> = {}): IdentificationGitHub {
  return {
    async repositoryFacts() {
      return { defaultBranch: "main", archived: false, isPrivate: true, workflowPaths: [".github/workflows/ci.yml"], workflowsTreeSha: "tree1", tsconfig: "root", hasActionsRuns: true, ...overrides };
    },
    async fileContent(_repo, path) {
      return files[path];
    },
  };
}

const FILES = { ".github/workflows/ci.yml": CI, "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) };

describe("identifyRepository (real store, fake GitHub)", () => {
  it("identifies the workflow that runs the tests, derives the stage layout, records the derivation, privacy and token", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "github-app-webhook");
    const outcome = await identifyRepository({ store, github: fakeGitHub({}, FILES), nowIso: () => "2026-09-05T10:00:00.000Z" }, "acme/web");
    assert.equal(outcome.status, "identified");
    assert.deepEqual(outcome.evidenceWorkflowPaths, [".github/workflows/ci.yml"]);
    const ident = (await store.getIdentification("acme/web"))!;
    assert.equal(ident.source, "auto");
    assert.equal(ident.status, "identified");
    assert.deepEqual(ident.evidenceWorkflowPaths, [".github/workflows/ci.yml"]);
    assert.equal(ident.workflowsTreeSha, "tree1");
    const derivation = JSON.parse(ident.derivationJson!);
    assert.equal(derivation.chosen.path, ".github/workflows/ci.yml");
    const cfg = JSON.parse((await store.getStageClassificationRaw("acme/web"))!);
    assert.deepEqual(cfg.steps, [{ job: "check", step: "Test", stage: "test" }]);
    const access = (await store.getReportAccess("acme/web"))!;
    assert.equal(access.isPrivate, true);
    assert.match(access.token!, /^[0-9a-f]{64}$/);
    assert.equal(await store.getEvidenceWorkflowPaths("acme/web").then((p) => p?.[0]), ".github/workflows/ci.yml", "the reconciler's identity mode sees it immediately");
  });

  it("an explicit configuration is never overwritten by the automatic path", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "github-app-webhook");
    await store.setEvidenceWorkflowPaths("acme/web", [".github/workflows/hand.yml"]);
    const outcome = await identifyRepository({ store, github: fakeGitHub({}, FILES) }, "acme/web");
    assert.equal(outcome.status, "explicit");
    assert.deepEqual(await store.getEvidenceWorkflowPaths("acme/web"), [".github/workflows/hand.yml"]);
    assert.equal((await store.getIdentification("acme/web"))!.source, "explicit");
  });

  it("none_found is recorded with the reason and no evidence workflow; ineligible repositories become UNSUPPORTED with the reason", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/lintonly", "github-app-webhook");
    const lint = `on: [push]\njobs:\n  l:\n    runs-on: ubuntu-latest\n    steps:\n      - run: eslint .\n`;
    const none = await identifyRepository({ store, github: fakeGitHub({}, { ".github/workflows/lint.yml": lint }) }, "acme/lintonly");
    // the fake lists ci.yml but only lint.yml has content -> effectively one lint-only workflow
    assert.equal(none.status, "none_found");
    const ident = (await store.getIdentification("acme/lintonly"))!;
    assert.equal(ident.status, "none_found");
    assert.equal(ident.evidenceWorkflowPaths, undefined);
    assert.ok(ident.note?.includes("runs a test command") || ident.note?.includes("no GitHub Actions workflows"));

    await store.ensureRepository("acme/py", "github-app-webhook");
    const inel = await identifyRepository({ store, github: fakeGitHub({ tsconfig: "none" }, FILES) }, "acme/py");
    assert.equal(inel.status, "ineligible");
    const py = (await store.getIdentification("acme/py"))!;
    assert.equal(py.state, "UNSUPPORTED");
    assert.ok(py.notes?.includes("tsconfig.json"));
  });

  it("a shape mismatch recorded later withdraws the automatic evidence workflow but keeps the derivation, and the repository is re-checked", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "github-app-webhook");
    await identifyRepository({ store, github: fakeGitHub({}, FILES), nowIso: () => "2026-09-05T10:00:00.000Z" }, "acme/web");
    await store.recordIdentification({ repository: "acme/web", status: "shape_mismatch", note: "none of the derived jobs appear", at: "2026-09-05T11:00:00.000Z" });
    const ident = (await store.getIdentification("acme/web"))!;
    assert.equal(ident.evidenceWorkflowPaths, undefined);
    assert.equal(ident.status, "shape_mismatch");
    assert.ok(ident.derivationJson, "the derivation stays on record");
    assert.deepEqual(await store.listRepositoriesNeedingIdentification("2026-09-05T18:00:00.000Z", 6 * 60 * 60 * 1000, 10), ["acme/web"], "re-checked after the recheck window");
    assert.deepEqual(await store.listRepositoriesNeedingIdentification("2026-09-05T12:00:00.000Z", 6 * 60 * 60 * 1000, 10), [], "not before it");
  });

  it("never-attempted repositories are listed first for identification; explicit ones never are", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/new", "github-app-webhook");
    await store.ensureRepository("acme/hand", "github-app-webhook");
    await store.setEvidenceWorkflowPaths("acme/hand", [".github/workflows/ci.yml"]);
    assert.deepEqual(await store.listRepositoriesNeedingIdentification("2026-09-05T10:00:00.000Z", 1000, 10), ["acme/new"]);
  });
});

describe("launch-budget fairness caps", () => {
  it("refuses a repository past its own daily cap and a source past its share, before the global ceiling", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("unjs/corpus", "cloudflare-poll");
    await store.ensureRepository("acme/installed", "github-app-webhook");
    const caps = { perRepositoryPerDay: 2, perSourcePerDay: { "cloudflare-poll": 3 } as const };
    assert.equal((await store.reserveLaunchSlot("unjs/corpus", 60, caps)).granted, true);
    assert.equal((await store.reserveLaunchSlot("unjs/corpus", 60, caps)).granted, true);
    const third = await store.reserveLaunchSlot("unjs/corpus", 60, caps);
    assert.equal(third.granted, false);
    assert.equal(third.refusedBy, "repository");
    // Another corpus repository takes the source's last slot; a third corpus repo is refused by source.
    await store.ensureRepository("unjs/other", "cloudflare-poll");
    assert.equal((await store.reserveLaunchSlot("unjs/other", 60, caps)).granted, true);
    await store.ensureRepository("unjs/third", "cloudflare-poll");
    const bySource = await store.reserveLaunchSlot("unjs/third", 60, caps);
    assert.equal(bySource.granted, false);
    assert.equal(bySource.refusedBy, "source");
    // The installed repository is unaffected by the corpus share.
    assert.equal((await store.reserveLaunchSlot("acme/installed", 60, caps)).granted, true);
    // The global ceiling still applies.
    const ceiling = await store.reserveLaunchSlot("acme/installed", 4, caps);
    assert.equal(ceiling.granted, false);
    assert.equal(ceiling.refusedBy, "day");
  });
});

describe("listReportAccessCandidates (real sqlite)", () => {
  it("lists App-installed repositories with privacy and token, never the polled corpus or removed rows", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/private-app", "github-app-webhook");
    await store.setInstallationId("acme/private-app", "1001");
    await store.setRepositoryPrivacy("acme/private-app", true);
    await store.ensureRepository("acme/public-lib", "github-app-webhook");
    await store.setInstallationId("acme/public-lib", "1001");
    await store.setRepositoryPrivacy("acme/public-lib", false);
    await store.ensureRepository("corpus/polled", "cloudflare-poll"); // no installation: nobody installed anything
    await store.ensureRepository("acme/gone", "github-app-webhook");
    await store.setInstallationId("acme/gone", "1002");
    await store.setRepositoryState("acme/gone", "REMOVED");

    const candidates = await store.listReportAccessCandidates(50);
    assert.deepEqual(candidates.map((c) => c.repository), ["acme/private-app", "acme/public-lib"]);
    assert.equal(candidates[0]!.isPrivate, true);
    assert.equal(typeof candidates[0]!.reportToken, "string", "a private repository's token exists once privacy is recorded");
    assert.equal(candidates[1]!.isPrivate, false);
  });
});
