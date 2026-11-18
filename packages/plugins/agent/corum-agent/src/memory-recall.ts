/**
 * fork（corum）：**运行时记忆召回机制**——把记忆能力（协议段 + 按需工具）接入
 * corum Agent 的 agent scope。
 *
 * ## 为什么独立成文件
 *
 * memory-tool 的工厂（`createMemoryRecallTool`）已由 `@corum/corum-memory/memory-tool`
 * 提供（纯工具定义，不含 cordis 装配）。本文件不重复工厂，只封装**运行时 seam**：
 *
 *   1. **系统提示词段**（动态 text provider）——每步组装时现读 config，按 injectionMode
 *      决定注入什么协议文本（或不注入）；
 *   2. **memory 工具注册**（agent scope）——仅 setup 时 `injectionMode==='recall'` 且
 *      `enabled` 才注册，并用 agent-scoped `tools.guard` 现读配置，mode 切走或
 *      `enabled=false` 立即拒（不卸载工具，而是在执行入口拒绝）；
 *   3. **disposer 生命周期**——段 + 工具 + guard 的撤销器收在一起，随 agent scope
 *      销毁或切换 preset 时撤销（与 ConductorRuntime.apply 同款先例）。
 *
 * ## per-agentCtx 生命周期 owner（防重复注册）
 *
 * `applyMemory` 可在 create / resume / activated / blank preset switch 多条路径重复
 * 进入**同一个 agentCtx**（同一 Context 对象）。若每次都注册新段/工具/guard 而不先撤旧的，
 * 旧能力会累积（段重复、guard 多份、工具可能重复注册）。
 *
 * 本模块用一个模块级 `WeakMap<Context, () => void>` 记录「该 agentCtx 上一次
 * applyMemory 注册的 disposer」：每次进入先撤销旧 disposer，再按 profile 条件注册新的。
 * skip（minimal / none / official）也先清旧能力——确保切走后旧段/工具/guard不留残。
 *
 * WeakMap 的弱引用语义：当 agentCtx（Context 对象）被 cordis 回收后，条目自动消失，
 * 不会阻止 GC。cordis scope 销毁时若自动 dispose scope-registered disposables，
 * WeakMap 里留的弱引用指向已回收对象是可接受的（不影响正确性）。
 *
 * ⚠️ 这是模块内部**per-agentCtx 生命周期簿记**，不是跨 bundle 共享业务状态
 * （红线 1 禁的是后者；本 WeakMap 不跨 bundle、不搬 cordis service 状态）。
 *
 * ## 安全边界（照抄 memory-tool.ts 的设计，不重复实现）
 *
 * - **agentId 强制归属**：工具内部用工厂绑定的 agentId 调 `searchFacts` /
 *   `getFactForAgent`。模型入参不含 agentId，本 seam 也不从 exec/model 入参读——
 *   agentId = profile.id，避免身份错配。
 * - **总开关 + 注入模式**：工具每次调用现读 `getConfig()`。`enabled=false` 或
 *   `injectionMode !== 'recall'` 时返回 disabled 结果（工厂已实现），本 seam 的 guard
 *   是第二道闸（在工具执行入口之前即拒绝，不进工厂）。
 * - **不泄漏给子 Agent**：工具注册在 `agentCtx`（agent scope），不沿 scope 链下行。
 *
 * ## 保守跳过条件
 *
 * 以下条件**不注册任何东西**（不注册段、不注册工具、不返回 disposer）：
 *   - profile 为 `undefined`（官方 preset 无 corum profile 实体）；
 *   - `profile.baseMode === 'minimal'`（极简模式跳过段和工具——与 compile.ts
 *     minimal 分支的「保持官方原汁原味」裁决一致）；
 *   - `profile.memoryPolicy.scope === 'none'`（profile 级关闭记忆）。
 *
 * @module @corum/corum-agent/memory-recall
 */

