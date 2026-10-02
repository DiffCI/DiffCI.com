import type { D1Binding } from "../product/store.js";

export class BodyLimitError extends Error {}

/** Enforces the byte cap while streaming, even without Content-Length. */
export async function readBoundedText(message: Request | Response, maxBytes: number): Promise<string> {
  if (Number(message.headers.get("Content-Length")) > maxBytes) {
    await message.body?.cancel();
    throw new BodyLimitError("Payload too large");
  }
  if (!message.body) return "";
  const reader = message.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new BodyLimitError("Payload too large");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

export async function hashOpaque(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function clientBucket(secret: string, ip: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${Math.floor(now / 86400000)}:${ip}`));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One atomic counter shared by Worker instances, with bounded lifetime. */
export async function takeRateLimit(db: D1Binding, key: string, limit: number, windowSeconds: number, now = Date.now()): Promise<boolean> {
  const window = Math.floor(now / (windowSeconds * 1000));
  const expires = (window + 1) * windowSeconds * 1000;
  const row = await db.prepare(`INSERT INTO hosted_request_limits (bucket, window, count, expires_at)
    VALUES (?, ?, 1, ?) ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1
    WHERE count < ? RETURNING count`).bind(key, window, expires, limit).first<{ count: number }>();
  return !!row;
}
