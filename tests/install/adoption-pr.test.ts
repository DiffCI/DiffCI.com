import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createAdoptionPullRequest, createWorkflowOnlyAdoptionPullRequest, workflowOnlyChange } from "../../src/install/adoption-pr.js";

describe("DiffCI Adoption App pull requests", () => {
  it("builds the zero-compute workflow with an exact DiffCI version", () => {
    const change = workflowOnlyChange("0.2.5");
    assert.equal(change.path, ".github/workflows/diffci.yml");
    assert.match(change.content, /npx "@diffci\.com\/diffci@0\.2\.5" observe --no-send/);
    assert.match(change.content, /continue-on-error: true/);
    assert.throws(() => workflowOnlyChange("latest"), /invalid DiffCI version/);
  });

  it("publishes all generated files in one commit and opens a draft PR", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; authorization?: string }> = [];
    let blob = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body, authorization: (init?.headers as Record<string, string>)?.Authorization });
      if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "base-commit" } });
      if (url.endsWith("/git/commits/base-commit")) return Response.json({ tree: { sha: "base-tree" } });
      if (url.endsWith("/git/blobs")) return Response.json({ sha: `blob-${++blob}` });
      if (url.endsWith("/git/trees")) return Response.json({ sha: "new-tree" });
      if (url.endsWith("/git/commits")) return Response.json({ sha: "new-commit" });
      if (url.endsWith("/git/refs")) return Response.json({ ref: "refs/heads/codex/add-diffci" });
      if (url.endsWith("/pulls")) return Response.json({ number: 42, html_url: "https://github.com/acme/app/pull/42" });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await createAdoptionPullRequest({
      installationToken: "secret-token",
      repository: "acme/app",
      baseBranch: "main",
      branch: "codex/add-diffci",
      title: "Add DiffCI observation",
      body: "Keeps existing required CI unchanged.",
      commitMessage: "ci: add DiffCI observation",
      changes: [
        { path: "package.json", content: "{}\n" },
        { path: "package-lock.json", content: "{}\n" },
        { path: ".github/workflows/diffci.yml", content: "name: DiffCI\n" },
      ],
    }, fetchFn);

    assert.deepEqual(result, { number: 42, url: "https://github.com/acme/app/pull/42", branch: "codex/add-diffci", commitSha: "new-commit" });
    assert.equal(calls.filter((call) => call.url.endsWith("/git/blobs")).length, 3);
    assert.deepEqual((calls.find((call) => call.url.endsWith("/git/trees"))!.body as { tree: Array<{ path: string }> }).tree.map((entry) => entry.path), [
      "package.json", "package-lock.json", ".github/workflows/diffci.yml",
    ]);
    assert.deepEqual(calls.find((call) => call.url.endsWith("/git/commits") && call.method === "POST")!.body, {
      message: "ci: add DiffCI observation", tree: "new-tree", parents: ["base-commit"],
    });
    assert.deepEqual(calls.find((call) => call.url.endsWith("/pulls"))!.body, {
      title: "Add DiffCI observation", body: "Keeps existing required CI unchanged.", head: "codex/add-diffci", base: "main", draft: true,
    });
    assert.ok(calls.every((call) => call.authorization === "Bearer secret-token"));
  });

  it("refuses unsafe paths and branches before contacting GitHub", async () => {
    let called = false;
    const fetchFn = (async () => { called = true; return Response.json({}); }) as typeof fetch;
    const base = {
      installationToken: "token", repository: "acme/app", baseBranch: "main", branch: "codex/add-diffci",
      title: "Add DiffCI", body: "", commitMessage: "add DiffCI", changes: [{ path: "package.json", content: "{}" }],
    };
    await assert.rejects(() => createAdoptionPullRequest({ ...base, changes: [{ path: "../secret", content: "x" }] }, fetchFn), /unsafe repository path/);
    await assert.rejects(() => createAdoptionPullRequest({ ...base, branch: "bad branch" }, fetchFn), /unsafe branch/);
    assert.equal(called, false);
  });

  it("stops before creating a branch when blob or tree creation fails", async () => {
    const methods: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "base" } });
      if (url.endsWith("/git/commits/base")) return Response.json({ tree: { sha: "tree" } });
      return Response.json({ message: "permission denied" }, { status: 403 });
    }) as typeof fetch;
    await assert.rejects(() => createAdoptionPullRequest({
      installationToken: "token", repository: "acme/app", baseBranch: "main", branch: "codex/add-diffci",
      title: "Add DiffCI", body: "", commitMessage: "add DiffCI", changes: [{ path: "package.json", content: "{}" }],
    }, fetchFn), /403.*permission denied/);
    assert.equal(methods.some((call) => call.endsWith("/git/refs")), false);
    assert.equal(methods.some((call) => call.endsWith("/pulls")), false);
  });

  it("opens a workflow-only draft PR without invoking a generation worker", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/contents/.github/workflows/diffci.yml")) return Response.json({ message: "Not Found" }, { status: 404 });
      if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "base" } });
      if (url.endsWith("/git/commits/base")) return Response.json({ tree: { sha: "tree" } });
      if (url.endsWith("/git/blobs")) return Response.json({ sha: "blob" });
      if (url.endsWith("/git/trees")) return Response.json({ sha: "new-tree" });
      if (url.endsWith("/git/commits")) return Response.json({ sha: "commit" });
      if (url.endsWith("/git/refs")) return Response.json({ ref: "refs/heads/codex/add-diffci" });
      if (url.endsWith("/pulls")) return Response.json({ number: 7, html_url: "https://github.com/acme/app/pull/7" });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const result = await createWorkflowOnlyAdoptionPullRequest({
      installationToken: "token", repository: "acme/app", baseBranch: "main", branch: "codex/add-diffci", diffciVersion: "0.2.5",
    }, fetchFn);
    assert.equal(result.number, 7);
    assert.equal(calls.filter((call) => call.url.endsWith("/git/blobs")).length, 1);
    assert.equal(calls.some((call) => call.url.includes("sandbox") || call.url.includes("generation")), false);
  });

  it("refuses to overwrite an existing workflow before creating Git objects", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json({ name: "diffci.yml" });
    }) as typeof fetch;
    await assert.rejects(() => createWorkflowOnlyAdoptionPullRequest({
      installationToken: "token", repository: "acme/app", baseBranch: "main", branch: "codex/add-diffci", diffciVersion: "0.2.5",
    }, fetchFn), /refusing to overwrite/);
    assert.equal(calls.length, 1);
  });
});
