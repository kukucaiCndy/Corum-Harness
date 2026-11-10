/**
 * Anti-cycle test — verifies the layout↔corumNavigation circular dependency
 * is broken.
 *
 * Background (2026-10-31): `corumNavigation` was originally provided inside
 * `@corum/corum-ui-conversation`'s `apply()`. But conversation hard-injects
 * `layout`, and `@corum/corum-ide-ui` hard-injects `corumNavigation` →
 * layout↔corumNavigation service activation cycle → 23 plugins stuck pending
 * → web boot blocked.
 *
 * This test verifies:
 * 1. conversation's inject array does NOT include 'layout' (uses ctx.get lazily)
 * 2. conversation's inject array DOES include 'corumNavigation' (injected, not provided)
 * 3. conversation's apply() does NOT call applyCorumSessionNavigation
 * 4. the standalone navigation plugin's inject is ['sessions'] only (no layout)
 * 5. the standalone navigation plugin's apply calls applyCorumSessionNavigation
 * 6. the dependency graph has no cycle: navigation → (sessions) → ide-shell
 *    → (corumNavigation) → conversation → (corumNavigation, sessions, …)
 *
 * Uses static source-level assertions (reading the actual source files) — no
 * cordis assembly needed. This makes the test fast and independent of the
 * runtime environment.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const conversationDir = join(__dirname, '..', 'src', 'client')
const navigationDir = join(__dirname, '..', '..', 'corum-ui-navigation', 'src', 'client')

function readSource(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

/**
 * Extract only the string literals from an `export const inject = [...]` array,
 * ignoring comments. This avoids false matches on comment text.
 */
function extractInjectStrings(source: string): string[] {
  // Find the inject array: `export const inject = [ ... ]`
  // Match up to the closing `]` (handles both single-line and multi-line forms).
  const match = source.match(/export const inject = \[([\s\S]*?)\]/)
  if (match === null) return []
  let body = match[1]
  // Strip line comments (// ...) and block comments (/* ... */)
  body = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  // Extract all quoted string literals (single or double quotes)
  const strings = body.match(/'([^']+)'|"([^"]+)"/g)
  if (strings === null) return []
  // Strip the quotes
  return strings.map(s => s.replace(/^['"]|['"]$/g, ''))
}

/**
 * Extract the body of the `export function apply(...)` function (up to the
 * closing brace at the same indentation level as the `export` keyword).
 * Comments are stripped to avoid false matches on comment text that mentions
 * function names.
 */
function extractApplyBody(source: string): string {
  const match = source.match(/export function apply\([^)]*\)[^{]*\{([\s\S]*?)(\n\}|\n\}\s*$)/)
  if (match === null) return ''
  // Strip comments to avoid matching function names mentioned in comments
  return match[1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('anti-cycle: conversation no longer provides corumNavigation', () => {
  const applySource = readSource('src/client/apply.ts')
  const injectStrings = extractInjectStrings(applySource)
  const applyBody = extractApplyBody(applySource)

  it('inject array does NOT contain "layout"', () => {
    expect(injectStrings).not.toContain('layout')
  })

  it('inject array DOES contain "corumNavigation"', () => {
    expect(injectStrings).toContain('corumNavigation')
  })

  it('apply() does NOT call applyCorumSessionNavigation', () => {
    // The apply() function body must not call applyCorumSessionNavigation — that's now
    // the navigation plugin's job.
    expect(applyBody).not.toMatch(/applyCorumSessionNavigation\(ctx\)/)
  })

  it('apply() uses ctx.corumNavigation (injected service)', () => {
    // Instead of calling applyCorumSessionNavigation + ctx.get('corumNavigation'),
    // apply() should use ctx.corumNavigation directly (the injected service).
    expect(applyBody).toMatch(/ctx\.corumNavigation/)
  })

  it('sidebarModeLayout uses ctx.get("layout") (lazy access, not hard inject)', () => {
    // The sidebarModeLayout function should use ctx.get('layout') instead of
    // ctx.layout (which requires the service to be injected).
    expect(applySource).toMatch(/ctx\.get\('layout'\)/)
  })

  it('newTaskForm uses ctx.get("layout") (lazy access)', () => {
    // The newTaskForm callbacks should use ctx.get('layout') for lazy access.
    const newTaskFormSection = applySource.match(/newTaskForm[\s\S]*?consumePending[\s\S]*?\}/)
    expect(newTaskFormSection).not.toBeNull()
    expect(newTaskFormSection![0]).toMatch(/ctx\.get\('layout'\)/)
  })
})

describe('anti-cycle: standalone navigation plugin', () => {
  const navIndexSource = readFileSync(join(navigationDir, 'index.ts'), 'utf8')
  const navServiceSource = readFileSync(join(navigationDir, 'corum-navigation.ts'), 'utf8')
  const navInjectStrings = extractInjectStrings(navIndexSource)

  it('inject is ["sessions"] only (no layout, no uiConversation)', () => {
    expect(navInjectStrings).toEqual(['sessions'])
  })

  it('apply() calls applyCorumSessionNavigation', () => {
    expect(navIndexSource).toMatch(/export function apply[\s\S]*?applyCorumSessionNavigation\(ctx\)/)
  })

  it('service provides "corumNavigation" name', () => {
    expect(navServiceSource).toMatch(/super\(ctx,\s*'corumNavigation'\)/)
  })

  it('service depends only on ISessions (no layout import)', () => {
    // The service source imports ISessions from dsh-api-session-controller
    expect(navServiceSource).toMatch(/ISessions/)
    expect(navServiceSource).toMatch(/dsh-api-session-controller\/client/)
    // No layout-related import (check only import statements, not comments)
    const sourceLines = navServiceSource.split('\n')
    const importBlock: string[] = []
    let inImport = false
    for (const line of sourceLines) {
      if (line.trim().startsWith('import ')) inImport = true
      if (inImport) importBlock.push(line)
      if (inImport && (line.includes('from ') || line.includes("from'"))) inImport = false
    }
    const allImports = importBlock.join('\n')
    expect(allImports).toMatch(/ISessions/)
    // No layout import
    expect(allImports).not.toMatch(/[Ll]ayout/)
  })
})

describe('anti-cycle: dependency graph is acyclic', () => {
  // The activation order (by cordis inject, not patch row order):
  // 1. sessions (provided by @deepseek-ai/dsh-api-session-controller client)
  // 2. corum-navigation (inject sessions → provides corumNavigation)
  // 3. ide-shell (inject corumNavigation + ... → provides layout)
  // 4. corum-conversation (inject corumNavigation + sessions + ... → uses layout lazily)

  it('navigation provides corumNavigation, does not inject it', () => {
    const navSource = readFileSync(join(navigationDir, 'index.ts'), 'utf8')
    const navInject = extractInjectStrings(navSource)
    expect(navInject).toEqual(['sessions'])
    expect(navInject).not.toContain('corumNavigation')
    expect(navSource).toMatch(/applyCorumSessionNavigation/)  // provides
  })

  it('conversation injects corumNavigation, does not provide it', () => {
    const convSource = readSource('src/client/apply.ts')
    const convInject = extractInjectStrings(convSource)
    expect(convInject).toContain('corumNavigation')
    // The apply() function body must NOT call applyCorumSessionNavigation
    const applyBody = extractApplyBody(convSource)
    expect(applyBody).not.toMatch(/applyCorumSessionNavigation\(ctx\)/)
  })

  it('conversation does not inject layout', () => {
    const convSource = readSource('src/client/apply.ts')
    const convInject = extractInjectStrings(convSource)
    expect(convInject).not.toContain('layout')
  })
})
