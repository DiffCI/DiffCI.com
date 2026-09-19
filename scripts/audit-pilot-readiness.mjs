import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

// Read-only public checks. Never enrolls repositories or sends outreach.
const directory = 'docs/growth/2026-09-10';
mkdirSync(directory, { recursive: true });
const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
const repositories = ['statelyai/xstate', 'inngest/inngest-js', 'triggerdotdev/trigger.dev', 'resend/react-email', 'novuhq/novu', 'formbricks/formbricks', 'heyform/heyform', 'twentyhq/twenty', 'activepieces/activepieces', 'documenso/documenso'];
const pages = await Promise.all([
  'http://diffci.com/', 'https://diffci.com/', 'https://www.diffci.com/',
  'https://diffci.com/welcome', 'https://diffci.com/contact', 'https://diffci.com/data-handling',
  'https://github.com/apps/diffci-shadow',
  'https://app.diffci.com/report?repository=adityankale190895%2FDiffCI.com&days=7',
  'https://app.diffci.com/report?repository=adityankale190895%2FDentalPresence.in&days=7',
].map(async url => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const body = await r.text();
    const filename = `page-${new URL(url).hostname}-${new URL(url).pathname.replaceAll('/', '_')}-${pagesIndex(url)}.txt`;
    writeFileSync(`${directory}/${filename}`, body);
    return { url, finalUrl: r.url, status: r.status, evidenceFile: filename };
  } catch (e) { return { url, error: e.message }; }
}));
function pagesIndex(url) { return url.includes('DentalPresence') ? 'dental' : url.includes('DiffCI.com&') ? 'own' : url.startsWith('http:') ? 'http' : 'https'; }
const prospects = [];
for (const repository of repositories) {
  try {
    const meta = gh(`repos/${repository}`);
    const tree = gh(`repos/${repository}/git/trees/${meta.default_branch}?recursive=1`);
    const runs = gh(`repos/${repository}/actions/runs?per_page=10`).workflow_runs ?? [];
    const configs = (tree.tree ?? []).filter(f => f.path === 'tsconfig.json' || f.path.endsWith('/tsconfig.json')).map(f => f.path);
    const workflows = (tree.tree ?? []).filter(f => /^\.github\/workflows\/.*\.ya?ml$/.test(f.path)).map(f => f.path);
    const tests = runs.filter(r => /test|ci|check/i.test(r.name));
    prospects.push({ repository, url: meta.html_url, archived: meta.archived, pushedAt: meta.pushed_at, defaultBranch: meta.default_branch,
      tsconfigKind: configs.includes('tsconfig.json') ? 'root' : configs.length ? 'nested' : 'unknown', tsconfigs: configs.length, treeTruncated: !!tree.truncated, workflows,
      recentRuns: runs.map(r => ({name:r.name, url:r.html_url, createdAt:r.created_at, status:r.status, conclusion:r.conclusion})),
      screen: !meta.archived && configs.length && tests.length ? 'STRUCTURAL_MATCH; runtime and test-stage cost unverified' : 'REVIEW_REQUIRED',
      outreachStatus: 'NOT_SENT', contactStatus: 'NEEDS_VERIFIED_CONTACT' });
    console.log(`${repository}: ${prospects.at(-1).screen}`);
  } catch (e) { prospects.push({repository, error:e.message.split('\n')[0]}); }
}
writeFileSync(`${directory}/readiness.json`, JSON.stringify({checkedAt:new Date().toISOString(), pages, prospects}, null, 2));
console.log(JSON.stringify(pages, null, 2));
