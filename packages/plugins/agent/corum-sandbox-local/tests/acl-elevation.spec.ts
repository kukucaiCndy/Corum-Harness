/**
 * Windows 工作区 ACL 提权修复的 sandbox-local 侧语义守卫。
 *
 * ## 本测试守什么
 *
 * mock `@corum/corum-platform` 的 `tryFixWorkspaceAcl` 返回 `'needs-elevation'`，
 * mock `@deepseek-ai/dsh-sandbox-windows-acl` 的 `AclWriteGrant`（grant.add 抛错触发
 * fail-then-fix 路径），守两条语义：
 *   ① `materializeAclGrant` 在 `needs-elevation` 时抛 `AclElevationRequiredError`；
 *   ② `emitAclElevationRequired` 被调用（`ctx.emit('corum/acl/elevation-required', ...)`）。
 *
 * 间接守：fail-closed（不挂起等待）、去重（同一 workspace 只 emit 一次）。
 *
 * ⚠️ 不做真机 Windows 验证（ACL / UAC consent 只在真 Windows 上有意义）。
 *
 * 测试手法：用 `Object.create(LocalSandboxProvider.prototype)` 绕过基类构造（cordis
 * Service 构造需要真实 ctx.provide），手动注入 `ctx` / `workspaceGrants`，然后直调
 * private 方法 `materializeAclGrant`（与 platform-facts.spec.ts 同款 Object.create 模式）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// mock @corum/corum-platform：tryFixWorkspaceAclWithDiagnostics 可控返回，
// AclElevationRequiredError 保留真类型。
//
// 桩的是**带诊断**的那个（issue #244 缺陷 2）：生产代码走它以便把每条命令的
// stderr 写进 host.log。旧版只桩 `tryFixWorkspaceAcl`，改名后桩不上 ⇒ 真函数被调用 ⇒
// 非 Windows 上返回 'unsupported' ⇒ 走不到 needs-elevation 分支（6 例假红）。
vi.mock('@corum/corum-platform', () => ({
  tryFixWorkspaceAclWithDiagnostics: vi.fn(),
  AclElevationRequiredError: class AclElevationRequiredError extends Error {
    readonly workspaceRoot: string
    readonly userMessage: string
    constructor(workspaceRoot: string, userMessage?: string) {
      super(`工作区目录权限不足${userMessage === undefined ? '，需要管理员权限一键修复' : `：${userMessage}`}：${workspaceRoot}`)
      this.name = 'AclElevationRequiredError'
      this.workspaceRoot = workspaceRoot
      this.userMessage = userMessage ?? '工作区目录权限不足，需要管理员权限一键修复'
    }
  },
  manualAclFixCommands: vi.fn(() => 'icacls "C:\\ws" /grant "testuser:(OI)(CI)F" /T /C /Q\ntakeown /f "C:\\ws" /r /d y'),
}))

// mock AclWriteGrant：create 返回一个 add 会抛错的假 grant（触发 fail-then-fix 路径）。
vi.mock('@deepseek-ai/dsh-sandbox-windows-acl', () => ({
  AclWriteGrant: {
    create: vi.fn(() => ({
      add: vi.fn(() => { throw new Error('SetNamedSecurityInfoW failed: Win32 5') }),
      dispose: vi.fn(),
    })),
  },
  assertTempRootOutsideWorkspace: vi.fn(),
  registerAclDiagnosisSkill: vi.fn(),
  tempWriteSid: vi.fn(() => 'S-1-2-3-temp'),
  workspaceWriteSid: vi.fn(() => 'S-1-2-3-ws'),
}))

import { tryFixWorkspaceAclWithDiagnostics, AclElevationRequiredError } from '@corum/corum-platform'
import { AclWriteGrant } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { LocalSandboxProvider } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 临时把 `process.platform` 伪装成 win32。 */
function withWin32(body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    body()
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original)
  }
}

/** 造一个带 emit spy 的假 ctx。 */
function makeFakeCtx(): { ctx: Context; emitSpy: ReturnType<typeof vi.fn> } {
  const emitSpy = vi.fn()
  const ctx = {
    emit: emitSpy,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    effect: vi.fn((fn: () => (() => void)) => fn()),
    inject: vi.fn((deps: string[], fn: () => void) => fn()),
  }
  return { ctx: ctx as unknown as Context, emitSpy }
}

/**
 * 造一个绕过构造的 provider 实例（Object.create 模式，不调 new → 不触 cordis Service 构造）。
 * 手动注入 materializeAclGrant 需要的 this 字段。
 */
function makeProvider(): { provider: LocalSandboxProvider; emitSpy: ReturnType<typeof vi.fn> } {
  const { ctx, emitSpy } = makeFakeCtx()
  const provider = Object.create(LocalSandboxProvider.prototype) as LocalSandboxProvider
  // 注入 materializeAclGrant 需要的 this 字段（与源码 class 字段一致）。
  Object.defineProperty(provider, 'ctx', { value: ctx, writable: false, configurable: true })
  Object.defineProperty(provider, 'workspaceGrants', { value: new Map(), writable: false, configurable: true })
  Object.defineProperty(provider, 'tempCapabilities', { value: new Map(), writable: false, configurable: true })
  Object.defineProperty(provider, 'elevationNotified', { value: new Set<string>(), writable: false, configurable: true })
  Object.defineProperty(provider, 'internals', { value: {}, writable: true, configurable: true })
  return { provider, emitSpy }
}

