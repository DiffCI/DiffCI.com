import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const source = readFileSync(new URL('./lib/dentalpresence-pairs.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const digest = createHash('sha256').update(source).digest('hex');
const output = `// Generated from DiffCI scripts/lib/dentalpresence-pairs.ts; source SHA256 ${digest}.\n` +
  '// Update with scripts/sync-dentalpresence-importer.mjs in DiffCI; do not edit by hand.\n' +
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const target = resolve(process.argv.slice(2).find((arg) => arg !== '--check') ?? '../DentalPresence.in/scripts/ci-pair-import.mjs');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('DentalPresence importer has drifted from its canonical source');
} else writeFileSync(target, output);
