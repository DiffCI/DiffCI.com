/**
 * Resource ownership tags (Part 24) - every real cloud resource DiffCI provisions must carry these so
 * orphan cleanup and cost attribution can trace a resource back to its owner. Deliberately built from
 * INTERNAL ids only (organizationId is a UUID, never the organization's display name; repositoryId is
 * DiffCI's own internal id, never "owner/name") - Part 24: "Do not put customer repository names into
 * public/provider tags unnecessarily."
 */
export interface ResourceTags {
  project: "diffci";
  environment: string;
  runnerId: string;
  organizationId: string; // internal UUID, privacy-safe - never a customer-visible org name/slug
  repositoryId?: string; // internal UUID, never "owner/name"
  jobId?: string;
  createdAt: string;
}

export function buildRunnerResourceTags(input: { environment: string; runnerId: string; organizationId: string; repositoryId?: string; jobId?: string; createdAt?: string }): ResourceTags {
  return {
    project: "diffci",
    environment: input.environment,
    runnerId: input.runnerId,
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    jobId: input.jobId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
