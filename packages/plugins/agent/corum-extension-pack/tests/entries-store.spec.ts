/**
 * 扩展包插件 insert 行持久层测试（P3a）。
 *
 * 覆盖：
 *   1. writePackEntries + readPackEntries roundtrip；文件路径正确；无 .tmp 残留。
 *   2. readPackEntries 文件缺失 ⇒ 抛错（消息含路径）。
 *   3. readPackEntries JSON 损坏 ⇒ 抛错。
 *   4. writePackEntries 校验 packId（'Bad'、'../x'、''）与 entry id 不匹配。
 *   5. loadExtensionEntries 空目录 ⇒ []；跳过无 entries.json 的子目录；排序。
 *   6. 重复 entry id 跨两个包 ⇒ 抛错（命名两个 pack id）。
 *   7. 同名插件被两个不同包声明 ⇒ 抛错（命名两个 pack id）。
 *   8. extensionPatches 空入 ⇒ []；单 patch 行排序；config/disabled 保留。
 *   9. writePackEntries 校验不过 ⇒ 不创建目标文件。
 *   10. 合法 entries.json 是带尾随换行的可解析 JSON。
 *
 * 所有夹具用 mkdtempSync 建临时目录，不碰真实 ~/.corum。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  entryIdFor,
  extensionPacksDir,
  packEntriesPath,
  readPackEntries,
  writePackEntries,
  listExtensionPackIds,
  loadExtensionEntries,
  extensionPatches,
  type ExtensionEntriesFile,
} from '../src/entries-store.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-entries-store-'))
})

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
})

// ── 辅助：造一份合法的 ExtensionEntriesFile ────────────────────────────

function makeValidFile(packId = 'my-pack', version = '1.0.0'): ExtensionEntriesFile {
  return {
    packId,
    version,
    entries: [
      { id: entryIdFor(packId, '@corum/plugin-a'), name: '@corum/plugin-a', order: 100 },
      { id: entryIdFor(packId, '@corum/plugin-b'), name: '@corum/plugin-b', order: 50, config: { foo: 'bar' } },
      { id: entryIdFor(packId, '@corum/plugin-c'), name: '@corum/plugin-c', disabled: true },
    ],
  }
}

// ── 1. roundtrip ────────────────────────────────────────────────────────

describe('writePackEntries + readPackEntries roundtrip', () => {
  it('写入后读回一致；文件路径正确；无 .tmp 残留', () => {
    const file = makeValidFile()
    writePackEntries(home, 'my-pack', file)

    const path = packEntriesPath(home, 'my-pack')
    expect(existsSync(path)).toBe(true)
    // 无 .tmp 残留。
    expect(existsSync(`${path}.tmp`)).toBe(false)

    const read = readPackEntries(home, 'my-pack')
    expect(read.packId).toBe('my-pack')
    expect(read.version).toBe('1.0.0')
    expect(read.entries).toHaveLength(3)
    expect(read.entries[0].id).toBe('ext:my-pack:@corum/plugin-a')
    expect(read.entries[0].name).toBe('@corum/plugin-a')
    expect(read.entries[0].order).toBe(100)
    expect(read.entries[1].config).toEqual({ foo: 'bar' })
    expect(read.entries[2].disabled).toBe(true)
  })

  it('空 entries 数组合法', () => {
    const file: ExtensionEntriesFile = { packId: 'empty-pack', version: '0.1.0', entries: [] }
    writePackEntries(home, 'empty-pack', file)
    const read = readPackEntries(home, 'empty-pack')
    expect(read.entries).toHaveLength(0)
  })
})

// ── 2. readPackEntries 文件缺失 ──────────────────────────────────────────

describe('readPackEntries — 文件缺失', () => {
  it('抛错且消息含文件路径', () => {
    const path = packEntriesPath(home, 'no-such-pack')
    expect(() => readPackEntries(home, 'no-such-pack')).toThrow(path)
  })
})

// ── 3. readPackEntries JSON 损坏 ─────────────────────────────────────────

describe('readPackEntries — JSON 损坏', () => {
  it('抛错', () => {
    // 先手写一个坏 JSON 文件。
    const dir = join(extensionPacksDir(home), 'bad-json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'entries.json'), '{ not valid json', 'utf8')

    expect(() => readPackEntries(home, 'bad-json')).toThrow()
  })

  it('文件内 packId 与目录名不一致 ⇒ 抛错（与 write 对称）', () => {
    const dir = join(extensionPacksDir(home), 'dir-name')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'entries.json'), JSON.stringify({
      packId: 'other-pack',
      version: '1.0.0',
      entries: [],
    }), 'utf8')

    expect(() => readPackEntries(home, 'dir-name')).toThrow(/不一致/)
  })
})

// ── 4. writePackEntries 校验 packId 与 entry id ──────────────────────────

describe('writePackEntries — 校验失败', () => {
  it('packId "Bad"（含大写）⇒ 抛错', () => {
    expect(() => writePackEntries(home, 'Bad', makeValidFile('Bad'))).toThrow()
  })

  it('packId "../x"（路径穿越）⇒ 抛错', () => {
    expect(() => writePackEntries(home, '../x', makeValidFile('../x'))).toThrow()
  })

  it('packId ""（空）⇒ 抛错', () => {
    expect(() => writePackEntries(home, '', makeValidFile(''))).toThrow()
  })

  it('entry id 与 packId/name 不匹配 ⇒ 抛错', () => {
    const file: ExtensionEntriesFile = {
      packId: 'good-pack',
      version: '1.0.0',
      entries: [{ id: 'ext:other-pack:plugin-a', name: 'plugin-a' }],
    }
    expect(() => writePackEntries(home, 'good-pack', file)).toThrow()
  })

  it('file.packId 与参数 packId 不一致 ⇒ 抛错', () => {
    const file = makeValidFile('pack-a')
    expect(() => writePackEntries(home, 'pack-b', file)).toThrow()
  })
})

// ── 5. loadExtensionEntries ─────────────────────────────────────────────

describe('loadExtensionEntries', () => {
  it('extension-packs 目录不存在 ⇒ []', () => {
    expect(loadExtensionEntries(home)).toEqual([])
  })

  it('跳过无 entries.json 的子目录', () => {
    // 有 entries.json 的包。
    writePackEntries(home, 'alpha', makeValidFile('alpha'))
    // 无 entries.json 的子目录。
    mkdirSync(join(extensionPacksDir(home), 'no-entries'), { recursive: true })

    const files = loadExtensionEntries(home)
    expect(files).toHaveLength(1)
    expect(files[0].packId).toBe('alpha')
  })

  it('多个合法包按 packId 排序返回', () => {
    writePackEntries(home, 'zeta', { packId: 'zeta', version: '1.0.0', entries: [] })
    writePackEntries(home, 'alpha', { packId: 'alpha', version: '1.0.0', entries: [] })
    writePackEntries(home, 'mid', { packId: 'mid', version: '1.0.0', entries: [] })

    const files = loadExtensionEntries(home)
    expect(files.map(f => f.packId)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('listExtensionPackIds 与 loadExtensionEntries 一致', () => {
    writePackEntries(home, 'zeta', { packId: 'zeta', version: '1.0.0', entries: [] })
    writePackEntries(home, 'alpha', { packId: 'alpha', version: '1.0.0', entries: [] })

    expect(listExtensionPackIds(home)).toEqual(['alpha', 'zeta'])
  })

  it('忽略名字非法的子目录（手建临时目录不参与 boot 折行）', () => {
    writePackEntries(home, 'alpha', { packId: 'alpha', version: '1.0.0', entries: [] })
    // 手建一个名字非法的目录 + entries.json：不该被扫描到。
    const badDir = join(extensionPacksDir(home), 'Bad Dir')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'entries.json'), JSON.stringify({
      packId: 'bad', version: '1.0.0', entries: [],
    }), 'utf8')

    expect(listExtensionPackIds(home)).toEqual(['alpha'])
    expect(loadExtensionEntries(home).map(f => f.packId)).toEqual(['alpha'])
  })
})

// ── 6. 同名插件被两个不同包声明 ─────────────────────────────────────────

describe('同名插件跨两个不同包', () => {
  it('两个包的 entry.name 相同 ⇒ 抛错且命名两个 pack', () => {
    const fileA: ExtensionEntriesFile = {
      packId: 'pack-a',
      version: '1.0.0',
      entries: [{ id: entryIdFor('pack-a', 'shared-plugin'), name: 'shared-plugin' }],
    }
    const fileB: ExtensionEntriesFile = {
      packId: 'pack-b',
      version: '1.0.0',
      entries: [{ id: entryIdFor('pack-b', 'shared-plugin'), name: 'shared-plugin' }],
    }
    writePackEntries(home, 'pack-a', fileA)
    writePackEntries(home, 'pack-b', fileB)

    expect(() => loadExtensionEntries(home)).toThrow(/shared-plugin/)
    // 消息含两个 pack id。
    expect(() => loadExtensionEntries(home)).toThrow(/pack-a/)
    expect(() => loadExtensionEntries(home)).toThrow(/pack-b/)
  })
})

// ── 8. extensionPatches ─────────────────────────────────────────────────

describe('extensionPatches', () => {
  it('空入 ⇒ []', () => {
    expect(extensionPatches([])).toEqual([])
  })

  it('空 entries ⇒ []', () => {
    const files: ExtensionEntriesFile[] = [{ packId: 'a', version: '1.0.0', entries: [] }]
    expect(extensionPatches(files)).toEqual([])
  })

  it('返回一条 patch，rows 按 order 升序再按 id 升序', () => {
    const files: ExtensionEntriesFile[] = [
      {
        packId: 'pack-a',
        version: '1.0.0',
        entries: [
          { id: entryIdFor('pack-a', 'c'), name: 'c', order: 100 },
          { id: entryIdFor('pack-a', 'a'), name: 'a', order: 50 },
          { id: entryIdFor('pack-a', 'b'), name: 'b', order: 50 },
        ],
      },
    ]
    const patches = extensionPatches(files)
    expect(patches).toHaveLength(1)
    const insert = patches[0]!.insert!
    expect(insert).toHaveLength(3)
    // order 50 的两条按 id 排序：a < b；order 100 的 c 最后。
    expect(insert[0].id).toBe('ext:pack-a:a')
    expect(insert[1].id).toBe('ext:pack-a:b')
    expect(insert[2].id).toBe('ext:pack-a:c')
  })

  it('无 order 的 entry 排在有 order 的之后（按 id 排序）', () => {
    const files: ExtensionEntriesFile[] = [
      {
        packId: 'pack-a',
        version: '1.0.0',
        entries: [
          { id: entryIdFor('pack-a', 'no-order'), name: 'no-order' },
          { id: entryIdFor('pack-a', 'has-order'), name: 'has-order', order: 1 },
        ],
      },
    ]
    const patches = extensionPatches(files)
    const insert = patches[0]!.insert!
    expect(insert[0].id).toBe('ext:pack-a:has-order')
    expect(insert[1].id).toBe('ext:pack-a:no-order')
  })

  it('config 保留在行中', () => {
    const files: ExtensionEntriesFile[] = [
      {
        packId: 'pack-a',
        version: '1.0.0',
        entries: [
          { id: entryIdFor('pack-a', 'p'), name: 'p', config: { key: 'value' } },
        ],
      },
    ]
    const patches = extensionPatches(files)
    expect(patches[0]!.insert![0].config).toEqual({ key: 'value' })
  })

  it('disabled=true 的 entry 产生 { disabled: true }', () => {
    const files: ExtensionEntriesFile[] = [
      {
        packId: 'pack-a',
        version: '1.0.0',
        entries: [
          { id: entryIdFor('pack-a', 'p'), name: 'p', disabled: true },
        ],
      },
    ]
    const patches = extensionPatches(files)
    expect(patches[0]!.insert![0].disabled).toBe(true)
  })

  it('disabled=false 或缺失 ⇒ 行中无 disabled 字段', () => {
    const files: ExtensionEntriesFile[] = [
      {
        packId: 'pack-a',
        version: '1.0.0',
        entries: [
          { id: entryIdFor('pack-a', 'p-false'), name: 'p-false', disabled: false },
          { id: entryIdFor('pack-a', 'p-none'), name: 'p-none' },
        ],
      },
    ]
    const patches = extensionPatches(files)
    expect(patches[0]!.insert![0].disabled).toBeUndefined()
    expect(patches[0]!.insert![1].disabled).toBeUndefined()
  })
})

// ── 9. writePackEntries 校验不过不创建目标文件 ──────────────────────────

describe('writePackEntries — 校验不过不写目标', () => {
  it('无效 packId ⇒ 不创建目标文件', () => {
    expect(() => writePackEntries(home, 'Bad', makeValidFile('Bad'))).toThrow()
    expect(existsSync(packEntriesPath(home, 'Bad'))).toBe(false)
  })

  it('entry id 不匹配 ⇒ 不创建目标文件', () => {
    const file: ExtensionEntriesFile = {
      packId: 'good',
      version: '1.0.0',
      entries: [{ id: 'ext:wrong:plugin', name: 'plugin' }],
    }
    expect(() => writePackEntries(home, 'good', file)).toThrow()
    expect(existsSync(packEntriesPath(home, 'good'))).toBe(false)
  })
})

// ── 10. 尾随换行约定 ────────────────────────────────────────────────────

describe('entries.json 尾随换行', () => {
  it('合法文件是带尾随换行的可解析 JSON', () => {
    const file = makeValidFile()
    writePackEntries(home, 'my-pack', file)
    const path = packEntriesPath(home, 'my-pack')
    const raw = readFileSync(path, 'utf8')
    // 尾随换行。
    expect(raw.endsWith('\n')).toBe(true)
    // 可解析。
    const parsed = JSON.parse(raw)
    expect(parsed.packId).toBe('my-pack')
  })
})
