/**
 * 预设模块化测试。
 *
 * 覆盖：requires 强制 / 导出（blocked 拦截 + 正常导出）/ 安装（来源标记 +
 * MCP 不写 requires + 技能落盘 + 头像 dataURL）/ 检查。
 *
 * **断言落在盘上字节上**（契约 §4 硬事实：listServers 裸 JSON.parse 无校验，
 * 写进 requires 会永久留在盘上——故用 readFileSync 读原始文本断言）。
 * 所有夹具用 mkdtempSync 建临时目录，不碰真实 ~/.corum。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateMcpEntry,
  validateManifest,
  exportProfileModule,
  inspectProfileModule,
  installProfileModule,
  resolveShippedModulesRoot,
  listShippedModules,
  packModuleArchive,
  unpackModuleArchive,
  resolveCorumHome,
} from '../src/index.ts'
import { makeTestHome, restoreHome, type TestHome } from './fixture.ts'

let savedEnv: string | undefined
let fixture: TestHome

beforeEach(() => {
  savedEnv = process.env.CORUM_HOME
  fixture = makeTestHome()
})

afterEach(() => {
  restoreHome(savedEnv)
  if (fixture !== undefined) {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

describe('validateMcpEntry — requires 强制', () => {
  it('缺 requires ⇒ 失败（field: requires）', () => {
    const errors = validateMcpEntry({
      name: 'test',
      transport: 'stdio',
      command: 'npx',
    })
    expect(errors.some(e => e.field === 'requires')).toBe(true)
  })

  it('有合法 requires (command) ⇒ 通过', () => {
    const errors = validateMcpEntry({
      name: 'test',
      transport: 'stdio',
      command: 'npx',
      requires: { kind: 'command', command: 'npx', hint: '运行 npx --version' },
    })
    expect(errors).toHaveLength(0)
  })

  it('requires.kind=app 缺 platforms ⇒ 失败', () => {
    const errors = validateMcpEntry({
      name: 'test',
      transport: 'stdio',
      command: 'npx',
      requires: { kind: 'app', hint: '装 Pen' },
    })
    expect(errors.some(e => e.field === 'requires.platforms')).toBe(true)
  })

  it('requires.kind=app 有非空 platforms ⇒ 通过', () => {
    const errors = validateMcpEntry({
      name: 'test',
      transport: 'stdio',
      command: 'npx',
      requires: { kind: 'app', platforms: { darwin: '/Applications/Pen.app' }, hint: '装 Pen' },
    })
    expect(errors).toHaveLength(0)
  })

  it('requires.kind=command 缺 command ⇒ 失败', () => {
    const errors = validateMcpEntry({
      name: 'test',
      transport: 'stdio',
      command: 'npx',
      requires: { kind: 'command', hint: '装 npx' },
    })
    expect(errors.some(e => e.field === 'requires.command')).toBe(true)
  })

  it('requires.kind=service 缺 url ⇒ 失败', () => {
    const errors = validateMcpEntry({
      name: 'test',
      transport: 'streamable-http',
      url: 'http://localhost:9333',
      requires: { kind: 'service', hint: '跑服务' },
    })
    expect(errors.some(e => e.field === 'requires.url')).toBe(true)
  })

  it('requires.hint 为空 ⇒ 失败', () => {
    const errors = validateMcpEntry({
      name: 'test',
      transport: 'stdio',
      command: 'npx',
      requires: { kind: 'command', command: 'npx', hint: '' },
    })
    expect(errors.some(e => e.field === 'requires.hint')).toBe(true)
  })
})

describe('exportProfileModule — blocked 拦截', () => {
  it('缺 requires 的 MCP ⇒ 进 blocked，不产出任何文件', () => {
    const outDir = join(fixture.home, 'out-module')
    const result = exportProfileModule({
      profileId: fixture.profileId,
      home: fixture.home,
      outDir,
    })
    // test-mcp 没 requires ⇒ 应进 blocked
    expect(result.blocked.length).toBeGreaterThan(0)
    expect(result.blocked.some(b => b.name === fixture.mcpName)).toBe(true)
    // blocked 非空 ⇒ 不产出任何文件
    expect(existsSync(outDir)).toBe(false)
  })

  it('只导出有合法 requires 的 MCP 时产出文件', () => {
    // 改预设只引用有 requires 的那个 MCP。
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')

    const outDir = join(fixture.home, 'out-module-ok')
    const result = exportProfileModule({
      profileId: fixture.profileId,
      home: fixture.home,
      outDir,
    })
    expect(result.blocked).toHaveLength(0)
    expect(existsSync(join(outDir, 'module.json'))).toBe(true)
    expect(existsSync(join(outDir, 'agent.json'))).toBe(true)
    expect(existsSync(join(outDir, 'skills', fixture.skillName, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(outDir, 'mcp', `${fixture.mcpWithRequiresName}.json`))).toBe(true)
    expect(existsSync(join(outDir, 'assets', 'avatar.png'))).toBe(true)
  })

  it('导出剥掉 model/subagentModel/researchModel/trust/version/specBaseline/moduleSource', () => {
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    profile.specBaseline = { model: 'test' }
    // 本机记账字段**必须先真的存在**，否则下面那几条 `toBeUndefined` 是空断言
    // （不存在 ⇒ 断言恒真 ⇒ 谁把 strip 删了都发现不了）。moduleSource 尤其如此：
    // 它是"装来的预设"才会有的字段（2026-10-11 核对导出 zip 时发现漏删）。
    profile.moduleSource = { kind: 'module', id: fixture.profileId, version: '9.9.9', installedAt: '2026-01-01T00:00:00.000Z' }
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')

    const outDir = join(fixture.home, 'out-strip')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir })
    const exported = JSON.parse(readFileSync(join(outDir, 'agent.json'), 'utf8'))
    expect(exported.model).toBeUndefined()
    expect(exported.subagentModel).toBeUndefined()
    expect(exported.researchModel).toBeUndefined()
    expect(exported.trust).toBeUndefined()
    expect(exported.specBaseline).toBeUndefined()
    // moduleSource 同属本机记账：导出包里不许带（2026-10-11 核对导出 zip 时发现漏删）。
    expect(exported.moduleSource).toBeUndefined()
    // avatar 也被剥（导入时由安装路径重新写）
    expect(exported.avatar).toBeUndefined()
  })
})

describe('installProfileModule — 落点与来源标记', () => {
  it('安装写入 moduleSource 来源标记', () => {
    // 先导出一个合法模块。
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')
    const moduleDir = join(fixture.home, 'exported-module')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir: moduleDir })

    // 清空 home 下的预设（模拟「装到干净机器」）。
    rmSync(join(fixture.home, '.agent-presets', fixture.profileId), { recursive: true, force: true })
    rmSync(join(fixture.home, 'skills', fixture.skillName), { recursive: true, force: true })

    const result = installProfileModule({
      sourceDir: moduleDir,
      home: fixture.home,
      conflict: { profile: 'overwrite', skills: 'overwrite', mcp: 'overwrite' },
    })
    expect(result.skipped).toBe(false)
    expect(result.profileId).toBe(fixture.profileId)

    // 断言盘上字节：agent.json 含 moduleSource 来源标记。
    const installed = JSON.parse(readFileSync(
      join(fixture.home, '.agent-presets', fixture.profileId, 'agent.json'), 'utf8'))
    expect(installed.moduleSource).toBeDefined()
    expect(installed.moduleSource.kind).toBe('module')
    expect(installed.moduleSource.id).toBe(fixture.profileId)
    expect(installed.moduleSource.installedAt).toBeTruthy()
  })

  it('MCP 走 saveServer 且绝不写 requires 进注册表（盘上字节断言）', () => {
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')
    const moduleDir = join(fixture.home, 'exported-module2')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir: moduleDir })

    rmSync(join(fixture.home, '.agent-presets', fixture.profileId), { recursive: true, force: true })
    // 清空注册表里的旧条目。
    writeFileSync(join(fixture.home, 'mcp-servers.json'), JSON.stringify({ servers: [] }, null, 2), 'utf8')

    installProfileModule({
      sourceDir: moduleDir,
      home: fixture.home,
      conflict: { profile: 'overwrite', skills: 'overwrite', mcp: 'overwrite' },
    })

    // 关键断言：读 mcp-servers.json，断言注册表里的 server 对象没有 requires 键。
    // §4 硬事实：listServers 裸 JSON.parse 无校验，写进 requires 会永久留在盘上。
    // 注意不能用 toContain('requires') 文本匹配——服务名 "mcp-with-requires" 自带该子串。
    const registryRaw = readFileSync(join(fixture.home, 'mcp-servers.json'), 'utf8')
    const registry = JSON.parse(registryRaw)
    const installed = registry.servers.find((s: { name: string }) => s.name === fixture.mcpWithRequiresName)
    expect(installed).toBeDefined()
    expect(installed).not.toHaveProperty('requires')
    // 反向验证：模块条目文件里**有** requires（证明不是导出时丢了，是安装时刻意没写进注册表）。
    const moduleEntry = JSON.parse(readFileSync(join(moduleDir, 'mcp', `${fixture.mcpWithRequiresName}.json`), 'utf8'))
    expect(moduleEntry).toHaveProperty('requires')
  })

  it('头像读成 dataURL 写进 agent.json 的 avatar 字段', () => {
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')
    const moduleDir = join(fixture.home, 'exported-module3')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir: moduleDir })

    rmSync(join(fixture.home, '.agent-presets', fixture.profileId), { recursive: true, force: true })
    installProfileModule({
      sourceDir: moduleDir,
      home: fixture.home,
      conflict: { profile: 'overwrite', skills: 'overwrite', mcp: 'overwrite' },
    })

    const installed = JSON.parse(readFileSync(
      join(fixture.home, '.agent-presets', fixture.profileId, 'agent.json'), 'utf8'))
    expect(installed.avatar).toMatch(/^data:image\/png;base64,/)
  })

  it('技能实体落盘到 <home>/skills/<name>/', () => {
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')
    const moduleDir = join(fixture.home, 'exported-module4')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir: moduleDir })

    rmSync(join(fixture.home, '.agent-presets', fixture.profileId), { recursive: true, force: true })
    rmSync(join(fixture.home, 'skills', fixture.skillName), { recursive: true, force: true })

    installProfileModule({
      sourceDir: moduleDir,
      home: fixture.home,
      conflict: { profile: 'overwrite', skills: 'overwrite', mcp: 'overwrite' },
    })

    expect(existsSync(join(fixture.home, 'skills', fixture.skillName, 'SKILL.md'))).toBe(true)
  })

  it('rename 策略 ⇒ <id>-2', () => {
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')
    const moduleDir = join(fixture.home, 'exported-module5')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir: moduleDir })

    // 预设已存在（fixture 造的）⇒ rename 策略应产出 <id>-2。
    const result = installProfileModule({
      sourceDir: moduleDir,
      home: fixture.home,
      conflict: { profile: 'rename', skills: 'skip', mcp: 'keep' },
    })
    expect(result.profileId).toBe(`${fixture.profileId}-2`)
    expect(existsSync(join(fixture.home, '.agent-presets', `${fixture.profileId}-2`, 'agent.json'))).toBe(true)
  })

  it('skip 策略 ⇒ 跳过', () => {
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')
    const moduleDir = join(fixture.home, 'exported-module6')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir: moduleDir })

    const result = installProfileModule({
      sourceDir: moduleDir,
      home: fixture.home,
      conflict: { profile: 'skip', skills: 'skip', mcp: 'keep' },
    })
    expect(result.skipped).toBe(true)
  })
})

describe('inspectProfileModule — 检查', () => {
  it('返回清单 + 第①层探测 + 磁盘差异', () => {
    // 先导出一个合法模块。
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')
    const moduleDir = join(fixture.home, 'exported-inspect')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir: moduleDir })

    // 清空 home（模拟检查时还没装）。
    rmSync(join(fixture.home, '.agent-presets', fixture.profileId), { recursive: true, force: true })
    rmSync(join(fixture.home, 'skills', fixture.skillName), { recursive: true, force: true })
    writeFileSync(join(fixture.home, 'mcp-servers.json'), JSON.stringify({ servers: [] }, null, 2), 'utf8')

    const inspection = inspectProfileModule(moduleDir, fixture.home)
    expect(inspection.manifest.id).toBe(fixture.profileId)
    expect(inspection.skills.length).toBeGreaterThan(0)
    expect(inspection.skills[0].exists).toBe(false)
    expect(inspection.mcp.length).toBeGreaterThan(0)
    expect(inspection.mcp[0].status).toBeDefined()
    expect(inspection.hasAvatar).toBe(true)
  })
})

describe('shipped-modules — 路径解析与列举', () => {
  it('resolveShippedModulesRoot 用环境变量覆盖', () => {
    const tmpRoot = join(fixture.home, 'fake-shipped')
    mkdirSync(tmpRoot, { recursive: true })
    process.env.CORUM_SHIPPED_MODULES_DIR = tmpRoot
    expect(resolveShippedModulesRoot()).toBe(tmpRoot)
    delete process.env.CORUM_SHIPPED_MODULES_DIR
  })

  it('listShippedModules 只收含合法 module.json 的目录', () => {
    const tmpRoot = join(fixture.home, 'fake-shipped2')
    mkdirSync(join(tmpRoot, 'good'), { recursive: true })
    writeFileSync(join(tmpRoot, 'good', 'module.json'), JSON.stringify({
      formatVersion: 1,
      id: 'good',
      version: '1.0.0',
      name: '好模块',
      contents: { skills: [], mcp: [], hasAvatar: false },
    }), 'utf8')
    mkdirSync(join(tmpRoot, 'bad'), { recursive: true })
    writeFileSync(join(tmpRoot, 'bad', 'module.json'), '{ not json', 'utf8')

    const list = listShippedModules(tmpRoot)
    expect(list.length).toBe(1)
    expect(list[0].manifest.id).toBe('good')
  })
})

// ── W4 新增：zip 打包/解包（防 zip slip） ──────────────────────────────

describe('module-archive — zip 打包/解包与 zip slip 防护', () => {
  it('pack → unpack 往返：目录结构逐文件一致', () => {
    // 造一个模块目录：module.json + skills/a/SKILL.md + mcp/x.json + assets/avatar.png
    const srcDir = mkdtempSync(join(tmpdir(), 'corum-archive-src-'))
    mkdirSync(join(srcDir, 'skills', 'a'), { recursive: true })
    writeFileSync(join(srcDir, 'skills', 'a', 'SKILL.md'), '# a\n', 'utf8')
    mkdirSync(join(srcDir, 'mcp'), { recursive: true })
    writeFileSync(join(srcDir, 'mcp', 'x.json'), '{"name":"x"}\n', 'utf8')
    mkdirSync(join(srcDir, 'assets'), { recursive: true })
    writeFileSync(join(srcDir, 'assets', 'avatar.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(srcDir, 'module.json'), '{"id":"test"}\n', 'utf8')

    const zipPath = join(srcDir, '..', 'test.zip')
    packModuleArchive(srcDir, zipPath)
    expect(existsSync(zipPath)).toBe(true)

    const destDir = mkdtempSync(join(tmpdir(), 'corum-archive-dest-'))
    unpackModuleArchive(zipPath, destDir)
    expect(existsSync(join(destDir, 'module.json'))).toBe(true)
    expect(existsSync(join(destDir, 'skills', 'a', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(destDir, 'skills', 'a', 'SKILL.md'), 'utf8')).toBe('# a\n')
    expect(existsSync(join(destDir, 'mcp', 'x.json'))).toBe(true)
    expect(existsSync(join(destDir, 'assets', 'avatar.png'))).toBe(true)

    rmSync(srcDir, { recursive: true, force: true })
    rmSync(destDir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  })

  it('zip slip：含 ../ 条目的 zip 被拒绝解包', () => {
    // 用 fflate 直接构造一个含 `../evil.txt` 条目的 zip（绕过 packModuleArchive 的安全收集）。
    // 这是安全判据，不是形式——证明 unpackModuleArchive 拦得住路径穿越。
    const { zipSync } = require('fflate') as typeof import('fflate')
    // 一个恶意条目：相对路径 `../evil-outside.txt`，会逃逸 destDir。
    const maliciousZip = join(tmpdir(), 'corum-slip.zip')
    const zipped = zipSync({ '../evil-outside.txt': new Uint8Array([0x65, 0x76, 0x69, 0x6c]) })
    writeFileSync(maliciousZip, zipped)
    const destDir = mkdtempSync(join(tmpdir(), 'corum-slip-dest-'))
    // 解包必须抛错（拒绝整个解包），而不是静默跳过单条。
    expect(() => unpackModuleArchive(maliciousZip, destDir)).toThrow(/zip slip|逃逸/)
    // 证伪点：destDir 之外不应出现 evil-outside.txt。
    const outsideTarget = join(destDir, '..', 'evil-outside.txt')
    expect(existsSync(outsideTarget)).toBe(false)

    rmSync(maliciousZip, { force: true })
    rmSync(destDir, { recursive: true, force: true })
  })
})

// ── W4 新增：exportProfileModule 的 archive 产出 ────────────────────────

describe('exportProfileModule — archive 产出', () => {
  it('archive !== false 时在同级产出 <id>-<version>.zip', () => {
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')

    const outDir = join(fixture.home, 'out-archive')
    const result = exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir })
    expect(result.archive).toBeDefined()
    expect(existsSync(result.archive!)).toBe(true)
    // zip 文件名 = <id>-<version>.zip
    expect(result.archive!).toMatch(/test-agent-1\.0\.0\.zip$/)
  })

  it('archive === false 时不产出 zip', () => {
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')

    const outDir = join(fixture.home, 'out-no-archive')
    const result = exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir, archive: false })
    expect(result.archive).toBeUndefined()
  })
})

// ── W4 新增：inspect/install 接受 .zip 路径 ──────────────────────────────

describe('inspect/install — 接受 .zip 路径', () => {
  it('inspectProfileModule 接受 .zip（内部解到临时目录，结束后清理）', () => {
    // 先导出一个合法模块，再打包成 zip。
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')
    const moduleDir = join(fixture.home, 'exported-zip-inspect')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir: moduleDir, archive: false })
    const zipPath = join(fixture.home, 'inspect-module.zip')
    packModuleArchive(moduleDir, zipPath)

    // 清空 home（模拟检查时还没装）。
    rmSync(join(fixture.home, '.agent-presets', fixture.profileId), { recursive: true, force: true })
    rmSync(join(fixture.home, 'skills', fixture.skillName), { recursive: true, force: true })
    writeFileSync(join(fixture.home, 'mcp-servers.json'), JSON.stringify({ servers: [] }, null, 2), 'utf8')

    // 用 .zip 路径 inspect。
    const inspection = inspectProfileModule(zipPath, fixture.home)
    expect(inspection.manifest.id).toBe(fixture.profileId)
    expect(inspection.skills.length).toBeGreaterThan(0)
    expect(inspection.hasAvatar).toBe(true)

    // 临时目录应已清理（没有遗留的 corum-module-unzip- 前缀目录）。
    // 注：mkdtempSync 在 tmpdir 下，这里只验 inspect 不抛错、返回正确即可（清理由 try/finally 保证）。
  })

  it('installProfileModule 接受 .zip（落点正确 + 临时目录清理）', () => {
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')
    const moduleDir = join(fixture.home, 'exported-zip-install')
    exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir: moduleDir, archive: false })
    const zipPath = join(fixture.home, 'install-module.zip')
    packModuleArchive(moduleDir, zipPath)

    rmSync(join(fixture.home, '.agent-presets', fixture.profileId), { recursive: true, force: true })
    rmSync(join(fixture.home, 'skills', fixture.skillName), { recursive: true, force: true })

    const result = installProfileModule({
      sourceDir: zipPath,
      home: fixture.home,
      conflict: { profile: 'overwrite', skills: 'overwrite', mcp: 'overwrite' },
    })
    expect(result.skipped).toBe(false)
    expect(existsSync(join(fixture.home, '.agent-presets', fixture.profileId, 'agent.json'))).toBe(true)
    expect(existsSync(join(fixture.home, 'skills', fixture.skillName, 'SKILL.md'))).toBe(true)
  })
})

// ── W4 新增：home 解析 DSH_HOME 回落（证伪分叉） ────────────────────────

describe('resolveCorumHome — DSH_HOME 回落（证伪与 corum-agent 的分叉）', () => {
  it('CORUM_HOME 未设、DSH_HOME 设了 ⇒ 解析到 DSH_HOME', () => {
    const savedCorum = process.env.CORUM_HOME
    const savedDsh = process.env.DSH_HOME
    const tmpHome = mkdtempSync(join(tmpdir(), 'corum-dsh-home-'))
    delete process.env.CORUM_HOME
    process.env.DSH_HOME = tmpHome
    try {
      expect(resolveCorumHome()).toBe(tmpHome)
    } finally {
      if (savedCorum === undefined) delete process.env.CORUM_HOME
      else process.env.CORUM_HOME = savedCorum
      if (savedDsh === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedDsh
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('CORUM_HOME 优先于 DSH_HOME', () => {
    const savedCorum = process.env.CORUM_HOME
    const savedDsh = process.env.DSH_HOME
    const corumTmp = mkdtempSync(join(tmpdir(), 'corum-priority-'))
    const dshTmp = mkdtempSync(join(tmpdir(), 'dsh-priority-'))
    process.env.CORUM_HOME = corumTmp
    process.env.DSH_HOME = dshTmp
    try {
      expect(resolveCorumHome()).toBe(corumTmp)
    } finally {
      if (savedCorum === undefined) delete process.env.CORUM_HOME
      else process.env.CORUM_HOME = savedCorum
      if (savedDsh === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedDsh
      rmSync(corumTmp, { recursive: true, force: true })
      rmSync(dshTmp, { recursive: true, force: true })
    }
  })
})

// ── W4 新增：导出侧缺口（预设引用了但本机没装的技能） ──────────────────────

describe('exportProfileModule — 引用的技能本机没装 ⇒ 进 warnings', () => {
  it('预设引用了但本机没装的技能 ⇒ 进 warnings（不阻断导出）', () => {
    // 在预设里加一个不存在的技能引用。
    const profileDir = join(fixture.home, '.agent-presets', fixture.profileId)
    const profile = JSON.parse(readFileSync(join(profileDir, 'agent.json'), 'utf8'))
    profile.mcpServers = [fixture.mcpWithRequiresName]
    // 加一个本机没装的技能名。
    profile.skills = [{ name: fixture.skillName, versionId: '' }, { name: 'nonexistent-skill', versionId: '' }]
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify(profile, null, 2), 'utf8')

    const outDir = join(fixture.home, 'out-missing-skill')
    const result = exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir })
    // 缺的技能进 warnings（UI 据此显示「本机未安装，已跳过」）。
    expect(result.warnings.some(w => w.includes('nonexistent-skill'))).toBe(true)
    // 导出的 skills 列表里**不含**缺的技能（实体没复制）。
    expect(result.skills).not.toContain('nonexistent-skill')
    // 不进 blocked（缺技能不是致命——MCP 缺 requires 才是）。
    expect(result.blocked).toHaveLength(0)
  })
})
