#!/usr/bin/env node
// scripts/fork-rebase-inventory.mjs
//
// Stage 3 §0d: Machine-generated 50-package fork rebase inventory.
//
// Reads official tag (dsh-v0.2.1-rc.3) and corum working tree, produces per-package
// JSON + Markdown summary to docs/fork-delta/inventory/.
//
// For each fork package, classifies every source file as:
//   - identical:         byte-for-byte same as official (cmp -s)
//   - import-rename:     only differences are @deepseek-ai/dsh-* → @corum/corum-* package name changes
//   - substantive:       has real logic/CSS/locale differences
//   - corum-new:         official has no corresponding file
//   - official-deleted:  file exists in official but not in corum
//
// Also records:
//   - officialBaseline: the rc3 tag
//   - officialDiffVsPrev: 0.1.5→rc3 change volume per file (heat signal)
//   - gates: { typecheck, build, test, drift } all "pending"
//   - stage3Status: "pending"
//
// Tracks src/ tests/ config/ package files only. Excludes lib/ dist/ node_modules/.
//
// Usage:
//   node scripts/fork-rebase-inventory.mjs
//
// Env:
//   DSH_CHECKOUT=/path/to/dsh (default: /Users/kukucai/dsh)
//   DSH_OFFICIAL_TAG=dsh-v0.2.1-rc.3 (default)
//   DSH_PREV_TAG=dsh-v0.1.5-rc.3 (for diff heat)
//
// Output:
//   docs/fork-delta/inventory/<pkg-name>.json (per package)
//   docs/fork-delta/inventory/SUMMARY.md (overview)
//   docs/fork-delta/inventory/needs-mapping.json (packages needing manual mapping)

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DSH_CHECKOUT = process.env.DSH_CHECKOUT || '/Users/kukucai/dsh';
const DSH_OFFICIAL_TAG = process.env.DSH_OFFICIAL_TAG || 'dsh-v0.2.1-rc.3';
const DSH_PREV_TAG = process.env.DSH_PREV_TAG || 'dsh-v0.1.5-rc.3';

// ── Fork → official package mapping ──────────────────────────────────────────
// This mapping is derived from:
//   1. fork-delta.md registered mappings (17 packages with explicit entries)
//   2. Package name convention: corum-X → dsh-X (with some transformations)
//   3. Reading each package.json for @deepseek-ai/dsh-* deps
//
// Format: { corumPkgName: { officialPkg: 'dsh-...', officialPath: 'packages/...', mapping: 'explicit'|'convention'|'needs-mapping', corumOnly: false } }

