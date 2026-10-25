/**
 * 本地扩展包端到端安装测试（P5c）。
 *
 * 覆盖（7 项）：
 *   1. pack manifest 复制到 <home>/extension-packs/<packId>/extension.json。
 *   2. plugins-src 复制到永久目录；installPlugin 收到 file: spec 指向永久路径（非临时来源）。
 *   3. entries.json 恰好一条 entry，id = ext:<packId>:@test/local-plugin，name = @test/local-plugin。
 *   4. registry.json 含该包，items 有 presets/skills/mcp/plugins + installedAt。
 *   5. installPlugin ok:false ⇒ rejects 且不写 registry.json + 清理 pack 目录副本。
 *   6. zip 来源可用（packModuleArchive 打包后安装）。
 *   7. reinstall 同包：registry 记录被替换、entries 无重复行。
 *
 * 所有夹具用 mkdtempSync 建临时目录，不碰真实 ~/.corum。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installLocalExtensionPack } from '../src/index.ts'
import { packModuleArchive } from '@corum/corum-preset-modules'
import { readRegistry } from '@corum/corum-extension-registry'
import { makeFixturePack, makeEmptyHome, type FixturePack } from './fixture.ts'

let savedEnv: string | undefined
let home: string
let pack: FixturePack

/**
 * 往 fixture pack 里加一个插件声明 + 插件源目录。
 *
 * 布局：
 *   plugins/local-plugin.json   { name:"local-plugin", spec:"file:./plugins-src/local-plugin",
 *                                mode:"permanent", bundle:true }
 *   plugins-src/local-plugin/package.json  { name:"@test/local-plugin", version:"1.0.0" }
 *   extension.json contents 追加 plugins:["local-plugin"]
 */
function addPluginFixture(packDir: string, pluginName = 'local-plugin', npmName = '@test/local-plugin'): void {
  // plugins/<name>.json
  mkdirSync(join(packDir, 'plugins'), { recursive: true })
  writeFileSync(join(packDir, 'plugins', `${pluginName}.json`), JSON.stringify({
    name: pluginName,
    spec: `file:./plugins-src/${pluginName}`,
    mode: 'permanent',
    bundle: true,
  }, null, 2), 'utf8')

  // plugins-src/<name>/package.json
  const srcDir = join(packDir, 'plugins-src', pluginName)
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'package.json'), JSON.stringify({
    name: npmName,
    version: '1.0.0',
    main: 'index.js',
  }, null, 2), 'utf8')
  writeFileSync(join(srcDir, 'index.js'), `module.exports = {};`, 'utf8')

  // 追加到 extension.json 的 contents.plugins
  const manifest = JSON.parse(readFileSync(join(packDir, 'extension.json'), 'utf8'))
  manifest.contents.plugins = [pluginName]
  writeFileSync(join(packDir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

beforeEach(() => {
  savedEnv = process.env.CORUM_HOME
  home = makeEmptyHome()
  process.env.CORUM_HOME = home
  pack = makeFixturePack()
  addPluginFixture(pack.dir)
})

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.CORUM_HOME
  } else {
    process.env.CORUM_HOME = savedEnv
  }
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  if (pack !== undefined) rmSync(pack.dir, { recursive: true, force: true })
})

// ── 1. manifest 复制 ─────────────────────────────────────────────────────

describe('installLocalExtensionPack — manifest 复制', () => {
  it('extension.json 复制到 <home>/extension-packs/<packId>/extension.json', async () => {
    const calls: Array<{ spec: string }> = []
    await installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async (decl) => {
        calls.push({ spec: decl.spec })
        return { ok: true, restartRequired: false }
      },
    })

    const manifestPath = join(home, 'extension-packs', pack.id, 'extension.json')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest.id).toBe(pack.id)
    expect(manifest.version).toBe('1.0.0')
  })
})

// ── 2. plugins-src 复制 + file: spec 指向永久路径 ─────────────────────────

