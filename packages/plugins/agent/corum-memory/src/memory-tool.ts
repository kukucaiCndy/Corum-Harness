/**
 * memory-tool —— 模型工具工厂：按需召回记忆（search/get）。
 *
 * ## 设计
 *
 * 这不是一个 cordis 插件，不注册全局工具，不持有模块级可变状态。
 * 它只导出一个工厂 {@link createMemoryRecallTool}，corum-agent 在 agent scope
 * `ctx.tools.register` 时调用它拿到一个 `defineTool` 工具定义。
 *
 * ## 安全边界
 *
 * - **agentId 强制归属**：工具内部用工厂绑定的 agentId 调 `searchFacts` /
 *   `getFactForAgent`。模型入参**不含** agentId——模型无法覆盖归属。
 * - **总开关 + 注入模式**：每次调用现读 getConfig()。`enabled=false` 或
 *   `injectionMode !== 'recall'` 时返回清晰的英文 disabled 结果，不执行读取。
 * - **search 只给线索**：返回 id/fact 首句或短截断（~160 chars）/retention/
 *   importance/effectiveScore，不返回 evidence 全文。模型要用 get 拿全文。
 * - **get 返回全文**：调 `getFactForAgent`（归属过滤 + 总开关短路）。
 *
 * ## 并发安全
 *
 * `isConcurrencySafe` **不声明 true**——search 有 readCount 写副作用
 * （命中命中写回 readCount/lastAccessedAt/retention），不是纯读。
 *
 * @module @corum/corum-memory/memory-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MemoryFactView, MemoryRetention } from './memory-entities.ts'
import type { InjectionMode } from './memory-config.ts'

/** search 返回的渐进线索（不含 evidence 全文）。 */
export interface MemoryRecallClue {
  /** 事实 id（模型可用 get action 拿全文）。 */
  id: string
  /** fact 首句或短截断（~160 chars）。 */
  fact: string
  /** 存续期。 */
  retention: MemoryRetention
  /** 重要性 0-100。 */
  importance: number
  /** 读时降权后的记忆强度（0-100）。 */
  effectiveScore: number
}

/** get action 返回的完整记忆（含全文与元数据）。 */
export interface MemoryRecallDetail {
  id: string
  fact: string
  entity: string
  relation: string
  source: string
  retention: MemoryRetention
  importance: number
  effectiveScore: number
  applicable: boolean
  retained: boolean
  readCount: number
  createdAt: number
  /** lastAccessedAt 可选：null 时省略（schema 不声明 required）。 */
  lastAccessedAt?: number
}

/** 工具执行返回的联合结果。 */
export type MemoryToolResult =
  | { kind: 'search'; clues: MemoryRecallClue[] }
  | { kind: 'get'; detail?: MemoryRecallDetail }
  | { kind: 'disabled'; reason: string }

/**
 * 工厂消费的窄记忆接口（不耦合 MemoryService 完整面）。
 *
 * corum-agent 从 `@corum/corum-memory` import 工厂 + 这个类型，
 * 运行时把 ctx.memory（MemoryService 实例）传入——它满足这个窄接口。
 */
export interface MemoryRecallCapable {
  searchFacts(input: {
    agentId?: string
    query?: string
    mode?: 'applicable' | 'recall'
    limit?: number
  }): Promise<MemoryFactView[]>
  getFactForAgent(id: string, agentId: string): Promise<MemoryFactView | null>
}

/** getConfig 每次调用现读，返回 enabled + injectionMode。 */
export interface MemoryToolConfig {
  readonly enabled: boolean
  readonly injectionMode: InjectionMode
}

/** 工具 description：英文，表达「仅在可能有帮助时使用；不强制每次使用」。 */
const TOOL_DESCRIPTION = [
  'Search and retrieve your own past experience (memory) by keyword, or fetch a specific memory by id.',
  'Use only when past experience may help; not required for every task.',
  '',
  'Actions:',
  '- search: query your memories by keyword. Returns progressive clues (id + fact snippet + retention/importance/score) — NOT full evidence. Use `get` with an id to read the full text.',
  '- get: fetch the full text and metadata of one memory by id.',
  '',
  'You can only access memories belonging to your own agent scope. Memories are not injected automatically — you decide when to look them up.',
].join('\n')

/** 截断 fact 到 ~160 chars（取首句或截断）。 */
function snippet(fact: string): string {
  if (fact.length <= 160) return fact
  // 取首句（第一个句号/换行之前的内容）；如果首句在 160 以内就取首句 + ...，
  // 否则截断到 157 + ...。
  const sentenceEnd = fact.search(/[。.\n!！?？]/)
  if (sentenceEnd !== -1 && sentenceEnd <= 160) return fact.slice(0, sentenceEnd + 1) + '...'
  return fact.slice(0, 157) + '...'
}

/** disabled 结果的英文原因。 */
function disabledReason(config: MemoryToolConfig): string {
  if (!config.enabled) return 'Memory is disabled (enabled=false). Memories exist but cannot be recalled.'
  if (config.injectionMode !== 'recall') {
    if (config.injectionMode === 'never') return 'Memory recall is disabled (injectionMode=never). No injection and no tool recall.'
    return `Memory recall tool is disabled (injectionMode=${config.injectionMode}). Tool recall requires injectionMode=recall.`
  }
  return 'Memory recall is disabled.'
}

