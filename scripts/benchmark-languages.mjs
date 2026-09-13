import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { freezeTimingHistory, heldOutEconomics, vitestWorkerConfiguration } from './bypass-benchmark-protocol.js';

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
let vueWorkerArguments = ['--maxWorkers=2', '--minWorkers=2'];
let vueWorkerEnvironment = {};
const deadline = Date.now() + 40 * 60_000;
function run(cmd, args, cwd = root, required = true, timeout = 300000, envOverrides = {}) {
  if (Date.now() > deadline) throw new Error('Repository budget exhausted');
  const start = performance.now();
  const result = spawnSync(cmd, args, { cwd, env: { ...process.env, ...envOverrides }, encoding: 'utf8', timeout: Math.min(timeout, Math.max(1000, deadline - Date.now())), maxBuffer: 48 * 1024 * 1024 });
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
    args = ['pnpm', '--dir', spec.cwd, 'exec', 'vitest', 'run', '--config', 'vitest.config.ts', ...vueWorkerArguments, '--sequence.seed=42', '--reporter=json', `--outputFile=${json}`, ...(selected ?? []).map(p => relative(resolve(checkout, spec.cwd), resolve(checkout, p)))];
  }
  const result = run('/usr/bin/time', ['-f', '%U %S %e %M', '-o', usage, cmd, ...args], cwd, false, 180000, vueWorkerEnvironment);
  const record = result.record;
  record.summary = summaries(result, json);
  try {
    const [userSeconds, systemSeconds, wallSeconds, peakRssKiB] = readFileSync(usage, 'utf8').trim().split('\n').at(-1).split(' ').map(Number);
    record.resources = { userSeconds, systemSeconds, wallSeconds, peakRssKiB };
  } catch {}
  return record;
}
function green(r) { return r.exitCode === 0 && !r.error && r.summary.readable; }