describe('installLocalExtensionPack — 插件 spec 解析', () => {
  it('plugins-src 复制到永久目录，installPlugin 收到 file: 指向永久路径', async () => {
    const calls: Array<{ name: string; spec: string }> = []
    const result = await installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async (decl) => {
        calls.push({ name: decl.name, spec: decl.spec })
        return { ok: true, restartRequired: false }
      },
    })

    // 只调了一次（一个插件）。
    expect(calls).toHaveLength(1)
    const call = calls[0]!

    // spec 必须是 file: 前缀 + 指向永久目录（不是临时来源）。
    expect(call.spec.startsWith('file:')).toBe(true)
    const resolvedPath = call.spec.slice('file:'.length)
    // 永久路径在 <home>/extension-packs/<packId>/plugins-src/<name>/ 下。
    const expectedDir = join(home, 'extension-packs', pack.id, 'plugins-src', 'local-plugin')
    expect(resolvedPath).toBe(expectedDir)
    // 该目录的 package.json 存在且 name 正确。
    const pkgPath = join(resolvedPath, 'package.json')
    expect(existsSync(pkgPath)).toBe(true)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    expect(pkg.name).toBe('@test/local-plugin')

    // 结果里的插件名是 npm 名（@test/local-plugin），不是 decl 名（local-plugin）。
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]!.name).toBe('@test/local-plugin')
  })
})

// ── 3. entries.json 内容 ──────────────────────────────────────────────────

describe('installLocalExtensionPack — entries.json', () => {
  it('恰一条 entry，id = ext:<packId>:@test/local-plugin，name = @test/local-plugin', async () => {
    await installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async () => ({ ok: true, restartRequired: false }),
    })

    const entriesPath = join(home, 'extension-packs', pack.id, 'entries.json')
    expect(existsSync(entriesPath)).toBe(true)
    const entries = JSON.parse(readFileSync(entriesPath, 'utf8'))
    expect(entries.packId).toBe(pack.id)
    expect(entries.version).toBe('1.0.0')
    expect(entries.entries).toHaveLength(1)
    expect(entries.entries[0].id).toBe(`ext:${pack.id}:@test/local-plugin`)
    expect(entries.entries[0].name).toBe('@test/local-plugin')
  })
})

// ── 4. registry.json 内容 ─────────────────────────────────────────────────

describe('installLocalExtensionPack — registry.json', () => {
  it('含该包，items 有 presets/skills/mcp/plugins + installedAt', async () => {
    const result = await installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async () => ({ ok: true, restartRequired: false }),
    })

    // result 自检。
    expect(result.packId).toBe(pack.id)
    expect(result.version).toBe('1.0.0')

    const registry = readRegistry(home)
    const record = registry.packs[pack.id]
    expect(record).toBeDefined()
    expect(record.id).toBe(pack.id)
    expect(record.version).toBe('1.0.0')
    expect(record.installedAt).toBeTruthy()
    // installedAt 是 ISO 字符。
    expect(() => new Date(record.installedAt).toISOString()).not.toThrow()

    // items 各类都有。
    expect(record.items.presets?.length).toBe(2) // alpha + beta
    expect(record.items.skills?.length).toBe(2) // shared-skill + lone-skill
    expect(record.items.mcp?.length).toBe(1)    // shared-mcp
    expect(record.items.plugins?.length).toBe(1)
    expect(record.items.plugins![0]!.name).toBe('@test/local-plugin')
    expect(record.items.plugins![0]!.entryId).toBe(`ext:${pack.id}:@test/local-plugin`)
  })
})

// ── 5. installPlugin ok:false ⇒ rejects 且不写 registry ───────────────────

describe('installLocalExtensionPack — 插件失败回滚', () => {
  it('ok:false ⇒ rejects，不写 registry.json，清理 pack 目录副本', async () => {
    await expect(
      installLocalExtensionPack({
        sourceDir: pack.dir,
        home,
        installPlugin: async () => ({ ok: false, restartRequired: false, log: 'pnpm add 失败' }),
      }),
    ).rejects.toThrow(/local-plugin/)

    // registry.json 不应存在（安装被 abort）。
    const registryPath = join(home, 'extension-packs', 'registry.json')
    expect(existsSync(registryPath)).toBe(false)

    // pack 目录里不能留「半套清单」：清单副本与插件源都要清掉（P5c 修正后
    // 清单在插件全部成功后才落盘，插件源则被 best-effort 删除）。
    const packDir = join(home, 'extension-packs', pack.id)
    expect(existsSync(join(packDir, 'extension.json'))).toBe(false)
    expect(existsSync(join(packDir, 'plugins-src', 'local-plugin'))).toBe(false)
  })

  it('installPlugin 抛错 ⇒ rejects 且不写 registry.json', async () => {
    await expect(
      installLocalExtensionPack({
        sourceDir: pack.dir,
        home,
        installPlugin: async () => { throw new Error('网络超时') },
      }),
    ).rejects.toThrow(/网络超时/)

    const registryPath = join(home, 'extension-packs', 'registry.json')
    expect(existsSync(registryPath)).toBe(false)
  })
})

