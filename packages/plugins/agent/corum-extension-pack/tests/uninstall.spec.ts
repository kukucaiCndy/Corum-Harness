/**
 * 卸载编排测试（P4）。
 *
 * 覆盖 planUninstall 纯函数（5 项）+ uninstallExtensionPack 端到端（5 项）：
 *
 * planUninstall：
 *   1. 全新技能（1 版本）→ delete。
 *   2. 用户改过的技能（>1 版本 或 versionId 不匹配）→ keep。
 *   3. 与别的包共享 → keep（只摘引用）。
 *   4. MCP solely owned → delete；shared → keep。
 *   5. themes/ui → keep（本轮只摘引用）。
 *
 * uninstallExtensionPack：
 *   6. 正常卸载：删 skill 目录 + MCP 注册表项 + entries.json + pack 目录 + registry 记录。
 *   7. 共享资源保留：skill/mcp 不删。
 *   8. 修改过的技能保留：skill 目录不删。
 *   9. 不在 registry 的 packId → ok:false。
 *   10. 插件卸载回调被调用且收到正确的 name + entryId。
 *
 * 所有夹具用 mkdtempSync 建临时目录，不碰真实 ~/.corum。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planUninstall, uninstallExtensionPack } from '../src/index.ts'
import { upsertPack, readRegistry, type ExtensionPackRecord } from '@corum/corum-extension-registry'
import { writePackEntries, type ExtensionEntry } from '../src/index.ts'
import { deleteServer, getServer, saveServer } from '@corum/corum-mcp-manager'
import { makeEmptyHome } from './fixture.ts'

let home: string

beforeEach(() => {
  home = makeEmptyHome()
})

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
})

// ── 辅助 ──────────────────────────────────────────────────────────────

function makeRecord(id: string, items: ExtensionPackRecord['items']): ExtensionPackRecord {
  return { id, version: '1.0.0', installedAt: '2026-10-24T00:00:00Z', items }
}

function makeSkillFacts(name: string, versionCount: number, latestVersionId?: string) {
  return { versionCount, ...(latestVersionId !== undefined ? { latestVersionId } : {}) }
}

function writeSkillDir(home: string, name: string, versions: number = 1): void {
  const skillDir = join(home, 'skills', name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\ndescription: ${name}\n---\n# ${name}\n`, 'utf8')
  if (versions > 0) {
    const versionList = Array.from({ length: versions }, (_, i) => ({
      id: `2026-10-24-${String(i + 1).padStart(2, '0')}`,
      date: '2026-10-24T00:00:00Z',
      label: `v${i + 1}`,
    }))
    writeFileSync(join(skillDir, 'skill-versions.json'), JSON.stringify({ versions: versionList }, null, 2), 'utf8')
  }
}

// ── planUninstall 测试 ───────────────────────────────────────────────

describe('planUninstall — 纯函数', () => {
  it('1. 全新技能（1 版本）→ delete', () => {
    const record = makeRecord('pack-a', { skills: [{ name: 'my-skill' }] })
    const plan = planUninstall(record, [], {
      skillFacts: () => makeSkillFacts('my-skill', 1, '2026-10-24-01'),
    })
    expect(plan.toDelete).toHaveLength(1)
    expect(plan.toDelete[0]).toEqual({ kind: 'skills', name: 'my-skill' })
    expect(plan.toKeep).toHaveLength(0)
  })

  it('2a. 用户改过的技能（>1 版本）→ keep', () => {
    const record = makeRecord('pack-a', { skills: [{ name: 'my-skill', versionId: '2026-10-24-01' }] })
    const plan = planUninstall(record, [], {
      skillFacts: () => makeSkillFacts('my-skill', 2, '2026-10-24-02'),
    })
    expect(plan.toDelete).toHaveLength(0)
    expect(plan.toKeep).toHaveLength(1)
    expect(plan.toKeep[0]!.name).toBe('my-skill')
    expect(plan.toKeep[0]!.reason).toContain('修改')
  })

  it('2b. versionId 不匹配 → keep', () => {
    const record = makeRecord('pack-a', { skills: [{ name: 'my-skill', versionId: 'old-id' }] })
    const plan = planUninstall(record, [], {
      skillFacts: () => makeSkillFacts('my-skill', 1, 'new-id'),
    })
    expect(plan.toDelete).toHaveLength(0)
    expect(plan.toKeep).toHaveLength(1)
  })

  it('2d. 包内自带多版本（基线 versionId = 最新）→ delete（不算用户修改）', () => {
    // 全新安装的扩展包技能自带 3 条历史版本快照；registry 基线 = 安装时最新版 id。
    const record = makeRecord('pack-a', { skills: [{ name: 'my-skill', versionId: '2026-10-24-03' }] })
    const plan = planUninstall(record, [], {
      skillFacts: () => makeSkillFacts('my-skill', 3, '2026-10-24-03'),
    })
    expect(plan.toDelete).toEqual([{ kind: 'skills', name: 'my-skill' }])
    expect(plan.toKeep).toHaveLength(0)
  })

  it('2e. 包内自带多版本 + 用户又新增一版（基线 ≠ 最新）→ keep', () => {
    const record = makeRecord('pack-a', { skills: [{ name: 'my-skill', versionId: '2026-10-24-03' }] })
    const plan = planUninstall(record, [], {
      skillFacts: () => makeSkillFacts('my-skill', 4, '2026-10-24-04'),
    })
    expect(plan.toDelete).toHaveLength(0)
    expect(plan.toKeep).toHaveLength(1)
    expect(plan.toKeep[0]!.reason).toContain('修改')
  })

  it('2f. 旧台账无 versionId、多版本 → keep（保守判据不变）', () => {
    const record = makeRecord('pack-a', { skills: [{ name: 'my-skill' }] })
    const plan = planUninstall(record, [], {
      skillFacts: () => makeSkillFacts('my-skill', 3, '2026-10-24-03'),
    })
    expect(plan.toDelete).toHaveLength(0)
    expect(plan.toKeep).toHaveLength(1)
  })

  it('2c. 无法判定技能事实 → keep（保守）', () => {
    const record = makeRecord('pack-a', { skills: [{ name: 'my-skill' }] })
    const plan = planUninstall(record, []) // 不传 skillFacts
    expect(plan.toDelete).toHaveLength(0)
    expect(plan.toKeep).toHaveLength(1)
  })

  it('3. 与别的包共享 → keep（只摘引用）', () => {
    const record = makeRecord('pack-a', { skills: [{ name: 'shared-skill' }] })
    const other = makeRecord('pack-b', { skills: [{ name: 'shared-skill' }] })
    const plan = planUninstall(record, [other], {
      skillFacts: () => makeSkillFacts('shared-skill', 1, '2026-10-24-01'),
    })
    expect(plan.toDelete).toHaveLength(0)
    expect(plan.toKeep).toHaveLength(1)
    expect(plan.toKeep[0]!.reason).toContain('共享')
  })

  it('4a. MCP solely owned → delete', () => {
    const record = makeRecord('pack-a', { mcp: [{ name: 'my-mcp' }] })
    const plan = planUninstall(record, [])
    expect(plan.toDelete).toHaveLength(1)
    expect(plan.toDelete[0]).toEqual({ kind: 'mcp', name: 'my-mcp' })
  })

  it('4b. MCP shared → keep', () => {
    const record = makeRecord('pack-a', { mcp: [{ name: 'shared-mcp' }] })
    const other = makeRecord('pack-b', { mcp: [{ name: 'shared-mcp' }] })
    const plan = planUninstall(record, [other])
    expect(plan.toDelete).toHaveLength(0)
    expect(plan.toKeep).toHaveLength(1)
  })

  it('5. themes/ui → keep（只摘引用）', () => {
    const record = makeRecord('pack-a', {
      themes: [{ name: 'my-theme' }],
      ui: [{ name: 'my-ui' }],
    })
    const plan = planUninstall(record, [])
    expect(plan.toDelete).toHaveLength(0)
    expect(plan.toKeep).toHaveLength(2)
    expect(plan.toKeep.some(k => k.name === 'my-theme')).toBe(true)
    expect(plan.toKeep.some(k => k.name === 'my-ui')).toBe(true)
  })

  it('6. presets → 未改过则删；改过则保留', () => {
    const record = makeRecord('pack-a', { presets: [{ name: 'my-preset' }] })
    const clean = planUninstall(record, [])
    expect(clean.toDelete).toEqual([{ kind: 'presets', name: 'my-preset' }])
    expect(clean.toKeep).toHaveLength(0)

    const modified = planUninstall(record, [], { presetFacts: () => ({ modified: true }) })
    expect(modified.toDelete).toHaveLength(0)
    expect(modified.toKeep).toHaveLength(1)
    expect(modified.toKeep[0]!.reason).toContain('预设')
  })

  it('7. plugins solely owned → delete', () => {
    const record = makeRecord('pack-a', {
      plugins: [{ name: '@test/plugin', entryId: 'ext:pack-a:@test/plugin' }],
    })
    const plan = planUninstall(record, [])
    expect(plan.toDelete).toHaveLength(1)
    expect(plan.toDelete[0]).toEqual({ kind: 'plugins', name: '@test/plugin' })
  })
})

// ── uninstallExtensionPack 端到端测试 ────────────────────────────────

describe('uninstallExtensionPack — 端到端', () => {
  it('8. 正常卸载：删 skill 目录 + MCP 注册表 + entries.json + pack 目录 + registry 记录', async () => {
    // 造一个包：1 个技能 + 1 个 MCP + 1 个插件。
    writeSkillDir(home, 'my-skill', 1)
    saveServer({ name: 'my-mcp', transport: 'stdio', command: 'node', args: [] }, home)
    const packDir = join(home, 'extension-packs', 'pack-a')
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'extension.json'), '{}', 'utf8')
    writePackEntries(home, 'pack-a', {
      packId: 'pack-a',
      version: '1.0.0',
      entries: [{ id: 'ext:pack-a:@test/plugin', name: '@test/plugin' }] as readonly ExtensionEntry[],
    })
    upsertPack(makeRecord('pack-a', {
      skills: [{ name: 'my-skill' }],
      mcp: [{ name: 'my-mcp' }],
      plugins: [{ name: '@test/plugin', entryId: 'ext:pack-a:@test/plugin' }],
    }), home)

    const result = await uninstallExtensionPack({
      packId: 'pack-a',
      home,
      uninstallPlugin: async () => ({ ok: true, restartRequired: false }),
    })

    expect(result.ok).toBe(true)
    expect(result.removed.skills).toEqual(['my-skill'])
    expect(result.removed.mcp).toEqual(['my-mcp'])
    expect(result.removed.plugins).toEqual(['@test/plugin'])
    expect(existsSync(join(home, 'skills', 'my-skill'))).toBe(false)
    expect(getServer('my-mcp', home)).toBeUndefined()
    expect(existsSync(join(home, 'extension-packs', 'pack-a'))).toBe(false)
    expect(readRegistry(home).packs['pack-a']).toBeUndefined()
  })

  it('9. 共享资源保留：skill/mcp 不删', async () => {
    writeSkillDir(home, 'shared-skill', 1)
    saveServer({ name: 'shared-mcp', transport: 'stdio', command: 'node', args: [] }, home)
    const packDir = join(home, 'extension-packs', 'pack-a')
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'extension.json'), '{}', 'utf8')
    upsertPack(makeRecord('pack-a', {
      skills: [{ name: 'shared-skill' }],
      mcp: [{ name: 'shared-mcp' }],
    }), home)
    // pack-b 也拥有同样的 skill/mcp
    upsertPack(makeRecord('pack-b', {
      skills: [{ name: 'shared-skill' }],
      mcp: [{ name: 'shared-mcp' }],
    }), home)

    const result = await uninstallExtensionPack({
      packId: 'pack-a',
      home,
    })

    expect(result.ok).toBe(true)
    expect(result.removed.skills).toHaveLength(0)
    expect(result.removed.mcp).toHaveLength(0)
    expect(result.kept).toHaveLength(2)
    // 共享资源保留在磁盘上
    expect(existsSync(join(home, 'skills', 'shared-skill'))).toBe(true)
    expect(getServer('shared-mcp', home)).toBeDefined()
    // pack-a 从 registry 删了，pack-b 还在
    expect(readRegistry(home).packs['pack-a']).toBeUndefined()
    expect(readRegistry(home).packs['pack-b']).toBeDefined()
  })

  it('10. 修改过的技能保留：skill 目录不删', async () => {
    writeSkillDir(home, 'modified-skill', 2) // 2 个版本 → 改过
    const packDir = join(home, 'extension-packs', 'pack-a')
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'extension.json'), '{}', 'utf8')
    upsertPack(makeRecord('pack-a', {
      skills: [{ name: 'modified-skill', versionId: '2026-10-24-01' }],
    }), home)

    const result = await uninstallExtensionPack({
      packId: 'pack-a',
      home,
    })

    expect(result.ok).toBe(true)
    expect(result.removed.skills).toHaveLength(0)
    expect(result.kept).toHaveLength(1)
    expect(existsSync(join(home, 'skills', 'modified-skill'))).toBe(true)
  })

  it('11. 不在 registry 的 packId → ok:false', async () => {
    const result = await uninstallExtensionPack({
      packId: 'nonexistent-pack',
      home,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不在 registry')
  })

  it('12. 插件卸载回调被调用且收到正确的 name + entryId', async () => {
    const packDir = join(home, 'extension-packs', 'pack-a')
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'extension.json'), '{}', 'utf8')
    writePackEntries(home, 'pack-a', {
      packId: 'pack-a',
      version: '1.0.0',
      entries: [{ id: 'ext:pack-a:@test/plugin', name: '@test/plugin' }] as readonly ExtensionEntry[],
    })
    upsertPack(makeRecord('pack-a', {
      plugins: [{ name: '@test/plugin', entryId: 'ext:pack-a:@test/plugin' }],
    }), home)

    const calls: Array<{ name: string; entryId: string }> = []
    const result = await uninstallExtensionPack({
      packId: 'pack-a',
      home,
      uninstallPlugin: async (name, entryId) => {
        calls.push({ name, entryId })
        return { ok: true, restartRequired: true }
      },
    })

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('@test/plugin')
    expect(calls[0]!.entryId).toBe('ext:pack-a:@test/plugin')
    expect(result.restartRequired).toBe(true)
  })

  it('13. 插件卸载失败 → warning + 其余资源仍删除', async () => {
    writeSkillDir(home, 'my-skill', 1)
    saveServer({ name: 'my-mcp', transport: 'stdio', command: 'node', args: [] }, home)
    const packDir = join(home, 'extension-packs', 'pack-a')
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'extension.json'), '{}', 'utf8')
    writePackEntries(home, 'pack-a', {
      packId: 'pack-a',
      version: '1.0.0',
      entries: [{ id: 'ext:pack-a:@test/plugin', name: '@test/plugin' }] as readonly ExtensionEntry[],
    })
    upsertPack(makeRecord('pack-a', {
      skills: [{ name: 'my-skill' }],
      mcp: [{ name: 'my-mcp' }],
      plugins: [{ name: '@test/plugin', entryId: 'ext:pack-a:@test/plugin' }],
    }), home)

    const result = await uninstallExtensionPack({
      packId: 'pack-a',
      home,
      uninstallPlugin: async () => ({ ok: false, restartRequired: false, log: 'pnpm remove failed' }),
    })

    // ok 仍为 true（entries/pack/registry 都删了）——插件失败只进 warnings。
    expect(result.ok).toBe(true)
    expect(result.removed.skills).toEqual(['my-skill'])
    expect(result.removed.mcp).toEqual(['my-mcp'])
    expect(result.removed.plugins).toHaveLength(0)
    expect(result.warnings.some(w => w.includes('@test/plugin'))).toBe(true)
    // entries.json + pack 目录 + registry 都清理了（entries 删除成功）。
    expect(existsSync(join(home, 'extension-packs', 'pack-a'))).toBe(false)
    expect(readRegistry(home).packs['pack-a']).toBeUndefined()
  })
})
