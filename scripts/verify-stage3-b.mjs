#!/usr/bin/env node
/**
 * Stage 3 B1 guard — ensures the rc3 migration patterns are complete.
 * Verifies that old API patterns are gone from fork src (comments stripped or
 * in reasonable ranges) and that drift assertions are meaningful.
 *
 * Uses Node recursive file traversal + JS RegExp (NOT shell grep — BSD grep
 * misinterprets `\(` as a group opener and exits 2, which `2>/dev/null || true`
 * silently swallows into a false-green).
 *
 * Run: node scripts/verify-stage3-b.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

/**
 * Recursively collect source files under a directory, filtering by extension
 * and excluding generated/build artifacts.
 */
function collectSourceFiles(dir) {
  if (!existsSync(dir)) {
    throw new Error(`verify-stage3-b: source directory does not exist: ${dir}`)
  }
  const results = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current)
    } catch (error) {
      throw new Error(`verify-stage3-b: cannot read directory ${current}: ${String(error)}`)
    }
    for (const entry of entries) {
      const full = join(current, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'lib' || entry === 'dist' || entry === '.corum-tmp') continue
        stack.push(full)
      } else if (stat.isFile()) {
        const ext = extname(entry)
        if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.mjs') {
          results.push(full)
        }
      }
    }
  }
  return results
}

/**
 * Strip comments from source text to avoid false positives from documentation.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

/**
 * Search for a RegExp pattern across all source files in the given directories.
 */
function searchPattern(pattern, dirs) {
  const regex = new RegExp(pattern)
  const matches = []
  for (const dir of dirs) {
    let files
    try {
      files = collectSourceFiles(dir)
    } catch (error) {
      console.error(String(error))
      throw error
    }
    for (const file of files) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const stripped = stripComments(text)
      const lines = stripped.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const rel = relative(ROOT, file)
          matches.push({ file: rel, line: i + 1, text: lines[i].trim() })
        }
      }
    }
  }
  return matches
}

const B1_DIRS = [
  'packages/plugins/session/corum-ui-conversation/src',
  'packages/plugins/session/corum-ui-chat/src',
  'packages/plugins/session/corum-ui-settings-models/src',
  'packages/plugins/session/corum-ui-settings-plugins/src',
  'packages/plugins/agent/corum-web-search/src',
  'packages/plugins/ui/corum-ide-ui/src',
  'packages/plugins/ui/corum-ide-sidebar-ui/src',
  'packages/plugins/ui/corum-ui-titlebar/src',
].map(d => join(ROOT, d))

const B1_AND_DESKTOP_DIRS = [...B1_DIRS, join(ROOT, 'packages/desktop/src/host')]

const checks = [
  {
    name: 'sessions.open( — must be zero in fork src',
    pattern: 'sessions\\.open\\(',
    dirs: B1_AND_DESKTOP_DIRS,
    max: 0,
  },
  {
    name: 'settings.register( — must be zero in fork src',
    pattern: 'settings\\.register\\(',
    dirs: B1_AND_DESKTOP_DIRS,
    max: 0,
  },
  {
    name: 'useSessionPendingInteraction — must be zero in fork src',
    pattern: 'useSessionPendingInteraction',
    dirs: B1_DIRS,
    max: 0,
  },
  {
    name: 'settingsScope — must be zero in fork src (comments ok if stripped)',
    pattern: 'settingsScope',
    dirs: B1_DIRS,
    max: 0,
  },
  {
    name: 'SessionListState.current / list.getSnapshot().current — must be zero',
    pattern: '\\.list\\.getSnapshot\\(\\)\\.current',
    dirs: B1_DIRS,
    max: 0,
  },
  {
    name: 'SessionSnapshot.queue — must be zero in fork src',
    pattern: 'SessionSnapshot\\[.queue.\\]|\\bs\\.queue\\b',
    dirs: B1_DIRS,
    max: 0,
  },
  {
    name: 'sessions.clear() — must be zero (replaced by corumNavigation.clearSelection)',
    pattern: 'sessions\\.clear\\(\\)',
    dirs: B1_AND_DESKTOP_DIRS,
    max: 0,
  },
  {
    name: 'refreshSubagents — must be zero (replaced by refreshProjections)',
    pattern: 'refreshSubagents',
    dirs: B1_DIRS,
    max: 0,
  },
  {
    name: 'setSubagentCatalogOpen — must be zero in session RPC calls',
    pattern: 'setSubagentCatalogOpen',
    dirs: B1_DIRS,
    max: 0,
  },
  {
    name: 'SettingsScope type import — must be zero',
    pattern: "import type \\{ .*SettingsScope.*\\}.*ui-settings",
    dirs: B1_DIRS,
    max: 0,
  },
  {
    name: 'corumNavigation — must exist (migration completed)',
    pattern: 'corumNavigation',
    dirs: B1_DIRS,
    min: 1,
  },
  {
    name: 'configForms — must exist (settingsScope replaced)',
    pattern: 'configForms',
    dirs: B1_DIRS,
    min: 1,
  },
]

let failures = 0
for (const check of checks) {
  let matches
  try {
    matches = searchPattern(check.pattern, check.dirs)
  } catch {
    failures++
    console.log(`✗ ${check.name}: ERROR (source directory missing)`)
    continue
  }
  const count = matches.length
  const passed = check.max !== undefined ? count <= check.max : count >= (check.min ?? 0)
  const status = passed ? '✓' : '✗'
  console.log(`${status} ${check.name}: ${count} matches`)
  if (!passed) {
    failures++
    if (matches.length > 0 && count > 0) {
      matches.slice(0, 5).forEach(m => console.log(`    ${m.file}:${m.line}: ${m.text}`))
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
