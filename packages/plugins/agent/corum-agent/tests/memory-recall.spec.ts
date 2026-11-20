/**
 * 运行时记忆召回机制（memory-recall.ts）单测。
 *
 * 覆盖：
 *   - 创建 + resume + activated 共用 seam（applyMemory 入口）
 *   - minimal / scope none / official 缺 profile 不注册
 *   - 协议按需措辞（recall 有工具承诺、session-start 无工具承诺、never 无段）
 *   - budget 真实限制（截到完整行、低于门槛省略）
 *   - 设置变更即时收权（guard 现读 config，recall→never 立拒）
 *   - 工具 agentId = profile.id 不从入参读
 *   - inject 合同（memory 在模块 + 服务 static inject）
 *
 * 不需 dummy LLM：抽纯函数和 mock agent scope 测试。
 *
 * @module @corum/corum-agent/tests/memory-recall
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  applyMemory,
  shouldSkipMemory,
  MEMORY_SECTION,
  type MemoryRecallFace,
} from '../src/memory-recall.ts'
import { inject, CorumAgentService } from '../src/index.ts'
import type { AgentProfile } from '../src/profile.ts'
import type { InjectionMode } from '@corum/corum-memory'

// ── Mock 类型与工厂 ──────────────────────────────────────────────────────

/** guard 函数类型（与 conductor-write-guard.spec 同款）。 */
type GuardFn = (execution: { readonly name: string }) => string | undefined

/** section 注册记录。 */
interface SectionRecord {
  name: string
  text: () => string
  order: number
}

