import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Restore exactly the commit required by the running Worker, without deploying local edits.
const base = 'https://diffci-research-sandbox.damp-waterfall-0cd8.workers.dev';
const headers = { Authorization: `Bearer ${readFileSync('.research/dispatch-token', 'utf8').trim()}` };
async function status() {
  const r = await fetch(`${base}/v1/shadow/cron-status`, { headers });
  if (!r.ok) throw new Error(`Status failed: ${r.status}`);
  return r.json();
}
const before = await status();
const sha = before.sourceIntegrity.expectedSha;
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Missing expected commit');
if (before.sourceIntegrity.status === 'CURRENT') { console.log('Already current'); process.exit(0); }
const resolved = execFileSync('git', ['rev-parse', `${sha}^{commit}`], { encoding: 'utf8' }).trim();
if (resolved !== sha) throw new Error('Commit mismatch');
const archive = execFileSync('git', ['archive', '--format=tar.gz', sha], { maxBuffer: 64 * 1024 * 1024 });
const form = new FormData();
form.set('source', new File([archive], 'diffci-source.tgz'));
form.set('sourceSha', sha);
form.set('archiveHash', createHash('sha256').update(archive).digest('hex'));
form.set('label', `Restore exact deployed commit ${sha.slice(0, 7)}`);
const response = await fetch(`${base}/v1/shadow/source`, { method: 'POST', headers, body: form });
if (!response.ok) throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
const after = await status();
writeFileSync('docs/growth/2026-09-10/archive-restoration.json', JSON.stringify({ checkedAt: new Date().toISOString(), before: before.sourceIntegrity, upload: await response.json(), after: after.sourceIntegrity }, null, 2));
console.log(JSON.stringify(after.sourceIntegrity, null, 2));
if (after.sourceIntegrity.status !== 'CURRENT') throw new Error('Restoration did not pass integrity verification');