function runtimePartitionSmoke(host) {
  const directory = join(root, 'runtime-partition-contract');
  mkdirSync(directory);
  const files = {
    'package.json': JSON.stringify({ type: 'module', private: true, devDependencies: { vitest: '2.1.9', vue: '3.5.13', '@vitejs/plugin-vue': '5.1.4', vite: '5.4.16', jsdom: '25.0.1' } }),
    'diffci.json': JSON.stringify({ vue: { packageRoot: '.', testConfig: 'vitest.config.ts' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022' }, include: ['src', 'tests'] }),
    'vitest.config.ts': 'import {defineConfig} from "vitest/config"; import vue from "@vitejs/plugin-vue"; export default defineConfig({plugins:[vue()],test:{include:["tests/**/*.test.ts"],environment:"jsdom",isolate:true}});',
    'src/value.ts': 'export const value = 1;',
    'src/Runtime.vue': '<script setup>defineProps(["component"])</script><template><component :is="component" /></template>',
    'tests/runtime.test.ts': 'import {it,expect} from "vitest"; import {createApp,h} from "vue"; import Runtime from "../src/Runtime.vue"; it("runtime component",()=>{const root=document.createElement("div");const app=createApp(Runtime,{component:h("span","ok")});app.mount(root);expect(root.textContent).toBe("ok");app.unmount()});',
    'tests/value.test.ts': 'import {it,expect} from "vitest"; import {value} from "../src/value"; it("value",()=>expect(value).toBeGreaterThan(0));',
    'tests/unrelated.test.ts': 'import {it,expect} from "vitest"; it("unrelated",()=>expect(true).toBe(true));',
    '.gitignore': 'node_modules/\n',
  };
  for (const [path, contents] of Object.entries(files)) { mkdirSync(resolve(directory, path, '..'), { recursive: true }); writeFileSync(join(directory, path), contents); }
  report.runtimeContractInstall = run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], directory).record;
  const fixtureGit = args => run('git', args, directory).stdout.trim();
  fixtureGit(['init']); fixtureGit(['remote', 'add', 'origin', 'https://github.com/diffci-fixture/runtime-contract.git']); fixtureGit(['add', '.']); fixtureGit(['-c', 'user.name=DiffCI', '-c', 'user.email=validation@diffci.com', 'commit', '-m', 'base']);
  const base = fixtureGit(['rev-parse', 'HEAD']);
  writeFileSync(join(directory, 'src/value.ts'), 'export const value = 2;');
  fixtureGit(['add', '.']); fixtureGit(['-c', 'user.name=DiffCI', '-c', 'user.email=validation@diffci.com', 'commit', '-m', 'unrelated source change']);
  const head = fixtureGit(['rev-parse', 'HEAD']);
  const output = join(root, 'runtime-contract-observation.json');
  const process = run('node', [join(host, 'node_modules/@diffci/observer/index.mjs'), 'observe', '--repo', directory, '--base', base, '--head', head, '--out', output, '--no-send'], directory).record;
  const observation = JSON.parse(readFileSync(output, 'utf8'));
  const selected = observation.result?.selectedTests;
  const smoke = report.runtimePartitionSmoke = { synthetic: true, process, observation, selectionFrozenBeforeMutation: true };
  save();
  if (observation.nonInterference?.worktreeUnchanged !== true || observation.result?.mode !== 'SELECTIVE' || JSON.stringify([...selected].sort()) !== '["tests/runtime.test.ts","tests/value.test.ts"]') throw new Error('Runtime contract did not keep the unrelated runtime test selected');
  const executeFixture = paths => {
    const json = join(root, `runtime-contract-${sequence++}.json`);
    const result = run('node', [join(directory, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', ...vueWorkerArguments, '--reporter=json', `--outputFile=${json}`, ...(paths ?? [])], directory, false, 180000, vueWorkerEnvironment).record;
    const raw = readFileSync(json, 'utf8'); const data = JSON.parse(raw);
    return { ...result, files: data.testResults.map(t => relative(directory, t.name)).sort(), failed: data.numFailedTests, failedSuites: data.numFailedTestSuites, markerSeen: raw.includes('DIFFCI_BENCHMARK_FAULT') };
  };
  smoke.full = executeFixture(); smoke.selected = executeFixture(selected); save();
  if (smoke.full.exitCode !== 0 || smoke.full.files.length !== 3 || smoke.selected.exitCode !== 0 || JSON.stringify(smoke.selected.files) !== JSON.stringify([...selected].sort())) throw new Error('Runtime contract full/subset execution failed');
  writeFileSync(join(directory, 'src/Runtime.vue'), files['src/Runtime.vue'].replace('<script setup>', '<script setup>throw new Error("DIFFCI_BENCHMARK_FAULT");'));
  try {
    smoke.faultFull = executeFixture(); smoke.faultSelected = executeFixture(selected); save();
    const detected = result => result.exitCode !== null && result.exitCode !== 0 && !result.error && result.markerSeen && (result.failed > 0 || result.failedSuites > 0);
    if (!detected(smoke.faultFull) || !detected(smoke.faultSelected)) throw new Error('Runtime contract missed a fault outside the static source-change closure');
    smoke.outcome = 'DETECTED';
  } finally { writeFileSync(join(directory, 'src/Runtime.vue'), files['src/Runtime.vue']); save(); }
  announce('runtime-contract-complete', { outcome: smoke.outcome });
}
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
  report.checks.push(run('npm', ['exec', '--', 'tsx', '--test', 'tests/repo/language-adapters.test.ts', 'tests/repo/vue-scope.test.ts', 'tests/client/economics.test.ts'], '/opt/diffci', false).record);
  if (['cache', 'reka-selection'].includes(experiment.mode)) report.checks.push(run('npm', ['exec', '--', 'tsx', '--test', 'tests/cache/vue-analysis-cache.test.ts'], '/opt/diffci', false).record);
  if (experiment.mode === 'bypass') report.checks.push(run('npm', ['exec', '--', 'tsx', '--test', 'tests/validation-env/bypass-protocol.test.ts'], '/opt/diffci', false).record);
  if (spec.id === 'vue-test-utils' || (['cache', 'reka-selection'].includes(experiment.mode) && spec.id === 'reka-ui')) {
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
  const baselineRoot = '/opt/diffci-baseline';
  if (experiment.baselineVersion) {
    const source = '/opt/diffci/scripts/performance-baseline.tgz';
    if (createHash('sha256').update(readFileSync(source)).digest('hex') !== experiment.baselineSourceSha256) throw new Error('Baseline source checksum mismatch');
    mkdirSync(baselineRoot);
    run('tar', ['-xzf', source, '-C', baselineRoot]);
    run('ln', ['-s', '/opt/diffci/node_modules', join(baselineRoot, 'node_modules')]);
    report.baselineBuild = run('npm', ['exec', '--', 'tsx', 'scripts/build-agent.ts', `--version=${experiment.baselineVersion}`], baselineRoot).record;
  }
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
  if (experiment.candidateIntegrity && report.agentIntegrity !== experiment.candidateIntegrity) throw new Error('Candidate differs from qualified observer artifact');
  const host = join(root, 'observer'); mkdirSync(host); writeFileSync(join(host, 'package.json'), '{"private":true}');
  run('npm', ['install', '--no-audit', '--no-fund', agent], host);
  const baselineHost = join(root, 'observer-baseline');
  if (experiment.baselineVersion) {
    const baselineAgent = join(baselineRoot, `dist-agent/diffci-observer-${experiment.baselineVersion}.tgz`);
    report.baselineIntegrity = 'sha512-' + createHash('sha512').update(readFileSync(baselineAgent)).digest('base64');
    if (report.baselineIntegrity !== experiment.baselineIntegrity) throw new Error('Baseline artifact differs from previously qualified artifact');
    mkdirSync(baselineHost); writeFileSync(join(baselineHost, 'package.json'), '{"private":true}');
    run('npm', ['install', '--no-audit', '--no-fund', baselineAgent], baselineHost);
  }
  if (spec.id === 'vue-test-utils' && experiment.mode === 'qualification') {
    const smoke = join(root, 'economics-smoke'); mkdirSync(smoke);
    const smokeGit = args => run('git', args, smoke).stdout.trim();
    smokeGit(['init', '--quiet']); smokeGit(['config', 'user.name', 'Cloud fixture']); smokeGit(['config', 'user.email', 'fixture@example.test']); smokeGit(['remote', 'add', 'origin', 'https://github.com/diffci-fixture/economics.git']);
    writeFileSync(join(smoke, 'package.json'), '{"devDependencies":{"vitest":"1"}}');
    writeFileSync(join(smoke, 'tsconfig.json'), 'INVALID_CONFIG_PROVES_BYPASS');
    const heads = [];
    for (let i = 0; i < 6; i++) { writeFileSync(join(smoke, 'value.ts'), `export const value = ${i};`); smokeGit(['add', '.']); smokeGit(['commit', '--quiet', '-m', `change ${i}`]); heads.push(smokeGit(['rev-parse', 'HEAD'])); }
    const output = join(root, 'economics-smoke.json');
    const args = [join(host, 'node_modules/@diffci/observer/index.mjs'), 'observe', '--repo', smoke, '--base', heads[4], '--head', heads[5], '--out', output, '--no-send', '--economics-job', 'synthetic-unit'];
    run('node', args, smoke);
    const contextKey = JSON.parse(readFileSync(output, 'utf8')).economics?.contextKey;
    if (!contextKey) throw new Error('Packaged observer did not expose economics context');
    const historyPath = join(root, 'economics-history.json');
    writeFileSync(historyPath, JSON.stringify({ schema: 'diffci.economics.v1', repository: 'diffci-fixture/economics', jobKey: 'synthetic-unit', contextKey, observerVersion: report.candidateVersion, recordedAt: new Date().toISOString(), samples: heads.slice(0, 5).map(headSha => ({ headSha, stable: true, fullMs: 20000, policyMs: 19800, observerMs: 2000 })) }));
    const process = run('node', [...args, '--economics-history', historyPath], smoke).record;
    const observation = JSON.parse(readFileSync(output, 'utf8'));
    report.economicsSmoke = { synthetic: true, process, observation };
    if (observation.observer.version !== report.candidateVersion || observation.observer.engineSha || observation.status !== 'REFUSED' || observation.economics?.decision !== 'BYPASS_FULL' || observation.result || observation.timings.phasesMs?.engineLoad !== undefined || observation.nonInterference?.worktreeUnchanged !== true) throw new Error('Packaged economics bypass failed');
  }
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
    if (candidates.length === (experiment.commitsPerRepository ?? cohort.commitsPerRepository)) break;
  }
  if (experiment.mode === 'bypass') {
    if (candidates.length !== 16 || experiment.trainingCount !== 8) throw new Error('Bypass experiment requires frozen 8 training + 8 held-out commits');
    candidates.reverse();
    report.bypassProtocol = { order: 'first-parent ancestry, oldest first', trainingCount: 8, heldOutCount: 8, history: 'frozen after training; latest observed training configuration only', targetFaults: 'not repeated; observer artifact unchanged' };
  }
  if (experiment.mode === 'cache') {
    if (candidates.length !== 8) throw new Error('Cache experiment requires the same eight held-out source commits');
    candidates.reverse();
    report.cacheProtocol = { order: 'oldest first', arms: ['uncached', 'cold', 'warm', 'incremental'], repetitions: 2, cacheTransport: 'runner-local filesystem on Cloudflare; reads/validation/writes included, cross-job R2 transfer not measured', priorCommit: 'independent persistent cache per repetition; first commit starts empty' };
  }
  if (experiment.mode === 'reka-selection') candidates.reverse();
  const trainingRecords = [];
  let latestTrainingContext = '';
  const timingHistoryPath = join(root, 'frozen-timing-history.json');
  let frozenHistoryHash;
  report.frozenCandidates = candidates;
  report.historyExaminedLimit = cohort.historyLimit;
  announce('cohort-frozen', { commits: candidates.map(c => c.head) });
  for (const [index, candidate] of candidates.entries()) {
    if (index < (experiment.caseStart ?? 0)) continue;
    if (experiment.caseLimit && index >= experiment.caseLimit) break;
    if (experiment.mode === 'profile' && index > 0) break;
    const c = { ...candidate, index, status: 'PREPARING', pairs: [] }; report.cases.push(c); announce('commit-start', { index, head: candidate.head });
    if (experiment.mode === 'bypass') {
      c.phase = index < experiment.trainingCount ? 'training' : 'held-out';
      if (index === experiment.trainingCount) {
        report.frozenTimingHistory = freezeTimingHistory(trainingRecords, { trainingCount: experiment.trainingCount, repository: spec.repository, jobKey: `${spec.id}-linux-${spec.language}-fixed-suite`, observerVersion: report.candidateVersion, contextKey: latestTrainingContext, recordedAt: new Date().toISOString() });
        writeFileSync(timingHistoryPath, JSON.stringify(report.frozenTimingHistory));
        frozenHistoryHash = createHash('sha256').update(readFileSync(timingHistoryPath)).digest('hex');
        report.frozenTimingHistorySha256 = frozenHistoryHash;
        announce('timing-history-frozen', { samples: report.frozenTimingHistory.samples.length, distinctCommits: new Set(report.frozenTimingHistory.samples.map(sample => sample.headSha)).size });
      }
    }
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
        if (experiment.compatibleVitestWorkers) {
          const help = run('corepack', ['pnpm', '--dir', spec.cwd, 'exec', 'vitest', '--help'], checkout);
          c.testRunnerHelp = help.record;
          const version = run('corepack', ['pnpm', '--dir', spec.cwd, 'exec', 'vitest', '--version'], checkout);
          c.testRunnerVersion = version.record;
          const workers = vitestWorkerConfiguration(help.stdout, version.stdout);
          vueWorkerArguments = workers.args;
          vueWorkerEnvironment = workers.env;
          c.testWorkerEnvironment = workers.env;
          c.testWorkerArguments = vueWorkerArguments;
          c.testRunnerHelp = help.record;
        }
        if (experiment.runtimePartitionSmoke && index === 0) {
          try { runtimePartitionSmoke(host); }
          catch (error) { report.runtimeContractFailed = true; throw error; }
        }
        if (spec.id === 'vue-router') {
          // Its Vitest type tests consume the outputs of the documented preceding builds.
          c.build = run('corepack', ['pnpm', '--filter', 'vue-router', 'run', 'build'], checkout).record;
          c.declarations = run('corepack', ['pnpm', '--filter', 'vue-router', 'run', 'build:dts'], checkout).record;
        }
      }
      const out = join(root, `observation-${index}.json`);
      const observeWith = (agentHost, extra = []) => {
        if (existsSync(out)) unlinkSync(out);
        const analysis = run('node', [join(agentHost, 'node_modules/@diffci/observer/index.mjs'), 'observe', '--repo', checkout, '--base', candidate.base, '--head', candidate.head, '--out', out, '--no-send', '--economics-job', `${spec.id}-linux-${spec.language}-fixed-suite`, ...extra], checkout, false, 180000).record;
        const observation = JSON.parse(readFileSync(out, 'utf8'));
        if (observation.nonInterference?.worktreeUnchanged !== true) throw new Error('Observation changed worktree');
        if (observation.commitRange?.headSha !== candidate.head || observation.commitRange?.baseSha !== candidate.base) throw new Error('Observation range mismatch');
        return { analysis, observation };
      };
      if (experiment.mode === 'cache') {
        c.cacheObservations = [];
        const identity = o => { const { graph, ...result } = o.result ?? {}; return JSON.stringify({ status: o.status, stage: o.stage, reason: o.reason, result, graph: graph && { nodes: graph.nodes, edges: graph.edges, confidence: graph.confidence, effectiveConfidence: graph.effectiveConfidence } }); };
        for (let repeat = 0; repeat < 2; repeat++) {
          const coldDir = join(root, `vue-cache-cold-${index}-${repeat}`);
          const incrementalDir = join(root, `vue-cache-incremental-${repeat}`);
          const order = (index + repeat) % 2 === 0 ? ['uncached', 'cold', 'warm', 'incremental'] : ['incremental', 'cold', 'warm', 'uncached'];
          const pair = { order };
          for (const arm of order) pair[arm] = observeWith(host, arm === 'uncached' ? [] : ['--vue-analysis-cache', arm === 'incremental' ? incrementalDir : coldDir]);
          if (pair.uncached.observation.status !== 'OBSERVED' || !order.every(arm => identity(pair[arm].observation) === identity(pair.uncached.observation))) throw new Error('Cached/uncached decision details differ');
          c.cacheObservations.push(pair);
        }
        c.analysis = c.cacheObservations[0].warm.analysis;
        c.observation = c.cacheObservations[0].warm.observation;
        c.cacheDecisionEquivalent = true;
      } else if (experiment.mode === 'reka-selection') {
        c.selectionObservations = [];
        const arms = experiment.selectionArms ?? ['uncached', 'incremental'];
        if (JSON.stringify(arms) !== '["uncached"]' && JSON.stringify(arms) !== '["uncached","incremental"]') throw new Error('Unsupported selection observer arms');
        c.primarySelectionArm = arms.at(-1);
        const identity = o => { const { graph, ...result } = o.result ?? {}; return JSON.stringify({ status: o.status, stage: o.stage, reason: o.reason, result, graph: graph && { nodes: graph.nodes, edges: graph.edges, confidence: graph.confidence, effectiveConfidence: graph.effectiveConfidence } }); };
        for (let repeat = 0; repeat < 2; repeat++) {
          const order = (index + repeat) % 2 === 0 ? [...arms] : [...arms].reverse();
          const pair = { order };
          for (const arm of order) pair[arm] = observeWith(host, arm === 'uncached' ? [] : ['--vue-analysis-cache', join(root, `selection-cache-${repeat}`)]);
          if (pair.uncached.observation.status !== 'OBSERVED' || !arms.every(arm => identity(pair[arm].observation) === identity(pair.uncached.observation))) throw new Error('Selection cached/uncached decisions differ');
          if (repeat && identity(pair.uncached.observation) !== identity(c.selectionObservations[0].uncached.observation)) throw new Error('Selection decisions changed between repetitions');
          c.selectionObservations.push(pair);
        }
        c.analysis = c.selectionObservations[0][c.primarySelectionArm].analysis;
        c.observation = c.selectionObservations[0][c.primarySelectionArm].observation;
        c.cacheDecisionEquivalent = arms.length === 2 ? true : undefined;
        c.repeatedDecisionEquivalent = true;
      } else if (experiment.mode === 'bypass') {
        c.bypassObservations = [];
        const heldOut = c.phase === 'held-out';
        const firstOrder = heldOut ? (index % 2 === 0 ? ['gated', 'oracle'] : ['oracle', 'gated']) : ['oracle'];
        const historyArgs = heldOut ? ['--economics-history', timingHistoryPath] : [];
        for (const order of [firstOrder, [...firstOrder].reverse()]) {
          const pair = { order };
          for (const arm of order) {
            pair[arm] = observeWith(host, [...historyArgs, ...(arm === 'oracle' ? ['--force-analysis'] : [])]);
            if (!['OBSERVED', 'REFUSED'].includes(pair[arm].observation.status)) throw new Error(`${arm} observation failed`);
          }
          c.bypassObservations.push(pair);
          if (heldOut) {
            const gated = pair.gated.observation;
            if (gated.economics?.decision === 'BYPASS_FULL') {
              if (gated.status !== 'REFUSED' || gated.result || gated.timings.phasesMs?.engineLoad !== undefined) throw new Error('Bypass did not retain full CI before engine loading');
            } else {
              const decision = o => { const { graph, ...result } = o.result ?? {}; return JSON.stringify({ status: o.status, stage: o.stage, reason: o.reason, result, confidence: graph?.effectiveConfidence }); };
              if (decision(gated) !== decision(pair.oracle.observation)) throw new Error('Analyzed gated/oracle decisions differ');
            }
          }
        }
        c.analysis = c.bypassObservations[0].oracle.analysis;
        c.observation = c.bypassObservations[0].oracle.observation;
        if (heldOut) {
          c.historySha256 = createHash('sha256').update(readFileSync(timingHistoryPath)).digest('hex');
          if (c.historySha256 !== frozenHistoryHash) throw new Error('Frozen timing history changed');
          if (c.bypassObservations[0].gated.observation.economics?.decision !== c.bypassObservations[1].gated.observation.economics?.decision) throw new Error('Gating decision changed across repetitions');
        } else latestTrainingContext = c.observation.economics?.contextKey ?? '';
      } else if (experiment.baselineVersion) {
        c.observerComparison = [];
        const firstOrder = index % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const order of [firstOrder, [...firstOrder].reverse()]) {
          const pair = { order };
          for (const label of order) pair[label] = observeWith(label === 'baseline' ? baselineHost : host);
          c.observerComparison.push(pair);
        }
        c.analysis = c.observerComparison[0].candidate.analysis;
        c.observation = c.observerComparison[0].candidate.observation;
        const policyIdentity = observation => JSON.stringify(observation.result?.mode === 'SELECTIVE' ? { mode: 'SELECTIVE', tests: [...observation.result.selectedTests].sort(), commands: observation.result.proposedCommands, refusal: observation.result.commandRefusalReason } : { mode: 'FULL' });
        c.comparatorPolicyEquivalent = c.observerComparison.every(pair => policyIdentity(pair.baseline.observation) === policyIdentity(pair.candidate.observation));
        if (!c.comparatorPolicyEquivalent) throw new Error('Baseline/candidate policy differs; matched timing cannot reuse test work');
        if (experiment.mode === 'overhead') {
          const decisionIdentity = observation => {
            const { graph, ...result } = observation.result ?? {};
            return JSON.stringify({ status: observation.status, stage: observation.stage, reason: observation.reason, result, graph: graph && { nodes: graph.nodes, edges: graph.edges, confidence: graph.confidence, effectiveConfidence: graph.effectiveConfidence } });
          };
          c.comparatorDecisionEquivalent = c.observerComparison.every(pair => decisionIdentity(pair.baseline.observation) === decisionIdentity(pair.candidate.observation));
          if (!c.comparatorDecisionEquivalent) throw new Error('Baseline/candidate decision details differ');
        }
      } else { const observed = observeWith(host); c.analysis = observed.analysis; c.observation = observed.observation; }
      if (c.observation.nonInterference?.worktreeUnchanged !== true) throw new Error('Observer violated non-interference');
      if (!['OBSERVED', 'REFUSED'].includes(c.observation.status)) throw new Error(`Observer ${c.observation.status}: ${c.observation.reason}`);
      const result = c.observation.result;
      if (experiment.mode === 'reka-selection') {
        const counts = {};
        for (const reason of result?.fallbackReasons ?? []) { const category = reason.replace(/^Vue .+?: /, 'Vue: '); counts[category] = (counts[category] ?? 0) + 1; }
        c.selectionDiagnostics = { policy: result?.mode, declaredTests: result?.totalTestCount, selectedTests: result?.selectedTests.length, processMs: c.analysis.elapsedMs, reasons: counts };
        announce('selection-diagnostics', { index, ...c.selectionDiagnostics });
      }
      if (experiment.mode === 'overhead') {
        if (!c.observerComparison || !c.comparatorDecisionEquivalent) throw new Error('Overhead mode requires a matched baseline');
        c.status = 'OBSERVER_OVERHEAD_MEASURED';
        c.cacheConditions = { process: 'fresh process for every observation', repository: 'same installed checkout per commit', order: 'alternating first pair, reversed second pair', caches: 'OS/tool caches not flushed; no persistent DiffCI graph cache or daemon enabled' };
        announce('observer-overhead-measured', { index, timings: c.observerComparison.map(pair => ({ order: pair.order, baselineMs: pair.baseline.analysis.elapsedMs, candidateMs: pair.candidate.analysis.elapsedMs })) });
        continue;
      }
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
      if (experiment.mode === 'reka-selection') {
        const declared = [...(result?.scopedTestFiles ?? [])].sort(); const actual = [...firstFull.summary.files].sort();
        c.inventoryAudit = { matches: JSON.stringify(declared) === JSON.stringify(actual), declaredCount: declared.length, actualCount: actual.length, missing: actual.filter(path => !declared.includes(path)), extra: declared.filter(path => !actual.includes(path)) };
        announce('inventory-audit', { index, ...c.inventoryAudit });
      }
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
        c.pairs.push({ full: secondFull, policy: secondPolicy, netSavedMs: secondFull.elapsedMs - secondPolicy.elapsedMs - (c.selectionObservations?.[1][c.primarySelectionArm].analysis.elapsedMs ?? c.analysis.elapsedMs) });
        if (!c.pairs.every(p => green(p.full) && green(p.policy))) { c.status = 'UNSTABLE_OR_POLICY_FAILED'; continue; }
      }
      const universe = s => JSON.stringify({ files: s.files, packages: Object.keys(s.packages ?? {}).sort(), total: s.total });
      if (universe(firstFull.summary) !== universe(secondFull.summary)) { c.status = 'FULL_UNIVERSE_CHANGED'; continue; }
      c.status = selected === undefined ? 'FULL_POLICY_MEASURED' : selected.length === 0 ? 'EMPTY_SELECTION_MEASURED' : 'SELECTIVE_POLICY_MEASURED';
      if (experiment.mode === 'reka-selection') {
        const pairs = c.pairs.length ? c.pairs : c.baselines.map(full => ({ full, policy: full }));
        c.selectionEconomics = pairs.map((pair, i) => Object.fromEntries((experiment.selectionArms ?? ['uncached', 'incremental']).map(arm => [arm, { fullMs: pair.full.elapsedMs, policyMs: pair.policy.elapsedMs, observerMs: c.selectionObservations[i][arm].analysis.elapsedMs, netSavedMs: pair.full.elapsedMs - pair.policy.elapsedMs - c.selectionObservations[i][arm].analysis.elapsedMs }])));
      }
      if (experiment.mode === 'cache') {
        const pairs = c.pairs.length ? c.pairs : c.baselines.map(full => ({ full, policy: full }));
        c.cacheEconomics = pairs.map((pair, i) => Object.fromEntries(['uncached', 'cold', 'warm', 'incremental'].map(arm => [arm, { fullMs: pair.full.elapsedMs, policyMs: pair.policy.elapsedMs, observerMs: c.cacheObservations[i][arm].analysis.elapsedMs, netSavedMs: pair.full.elapsedMs - pair.policy.elapsedMs - c.cacheObservations[i][arm].analysis.elapsedMs }])));
      }
      if (experiment.mode === 'bypass') {
        const testPairs = c.pairs.length ? c.pairs : c.baselines.map(full => ({ full, policy: full, policyIdenticalToFull: true }));
        if (c.phase === 'training') {
          const record = { index, headSha: c.head, contextKey: c.observation.economics?.contextKey ?? '', stable: true, pairs: testPairs.map((pair, i) => ({ fullMs: pair.full.elapsedMs, policyMs: pair.policy.elapsedMs, observerMs: c.bypassObservations[i].oracle.analysis.elapsedMs })) };
          trainingRecords.push(record);
          c.trainingRecord = record;
        } else {
          c.bypassEvaluation = testPairs.map((pair, i) => heldOutEconomics({ decision: c.bypassObservations[i].gated.observation.economics.decision, fullMs: pair.full.elapsedMs, policyMs: pair.policy.elapsedMs, gatedObserverMs: c.bypassObservations[i].gated.analysis.elapsedMs, forcedObserverMs: c.bypassObservations[i].oracle.analysis.elapsedMs }));
        }
      }
      if (c.observerComparison) {
        c.matchedEconomics = c.pairs.map(pair => ({ fullMs: pair.full.elapsedMs, policyMs: pair.policy.elapsedMs, baselineObserverMs: c.observerComparison[0].baseline.analysis.elapsedMs, candidateObserverMs: c.analysis.elapsedMs, baselineNetSavedMs: pair.full.elapsedMs - pair.policy.elapsedMs - c.observerComparison[0].baseline.analysis.elapsedMs, candidateNetSavedMs: pair.netSavedMs }));
      }
      announce('commit-measured', { index, policy: c.policy, status: c.status, netSavedMs: c.pairs.map(p => p.netSavedMs) });
      if (experiment.mode !== 'bypass' && cohort.faultIndexes.includes(index)) {
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
    if (report.runtimeContractFailed) throw new Error('Runtime protection contract failed; cohort qualification stopped');
  }
} catch (e) { report.error = String(e); }
report.finishedAt = new Date().toISOString(); save();
console.log(JSON.stringify({ event: 'benchmark-complete', repository: spec.id, error: report.error, cases: report.cases.map(c => ({ head: c.head, status: c.status, policy: c.policy, fault: c.fault?.outcome })) }));