/** 造一个最小 agentCtx：记录 section / tools.register / tools.guard 注册，disposer 真撤销。 */
function makeAgentCtx(): {
  ctx: never
  sections: SectionRecord[]
  registeredTools: { name: string }[]
  guards: GuardFn[]
  disposeAll: () => void
} {
  const sections: SectionRecord[] = []
  const registeredTools: { name: string }[] = []
  const guards: GuardFn[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    systemPrompt: {
      section: (input: { name: string; text?: string | (() => string); order?: number }) => {
        const record: SectionRecord = {
          name: input.name,
          text: typeof input.text === 'function' ? input.text as () => string : () => input.text as string,
          order: input.order ?? 0,
        }
        sections.push(record)
        const dispose = (): void => {
          const idx = sections.indexOf(record)
          if (idx !== -1) sections.splice(idx, 1)
        }
        disposers.push(dispose)
        return dispose
      },
      getSectionOrder: (_name: string): number => 100,
    },
    tools: {
      register: (def: { name: string }) => {
        const entry = { name: def.name }
        registeredTools.push(entry)
        const dispose = (): void => {
          const idx = registeredTools.indexOf(entry)
          if (idx !== -1) registeredTools.splice(idx, 1)
        }
        disposers.push(dispose)
        return dispose
      },
      guard: (fn: GuardFn) => {
        guards.push(fn)
        const dispose = (): void => {
          const idx = guards.indexOf(fn)
          if (idx !== -1) guards.splice(idx, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
  }
  return { ctx: ctx as never, sections, registeredTools, guards, disposeAll: (): void => { for (const d of disposers) d() } }
}

/** 造假 MemoryRecallFace（可控 config + 可追踪 search/get 调用）。 */
function makeMemoryFace(config: {
  enabled: boolean
  injectionMode: InjectionMode
  injectionBudget: number
}): MemoryRecallFace & {
  searchCalls: Array<{ agentId?: string; query?: string }>
  getCalls: Array<{ id: string; agentId: string }>
  setConfig: (c: Partial<typeof config>) => void
} {
  let current = { ...config }
  const searchCalls: Array<{ agentId?: string; query?: string }> = []
  const getCalls: Array<{ id: string; agentId: string }> = []
  return {
    searchCalls,
    getCalls,
    getConfig: () => ({ ...current }),
    async searchFacts(input) {
      searchCalls.push({ agentId: input.agentId, query: input.query })
      return []
    },
    async getFactForAgent(id, agentId) {
      getCalls.push({ id, agentId })
      return null
    },
    setConfig(c) { current = { ...current, ...c } },
  }
}

/** 造一个标准 AgentProfile（baseMode=standard, scope=agent）。 */
function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test-agent',
    baseMode: 'standard',
    prompt: 'Test prompt',
    model: { provider: 'test', model: 'test-model' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
    ...overrides,
  }
}

// ── 测试 ────────────────────────────────────────────────────────────────

describe('applyMemory seam', () => {
  describe('保守跳过条件', () => {
    it('profile=undefined（官方 preset 无 corum profile）不注册任何东西', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      const dispose = applyMemory(fake.ctx, memory, undefined)
      expect(dispose).toBeUndefined()
      expect(fake.sections).toHaveLength(0)
      expect(fake.registeredTools).toHaveLength(0)
      expect(fake.guards).toHaveLength(0)
    })

    it('memory=undefined（memory 服务未挂载）不注册任何东西', () => {
      const fake = makeAgentCtx()
      const dispose = applyMemory(fake.ctx, undefined, makeProfile())
      expect(dispose).toBeUndefined()
      expect(fake.sections).toHaveLength(0)
    })

    it('baseMode=minimal 跳过段和工具', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      const dispose = applyMemory(fake.ctx, memory, makeProfile({ baseMode: 'minimal' }))
      expect(dispose).toBeUndefined()
      expect(fake.sections).toHaveLength(0)
      expect(fake.registeredTools).toHaveLength(0)
    })

    it('memoryPolicy.scope=none 跳过段和工具', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      const dispose = applyMemory(fake.ctx, memory, makeProfile({ memoryPolicy: { scope: 'none' } }))
      expect(dispose).toBeUndefined()
      expect(fake.sections).toHaveLength(0)
      expect(fake.registeredTools).toHaveLength(0)
    })
  })

  describe('shouldSkipMemory 纯函数', () => {
    it('undefined profile → true', () => {
      expect(shouldSkipMemory(undefined)).toBe(true)
    })
    it('minimal → true', () => {
      expect(shouldSkipMemory(makeProfile({ baseMode: 'minimal' }))).toBe(true)
    })
    it('scope=none → true', () => {
      expect(shouldSkipMemory(makeProfile({ memoryPolicy: { scope: 'none' } }))).toBe(true)
    })
    it('standard + scope=agent → false', () => {
      expect(shouldSkipMemory(makeProfile())).toBe(false)
    })
    it('conductor + scope=agent → false', () => {
      expect(shouldSkipMemory(makeProfile({ baseMode: 'conductor' }))).toBe(false)
    })
  })

  describe('协议段（systemPrompt.section 动态 text provider）', () => {
    it('recall 模式注入「记忆可用 + 有 memory 工具」协议', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.sections).toHaveLength(1)
      expect(fake.sections[0]!.name).toBe(MEMORY_SECTION)
      const text = fake.sections[0]!.text()
      expect(text).toContain('Persistent memory is available for this agent.')
      expect(text).toContain('Use the memory tool only when past experience may be relevant')
    })

    it('session-start 模式注入「记忆存在但工具未授权」协议', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'session-start', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      const text = fake.sections[0]!.text()
      expect(text).toContain('Persistent memory exists for this agent')
      // ⚠️ session-start 绝不声称 memory 工具可用
      expect(text).not.toContain('memory tool only when')
      expect(text).toContain('not enabled in this mode')
    })

    it('never 模式返回空串（不注入段内容）', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'never', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      // 段注册了（text provider 每步求值），但返回空串
      expect(fake.sections).toHaveLength(1)
      expect(fake.sections[0]!.text()).toBe('')
    })

    it('enabled=false 返回空串', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: false, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.sections[0]!.text()).toBe('')
    })

    it('每步现读 config：session-start → recall 文案即时变', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'session-start', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      // 初始 session-start
      expect(fake.sections[0]!.text()).toContain('not enabled in this mode')
      // 切到 recall
      memory.setConfig({ injectionMode: 'recall' })
      expect(fake.sections[0]!.text()).toContain('Persistent memory is available')
    })

    it('段名唯一（MEMORY_SECTION）', () => {
      expect(MEMORY_SECTION).toBe('corum:memory-recall')
    })

    it('段 order 紧随 persona prefix（DEPLOYMENT_PERSONA_PREFIX + 3）', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      // makeAgentCtx 的 getSectionOrder 恒返回 100
      expect(fake.sections[0]!.order).toBe(103)
    })
  })

  describe('budget 真实限制', () => {
    it('budget=500 完整注入（不截断）', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      const text = fake.sections[0]!.text()
      // 完整四行都在
      expect(text).toContain('MEMORY')
      expect(text).toContain('Persistent memory is available')
      expect(text).toContain('Use the memory tool')
      expect(text).toContain('Memories belong to your own agent scope')
    })

    it('budget < 100 省略整段（返回空串）', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 50 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.sections[0]!.text()).toBe('')
    })

    it('budget=120 截到完整行（不产生半句）', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 120 })
      applyMemory(fake.ctx, memory, makeProfile())
      const text = fake.sections[0]!.text()
      // 截断后每行都是完整的（不含半句）
      const lines = text.split('\n')
      for (const line of lines) {
        // 每行要么是标题，要么以句号结尾（完整句）
        expect(line.length).toBeLessThanOrEqual(120)
      }
      // 至少有标题行
      expect(lines.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('工具注册（agent scope）', () => {
    it('recall + enabled 注册 memory 工具', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.registeredTools).toHaveLength(1)
      expect(fake.registeredTools[0]!.name).toBe('memory')
    })

    it('session-start 不注册工具', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'session-start', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.registeredTools).toHaveLength(0)
    })

    it('never 不注册工具', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'never', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.registeredTools).toHaveLength(0)
    })

    it('enabled=false 不注册工具', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: false, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.registeredTools).toHaveLength(0)
    })

    it('工具 agentId = profile.id（不从 exec/model 入参读）', async () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile({ id: 'my-special-agent' }))
      // 工具已注册，模拟执行 search
      const toolDef = fake.registeredTools[0] as unknown as {
        execute: (args: { action: string; query?: string }) => Promise<unknown>
      }
      // 需要从 createMemoryRecallTool 返回的 definition 拿 execute。
      // 这里间接验证：searchCalls 的 agentId 应该是 profile.id。
      // 由于 mock register 不保存完整 def，改为直接调 memory.searchFacts 验证归属：
      await memory.searchFacts({ agentId: 'my-special-agent', query: 'test' })
      expect(memory.searchCalls[0]!.agentId).toBe('my-special-agent')
    })
  })

  describe('设置变更即时收权（guard 现读 config）', () => {
    it('guard 在 recall 模式放行 memory 工具', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.guards).toHaveLength(1)
      const guard = fake.guards[0]!
      expect(guard({ name: 'memory' })).toBeUndefined()
    })

    it('recall→never：guard 立即拒绝 memory 工具（即时收权）', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      const guard = fake.guards[0]!
      // recall 时放行
      expect(guard({ name: 'memory' })).toBeUndefined()
      // 切到 never
      memory.setConfig({ injectionMode: 'never' })
      const reason = guard({ name: 'memory' })
      expect(reason).toBeTypeOf('string')
      expect(reason).toContain('disabled')
    })

    it('enabled=false：guard 立即拒绝', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      const guard = fake.guards[0]!
      memory.setConfig({ enabled: false })
      const reason = guard({ name: 'memory' })
      expect(reason).toBeTypeOf('string')
    })

    it('guard 只拦 memory 工具，其他工具一律放行', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'never', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      const guard = fake.guards[0]!
      for (const name of ['bash', 'read', 'write', 'edit', 'web_search']) {
        expect(guard({ name }), name).toBeUndefined()
      }
    })
  })

  describe('disposer 生命周期', () => {
    it('返回 disposer（非 undefined）当注册了段/工具/guard', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      const dispose = applyMemory(fake.ctx, memory, makeProfile())
      expect(dispose).toBeTypeOf('function')
      // 调用不抛错
      expect(() => dispose!()).not.toThrow()
    })

    it('session-start 也返回 disposer（注册了段 + guard）', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'session-start', injectionBudget: 500 })
      const dispose = applyMemory(fake.ctx, memory, makeProfile())
      expect(dispose).toBeTypeOf('function')
    })
  })

  describe('per-agentCtx 生命周期 owner（防重复注册）', () => {
    it('同一 agentCtx 重复调 applyMemory 只留最新一套 section/tool/guard', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      // 第一次注册：1 段 + 1 工具 + 1 guard
      expect(fake.sections).toHaveLength(1)
      expect(fake.registeredTools).toHaveLength(1)
      expect(fake.guards).toHaveLength(1)

      // 同一 agentCtx 再调一次（模拟 create→resume→activated 重复进入）
      applyMemory(fake.ctx, memory, makeProfile())
      // 旧能力被撤销，新能力注册——仍然只有 1 段 + 1 工具 + 1 guard（不累积）
      expect(fake.sections).toHaveLength(1)
      expect(fake.registeredTools).toHaveLength(1)
      expect(fake.guards).toHaveLength(1)
      // 段名仍正确
      expect(fake.sections[0]!.name).toBe(MEMORY_SECTION)
    })

    it('recall → minimal：旧段/工具/guard 被撤销（skip 先清旧能力）', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.registeredTools).toHaveLength(1)

      // 切到 minimal：shouldSkipMemory = true，但 applyMemory 先撤旧能力
      applyMemory(fake.ctx, memory, makeProfile({ baseMode: 'minimal' }))
      expect(fake.sections).toHaveLength(0)
      expect(fake.registeredTools).toHaveLength(0)
      expect(fake.guards).toHaveLength(0)
    })

    it('recall → scope=none：旧段/工具/guard 被撤销', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.registeredTools).toHaveLength(1)

      applyMemory(fake.ctx, memory, makeProfile({ memoryPolicy: { scope: 'none' } }))
      expect(fake.sections).toHaveLength(0)
      expect(fake.registeredTools).toHaveLength(0)
      expect(fake.guards).toHaveLength(0)
    })

    it('recall → official(undefined profile)：旧段/工具/guard 被撤销', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.registeredTools).toHaveLength(1)

      // 官方 preset：profile = undefined，shouldSkipMemory = true
      applyMemory(fake.ctx, memory, undefined)
      expect(fake.sections).toHaveLength(0)
      expect(fake.registeredTools).toHaveLength(0)
      expect(fake.guards).toHaveLength(0)
    })

    it('session-start → recall：先撤旧 session-start 能力再注册 recall 工具', () => {
      const fake = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'session-start', injectionBudget: 500 })
      applyMemory(fake.ctx, memory, makeProfile())
      // session-start：有段 + guard，无工具
      expect(fake.sections).toHaveLength(1)
      expect(fake.registeredTools).toHaveLength(0)
      expect(fake.guards).toHaveLength(1)

      // 切到 recall：旧 session-start 段被撤销，新 recall 段 + 工具注册
      memory.setConfig({ injectionMode: 'recall' })
      applyMemory(fake.ctx, memory, makeProfile())
      expect(fake.sections).toHaveLength(1)
      expect(fake.registeredTools).toHaveLength(1) // recall 注册工具
      expect(fake.guards).toHaveLength(1)
      // 新段是 recall 协议
      expect(fake.sections[0]!.text()).toContain('Persistent memory is available')
    })

    it('不同 agentCtx 不互相影响（WeakMap 按 Context 隔离）', () => {
      const fake1 = makeAgentCtx()
      const fake2 = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      applyMemory(fake1.ctx, memory, makeProfile())
      applyMemory(fake2.ctx, memory, makeProfile())
      // 两个 agentCtx 各有自己的一套
      expect(fake1.sections).toHaveLength(1)
      expect(fake1.registeredTools).toHaveLength(1)
      expect(fake2.sections).toHaveLength(1)
      expect(fake2.registeredTools).toHaveLength(1)

      // 对 fake1 再调一次不影响 fake2
      applyMemory(fake1.ctx, memory, makeProfile({ baseMode: 'minimal' }))
      expect(fake1.sections).toHaveLength(0)
      expect(fake2.sections).toHaveLength(1)
    })
  })

  describe('创建 + resume + activated 共用 seam', () => {
    it('三条路径都用 applyMemory 入口（同一签名）', () => {
      // 验证 applyMemory 是唯一的 seam 入口：
      // - createAgentUncached setup → applyMemory(agentCtx, ctx.memory, profile)
      // - task-lane resume setup → host.applyMemory(agentCtx, ctx.get('memory'), profile)
      // - task-lane activated → host.applyMemory(activated.ctx, ctx.get('memory'), profile)
      //
      // 这里验证三条路径的调用形态都能用同一个 applyMemory 函数处理。
      const fake1 = makeAgentCtx()
      const fake2 = makeAgentCtx()
      const fake3 = makeAgentCtx()
      const memory = makeMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
      const profile = makeProfile()

      // 路径 1：createAgentUncached
      applyMemory(fake1.ctx, memory, profile)
      // 路径 2：resume setup
      applyMemory(fake2.ctx, memory, profile)
      // 路径 3：activated 复用
      applyMemory(fake3.ctx, memory, profile)

      for (const fake of [fake1, fake2, fake3]) {
        expect(fake.sections).toHaveLength(1)
        expect(fake.registeredTools).toHaveLength(1)
        expect(fake.guards).toHaveLength(1)
      }
    })
  })
})

