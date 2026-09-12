import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

if (process.platform !== 'linux' || !process.env.DIFFCI_VALIDATION_IMAGE) throw new Error('Cloudflare validation container required');
const cohort = JSON.parse(readFileSync(new URL('./language-benchmark-cohort.json', import.meta.url), 'utf8'));
const experiment = JSON.parse(readFileSync(new URL('./language-benchmark-experiment.json', import.meta.url), 'utf8'));
const spec = cohort.repositories.find(s => s.id === process.argv[2]);
if (!spec) throw new Error('Unknown fixed cohort repository');
const root = '/workspace/broad-benchmark';
const checkout = join(root, 'repo');
mkdirSync(root, { recursive: true });
const expected = 'sha512-FiVDAHdmzEZKE1Gh0EzfyTv0LNxfzy6JsrcEGR52G41ErixoS7DOha9qr1m+D1fRwVk6o3j+UbXcRk+jupuQUg==';
const report = { schemaVersion: 2, cohortVersion: cohort.version, spec, startedAt: new Date().toISOString(), image: process.env.DIFFCI_VALIDATION_IMAGE, node: process.version, scope: spec.language === 'go' ? 'root module go test ./...' : `Vitest unit suite in ${spec.cwd}; excludes browser/type/build CI`, cases: [], checks: [] };
const save = () => writeFileSync('/workspace/language-qualification.json', JSON.stringify(report, null, 2));
report.experiment = experiment;
const announce = (event, detail) => { console.log(JSON.stringify({ event, repository: spec.id, ...detail })); save(); };
let sequence = 0;
const deadline = Date.now() + 40 * 60_000;
function run(cmd, args, cwd = root, required = true, timeout = 300000) {
  if (Date.now() > deadline) throw new Error('Repository budget exhausted');
  const start = performance.now();
  const result = spawnSync(cmd, args, { cwd, env: process.env, encoding: 'utf8', timeout: Math.min(timeout, Math.max(1000, deadline - Date.now())), maxBuffer: 48 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const record = { command: [cmd, ...args], cwd, exitCode: result.status, signal: result.signal, error: result.error?.message, elapsedMs: Math.round(performance.now() - start), mutationMarkerSeen: output.includes('DIFFCI_BENCHMARK_FAULT'), outputSha256: createHash('sha256').update(output).digest('hex'), tail: output.slice(-4000) };
  if (result.status !== 0) {
    const lines = output.split('\n');
    record.failureDetails = lines.flatMap((line, i) => /^\s*not ok\b/.test(line) ? lines.slice(Math.max(0, i - 1), i + 45) : []).join('\n').slice(0, 40000);
  }
  if (required && (result.status !== 0 || result.error)) throw new Error(JSON.stringify(record));
  return { record, stdout: result.stdout ?? '', output };
}
function git(args) { return run('git', args, checkout).stdout.trim(); }
function safePath(path) { return typeof path === 'string' && !path.startsWith('-') && !path.startsWith('/') && !path.split('/').includes('..') && !/[\r\n\\]/.test(path); }
function summaries(result, jsonPath) {
  if (spec.language === 'vue') {
    try {
      const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
      const files = (data.testResults ?? []).map(t => relative(checkout, t.name).replaceAll('\\', '/')).sort();
      const failures = (data.testResults ?? []).flatMap(t => (t.assertionResults ?? []).filter(a => a.status === 'failed').map(a => `${relative(checkout, t.name)}::${a.fullName ?? a.title}`));
      return { readable: Array.isArray(data.testResults) && data.testResults.length > 0, files, passed: data.numPassedTests, failed: data.numFailedTests, failedSuites: data.numFailedTestSuites, failures, total: data.numTotalTests };
    } catch { return { readable: false, files: [], failures: [] }; }
  }
  const packages = new Map(); const tests = new Set(); const failures = new Set(); let malformed = false;
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (!e.Test && e.Package && ['start', 'pass', 'fail', 'skip'].includes(e.Action)) packages.set(e.Package, e.Action);
      if (e.Test && e.Action === 'run') tests.add(`${e.Package}/${e.Test}`);
      if (e.Test && e.Action === 'fail') failures.add(`${e.Package}/${e.Test}`);
    } catch { malformed = true; }
  }
  return { readable: !malformed && packages.size > 0 && [...packages.values()].every(v => v !== 'start'), packages: Object.fromEntries(packages), total: tests.size, failures: [...failures], failed: failures.size, files: [] };
}
function execute(selected) {
  if (Array.isArray(selected) && selected.length === 0) return { exitCode: 0, elapsedMs: 0, noTestsSelected: true, summary: { readable: true, files: [], failures: [], total: 0 } };
  const id = sequence++;
  const usage = join(root, `usage-${id}.txt`); const json = join(root, `tests-${id}.json`);
  const cwd = checkout;
  const cmd = spec.language === 'go' ? 'go' : 'corepack';
  let args;
  if (spec.language === 'go') {
    const targets = selected ? [...new Set(selected.map(p => p.includes('/') ? './' + p.slice(0, p.lastIndexOf('/')) : '.'))].sort() : ['./...'];
    args = ['test', '-mod=readonly', '-json', '-count=1', ...targets];
  } else {
    args = ['pnpm', '--dir', spec.cwd, 'exec', 'vitest', 'run', '--config', 'vitest.config.ts', '--maxWorkers=2', '--minWorkers=2', '--sequence.seed=42', '--reporter=json', `--outputFile=${json}`, ...(selected ?? []).map(p => relative(resolve(checkout, spec.cwd), resolve(checkout, p)))];
  }
  const result = run('/usr/bin/time', ['-f', '%U %S %e %M', '-o', usage, cmd, ...args], cwd, false, 180000);
  const record = result.record;
  record.summary = summaries(result, json);
  try {
    const [userSeconds, systemSeconds, wallSeconds, peakRssKiB] = readFileSync(usage, 'utf8').trim().split('\n').at(-1).split(' ').map(Number);
    record.resources = { userSeconds, systemSeconds, wallSeconds, peakRssKiB };
  } catch {}
  return record;
}
function green(r) { return r.exitCode === 0 && !r.error && r.summary.readable; }
function mutation(path) {
  const text = readFileSync(join(checkout, path), 'utf8');
  if (spec.language === 'go') {
    const offset = Number(run(join(root, 'go-function-offset'), [join(checkout, path)]).stdout.trim());
    if (!Number.isInteger(offset) || offset < 1) return undefined;
    const bytes = Buffer.from(text); return { original: text, changed: Buffer.concat([bytes.subarray(0, offset), Buffer.from('\npanic("DIFFCI_BENCHMARK_FAULT")\n'), bytes.subarray(offset)]), kind: 'first-function-body-panic' };
  }
  if (path.endsWith('.vue')) {
    const script = /<script\b[^>]*>/.exec(text);
    if (!script || /\bsrc\s*=/.test(script[0])) return undefined;
    const offset = script.index + script[0].length;
    return { original: text, changed: text.slice(0, offset) + '\nthrow new Error("DIFFCI_BENCHMARK_FAULT");\n' + text.slice(offset), kind: script[0].includes('setup') ? 'component-setup-throw' : 'component-module-throw' };
  }
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let offset;
  function visit(node) {
    if (offset !== undefined) return;
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && node.body && ts.isBlock(node.body)) offset = node.body.getStart(file) + 1;
    else ts.forEachChild(node, visit);
  }
  visit(file);
  if (offset === undefined) return undefined;
  return { original: text, changed: text.slice(0, offset) + '\nthrow new Error("DIFFCI_BENCHMARK_FAULT");\n' + text.slice(offset), kind: 'first-function-body-throw' };
}
save();
try {
  run('apt-get', ['update']); run('apt-get', ['install', '-y', 'time']);
  if (spec.language === 'go') {
    run('curl', ['-fL', '--retry', '3', 'https://go.dev/dl/go1.27.1.linux-amd64.tar.gz', '-o', join(root, 'go.tgz')]);
    const hash = createHash('sha256').update(readFileSync(join(root, 'go.tgz'))).digest('hex');
    if (hash !== '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445') throw new Error('Go checksum mismatch');
    run('tar', ['-xzf', join(root, 'go.tgz'), '-C', root]);
    process.env.PATH = `${root}/go/bin:${process.env.PATH}`;
    Object.assign(process.env, { GOTOOLCHAIN: 'local', GOFLAGS: '', GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0', GOWORK: 'off' });
    report.go = { checksum: hash, version: run('go', ['version']).stdout.trim(), env: run('go', ['env', '-json', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOFLAGS']).stdout };
    writeFileSync(join(root, 'offset.go'), 'package main\nimport("go/parser";"go/token";"go/ast";"fmt";"os")\nfunc main(){fset:=token.NewFileSet(); f,e:=parser.ParseFile(fset,os.Args[1],nil,0);if e!=nil{panic(e)};for _,d:=range f.Decls{if fn,ok:=d.(*ast.FuncDecl);ok&&fn.Body!=nil&&fn.Name.Name!="init"{fmt.Println(fset.Position(fn.Body.Lbrace).Offset+1);return}};fmt.Println(-1)}\n');
    run('go', ['build', '-o', join(root, 'go-function-offset'), join(root, 'offset.go')]);
  }
  report.bootstrapAgentIntegrity = 'sha512-' + createHash('sha512').update(readFileSync('/opt/diffci/dist-agent/agent.tgz')).digest('base64');
  if (report.bootstrapAgentIntegrity !== expected) throw new Error('Unexpected bootstrap agent');
  report.candidateVersion = experiment.candidateVersion;
  report.checks.push(run('npm', ['run', 'typecheck'], '/opt/diffci', false).record);
  report.checks.push(run('npm', ['exec', '--', 'tsx', '--test', 'tests/repo/language-adapters.test.ts', 'tests/repo/vue-scope.test.ts'], '/opt/diffci', false).record);
  if (spec.id === 'vue-test-utils') {
    // Record the environment of the suite's existing live GitHub assertion without
    // weakening it or treating an HTTP failure as a passed regression check.
    try {
      const response = await fetch('https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'diffci-r2-verification' } });
      const data = await response.json();
      report.githubProofEnvironment = { status: response.status, remaining: response.headers.get('x-ratelimit-remaining'), reset: response.headers.get('x-ratelimit-reset'), sha: data.sha, message: data.message };
    } catch (error) { report.githubProofEnvironment = { error: String(error) }; }
    report.checks.push(run('npm', ['test'], '/opt/diffci', false, 600000).record);
  }
  if (report.checks.some(r => r.exitCode !== 0)) throw new Error('Candidate checks failed');
  report.candidateBuild = run('npm', ['exec', '--', 'tsx', 'scripts/build-agent.ts', `--version=${report.candidateVersion}`], '/opt/diffci').record;
  // Standard CI users cannot bypass chmod-based permission tests (Cobra exposed this).
  run('useradd', ['--create-home', '--home-dir', join(root, 'home'), 'diffci-benchmark']);
  const uid = Number(run('id', ['-u', 'diffci-benchmark']).stdout.trim());
  const gid = Number(run('id', ['-g', 'diffci-benchmark']).stdout.trim());
  run('chown', ['-R', `${uid}:${gid}`, root]);
  run('chown', [`${uid}:${gid}`, '/workspace/language-qualification.json']);
  Object.assign(process.env, { HOME: join(root, 'home'), GOPATH: join(root, 'gopath'), GOCACHE: join(root, 'gocache'), COREPACK_HOME: join(root, 'corepack'), npm_config_cache: join(root, 'npm-cache'), TMPDIR: root });
  process.setgroups([]); process.setgid(gid); process.setuid(uid);
  report.identity = { uid: process.getuid(), gid: process.getgid(), root: false };
  // The report lives outside the target checkout, in our writable benchmark directory.
  // /workspace is owned by bootstrap's root user, so establish this file before dropping privileges.
  if (spec.id === 'vue-test-utils') {
    report.checks.push(run('npm', ['run', 'typecheck'], '/opt/diffci', false).record);
    report.checks.push(run('npm', ['exec', '--', 'tsx', '--test', 'tests/validation-env/*.test.ts'], '/opt/diffci', false).record);
    if (report.checks.some(r => r.exitCode !== 0)) throw new Error('Benchmark control-plane checks failed');
  }
  const agent = `/opt/diffci/dist-agent/diffci-observer-${report.candidateVersion}.tgz`;
  report.agentIntegrity = 'sha512-' + createHash('sha512').update(readFileSync(agent)).digest('base64');
  const host = join(root, 'observer'); mkdirSync(host); writeFileSync(join(host, 'package.json'), '{"private":true}');
  run('npm', ['install', '--no-audit', '--no-fund', agent], host);
  run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${spec.repository}.git`, checkout]);
  git(['checkout', '--detach', spec.sha]);
  const history = git(['rev-list', '--first-parent', `--max-count=${cohort.historyLimit}`, spec.sha]).split('\n');
  const pattern = new RegExp(spec.sourcePattern);
  const candidates = [];
  for (const head of history) {
    const parents = git(['rev-list', '--parents', '-n', '1', head]).split(' ');
    if (parents.length < 2) continue;
    const base = parents[1];
    const files = git(['diff', '--name-only', base, head]).split('\n').filter(Boolean).sort();
    const sources = files.filter(p => pattern.test(p) && !/(?:^|\/)(?:__tests__|__test__|docs|testdata|_examples|examples|playground)\//.test(p) && !/(?:_test\.go|\.(?:test|spec)\.ts|\.d\.ts|\.story\.vue)$/.test(p));
    if (!sources.length) continue;
    candidates.push({ head, base, subject: git(['show', '-s', '--format=%s', head]), files, sourceFiles: sources });
    if (candidates.length === cohort.commitsPerRepository) break;
  }
  report.frozenCandidates = candidates;
  report.historyExaminedLimit = cohort.historyLimit;
  announce('cohort-frozen', { commits: candidates.map(c => c.head) });
  for (const [index, candidate] of candidates.entries()) {
    if (experiment.mode === 'profile' && index > 0) break;
    const c = { ...candidate, index, status: 'PREPARING', pairs: [] }; report.cases.push(c); announce('commit-start', { index, head: candidate.head });
    try {
      git(['checkout', '--force', '--detach', candidate.head]);
      if (spec.language === 'go') {
        if (existsSync(join(checkout, 'diffci.json'))) throw new Error('Existing DiffCI config requires a separate cohort; no overwrite');
        // Constant benchmark CI declaration, outside the historical source delta.
        c.configurationOverlay = { go: { scope: 'root-module' } };
        writeFileSync(join(checkout, 'diffci.json'), JSON.stringify(c.configurationOverlay));
        c.setup = run('go', ['mod', 'download'], checkout).record;
      } else {
        if (existsSync(join(checkout, 'diffci.json'))) throw new Error('Existing DiffCI config requires a separate cohort; no overwrite');
        c.configurationOverlay = { vue: { packageRoot: spec.cwd, testConfig: 'vitest.config.ts' } };
        writeFileSync(join(checkout, 'diffci.json'), JSON.stringify(c.configurationOverlay));
        c.setup = run('corepack', ['pnpm', 'install', '--frozen-lockfile'], checkout, true, 480000).record;
        if (spec.id === 'vue-router') {
          // Its Vitest type tests consume the outputs of the documented preceding builds.
          c.build = run('corepack', ['pnpm', '--filter', 'vue-router', 'run', 'build'], checkout).record;
          c.declarations = run('corepack', ['pnpm', '--filter', 'vue-router', 'run', 'build:dts'], checkout).record;
        }
      }
      const out = join(root, `observation-${index}.json`);
      c.analysis = run('node', [join(host, 'node_modules/@diffci/observer/index.mjs'), 'observe', '--repo', checkout, '--base', candidate.base, '--head', candidate.head, '--out', out, '--no-send'], checkout, false, 180000).record;
      c.observation = JSON.parse(readFileSync(out, 'utf8'));
      if (c.observation.nonInterference?.worktreeUnchanged !== true) throw new Error('Observer violated non-interference');
      if (!['OBSERVED', 'REFUSED'].includes(c.observation.status)) throw new Error(`Observer ${c.observation.status}: ${c.observation.reason}`);
      const result = c.observation.result;
      if (experiment.mode === 'profile') {
        c.profiles = [{ processMs: c.analysis.elapsedMs, timings: c.observation.timings, graph: result?.graph }];
        for (let repeat = 0; repeat < 2; repeat++) {
          const measured = run('node', [join(host, 'node_modules/@diffci/observer/index.mjs'), 'observe', '--repo', checkout, '--base', candidate.base, '--head', candidate.head, '--out', out, '--no-send'], checkout).record;
          const observed = JSON.parse(readFileSync(out, 'utf8'));
          if (observed.nonInterference?.worktreeUnchanged !== true) throw new Error('Profile observation changed worktree');
          c.profiles.push({ processMs: measured.elapsedMs, timings: observed.timings, graph: observed.result?.graph });
        }
        c.status = 'OBSERVER_PROFILED';
        announce('observer-profiled', { profiles: c.profiles });
        continue;
      }
      let selected;
      c.policy = c.observation.status === 'REFUSED' ? 'REFUSED_FULL' : result.mode;
      if (result?.mode === 'SELECTIVE') {
        if (result.commandRefusalReason || result.unroutedTestPaths?.length || result.blindSpot) c.policy = 'COMMAND_OR_UNIVERSE_REFUSED_FULL';
        else {
          selected = result.selectedTests;
          if (!selected.every(safePath)) throw new Error('Invalid selected test path');
        }
      }
      const firstFull = execute(); c.firstFull = firstFull; save();
      if (!green(firstFull)) { c.status = 'BASELINE_RED_OR_UNREADABLE'; continue; }
      if (selected && spec.language === 'vue' && JSON.stringify([...(result.scopedTestFiles ?? [])].sort()) !== JSON.stringify([...firstFull.summary.files].sort())) {
        c.policy = 'SUITE_UNIVERSE_MISMATCH_FULL';
        c.suiteUniverseMismatch = { declared: result.scopedTestFiles ?? [], actual: firstFull.summary.files };
        selected = undefined;
      }
      if (selected && spec.language === 'vue' && selected.some(p => !firstFull.summary.files.includes(p))) { c.policy = 'OUTSIDE_MEASURED_SUITE_FULL'; selected = undefined; }
      c.executedSelection = selected ?? null;
      let secondFull;
      if (selected === undefined) {
        secondFull = execute();
        c.baselines = [firstFull, secondFull];
        c.fullPolicyIsIdentical = true;
        c.observerOverheadMs = c.analysis.elapsedMs;
        if (!green(secondFull)) { c.status = 'UNSTABLE_OR_POLICY_FAILED'; continue; }
      } else {
        const firstPolicy = execute(selected);
        c.pairs.push({ full: firstFull, policy: firstPolicy, netSavedMs: firstFull.elapsedMs - firstPolicy.elapsedMs - c.analysis.elapsedMs }); save();
        const secondPolicy = execute(selected); secondFull = execute();
        c.pairs.push({ full: secondFull, policy: secondPolicy, netSavedMs: secondFull.elapsedMs - secondPolicy.elapsedMs - c.analysis.elapsedMs });
        if (!c.pairs.every(p => green(p.full) && green(p.policy))) { c.status = 'UNSTABLE_OR_POLICY_FAILED'; continue; }
      }
      const universe = s => JSON.stringify({ files: s.files, packages: Object.keys(s.packages ?? {}).sort(), total: s.total });
      if (universe(firstFull.summary) !== universe(secondFull.summary)) { c.status = 'FULL_UNIVERSE_CHANGED'; continue; }
      c.status = selected === undefined ? 'FULL_POLICY_MEASURED' : selected.length === 0 ? 'EMPTY_SELECTION_MEASURED' : 'SELECTIVE_POLICY_MEASURED';
      announce('commit-measured', { index, policy: c.policy, status: c.status, netSavedMs: c.pairs.map(p => p.netSavedMs) });
      if (cohort.faultIndexes.includes(index)) {
        const path = candidate.sourceFiles.find(p => existsSync(join(checkout, p)));
        if (!path) c.fault = { outcome: 'NO_SURVIVING_SOURCE_FILE' };
        else {
          const m = mutation(path);
          if (!m) c.fault = { path, outcome: 'NO_SUPPORTED_MUTATION_SITE' };
          else {
            c.fault = { path, kind: m.kind, selectionFrozenBeforeMutation: true };
            writeFileSync(join(checkout, path), m.changed);
            try {
              c.fault.full = execute();
              if (selected !== undefined) c.fault.policy = execute(selected);
              else c.fault.policyIdenticalToFull = true;
              const detects = r => r.exitCode !== null && r.exitCode !== 0 && !r.error && r.mutationMarkerSeen && r.summary.readable && (r.summary.failed > 0 || r.summary.failedSuites > 0);
              c.fault.fullDetected = detects(c.fault.full); c.fault.policyDetected = c.fault.policyIdenticalToFull ? c.fault.fullDetected : detects(c.fault.policy);
              c.fault.outcome = !c.fault.fullDetected ? 'INCONCLUSIVE_FULL_DID_NOT_DETECT' : c.fault.policyDetected ? 'DETECTED' : 'MISSED_OR_UNREADABLE_POLICY';
            } finally { writeFileSync(join(checkout, path), m.original); }
          }
        }
        announce('fault-complete', { index, outcome: c.fault.outcome });
      }
    } catch (e) { c.status = 'INCONCLUSIVE'; c.error = String(e); }
    finally {
      if (c.configurationOverlay && existsSync(join(checkout, 'diffci.json'))) { const { unlinkSync } = await import('node:fs'); unlinkSync(join(checkout, 'diffci.json')); }
      announce('commit-complete', { index, status: c.status });
    }
  }
} catch (e) { report.error = String(e); }
report.finishedAt = new Date().toISOString(); save();
console.log(JSON.stringify({ event: 'benchmark-complete', repository: spec.id, error: report.error, cases: report.cases.map(c => ({ head: c.head, status: c.status, policy: c.policy, fault: c.fault?.outcome })) }));
