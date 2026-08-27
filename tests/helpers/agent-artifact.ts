/**
 * Test-only constructor for a PinnedAgentArtifact.
 *
 * Deliberately goes through the real parseAgentArtifact rather than casting: if a test needs an
 * artifact the production parser would reject, that is the test telling you the invariant is wrong,
 * not a reason to reach around it. Throws at the definition site rather than returning null, so a bad
 * fixture fails loudly instead of as a confusing assertion later.
 */
import { parseAgentArtifact, type PinnedAgentArtifact } from "../../src/ingest/agent-artifact.js";

export function pinnedArtifact(value: string): PinnedAgentArtifact {
  const parsed = parseAgentArtifact(value);
  if (!parsed.ok) throw new Error(`test fixture "${value}" is not a pinned agent artifact: ${parsed.rejection}`);
  return parsed.artifact;
}

/** A stable, obviously-fake integrity value of the right shape (64 bytes, base64). */
export const TEST_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

/** The default pinned npm agent for tests that do not care about the specific value. */
export const TEST_AGENT = `npm:@diffci/observer@1.4.2#${TEST_INTEGRITY}`;

export const TEST_PINNED_AGENT: PinnedAgentArtifact = pinnedArtifact(TEST_AGENT);