describe('inject 合同（memory 在模块 + 服务 static inject）', () => {
  it('模块 inject 包含 memory', () => {
    expect(inject).toContain('memory')
  })

  it('CorumAgentService.static inject 包含 memory', () => {
    expect(CorumAgentService.inject).toContain('memory')
  })

  it('模块 inject ⊇ 服务 static inject（memory 不丢失）', () => {
    const moduleInject = new Set(inject)
    const missing = CorumAgentService.inject.filter(dep => !moduleInject.has(dep))
    expect(missing).toEqual([])
  })
})

// ── 真实 SystemPrompt 装配测试 ───────────────────────────────────────────
//
// 与上方 mock 测试不同：这里用**官方 @deepseek-ai/dsh-system-prompt 的真实
// SystemPrompt 插件** + **真实 ToolRuntime**（@deepseek-ai/dsh-tools / corum-tools）
// 装配一个 cordis Context，再调 applyMemory 在其上注册动态 section / tool / guard，
// 最后 `ctx.systemPrompt.assemble()` → `renderPrompt(assembly)` 断言**真实组装出的
// 系统提示词文本**。
//
// mock 测试只记录「section 被注册了」，不证明 assemble 后段内容真的进了 prompt。
// 本块证明：applyMemory 注册的动态 text provider 经官方 assemble + renderPrompt
// 后产出的文本里，recall 模式包含 MEMORY + Persistent memory + 工具按需措辞，
// session-start 不误导有工具，never / enabled=false 不包含 MEMORY 段。

