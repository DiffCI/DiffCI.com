/**
 * Phase 03's exit criterion, in two halves (2026-08-26): "org A provably can't read org B".
 *
 * BEHAVIOURAL. Two organizations, each with a repository, a credential and stored observations. Every
 * ingest route is then called by org A's user against org B's data, using real ids - not guessed ones,
 * so a failure to scope shows up as a leak rather than as a lookup miss. The delete cases matter as
 * much as the read cases: erasure that crossed a tenant boundary would be worse than a read that did.
 *
 * STRUCTURAL. The behavioural half only covers the queries that exist today. The second half reads the
 * ingest modules' own SQL and fails if any statement against a tenant table lacks an organization_id
 * predicate - so a query added next month is checked by this test before anyone reviews it. Statements
 * that legitimately cannot be scoped (the retention sweep, which crosses tenants by definition; the
 * token lookup, which is how an organization is established in the first place) are listed explicitly
 * with their reason, and adding to that list is a deliberate act rather than an oversight.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeReport } from "./report-fixture.js";
import { ingestObservation } from "../../src/ingest/ingest.js";
import { makeD1ObservationStore } from "../../src/ingest/store.js";
import { makeD1IngestTokenStore } from "../../src/ingest/token.js";
import {
  deleteObservationsForOrganization,
  getInstallInstructionsForRepository,
  getObservationForOrganization,
  issueIngestTokenForRepository,
  listIngestTokensForOrganization,
  listObservationsForOrganization,
  revokeIngestToken,
  type IngestRouteDeps,
} from "../../src/ingest/routes.js";
import { makeD1ProductStore } from "../../src/product/store.js";
import { TEST_PINNED_AGENT } from "../helpers/agent-artifact.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function twoTenants() {
  const db = freshProductDb(["ingest", "usage"]);
  const d1 = makeD1(db);
  const productStore = makeD1ProductStore(d1);
  const tokenStore = makeD1IngestTokenStore(d1);
  const observationStore = makeD1ObservationStore(d1);

  const userA = await productStore.createUser({ email: "a@example.com" });
  const userB = await productStore.createUser({ email: "b@example.com" });
  const orgA = await productStore.createOrganization({ name: "A", slug: "a", ownerUserId: userA.id });
  const orgB = await productStore.createOrganization({ name: "B", slug: "b", ownerUserId: userB.id });
  const repoA = await productStore.createRepository({ organizationId: orgA.id, providerRepositoryId: "111", ownerName: "a/app" });
  const repoB = await productStore.createRepository({ organizationId: orgB.id, providerRepositoryId: "222", ownerName: "b/app" });

  const tokenA = await tokenStore.issue({ organizationId: orgA.id, repositoryId: repoA.id });
  const tokenB = await tokenStore.issue({ organizationId: orgB.id, repositoryId: repoB.id });

  const ingestDeps = { tokenStore, observationStore, productStore };
  const observedA = await ingestObservation(
    { authorization: `Bearer ${tokenA.raw}`, body: JSON.stringify(makeReport()) },
    ingestDeps,
  );
  const observedB = await ingestObservation(
    {
      authorization: `Bearer ${tokenB.raw}`,
      body: JSON.stringify(
        makeReport({
          repository: { provider: "github", ownerName: "b/app", providerRepositoryId: "222" },
          ci: { provider: "github-actions", runId: "7777", runAttempt: "1" },
        }),
      ),
    },
    ingestDeps,
  );
  assert.equal(observedA.ok && observedB.ok, true, "fixture setup should have stored one observation per tenant");

  const deps: IngestRouteDeps = {
    productStore,
    tokenStore,
    observationStore,
    agentArtifact: TEST_PINNED_AGENT,
    apiOrigin: "https://api.diffci.test",
  };
  return {
    deps,
    productStore,
    tokenStore,
    observationStore,
    userA,
    userB,
    orgA,
    orgB,
    repoA,
    repoB,
    tokenA,
    tokenB,
    observationA: (observedA as { record: { id: string } }).record,
    observationB: (observedB as { record: { id: string } }).record,
  };
}

describe("tenant isolation: org A cannot reach org B", () => {
  it("cannot list org B's observations", async () => {
    const { deps, userA, orgB } = await twoTenants();
    const outcome = await listObservationsForOrganization(deps, userA.id, orgB.id);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error, "unauthorized");
  });

  it("cannot read org B's observation by its real id, from inside its own organization", async () => {
    const { deps, userA, orgA, observationB } = await twoTenants();
    const outcome = await getObservationForOrganization(deps, userA.id, orgA.id, observationB.id);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    // not_found, not unauthorized: the answer must not confirm that the id exists somewhere else.
    assert.equal(outcome.error, "not_found");
  });

  it("cannot filter its own listing by org B's repository", async () => {
    const { deps, userA, orgA, repoB } = await twoTenants();
    const outcome = await listObservationsForOrganization(deps, userA.id, orgA.id, { repositoryId: repoB.id });
    assert.equal(outcome.ok === false && outcome.error, "not_found");
  });

  it("sees only its own rows and its own totals", async () => {
    const { deps, userA, orgA, repoA } = await twoTenants();
    const outcome = await listObservationsForOrganization(deps, userA.id, orgA.id);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.data.observations.length, 1);
    assert.equal(outcome.data.observations[0]!.repositoryId, repoA.id);
    assert.equal(outcome.data.summary.total, 1);
    assert.equal(outcome.data.summary.distinctRepositories, 1);
  });

  it("cannot mint a credential for org B's repository", async () => {
    const { deps, userA, orgA, repoB } = await twoTenants();
    const outcome = await issueIngestTokenForRepository(deps, userA.id, orgA.id, repoB.id);
    assert.equal(outcome.ok === false && outcome.error, "not_found");
  });

  it("cannot list or revoke org B's credentials", async () => {
    const { deps, tokenStore, userA, orgA, tokenB } = await twoTenants();

    const listed = await listIngestTokensForOrganization(deps, userA.id, orgA.id);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data.some((token) => token.id === tokenB.record.id), false);

    const revoke = await revokeIngestToken(deps, userA.id, orgA.id, tokenB.record.id);
    assert.equal(revoke.ok === false && revoke.error, "not_found");
    assert.equal((await tokenStore.verify(tokenB.raw)).ok, true, "org B's credential still works");
  });

  it("cannot read install instructions for org B's repository", async () => {
    const { deps, userA, orgA, repoB } = await twoTenants();
    const outcome = await getInstallInstructionsForRepository(deps, userA.id, orgA.id, repoB.id);
    assert.equal(outcome.ok === false && outcome.error, "not_found");
  });

  it("erasing everything in org A leaves org B untouched", async () => {
    const { deps, observationStore, userA, userB, orgA, orgB } = await twoTenants();

    const deleted = await deleteObservationsForOrganization(deps, userA.id, orgA.id);
    assert.equal(deleted.ok, true);
    if (!deleted.ok) return;
    assert.equal(deleted.data.deleted, 1);

    assert.equal((await observationStore.summarise(orgA.id)).total, 0);
    assert.equal((await observationStore.summarise(orgB.id)).total, 1);

    const stillThere = await listObservationsForOrganization(deps, userB.id, orgB.id);
    assert.equal(stillThere.ok === true && stillThere.data.observations.length, 1);
  });

  it("cannot erase org B's data", async () => {
    const { deps, observationStore, userA, orgB } = await twoTenants();
    const outcome = await deleteObservationsForOrganization(deps, userA.id, orgB.id);
    assert.equal(outcome.ok === false && outcome.error, "unauthorized");
    assert.equal((await observationStore.summarise(orgB.id)).total, 1);
  });

  it("a member of both organizations still sees exactly the one they asked about", async () => {
    const { deps, productStore, userA, orgA, orgB, repoB } = await twoTenants();
    await productStore.addMember(orgB.id, userA.id, "member");

    const asA = await listObservationsForOrganization(deps, userA.id, orgA.id);
    const asB = await listObservationsForOrganization(deps, userA.id, orgB.id);
    assert.equal(asA.ok === true && asA.data.observations.length, 1);
    assert.equal(asB.ok === true && asB.data.observations.length, 1);
    if (!asA.ok || !asB.ok) return;
    assert.notEqual(asA.data.observations[0]!.id, asB.data.observations[0]!.id);
    assert.equal(asB.data.observations[0]!.repositoryId, repoB.id);
  });
});

/**
 * Statements that genuinely cannot carry an organization predicate, each with the reason it cannot.
 * A new entry here is a decision to be defended in review; the point of the list is that it is short
 * and that nothing joins it by accident.
 */
