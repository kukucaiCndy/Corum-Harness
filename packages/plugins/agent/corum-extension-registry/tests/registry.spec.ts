/**
 * registry.json 读写与归属查询测试（P5a）。
 *
 * 覆盖：
 *   1. writeRegistry + readRegistry roundtrip；文件路径正确；无 .tmp 残留。
 *   2. 缺失目录/文件 ⇒ readRegistry 返回 { packs: {} }。
 *   3. 损坏 JSON ⇒ readRegistry 抛错（消息含路径）。
 *   4. 非法结构（packs 不是对象 / pack id 非法 / version 空 / items 未知键）⇒ 抛错。
 *   5. upsertPack 插入 + 覆盖；removePack 删除 + 幂等。
 *   6. findOwner 按 kind 找归属；无归属返回 undefined。
 *   7. ownershipMap 形状：六个 kind 键都在，值正确。
 *   8. PackOwnedError 消息含包名 + 集成中心 › 扩展包；assertNotPackOwned 不命中时不抛。
 *   9. 原子写不残留 .tmp。
 *
 * 所有夹具用 mkdtempSync 建临时目录，不碰真实 ~/.corum。
 *
 * 详见 P5 设计文档 §4.2、§5.2。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EXTENSION_PACKS_DIRNAME,
  EXTENSION_REGISTRY_FILENAME,
  registryPath,
  readRegistry,
  writeRegistry,
  upsertPack,
  removePack,
  findOwner,
  ownershipMap,
  PackOwnedError,
  assertNotPackOwned,
} from '../src/index.ts'
import type { ExtensionItemKind, ExtensionPackRecord, ExtensionRegistry } from '../src/types.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-registry-'))
})

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
})

// ── 辅助：造一份合法的 ExtensionPackRecord ────────────────────────────

function makePackRecord(id = 'corum-dev', version = '1.3.0'): ExtensionPackRecord {
  return {
    id,
    version,
    name: 'Corum 开发',
    installedAt: '2026-10-23T12:00:00.000Z',
    items: {
      skills: [{ name: 'corum-cdp-verify' }],
      mcp: [{ name: 'pencil-mcp' }],
      presets: [{ name: 'corum-dev' }],
      plugins: [{ name: '@corum/remotion-kit', entryId: 'ext:corum-dev:remotion-kit' }],
      themes: [{ name: 'corum-remotion' }],
      ui: [{ name: 'remotion-kit-ui' }],
    },
  }
}

// ── 1. roundtrip ───────────────────────────────────────────────────────

describe('registry roundtrip', () => {
  it('write + read 回到原值；文件路径在 extension-packs/registry.json', () => {
    const registry: ExtensionRegistry = { packs: { 'corum-dev': makePackRecord() } }
    writeRegistry(registry, home)

    const path = registryPath(home)
    expect(existsSync(path)).toBe(true)
    expect(path).toBe(join(home, EXTENSION_PACKS_DIRNAME, EXTENSION_REGISTRY_FILENAME))

    const read = readRegistry(home)
    expect(read).toEqual(registry)
  })

  it('写出的文件带尾随换行且是可解析 JSON', () => {
    const registry: ExtensionRegistry = { packs: { 'corum-dev': makePackRecord() } }
    writeRegistry(registry, home)
    const raw = readFileSync(registryPath(home), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('原子写不残留 .tmp', () => {
    writeRegistry({ packs: { 'corum-dev': makePackRecord() } }, home)
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    const files = readdirSync(dir)
    expect(files.includes(EXTENSION_REGISTRY_FILENAME)).toBe(true)
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
  })
})

// ── 2. 缺失 ⇒ 空 ───────────────────────────────────────────────────────

describe('缺失目录/文件', () => {
  it('缺失 extension-packs 目录 ⇒ { packs: {} }', () => {
    const read = readRegistry(home)
    expect(read).toEqual({ packs: {} })
  })

  it('缺失 registry.json 但有 extension-packs 目录 ⇒ { packs: {} }', () => {
    mkdirSync(join(home, EXTENSION_PACKS_DIRNAME), { recursive: true })
    const read = readRegistry(home)
    expect(read).toEqual({ packs: {} })
  })
})

// ── 3. 损坏 JSON ⇒ 抛错 ────────────────────────────────────────────────

describe('损坏/非法 ⇒ fail loud', () => {
  it('JSON 损坏 ⇒ 抛错（消息含路径）', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), '{ not valid json', 'utf8')
    expect(() => readRegistry(home)).toThrow(/registry\.json JSON 损坏/)
  })

  it('根不是对象 ⇒ 抛错', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), '[]', 'utf8')
    expect(() => readRegistry(home)).toThrow(/必须是 JSON 对象/)
  })

  it('缺少 packs 对象 ⇒ 抛错', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), '{}', 'utf8')
    expect(() => readRegistry(home)).toThrow(/缺少 packs/)
  })

  it('pack id 非法 ⇒ 抛错', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), JSON.stringify({
      packs: { 'BAD-ID': { id: 'BAD-ID', version: '1.0.0', installedAt: '2026-01-01', items: {} } },
    }), 'utf8')
    expect(() => readRegistry(home)).toThrow(/packId 不合法/)
  })

  it('pack id 与 key 不一致 ⇒ 抛错', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), JSON.stringify({
      packs: { 'pack-a': { id: 'pack-b', version: '1.0.0', installedAt: '2026-01-01', items: {} } },
    }), 'utf8')
    expect(() => readRegistry(home)).toThrow(/不一致/)
  })

  it('version 空 ⇒ 抛错', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), JSON.stringify({
      packs: { 'my-pack': { id: 'my-pack', version: '', installedAt: '2026-01-01', items: {} } },
    }), 'utf8')
    expect(() => readRegistry(home)).toThrow(/version 不能为空/)
  })

  it('installedAt 空 ⇒ 抛错', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), JSON.stringify({
      packs: { 'my-pack': { id: 'my-pack', version: '1.0.0', installedAt: '', items: {} } },
    }), 'utf8')
    expect(() => readRegistry(home)).toThrow(/installedAt 不能为空/)
  })

  it('items 未知 kind 键 ⇒ 抛错', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), JSON.stringify({
      packs: { 'my-pack': { id: 'my-pack', version: '1.0.0', installedAt: '2026-01-01', items: { unknown: [{ name: 'x' }] } } },
    }), 'utf8')
    expect(() => readRegistry(home)).toThrow(/未知的资源类别/)
  })

  it('items kind 值不是数组 ⇒ 抛错', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), JSON.stringify({
      packs: { 'my-pack': { id: 'my-pack', version: '1.0.0', installedAt: '2026-01-01', items: { skills: 'not-array' } } },
    }), 'utf8')
    expect(() => readRegistry(home)).toThrow(/必须是数组/)
  })

  it('item 缺 name ⇒ 抛错', () => {
    const dir = join(home, EXTENSION_PACKS_DIRNAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(home), JSON.stringify({
      packs: { 'my-pack': { id: 'my-pack', version: '1.0.0', installedAt: '2026-01-01', items: { skills: [{ versionId: 'v1' }] } } },
    }), 'utf8')
    expect(() => readRegistry(home)).toThrow(/name 不能为空/)
  })
})

// ── 5. upsert / remove ─────────────────────────────────────────────────

describe('upsertPack / removePack', () => {
  it('upsertPack 插入新包', () => {
    upsertPack(makePackRecord(), home)
    const read = readRegistry(home)
    expect(read.packs['corum-dev']).toBeDefined()
    expect(read.packs['corum-dev']!.version).toBe('1.3.0')
  })

  it('upsertPack 覆盖已有包（同 id 换 version）', () => {
    upsertPack(makePackRecord('corum-dev', '1.0.0'), home)
    upsertPack(makePackRecord('corum-dev', '2.0.0'), home)
    const read = readRegistry(home)
    expect(read.packs['corum-dev']!.version).toBe('2.0.0')
  })

  it('upsertPack 非法 id ⇒ 抛错', () => {
    expect(() => upsertPack({ id: 'BAD', version: '1.0.0', installedAt: '2026-01-01', items: {} }, home))
      .toThrow(/packId "BAD" 不合法/)
  })

  it('removePack 删除已有包', () => {
    upsertPack(makePackRecord(), home)
    removePack('corum-dev', home)
    expect(readRegistry(home).packs['corum-dev']).toBeUndefined()
  })

  it('removePack 不存在的包 ⇒ no-op（幂等）', () => {
    upsertPack(makePackRecord(), home)
    removePack('nonexistent', home)
    expect(readRegistry(home).packs['corum-dev']).toBeDefined()
  })
})

// ── 6. findOwner ───────────────────────────────────────────────────────

describe('findOwner', () => {
  it('按 kind + name 找到归属', () => {
    upsertPack(makePackRecord(), home)
    const owner = findOwner('skills', 'corum-cdp-verify', home)
    expect(owner).toBeDefined()
    expect(owner!.packId).toBe('corum-dev')
    expect(owner!.pack.id).toBe('corum-dev')
  })

  it('按不同 kind 找归属（mcp）', () => {
    upsertPack(makePackRecord(), home)
    const owner = findOwner('mcp', 'pencil-mcp', home)
    expect(owner!.packId).toBe('corum-dev')
  })

  it('按不同 kind 找归属（plugins，带 entryId）', () => {
    upsertPack(makePackRecord(), home)
    const owner = findOwner('plugins', '@corum/remotion-kit', home)
    expect(owner!.packId).toBe('corum-dev')
  })

  it('无归属 ⇒ undefined', () => {
    upsertPack(makePackRecord(), home)
    expect(findOwner('skills', 'nonexistent-skill', home)).toBeUndefined()
  })

  it('kind 正确但 name 不匹配 ⇒ undefined', () => {
    upsertPack(makePackRecord(), home)
    expect(findOwner('mcp', 'corum-cdp-verify', home)).toBeUndefined()
  })

  it('空 registry ⇒ undefined', () => {
    expect(findOwner('skills', 'any', home)).toBeUndefined()
  })

  it('多个包同名资源 ⇒ 第一个命中（按插入顺序）', () => {
    upsertPack(makePackRecord('pack-a', '1.0.0'), home)
    const packB: ExtensionPackRecord = {
      id: 'pack-b',
      version: '1.0.0',
      installedAt: '2026-01-02',
      items: { skills: [{ name: 'shared-skill' }] },
    }
    upsertPack(packB, home)
    // 再覆盖 pack-a（让它的 items 也含 shared-skill）
    const packAWithShared: ExtensionPackRecord = {
      id: 'pack-a',
      version: '1.0.0',
      installedAt: '2026-01-01',
      items: { skills: [{ name: 'shared-skill' }] },
    }
    upsertPack(packAWithShared, home)
    // 插入顺序：pack-a 先写（Object.entries 按插入序），pack-b 后写；
    // 重新 upsert pack-a 时它的 key 已存在，Object.entries 顺序不变（JS 对象 key 顺序：已有 key 不重排）。
    const owner = findOwner('skills', 'shared-skill', home)
    expect(owner!.packId).toBe('pack-a')
  })
})

// ── 7. ownershipMap ────────────────────────────────────────────────────

describe('ownershipMap', () => {
  it('六个 kind 键都在', () => {
    upsertPack(makePackRecord(), home)
    const map = ownershipMap(home)
    const keys = Object.keys(map)
    expect(keys).toContain('presets')
    expect(keys).toContain('skills')
    expect(keys).toContain('mcp')
    expect(keys).toContain('plugins')
    expect(keys).toContain('themes')
    expect(keys).toContain('ui')
  })

  it('值正确：name → packId', () => {
    upsertPack(makePackRecord(), home)
    const map = ownershipMap(home)
    expect(map.skills['corum-cdp-verify']).toBe('corum-dev')
    expect(map.mcp['pencil-mcp']).toBe('corum-dev')
    expect(map.presets['corum-dev']).toBe('corum-dev')
    expect(map.plugins['@corum/remotion-kit']).toBe('corum-dev')
    expect(map.themes['corum-remotion']).toBe('corum-dev')
    expect(map.ui['remotion-kit-ui']).toBe('corum-dev')
  })

  it('空 registry ⇒ 六个空对象', () => {
    const map = ownershipMap(home)
    expect(Object.keys(map.skills)).toHaveLength(0)
    expect(Object.keys(map.mcp)).toHaveLength(0)
    expect(Object.keys(map.presets)).toHaveLength(0)
  })

  it('多个包合并到同一张图', () => {
    upsertPack(makePackRecord('pack-a', '1.0.0'), home)
    const packB: ExtensionPackRecord = {
      id: 'pack-b',
      version: '1.0.0',
      installedAt: '2026-01-02',
      items: { skills: [{ name: 'pack-b-skill' }], mcp: [{ name: 'pack-b-mcp' }] },
    }
    upsertPack(packB, home)
    const map = ownershipMap(home)
    expect(map.skills['corum-cdp-verify']).toBe('pack-a')
    expect(map.skills['pack-b-skill']).toBe('pack-b')
    expect(map.mcp['pencil-mcp']).toBe('pack-a')
    expect(map.mcp['pack-b-mcp']).toBe('pack-b')
  })
})

// ── 8. PackOwnedError ──────────────────────────────────────────────────

describe('PackOwnedError', () => {
  it('消息含包名 + 集成中心 › 扩展包', () => {
    upsertPack(makePackRecord(), home)
    expect(() => assertNotPackOwned('skills', 'corum-cdp-verify', home)).toThrow(PackOwnedError)
    try {
      assertNotPackOwned('skills', 'corum-cdp-verify', home)
    } catch (e) {
      const err = e as PackOwnedError
      expect(err.message).toContain('扩展包')
      expect(err.message).toContain('Corum 开发')
      expect(err.message).toContain('集成中心 › 扩展包')
      expect(err.packId).toBe('corum-dev')
      expect(err.kind).toBe('skills')
      expect(err.name).toBe('corum-cdp-verify')
    }
  })

  it('pack 无 name 时消息用 id', () => {
    const noNamePack: ExtensionPackRecord = {
      id: 'no-name-pack',
      version: '1.0.0',
      installedAt: '2026-01-01',
      items: { skills: [{ name: 'owned-skill' }] },
    }
    upsertPack(noNamePack, home)
    try {
      assertNotPackOwned('skills', 'owned-skill', home)
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as PackOwnedError).message).toContain('no-name-pack')
      expect((e as PackOwnedError).message).not.toContain('Corum 开发')
    }
  })

  it('assertNotPackOwned 不命中时不抛', () => {
    upsertPack(makePackRecord(), home)
    expect(() => assertNotPackOwned('skills', 'nonexistent', home)).not.toThrow()
  })

  it('assertNotPackOwned 空 registry 不抛', () => {
    expect(() => assertNotPackOwned('skills', 'any', home)).not.toThrow()
  })
})
