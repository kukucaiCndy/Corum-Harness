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
 * 另有⑤ psCommand PowerShell 解析器语法校验（**仅 Windows 跑**，用真实 PS Parser）。
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
  tmpdir: vi.fn(() => 'C:\\Temp'),
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { existsSync, writeFileSync } from 'node:fs'
import {
  tryFixWorkspaceAcl,
  tryFixWorkspaceAclWithDiagnostics,
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

/** 同 {@link withPlatform}，但把 body 的返回值带出来。 */
function withPlatformReturn<T>(platform: NodeJS.Platform, body: () => T): T {
  let out!: T
  withPlatform(platform, () => { out = body() })
  return out
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

/**
 * 把字符串嵌入 PowerShell 单引号串：PS 单引号串只需把 ' 加倍为 ''，
 * 其余字符（双引号、反斜杠等）原样保留。避免 JSON.stringify 产出的 \"
 * 在 PS 双引号串里是非法转义（" 提前结束串 → MissingEndParenthesis）。
 */
const psSingleQuoted = (s: string): string => "'" + s.replace(/'/g, "''") + "'"

beforeEach(() => {
  // 默认 mock：所有 spawnSync 返回 status:0（安全成功）。
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '', pid: 0, output: ['', '', ''], signal: null } as never)
  vi.mocked(userInfo).mockReturnValue({ username: 'testuser' } as never)
  // 默认 existsSync 返回 false（非 Windows 环境，psExe 回落 'powershell'）。
  vi.mocked(existsSync).mockReturnValue(false)
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

// ── ①b issue #244 缺陷 2：非 ASCII 路径 + 必须 shell:false + 诊断可见 ──────────

describe('tryFixWorkspaceAcl —— 非 ASCII 路径（issue #244 缺陷 2）', () => {
  /**
   * 用户报障：工作区 `D:\corum_projects\xxx`（路径含中文）下，workspace-write 模式下
   * **任何**命令行都在执行前失败，报「工作区目录权限不足，需要管理员权限一键修复」，
   * 而实测 `icacls /grant` 根本不需要管理员。
   *
   * 根因之一：三条修复命令都用 `shell: true` ⇒ Windows 上经 `cmd.exe` 执行，argv 被
   * 拼成一条字符串，OEM 代码页与 JS 字符串编码不一致时路径被破坏 ⇒ 命令必然失败。
   * 且 stderr 全部丢弃 ⇒ 无法分辨「真的缺权限」与「路径被破坏」。
   */
  it('★ 所有修复命令都必须 shell:false（否则 cmd.exe 会破坏非 ASCII 路径）', () => {
    withPlatform('win32', () => {
      tryFixWorkspaceAcl('D:\\项目\\工作区')
    })
    const calls = vi.mocked(spawnSync).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [, , options] of calls) {
      expect((options as { shell?: boolean }).shell).toBe(false)
    }
  })

  it('★ 非 ASCII 路径必须**原样**作为 argv 元素传给子进程（不经 shell 拼接）', () => {
    const path = 'D:\\项目\\工作区 with space'
    withPlatform('win32', () => {
      tryFixWorkspaceAcl(path)
    })
    const argvLists = vi.mocked(spawnSync).mock.calls.map(([, args]) => args as string[])
    expect(argvLists.length).toBeGreaterThan(0)
    for (const argv of argvLists) {
      // 路径必须是一个**独立的 argv 元素**，不是被拼进某个串里。
      expect(argv).toContain(path)
    }
  })

  it('★ 诊断必须带回退出码与 stderr（旧实现全丢弃，用户只看到「需要管理员权限」）', () => {
    setSpawnSyncDispatch({
      takeown: { status: 1, stderr: 'ERROR: The system cannot find the path specified.' },
      icacls: { status: 5, stderr: '拒绝访问。' },
    })
    const outcome = withPlatformReturn('win32', () => tryFixWorkspaceAclWithDiagnostics('D:\\项目\\ws'))
    expect(outcome.result).toBe('needs-elevation')
    expect(outcome.attempts.length).toBeGreaterThan(0)
    // 失败命令的 stderr 必须留着——那是唯一能区分「缺权限 / 路径被破坏」的现场。
    expect(outcome.attempts.some((a) => a.stderr.includes('cannot find the path'))).toBe(true)
    expect(outcome.attempts.some((a) => a.status !== 0)).toBe(true)
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

  it('退出码 0 + 核验通过（显式 ACE）→ fixed', () => {
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

  it('退出码 0 + 属主匹配但无显式 ACE → fixed（takeown 成功、grant 串失效的远程实测场景）', () => {
    setSpawnSyncDispatch({
      powershell: (args) => {
        // verifyAclFix 的 Get-Acl 调用：args 含 -Command 且含 Get-Acl → 返回属主。
        if (args.some(a => typeof a === 'string' && a.includes('Get-Acl'))) {
          return { status: 0, stdout: 'DESKTOP\\testuser\n' }
        }
        // Start-Process 主调用 → 退出 0。
        return { status: 0 }
      },
      icacls: { status: 0, stdout: 'C:\\ws BUILTIN\\Administrators:(OI)(CI)(F)\n' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('fixed')
      expect(r.ok).toBe(true)
    })
  })

  it('退出码 0 但核验不通过（icacls 无 ACE + Get-Acl 属主不匹配）→ failed', () => {
    setSpawnSyncDispatch({
      powershell: (args) => {
        if (args.some(a => typeof a === 'string' && a.includes('Get-Acl'))) {
          return { status: 0, stdout: 'DESKTOP\\Administrator\n' }
        }
        return { status: 0 }
      },
      icacls: { status: 0, stdout: 'C:\\ws BUILTIN\\Administrators:(OI)(CI)(F)\n' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('failed')
      expect(r.ok).toBe(false)
    })
  })

  it('退出码 0 但核验不通过（icacls 读回无 user:(F) 且 Get-Acl 失败）→ failed', () => {
    setSpawnSyncDispatch({
      powershell: (args) => {
        if (args.some(a => typeof a === 'string' && a.includes('Get-Acl'))) {
          return { status: 1, stdout: '' }
        }
        return { status: 0 }
      },
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

// ── ②c powershell 绝对路径 + spawn 错误诊断 ─────────────────────────────────────

describe('fixWorkspaceAclElevated —— powershell 绝对路径与 spawn 错误', () => {
  /**
   * 守 schtasks 拉起的 host 进程 PATH 无 powershell 的 ENOENT 修复：
   * existsSync(System32/WindowsPowerShell) 为真时，spawnSync 第一参数必须是
   * 绝对路径（含 System32/WindowsPowerShell），而非裸 'powershell'。
   */

  it('existsSync 为真 → spawnSync 第一参数为绝对路径（含 System32/WindowsPowerShell）', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    setSpawnSyncDispatch({
      powershell: (args) => {
        // verifyAclFix 的 Get-Acl 调用也走 powershell → 返回属主匹配。
        if (args.some(a => typeof a === 'string' && a.includes('Get-Acl'))) {
          return { status: 0, stdout: 'MACHINE\\testuser\n' }
        }
        return { status: 0 }
      },
      icacls: { status: 0, stdout: 'C:\\ws testuser:(OI)(CI)(F)\n' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('fixed')
    })
    // spawnSync 第一参数应是绝对路径，而非裸 'powershell'。
    const calls = vi.mocked(spawnSync).mock.calls.filter(c => typeof c[0] === 'string' && (c[0] as string).includes('powershell'))
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const cmd = calls[0]![0] as string
    expect(cmd).toContain('System32')
    expect(cmd).toContain('WindowsPowerShell')
    expect(cmd).not.toBe('powershell')
  })

  it('existsSync 为假 → 回落 PATH 查找（第一参数为裸 powershell）', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    setSpawnSyncDispatch({
      powershell: (args) => {
        if (args.some(a => typeof a === 'string' && a.includes('Get-Acl'))) {
          return { status: 0, stdout: 'MACHINE\\testuser\n' }
        }
        return { status: 0 }
      },
      icacls: { status: 0, stdout: 'C:\\ws testuser:(OI)(CI)(F)\n' },
    })
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('fixed')
    })
    const calls = vi.mocked(spawnSync).mock.calls.filter(c => c[0] === 'powershell')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('result.error 存在时 detail 含错误信息（ENOENT 诊断）', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    // spawnSync 返回 status:null + error（模拟 ENOENT：PATH 无 powershell）。
    vi.mocked(spawnSync).mockImplementation(((cmd: string) => {
      if ((cmd as string).includes('powershell')) {
        return { status: null, stdout: '', stderr: '', pid: 0, output: ['', '', ''], signal: null, error: new Error('spawn powershell ENOENT') } as never
      }
      return { status: 0, stdout: '', stderr: '', pid: 0, output: ['', '', ''], signal: null } as never
    }) as never)
    withPlatform('win32', () => {
      const r = fixWorkspaceAclElevated('C:\\ws') as AclElevatedFixResult
      expect(r.outcome).toBe('failed')
      expect(r.detail).toContain('ENOENT')
      // exitCode 为 -1（status null → -1）。
      expect(r.detail).toContain('退出码 -1')
    })
  })
})

// ── ②b psCommand 形状 + 临时 bat 内容（守引号修复：bat 免 Start-Process 转义）──────

describe('fixWorkspaceAclElevated —— psCommand 形状 + bat 内容', () => {
  /**
   * 守 bat 免转义修复：原先把 takeown+icacls 拼成单串塞进 Start-Process
   * -ArgumentList，引号被二次转义弄坏 → icacls grant 失效。现在写临时 bat，
   * psCommand 只传 `'/c "<batPath>"'`，takeown/icacls 移入 bat。
   */

  it('psCommand 含 bat 路径与 /c，不含裸 takeown（已移入 bat）', () => {
    setSpawnSyncDispatch({
      powershell: (args) => {
        if (args.some(a => typeof a === 'string' && a.includes('Get-Acl'))) {
          return { status: 0, stdout: 'MACHINE\\testuser\n' }
        }
        return { status: 0 }
      },
      icacls: { status: 0, stdout: 'E:\\test-dir testuser:(OI)(CI)(F)\n' },
    })
    withPlatform('win32', () => {
      fixWorkspaceAclElevated('E:\\test-dir')
    })
    // 取 powershell 调用的 -Command 参数（argv[3]：['-NoProfile','-NonInteractive','-Command', psCommand]）。
    const calls = vi.mocked(spawnSync).mock.calls.filter(c => c[0] === 'powershell')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const args = calls[0]![1] as string[]
    // -Command 是第 3 个参数（index 2）。
    expect(args[2]).toBe('-Command')
    const psCommand = args[3] as string
    // 核心断言：psCommand 含 bat 路径 + /c。
    expect(psCommand).toContain('/c')
    expect(psCommand).toContain('corum-acl-fix-')
    expect(psCommand).toContain('.bat')
    // 反向断言：psCommand 不含裸 takeown（已移入 bat）。
    expect(psCommand).not.toContain('takeown')
    // 形状：Start-Process cmd.exe -Verb RunAs -Wait -ArgumentList '/c "<batPath>"'
    // PS 单引号串：内部双引号原样保留，不转义。串以 "' 结尾（双引号闭 bat 路径 + 单引号闭 PS 串）。
    expect(psCommand).toMatch(/^Start-Process cmd\.exe -Verb RunAs -Wait -ArgumentList '\/c "/)
    expect(psCommand).toMatch(/"'$/)
    // 不含反斜杠转义引号（\" 是非法 PS 语法，已修复）。
    expect(psCommand).not.toContain('\\"')
  })

  it('bat 内容含 takeown + icacls 两行（写文件时验证）', () => {
    setSpawnSyncDispatch({
      powershell: { status: 0 },
      icacls: { status: 0, stdout: 'C:\\Users\\test\\ws testuser:(OI)(CI)(F)\n' },
    })
    withPlatform('win32', () => {
      fixWorkspaceAclElevated('C:\\Users\\test\\ws')
    })
    // writeFileSync 应被调用一次，内容含 takeown + icacls 两行。
    const writeCalls = vi.mocked(writeFileSync).mock.calls
    expect(writeCalls.length).toBeGreaterThanOrEqual(1)
    const content = writeCalls[0]![1] as string
    expect(content).toContain('takeown /f "C:\\Users\\test\\ws" /r /d y')
    expect(content).toContain('icacls "C:\\Users\\test\\ws" /grant')
    expect(content).toContain('(OI)(CI)F')
    // 两行用 \r\n 换行。
    expect(content).toContain('\r\n')
    const lines = content.split('\r\n').filter(l => l.length > 0)
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(/^takeown\b/)
    expect(lines[1]).toMatch(/^icacls\b/)
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

// ── ⑤ psCommand PowerShell 解析器语法校验（防回归：`\"` 非法 PS 语法）────────────
//
// 守的是 2026-11-14 修的 bug：原先 psCommand 用 PS 双引号串 + `\"` 转义引号，
// 但 `\"` 在 PS 双引号串里是非法语法（`"` 会提前结束串），PowerShell 解析失败、
// Start-Process 不执行、bat 跑不起来。改用 PS 单引号串后内部双引号原样保留，
// 不需转义。本测试用**真实 PowerShell 解析器**校验 psCommand 无语法错误。
//
// **只在 Windows 跑**（非 win32 skip——没有 PowerShell 可用）。用 vi.importActual
// 拿真实的 spawnSync（不被顶层 vi.mock('node:child_process') 劫持），spawn
// powershell.exe 跑 `[System.Management.Automation.Language.Parser]::ParseInput()`。

describe('psCommand —— PowerShell 解析器语法校验（Windows only）', () => {
  // 多种 batPath 形状（含空格路径），都应产出合法 PS 语法。
  const batPathCases: Array<[string, string]> = [
    ['简单路径', 'C:\\Temp\\corum-acl-fix-12345-67890.bat'],
    ['含空格路径', 'C:\\Users\\test user\\AppData\\Local\\Temp\\corum-acl-fix-12345-67890.bat'],
    ['UNC 路径', '\\\\server\\share\\corum-acl-fix-12345-67890.bat'],
  ]

  /**
   * 从 fixWorkspaceAclElevated 的 mock spawnSync 调用里提取 psCommand。
   * 调用方需在 win32 平台伪装下执行（withPlatform('win32', ...)）。
   */
  function capturePsCommand(): string {
    setSpawnSyncDispatch({
      powershell: (args) => {
        // verifyAclFix 的 Get-Acl 调用也走 powershell → 返回属主匹配。
        if (args.some(a => typeof a === 'string' && a.includes('Get-Acl'))) {
          return { status: 0, stdout: 'MACHINE\\testuser\n' }
        }
        return { status: 0 }
      },
      icacls: { status: 0, stdout: 'C:\\ws testuser:(OI)(CI)(F)\n' },
    })
    withPlatform('win32', () => {
      fixWorkspaceAclElevated('C:\\ws')
    })
    const calls = vi.mocked(spawnSync).mock.calls.filter(
      c => typeof c[0] === 'string' && (c[0] as string).includes('powershell') && !c[0].includes('Get-Acl'),
    )
    // 取 Start-Process 主调用（非 Get-Acl verifyAclFix 调用）的 -Command 参数。
    const mainCall = calls.find(c => {
      const args = c[1] as string[]
      return Array.isArray(args) && args.includes('-Command') && !args.some(a => typeof a === 'string' && a.includes('Get-Acl'))
    })
    expect(mainCall, '应捕获到 Start-Process 的 powershell spawnSync 调用').toBeDefined()
    const args = mainCall![1] as string[]
    return args[3] as string
  }

  for (const [label, batPath] of batPathCases) {
    it(`真实 PowerShell 解析器校验 psCommand 无语法错误（${label}）`, async () => {
      if (process.platform !== 'win32') {
        // 非 Windows：没有 PowerShell，skip（与现有测试的平台处理模式一致）。
        return
      }

      // 手动构造与源码相同模板的 psCommand（用真实 batPath 形状）。
      // 源码模板：`Start-Process cmd.exe -Verb RunAs -Wait -ArgumentList '/c "${batPath}"'`
      const psCommand = `Start-Process cmd.exe -Verb RunAs -Wait -ArgumentList '/c "${batPath}"'`

      // 拿真实的 spawnSync（不被顶层 vi.mock 劫持）。
      const realChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      const { existsSync: realExistsSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
      const { join: realJoin } = await vi.importActual<typeof import('node:path')>('node:path')

      // 解析 powershell 绝对路径（与源码逻辑一致）。
      const psExe = realExistsSync(realJoin(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
        ? realJoin(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell'

      // 用 PS 语言解析器校验 psCommand 语法：
      // [System.Management.Automation.Language.Parser]::ParseInput() 把 errors 输出到
      // [ref]$errs；有 errors 则打印每条 Message 并 exit 1，无 errors 则 exit 0。
      const parseScript = `[System.Management.Automation.Language.Parser]::ParseInput(${psSingleQuoted(psCommand)}, [ref]$null, [ref]$errs); if($errs){$errs|ForEach-Object{$_.Message}; exit 1}else{exit 0}`

      const result = realChildProcess.spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', parseScript], {
        stdio: 'pipe', windowsHide: true, shell: false, timeout: 15000,
      })

      const stderr = result.stderr?.toString() ?? ''
      const stdout = result.stdout?.toString() ?? ''
      const exitCode = result.status ?? -1

      // 断言：exit 0（无语法错误）。失败时打印 parser 报错信息辅助诊断。
      if (exitCode !== 0) {
        throw new Error(
          `psCommand PowerShell 语法校验失败（${label}）：exit=${exitCode}\n` +
          `psCommand: ${psCommand}\n` +
          `stdout: ${stdout}\nstderr: ${stderr}`,
        )
      }
    })
  }

  // 额外：验证从 fixWorkspaceAclElevated 实际产出的 psCommand（不是手构造的）
  // 也通过解析器校验——守源码模板与测试模板一致。
  it('fixWorkspaceAclElevated 产出的 psCommand 通过解析器校验（集成校验）', async () => {
    if (process.platform !== 'win32') {
      return
    }

    // 从 mock 调用里捕获真实产出的 psCommand。
    const psCommand = capturePsCommand()

    // 反向断言：不含 `\"`（非法 PS 转义，防回归）。
    expect(psCommand).not.toContain('\\"')
    // 正向断言：用 PS 单引号串包裹 ArgumentList。
    expect(psCommand).toMatch(/-ArgumentList '\/c "/)

    const realChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { existsSync: realExistsSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const { join: realJoin } = await vi.importActual<typeof import('node:path')>('node:path')

    const psExe = realExistsSync(realJoin(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
      ? realJoin(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell'

    const parseScript = `[System.Management.Automation.Language.Parser]::ParseInput(${psSingleQuoted(psCommand)}, [ref]$null, [ref]$errs); if($errs){$errs|ForEach-Object{$_.Message}; exit 1}else{exit 0}`

    const result = realChildProcess.spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', parseScript], {
      stdio: 'pipe', windowsHide: true, shell: false, timeout: 15000,
    })

    const stderr = result.stderr?.toString() ?? ''
    const stdout = result.stdout?.toString() ?? ''
    const exitCode = result.status ?? -1

    if (exitCode !== 0) {
      throw new Error(
        `fixWorkspaceAclElevated 产出的 psCommand 语法校验失败：exit=${exitCode}\n` +
        `psCommand: ${psCommand}\n` +
        `stdout: ${stdout}\nstderr: ${stderr}`,
      )
    }
  })
})
