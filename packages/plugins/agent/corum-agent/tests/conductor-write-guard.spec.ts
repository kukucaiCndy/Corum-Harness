/**
 * 指挥模式的**写操作护栏**在运行期的形态（issue #194 的回归网）。
 *
 * ## issue #194 报的是什么
 *
 * 用户实测（0.7.0）：会话沙箱 `danger-full-access` + approval `never` 时，Conductor
 * 调用 `write` 工具**成功写盘**。期望是「角色边界独立于沙箱策略」：沙箱管文件系统能不能写，
 * 角色管这个 Agent 该不该写，两者正交。
 *
 * ## 当前机制（本测试钉住的就是它）
 *
 * 护栏**不读沙箱、不读审批策略**，只做两件事，都注册在主 Agent 的 `agentCtx` 上：
 *   ① `tools.restrict({ deny: [...write/edit/str_replace_editor(/pwsh)] })` —— 把这些工具从
 *      **工具面**摘掉（模型根本看不到、也调不到）；
 *   ② `tools.guard(conductorMainReadonlyGuard())` —— bash 的写形态命令在**执行前**被拒
 *      （guard 语义单调：deny or abstain, never allow）。
 *
 * 于是「沙箱换档 / 审批自动通过」都改不动这两条 —— 它们不是状态，是注册。
 *
 * ## 为什么这个测试有价值
 *
 * 仓库里此前只有「`composeSandboxMode` 合成表」与「编译层产物」两类断言，
 * **没有任何测试锁住运行期注册**（deny 名单内容 + guard 真的挂上 + 撤销可回收）。
 * 一旦有人把 ① 删掉只留 ②（或反之），本次 issue 的形态就会静默回归。
 *
 * @module @corum/corum-agent/tests/conductor-write-guard
 */
import { describe, expect, it } from 'vitest'
import { ConductorRuntime } from '../src/conductor-runtime.ts'
import { conductorExecutionDeny } from '../src/conductor.ts'
import { conductorMainReadonlyGuard } from '../src/permission-policy.ts'

/** 一条被登记的 guard（`tools.guard` 的入参）。 */
type GuardFn = (execution: { readonly name: string; readonly arguments?: unknown }) => string | undefined

/**
 * 造一个最小 `agentCtx`：只实现 `ConductorRuntime.apply()` 用到的能力面，并记录注册了什么。
 * @param visibleTools - 该 scope 真实可见的工具名（`corumVisibleToolNames` 的数据源）。
 */
function makeAgentCtx(visibleTools: string[]): {
  ctx: never
  restricts: { deny: readonly string[] }[]
  guards: GuardFn[]
  sections: string[]
  disposeAll: () => void
} {
  const restricts: { deny: readonly string[] }[] = []
  const guards: GuardFn[] = []
  const sections: string[] = []
  const disposers: (() => void)[] = []
  const record = (name: string): (() => void) => {
    sections.push(name)
    const dispose = (): void => { /* noop */ }
    disposers.push(dispose)
    return dispose
  }
  const ctx = {
    systemPrompt: {
      section: (input: { name: string }) => record(input.name),
      getSectionOrder: (): number => 0,
    },
    tools: {
      restrict: (input: { deny: readonly string[] }) => {
        restricts.push(input)
        const dispose = (): void => { /* noop */ }
        disposers.push(dispose)
        return dispose
      },
      guard: (fn: GuardFn) => {
        guards.push(fn)
        const dispose = (): void => { /* noop */ }
        disposers.push(dispose)
        return dispose
      },
      // `corumVisibleToolNames(ctx)` 的数据源：它调 `ctx.tools.schemas(scope)` 取名。
      schemas: () => visibleTools.map(name => ({ name })),
    },
  }
  return { ctx: ctx as never, restricts, guards, sections, disposeAll: (): void => { for (const d of disposers) d() } }
}