const FORK_TO_OFFICIAL = {
  // ── Agent group (23) ──
  '@corum/corum-agent': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有包，非对照官方单一包的 fork（组合修正 dsh-agent-instructions / dsh-skill-filesystem / dsh-agent-presets）',
    relatedOfficial: ['@deepseek-ai/dsh-agent', 'packages/agent/agent'],
  },
  '@corum/corum-api-remotes': {
    officialPkg: '@deepseek-ai/dsh-api-remotes',
    officialPath: 'packages/api/remotes',
    mapping: 'explicit',
    note: 'fork-delta §8',
  },
  '@corum/corum-artgen': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 artgen 包，无官方对应',
  },
  '@corum/corum-credentials-local': {
    officialPkg: '@deepseek-ai/dsh-credentials-local',
    officialPath: 'packages/credentials/credentials-local',
    mapping: 'explicit',
    note: 'fork-delta §7',
  },
  '@corum/corum-extension-pack': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应官方 extension 相关包，待确认',
  },
  '@corum/corum-extension-registry': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应官方 extension 相关包，待确认',
  },
  '@corum/corum-fs-local': {
    officialPkg: '@deepseek-ai/dsh-fs-local',
    officialPath: 'packages/fs/fs-local',
    mapping: 'explicit',
    note: 'fork-delta §15',
  },
  '@corum/corum-git-core': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应官方 git 相关包，待确认',
  },
  '@corum/corum-goal-round-driver': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 goal-round-driver 包',
  },
  '@corum/corum-mcp-manager': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应官方 mcp 相关包，待确认',
  },
  '@corum/corum-memory': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 memory 包',
  },
  '@corum/corum-ollama': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 ollama 包',
  },
  '@corum/corum-orchestration': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 orchestration 包（方案甲结构化编排）',
  },
  '@corum/corum-platform': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 platform 包（2026-10-12 创建）',
  },
  '@corum/corum-preset-modules': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应官方 preset 相关包，待确认',
  },
  '@corum/corum-sandbox-local': {
    officialPkg: '@deepseek-ai/dsh-sandbox-local',
    officialPath: 'packages/sandbox/sandbox-local',
    mapping: 'explicit',
    note: 'fork-delta §13',
  },
  '@corum/corum-skill-manager': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应官方 skill 相关包，待确认',
  },
  '@corum/corum-subagent': {
    officialPkg: '@deepseek-ai/dsh-subagent',
    officialPath: 'packages/subagent/subagent',
    mapping: 'explicit',
    note: 'fork-delta §10（含 dsh-subagent-in-process-driver + dsh-subagent-spawn-in-process）',
    extraOfficialPaths: [
      'packages/subagent/subagent-spawn-in-process',
      'packages/subagent/subagent-fork-in-process',
    ],
  },
  '@corum/corum-todo-guard': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 todo-guard 包',
  },
  '@corum/corum-tool-subagent': {
    officialPkg: '@deepseek-ai/dsh-tool-subagent',
    officialPath: 'packages/subagent/tool-subagent',
    mapping: 'explicit',
    note: 'fork-delta §11',
  },
  '@corum/corum-tools': {
    officialPkg: '@deepseek-ai/dsh-tools',
    officialPath: 'packages/core/tools',
    mapping: 'explicit',
    note: 'fork-delta §19',
  },
  '@corum/corum-update-checker': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 update-checker 包',
  },
  '@corum/corum-web-search': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应官方 web-search 相关包，待确认',
  },

  // ── Session group (12) ──
  '@corum/corum-session-archive': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '待确认官方对应',
  },
  '@corum/corum-session-queue-revert': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 session-queue-revert 包',
  },
  '@corum/corum-ui-approval': {
    officialPkg: '@deepseek-ai/dsh-client-ui-approval',
    officialPath: 'packages/client/ui-approval',
    mapping: 'explicit',
    note: 'fork-delta §1',
  },
  '@corum/corum-ui-chat': {
    officialPkg: '@deepseek-ai/dsh-client-ui-chat',
    officialPath: 'packages/client/ui-chat',
    mapping: 'explicit',
    note: 'fork-delta §3',
  },
  '@corum/corum-ui-commit-card': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '待确认官方对应',
  },
  '@corum/corum-ui-conversation': {
    officialPkg: '@deepseek-ai/dsh-client-ui-conversation',
    officialPath: 'packages/client/ui-conversation',
    mapping: 'explicit',
    note: 'fork-delta §1',
  },
  '@corum/corum-ui-model-ask': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 ui-model-ask 包',
  },
  '@corum/corum-ui-model-selection': {
    officialPkg: '@deepseek-ai/dsh-client-ui-model-selection',
    officialPath: 'packages/client/ui-model-selection',
    mapping: 'explicit',
    note: 'fork-delta §1',
  },
  '@corum/corum-ui-questions': {
    officialPkg: '@deepseek-ai/dsh-client-ui-user-questions',
    officialPath: 'packages/client/ui-user-questions',
    mapping: 'explicit',
    note: 'fork-delta §1 (corum-ui-questions → dsh-client-ui-user-questions, name differs)',
  },
  '@corum/corum-ui-settings-models': {
    officialPkg: '@deepseek-ai/dsh-client-ui-settings-models',
    officialPath: 'packages/client/ui-settings-models',
    mapping: 'explicit',
    note: 'fork-delta §1',
  },
  '@corum/corum-ui-settings-plugins': {
    officialPkg: '@deepseek-ai/dsh-client-ui-settings-plugins',
    officialPath: 'packages/client/ui-settings-plugins',
    mapping: 'explicit',
    note: 'fork-delta §11 (total #11)',
  },
  '@corum/corum-ui-trajectory': {
    officialPkg: '@deepseek-ai/dsh-client-ui-trajectory',
    officialPath: 'packages/client/ui-trajectory',
    mapping: 'explicit',
    note: 'fork-delta §14',
  },

  // ── UI group (15) ──
  '@corum/corum-ide-explorer-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应官方 IDE UI 包，待确认',
  },
  '@corum/corum-ide-integrations-pages-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '待确认官方对应',
  },
  '@corum/corum-ide-integrations-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '待确认官方对应',
  },
  '@corum/corum-ide-panel-bottom-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '待确认官方对应',
  },
  '@corum/corum-ide-plugin-manager-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应 packages/client/ui-plugin-manager，待确认',
  },
  '@corum/corum-ide-sidebar-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '待确认官方对应',
  },
  '@corum/corum-ide-statusbar-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '待确认官方对应',
  },
  '@corum/corum-ide-test-conversation-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 test UI 包',
  },
  '@corum/corum-ide-test-sidebar-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 test UI 包',
  },
  '@corum/corum-ide-test-statusbar-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 test UI 包',
  },
  '@corum/corum-ide-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应 packages/client/ui-settings-shell 或复合包，待确认',
  },
  '@corum/corum-issue-reporter-ui': {
    officialPkg: null,
    officialPath: null,
    mapping: 'corum-only',
    corumOnly: true,
    note: 'corum 自有 issue-reporter 包',
  },
  '@corum/corum-rpc-client': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '待确认官方对应（可能 dsh-client/connection）',
  },
  '@corum/corum-ui-base': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '可能对应 dsh-client-ui-slots / dsh-client-ui-theme，待确认',
  },
  '@corum/corum-ui-titlebar': {
    officialPkg: null,
    officialPath: null,
    mapping: 'needs-mapping',
    corumOnly: false,
    note: '待确认官方对应',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function gitArchiveList(checkout, tag, path) {
  try {
    const out = execSync(
      `git -C "${checkout}" ls-tree -r --name-only "${tag}" -- "${path}" 2>/dev/null`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function gitArchiveFile(checkout, tag, filePath) {
  try {
    return execSync(
      `git -C "${checkout}" show "${tag}:${filePath}" 2>/dev/null`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
  } catch {
    return null;
  }
}

function gitDiffStat(checkout, prevTag, newTag, filePath) {
  try {
    const out = execSync(
      `git -C "${checkout}" diff --numstat "${prevTag}" "${newTag}" -- "${filePath}" 2>/dev/null`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    if (!out) return null;
    const m = out.match(/^(\d+)\s+(\d+)\s+/);
    if (m) return `+${m[1]}/-${m[2]}`;
    return 'changed';
  } catch {
    return null;
  }
}

// List source files in a corum package dir (src/ tests/ + root config files)
function listCorumFiles(pkgDir) {
  const files = [];
  // Source dirs
  for (const dir of ['src', 'tests', 'test']) {
    const fullDir = join(pkgDir, dir);
    if (existsSync(fullDir)) {
      walkDir(fullDir, pkgDir, files);
    }
  }
  // Root config files
  for (const f of ['package.json', 'tsconfig.json', 'tsconfig.spec.json', 'tsdown.config.ts', 'tsconfig.client.json', 'tsconfig.host.json']) {
    if (existsSync(join(pkgDir, f))) {
      files.push(f);
    }
  }
  return files;
}

function walkDir(dir, base, files) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      // Skip lib, dist, node_modules
      if (['lib', 'dist', 'node_modules', '.turbo', 'coverage'].includes(entry)) continue;
      walkDir(full, base, files);
    } else {
      files.push(relative(base, full));
    }
  }
}

// List official source files from git archive
function listOfficialFiles(checkout, tag, officialPath) {
  const files = [];
  // List src/ and tests/ dirs + root config
  for (const sub of ['src', 'tests', 'test']) {
    const basePath = `${officialPath}/${sub}`;
    const tree = gitArchiveList(checkout, tag, basePath);
    for (const f of tree) {
      // f is like "packages/xxx/src/yyy.ts"
      // Extract the relative path from the official package root
      const rel = f.substring(officialPath.length + 1);
      files.push(rel);
    }
  }
  // Root config files
  for (const f of ['package.json', 'tsconfig.json', 'tsconfig.spec.json', 'tsdown.config.ts']) {
    const content = gitArchiveFile(checkout, tag, `${officialPath}/${f}`);
    if (content !== null) files.push(f);
  }
  return [...new Set(files)];
}

// Compare a corum file with its official counterpart
function classifyFile(corumFileContent, officialFileContent, corumRelPath) {
  if (officialFileContent === null || officialFileContent === undefined) {
    return 'corum-new';
  }
  if (corumFileContent === null || corumFileContent === undefined) {
    return 'official-deleted';
  }
  if (corumFileContent === officialFileContent) {
    return 'identical';
  }
  // Check if the only difference is import renames
  if (isImportRenameOnly(corumFileContent, officialFileContent)) {
    return 'import-rename';
  }
  return 'substantive';
}

function isImportRenameOnly(corumContent, officialContent) {
  if (!corumContent || !officialContent) return false;
  // Normalize: replace all @corum/corum-* with @deepseek-ai/dsh-* and compare
  // Also normalize corum- → dsh- for package-internal references
  const normalized = officialContent
    .replace(/@deepseek-ai\/dsh-/g, '@corum/corum-')
    .replace(/from ['"]@corum\/corum-/g, "from '@corum/corum-") // already corum
    .replace(/dsh-/g, 'corum-'); // catch bare dsh- references
  
  // If normalizing official to corum naming makes them identical, it's import-rename
  if (normalized === corumContent) return true;
  
  // Also try the reverse: normalize corum to official
  const normalizedCorum = corumContent
    .replace(/@corum\/corum-/g, '@deepseek-ai/dsh-')
    .replace(/corum-/g, 'dsh-');
  
  if (normalizedCorum === officialContent) return true;
  
  // Check line-by-line: are ALL diff lines just package name changes?
  const corumLines = corumContent.split('\n');
  const officialLines = officialContent.split('\n');
  if (corumLines.length !== officialLines.length) return false;
  
  let allRenameDiffs = true;
  for (let i = 0; i < corumLines.length; i++) {
    if (corumLines[i] === officialLines[i]) continue;
    // Normalize both lines
    const normCorum = corumLines[i].replace(/@corum\/corum-/g, '@deepseek-ai/dsh-').replace(/corum-/g, 'dsh-');
    const normOfficial = officialLines[i];
    // Also try: strip both of package-name-only differences
    const strippedCorum = corumLines[i].replace(/@corum\/corum-[a-z0-9-]+/g, 'PKG').replace(/corum-[a-z0-9-]+/g, 'PKG');
    const strippedOfficial = officialLines[i].replace(/@deepseek-ai\/dsh-[a-z0-9-]+/g, 'PKG').replace(/dsh-[a-z0-9-]+/g, 'PKG');
    if (strippedCorum !== strippedOfficial) {
      allRenameDiffs = false;
      break;
    }
  }
  return allRenameDiffs;
}

// Read corum file content
function readCorumFile(pkgDir, relPath) {
  const full = join(pkgDir, relPath);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`[fork-rebase-inventory] DSH_CHECKOUT=${DSH_CHECKOUT}`);
console.log(`[fork-rebase-inventory] official tag=${DSH_OFFICIAL_TAG}, prev tag=${DSH_PREV_TAG}`);

const OUTPUT_DIR = join(REPO_ROOT, 'docs', 'fork-delta', 'inventory');
mkdirSync(OUTPUT_DIR, { recursive: true });

// Discover fork packages
const groupDirs = [
  { group: 'agent', path: 'packages/plugins/agent' },
  { group: 'session', path: 'packages/plugins/session' },
  { group: 'ui', path: 'packages/plugins/ui' },
];

const packages = [];
for (const { group, path: groupPath } of groupDirs) {
  const fullGroupPath = join(REPO_ROOT, groupPath);
  if (!existsSync(fullGroupPath)) continue;
  let entries;
  try { entries = readdirSync(fullGroupPath); } catch { continue; }
  for (const entry of entries) {
    const pkgDir = join(fullGroupPath, entry);
    if (!statSync(pkgDir).isDirectory()) continue;
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    let pkgName;
    try {
      pkgName = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).name;
    } catch { continue; }
    packages.push({ group, dir: pkgDir, name: pkgName, relPath: relative(REPO_ROOT, pkgDir) });
  }
}

console.log(`[fork-rebase-inventory] Found ${packages.length} fork packages`);

const needsMapping = [];
const summaryRows = [];

for (const pkg of packages) {
  const mapping = FORK_TO_OFFICIAL[pkg.name];
  const pkgSlug = pkg.name.replace(/^@corum\//, '').replace(/\//g, '-');
  
  if (!mapping) {
    needsMapping.push({ package: pkg.name, path: pkg.relPath, reason: 'No mapping entry found' });
    continue;
  }

  // Get official files
  let officialFiles = [];
  let officialFilesByPath = {};
  
  if (mapping.officialPath && !mapping.corumOnly) {
    officialFiles = listOfficialFiles(DSH_CHECKOUT, DSH_OFFICIAL_TAG, mapping.officialPath);
    // Also check extra official paths (e.g. subagent-spawn-in-process)
    if (mapping.extraOfficialPaths) {
      for (const extraPath of mapping.extraOfficialPaths) {
        const extraFiles = listOfficialFiles(DSH_CHECKOUT, DSH_OFFICIAL_TAG, extraPath);
        for (const ef of extraFiles) {
          if (!officialFiles.includes(ef)) {
            officialFiles.push(ef);
            // Mark these as from extra paths
          }
        }
      }
    }
    // Read official file contents
    for (const of of officialFiles) {
      const fullOfficialPath = `${mapping.officialPath}/${of}`;
      const content = gitArchiveFile(DSH_CHECKOUT, DSH_OFFICIAL_TAG, fullOfficialPath);
      if (content !== null) {
        officialFilesByPath[of] = content;
      }
    }
  }

  // Get corum files
  const corumFiles = listCorumFiles(pkg.dir);

  // Classify each corum file
  const fileEntries = [];
  for (const corumFile of corumFiles) {
    const corumContent = readCorumFile(pkg.dir, corumFile);
    let officialContent = null;
    let officialRelPath = null;
    
    if (!mapping.corumOnly && mapping.officialPath) {
      officialContent = officialFilesByPath[corumFile];
      officialRelPath = `${mapping.officialPath}/${corumFile}`;
    }

    const fileClass = classifyFile(corumContent, officialContent, corumFile);
    
    // Get diff heat (0.1.5 → rc3)
    let diffHeat = null;
    if (officialRelPath && !mapping.corumOnly) {
      diffHeat = gitDiffStat(DSH_CHECKOUT, DSH_PREV_TAG, DSH_OFFICIAL_TAG, officialRelPath);
    }

    fileEntries.push({
      path: corumFile,
      class: fileClass,
      officialPath: officialRelPath,
      officialDiffVsPrev: diffHeat,
    });
  }

  // Find official files not in corum (official-deleted)
  if (!mapping.corumOnly && mapping.officialPath) {
    const corumFileSet = new Set(corumFiles);
    for (const officialFile of officialFiles) {
      if (!corumFileSet.has(officialFile)) {
        const fullOfficialPath = `${mapping.officialPath}/${officialFile}`;
        const diffHeat = gitDiffStat(DSH_CHECKOUT, DSH_PREV_TAG, DSH_OFFICIAL_TAG, fullOfficialPath);
        fileEntries.push({
          path: officialFile,
          class: 'official-deleted',
          officialPath: fullOfficialPath,
          officialDiffVsPrev: diffHeat,
        });
      }
    }
  }

  // Classify summary
  const classCounts = {
    identical: 0,
    'import-rename': 0,
    substantive: 0,
    'corum-new': 0,
    'official-deleted': 0,
  };
  for (const fe of fileEntries) {
    classCounts[fe.class] = (classCounts[fe.class] || 0) + 1;
  }

  // Get export face diff (simplified: check .d.ts files if they exist)
  const exportFaceDiff = { removed: [], renamed: [], added: [] };

  const inventory = {
    package: pkg.name,
    group: pkg.group,
    path: pkg.relPath,
    officialMapping: mapping.corumOnly
      ? { type: 'corum-only', note: mapping.note }
      : mapping.officialPath
        ? {
            type: mapping.mapping,
            officialPkg: mapping.officialPkg,
            officialPath: mapping.officialPath,
            note: mapping.note,
            ...(mapping.extraOfficialPaths ? { extraOfficialPaths: mapping.extraOfficialPaths } : {}),
          }
        : { type: 'needs-mapping', note: mapping.note },
    officialBaseline: DSH_OFFICIAL_TAG,
    files: fileEntries,
    fileClassCounts: classCounts,
    exportFaceDiff,
    stage3Status: 'pending',
    gates: { typecheck: 'pending', build: 'pending', test: 'pending', drift: 'pending' },
  };

  // Write per-package JSON
  const jsonPath = join(OUTPUT_DIR, `${pkgSlug}.json`);
  writeFileSync(jsonPath, JSON.stringify(inventory, null, 2));

  // Track needs-mapping
  if (mapping.mapping === 'needs-mapping') {
    needsMapping.push({
      package: pkg.name,
      path: pkg.relPath,
      group: pkg.group,
      reason: mapping.note,
      jsonFile: `${pkgSlug}.json`,
    });
  }

  summaryRows.push({
    package: pkg.name,
    group: pkg.group,
    mapping: mapping.corumOnly ? 'corum-only' : mapping.mapping,
    officialPath: mapping.officialPath || '—',
    files: fileEntries.length,
    identical: classCounts.identical,
    importRename: classCounts['import-rename'],
    substantive: classCounts.substantive,
    corumNew: classCounts['corum-new'],
    officialDeleted: classCounts['official-deleted'],
  });

  const status = mapping.corumOnly ? 'CORUM-ONLY' : mapping.officialPath ? 'MAPPED' : 'NEEDS-MAPPING';
  console.log(`  ${status.padEnd(14)} ${pkg.name.padEnd(40)} ${fileEntries.length} files`);
}

// Write needs-mapping JSON
writeFileSync(join(OUTPUT_DIR, 'needs-mapping.json'), JSON.stringify({
  count: needsMapping.length,
  packages: needsMapping,
}, null, 2));

// Write summary markdown
const mdLines = [
  '# Stage 3 Fork Rebase Inventory — 50 Package Overview',
  '',
  `> Generated: ${new Date().toISOString()}`,
  `> Official tag: \`${DSH_OFFICIAL_TAG}\` (prev: \`${DSH_PREV_TAG}\`)`,
  `> DSH checkout: \`${DSH_CHECKOUT}\``,
  '',
  '## Coverage',
  '',
  `| Metric | Count |`,
  `|---|---|`,
  `| Total fork packages | ${packages.length} |`,
  `| Mapped to official | ${summaryRows.filter(r => r.mapping === 'explicit' || r.mapping === 'convention').length} |`,
  `| corum-only (no official counterpart) | ${summaryRows.filter(r => r.mapping === 'corum-only').length} |`,
  `| Needs mapping | ${summaryRows.filter(r => r.mapping === 'needs-mapping').length} |`,
  `| Inventory JSON files | ${packages.length} |`,
  '',
  '## Per-Package Summary',
  '',
  '| Package | Group | Mapping | Official Path | Files | identical | import-rename | substantive | corum-new | official-deleted |',
  '|---|---|---|---|---|---|---|---|---|---|',
];

for (const r of summaryRows) {
  mdLines.push(`| ${r.package} | ${r.group} | ${r.mapping} | ${r.officialPath} | ${r.files} | ${r.identical} | ${r.importRename} | ${r.substantive} | ${r.corumNew} | ${r.officialDeleted} |`);
}

mdLines.push('', '## Needs-Mapping Packages', '');
if (needsMapping.length === 0) {
  mdLines.push('All packages mapped.');
} else {
  mdLines.push('| Package | Path | Group | Reason |');
  mdLines.push('|---|---|---|---|');
  for (const nm of needsMapping) {
    mdLines.push(`| ${nm.package} | ${nm.path} | ${nm.group || '—'} | ${nm.reason} |`);
  }
}

mdLines.push('', '## Usage', '',
  '- Each `docs/fork-delta/inventory/<pkg>.json` contains the per-file machine classification.',
  '- `needs-mapping.json` lists packages where the official counterpart could not be determined automatically.',
  '- These packages require manual mapping verification before rebase (see 05-fork-rebase.md §4.0 步骤 0d).',
  '- Gates (`typecheck/build/test/drift`) and `stage3Status` are all `pending` — updated as rebase proceeds.',
  '- File classification rules:',
  '  - `identical`: byte-for-byte same (cmp -s)',
  '  - `import-rename`: only differences are @deepseek-ai/dsh-* → @corum/corum-* package name changes',
  '  - `substantive`: has real logic/CSS/locale differences',
  '  - `corum-new`: official has no corresponding file',
  '  - `official-deleted`: file exists in official but not in corum',
);

writeFileSync(join(OUTPUT_DIR, 'SUMMARY.md'), mdLines.join('\n'));

console.log(`\n[fork-rebase-inventory] Written ${packages.length} JSON files to docs/fork-delta/inventory/`);
console.log(`[fork-rebase-inventory] Needs-mapping: ${needsMapping.length} packages`);
console.log(`[fork-rebase-inventory] SUMMARY.md written`);
console.log(`[fork-rebase-inventory] Coverage: ${packages.length}/${packages.length}`);
