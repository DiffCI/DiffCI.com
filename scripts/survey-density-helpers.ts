/**
 * Shared pieces of the density survey, kept separate so the exclusion list has ONE definition.
 *
 * The addressability survey already carries this list in `survey-adjudicate.ts`; duplicating it here
 * would be the same mistake as the duplicate glob matcher deleted from impact.ts on 2026-08-30, which
 * survived a consolidation and then drifted into two different behaviours. This module re-exports the
 * one definition rather than restating it.
 */
export { ALREADY_EXAMINED } from "./survey-adjudicate.js";
import { repositorySlugFrom } from "./survey-facts.js";

/** Resolve an npm package name to "owner/name" through the registry, or null. */
export async function repositorySlugFromFacts(packageName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      headers: { "user-agent": "diffci-density-survey" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      "dist-tags"?: { latest?: string };
      versions?: Record<string, { repository?: unknown }>;
      repository?: unknown;
    };
    const latest = body["dist-tags"]?.latest;
    const version = latest ? body.versions?.[latest] : undefined;
    const repo = version?.repository ?? body.repository;
    return repositorySlugFrom(typeof repo === "string" ? repo : (repo as { url?: string } | undefined)?.url);
  } catch {
    return null;
  }
}