const ALLOWED_UNSCOPED: Array<{ sql: RegExp; reason: string }> = [
  { sql: /^DELETE FROM observations WHERE received_at < \?$/, reason: "retention sweep - the 90-day cap is a promise about every row, not one tenant's" },
  { sql: /^SELECT COUNT\(\*\) AS n FROM observations WHERE received_at < \?$/, reason: "retention health count, same reason" },
  { sql: /^SELECT \* FROM ingest_tokens WHERE token_hash = \?$/, reason: "token lookup IS how an organization is established; it cannot presuppose one" },
  { sql: /^UPDATE ingest_tokens SET last_used_at = \? WHERE id = \?$/, reason: "stamps a row already resolved from a verified token; writes no tenant-visible data" },
];

const TENANT_TABLES = ["observations", "ingest_tokens", "invoices", "invoice_lines"];

/** Every SQL string handed to db.prepare() in a module, flattened to one line. */
function preparedStatements(relativePath: string): string[] {
  const source = readFileSync(join(REPO_ROOT, relativePath), "utf8");
  const statements: string[] = [];
  // Matches `.prepare(` followed by a template literal, and deliberately does NOT require the closing
  // parenthesis: several calls pass the SQL as the first of several arguments, and requiring `)` made
  // this silently skip four of the statements it exists to check.
  const pattern = /\.prepare\(\s*`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    statements.push(match[1]!.replace(/\s+/g, " ").trim());
  }
  return statements;
}

describe("tenant isolation is structural, not remembered", () => {
  it("every read, update and delete against a tenant table is scoped by organization_id", () => {
    // src/billing/invoice-store.ts is in this list for the strongest reason of the three: it holds money.
    const modules = ["src/ingest/store.ts", "src/ingest/token.ts", "src/billing/invoice-store.ts"];
    const checked: string[] = [];

    for (const module of modules) {
      const statements = preparedStatements(module);
      assert.ok(statements.length > 0, `${module}: no prepared statements found - has the query idiom changed?`);

      for (const sql of statements) {
        const isRead = /^SELECT/i.test(sql);
        const isMutation = /^(UPDATE|DELETE)/i.test(sql);
        if (!isRead && !isMutation) continue; // INSERTs supply organization_id as a value, not a predicate
        if (!TENANT_TABLES.some((table) => sql.includes(table))) continue;
        if (ALLOWED_UNSCOPED.some((allowed) => allowed.sql.test(sql))) continue;

        assert.ok(
          /organization_id = \?/.test(sql),
          `${module}: statement touches a tenant table without an organization_id predicate, and is not on the documented exception list:\n  ${sql}`,
        );
        checked.push(sql);
      }
    }

    // A guard that checked nothing would pass silently, which is the failure mode of every guard.
    assert.ok(checked.length >= 14, `expected the guard to have checked several statements, saw ${checked.length}`);
  });

  it("the store's insert supplies organization_id rather than deriving it later", () => {
    const inserts = preparedStatements("src/ingest/store.ts").filter((sql) => /^INSERT/i.test(sql));
    assert.equal(inserts.length, 1);
    assert.ok(inserts[0]!.includes("organization_id"), "an observation must carry its tenant from the moment it is written");
  });
});
