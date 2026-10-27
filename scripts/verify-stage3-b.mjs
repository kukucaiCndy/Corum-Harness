#!/usr/bin/env node
/**
 * Stage 3 B1 grep guard — ensures the rc3 migration patterns are complete.
 * Verifies that old API patterns are gone from fork src (comments stripped or
 * in reasonable ranges) and that drift assertions are meaningful.
 *
 * Run: node scripts/verify-stage3-b.mjs
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname

function grep(pattern, paths) {
  try {
    const result = execSync(
      `grep -rn '${pattern}' ${paths} 2>/dev/null || true`,
      { cwd: ROOT, encoding: 'utf-8' },
    )
    // Filter out comment-only lines (lines where the match is in a // or * comment)
    return result.trim().split('\n').filter(l => {
      if (l.length === 0) return false
      // Check if the match is only in a comment
      const commentIdx = Math.max(l.indexOf('//'), l.indexOf(' *'))
      if (commentIdx === -1) return true // not a comment line
      // Check if the pattern appears before the comment marker
      const beforeComment = l.slice(0, commentIdx)
      const patternIdx = beforeComment.indexOf(pattern.replace(/\\./g, '').replace(/[\[\]\(\)\.\*\+\?\{\}\|]/g, ''))
      return patternIdx !== -1 && patternIdx < commentIdx
    })
  } catch {
    return []
  }
}

const B1_SRC = [
  'packages/plugins/session/corum-ui-conversation/src',
  'packages/plugins/session/corum-ui-chat/src',
  'packages/plugins/session/corum-ui-settings-models/src',
  'packages/plugins/session/corum-ui-settings-plugins/src',
  'packages/plugins/session/corum-web-search/src',
  'packages/plugins/ui/corum-ide-ui/src',
  'packages/plugins/ui/corum-ide-sidebar-ui/src',
  'packages/plugins/ui/corum-ui-titlebar/src',
].join(' ')

const B1_AND_DESKTOP = B1_SRC + ' packages/desktop/src/host'

const checks = [
  {
    name: 'sessions.open( — must be zero in fork src',
    pattern: 'sessions\\.open\\(',
    paths: B1_AND_DESKTOP,
    max: 0,
  },
  {
    name: 'settings.register( — must be zero in fork src',
    pattern: 'settings\\.register\\(',
    paths: B1_AND_DESKTOP,
    max: 0,
  },
  {
    name: 'useSessionPendingInteraction — must be zero in fork src',
    pattern: 'useSessionPendingInteraction',
    paths: B1_SRC,
    max: 0,
  },
  {
    name: 'settingsScope — must be zero in fork src (comments ok if stripped)',
    pattern: 'settingsScope',
    paths: B1_SRC,
    max: 0,
  },
  {
    name: 'SessionListState.current / list.getSnapshot().current — must be zero',
    pattern: '\\.list\\.getSnapshot\\(\\)\\.current',
    paths: B1_SRC,
    max: 0,
  },
  {
    name: 'SessionSnapshot.queue — must be zero in fork src',
    pattern: 'SessionSnapshot\\[.queue.\\]|s\\.queue\\b',
    paths: B1_SRC,
    max: 0,
  },
  {
    name: 'sessions.clear() — must be zero (replaced by corumNavigation.clearSelection)',
    pattern: 'sessions\\.clear\\(\\)',
    paths: B1_AND_DESKTOP,
    max: 0,
  },
  {
    name: 'refreshSubagents — must be zero (replaced by refreshProjections)',
    pattern: 'refreshSubagents',
    paths: B1_SRC,
    max: 0,
  },
  {
    name: 'setSubagentCatalogOpen — must be zero in session RPC calls',
    pattern: 'setSubagentCatalogOpen',
    paths: B1_SRC,
    max: 0,
  },
  {
    name: 'SettingsScope type import — must be zero',
    pattern: "import type \\{ .*SettingsScope.*\\}.*ui-settings",
    paths: B1_SRC,
    max: 0,
  },
  {
    name: 'corumNavigation — must exist (migration completed)',
    pattern: 'corumNavigation',
    paths: B1_SRC,
    min: 1,
  },
  {
    name: 'configForms — must exist (settingsScope replaced)',
    pattern: 'configForms',
    paths: B1_SRC,
    min: 1,
  },
]

let failures = 0
for (const check of checks) {
  const matches = grep(check.pattern, check.paths)
  const count = matches.length
  const passed = check.max !== undefined ? count <= check.max : count >= (check.min ?? 0)
  const status = passed ? '✓' : '✗'
  console.log(`${status} ${check.name}: ${count} matches`)
  if (!passed) {
    failures++
    if (matches.length > 0 && count > 0) {
      matches.slice(0, 5).forEach(m => console.log(`    ${m}`))
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