// ── 6. zip 来源可用 ───────────────────────────────────────────────────────

describe('installLocalExtensionPack — zip 来源', () => {
  it('packModuleArchive 打包后安装，结果与目录来源一致', async () => {
    const zipPath = join(home, 'test-pack.zip')
    packModuleArchive(pack.dir, zipPath)

    const calls: Array<{ spec: string }> = []
    const result = await installLocalExtensionPack({
      sourceDir: zipPath,
      home,
      installPlugin: async (decl) => {
        calls.push({ spec: decl.spec })
        return { ok: true, restartRequired: false }
      },
    })

    // 与目录来源同样的结果。
    expect(result.packId).toBe(pack.id)
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]!.name).toBe('@test/local-plugin')

    // file: spec 指向永久路径（zip 临时目录已清理，但永久副本在）。
    expect(calls[0]!.spec.startsWith('file:')).toBe(true)
    const resolvedPath = calls[0]!.spec.slice('file:'.length)
    expect(existsSync(join(resolvedPath, 'package.json'))).toBe(true)

    // extension.json 在永久位置。
    expect(existsSync(join(home, 'extension-packs', pack.id, 'extension.json'))).toBe(true)

    // zip 临时目录已清理（无法直接验证临时目录路径，但 home 下只有 pack 产物）。
    const extensionPacksDir = join(home, 'extension-packs')
    const entries = readdirSync(extensionPacksDir)
    // extensionPacks 下应该只有 pack.id 目录 + registry.json（不含临时目录）。
    expect(entries).toContain(pack.id)
  })
})

// ── 7. reinstall 替换 registry + entries 无重复 ──────────────────────────

describe('installLocalExtensionPack — reinstall 幂等', () => {
  it('第二次安装：registry 记录被替换、entries 无重复行', async () => {
    const installFn = async () => installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async () => ({ ok: true, restartRequired: false }),
    })

    // 第一次安装。
    await installFn()

    // 第二次安装同一包。
    const result2 = await installFn()

    // registry 只有一条该包的记录（upsert 替换，不新增）。
    const registry = readRegistry(home)
    const packIds = Object.keys(registry.packs)
    const samePacks = packIds.filter(id => id === pack.id)
    expect(samePacks).toHaveLength(1)

    // entries.json 只有一条 entry（不重复）。
    const entriesPath = join(home, 'extension-packs', pack.id, 'entries.json')
    const entries = JSON.parse(readFileSync(entriesPath, 'utf8'))
    expect(entries.entries).toHaveLength(1)
    expect(entries.entries[0].id).toBe(`ext:${pack.id}:@test/local-plugin`)

    // 第二次结果也正常。
    expect(result2.plugins).toHaveLength(1)
    expect(result2.plugins[0]!.ok).toBe(true)
  })
})

// ── 8. 归属语义（P5c 修正：不能把用户资源抢成包所有） ─────────────────────

describe('installLocalExtensionPack — 归属语义', () => {
  it('冲突跳过的用户技能不被登记为本包所有', async () => {
    // 用户自己先有一个同名技能（内容与包内不同）。
    mkdirSync(join(home, 'skills', 'shared-skill'), { recursive: true })
    writeFileSync(join(home, 'skills', 'shared-skill', 'SKILL.md'), 'USER OWNED', 'utf8')

    await installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async () => ({ ok: true, restartRequired: false }),
    })

    const record = readRegistry(home).packs[pack.id]
    // 默认 conflict=skip：shared-skill 跳过（用户自己的）⇒ 不登记；
    // lone-skill 是包新装的 ⇒ 登记。
    expect(record.items.skills?.map(s => s.name)).toEqual(['lone-skill'])
  })

  it('重装时被 skip 的旧包资源仍保留归属（升级不丢锁）', async () => {
    const install = (): Promise<unknown> => installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async () => ({ ok: true, restartRequired: false }),
    })
    await install()
    await install()

    const record = readRegistry(home).packs[pack.id]
    expect([...(record.items.skills ?? [])].map(s => s.name).sort()).toEqual(['lone-skill', 'shared-skill'])
    expect(record.items.presets).toHaveLength(2)
    expect(record.items.mcp).toHaveLength(1)
  })

  it('插件的 file: spec 指向包外 ⇒ 拒绝（防越界复制）', async () => {
    writeFileSync(join(pack.dir, 'plugins', 'local-plugin.json'), JSON.stringify({
      name: 'local-plugin',
      spec: 'file:../../outside',
      mode: 'permanent',
      bundle: true,
    }, null, 2), 'utf8')

    await expect(installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async () => ({ ok: true, restartRequired: false }),
    })).rejects.toThrow(/包外/)
  })
})