describe('issue #194：指挥模式的写护栏是「注册」而不是「状态」', () => {
  it('apply() 注册 deny 名单，覆盖 write / edit / str_replace_editor（本平台装载的写工具）', () => {
    const fake = makeAgentCtx(['bash', 'read', 'write', 'edit', 'str_replace_editor'])
    new ConductorRuntime().apply('s1', fake.ctx, 'preset')

    expect(fake.restricts).toHaveLength(1)
    const denied = [...fake.restricts[0]!.deny]
    expect(denied).toContain('write')
    expect(denied).toContain('edit')
    expect(denied).toContain('str_replace_editor')
    // deny 只许包含该 scope 真实可见的工具名（未知名会让 restrict fail-loud）
    expect(denied.every(name => ['bash', 'read', 'write', 'edit', 'str_replace_editor'].includes(name))).toBe(true)
    // bash 不在 deny 里：指挥者要能只读地看现场（2026-09-20 用户定调）
    expect(denied).not.toContain('bash')
  })

  it('apply() 注册 bash 只读 guard（bash 是放开后唯一的写通路）', () => {
    const fake = makeAgentCtx(['bash', 'read', 'write', 'edit'])
    new ConductorRuntime().apply('s1', fake.ctx, 'preset')
    expect(fake.guards).toHaveLength(1)
  })

  it('guard 拒绝写形态的 bash（与沙箱/审批无关：它只看 name + arguments）', () => {
    const guard = conductorMainReadonlyGuard()
    const writeForms = [
      ['bash', { command: 'echo hi > /tmp/x' }],
      ['bash', { command: 'sed -i "s/a/b/" file.txt' }],
      ['bash', { command: 'cat <<EOF > f.txt' }],
      ['bash', { command: 'rm -rf build' }],
    ] as const
    for (const [name, args] of writeForms) {
      const reason = guard({ name, arguments: args })
      expect(reason, `${args.command} 应被拒`).toBeTypeOf('string')
      expect(reason).toContain('read-only mode')
    }
  })

  it('guard 放行只读命令（不干扰 ls / git log / grep）', () => {
    const guard = conductorMainReadonlyGuard()
    for (const command of ['ls -la', 'git log --oneline -5', 'grep -rn foo src', 'git diff --stat']) {
      expect(guard({ name: 'bash', arguments: { command } }), command).toBeUndefined()
    }
  })

  it('guard 兜底拒绝直接写工具本身（restrict 依赖注册时机，guard 不依赖）', () => {
    // issue #194 的形态：write 真的调到了。restrict 的 deny 名单靠**当时的**工具可见面收敛，
    // 时机稍早就会空集 ⇒ 完全不注册；guard 按名字判定，与注册时机无关，是最后一道。
    const guard = conductorMainReadonlyGuard()
    for (const name of ['write', 'edit', 'str_replace_editor']) {
      const reason = guard({ name, arguments: { path: '/tmp/x', content: 'hi' } })
      expect(reason, name).toBeTypeOf('string')
      expect(reason).toContain('not available to the Conductor')
    }
  })

  it('guard 对只读工具放行（read / glob / grep）', () => {
    const guard = conductorMainReadonlyGuard()
    for (const name of ['read', 'glob', 'grep', 'web_search']) {
      expect(guard({ name, arguments: { path: '/tmp/x' } }), name).toBeUndefined()
    }
  })

  it('切出指挥模式（apply(..., "off")）会把上一轮的 deny/guard 全部撤销', () => {
    const runtime = new ConductorRuntime()
    const fake = makeAgentCtx(['bash', 'read', 'write', 'edit'])
    const disposed: string[] = []
    const ctx = fake.ctx as unknown as {
      tools: {
        restrict: () => () => void
        guard: () => () => void
      }
    }
    const originalRestrict = ctx.tools.restrict
    const originalGuard = ctx.tools.guard
    ctx.tools.restrict = (input: never) => {
      const dispose = originalRestrict.call(ctx.tools, input)
      return () => { disposed.push('restrict'); dispose() }
    }
    ctx.tools.guard = (fn: never) => {
      const dispose = originalGuard.call(ctx.tools, fn)
      return () => { disposed.push('guard'); dispose() }
    }
    runtime.apply('s1', fake.ctx, 'preset')
    runtime.apply('s1', fake.ctx, 'off')
    expect(disposed).toContain('restrict')
    expect(disposed).toContain('guard')
    expect(runtime.isConductor('s1')).toBe(false)
  })

  it('deny 名单按平台收敛：非 win32 不含 pwsh（未装载的名字会让 restrict fail-loud）', () => {
    const deny = conductorExecutionDeny()
    if (process.platform === 'win32') expect(deny).toContain('pwsh')
    else expect(deny).not.toContain('pwsh')
  })
})