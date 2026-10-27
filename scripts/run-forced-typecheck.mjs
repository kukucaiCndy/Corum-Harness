#!/usr/bin/env node
// scripts/run-forced-typecheck.mjs
//
// Stage 3 §0b: per-package forced typecheck baseline collector.
//
// Why this script exists (05-fork-rebase.md §4.0 步骤 0b):
//   - `pnpm -r --no-bail run typecheck` runs each package's `tsc -b` which is
//     incremental — it can hide breakage behind stale tsbuildinfo.
//   - We need `tsc -b --force` per package to flush the cache and surface real
//     errors. But `pnpm -r run typecheck -- --force` appends `--force` to the
//     LAST command in a `&&` chain (some packages have `tsc -b && tsc -p spec`),
//     so the main compilation never gets `--force` (06-verification.md §4.1).
//   - For packages with `tsconfig.spec.json`, we also run `tsc -p tsconfig.spec.json
//     --noEmit` to check test files (--force is only valid with --build / TS5093).
//
// This script:
//   1. Discovers all packages under packages/plugins/{agent,session,ui}/* and
//      packages/desktop that have a tsconfig.json.
//   2. Runs `npx tsc -b --force` in each (no-bail: collects ALL failures).
//   3. If tsconfig.spec.json exists, runs `npx tsc -p tsconfig.spec.json --noEmit`.
//   4. Collects results, classifies errors (TS5033 env vs semantic), and writes
//      a summary + log to the specified log path.
//   5. Does NOT modify any source files.
//
// Usage:
//   node scripts/run-forced-typecheck.mjs [--log .corum-tmp/stage3-expected-red.log]
//
// Output:
//   - Prints a summary table to stdout (package | status | error count | TS5033 count).
//   - Writes the full tsc output to the log file.
//   - Writes a JSON summary to <log>.json with per-package error identities.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Parse args
const args = process.argv.slice(2);
let logPath = '.corum-tmp/stage3-expected-red.log';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--log' && args[i + 1]) {
    logPath = args[i + 1];
    i++;
  }
}

// Discover packages
const groupDirs = ['agent', 'session', 'ui'];
const packageDirs = [];

for (const group of groupDirs) {
  const groupPath = join(REPO_ROOT, 'packages', 'plugins', group);
  if (!existsSync(groupPath)) continue;
  // List immediate subdirectories
  let entries;
  try {
    entries = execSync(`ls -d ${groupPath}/*/`, { encoding: 'utf8' }).trim().split('\n');
  } catch { continue; }
  for (const dir of entries) {
    const trimmed = dir.replace(/\/$/, '');
    if (existsSync(join(trimmed, 'tsconfig.json'))) {
      packageDirs.push(trimmed);
    }
  }
}

// Add packages/desktop
const desktopDir = join(REPO_ROOT, 'packages', 'desktop');
if (existsSync(join(desktopDir, 'tsconfig.json'))) {
  packageDirs.push(desktopDir);
}

// Ensure log dir
const fullLogPath = resolve(REPO_ROOT, logPath);
mkdirSync(dirname(fullLogPath), { recursive: true });

// Collect results
const results = [];
const allOutput = [];

