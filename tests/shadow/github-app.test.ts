import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { signAppJwt, verifyWebhookSignature, exchangeInstallationToken } from "../../src/shadow/github-app.js";

function generateTestKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKeyPkcs8Pem, publicKeyPem };
}

describe("signAppJwt", () => {
  it("produces a JWT whose signature verifies against the corresponding public key (real RSA round-trip, not a mock)", async () => {
    const { privateKeyPkcs8Pem, publicKeyPem } = generateTestKeyPair();
    const jwt = await signAppJwt({ appId: "123456", privateKeyPkcs8Pem, nowSeconds: 1_700_000_000 });

    const [headerB64, payloadB64, signatureB64] = jwt.split(".");
    assert.ok(headerB64 && payloadB64 && signatureB64, "JWT must have exactly 3 parts");

    const signingInput = `${headerB64}.${payloadB64}`;
    const signatureBuffer = Buffer.from(signatureB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    assert.ok(verifier.verify(publicKeyPem, signatureBuffer), "signature must verify against the real public key");
  });

  it("sets iat 60s in the past and exp exactly 9 minutes later, both within GitHub's 10-minute cap", async () => {
    const { privateKeyPkcs8Pem } = generateTestKeyPair();
    const now = 1_700_000_000;
    const jwt = await signAppJwt({ appId: "123456", privateKeyPkcs8Pem, nowSeconds: now });
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    assert.equal(payload.iat, now - 60);
    assert.equal(payload.exp, now + 9 * 60);
    assert.equal(payload.iss, "123456");
    assert.ok(payload.exp - payload.iat <= 600, "must never exceed GitHub's 10-minute cap");
  });
});

describe("exchangeInstallationToken", () => {
  it("posts to the correct App-installation endpoint with the JWT as bearer auth and returns the token", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ token: "ghs_fake", expires_at: "2026-08-21T11:00:00Z" }), { status: 201 });
    }) as typeof fetch;

    const result = await exchangeInstallationToken("fake.jwt.token", "9999", fakeFetch);
    assert.equal(capturedUrl, "https://api.github.com/app/installations/9999/access_tokens");
    assert.equal(capturedAuth, "Bearer fake.jwt.token");
    assert.equal(result.token, "ghs_fake");
    assert.equal(result.expiresAt, "2026-08-21T11:00:00Z");
  });

  it("throws with the response body captured, never swallowing a failed exchange", async () => {
    const fakeFetch = (async () => new Response("installation suspended", { status: 403 })) as typeof fetch;
    await assert.rejects(() => exchangeInstallationToken("jwt", "1", fakeFetch), /installation suspended/);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a signature computed correctly with the real secret", async () => {
    const secret = "test-webhook-secret";
    const body = JSON.stringify({ action: "opened", number: 42 });
    const { createHmac } = await import("node:crypto");
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    assert.equal(await verifyWebhookSignature(body, expected, secret), true);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const body = JSON.stringify({ action: "opened" });
    const { createHmac } = await import("node:crypto");
    const wrongSig = `sha256=${createHmac("sha256", "wrong-secret").update(body).digest("hex")}`;
    assert.equal(await verifyWebhookSignature(body, wrongSig, "test-webhook-secret"), false);
  });

  it("rejects a signature computed over a DIFFERENT body than the one supplied (tamper detection)", async () => {
    const secret = "test-webhook-secret";
    const { createHmac } = await import("node:crypto");
    const sigForOriginalBody = `sha256=${createHmac("sha256", secret).update(JSON.stringify({ action: "opened" })).digest("hex")}`;
    const tamperedBody = JSON.stringify({ action: "closed" });
    assert.equal(await verifyWebhookSignature(tamperedBody, sigForOriginalBody, secret), false);
  });

  it("rejects when the header is missing or malformed, never treating absence as valid", async () => {
    assert.equal(await verifyWebhookSignature("body", null, "secret"), false);
    assert.equal(await verifyWebhookSignature("body", "", "secret"), false);
    assert.equal(await verifyWebhookSignature("body", "not-a-real-signature", "secret"), false);
    assert.equal(await verifyWebhookSignature("body", "sha1=abcd", "secret"), false, "must reject the deprecated sha1 scheme");
  });
});
