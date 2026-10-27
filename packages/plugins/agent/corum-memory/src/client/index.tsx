/**
 * @corum/corum-memory client half —— 在设置中心「记忆」分组注册**两个** section。
 *
 * ## 导航结构（2026-09-22 用户裁定「移除项目记忆」后的收敛态）
 *
 * 经验归属 Agent（人），事务归属项目——单一归宿，不两头记账。故「项目记忆」
 * section 已删除，记忆维度收敛为 Agent 单一维度。导航「记忆」独立分组（紧邻
 * 「智能体」下方），组内两项：
 *
 * ```
 * 设置 › 记忆
 *   ├─ 全局设置     （id 'memory-settings'，order 60）—— 全局策略
 *   └─ 智能体记忆   （id 'memory-agent'，   order 61）—— Agent 列表 → 三维记忆空间
 * ```
 *
 * **「智能体记忆」是两步流程**（用户 2026-09-21 裁定：「先有个 Agent 列表，列出已经
 * 开启记忆的 Agent，点击进去后，可以进入一个三维的 Agent 记忆空间」）：
 *
 * ```
 * Agent 列表（MemoryAgentList）──点某个 Agent──▶ 该 Agent 的三维记忆空间（MemorySpace）
 *        ▲                                                    │
 *        └────────────────  ‹ Agent 列表  ────────────────────┘
 * ```
 *
 * ⚠️ **记忆只归属 Agent**（2026-09-22 裁定）：`scope` / `projectId` 字段已从底座
 * 删除，记忆维度不再分 agent / project。旧存储里残留的 `scope='project'` fact 是
 * 无害孤儿（schema 忽略、检索不取值），不专门清理。
 *
 * 分组归属由壳的 `NAV_GROUP_BY_ID` 决定（`memory-settings` / `memory-agent`
 * → `'memory'`）——壳侧已同步声明 `group.memory` 组标题（中/英）。
 *
 * ## 数据通路
 *
 * - 记忆数据：host RPC `/api/memory/*`。信封与 `@corum/corum-rpc-client` 的
 *   `makeCorumRpcCall` 逐字相同（`connection.rpc.call('/api', '<ns>/<method>', { args })`
 *   → `!ok` 抛 `<code>: <message>`），但**本地内联**而不引该包：为一个几行的函数新增
 *   workspace 依赖不值得（包越少、打包闭包越小）。
 * - 参数持久化：官方 settings 面 —— `ctx.settingsScope.bind({ namespace: 'corum-memory' })`。
 *   host 侧 boot 常驻注册行见 `@corum/corum-memory/settings-registrar`（不在 boot 注册
 *   则冷启动读不到已存参数，同 corum-subagent 的实测教训）。
 *
 * ## 视觉
 *
 * 组件全部自备（`./ui.tsx`，内联 style + 壳 token）——红线 §3.5：插件**不得**静态
 * value-import 壳 client bundle 的组件（`corum-ollama` 同款做法）。
 *
 * @module @corum/corum-memory/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { useState } from 'react'
import { MemorySettingsPage } from './MemorySettingsPage.tsx'
import type { MemoryCall, MemorySettingsFace } from './MemorySettingsPage.tsx'
import { MemoryAgentList } from './MemoryAgentList.tsx'
import type { AgentSummary } from './MemoryAgentList.tsx'
import { MemorySpace } from './MemorySpace.tsx'

/** host settings namespace（与 memory-config.ts 的常量同值；client 不 import host 值）。 */
export const MEMORY_SETTINGS_NS = 'corum-memory'

/**
 * 基于官方 ConnectionHandle 构造 RPC 调用函数（`@corum/corum-rpc-client` 的同款信封）。
 *
 * @param connection - 官方 client connection 服务。
 * @returns 命名空间化调用函数；`!result.ok` 时抛 `<code>: <message>`。
 */
function makeCall(connection: ConnectionHandle): MemoryCall {
  return async function call<T, A extends object = Record<string, unknown>>(
    service: string,
    method: string,
    args: A,
  ): Promise<T> {
    const result = await connection.rpc.call('/api', `${service}/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

/**
 * 「记忆 › 全局设置」的 React 包装。
 *
 * @param props.settings - 已绑定的 settings scope（调用面）。
 * @param props.call - host RPC。
 * @returns 设置页。
 */
function SettingsSectionHost({ settings, call }: { settings: MemorySettingsFace; call: MemoryCall }) {
  return <MemorySettingsPage settings={settings} call={call} />
}

/**
 * 「记忆 › 智能体记忆」：**两步流程**（Agent 列表 ⇄ 三维记忆空间）。
 *
 * `openAgent` 是这一步的全部状态——为 null 显示列表，非 null 显示该 Agent 的空间。
 * 用组件内 state 而不是新增 section：用户口径是「点进去」，即**同一入口内的下钻**，
 * 不是导航里多一个分区（多一个分区还要处理「从列表进的空间，返回时高亮哪个导航项」）。
 *
 * @param props.call - host RPC。
 * @returns 列表或空间。
 */
function AgentSectionHost({ call }: { call: MemoryCall }) {
  const [openAgent, setOpenAgent] = useState<AgentSummary | null>(null)
  if (openAgent === null) {
    return <MemoryAgentList call={call} onOpen={setOpenAgent} />
  }
  return (
    <MemorySpace
      call={call}
      agentId={openAgent.id}
      agentName={openAgent.nickname ?? openAgent.title ?? openAgent.id}
      onBack={() => setOpenAgent(null)}
    />
  )
}

export const inject = ['slots', 'connection', 'remote', 'configForms']

export function apply(ctx: ClientContext): void {
  let slots: ClientContext['slots'] | undefined
  try {
    slots = ctx.slots
  } catch {
    return
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const call = makeCall(connection)
  // settings 面：rc3 改走 ctx.configForms.get(ns)（ConfigForm<T>）。
  // 读走共享 mirror，写走官方序列化写链 —— 不自己拼 RPC。
  // ConfigForm.set/unset 返回 Promise<boolean>，MemorySettingsFace 期望 Promise<void>，
  // 窄化适配（boolean → void 丢弃结果即可）。
  const form = ctx.configForms.get<unknown>(MEMORY_SETTINGS_NS)
  const settings: MemorySettingsFace = {
    getSnapshot: () => form.getSnapshot() as {
      status: string
      value: unknown
      user: unknown
      revision: number | undefined
      writable: boolean
    },
    subscribe: (listener) => form.subscribe(listener),
    set: async (field, value) => { void await form.set(field, value) },
    unset: async (field) => { void await form.unset(field) },
  }

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'memory-settings',
    order: 60,
    label: '全局设置',
  }, () => <SettingsSectionHost settings={settings} call={call} />))

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'memory-agent',
    order: 61,
    label: '智能体记忆',
  }, () => <AgentSectionHost call={call} />))
}