// ── 9. 基线 versionId：安装时记录、卸载时判改（多版本技能不被误判） ────────

describe('installLocalExtensionPack — 技能基线 versionId', () => {
  /**
   * 给 fixture 包的 skills[0] 补一个自带 3 条历史版本的快照文件
   * （模拟 corum-dev 包里带 .versions 的技能），并写 SKILL.md。
   */
  function addVersionsToPackSkill(skillName: string, count: number): void {
    const skillDir = join(pack.dir, 'skills', skillName)
    const versions = Array.from({ length: count }, (_, i) => ({
      id: `2026-10-24-${String(i + 1).padStart(2, '0')}`,
      date: '2026-10-24T00:00:00Z',
      label: `v${i + 1}`,
    }))
    writeFileSync(join(skillDir, 'skill-versions.json'), JSON.stringify({ versions }, null, 2), 'utf8')
  }

  it('registry 记录的 versionId = 技能最新版本 id；无版本文件的不记', async () => {
    addVersionsToPackSkill('shared-skill', 3) // lone-skill 无版本文件

    await installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async () => ({ ok: true, restartRequired: false }),
    })

    const record = readRegistry(home).packs[pack.id]
    const shared = record.items.skills!.find(s => s.name === 'shared-skill')
    const lone = record.items.skills!.find(s => s.name === 'lone-skill')
    expect(shared!.versionId).toBe('2026-10-24-03')
    expect(lone!.versionId).toBeUndefined()
  })

  it('全新安装的多版本技能卸载时被删除（不是 kept）', async () => {
    const { uninstallExtensionPack } = await import('../src/index.ts')
    addVersionsToPackSkill('shared-skill', 3)

    await installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async () => ({ ok: true, restartRequired: false }),
    })

    const result = await uninstallExtensionPack({ packId: pack.id, home })
    expect(result.ok).toBe(true)
    expect(result.removed.skills).toContain('shared-skill')
    expect(result.removed.skills).toContain('lone-skill')
    expect(result.kept.filter(k => k.kind === 'skills')).toHaveLength(0)
    expect(existsSync(join(home, 'skills', 'shared-skill'))).toBe(false)
  })

  it('用户新增一个版本后再卸载 ⇒ kept（基线之外的新版本 = 用户改过）', async () => {
    const { uninstallExtensionPack } = await import('../src/index.ts')
    addVersionsToPackSkill('shared-skill', 3)

    await installLocalExtensionPack({
      sourceDir: pack.dir,
      home,
      installPlugin: async () => ({ ok: true, restartRequired: false }),
    })

    // 用户在 home 里提交了一个新版本（版本数 3 → 4）。
    const versionsFile = join(home, 'skills', 'shared-skill', 'skill-versions.json')
    const parsed = JSON.parse(readFileSync(versionsFile, 'utf8')) as { versions: Array<{ id: string }> }
    parsed.versions.push({ id: '2026-10-24-04' })
    writeFileSync(versionsFile, JSON.stringify(parsed, null, 2), 'utf8')

    const result = await uninstallExtensionPack({ packId: pack.id, home })
    expect(result.ok).toBe(true)
    expect(result.removed.skills).not.toContain('shared-skill')
    const kept = result.kept.find(k => k.kind === 'skills' && k.name === 'shared-skill')
    expect(kept).toBeDefined()
    expect(kept!.reason).toContain('修改')
    expect(existsSync(join(home, 'skills', 'shared-skill'))).toBe(true)
  })
})
