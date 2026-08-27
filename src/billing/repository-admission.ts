/**
 * Whether a repository may be connected, and why (2026-08-27).
 *
 * WHAT THIS REPLACES. There were two ways to connect a repository, and they disagreed:
 *
 *   - `POST /v1/organizations/:id/repositories` checked `entitlements.maxRepositories` and returned 402
 *     when the free plan's limit of one was reached.
 *   - `connectInstallation()`, the GitHub App path, called `createRepository` directly and checked
 *     nothing at all.
 *
 * So the plan limit was enforced on the path almost nobody uses and ignored on the path onboarding
 * actually runs through. Early-access onboarding therefore worked - by accident, via an inconsistency,
 * with no test asserting it and nothing stopping someone "fixing" the gap and silently breaking signup
 * on a Tuesday.
 *
 * THIS DOES NOT REDESIGN BILLING. The 15% savings-share model, the plans, and the entitlement values
 * are all untouched. What changes is that the decision is now made in one place, by name, with the
 * reason attached - so "early access does not require payment setup" is a policy the code states rather
 * than an outcome the code happens to produce.
 *
 * WHY THE INSTALLATION PATH IS THE EXEMPT ONE. It is the path where GitHub has already proved the
 * caller controls the repository: the installation exists because someone with admin rights on that
 * repository granted it. The typed path proves nothing of the kind - it takes a numeric id from a
 * request body. Exempting the proven path and holding the unproven one to the plan limit is therefore
 * not a weakening; the unproven path is the one where an unlimited allowance would be worth abusing.
 */
import type { Entitlements } from "./types.js";

export type AdmissionSource =
  /** GitHub told us this installation covers this repository. Ownership is proven by the provider. */
  | "installation"
  /** A repository id supplied in a request body. Nothing outside DiffCI vouches for it. */
  | "manual";

export type AdmissionDecision =
  | { admit: true; reason: "within_plan_limit" | "early_access_installation" }
  | { admit: false; reason: "plan_limit_reached"; maxRepositories: number };

export interface AdmissionInput {
  entitlements: Pick<Entitlements, "maxRepositories">;
  currentRepositoryCount: number;
  source: AdmissionSource;
  /**
   * Whether this deployment is running the early-access programme. True today. When it becomes false,
   * installation-sourced connections start obeying the same plan limit as everything else, and the only
   * change required is this flag - not a rewrite of either call site.
   */
  earlyAccess: boolean;
}

/**
 * Early access is a property of the deployment, not of a customer record: there is no per-organization
 * "early access" flag to set, forget, or leak. Flipping this to false is the whole of ending the
 * programme, and `plan_limit_reached` then applies uniformly.
 */
export const EARLY_ACCESS_ENABLED = true;

export function decideRepositoryAdmission(input: AdmissionInput): AdmissionDecision {
  const { maxRepositories } = input.entitlements;

  // A negative limit is the codebase's existing convention for "unlimited" (see billing/plans.ts).
  if (maxRepositories < 0) return { admit: true, reason: "within_plan_limit" };
  if (input.currentRepositoryCount < maxRepositories) return { admit: true, reason: "within_plan_limit" };

  if (input.earlyAccess && input.source === "installation") {
    return { admit: true, reason: "early_access_installation" };
  }

  return { admit: false, reason: "plan_limit_reached", maxRepositories };
}