import type { Context } from '@deepseek-ai/cordis'
// 空类型 import：让 `ctx.tools` 的 Context 合并生效（ToolRuntime 由
// @deepseek-ai/dsh-tools 声明为 cordis ambient augmentation）。与
// conductor-runtime.ts 同款——本文件用 `agentCtx.tools.register` / `.guard`，
// 必须自证依赖，不靠邻居文件的偶然 import。
import type {} from '@deepseek-ai/dsh-tools'
import { createMemoryRecallTool } from '@corum/corum-memory/memory-tool'
import type { MemoryRecallCapable, MemoryToolConfig } from '@corum/corum-memory/memory-tool'
import type { InjectionMode, MemoryFactView } from '@corum/corum-memory'
import type { AgentProfile } from './profile.ts'

/**
 * 本 seam 消费的窄记忆面（getConfig + MemoryRecallCapable）。
 *
 * 对应 root cordis `ctx.memory`（MemoryService 实例）。corum-agent 经模块 inject
 * + CorumAgentService static inject 声明 `'memory'`，运行时从 `ctx.memory` 取到
 * 服务实例——它满足 `getConfig(): ResolvedMemoryConfig` 与
 * `MemoryRecallCapable`（searchFacts / getFactForAgent）。
 *
 * **类型兼容**：searchFacts / getFactForAgent 的返回类型与 {@link MemoryRecallCapable}
 * 一致（`MemoryFactView[]` / `MemoryFactView | null`），使 `MemoryRecallFace`
 * 结构上 extends `MemoryRecallCapable`——传给 `createMemoryRecallTool` 时不需要
 * `as MemoryRecallCapable` 强转（避免类型强转掩盖真实接口偏差）。
 *
 * 不 import MemoryService 实现类（红线 3：用窄接口不耦合实现包）。
 */
export interface MemoryRecallFace {
  getConfig(): { readonly enabled: boolean; readonly injectionMode: InjectionMode; readonly injectionBudget: number }
  searchFacts(input: { agentId?: string; query?: string; mode?: 'applicable' | 'recall'; limit?: number }): Promise<MemoryFactView[]>
  getFactForAgent(id: string, agentId: string): Promise<MemoryFactView | null>
}

/** 段名（唯一，与所有既有段不冲突）。 */
export const MEMORY_SECTION = 'corum:memory-recall'

/**
 * 从 MemoryRecallFace 构造工具每次调用现读的 getConfig 闭包。
 *
 * 返回 `MemoryToolConfig`（enabled + injectionMode），工厂在 execute 入口现读。
 */
function makeGetToolConfig(memory: MemoryRecallFace): () => MemoryToolConfig {
  return () => {
    const c = memory.getConfig()
    return { enabled: c.enabled, injectionMode: c.injectionMode }
  }
}

/**
 * **协议段文本**（动态 text provider）。
 *
 * 每步组装时现读 config：
 *   - `enabled=false` 或 `injectionMode='never'` → 返回空串（不注入）；
 *   - `session-start` → 注入「记忆存在但工具未授权」协议（**绝不**声称 memory 工具可用）；
 *   - `recall` → 注入「记忆可用 + 有 memory 工具」协议。
 *
 * 首版**不注入记忆内容/计数/维度**——只注入能力协议，避免 setup 异步快照复杂度。
 * `injectionBudget` 真实约束段长度：按 budget 截到完整行，预算小于最低文本则省略。
 */

/** recall 模式的完整协议文本（英文）。 */
const PROTOCOL_RECALL = [
  'MEMORY',
  'Persistent memory is available for this agent.',
  'Use the memory tool only when past experience may be relevant; it is not required for every task.',
  'Memories belong to your own agent scope and are not injected automatically — you decide when to look them up.',
].join('\n')

