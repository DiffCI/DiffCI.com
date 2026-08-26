/**
 * Derives missed-intermediate-commit counts from the observed head-transition log.
 *
 * RUN THIS AFTER THE 24-HOUR LOAD-GATE WINDOW, NEVER DURING IT. It issues GitHub compare calls, and
 * adding API traffic mid-window would change the very workload the predeclared gate is measuring.
 *
 * DiffCI's poller analyses the LATEST head it observes. When several commits land between two sweeps,
 * only the newest is analysed and the ones behind it are never individually predicted. That gap is real,
 * expected, and must be measured rather than assumed to be zero.
 *
 * It is derived from shadow_head_transitions, not from shadow_repositories.last_observed_head_sha, because
 * the latter is overwritten state: it says what the head is now and destroys what it used to be. If the
 * transition log does not actually contain a usable consecutive sequence for a repository, this script
 * reports UNAVAILABLE for it rather than inventing a number from data that cannot support one.
 *
 * Usage: npx tsx scripts/derive-missed-commits.ts [--since 2026-08-26T05:00:00Z] [--token-env GITHUB_TOKEN]
 */
import { execFileSync } from "node:child_process";

interface Transition {
  id: number;
  repository: string;
  from_sha: string | null;
  to_sha: string;
  detected_at: string;
  analysed: number;
}

function d1<T>(sql: string): T[] {
  const out = execFileSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "diffci-research", "--remote", "--config", "wrangler.research-sandbox.jsonc", "--command", sql, "--json"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return (JSON.parse(out.slice(out.indexOf("["))) as { results: T[] }[])[0]?.results ?? [];
}

async function compareCommits(repository: string, base: string, head: string, token?: string): Promise<number | undefined> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "diffci-shadow", "X-GitHub-Api-Version": "2026-03-10" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${repository}/compare/${base}...${head}`, { headers });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { ahead_by?: number };
  return typeof body.ahead_by === "number" ? body.ahead_by : undefined;
}

async function main() {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i]?.startsWith("--")) args[argv[i]!.slice(2)] = argv[++i] ?? "";
  const token = process.env[args["token-env"] ?? "GITHUB_TOKEN"];
  const since = args.since ?? "1970-01-01T00:00:00Z";

  const transitions = d1<Transition>(
    `SELECT id, repository, from_sha, to_sha, detected_at, analysed FROM shadow_head_transitions WHERE detected_at >= '${since.replace(/'/g, "''")}' ORDER BY repository, detected_at ASC`,
  );

  if (transitions.length === 0) {
    console.log("UNAVAILABLE - no head transitions recorded in this window.");
    console.log("The metric cannot be derived, and must be reported as unavailable rather than as zero.");
    return;
  }

  const byRepo = new Map<string, Transition[]>();
  for (const t of transitions) {
    const list = byRepo.get(t.repository) ?? [];
    list.push(t);
    byRepo.set(t.repository, list);
  }

  console.log(`Missed-intermediate-commit derivation, since ${since}`);
  console.log(token ? "(authenticated)" : "(UNAUTHENTICATED - 60 req/hour; expect UNAVAILABLE rows on rate limit)");

  for (const [repository, list] of byRepo) {
    let analysedTransitions = 0;
    let commitsSpanned = 0;
    let missed = 0;
    let unavailable = 0;

    for (const t of list) {
      // A transition with no from_sha is the first head ever seen - there is no prior point to compare
      // against, so it contributes no missed-commit information either way.
      if (!t.from_sha) continue;
      const ahead = await compareCommits(repository, t.from_sha, t.to_sha, token);
      if (ahead === undefined) {
        unavailable++;
        continue;
      }
      commitsSpanned += ahead;
      // The newest commit in the span is the one actually analysed (when the transition was not deferred);
      // everything behind it in the same span was never individually predicted.
      if (t.analysed) {
        analysedTransitions++;
        missed += Math.max(0, ahead - 1);
      } else {
        missed += ahead; // deferred by the ceiling: none of the span was analysed
      }
    }

    if (unavailable === list.filter((t) => t.from_sha).length && unavailable > 0) {
      console.log(`  ${repository}: UNAVAILABLE - every compare call failed (rate limit or missing history).`);
      continue;
    }
    console.log(
      `  ${repository}: transitions=${list.length} analysed=${analysedTransitions} commitsSpanned=${commitsSpanned} missedIntermediate=${missed}` +
        (unavailable > 0 ? ` (UNAVAILABLE for ${unavailable} transition(s))` : ""),
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
