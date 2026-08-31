/**
 * The frozen identity of the QUALIFIED apparatus (generation C, 2026-08-31).
 *
 * An experiment job that declares `requiresApparatus` must run on exactly this apparatus. The check
 * exists because defect 18 made identity drift a live hazard rather than a theoretical one: `pack`
 * uploaded a stale agent and reported the previous generation's digest, so a run could have measured
 * generation B while every artefact claimed C. Pinning the expected digest per job was the first
 * guard; this is the second, and it fails the RUN rather than annotating the result.
 *
 * Evidence produced under generation B stays attributed to B. Nothing here re-labels it.
 */
export const GENERATION_C = {
  generation: "C",
  analyserCommit: "0beb661",
  qualificationEvidenceCommit: "5fcff30",
  sourceTarballSha256: "3ed8fc1e0800336dced4aca6902bbcf70646ab29b0f94ce35f2a6d22a29e67c8",
  agentIntegrity: "sha512-eQGRE3epHI3vAszgEL8qD0GzrAkcRbDyiiIhWyBa2f5soZMkceIXdXcvdqovj/YOd6G2Faa3htaf9NW0HEFHfw==",
  image: "docker.io/cloudflare/sandbox:0.12.5",
  node: "v22.23.2",
} as const;

/** Generation B, kept only so a run can be REFUSED for carrying it. Never a valid experiment apparatus. */
export const GENERATION_B_AGENT_INTEGRITY =
  "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==";

export interface ObservedApparatus {
  agentIntegrity?: string;
  image?: string;
  node?: string;
}

/**
 * Returns the reasons this apparatus is NOT the qualified one. Empty means it is.
 *
 * Every mismatch is reported rather than the first, so one run tells the operator everything that
 * drifted instead of one thing at a time.
 */
export function apparatusMismatches(observed: ObservedApparatus): string[] {
  const problems: string[] = [];
  if (observed.agentIntegrity === GENERATION_B_AGENT_INTEGRITY) {
    problems.push("agent is generation B, the SUPERSEDED analyser - this is the defect-18 failure mode");
  } else if (observed.agentIntegrity !== GENERATION_C.agentIntegrity) {
    problems.push(`agent integrity is ${observed.agentIntegrity ?? "absent"}, expected generation C ${GENERATION_C.agentIntegrity}`);
  }
  if (observed.image !== undefined && observed.image !== GENERATION_C.image) {
    problems.push(`image is ${observed.image}, expected ${GENERATION_C.image}`);
  }
  if (observed.node !== undefined && observed.node !== GENERATION_C.node) {
    problems.push(`node is ${observed.node}, expected ${GENERATION_C.node}`);
  }
  return problems;
}