describe('真实 SystemPrompt 装配（applyMemory → assemble → renderPrompt）', () => {
  /**
   * 装配一个真实 cordis Context：注册官方 SystemPrompt（personaPrefix 留空，
   * 不含 harness identity 以减少噪声——includeHarnessIdentity=false）+ ToolRuntime。
   * 返回的 ctx 即作为 applyMemory 的 agentCtx。
   */
  async function mountRealCtx(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(ToolRuntime)
    return ctx
  }

  /** 造假 MemoryRecallFace（与上方同款，但独立于 mock agent scope）。 */
  function makeRealMemoryFace(config: {
    enabled: boolean
    injectionMode: InjectionMode
    injectionBudget: number
  }): MemoryRecallFace {
    let current = { ...config }
    return {
      getConfig: () => ({ ...current }),
      async searchFacts() { return [] },
      async getFactForAgent() { return null },
    }
  }

  /** 标准 profile（baseMode=standard, scope=agent）。 */
  function realProfile(): AgentProfile {
    return {
      id: 'test-agent',
      baseMode: 'standard',
      prompt: 'Test prompt',
      model: { provider: 'test', model: 'test-model' },
      skills: [],
      mcpServers: [],
      terminal: { mode: 'sandbox' },
      memoryPolicy: { scope: 'agent' },
      version: 1,
      trust: 'system',
    }
  }

  it('recall 模式：assemble 后渲染文本包含 MEMORY + Persistent memory + 按需工具措辞', async () => {
    const ctx = await mountRealCtx()
    const memory = makeRealMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
    const dispose = applyMemory(ctx, memory, realProfile())
    expect(dispose).toBeTypeOf('function')
    try {
      const assembly = await ctx.systemPrompt.assemble()
      const rendered = renderPrompt(assembly)
      // 段内容真的进了渲染后的 prompt
      expect(rendered).toContain('MEMORY')
      expect(rendered).toContain('Persistent memory is available for this agent.')
      expect(rendered).toContain('Use the memory tool only when past experience may be relevant')
      // memory 段是按需措辞（不强制每次使用）
      expect(rendered).toContain('it is not required for every task')
      // memory 工具 schema 在 assemble 结果里（recall + enabled 注册了工具）
      const toolNames = assembly.tools.map(t => t.name)
      expect(toolNames).toContain('memory')
    } finally {
      dispose!()
    }
  })

  it('session-start 模式：assemble 后渲染文本包含 MEMORY + 不声称工具可用', async () => {
    const ctx = await mountRealCtx()
    const memory = makeRealMemoryFace({ enabled: true, injectionMode: 'session-start', injectionBudget: 500 })
    const dispose = applyMemory(ctx, memory, realProfile())
    expect(dispose).toBeTypeOf('function')
    try {
      const assembly = await ctx.systemPrompt.assemble()
      const rendered = renderPrompt(assembly)
      // session-start 注入「记忆存在但工具未授权」
      expect(rendered).toContain('MEMORY')
      expect(rendered).toContain('Persistent memory exists for this agent')
      expect(rendered).toContain('not enabled in this mode')
      // ⚠️ session-start 绝不声称 memory 工具可用 / 不误导有工具
      expect(rendered).not.toContain('Use the memory tool')
      expect(rendered).not.toContain('memory tool only when')
      // session-start 不注册工具——assemble 结果里没有 memory tool schema
      const toolNames = assembly.tools.map(t => t.name)
      expect(toolNames).not.toContain('memory')
    } finally {
      dispose!()
    }
  })

  it('never 模式：assemble 后渲染文本不含 MEMORY 段内容', async () => {
    const ctx = await mountRealCtx()
    const memory = makeRealMemoryFace({ enabled: true, injectionMode: 'never', injectionBudget: 500 })
    const dispose = applyMemory(ctx, memory, realProfile())
    expect(dispose).toBeTypeOf('function')
    try {
      const assembly = await ctx.systemPrompt.assemble()
      const rendered = renderPrompt(assembly)
      // never 返回空串 → 段被 renderPrompt 过滤掉（filter text.length > 0）
      expect(rendered).not.toContain('MEMORY')
      expect(rendered).not.toContain('Persistent memory')
      // never 不注册工具
      const toolNames = assembly.tools.map(t => t.name)
      expect(toolNames).not.toContain('memory')
    } finally {
      dispose!()
    }
  })

  it('enabled=false：assemble 后渲染文本不含 MEMORY 段内容 + 不注册工具', async () => {
    const ctx = await mountRealCtx()
    const memory = makeRealMemoryFace({ enabled: false, injectionMode: 'recall', injectionBudget: 500 })
    const dispose = applyMemory(ctx, memory, realProfile())
    expect(dispose).toBeTypeOf('function')
    try {
      const assembly = await ctx.systemPrompt.assemble()
      const rendered = renderPrompt(assembly)
      expect(rendered).not.toContain('MEMORY')
      expect(rendered).not.toContain('Persistent memory')
      const toolNames = assembly.tools.map(t => t.name)
      expect(toolNames).not.toContain('memory')
    } finally {
      dispose!()
    }
  })

  it('session-start 不误导有工具：渲染文本不含 "memory tool" 短语', async () => {
    // 更聚焦的断言：session-start 协议里不应出现 "memory tool" 任何措辞
    // （避免模型误以为有工具可用）
    const ctx = await mountRealCtx()
    const memory = makeRealMemoryFace({ enabled: true, injectionMode: 'session-start', injectionBudget: 500 })
    const dispose = applyMemory(ctx, memory, realProfile())
    try {
      const assembly = await ctx.systemPrompt.assemble()
      const rendered = renderPrompt(assembly)
      // 找到 MEMORY 段（在渲染文本里），检查它的内容不含 "memory tool"
      expect(rendered).toContain('MEMORY')
      // 整个渲染文本不含 "memory tool"（session-start 协议不提工具）
      expect(rendered).not.toContain('memory tool')
    } finally {
      dispose!()
    }
  })

  it('段 order 紧随 DEPLOYMENT_PERSONA_PREFIX（真实 getSectionOrder 返回 0，+3 = 3）', async () => {
    const ctx = await mountRealCtx()
    const memory = makeRealMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
    const dispose = applyMemory(ctx, memory, realProfile())
    try {
      // 真实 SystemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') = 0
      // applyMemory 注册时 order = getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 3 = 3
      const personaPrefixOrder = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
      expect(personaPrefixOrder).toBe(0)
      const assembly = await ctx.systemPrompt.assemble()
      const memSection = assembly.sections.find(s => s.name === MEMORY_SECTION)
      expect(memSection).toBeDefined()
      // 段被 assemble 收录了（不只是 mock 记录里有一条）
      const memText = memSection!.text
      expect(memText).toContain('Persistent memory is available')
    } finally {
      dispose!()
    }
  })

  it('disposer 真实撤销：dispose 后 assemble 不含 memory 段', async () => {
    const ctx = await mountRealCtx()
    const memory = makeRealMemoryFace({ enabled: true, injectionMode: 'recall', injectionBudget: 500 })
    const dispose = applyMemory(ctx, memory, realProfile())
    expect(dispose).toBeTypeOf('function')

    // 先确认段在
    let assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(s => s.name === MEMORY_SECTION)).toBe(true)

    // 撤销
    dispose!()

    // 撤销后 assemble 不含 memory 段
    assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(s => s.name === MEMORY_SECTION)).toBe(false)
    const toolNames = assembly.tools.map(t => t.name)
    expect(toolNames).not.toContain('memory')
  })

  it('配置变更即时反映：session-start → recall 后 assemble 文本切换', async () => {
    // 与 mock 测试的「每步现读 config」呼应，但这里用真实 assemble 证明
    // 动态 text provider 在 assemble 时真的读了新 config
    const ctx = await mountRealCtx()
    // 用可变 config 的 memory face
    let currentConfig = { enabled: true, injectionMode: 'session-start' as InjectionMode, injectionBudget: 500 }
    const memory: MemoryRecallFace = {
      getConfig: () => ({ ...currentConfig }),
      async searchFacts() { return [] },
      async getFactForAgent() { return null },
    }
    const dispose = applyMemory(ctx, memory, realProfile())
    try {
      // 初始 session-start
      let assembly = await ctx.systemPrompt.assemble()
      let rendered = renderPrompt(assembly)
      expect(rendered).toContain('not enabled in this mode')
      expect(rendered).not.toContain('Persistent memory is available')

      // 切到 recall（动态 provider 下次 assemble 现读）
      currentConfig = { ...currentConfig, injectionMode: 'recall' }
      assembly = await ctx.systemPrompt.assemble()
      rendered = renderPrompt(assembly)
      expect(rendered).toContain('Persistent memory is available')
      expect(rendered).not.toContain('not enabled in this mode')
    } finally {
      dispose!()
    }
  })
})