/**
 * 创建 `memory` 工具定义（供 corum-agent 在 agent scope ctx.tools.register）。
 *
 * @param memory - 窄记忆接口（满足 MemoryRecallCapable 的服务实例）。
 * @param agentId - 绑定的 Agent id（模型无法覆盖）。
 * @param getConfig - 每次调用现读配置（返回 enabled + injectionMode）。
 * @returns dsh `defineTool` 工具定义。
 */
export function createMemoryRecallTool(
  memory: MemoryRecallCapable,
  agentId: string,
  getConfig: () => MemoryToolConfig,
) {
  return defineTool({
    name: 'memory',
    description: TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['search', 'get'],
        description: 'Which operation to perform: "search" to query memories by keyword, or "get" to fetch one memory by id.',
      },
      query: {
        type: 'string',
        description: 'Search query (keyword to match against fact/entity/relation/source). Optional for "search" action; ignored for "get".',
      },
      id: {
        type: 'string',
        description: 'Memory id to fetch (required for "get" action; ignored for "search").',
      },
      limit: {
        type: 'integer',
        description: 'Max number of clues to return for "search" (1-20, default 10). Ignored for "get".',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'search' },
              clues: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    fact: { type: 'string', required: true },
                    retention: { type: 'string', required: true },
                    importance: { type: 'number', required: true },
                    effectiveScore: { type: 'number', required: true },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'get' },
              detail: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  fact: { type: 'string', required: true },
                  entity: { type: 'string', required: true },
                  relation: { type: 'string', required: true },
                  source: { type: 'string', required: true },
                  retention: { type: 'string', required: true },
                  importance: { type: 'number', required: true },
                  effectiveScore: { type: 'number', required: true },
                  applicable: { type: 'boolean', required: true },
                  retained: { type: 'boolean', required: true },
                  readCount: { type: 'integer', required: true },
                  createdAt: { type: 'integer', required: true },
                  lastAccessedAt: { type: 'integer' },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'disabled' },
              reason: { type: 'string', required: true },
            },
          },
        ],
      } as const,
      render(_args: unknown, value: unknown): ContentBlock[] {
        const v = value as MemoryToolResult
        if (v.kind === 'search') {
          if (v.clues.length === 0) {
            return [{ type: 'text', text: 'No matching memories found.' }]
          }
          const lines = v.clues.map(c =>
            `[${c.id}] (${c.retention}, importance=${c.importance}, score=${c.effectiveScore}) ${c.fact}`,
          )
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (v.kind === 'get') {
          if (v.detail === undefined) {
            return [{ type: 'text', text: 'Memory not found or not accessible.' }]
          }
          const d = v.detail
          const lines = [
            `id: ${d.id}`,
            `fact: ${d.fact}`,
            `entity: ${d.entity}`,
            `relation: ${d.relation}`,
            `source: ${d.source}`,
            `retention: ${d.retention}`,
            `importance: ${d.importance}`,
            `effectiveScore: ${d.effectiveScore}`,
            `applicable: ${d.applicable}`,
            `retained: ${d.retained}`,
            `readCount: ${d.readCount}`,
            `createdAt: ${d.createdAt}`,
            ...(d.lastAccessedAt !== undefined ? [`lastAccessedAt: ${d.lastAccessedAt}`] : []),
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        }
        // disabled
        return [{ type: 'text', text: v.reason }]
      },
    },
    async execute(args): Promise<MemoryToolResult> {
      const action = args.action
      const config = getConfig()

      // 每次调用现读：enabled=false 或 injectionMode !== 'recall' ⇒ 不执行读取。
      if (!config.enabled || config.injectionMode !== 'recall') {
        return { kind: 'disabled', reason: disabledReason(config) }
      }

      if (action === 'search') {
        const query = typeof args.query === 'string' ? args.query : undefined
        const rawLimit = typeof args.limit === 'number' ? args.limit : 10
        const limit = Math.max(1, Math.min(20, Math.round(rawLimit)))

        // 强制归属：agentId 由工厂绑定，模型无法覆盖。
        // 强制 mode='applicable'：模型只看到当前适用的事实。
        const searchInput: { agentId: string; mode: 'applicable'; limit: number; query?: string } = {
          agentId,
          mode: 'applicable',
          limit,
        }
        if (query !== undefined) searchInput.query = query
        const views = await memory.searchFacts(searchInput)

        const clues: MemoryRecallClue[] = views.map(v => ({
          id: v.id,
          fact: snippet(v.fact),
          retention: v.retention,
          importance: v.importance,
          effectiveScore: v.effectiveScore,
        }))
        return { kind: 'search', clues }
      }

      if (action === 'get') {
        const id = args.id
        if (typeof id !== 'string' || id === '') {
          return { kind: 'get' }
        }
        const view = await memory.getFactForAgent(id, agentId)
        if (view === null) {
          return { kind: 'get' }
        }
        const detail: MemoryRecallDetail = {
          id: view.id,
          fact: view.fact,
          entity: view.entity,
          relation: view.relation,
          source: view.source,
          retention: view.retention,
          importance: view.importance,
          effectiveScore: view.effectiveScore,
          applicable: view.applicable,
          retained: view.retained,
          readCount: view.readCount,
          createdAt: view.createdAt,
          ...(view.lastAccessedAt !== null ? { lastAccessedAt: view.lastAccessedAt } : {}),
        }
        return { kind: 'get', detail }
      }

      // 不应该到达——schema 的 enum 已限定。兜底返回 disabled。
      return { kind: 'disabled', reason: `Unknown action: ${String(action)}` }
    },
  })
}
