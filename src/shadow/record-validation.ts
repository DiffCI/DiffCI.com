import type { ExecutionPlan } from "../planner/types.js";
import type { ShadowRunIdentity, ShadowRunRecord } from "./types.js";

const SENSITIVE_PATTERNS = ["ghs_", "ghp_", "github_pat_", "Authorization", "Bearer ", "PRIVATE KEY", "AWS_SECRET_ACCESS_KEY"];

export interface ShadowRecordValidation {
  valid: boolean;
  errors: string[];
}

function expectedLogicalKey(identity: ShadowRunIdentity): string {
  return `${identity.baseSha}:${identity.headSha}:${identity.schemaVersion}:${identity.diffciVersion}`;
}

function planModeConsistent(plan: ExecutionPlan): boolean {
  if (!plan || typeof plan.mode !== "string") return false;
  const fallbackRequired = plan.safety?.fallbackRequired === true;
  if (fallbackRequired && plan.mode !== "FULL") return false;
  if (!fallbackRequired && plan.mode !== "SELECTIVE") return false;
  return true;
}

function containsSensitiveValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return SENSITIVE_PATTERNS.some((pattern) => value.includes(pattern));
}

function scanForSecrets(obj: unknown, path = ""): string[] {
  const findings: string[] = [];
  if (obj === null || obj === undefined) return findings;
  if (typeof obj === "string") {
    if (containsSensitiveValue(obj)) {
      findings.push(`${path || "record"} may contain sensitive value`);
    }
    return findings;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      findings.push(...scanForSecrets(obj[i], `${path}[${i}]`));
    }
    return findings;
  }
  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      findings.push(...scanForSecrets(value, path ? `${path}.${key}` : key));
    }
  }
  return findings;
}

export function validateShadowRunRecord(record: ShadowRunRecord): ShadowRecordValidation {
  const errors: string[] = [];

  if (!record?.schemaVersion || typeof record.schemaVersion !== "string") {
    errors.push("missing or invalid schemaVersion");
  }

  if (!record?.commit?.baseSha || !record?.commit?.headSha) {
    errors.push("missing commit baseSha or headSha");
  }

  if (record?.runIdentity) {
    const identity = record.runIdentity;
    if (identity.logicalKey !== expectedLogicalKey(identity)) {
      errors.push(`logicalKey inconsistent: ${identity.logicalKey} !== ${expectedLogicalKey(identity)}`);
    }
    if (identity.baseSha !== record.commit.baseSha || identity.headSha !== record.commit.headSha) {
      errors.push("identity commit range differs from record commit");
    }
  }

  if (!record?.plan || !Array.isArray(record.plan.tasks)) {
    errors.push("missing or invalid plan");
  } else if (!planModeConsistent(record.plan)) {
    errors.push("plan mode is inconsistent with fallback state");
  }

  if (record?.timing) {
    const numericTimings = [
      "gitAnalysisMs",
      "graphConstructionMs",
      "impactAnalysisMs",
      "plannerMs",
      "totalDiffCiOverheadMs",
    ] as const;
    for (const key of numericTimings) {
      const value = record.timing[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        errors.push(`timing.${key} is missing or negative`);
      }
    }
  } else {
    errors.push("missing timing");
  }

  if (record?.cacheMetrics) {
    if (typeof record.cacheMetrics.cacheHit !== "boolean") {
      errors.push("cacheMetrics.cacheHit must be boolean");
    }
    if (!record.cacheMetrics.cacheKey) {
      errors.push("cacheMetrics.cacheKey is missing");
    }
  }

  if (typeof record?.impactFallback !== "boolean") {
    errors.push("missing or invalid impactFallback");
  }

  if (!Array.isArray(record?.fallbackReasons)) {
    errors.push("fallbackReasons must be an array");
  }

  const percents = [
    record?.measured?.netPotentialReductionPercent,
  ].filter((v): v is number => typeof v === "number");
  for (const p of percents) {
    if (p < 0 || p > 100) {
      errors.push(`percentage ${p} is outside [0, 100]`);
    }
  }

  if (!Array.isArray(record?.changedFiles)) {
    errors.push("changedFiles must be an array");
  }

  errors.push(...scanForSecrets(record));

  return { valid: errors.length === 0, errors };
}
