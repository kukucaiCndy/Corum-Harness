/**
 * Windows 工作区 ACL 提权修复的语义守卫（host 侧纯函数面）。
 *
 * ## 本测试守什么
 *
 * 不依赖真机 Windows（在 darwin/linux 上跑）：mock `child_process.spawnSync` 与
 * `os.userInfo`，守四组语义：
 *   ① `tryFixWorkspaceAcl` 三态（fixed / needs-elevation / unsupported）；
 *   ② `fixWorkspaceAclElevated` 退出码映射（0=fixed / 1602=cancelled / 1223=denied / 其它=failed）；
 *   ③ 路径防注入（`isSafeWindowsPath` 间接守——不安全路径直接 failed）；
 *   ④ `manualAclFixCommands` 输出含 takeown + icacls。
 *
 * ⚠️ 本测试**不**代替真机验证（UAC consent 桌面弹窗、PowerShell Start-Process
 * -Verb RunAs 的退出码语义只在真 Windows 上有意义）。这里守的是「后人重构时别把
 * 退出码映射/三态/注入防护改坏」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 被 vitest 提升（hoist）到文件顶部——必须在 import 源码之前声明。
// mock 工厂里用 vi.fn() 造可控的 spawnSync / userInfo，每个 test 里设 mockReturnValue。
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))
vi.mock('node:os', () => ({
  userInfo: vi.fn(() => ({ username: 'testuser' })),
}))

import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import {
  tryFixWorkspaceAcl,
  fixWorkspaceAclElevated,
  manualAclFixCommands,
  AclElevationRequiredError,
} from '../src/index.ts'
import type { AclFixResult, AclElevatedFixResult } from '../src/index.ts'

/** 临时把 `process.platform` 伪装成指定平台。 */
function withPlatform(platform: NodeJS.Platform, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    body()
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original)
  }
}

/** mock spawnSync 的返回形态（只取 status / stdout / stderr）。 */
interface MockSpawn {
  status: number | null
  stdout?: string
  stderr?: string
}

/**
 * 设 spawnSync 的分发 mock：按命令名（argv[0]）分发到不同的返回。
 * 未列出的命令返回 { status: 0, stdout: '', stderr: '' }（安全默认）。
 * 函数形态：按 args 数组动态判断。
 */
function setSpawnSyncDispatch(table: Record<string, MockSpawn | ((args: readonly string[]) => MockSpawn)>): void {
  const mockFn = vi.mocked(spawnSync)
  mockFn.mockReset()
  mockFn.mockImplementation(((cmd: string, args: string[]) => {
    const entry = table[cmd]
    if (entry === undefined) return { status: 0, stdout: '', stderr: '', pid: 0, output: ['', '', ''], signal: null }
    const result = typeof entry === 'function' ? entry(args) : entry
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', pid: 0, output: ['', '', ''], signal: null }
  }) as never)
}

beforeEach(() => {
  // 默认 mock：所有 spawnSync 返回 status:0（安全成功）。
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '', pid: 0, output: ['', '', ''], signal: null } as never)
  vi.mocked(userInfo).mockReturnValue({ username: 'testuser' } as never)
  vi.stubEnv('USERNAME', 'testuser')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

// ── ① tryFixWorkspaceAcl 三态 ──────────────────────────────────────────────────