/** session-start 模式的协议文本（英文；不提工具，只说记忆存在）。 */
const PROTOCOL_SESSION_START = [
  'MEMORY',
  'Persistent memory exists for this agent, but the memory recall tool is not enabled in this mode.',
  'Past experience is stored but cannot be queried on demand. Do not claim you can look up memories.',
].join('\n')

/**
 * 按 budget 截断文本到完整行（不产生半句、不越过上限）。
 *
 * 预算小于最低文本（首行 + 标题行 = 约 60 字符）时返回空串（省略整段）。
 * `min100` 配置：预算 < 100 即省略（MEMORY_CONFIG_DEFAULTS.injectionBudget 的 min）。
 */
function trimToBudget(text: string, budget: number): string {
  // 最低文本门槛：标题行 + 至少一条实质内容行。
  const MIN_BUDGET = 100
  if (budget < MIN_BUDGET) return ''
  if (text.length <= budget) return text
  // 按行截断：保留完整的行，不产生半句。
  const lines = text.split('\n')
  const result: string[] = []
  let length = 0
  for (const line of lines) {
    const lineLen = line.length + 1 // +1 for \n
    if (length + lineLen > budget) break
    result.push(line)
    length += lineLen
  }
  // 至少保留标题行 + 一行内容（否则段太短不如省略）。
  if (result.length < 2) return ''
  return result.join('\n')
}

/**
 * 构造协议段的动态 text provider。
 *
 * @param memory - 窄记忆面（现读 getConfig）。
 * @returns systemPrompt.section 的 text provider（接收 assemble context，返回 string）。
 */
function memoryProtocolProvider(memory: MemoryRecallFace): () => string {
  return () => {
    const config = memory.getConfig()
    if (!config.enabled || config.injectionMode === 'never') return ''
    if (config.injectionMode === 'session-start') {
      return trimToBudget(PROTOCOL_SESSION_START, config.injectionBudget)
    }
    if (config.injectionMode === 'recall') {
      return trimToBudget(PROTOCOL_RECALL, config.injectionBudget)
    }
    return ''
  }
}

/**
 * **agent-scoped 工具 guard**：现读配置，mode 切走或 enabled=false 立即拒。
 *
 * 与 ConductorRuntime 的 `conductorMainReadonlyGuard` 同款——guard 返回字符串 = 拒绝，
 * 返回 undefined = 放行。guard 是**单调的**（后续监听者无法复活被拒的调用）。
 *
 * 本 guard 只拦 `memory` 工具（其他工具一律放行）。注册在 agent scope 上，
 * 不沿 scope 链下行（不泄漏给子 Agent）。
 */
function memoryToolGuard(memory: MemoryRecallFace): (execution: { readonly name: string }) => string | undefined {
  return (execution) => {
    if (execution.name !== 'memory') return undefined
    const config = memory.getConfig()
    if (!config.enabled || config.injectionMode !== 'recall') {
      return 'Memory recall is disabled in the current configuration. Do not call the memory tool.'
    }
    return undefined
  }
}

/**
 * 判断 profile 是否应该跳过记忆机制。
 *
 * 保守跳过条件：
 *   - profile 为 undefined（官方 preset 无 corum profile）；
 *   - baseMode === 'minimal'（极简模式跳过段和工具）；
 *   - memoryPolicy.scope === 'none'（profile 级关闭记忆）。
 *
 * @param profile - Agent profile（可为 undefined = 官方 preset）。
 * @returns true = 跳过（不注册任何东西）。
 */
export function shouldSkipMemory(profile: AgentProfile | undefined): boolean {
  if (profile === undefined) return true
  if (profile.baseMode === 'minimal') return true
  if (profile.memoryPolicy?.scope === 'none') return true
  return false
}

/**
 * **per-agentCtx 生命周期簿记**：记录每个 agentCtx 上一次 applyMemory 注册的 disposer。
 *
 * 每次 applyMemory 进入时先取旧 disposer 并执行（撤销旧段/工具/guard），再注册新能力。
 * WeakMap 弱引用：agentCtx 被回收后条目自动消失，不阻止 GC、不泄漏。
 *
 * ⚠️ 模块内部簿记，不是跨 bundle 共享业务状态（红线 1 不适用）。
 */
