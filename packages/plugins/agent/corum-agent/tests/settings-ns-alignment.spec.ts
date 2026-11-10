/**
 * Settings namespace alignment tests.
 *
 * rc3: settings ns = entry id (the plugin entry's `id` field in cordis.patch.yml).
 * This test verifies that every client-side ns constant matches the entry id
 * declared in the patch files (cordis.patch.yml / cordis.ide.patch.yml).
 *
 * It also verifies that the old `settings.register()` pattern is gone from
 * all six ns-owning packages, and that the Config declarations exist where
 * needed (corum-agent, corum-web-search, corum-review registrar).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// packages/plugins/agent/corum-agent/tests/ → repo root (4 levels up)
const REPO_ROOT = join(import.meta.dirname, '../../../../..')
// packages/ directory (3 levels up from tests/)
const PKGS = join(import.meta.dirname, '../../../..')

// ── Helper: read a file relative to packages/ and strip comments ────────────

function readPkg(rel: string): string {
  return readFileSync(join(PKGS, rel), 'utf8')
}

function readPkgStripped(rel: string): string {
  const source = readFileSync(join(PKGS, rel), 'utf8')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

// ── Patch files ─────────────────────────────────────────────────────────────

const DESKTOP_PATCH = readFileSync(join(REPO_ROOT, 'packages/desktop/cordis.patch.yml'), 'utf8')
const IDE_PATCH = readFileSync(join(REPO_ROOT, 'packages/desktop/cordis.ide.patch.yml'), 'utf8')

// ── Tests ───────────────────────────────────────────────────────────────────

describe('settings ns = entry id alignment', () => {
  describe('corum-agent ns', () => {
    it('CORUM_AGENT_SETTINGS_NAMESPACE is "@corum/corum-agent" (combo entry id)', () => {
      const source = readPkg('plugins/agent/corum-agent/src/index.ts')
      expect(source).toMatch(/CORUM_AGENT_SETTINGS_NAMESPACE\s*=\s*'@corum\/corum-agent'/)
    })

    it('exports Config with stallRecoverMinutes volatile', () => {
      const source = readPkg('plugins/agent/corum-agent/src/index.ts')
      expect(source).toMatch(/export const Config/)
      expect(source).toMatch(/stallRecoverMinutes/)
      expect(source).toMatch(/volatile\(\)/)
    })

    it('no settings.register( in corum-agent index', () => {
      const source = readPkgStripped('plugins/agent/corum-agent/src/index.ts')
      expect(source).not.toMatch(/settings\.register\(/)
    })

    it('no setInterval polling in corum-agent index', () => {
      const source = readPkg('plugins/agent/corum-agent/src/index.ts')
      expect(source).not.toMatch(/setInterval/)
    })

    it('general-groups.tsx uses @corum/corum-agent ns', () => {
      const source = readPkg('plugins/ui/corum-ide-ui/src/client/settings/sections/general-groups.tsx')
      expect(source).toMatch(/CORUM_AGENT_NS\s*=\s*'@corum\/corum-agent'/)
    })
  })

  describe('corum-review ns', () => {
    it('cordis.patch.yml has corum-review registrar row', () => {
      expect(DESKTOP_PATCH).toMatch(/id:\s*corum-review/)
      expect(DESKTOP_PATCH).toMatch(/@corum\/corum-agent\/review-settings/)
    })

    it('review-settings-registrar exports Config with retentionDays volatile', () => {
      const source = readPkg('plugins/agent/corum-agent/src/review-settings-registrar.ts')
      expect(source).toMatch(/export const Config/)
      expect(source).toMatch(/retentionDays/)
      expect(source).toMatch(/volatile\(\)/)
      expect(source).toMatch(/static Config/)
    })

    it('corum-review.ts reads from describe, not register', () => {
      const source = readPkgStripped('desktop/src/host/corum-review.ts')
      expect(source).not.toMatch(/settings\.register\(/)
      expect(source).toMatch(/describe\(\)/)
      // rc3: hot update via settings/document-updated event (not ObservableSnapshot.subscribe)
      expect(source).toMatch(/settings\/document-updated/)
    })

    it('no setInterval polling in corum-review constructor', () => {
      const source = readPkg('desktop/src/host/corum-review.ts')
      // The constructor should not have polling.
      const constructorBlock = source.match(/constructor\(ctx[^]*?\)\s*{/)
      if (constructorBlock !== null) {
        // Extract constructor body (up to the closing brace at same indent).
        const start = source.indexOf('constructor(ctx')
        const bodyEnd = source.indexOf('    // 恢复上一次运行里', start)
        const body = source.slice(start, bodyEnd)
        expect(body).not.toMatch(/setInterval/)
      }
    })
  })

  describe('corum-web-search ns', () => {
    it('exports Config with activeProvider volatile', () => {
      const source = readPkg('plugins/agent/corum-web-search/src/index.ts')
      expect(source).toMatch(/export const Config/)
      expect(source).toMatch(/activeProvider/)
      expect(source).toMatch(/volatile\(\)/)
    })

    it('no settings.register( in web-search index', () => {
      const source = readPkgStripped('plugins/agent/corum-web-search/src/index.ts')
      expect(source).not.toMatch(/settings\.register\(/)
    })

    it('cordis.patch.yml has corum-web-search entry id', () => {
      expect(DESKTOP_PATCH).toMatch(/id:\s*corum-web-search/)
    })
  })

  describe('shell ns (bash-sandbox)', () => {
    it('SHELL_NS is "bash-sandbox"', () => {
      const source = readPkg('plugins/session/corum-ui-settings-plugins/src/client/bash-card-controller.ts')
      expect(source).toMatch(/SHELL_NS\s*=\s*'bash-sandbox'/)
    })

    it('SHELL_NS is not "shell"', () => {
      const source = readPkg('plugins/session/corum-ui-settings-plugins/src/client/bash-card-controller.ts')
      expect(source).not.toMatch(/SHELL_NS\s*=\s*'shell'/)
    })

    it('official base patch has bash-sandbox entry id', () => {
      // Check the installed dsh-base patch for bash-sandbox entry.
      const basePath = join(REPO_ROOT, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml')
      let basePatch: string
      try {
        basePatch = readFileSync(basePath, 'utf8')
      } catch {
        // If not found at this path, skip (pnpm layout may differ).
        return
      }
      expect(basePatch).toMatch(/id:\s*bash-sandbox/)
    })
  })

  describe('conversation/chat ns (IDE mode)', () => {
    it('CONVERSATION_SETTINGS_NAMESPACE is "corum-conversation"', () => {
      const source = readPkg('plugins/session/corum-ui-conversation/src/submission-settings.ts')
      expect(source).toMatch(/CONVERSATION_SETTINGS_NAMESPACE\s*=\s*'corum-conversation'/)
    })

    it('CHAT_SETTINGS_NAMESPACE is "corum-chat"', () => {
      const source = readPkg('plugins/session/corum-ui-chat/src/chat-settings.ts')
      expect(source).toMatch(/CHAT_SETTINGS_NAMESPACE\s*=\s*'corum-chat'/)
    })

    it('IDE patch has corum-conversation entry id', () => {
      expect(IDE_PATCH).toMatch(/id:\s*corum-conversation/)
    })

    it('IDE patch has corum-chat entry id', () => {
      expect(IDE_PATCH).toMatch(/id:\s*corum-chat/)
    })
  })

  describe('subagent-model-selection ns', () => {
    it('SUBAGENT_MODEL_SELECTION_NS is "subagent-model-selection-settings"', () => {
      const source = readPkg('plugins/session/corum-ui-settings-plugins/src/client/subagent-model-selection-card-controller.ts')
      expect(source).toMatch(/SUBAGENT_MODEL_SELECTION_NS\s*=\s*'subagent-model-selection-settings'/)
    })
  })
})

describe('settings.register removal across all fork src', () => {
  it('no settings.register( in any fork plugin src or desktop host', () => {
    // Scan all source files for settings.register( — must be zero.
    // Uses readdirSync recursive traversal (no glob dependency).
    const { readdirSync, readFileSync: readSync, statSync } = require('node:fs')
    function collectTs(dir: string): string[] {
      const results: string[] = []
      const stack = [dir]
      while (stack.length > 0) {
        const current = stack.pop()!
        let entries: string[]
        try { entries = readdirSync(current) } catch { continue }
        for (const entry of entries) {
          const full = join(current, entry)
          let stat
          try { stat = statSync(full) } catch { continue }
          if (stat.isDirectory()) {
            if (entry === 'node_modules' || entry === 'lib' || entry === 'dist') continue
            stack.push(full)
          } else if (stat.isFile() && (entry.endsWith('.ts') || entry.endsWith('.tsx'))) {
            results.push(full)
          }
        }
      }
      return results
    }
    const dirs = [
      join(PKGS, 'plugins/agent/corum-agent/src'),
      join(PKGS, 'plugins/agent/corum-web-search/src'),
      join(PKGS, 'plugins/session/corum-ui-conversation/src'),
      join(PKGS, 'plugins/session/corum-ui-chat/src'),
      join(PKGS, 'plugins/session/corum-ui-settings-plugins/src'),
      join(PKGS, 'plugins/session/corum-ui-settings-models/src'),
      join(PKGS, 'plugins/ui/corum-ide-ui/src'),
      join(PKGS, 'desktop/src/host'),
    ]
    for (const dir of dirs) {
      const files = collectTs(dir)
      for (const file of files) {
        const content = readSync(file, 'utf8')
        // Strip comments to avoid false positives.
        const stripped = content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|\s)\/\/.*$/gm, '$1')
        expect(stripped).not.toMatch(/settings\.register\(/)
      }
    }
  })
})