describe('tryFixWorkspaceAcl —— 非提权修复三态', () => {
  it('非 Windows 平台返回 unsupported（no-op，不 spawn）', () => {
    const calls: string[] = []
    vi.mocked(spawnSync).mockImplementation(((cmd: string) => { calls.push(cmd); return { status: 0, stdout: '', stderr: '' } as never }))
    withPlatform('darwin', () => {
      const r = tryFixWorkspaceAcl('/Users/test/ws') as AclFixResult
      expect(r).toBe('unsupported')
    })
    withPlatform('linux', () => {
      const r = tryFixWorkspaceAcl('/home/test/ws') as AclFixResult
      expect(r).toBe('unsupported')
    })
    expect(calls).toHaveLength(0)
  })

  it('takeown 成功 + icacls grant 成功 → fixed', () => {
    setSpawnSyncDispatch({
      takeown: { status: 0 },
      icacls: { status: 0 },
    })
    withPlatform('win32', () => {
      expect(tryFixWorkspaceAcl('C:\\ws')).toBe('fixed')
    })
  })

  it('takeown 失败 + icacls setowner 失败 → needs-elevation', () => {
    setSpawnSyncDispatch({
      takeown: { status: 1 },
      icacls: (args) => {
        if (args.includes('/setowner')) return { status: 1 }
        return { status: 0 }
      },
    })
    withPlatform('win32', () => {
      expect(tryFixWorkspaceAcl('C:\\ws')).toBe('needs-elevation')
    })
  })

  it('takeown 成功但 icacls grant 失败 → needs-elevation', () => {
    setSpawnSyncDispatch({
      takeown: { status: 0 },
      icacls: (args) => {
        if (args.includes('/grant')) return { status: 1 }
        return { status: 0 }
      },
    })
    withPlatform('win32', () => {
      expect(tryFixWorkspaceAcl('C:\\ws')).toBe('needs-elevation')
    })
  })

  it('takeown 失败但 icacls setowner 成功 + grant 成功 → fixed（takeown 回落到 icacls setowner 路径）', () => {
    setSpawnSyncDispatch({
      takeown: { status: 1 },
      icacls: { status: 0 },
    })
    withPlatform('win32', () => {
      expect(tryFixWorkspaceAcl('C:\\ws')).toBe('fixed')
    })
  })

  it('用户名为空 → needs-elevation（不 spawn）', () => {
    vi.mocked(userInfo).mockReturnValue({ username: '' } as never)
    withPlatform('win32', () => {
      expect(tryFixWorkspaceAcl('C:\\ws')).toBe('needs-elevation')
    })
  })

  it('spawnSync 抛异常 → needs-elevation（catch 兜底）', () => {
    vi.mocked(spawnSync).mockImplementation(() => { throw new Error('spawn failed') })
    withPlatform('win32', () => {
      expect(tryFixWorkspaceAcl('C:\\ws')).toBe('needs-elevation')
    })
  })
})

// ── ② fixWorkspaceAclElevated 退出码映射 ───────────────────────────────────────