beforeEach(() => {
  vi.mocked(tryFixWorkspaceAclWithDiagnostics).mockReturnValue({ result: 'needs-elevation', attempts: [], failureReason: 'owner-mismatch' })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

/**
 * 直调 private materializeAclGrant（通过 ['materializeAclGrant'] 括号记法访问）。
 * 返回的不是正常值——它应该抛 AclElevationRequiredError。
 */
function callMaterialize(provider: LocalSandboxProvider, workspaceRoot: string): void {
  // TypeScript 不让直接调 private，用 any 绕过。
  (provider as unknown as { materializeAclGrant: (sessionId: string, workspaceRoot: string) => unknown }).materializeAclGrant('test-session', workspaceRoot)
}

// ── ① needs-elevation 分支抛 AclElevationRequiredError ──────────────────────────

describe('sandbox-local materializeAclGrant —— needs-elevation 分支', () => {
  it('tryFixWorkspaceAcl 返回 needs-elevation 时抛 AclElevationRequiredError', () => {
    const { provider } = makeProvider()
    withWin32(() => {
      expect(() => callMaterialize(provider, 'C:\\ws')).toThrow(AclElevationRequiredError)
    })
  })

  it('抛出的错误含 workspaceRoot', () => {
    const { provider } = makeProvider()
    withWin32(() => {
      try {
        callMaterialize(provider, 'C:\\ws')
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(AclElevationRequiredError)
        expect((error as AclElevationRequiredError).workspaceRoot).toContain('C:\\ws')
      }
    })
  })

  it('fail-closed：不返回正常值（grant.add 失败后不走 fallback，直接抛错）', () => {
    const { provider } = makeProvider()
    withWin32(() => {
      // materializeAclGrant 正常时返回 AclTempCapability 对象；
      // needs-elevation 时应抛错（不返回 undefined / null）。
      expect(() => callMaterialize(provider, 'C:\\ws')).toThrow()
      // 验证 workspaceGrants 里没有残留（grant.add 失败后 dispose 了）。
      const grants = provider['workspaceGrants'] as Map<string, unknown>
      expect(grants.size).toBe(0)
    })
  })
})

// ── ② emit 事件（corum/acl/elevation-required）──────────────────────────────────

describe('sandbox-local emitAclElevationRequired —— 事件 emit', () => {
  it('needs-elevation 时 emit corum/acl/elevation-required 事件（含 workspaceRoot + message + manualCommands）', () => {
    const { provider, emitSpy } = makeProvider()
    withWin32(() => {
      try { callMaterialize(provider, 'C:\\ws') } catch { /* expected */ }
      // emit 被调用过。
      expect(emitSpy).toHaveBeenCalled()
      // 找到 corum/acl/elevation-required 的调用。
      const aclCalls = emitSpy.mock.calls.filter(c => c[0] === 'corum/acl/elevation-required')
      expect(aclCalls.length).toBeGreaterThanOrEqual(1)
      const payload = aclCalls[0][1]
      expect(payload.workspaceRoot).toContain('C:\\ws')
      // issue #246：文案按 failureReason 分叉——owner-mismatch 时说属主问题（真需要提权）。
      expect(payload.message).toContain('属主')
      expect(payload.manualCommands).toContain('icacls')
    })
  })

  it('同一 workspace 多次触发只 emit 一次（进程内去重）', () => {
    const { provider, emitSpy } = makeProvider()
    withWin32(() => {
      // 第一次触发。
      try { callMaterialize(provider, 'C:\\ws') } catch { /* expected */ }
      // 第二次触发（同一 workspaceRoot）。
      try { callMaterialize(provider, 'C:\\ws') } catch { /* expected */ }
      const aclCalls = emitSpy.mock.calls.filter(c => c[0] === 'corum/acl/elevation-required')
      expect(aclCalls).toHaveLength(1)
    })
  })

  it('不同 workspace 各 emit 一次', () => {
    const { provider, emitSpy } = makeProvider()
    withWin32(() => {
      try { callMaterialize(provider, 'C:\\ws') } catch { /* expected */ }
      try { callMaterialize(provider, 'D:\\other') } catch { /* expected */ }
      const aclCalls = emitSpy.mock.calls.filter(c => c[0] === 'corum/acl/elevation-required')
      expect(aclCalls).toHaveLength(2)
      expect(aclCalls[0][1].workspaceRoot).toContain('C:\\ws')
      expect(aclCalls[1][1].workspaceRoot).toContain('D:\\other')
    })
  })

  it('emit 失败不阻塞抛错（catch 兜底：emit 抛错时仍抛 AclElevationRequiredError）', () => {
    const { provider, emitSpy } = makeProvider()
    // 让 emit 抛错。
    emitSpy.mockImplementation(() => { throw new Error('emit failed') })
    withWin32(() => {
      // 即使 emit 抛错，materializeAclGrant 仍应抛 AclElevationRequiredError（不是 emit 的 Error）。
      expect(() => callMaterialize(provider, 'C:\\ws')).toThrow(AclElevationRequiredError)
    })
  })
})
