import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// This workload is intentionally unavailable on the operator's desktop.
if (process.platform !== 'linux' || !process.env.DIFFCI_VALIDATION_IMAGE) throw new Error('Cloudflare validation container required');
const root = '/workspace/language-qualification';
mkdirSync(root, { recursive: true });
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), image: process.env.DIFFCI_VALIDATION_IMAGE, node: process.version, repositories: [], checks: [] };
const save = () => writeFileSync('/workspace/language-qualification.json', JSON.stringify(report, null, 2));
let serial = 0;
function run(cmd, args, cwd = root, required = true, timeout = 600000) {
  console.log(JSON.stringify({ event: 'command', cmd, args, cwd }));
  const start = performance.now();
  const r = spawnSync(cmd, args, { cwd, env: process.env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const result = { command: [cmd, ...args], exitCode: r.status, signal: r.signal, error: r.error?.message, mutationMarkerSeen: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.includes('DIFFCI_MUTATION'), elapsedMs: Math.round(performance.now() - start), tail: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-6000) };
  console.log(JSON.stringify({ event: 'completed', command: cmd, exitCode: r.status, elapsedMs: result.elapsedMs }));
  if (required && r.status !== 0) throw new Error(JSON.stringify(result));
  return result;
}
function measured(cmd, args, cwd) {
  const usage = `${root}/usage-${serial++}.txt`;
  const r = run('/usr/bin/time', ['-f', '%U %S %e %M', '-o', usage, cmd, ...args], cwd, false);
  try { const [userSeconds, systemSeconds, wallSeconds, peakRssKiB] = readFileSync(usage, 'utf8').trim().split('\n').at(-1).split(' ').map(Number); r.resources = { userSeconds, systemSeconds, wallSeconds, peakRssKiB }; } catch {}
  return r;
}
const specs = [
  { name: 'vue', remote: 'https://github.com/vuejs/test-utils.git', sha: '93321272b33fe931da71d636654b41f45058ed0c', file: 'tests/components/Hello.vue', from: "'Hello world'", to: "'DIFFCI_MUTATION'" },
  { name: 'go', remote: 'https://github.com/go-chi/chi.git', sha: 'b1c9ab47626cc46b34393ad4d35779c4363c4e1e', file: 'context.go', from: 'func NewRouteContext() *Context {', to: 'func NewRouteContext() *Context { panic("DIFFCI_MUTATION");' },
];
save();
try {
  run('apt-get', ['update']); run('apt-get', ['install', '-y', 'time']);
  const goArchive = `${root}/go.tgz`;
  run('curl', ['-fL', '--retry', '3', 'https://go.dev/dl/go1.27.1.linux-amd64.tar.gz', '-o', goArchive]);
  const goHash = createHash('sha256').update(readFileSync(goArchive)).digest('hex');
  if (goHash !== '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445') throw new Error('Go archive checksum mismatch');
  run('tar', ['-xzf', goArchive, '-C', root]);
  process.env.PATH = `${root}/go/bin:${process.env.PATH}`;
  Object.assign(process.env, { GOTOOLCHAIN: 'local', GOFLAGS: '', GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' });
  report.go = { checksum: goHash, version: run('go', ['version']).tail, env: run('go', ['env', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOFLAGS']).tail };
  report.checks.push(run('npm', ['run', 'typecheck'], '/opt/diffci', false));
  report.checks.push(run('npm', ['exec', '--', 'tsx', '--test', 'tests/validation-env/*.test.ts'], '/opt/diffci', false));
  if (report.checks.some(r => r.exitCode !== 0)) throw new Error('Remote validation source checks failed');
  const host = `${root}/observer`; mkdirSync(host);
  writeFileSync(`${host}/package.json`, JSON.stringify({ name: 'qualification-host', private: true }));
  run('npm', ['install', '--no-audit', '--no-fund', '/opt/diffci/dist-agent/agent.tgz'], host);
  report.agentIntegrity = 'sha512-' + createHash('sha512').update(readFileSync('/opt/diffci/dist-agent/agent.tgz')).digest('base64');
  for (const spec of specs) {
    const entry = { ...spec, phase: 'setup' }; report.repositories.push(entry); save();
    const cwd = `${root}/${spec.name}-repo`;
    try {
      run('git', ['clone', '--filter=blob:none', '--no-checkout', spec.remote, cwd]);
      run('git', ['checkout', '--detach', spec.sha], cwd);
      run('git', ['config', 'user.email', 'qualification@diffci.com'], cwd);
      run('git', ['config', 'user.name', 'DiffCI qualification'], cwd);
      if (spec.name === 'vue') run('corepack', ['pnpm', 'install', '--frozen-lockfile'], cwd);
      else run('go', ['mod', 'download'], cwd);
      const full = spec.name === 'vue' ? ['node', ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', '--minWorkers=2', '--sequence.seed=42']] : ['go', ['test', '-mod=readonly', '-json', '-count=1', './...']];
      entry.phase = 'baseline'; save();
      entry.baselines = [measured(...full, cwd), measured(...full, cwd)]; save();
      if (entry.baselines.some(r => r.exitCode !== 0)) throw new Error('Baseline failed; no qualification claim');
      const path = `${cwd}/${spec.file}`; const original = readFileSync(path, 'utf8');
      if (!original.includes(spec.from)) throw new Error('Preregistered mutation target missing');
      writeFileSync(path, original + '\n');
      run('git', ['add', spec.file], cwd); run('git', ['commit', '-m', 'Qualification change: whitespace only'], cwd);
      const head = run('git', ['rev-parse', 'HEAD'], cwd).tail.trim();
      const out = `${root}/${spec.name}-observation.json`;
      entry.phase = 'observe'; save();
      entry.observerExecution = measured('node', [`${host}/node_modules/@diffci/observer/index.mjs`, 'observe', '--repo', cwd, '--base', spec.sha, '--head', head, '--out', out, '--no-send'], cwd);
      entry.observation = JSON.parse(readFileSync(out, 'utf8')); save();
      if (entry.observation.nonInterference?.worktreeUnchanged !== true) throw new Error('Observer changed the worktree');
      if (!['OBSERVED', 'REFUSED'].includes(entry.observation.status)) throw new Error('Observer failed');
      if (entry.observation.status === 'REFUSED') {
        const { buildDependencyGraph } = await import('../src/repo/graph.ts');
        const diagnostic = await buildDependencyGraph({ repoPath: cwd });
        entry.refusalDiagnostic = { nodes: diagnostic.graph.nodes.length, adapterBlockers: diagnostic.adapterBlockers, adapters: diagnostic.profile.adapters };
      }
      // Refusal leaves the user's full suite intact. Preserve the refusal distinctly.
      const result = entry.observation.result ?? { mode: 'FULL', fallbackReasons: [entry.observation.reason] };
      let policy = full;
      if (result.mode === 'SELECTIVE') {
        if (result.commandRefusalReason || result.unroutedTestPaths?.length || !result.selectedTests.length) throw new Error('Subset execution unavailable');
        const paths = result.selectedTests;
        if (paths.some(p => p.startsWith('-') || p.includes('..') || p.startsWith('/'))) throw new Error('Invalid selected path');
        policy = spec.name === 'vue' ? ['node', [...full[1], ...paths]] : ['go', ['test', '-mod=readonly', '-json', '-count=1', ...new Set(paths.map(p => './' + (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')))]];
      }
      entry.policy = entry.observation.status === 'REFUSED' ? 'REFUSED_FULL_RUN' : result.mode; entry.phase = 'timings'; entry.pairs = []; save();
      for (let i = 0; i < 3; i++) {
        const pair = i % 2 === 0 ? { full: measured(...full, cwd), policy: measured(...policy, cwd) } : { policy: measured(...policy, cwd), full: measured(...full, cwd) };
        pair.netElapsedSavedMs = pair.full.elapsedMs - pair.policy.elapsedMs - entry.observerExecution.elapsedMs;
        entry.pairs.push(pair); save();
      }
      if (entry.pairs.some(p => p.full.exitCode !== 0 || p.policy.exitCode !== 0)) throw new Error('Timing baseline became unstable');
      entry.phase = 'fault'; save();
      writeFileSync(path, original.replace(spec.from, spec.to));
      try {
        entry.fault = { full: measured(...full, cwd), policy: measured(...policy, cwd) };
        const detects = r => r.exitCode !== null && r.exitCode !== 0 && !r.error && r.mutationMarkerSeen;
        entry.fault.fullDetected = detects(entry.fault.full); entry.fault.policyDetected = detects(entry.fault.policy);
      } finally { writeFileSync(path, original + '\n'); }
      entry.outcome = !entry.fault.fullDetected ? 'INCONCLUSIVE_FAULT' : !entry.fault.policyDetected ? 'UNSAFE' : result.mode === 'FULL' ? 'FULL_FALLBACK_NO_SELECTIVE_QUALIFICATION' : 'BOUNDED_SELECTIVE_CASE_PASSED';
      entry.phase = 'complete';
    } catch (e) { entry.error = String(e); entry.outcome = 'INCONCLUSIVE'; }
    save();
  }
} catch (e) { report.error = String(e); }
report.finishedAt = new Date().toISOString(); save();
console.log(JSON.stringify(report));
