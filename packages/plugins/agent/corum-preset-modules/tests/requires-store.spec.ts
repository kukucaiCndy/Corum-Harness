/**
 * `requires` sidecar（安装说明存放处）的行为测试。
 *
 * 这一组的由来（**本轮补的一个真缺陷**）：导出闸门要求每个 MCP 有合法 `requires`，
 * 而安装/保存路径又**绝不**把 `requires` 写进注册表 ⇒ 若导出只从注册表读，
 * 闸门就永远打不开（每个 MCP 永远「待补全」）。判据必须同时守住两头：
 *   · 写了 sidecar ⇒ 导出**能**通过，且模块条目里带着它；
 *   · 无论怎么走 ⇒ `mcp-servers.json` 里**永远**没有 `requires`（盘上字节为证）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODULE_REQUIRES_FILE,
  moduleRequiresPath,
  readModuleRequires,
  mergeModuleRequires,
  exportProfileModule,
} from '../src/index.ts'

interface Fixture {
  readonly home: string
  readonly profileId: string
}

/** 造一个最小 CORUM_HOME：一个预设 + 一条没有 requires 的 MCP。 */
function makeHome(): Fixture {
  const home = join(tmpdir(), `corum-requires-${process.pid}-${Math.random().toString(36).slice(2)}`)
  const profileId = 'req-probe'
  const dir = join(home, '.agent-presets', profileId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({
    id: profileId,
    nickname: '要求探针',
    baseMode: 'standard',
    prompt: 'x',
    model: { provider: 'p', model: 'm' },
    skills: [],
    mcpServers: ['probe-mcp'],
    terminal: { mode: 'sandbox' },
  }, null, 2), 'utf8')
  writeFileSync(join(home, 'mcp-servers.json'), JSON.stringify({
    servers: [{ name: 'probe-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'probe'] }],
  }, null, 2), 'utf8')
  mkdirSync(join(home, 'skills'), { recursive: true })
  return { home, profileId }
}

let fixture: Fixture
beforeEach(() => { fixture = makeHome() })
afterEach(() => { rmSync(fixture.home, { recursive: true, force: true }) })

describe('requires sidecar — 读/并写', () => {
  it('读不存在的文件 ⇒ 空对象（不抛）', () => {
    expect(readModuleRequires(fixture.home, fixture.profileId)).toEqual({})
  })

  it('并写保留未提及的名字（不是整体替换）', () => {
    mergeModuleRequires(fixture.home, fixture.profileId, {
      a: { kind: 'command', command: 'npx', hint: 'a 的装法' },
    })
    const merged = mergeModuleRequires(fixture.home, fixture.profileId, {
      b: { kind: 'app', platforms: { darwin: '/x' }, hint: 'b 的装法' },
    })
    // 判据：a 还在（若实现是整体替换，这条会红——那正是「重试一次反而丢东西」的形态）。
    expect(Object.keys(merged).sort()).toEqual(['a', 'b'])
    expect(readModuleRequires(fixture.home, fixture.profileId).a).toBeDefined()
  })

  it('sidecar 与 agent.json 同级（同生共死）', () => {
    expect(moduleRequiresPath(fixture.home, fixture.profileId))
      .toBe(join(fixture.home, '.agent-presets', fixture.profileId, MODULE_REQUIRES_FILE))
  })

  it('坏文件 ⇒ 空对象，不把发布流程打挂', () => {
    writeFileSync(moduleRequiresPath(fixture.home, fixture.profileId), '{ not json', 'utf8')
    expect(readModuleRequires(fixture.home, fixture.profileId)).toEqual({})
  })
})

describe('导出闸门 — sidecar 是它唯一的开闸来源', () => {
  it('★ 没写 sidecar ⇒ blocked 且一个文件都不产出', () => {
    const outDir = join(fixture.home, 'out-blocked')
    const result = exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir, archive: false })
    expect(result.blocked.map(b => b.name)).toEqual(['probe-mcp'])
    // 「不产出任何文件」是用户原话「不是导出半成品」的机械判据。
    expect(existsSync(join(outDir, 'module.json'))).toBe(false)
  })

  it('★ 写了 sidecar ⇒ 闸门打开，且模块条目带着它；注册表始终没有 requires', () => {
    mergeModuleRequires(fixture.home, fixture.profileId, {
      'probe-mcp': { kind: 'command', command: 'npx', hint: '装 Node 后即可；验证：npx --version' },
    })
    const outDir = join(fixture.home, 'out-ok')
    const result = exportProfileModule({ profileId: fixture.profileId, home: fixture.home, outDir, archive: false })
    expect(result.blocked).toEqual([])
    expect(result.mcp).toEqual(['probe-mcp'])
    const entry = JSON.parse(readFileSync(join(outDir, 'mcp', 'probe-mcp.json'), 'utf8'))
    expect(entry.requires.kind).toBe('command')
    expect(entry.requires.hint).toContain('验证')
    // 注册表（盘上字节）里不许出现 requires —— sidecar 的存在有没有被顺手写进注册表，
    // 只有读原始文本能发现（listServers 是裸 JSON.parse，无校验）。
    const registry = readFileSync(join(fixture.home, 'mcp-servers.json'), 'utf8')
    expect(registry).not.toContain('requires')
  })
})
