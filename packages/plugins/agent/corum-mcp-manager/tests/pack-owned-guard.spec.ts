/**
 * 扩展包归属拒绝测试（P5a）：deleteServerRemote 对扩展包拥有的 MCP 拒绝。
 *
 * 覆盖：
 *   1. registry 里某包拥有 MCP「owned-mcp」⇒ deleteServerRemote 抛 Error，
 *      消息含包名 + 集成中心 › 扩展包。
 *   2. 非扩展包拥有的 MCP「free-mcp」⇒ deleteServerRemote 正常删除。
 *
 * 见 P5 设计 §5.1/§5.2。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { McpManagerService } from '../src/mcp-manager-service.ts'
import { saveServer, deleteServer, getServer } from '../src/registry-store.ts'
import type { McpServerConfig } from '../src/types.ts'
import { EXTENSION_PACKS_DIRNAME, EXTENSION_REGISTRY_FILENAME } from '@corum/corum-extension-registry'

let home: string
let savedCorumHome: string | undefined
let savedDshHome: string | undefined

const OWNED_MCP: McpServerConfig = {
  name: 'owned-mcp',
  transport: 'stdio',
  command: 'echo',
}
const FREE_MCP: McpServerConfig = {
  name: 'free-mcp',
  transport: 'stdio',
  command: 'echo',
}

beforeEach(() => {
  savedCorumHome = process.env.CORUM_HOME
  savedDshHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'corum-mcp-guard-'))
  process.env.CORUM_HOME = home
  process.env.DSH_HOME = home

  // 在 home 下造一份 registry.json，让 owned-mcp 归属扩展包「test-pack」。
  const packsDir = join(home, EXTENSION_PACKS_DIRNAME)
  mkdirSync(packsDir, { recursive: true })
  writeFileSync(
    join(packsDir, EXTENSION_REGISTRY_FILENAME),
    JSON.stringify({
      packs: {
        'test-pack': {
          id: 'test-pack',
          version: '1.0.0',
          name: '测试扩展包',
          installedAt: '2026-10-23T00:00:00.000Z',
          items: { mcp: [{ name: 'owned-mcp' }] },
        },
      },
    }),
    'utf8',
  )

  // 预置两个 MCP 到 mcp-servers.json（saveServer 用 CORUM_HOME）。
  saveServer(OWNED_MCP)
  saveServer(FREE_MCP)
})

afterEach(() => {
  if (savedCorumHome === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = savedCorumHome
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
})

describe('deleteServerRemote — 扩展包归属拒绝（P5 §5.2）', () => {
  it('扩展包拥有的 MCP ⇒ 抛 Error（消息含包名 + 集成中心 › 扩展包）', () => {
    const ctx = new Context()
    const svc = new McpManagerService(ctx)
    // deleteServerRemote 把 PackOwnedError 包装成 new Error(e.message)，
    // McpPage 的 doDelete catch 后展示 e.message——所以这里只断言消息。
    expect(() => svc.deleteServerRemote('owned-mcp')).toThrow(/集成中心 › 扩展包/)
    try {
      svc.deleteServerRemote('owned-mcp')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('测试扩展包')
      expect(msg).toContain('集成中心 › 扩展包')
    }
    // MCP 仍在注册表里（拒绝后不删）。
    expect(getServer('owned-mcp')?.name).toBe('owned-mcp')
  })

  it('非扩展包拥有的 MCP ⇒ 正常删除', () => {
    const ctx = new Context()
    const svc = new McpManagerService(ctx)
    expect(getServer('free-mcp')?.name).toBe('free-mcp')
    svc.deleteServerRemote('free-mcp')
    expect(getServer('free-mcp')).toBeUndefined()
  })
})
