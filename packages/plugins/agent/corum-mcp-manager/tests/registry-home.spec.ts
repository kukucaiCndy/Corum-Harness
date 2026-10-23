/**
 * 注册表落点一致性回归（extension-pack P0 缺陷）。
 *
 * 旧实现 `saveServer` 只读 `process.env.CORUM_HOME`，无视调用方传入的 `home`。
 * 后果：`installProfileModule({ home: '/tmp/x' })` 把技能落进 `/tmp/x`，
 * 但注册表落进 `CORUM_HOME` 指向的另一个根——安装拆成两棵树。
 *
 * 本组直接测 registry-store 的四个函数是否尊重显式 `home` 形参，
 * 以及不传 `home` 时是否逐字保持旧行为（CORUM_HOME 回落）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listServers, getServer, saveServer, deleteServer } from '../src/registry-store.ts'
import type { McpServerConfig } from '../src/types.ts'

let savedEnv: string | undefined
/** 显式 home（模拟 input.home）。 */
let explicitHome: string
/** CORUM_HOME 指向的另一个根（与 explicitHome 不同）。 */
let envHome: string

const SERVER: McpServerConfig = {
  name: 'routing-test',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@test/routing'],
}

beforeEach(() => {
  savedEnv = process.env.CORUM_HOME
  explicitHome = mkdtempSync(join(tmpdir(), 'corum-registry-explicit-'))
  envHome = mkdtempSync(join(tmpdir(), 'corum-registry-env-'))
  // CORUM_HOME 故意指向 envHome——与 explicitHome 不同，才能暴露「写错根」的缺陷。
  process.env.CORUM_HOME = envHome
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = savedEnv
  rmSync(explicitHome, { recursive: true, force: true })
  rmSync(envHome, { recursive: true, force: true })
})

describe('registry-store — 显式 home 落点（P0 缺陷回归）', () => {
  it('saveServer(srv, explicitHome) 写进 explicitHome/mcp-servers.json，不写进 CORUM_HOME 指向的根', () => {
    saveServer(SERVER, explicitHome)

    // 显式根：注册表存在且含该服务。
    expect(existsSync(join(explicitHome, 'mcp-servers.json'))).toBe(true)
    const explicit = JSON.parse(readFileSync(join(explicitHome, 'mcp-servers.json'), 'utf8'))
    expect(explicit.servers.some((s: { name: string }) => s.name === SERVER.name)).toBe(true)

    // CORUM_HOME 指向的根：注册表**不含**该服务（旧代码会写到这里——这正是缺陷）。
    const envReg = join(envHome, 'mcp-servers.json')
    if (existsSync(envReg)) {
      const env = JSON.parse(readFileSync(envReg, 'utf8'))
      expect(env.servers.some((s: { name: string }) => s.name === SERVER.name)).toBe(false)
    }
  })

  it('listServers(explicitHome) 读回显式根里的服务', () => {
    saveServer(SERVER, explicitHome)
    const list = listServers(explicitHome)
    expect(list.some(s => s.name === SERVER.name)).toBe(true)
  })

  it('getServer(name, explicitHome) 从显式根按名取出', () => {
    saveServer(SERVER, explicitHome)
    const got = getServer(SERVER.name, explicitHome)
    expect(got).toBeDefined()
    expect(got?.name).toBe(SERVER.name)
  })

  it('deleteServer(name, explicitHome) 从显式根删除', () => {
    saveServer(SERVER, explicitHome)
    expect(getServer(SERVER.name, explicitHome)).toBeDefined()
    deleteServer(SERVER.name, explicitHome)
    expect(getServer(SERVER.name, explicitHome)).toBeUndefined()
  })

  it('读写用同一个 home：saveServer 写 explicitHome 后，listServers(envHome) 读不到', () => {
    saveServer(SERVER, explicitHome)
    // envHome 是另一个根——读它不该看到 explicitHome 里的服务。
    expect(listServers(envHome).some(s => s.name === SERVER.name)).toBe(false)
  })
})

describe('registry-store — 不传 home 时逐字保持旧行为（CORUM_HOME 回落）', () => {
  it('saveServer(srv) 不带 home ⇒ 写进 CORUM_HOME 指向的根（向后兼容）', () => {
    saveServer(SERVER)
    expect(existsSync(join(envHome, 'mcp-servers.json'))).toBe(true)
    const env = JSON.parse(readFileSync(join(envHome, 'mcp-servers.json'), 'utf8'))
    expect(env.servers.some((s: { name: string }) => s.name === SERVER.name)).toBe(true)
    // explicitHome 没被碰。
    expect(existsSync(join(explicitHome, 'mcp-servers.json'))).toBe(false)
  })

  it('listServers() 不带 home ⇒ 读 CORUM_HOME 指向的根', () => {
    saveServer(SERVER)
    expect(listServers().some(s => s.name === SERVER.name)).toBe(true)
  })

  it('deleteServer(name) 不带 home ⇒ 删 CORUM_HOME 指向的根里的服务', () => {
    saveServer(SERVER)
    deleteServer(SERVER.name)
    expect(listServers().some(s => s.name === SERVER.name)).toBe(false)
  })

  it('预置的 CORUM_HOME 注册表不被显式 home 操作触碰', () => {
    // 在 envHome（=CORUM_HOME）里预置一个服务。
    writeFileSync(join(envHome, 'mcp-servers.json'), JSON.stringify({
      servers: [{ name: 'pre-existing', transport: 'stdio', command: 'echo' }],
    }), 'utf8')

    // 用 explicitHome 存删——envHome 里那条不应被动。
    saveServer(SERVER, explicitHome)
    deleteServer(SERVER.name, explicitHome)

    const env = JSON.parse(readFileSync(join(envHome, 'mcp-servers.json'), 'utf8'))
    expect(env.servers.some((s: { name: string }) => s.name === 'pre-existing')).toBe(true)
    expect(env.servers.some((s: { name: string }) => s.name === SERVER.name)).toBe(false)
  })

  // 评审补充（2026-10-23）：回落链必须与 resolveCorumHome 逐字一致（CORUM_HOME → DSH_HOME
  // → ~/.corum）。旧实现漏了 DSH_HOME 档：只设 DSH_HOME 的部署里，UI 加的 MCP 会落
  // ~/.corum，而运行期按 DSH_HOME 读——配置静默丢失。
  it('只设 DSH_HOME（未设 CORUM_HOME）⇒ 落到 DSH_HOME 指向的根', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'corum-registry-dsh-'))
    const savedCorum = process.env.CORUM_HOME
    const savedDsh = process.env.DSH_HOME
    try {
      delete process.env.CORUM_HOME
      process.env.DSH_HOME = dshHome

      saveServer(SERVER)

      expect(existsSync(join(dshHome, 'mcp-servers.json'))).toBe(true)
      expect(existsSync(join(envHome, 'mcp-servers.json'))).toBe(false)
      expect(getServer(SERVER.name)?.name).toBe(SERVER.name)
    } finally {
      if (savedCorum === undefined) delete process.env.CORUM_HOME
      else process.env.CORUM_HOME = savedCorum
      if (savedDsh === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedDsh
      rmSync(dshHome, { recursive: true, force: true })
    }
  })
})