function runTsc(pkgDir, command, label) {
  const result = spawnSync('npx', command, {
    cwd: pkgDir,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    shell: true,
    env: {
      ...process.env,
      PATH: '/opt/homebrew/bin:' + (process.env.PATH || ''),
      // Increase heap for large packages (corum-tool-subagent OOMs at 4GB default)
      NODE_OPTIONS: '--max-old-space-size=8192',
    },
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const output = stdout + stderr;
  const exitCode = result.status;
  return { output, exitCode, label };
}

function parseErrors(output) {
  const errors = [];
  const ts5033 = [];
  const lines = output.split('\n');
  for (const line of lines) {
    // Match: path(line,col): error TSxxxx: message
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/);
    if (m) {
      const [, file, lineNo, col, severity, code, msg] = m;
      if (severity === 'error') {
        if (code === 'TS5033') {
          ts5033.push({ file, line: lineNo, code, msg });
        } else {
          errors.push({ file, line: lineNo, code, msg });
        }
      }
    }
    // Also match: error TSxxxx: message (no file path, env-level)
    const m2 = line.match(/^error\s+(TS\d+):\s+(.*)$/);
    if (m2 && !m) {
      const [, code, msg] = m2;
      if (code === 'TS5033') {
        ts5033.push({ file: '(env)', line: '0', code, msg });
      } else {
        errors.push({ file: '(env)', line: '0', code, msg });
      }
    }
  }
  return { errors, ts5033 };
}

console.log(`[run-forced-typecheck] Discovered ${packageDirs.length} packages with tsconfig.json`);
console.log(`[run-forced-typecheck] Log: ${logPath}\n`);

for (const pkgDir of packageDirs) {
  const pkgName = pkgDir.replace(REPO_ROOT + '/', '');
  const pkgJsonPath = join(pkgDir, 'package.json');
  let pkgLabel = pkgName;
  if (existsSync(pkgJsonPath)) {
    try {
      const pj = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      pkgLabel = pj.name || pkgName;
    } catch {}
  }

  allOutput.push(`\n${'='.repeat(80)}`);
  allOutput.push(`Package: ${pkgLabel} (${pkgName})`);
  allOutput.push(`${'='.repeat(80)}\n`);

  // Step 1: tsc -b --force
  const mainResult = runTsc(pkgDir, ['tsc', '-b', '--force'], 'main');
  allOutput.push(`[tsc -b --force] exit=${mainResult.exitCode}`);
  allOutput.push(mainResult.output);
  if (mainResult.output.trim()) allOutput.push('');

  const mainParsed = parseErrors(mainResult.output);

  // Step 2: tsc -p tsconfig.spec.json --noEmit (if exists)
  // Note: --force is only valid with --build (TS5093); tsconfig.spec.json uses
  // composite:false + incremental:false so there's nothing to force-flush.
  let specResult = null;
  let specParsed = { errors: [], ts5033: [] };
  const specPath = join(pkgDir, 'tsconfig.spec.json');
  if (existsSync(specPath)) {
    specResult = runTsc(pkgDir, ['tsc', '-p', 'tsconfig.spec.json', '--noEmit'], 'spec');
    allOutput.push(`[tsc -p tsconfig.spec.json --noEmit] exit=${specResult.exitCode}`);
    allOutput.push(specResult.output);
    if (specResult.output.trim()) allOutput.push('');
    specParsed = parseErrors(specResult.output);
  }

  const totalErrors = mainParsed.errors.length + specParsed.errors.length;
  const total5033 = mainParsed.ts5033.length + specParsed.ts5033.length;
  const pass = mainResult.exitCode === 0 && (!specResult || specResult.exitCode === 0);

  results.push({
    package: pkgLabel,
    path: pkgName,
    status: pass ? 'PASS' : 'FAIL',
    semanticErrors: totalErrors,
    ts5033Errors: total5033,
    mainExit: mainResult.exitCode,
    specExit: specResult ? specResult.exitCode : null,
    mainErrors: mainParsed.errors,
    specErrors: specParsed.errors,
    main5033: mainParsed.ts5033,
    spec5033: specParsed.ts5033,
  });

  const statusIcon = pass ? '✓' : '✗';
  const errStr = totalErrors > 0 ? ` ${totalErrors} errors` : '';
  const ts5033Str = total5033 > 0 ? ` ${total5033} TS5033` : '';
  console.log(`${statusIcon} ${pkgLabel.padEnd(45)} ${errStr}${ts5033Str}`);
}

// Summary
const failPkgs = results.filter(r => r.status === 'FAIL');
const passPkgs = results.filter(r => r.status === 'PASS');
const totalSemantic = results.reduce((s, r) => s + r.semanticErrors, 0);
const total5033 = results.reduce((s, r) => s + r.ts5033Errors, 0);

const summary = [
  `\n${'='.repeat(80)}`,
  `SUMMARY`,
  `${'='.repeat(80)}`,
  `Total packages:    ${results.length}`,
  `PASS:              ${passPkgs.length}`,
  `FAIL:              ${failPkgs.length}`,
  `Semantic errors:   ${totalSemantic}`,
  `TS5033 env errors: ${total5033}`,
  ``,
  `Failed packages:`,
];

for (const r of failPkgs) {
  summary.push(`  ${r.package} (${r.path})`);
  summary.push(`    main: exit=${r.mainExit}, ${r.mainErrors.length} semantic, ${r.main5033.length} TS5033`);
  if (r.specExit !== null) {
    summary.push(`    spec: exit=${r.specExit}, ${r.specErrors.length} semantic, ${r.spec5033.length} TS5033`);
  }
  // Show error identities (code + file:line)
  const allErrs = [...r.mainErrors, ...r.specErrors];
  for (const e of allErrs.slice(0, 20)) {
    summary.push(`    ${e.code} ${e.file}:${e.line} — ${e.msg.slice(0, 80)}`);
  }
  if (allErrs.length > 20) summary.push(`    ... and ${allErrs.length - 20} more`);
  const all5033 = [...r.main5033, ...r.spec5033];
  for (const e of all5033.slice(0, 5)) {
    summary.push(`    TS5033 ${e.file}:${e.line} — ${e.msg.slice(0, 80)}`);
  }
  if (all5033.length > 5) summary.push(`    ... and ${all5033.length - 5} more TS5033`);
}

allOutput.push(...summary);

// Write log
writeFileSync(fullLogPath, allOutput.join('\n'));

// Write JSON summary
const jsonSummary = {
  timestamp: new Date().toISOString(),
  totalPackages: results.length,
  passCount: passPkgs.length,
  failCount: failPkgs.length,
  totalSemanticErrors: totalSemantic,
  totalTs5033: total5033,
  failedPackages: failPkgs.map(r => ({
    package: r.package,
    path: r.path,
    semanticErrors: r.semanticErrors,
    ts5033Errors: r.ts5033Errors,
    mainExit: r.mainExit,
    specExit: r.specExit,
    mainErrors: r.mainErrors.map(e => ({ code: e.code, file: e.file, line: e.line, msg: e.msg })),
    specErrors: r.specErrors.map(e => ({ code: e.code, file: e.file, line: e.line, msg: e.msg })),
    main5033: r.main5033.map(e => ({ code: e.code, file: e.file, line: e.line, msg: e.msg })),
    spec5033: r.spec5033.map(e => ({ code: e.code, file: e.file, line: e.line, msg: e.msg })),
  })),
  passedPackages: passPkgs.map(r => r.package),
};
writeFileSync(fullLogPath + '.json', JSON.stringify(jsonSummary, null, 2));

console.log(`\n${'='.repeat(80)}`);
console.log(`SUMMARY: ${passPkgs.length}/${results.length} PASS, ${failPkgs.length} FAIL, ${totalSemantic} semantic errors, ${total5033} TS5033`);
console.log(`Log: ${logPath}`);
console.log(`JSON: ${logPath}.json`);
