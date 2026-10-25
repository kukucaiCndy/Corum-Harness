/**
 * 扩展包扫描与安装测试（P2）。
 *
 * 覆盖：
 *   1. scan：合法包 0 错误 + 解析每个实体路径。
 *   2. scan：歧义/空/缺 extension.json/缺失实体/dangling ui.plugin/importSkill 指向未知技能。
 *   3. install 到干净 home：两个预设落盘、shared-skill 只一份、lone-skill 独立安装、
 *      注册表只有一个 shared-mcp、agent.json 仍按名引用、agent.json 含 moduleSource。
 *   4. install 幂等：第二次 skills skipped / mcp kept、不重复。
 *   5. install .zip 来源：先 pack 再装，落点与目录来源一致。
 *   6. 含 plugins/themes/ui 的包：deferred 三项齐全、不安装它们。
 *   7. scan.errors 非空 ⇒ install 抛错且 home 里没有 .agent-presets。
 *
 * 所有夹具用 mkdtempSync 建临时目录，不碰真实 ~/.corum
 * （set process.env.CORUM_HOME to a temp dir in beforeEach and restore after）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  scanExtensionPack,
  installExtensionPack,
  validatePluginDecl,
  validateUiDecl,
} from '../src/index.ts'
import { packModuleArchive } from '@corum/corum-preset-modules'
import { makeFixturePack, makeEmptyHome, type FixturePack } from './fixture.ts'

let savedEnv: string | undefined
let home: string
let pack: FixturePack

beforeEach(() => {
  savedEnv = process.env.CORUM_HOME
  home = makeEmptyHome()
  process.env.CORUM_HOME = home
  pack = makeFixturePack()
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

// ── 1. scan：合法包 0 错误 + 解析实体路径 ─────────────────────────────

describe('scanExtensionPack — 合法包', () => {
  it('0 errors 且解析出每个实体的绝对路径', () => {
    const scan = scanExtensionPack(pack.dir)
    expect(scan.errors).toHaveLength(0)
    expect(scan.kind).toBe('extension')
    expect(scan.manifest?.id).toBe(pack.id)

    // presets：alpha/beta 各一条，path 指向 presets/<name>/agent.json。
    expect(scan.presets.map(p => p.name).sort()).toEqual(['alpha', 'beta'])
    for (const ref of scan.presets) {
      expect(ref.path).toBe(join(pack.dir, 'presets', ref.name, 'agent.json'))
      expect(existsSync(ref.path)).toBe(true)
    }

    // skills：shared-skill/lone-skill。
    expect(scan.skills.map(s => s.name).sort()).toEqual(['lone-skill', 'shared-skill'])
    for (const ref of scan.skills) {
      expect(ref.path).toBe(join(pack.dir, 'skills', ref.name))
      expect(existsSync(ref.path)).toBe(true)
    }

    // mcp：shared-mcp。
    expect(scan.mcp.map(m => m.name)).toEqual(['shared-mcp'])
    expect(scan.mcp[0]!.path).toBe(join(pack.dir, 'mcp', 'shared-mcp.json'))

    // 空类。
    expect(scan.plugins).toHaveLength(0)
    expect(scan.themes).toHaveLength(0)
    expect(scan.ui).toHaveLength(0)
  })
})

// ── 2. scan：各种错误形态 ─────────────────────────────────────────────

describe('scanExtensionPack — 错误形态', () => {
  it('ambiguous（同时有 extension.json 和 module.json）⇒ error', () => {
    writeFileSync(join(pack.dir, 'module.json'), JSON.stringify({
      formatVersion: 1, id: 'x', version: '1.0.0', name: 'x',
      contents: { skills: [], mcp: [], hasAvatar: false },
    }), 'utf8')
    const scan = scanExtensionPack(pack.dir)
    expect(scan.kind).toBe('ambiguous')
    expect(scan.errors.length).toBeGreaterThan(0)
    expect(scan.errors.some(e => e.message.includes('必须正好是一种'))).toBe(true)
  })

  it('missing extension.json（空目录）⇒ error', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'corum-empty-'))
    try {
      const scan = scanExtensionPack(emptyDir)
      expect(scan.kind).toBe('empty')
      expect(scan.errors.length).toBeGreaterThan(0)
      expect(scan.errors.some(e => e.message.includes('缺少 extension.json'))).toBe(true)
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('声明的实体在磁盘上缺失 ⇒ error 命名预期路径', () => {
    // 删掉 shared-skill 目录。
    rmSync(join(pack.dir, 'skills', 'shared-skill'), { recursive: true, force: true })
    const scan = scanExtensionPack(pack.dir)
    expect(scan.errors.some(e => e.message.includes('shared-skill') && e.message.includes('技能实体目录缺失'))).toBe(true)
  })

  it('invalid entity name（清单里写了不安全名字）⇒ validateExtension 报错', () => {
    // 改清单，把 skills 写成含路径穿越的名字。
    writeFileSync(join(pack.dir, 'extension.json'), JSON.stringify({
      formatVersion: 1, id: pack.id, version: '1.0.0', name: 'Test Pack',
      contents: { presets: [], skills: ['../evil'], mcp: [] },
    }), 'utf8')
    const scan = scanExtensionPack(pack.dir)
    expect(scan.errors.some(e => e.field === 'contents.skills' && e.message.includes('../evil'))).toBe(true)
    // 不安全名字不能被拼成实体路径——否则 join 会穿到包外，扫描器会去读包外文件。
    expect(scan.skills).toHaveLength(0)
  })

  it('dangling ui.plugin 引用 ⇒ error', () => {
    // 给包加一个 ui 声明，plugin 指向不存在的插件名。
    mkdirSync(join(pack.dir, 'ui'), { recursive: true })
    writeFileSync(join(pack.dir, 'ui', 'my-ui.json'), JSON.stringify({
      name: 'my-ui',
      plugin: 'nonexistent-plugin',
      slot: 'sidebar',
    }), 'utf8')
    // 清单 contents 里登记。
    const manifest = JSON.parse(readFileSync(join(pack.dir, 'extension.json'), 'utf8'))
    manifest.contents.ui = ['my-ui']
    writeFileSync(join(pack.dir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8')

    const scan = scanExtensionPack(pack.dir)
    expect(scan.errors.some(e => e.field === 'contents.ui.my-ui.plugin' && e.message.includes('dangling'))).toBe(true)
  })

  it('importSkill 指向未知技能 ⇒ error', () => {
    const manifest = JSON.parse(readFileSync(join(pack.dir, 'extension.json'), 'utf8'))
    manifest.importSkill = 'unknown-skill'
    writeFileSync(join(pack.dir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8')
    const scan = scanExtensionPack(pack.dir)
    expect(scan.errors.some(e => e.field === 'importSkill' && e.message.includes('unknown-skill'))).toBe(true)
  })
})

// ── 3. install 到干净 home ───────────────────────────────────────────

describe('installExtensionPack — 干净 home 安装', () => {
  it('两个预设落盘、shared-skill 只一份、lone-skill 独立、注册表只有一个 mcp、agent.json 含 moduleSource', () => {
    const result = installExtensionPack({ sourceDir: pack.dir, home })

    // 两个预设都落盘。
    expect(result.presets.map(p => p.id).sort()).toEqual(['alpha', 'beta'])
    for (const p of result.presets) {
      const agentPath = join(home, '.agent-presets', p.profileId, 'agent.json')
      expect(existsSync(agentPath)).toBe(true)
      const agent = JSON.parse(readFileSync(agentPath, 'utf8'))
      // agent.json 仍按名引用 shared-skill / shared-mcp。
      expect(agent.skills.some((s: { name: string }) => s.name === 'shared-skill')).toBe(true)
      expect(agent.mcpServers).toContain('shared-mcp')
      // 含 moduleSource 来源标记（installProfileModule 写的）。
      expect(agent.moduleSource).toBeDefined()
      expect(agent.moduleSource.kind).toBe('module')
    }

    // shared-skill 只存在一份（两个预设都引用它，但技能按名落盘只一份）。
    expect(existsSync(join(home, 'skills', 'shared-skill', 'SKILL.md'))).toBe(true)
    // lone-skill 也独立安装（standalone 技能仍装）。
    expect(existsSync(join(home, 'skills', 'lone-skill', 'SKILL.md'))).toBe(true)

    // 注册表里只有一个 shared-mcp。
    const reg = JSON.parse(readFileSync(join(home, 'mcp-servers.json'), 'utf8'))
    expect(reg.servers.length).toBe(1)
    expect(reg.servers[0].name).toBe('shared-mcp')
    // 绝不写 requires 进注册表（§4 硬事实）。
    expect(reg.servers[0]).not.toHaveProperty('requires')

    // 技能安装情况：两个都装了。
    expect([...result.skills.installed].sort()).toEqual(['lone-skill', 'shared-skill'])
    expect(result.skills.skipped).toHaveLength(0)
    // MCP：shared-mcp applied。
    expect(result.mcp.applied).toEqual(['shared-mcp'])
    expect(result.mcp.kept).toHaveLength(0)
  })
})

// ── 3a. install 预设头像：从 agent.json 复制包内文件并转成 dataURL ──────

describe('installExtensionPack — 预设头像', () => {
  function setAlphaAvatar(avatar: string): void {
    const agentPath = join(pack.dir, 'presets', 'alpha', 'agent.json')
    const agent = JSON.parse(readFileSync(agentPath, 'utf8'))
    agent.avatar = avatar
    writeFileSync(agentPath, JSON.stringify(agent, null, 2), 'utf8')
  }

  it('agent.json 指向包根 assets/avatar.png 时，安装后头像为 PNG dataURL', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
    mkdirSync(join(pack.dir, 'assets'), { recursive: true })
    writeFileSync(join(pack.dir, 'assets', 'avatar.png'), png)
    setAlphaAvatar('assets/avatar.png')

    installExtensionPack({ sourceDir: pack.dir, home })

    const installed = JSON.parse(readFileSync(join(home, '.agent-presets', 'alpha', 'agent.json'), 'utf8'))
    expect(installed.avatar).toMatch(/^data:image\/png;base64,/)
    expect(installed.avatar).toBe(`data:image/png;base64,${png.toString('base64')}`)
  })

  it('avatar 路径逃出扩展包根时不复制包外文件，保留无头像行为', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'corum-extension-outside-'))
    try {
      writeFileSync(join(outsideDir, 'avatar.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      setAlphaAvatar(relative(pack.dir, join(outsideDir, 'avatar.png')))

      installExtensionPack({ sourceDir: pack.dir, home })

      const installed = JSON.parse(readFileSync(join(home, '.agent-presets', 'alpha', 'agent.json'), 'utf8'))
      expect(installed.avatar).toBe(relative(pack.dir, join(outsideDir, 'avatar.png')))
      expect(installed.avatar).not.toMatch(/^data:/)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('avatar 指向不存在的包内文件时保留无头像行为', () => {
    setAlphaAvatar('assets/missing.png')

    installExtensionPack({ sourceDir: pack.dir, home })

    const installed = JSON.parse(readFileSync(join(home, '.agent-presets', 'alpha', 'agent.json'), 'utf8'))
    expect(installed.avatar).toBe('assets/missing.png')
  })
})

// ── 4. install 幂等 ──────────────────────────────────────────────────

describe('installExtensionPack — 幂等', () => {
  it('第二次同输入：skills skipped / mcp kept、不重复', () => {
    // 第一次安装（默认冲突策略：skills skip 不存在时直接装、mcp keep 不存在时直接写）。
    installExtensionPack({ sourceDir: pack.dir, home })

    // 第二次：现在 home 里已有同名技能/MCP/预设。
    // 默认 conflict：skills→skip、mcp→keep、profile→skip。
    const result = installExtensionPack({ sourceDir: pack.dir, home })

    // 技能全部 skipped（同名已存在，默认 skip）。
    expect(result.skills.installed).toHaveLength(0)
    expect([...result.skills.skipped].sort()).toEqual(['lone-skill', 'shared-skill'])

    // MCP kept（注册表已有同名，默认 keep）。
    expect(result.mcp.applied).toHaveLength(0)
    expect(result.mcp.kept).toEqual(['shared-mcp'])

    // 预设 skipped（profile 默认 skip）。
    expect(result.presets.every(p => p.skipped)).toBe(true)

    // 注册表里仍然只有一个 shared-mcp（没有重复）。
    const reg = JSON.parse(readFileSync(join(home, 'mcp-servers.json'), 'utf8'))
    expect(reg.servers.length).toBe(1)

    // 技能目录仍然各只一份。
    expect(existsSync(join(home, 'skills', 'shared-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, 'skills', 'lone-skill', 'SKILL.md'))).toBe(true)
  })
})

// ── 5. install .zip 来源 ─────────────────────────────────────────────

describe('installExtensionPack — .zip 来源', () => {
  it('先 pack 再装，落点与目录来源一致', () => {
    // 把 pack.dir 打包成 zip。
    const zipPath = join(home, 'test-pack.zip')
    packModuleArchive(pack.dir, zipPath)
    expect(existsSync(zipPath)).toBe(true)

    const result = installExtensionPack({ sourceDir: zipPath, home })

    // 两个预设都落盘。
    expect(result.presets.map(p => p.id).sort()).toEqual(['alpha', 'beta'])
    expect(existsSync(join(home, '.agent-presets', 'alpha', 'agent.json'))).toBe(true)
    expect(existsSync(join(home, '.agent-presets', 'beta', 'agent.json'))).toBe(true)
    // 技能 + MCP。
    expect(existsSync(join(home, 'skills', 'shared-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, 'skills', 'lone-skill', 'SKILL.md'))).toBe(true)
    const reg = JSON.parse(readFileSync(join(home, 'mcp-servers.json'), 'utf8'))
    expect(reg.servers.some((s: { name: string }) => s.name === 'shared-mcp')).toBe(true)
  })
})

// ── 6. plugins/themes/ui 返回 deferred ───────────────────────────────

describe('installExtensionPack — deferred 类', () => {
  it('声明 plugins/themes/ui 时返回 deferred 三项且不安装', () => {
    // 加一个合法 plugin 声明。
    mkdirSync(join(pack.dir, 'plugins'), { recursive: true })
    const pluginName = 'my-plugin'
    const pluginDecl = {
      name: pluginName,
      spec: 'test-spec',
      mode: 'permanent',
      bundle: true,
    }
    // 先校验我们的夹具 decl 是合法的（validatePluginDecl 0 错）。
    expect(validatePluginDecl(pluginDecl)).toHaveLength(0)
    writeFileSync(join(pack.dir, 'plugins', `${pluginName}.json`), JSON.stringify(pluginDecl, null, 2), 'utf8')

    // 加一个合法 theme zip（空文件即可，扫描只校验存在）。
    mkdirSync(join(pack.dir, 'themes'), { recursive: true })
    writeFileSync(join(pack.dir, 'themes', 'my-theme.zip'), Buffer.from([0x50, 0x4b, 0x05, 0x06]))

    // 加一个合法 ui 声明，plugin 指向上面的 pluginName。
    mkdirSync(join(pack.dir, 'ui'), { recursive: true })
    const uiDecl = {
      name: 'my-ui',
      plugin: pluginName,
      slot: 'sidebar',
    }
    expect(validateUiDecl(uiDecl)).toHaveLength(0)
    writeFileSync(join(pack.dir, 'ui', 'my-ui.json'), JSON.stringify(uiDecl, null, 2), 'utf8')

    // 清单 contents 登记三类。
    const manifest = JSON.parse(readFileSync(join(pack.dir, 'extension.json'), 'utf8'))
    manifest.contents.plugins = [pluginName]
    manifest.contents.themes = ['my-theme']
    manifest.contents.ui = ['my-ui']
    writeFileSync(join(pack.dir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8')

    // 先确认扫描 0 错（三类 decl 都合法）。
    const scan = scanExtensionPack(pack.dir)
    expect(scan.errors, scan.errors.map(e => `${e.field}: ${e.message}`).join('; ')).toHaveLength(0)

    const result = installExtensionPack({ sourceDir: pack.dir, home })

    // deferred 三项齐全。
    expect(result.deferred.map(d => d.kind).sort()).toEqual(['plugins', 'themes', 'ui'])
    const pluginsDeferred = result.deferred.find(d => d.kind === 'plugins')!
    expect(pluginsDeferred.names).toEqual([pluginName])
    const themesDeferred = result.deferred.find(d => d.kind === 'themes')!
    expect(themesDeferred.names).toEqual(['my-theme'])
    const uiDeferred = result.deferred.find(d => d.kind === 'ui')!
    expect(uiDeferred.names).toEqual(['my-ui'])

    // 没有把插件/themes/ui 装进 home（本轮不安装）。
    // home 下不应该有 entries.json（那是 P3/P4 的插件挂载产物）。
    expect(existsSync(join(home, 'entries.json'))).toBe(false)
  })
})

// ── 7. scan.errors 非空 ⇒ install 抛错且不安装 ───────────────────────

describe('installExtensionPack — fail-loud on scan errors', () => {
  it('scan 有 errors 时抛错，home 里没有 .agent-presets', () => {
    // 破坏清单：删掉 shared-skill 目录 ⇒ scan 报实体缺失。
    rmSync(join(pack.dir, 'skills', 'shared-skill'), { recursive: true, force: true })

    expect(() => installExtensionPack({ sourceDir: pack.dir, home })).toThrow(/扫描失败|拒绝安装/)

    // 没有装任何东西——home 下没有 .agent-presets。
    expect(existsSync(join(home, '.agent-presets'))).toBe(false)
    // 也没有 skills（install 在 scan 之后才装技能，scan 失败直接 throw）。
    expect(existsSync(join(home, 'skills'))).toBe(false)
  })
})

// ── 8. 冲突策略（评审补充：overwrite / rename 分支此前零覆盖） ─────────

describe('installExtensionPack — 冲突策略', () => {
  it('skills overwrite：已存在的同名技能被替换', () => {
    mkdirSync(join(home, 'skills', 'shared-skill'), { recursive: true })
    writeFileSync(join(home, 'skills', 'shared-skill', 'SKILL.md'), 'OLD CONTENT', 'utf8')

    const result = installExtensionPack({
      sourceDir: pack.dir,
      home,
      conflict: { skills: { 'shared-skill': 'overwrite' } },
    })

    expect(result.skills.installed).toContain('shared-skill')
    expect(result.skills.skipped).not.toContain('shared-skill')
    expect(readFileSync(join(home, 'skills', 'shared-skill', 'SKILL.md'), 'utf8')).not.toBe('OLD CONTENT')
  })

  it('mcp overwrite：已存在的同名服务被新配置替换', () => {
    writeFileSync(join(home, 'mcp-servers.json'), JSON.stringify({
      servers: [{ name: 'shared-mcp', transport: 'stdio', command: 'OLD' }],
    }), 'utf8')

    const result = installExtensionPack({
      sourceDir: pack.dir,
      home,
      conflict: { mcp: { 'shared-mcp': 'overwrite' } },
    })

    expect(result.mcp.applied).toContain('shared-mcp')
    expect(result.mcp.kept).not.toContain('shared-mcp')
    const reg = JSON.parse(readFileSync(join(home, 'mcp-servers.json'), 'utf8'))
    const server = reg.servers.find((s: { name: string }) => s.name === 'shared-mcp')
    expect(server.command).toBe('npx')
  })

  it('profile rename：第二次安装改名为 <id>-2', () => {
    installExtensionPack({ sourceDir: pack.dir, home })
    const result = installExtensionPack({ sourceDir: pack.dir, home, conflict: { profile: 'rename' } })

    const alpha = result.presets.find(p => p.id === 'alpha')
    expect(alpha?.profileId).toBe('alpha-2')
    expect(existsSync(join(home, '.agent-presets', 'alpha-2', 'agent.json'))).toBe(true)
  })
})

// ── 9. zip 根下降逻辑（评审补充：此前只测了「根就是包根」） ─────────────

describe('installExtensionPack — zip 根形态', () => {
  it('zip 根多一层子目录 ⇒ 自动下降', () => {
    const wrapper = join(home, "wrapper")
    mkdirSync(wrapper, { recursive: true })
    cpSync(pack.dir, join(wrapper, 'inner'), { recursive: true })
    const zipPath = join(home, 'wrapped.zip')
    packModuleArchive(wrapper, zipPath)

    const result = installExtensionPack({ sourceDir: zipPath, home })
    expect(result.presets.map(p => p.id).sort()).toEqual(['alpha', 'beta'])
    expect(existsSync(join(home, '.agent-presets', 'alpha', 'agent.json'))).toBe(true)
  })

  it('zip 根有两个候选子目录 ⇒ 不下降（scan 报错并拒绝安装）', () => {
    const wrapper = join(home, "wrapper2")
    mkdirSync(wrapper, { recursive: true })
    cpSync(pack.dir, join(wrapper, 'a'), { recursive: true })
    cpSync(pack.dir, join(wrapper, 'b'), { recursive: true })
    const zipPath = join(home, 'wrapped2.zip')
    packModuleArchive(wrapper, zipPath)

    expect(() => installExtensionPack({ sourceDir: zipPath, home })).toThrow(/扫描失败|拒绝安装/)
    expect(existsSync(join(home, '.agent-presets'))).toBe(false)
  })
})

// ── 10. streamable-http MCP（评审补充：此前只测 stdio） ────────────────

describe('installExtensionPack — streamable-http MCP', () => {
  it('按 url/headers 落库，且绝不带 requires', () => {
    const url = 'http://127.0.0.1:19999/mcp'
    writeFileSync(join(pack.dir, 'mcp', 'shared-mcp.json'), JSON.stringify({
      name: 'shared-mcp',
      transport: 'streamable-http',
      url,
      headers: { Authorization: 'Bearer test-token' },
      requires: { kind: 'service', url, hint: '先启动本地服务' },
    }), 'utf8')

    const scan = scanExtensionPack(pack.dir)
    expect(scan.errors, scan.errors.map(e => `${e.field}: ${e.message}`).join('; ')).toHaveLength(0)

    installExtensionPack({ sourceDir: pack.dir, home })

    const reg = JSON.parse(readFileSync(join(home, 'mcp-servers.json'), 'utf8'))
    const server = reg.servers.find((s: { name: string }) => s.name === 'shared-mcp')
    expect(server.transport).toBe('streamable-http')
    expect(server.url).toBe(url)
    expect(server.headers).toEqual({ Authorization: 'Bearer test-token' })
    expect(server).not.toHaveProperty('requires')
  })
})

// ── 11. 跨文件引用校验（评审补充：decl.name / ui.replaces 此前零覆盖） ──

describe('scanExtensionPack — 跨文件引用', () => {
  /** 往包里登记一个内容类（重写 extension.json 的 contents）。 */
  function registerContents(patch: Record<string, unknown>): void {
    const manifest = JSON.parse(readFileSync(join(pack.dir, 'extension.json'), 'utf8'))
    Object.assign(manifest.contents, patch)
    writeFileSync(join(pack.dir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }

  it('plugin 声明 name 与文件名 stem 不一致 ⇒ error', () => {
    mkdirSync(join(pack.dir, 'plugins'), { recursive: true })
    writeFileSync(join(pack.dir, 'plugins', 'foo.json'), JSON.stringify({
      name: 'bar', spec: 'x', mode: 'permanent', bundle: true,
    }), 'utf8')
    registerContents({ plugins: ['foo'] })

    const scan = scanExtensionPack(pack.dir)
    expect(scan.errors.some(e => e.field === 'contents.plugins.foo.name' && e.message.includes('不一致'))).toBe(true)
  })

  it('ui.replaces 指向不存在的 ui ⇒ dangling error', () => {
    mkdirSync(join(pack.dir, 'plugins'), { recursive: true })
    writeFileSync(join(pack.dir, 'plugins', 'p1.json'), JSON.stringify({
      name: 'p1', spec: 'x', mode: 'permanent', bundle: true,
    }), 'utf8')
    mkdirSync(join(pack.dir, 'ui'), { recursive: true })
    writeFileSync(join(pack.dir, 'ui', 'u1.json'), JSON.stringify({
      name: 'u1', plugin: 'p1', slot: 'corum.editor', replaces: ['nope'],
    }), 'utf8')
    registerContents({ plugins: ['p1'], ui: ['u1'] })

    const scan = scanExtensionPack(pack.dir)
    expect(scan.errors.some(e => e.field === 'contents.ui.u1.replaces' && e.message.includes('dangling'))).toBe(true)
  })
})