describe('fixWorkspaceAclElevated —— 退出码映射', () => {
  it('非 Windows → unsupported', () => {
    withPlatform('darwin', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('unsupported')
      expect(r.ok).toBe(false)
    })
  })

  it('不安全路径（含注入元字符）→ failed', () => {
    withPlatform('win32', () => {
      // 路径含管道符 → isSafeWindowsPath 拒绝。
      const r = fixWorkspaceAclElevated('C:\\ws & whoami') as AclElevatedFixResult
      expect(r.outcome).toBe('failed')
      expect(r.ok).toBe(false)
    })
  })

  it('不安全路径（非绝对路径）→ failed', () => {
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('relative\\path') as AclElevatedFixResult
      expect(r.outcome).toBe('failed')
      expect(r.ok).toBe(false)
    })
  })

  it('退出码 0 + 核验通过 → fixed', () => {
    setSpawnSyncDispatch({
      powershell: { status: 0 },
      icacls: { status: 0, stdout: 'C:\\ws testuser:(OI)(CI)(F)\n' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('fixed')
      expect(r.ok).toBe(true)
    })
  })

  it('退出码 0 但核验不通过（icacls 读回无 user:(F)）→ failed', () => {
    setSpawnSyncDispatch({
      powershell: { status: 0 },
      // icacls 读回的输出里没有 (F)
      icacls: { status: 0, stdout: 'C:\\ws testuser:(RX)\n' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('failed')
      expect(r.ok).toBe(false)
    })
  })

  it('退出码 1602 → cancelled（UAC 取消）', () => {
    setSpawnSyncDispatch({
      powershell: { status: 1602, stderr: '' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('cancelled')
      expect(r.ok).toBe(false)
    })
  })

  it('stderr 含 1602 → cancelled（即使 exitCode 不是 1602）', () => {
    setSpawnSyncDispatch({
      powershell: { status: -1, stderr: 'Start-Process: 1602' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('cancelled')
    })
  })

  it('退出码 1223 → denied（UAC 拒绝）', () => {
    setSpawnSyncDispatch({
      powershell: { status: 1223, stderr: '' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('denied')
      expect(r.ok).toBe(false)
    })
  })

  it('stderr 含 "requires elevation" → denied', () => {
    setSpawnSyncDispatch({
      powershell: { status: 1, stderr: 'This operation requires elevation' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('denied')
    })
  })

  it('其它退出码（如 1）→ failed', () => {
    setSpawnSyncDispatch({
      powershell: { status: 1, stderr: 'some error' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('failed')
      expect(r.ok).toBe(false)
    })
  })

  it('spawnSync 抛异常 → failed（catch 兜底）', () => {
    vi.mocked(spawnSync).mockImplementation(() => { throw new Error('powershell not found') })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('failed')
    })
  })
})

// ── ③ 路径防注入（间接守 isSafeWindowsPath）──────────────────────────────────────

describe('fixWorkspaceAclElevated —— 路径防注入', () => {
  // 每个注入元字符都应被拒绝（isSafeWindowsPath 的元字符黑名单）。
  const injectionCases: Array<[string, string]> = [
    ['管道', 'C:\\ws | whoami'],
    ['amp', 'C:\\ws & whoami'],
    ['重定向', 'C:\\ws > out.txt'],
    ['双引号', 'C:\\ws"evil'],
    ['反引号', 'C:\\ws`whoami'],
    ['分号', 'C:\\ws; whoami'],
    ['换行', 'C:\\ws\nwhoami'],
  ]
  for (const [label, path] of injectionCases) {
    it(`路径含 ${label} → failed（拒绝）`, () => {
      withPlatform('win32', () => {
        const r = fixWorkspaceAclElevated(path) as AclElevatedFixResult
        expect(r.outcome).toBe('failed')
        expect(r.detail).toContain('不安全')
      })
    })
  }

  it('合法盘符绝对路径 → 通过注入检查（不返回 failed/不安全）', () => {
    setSpawnSyncDispatch({
      powershell: { status: 0 },
      icacls: { status: 0, stdout: 'C:\\ws testuser:(F)\n' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\Users\\test\\workspace') as AclElevatedFixResult
      expect(r.detail).not.toContain('不安全')
    })
  })

  it('UNC 路径 → 通过注入检查', () => {
    setSpawnSyncDispatch({
      powershell: { status: 0 },
      icacls: { status: 0, stdout: '\\\\server\\share testuser:(F)\n' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('\\\\server\\share') as AclElevatedFixResult
      expect(r.detail).not.toContain('不安全')
    })
  })
})

// ── ④ manualAclFixCommands ─────────────────────────────────────────────────────

describe('manualAclFixCommands —— 手工命令兜底', () => {
  it('非 Windows → 空字符串', () => {
    withPlatform('darwin', () => {
      expect(manualAclFixCommands('/Users/test/ws')).toBe('')
    })
  })

  it('Windows → 输出含 takeown + icacls', () => {
    withPlatform('win32', () => {
      const out = manualAclFixCommands('C:\\ws')
      expect(out).toContain('takeown')
      expect(out).toContain('icacls')
      expect(out).toContain('/grant')
      expect(out).toContain('(OI)(CI)F')
      expect(out).toContain('C:\\ws')
    })
  })

  it('Windows → 两行命令（takeown 一行、icacls 一行）', () => {
    withPlatform('win32', () => {
      const lines = manualAclFixCommands('C:\\ws').split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^takeown\b/)
      expect(lines[1]).toMatch(/^icacls\b/)
    })
  })
})

// ── AclElevationRequiredError ──────────────────────────────────────────────────

describe('AclElevationRequiredError —— 类型化错误', () => {
  it('instanceof Error + name + workspaceRoot + userMessage', () => {
    const err = new AclElevationRequiredError('C:\\ws')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AclElevationRequiredError')
    expect(err.workspaceRoot).toBe('C:\\ws')
    expect(err.userMessage).toContain('权限不足')
    expect(err.message).toContain('C:\\ws')
  })
})
