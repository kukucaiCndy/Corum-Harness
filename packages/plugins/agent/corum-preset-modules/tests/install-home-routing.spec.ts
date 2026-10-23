/**
 * 安装落点一致性回归（extension-pack P0 缺陷）。
 *
 * 缺陷：`installProfileModule(input)` 文档承诺把预设/技能/MCP 全部装进 `input.home`，
 * 技能与预设早就走 `homeRoot`，但 `saveServer` 旧实现只读 `process.env.CORUM_HOME`。
 * 后果：`CORUM_HOME=homeA` 时调 `installProfileModule({ home: homeB })`，
 * 技能落进 homeB 但注册表落进 homeA——安装拆成两棵树。
 *
 * 修法：给 `saveServer` 透传 `homeRoot`。本组断言注册表与技能**同根**（homeB），
 * 且 homeA（=CORUM_HOME）的注册表**不含**该服务（这条在旧代码上会失败）。
 *
 * 夹具与模块布局复用 preset-modules.spec.ts / fixture.ts 的既有形态：
 * `makeTestHome()` 造 homeA 并设进 `CORUM_HOME`；模块目录 = module.json + agent.json +
 * mcp/<name>.json（带合法 requires）+ skills/<name>/SKILL.md。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installProfileModule } from '../src/index.ts'
import { makeTestHome, restoreHome, type TestHome } from './fixture.ts'

let savedEnv: string | undefined
let fixture: TestHome
/** 显式 input.home——与 CORUM_HOME(homeA) 不同，才能暴露「写错根」。 */
let homeB: string
/** 模块目录（sourceDir）。 */
let moduleDir: string

const MCP_NAME = 'home-routing-mcp'
const SKILL_NAME = 'home-routing-skill'
const PROFILE_ID = 'home-routing-agent'

beforeEach(() => {
  savedEnv = process.env.CORUM_HOME
  // makeTestHome 造 homeA 并设进 CORUM_HOME（与既有测试同形态）。
  // 注意：fixture 默认在 homeA 的注册表里预置 test-mcp / mcp-with-requires 两条，
  // 故模块里的 MCP/SKILL/PROFILE 名字要与 fixture 默认值**不同**——否则 homeA 早就
  // 含同名服务，「不该含它」的断言会被预置数据污染（与安装落点无关）。
  fixture = makeTestHome()
  homeB = mkdtempSync(join(tmpdir(), 'corum-install-homeB-'))

  // 造一个最小合法模块目录（复用 preset-modules.spec.ts 里 archive 测试的布局）。
  moduleDir = mkdtempSync(join(tmpdir(), 'corum-install-module-'))
  // module.json：formatVersion=1、合法 id、version、name、contents。
  writeFileSync(join(moduleDir, 'module.json'), JSON.stringify({
    formatVersion: 1,
    id: PROFILE_ID,
    version: '1.0.0',
    name: '落点回归模块',
    contents: { skills: [SKILL_NAME], mcp: [MCP_NAME], hasAvatar: false },
  }), 'utf8')
  // agent.json：预设本体（install 会读它）。
  writeFileSync(join(moduleDir, 'agent.json'), JSON.stringify({
    id: PROFILE_ID,
    nickname: '落点回归 Agent',
    baseMode: 'standard',
    prompt: '测试落点一致性',
  }), 'utf8')
  // mcp/<name>.json：必须带合法 requires（validateMcpEntry 强制）。
  mkdirSync(join(moduleDir, 'mcp'), { recursive: true })
  writeFileSync(join(moduleDir, 'mcp', `${MCP_NAME}.json`), JSON.stringify({
    name: MCP_NAME,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@test/routing'],
    requires: { kind: 'command', command: 'npx', hint: '运行 npx --version' },
  }), 'utf8')
  // skills/<name>/SKILL.md：技能实体（证明技能与 MCP 同根）。
  mkdirSync(join(moduleDir, 'skills', SKILL_NAME), { recursive: true })
  writeFileSync(join(moduleDir, 'skills', SKILL_NAME, 'SKILL.md'), '---\ndescription: 落点技能\n---\n# 落点技能\n', 'utf8')
})

afterEach(() => {
  restoreHome(savedEnv)
  if (fixture !== undefined) rmSync(fixture.home, { recursive: true, force: true })
  if (homeB !== undefined) rmSync(homeB, { recursive: true, force: true })
  if (moduleDir !== undefined) rmSync(moduleDir, { recursive: true, force: true })
})

describe('installProfileModule — 落点一致性（P0 缺陷回归）', () => {
  it('home=homeB 时注册表落进 homeB，不落进 CORUM_HOME(homeA)', () => {
    installProfileModule({
      sourceDir: moduleDir,
      home: homeB,
      conflict: {
        profile: 'overwrite',
        skills: { [SKILL_NAME]: 'overwrite' },
        mcp: { [MCP_NAME]: 'overwrite' },
      },
    })

    // homeB/mcp-servers.json 存在且含该服务——这是修后的正确落点。
    const regB = join(homeB, 'mcp-servers.json')
    expect(existsSync(regB)).toBe(true)
    const dataB = JSON.parse(readFileSync(regB, 'utf8'))
    expect(dataB.servers.some((s: { name: string }) => s.name === MCP_NAME)).toBe(true)

    // homeA(=CORUM_HOME)/mcp-servers.json **不含**该服务——这条在旧代码（saveServer
    // 只读 CORUM_HOME）上会失败：旧代码会把注册表写进 homeA。
    const regA = join(fixture.home, 'mcp-servers.json')
    if (existsSync(regA)) {
      const dataA = JSON.parse(readFileSync(regA, 'utf8'))
      expect(dataA.servers.some((s: { name: string }) => s.name === MCP_NAME)).toBe(false)
    }
  })

  it('技能与注册表同根：homeB/skills/<name>/SKILL.md 存在（两类落盘共享 input.home）', () => {
    installProfileModule({
      sourceDir: moduleDir,
      home: homeB,
      conflict: {
        profile: 'overwrite',
        skills: { [SKILL_NAME]: 'overwrite' },
        mcp: { [MCP_NAME]: 'overwrite' },
      },
    })

    // 技能落进 homeB（与注册表同根）——证明两类落盘不再拆成两棵树。
    expect(existsSync(join(homeB, 'skills', SKILL_NAME, 'SKILL.md'))).toBe(true)
    // 注册表也在 homeB。
    expect(existsSync(join(homeB, 'mcp-servers.json'))).toBe(true)
  })
})