const memoryEffects = new WeakMap<Context, () => void>()

/**
 * **运行时记忆召回 seam**（在 agent scope 注册段 + 工具 + guard）。
 *
 * 调用时机：createAgentUncached / task-lane resume setup 内，`agentPresets.mount`
 * 之后（闭包已有 profile）。
 *
 * **生命周期保证**：同一个 agentCtx 重复调用时，先撤销上一次注册的段/工具/guard，
 * 再按当前 profile 条件注册新能力。skip（minimal / none / official）也先清旧能力
 * ——确保切走后旧能力不留残。
 *
 * @param agentCtx - 主 Agent 的 scoped 上下文（tools / systemPrompt 在此注册）。
 * @param memory - 窄记忆面（`ctx.memory`，MemoryService 实例）。
 * @param profile - Agent profile（undefined = 官方 preset，保守跳过）。
 * @returns disposer（撤销段 + 工具 + guard）；跳过时返回 `undefined`（无需撤销）。
 */
export function applyMemory(
  agentCtx: Context,
  memory: MemoryRecallFace | undefined,
  profile: AgentProfile | undefined,
): (() => void) | undefined {
  // 先撤销同一 agentCtx 上一次注册的能力（防重复注册）。
  const previousDispose = memoryEffects.get(agentCtx)
  if (previousDispose !== undefined) {
    memoryEffects.delete(agentCtx)
    try { previousDispose() } catch { /* best-effort：旧撤销失败不阻断新注册 */ }
  }

  // 保守跳过：无 memory 服务、官方 preset 无 profile、minimal、scope=none。
  // 注意：即使 skip 也已在上面撤销了旧能力——切走到 minimal/none/official 后旧段/工具/guard不留残。
  if (memory === undefined) return undefined
  if (shouldSkipMemory(profile)) return undefined

  const profileId = profile!.id
  const disposers: Array<() => void> = []

  // 1. 系统提示词段（动态 text provider，每步现读 config）。
  //    order 紧随 persona suffix 附近（DEPLOYMENT_PERSONA_PREFIX + 3，与
  //    CONDUCTOR_SECTION 的 +1 / RESEARCH_MISSING 的 +2 错开，不冲突）。
  disposers.push(agentCtx.systemPrompt.section({
    name: MEMORY_SECTION,
    order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 3,
    text: memoryProtocolProvider(memory),
  }))

  // 2. 工具注册（仅 recall + enabled 时）。
  //    用 agent-scoped tools.guard 现读配置，mode 切走或 enabled=false 立拒。
  //    工具 agentId = profile.id（不从 exec/model 入参读，避免身份错配）。
  const toolConfig = makeGetToolConfig(memory)
  const currentConfig = memory.getConfig()
  if (currentConfig.enabled && currentConfig.injectionMode === 'recall') {
    const tool = createMemoryRecallTool(
      memory,
      profileId,
      toolConfig,
    )
    disposers.push(agentCtx.tools.register(tool))
  }

  // 3. guard（现读配置，即使当前不是 recall 也注册——切换到 recall 后仍能拦截
  //    已注册但此刻不应用的工具；但工具未注册时 guard 只对 'memory' 名生效，
  //    对未注册工具无副作用）。
  //    ⚠️ guard 注册在 agent scope，不泄漏给子 Agent。
  disposers.push(agentCtx.tools.guard(memoryToolGuard(memory)))

  const dispose = (): void => { for (const dispose of disposers) dispose() }
  // 记入 WeakMap：下次同一 agentCtx 再调 applyMemory 时先撤销这一批。
  memoryEffects.set(agentCtx, dispose)
  return dispose
}
