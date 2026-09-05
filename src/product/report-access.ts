/**
 * Dashboard report links for the signed-in user (2026-09-05). The product Worker asks the research
 * Worker - over a Service Binding, authenticated with the research dispatch token - which enrolled
 * repositories GitHub says this user can access, and turns the answer into report links. A private
 * repository's link carries its report token; that token is shown nowhere else.
 *
 * Every failure is rendered as "unavailable, because …" rather than as an empty list: an empty list
 * would read as "you have no repositories", which is a claim this code cannot make when it could not ask.
 */
import { DEFAULT_REPORT_BASE_URL } from "./routes.js";

export interface ReportAccessSource {
  fetch(request: Request): Promise<Response>;
}

export interface UserReportLink {
  repository: string;
  isPrivate: boolean;
  state: string;
  /** Absent for a private repository whose token has not been generated yet. */
  url?: string;
}

export type UserReports =
  | { status: "ok"; login: string; links: UserReportLink[]; unknown: string[] }
  | { status: "unavailable"; reason: string };

export interface UserReportsDeps {
  researchWorker?: ReportAccessSource;
  dispatchToken?: string;
  reportBaseUrl?: string;
}

export function buildReportUrl(reportBaseUrl: string, repository: string, token?: string): string {
  const url = new URL(reportBaseUrl);
  url.searchParams.set("repository", repository);
  url.searchParams.set("days", "7");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export async function loadUserReports(deps: UserReportsDeps, login: string | null): Promise<UserReports> {
  if (!login) return { status: "unavailable", reason: "this account has no GitHub login on record - sign out and sign in with GitHub again" };
  if (!deps.researchWorker || !deps.dispatchToken) return { status: "unavailable", reason: "the report service is not connected in this environment" };
  const base = deps.reportBaseUrl ?? DEFAULT_REPORT_BASE_URL;
  let payload: { ok?: boolean; error?: string; repositories?: Array<{ repository: string; state: string; isPrivate: boolean; reportToken?: string }>; unknown?: string[] };
  try {
    const res = await deps.researchWorker.fetch(
      new Request(`https://diffci-research-sandbox.internal/v1/shadow/report-access?login=${encodeURIComponent(login)}`, {
        headers: { Authorization: `Bearer ${deps.dispatchToken}`, Accept: "application/json" },
      }),
    );
    payload = (await res.json()) as typeof payload;
    if (!res.ok || !payload.ok) return { status: "unavailable", reason: `the report service answered ${res.status}${payload.error ? `: ${payload.error}` : ""}` };
  } catch (error: unknown) {
    return { status: "unavailable", reason: `the report service could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  const links: UserReportLink[] = (payload.repositories ?? []).map((r) => ({
    repository: r.repository,
    isPrivate: r.isPrivate,
    state: r.state,
    url: r.isPrivate && !r.reportToken ? undefined : buildReportUrl(base, r.repository, r.isPrivate ? r.reportToken : undefined),
  }));
  return { status: "ok", login, links, unknown: payload.unknown ?? [] };
}
