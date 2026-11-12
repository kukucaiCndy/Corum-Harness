/**
 * MCP preset 代理行：把「注册表里的一个 MCP 服务」接成**宿主池的授权视图**。
 *
 * ## 它在架构里的位置（2026-09-27 用户模型）
 *
 * ```
 * profile.mcpServers: ['pencil-mcp']  ──compile.ts──▶  preset 行
 *      @corum/corum-mcp-manager/proxy  config:{ serverName: 'pencil-mcp' }
 *                     │ inject: ['corumMcpPool','tools']
 *                     ▼
 *   工具注册在**本 preset 常驻 scope** 的 tools 上（与官方 dsh-mcp-client 同一注册面，
 *   所以父子会话的可见性与改造前完全一致）
 *   每次 execute → 池.callTool（独占租约：排队 + 超时）→ 共用同一个 server 进程
 * ```
 *
 * 与官方 `dsh-mcp-client` 行的差别只有三处，都是这次改造的目的：
 *   1. **不自己起进程**：进程由宿主池按服务名持有 ⇒ 多 profile/多 Agent 授权共用**一个**进程；
 *   2. **调用经独占租约**：忙则排队（超时拒绝并告知持有者），不再无仲裁并发；
 *   3. 定义只留 `serverName`：改 `args`/`env` 不必重写每个 preset（池按指纹自己换进程）。
 *
 * ## 为什么要手搓 `ToolDefinition` 而不是用 `defineTool`
 *
 * `defineTool` 要的是**类型化参数 spec**，而 MCP 工具的 `inputSchema` 是服务端给的任意 JSON Schema。
 * 官方 `dsh-mcp-client` 同样是手搓 `{name,description,parameters,output,execute}` 直接
 * `ctx.tools.register(definition)`（见其 `createDefinition`/`createOutput`），本文件照此办理：
 * `parameters` 原样透传服务端 schema，`output.schema` 用官方同款「content 数组」canonical 契约
 * （缺 `output` 会被 ToolRuntime 直接拒绝——它是 mandatory）。
 *
 * ## 两种挂载模式（`mcpMode`，2026-11-12d §2 用户批准；默认 `index`）
 *
 * - **`eager`**：改造前的行为，逐字不变——挂载即把该 server 的全部工具注册进工具面 + 注入 guidance。
 * - **`index`**：挂载时只注入一段**紧凑索引**（server 名 + 一行用途 + 工具名与 ≤60 字符摘要，
 *   见 `mcp-index.ts`），再注册两个**共享**工具 `mcp_index` / `mcp_load`；模型按需查询、按需加载。
 *   加载时才把选定工具走既有注册路径（`createSyncer` 用的同一套 `createDefinition`）注册，
 *   并把该 server 的 guidance 段注入。
 *
 * 加载语义 = **per-preset-scope**（= per-profile），这是 MVP 语义：工具注册在 preset 常驻 scope 的
 * `tools` 上，故一个会话 load 之后，**同一 profile 的所有会话**都看得见（不做 agent 级加载——
 * 那需要 agent 创建钩子，超出本轮）。
 *
 * 加载态是 **scope 内存态**：应用重启后回到 index 态、需要重新 load（不做会话投影；设计文档
 * §2.2 的 sessionProjections 方案本轮未实施）。
 *
 * ## 共享工具的"每 scope 一次"协调（红线 1 的说明）
 *
 * `mcp_index` / `mcp_load` 必须**每 scope 只注册一次**（`tools.register` 撞名会抛），而一个 profile
 * 可能授权了多个 server ⇒ 多个 proxy 行。协调态放在模块级 `WeakMap`，键是**`tools` 注册面对象**
 * 本身：同一 preset scope 的所有行/会话拿到的是同一个注册面实例（也正是撞名域的边界），
 * 而每个 proxy 行是各自 cordis fiber ⇒ 行 ctx 对象互不相同、不能当 scope 身份。
 *
 * 这不违纪红线 1：红线针对的是**跨 bundle** 的共享可变状态（dsh 把 `@corum/*` inline 进各消费方
 * bundle ⇒ 模块态分裂）。本文件是 preset 行插件的**唯一加载实例**（`compile.ts` 只 `import type`
 * 本包，不 inline 它的运行态），故模块态与"该进程内的 scope 注册面"一一对应。
 *
 * ## 跨 bundle 类型面（红线 3）
 *
 * `tools` 服务的类型来自官方 `@deepseek-ai/dsh-tools`；本包不为**类型**再引一个依赖，
 * 故用本地能力接口收窄 + `inject` 声明（红线 4：服务装配由 inject 保证，不靠 `ctx.get` 赌顺序）。
 *
 * @module @corum/corum-mcp-manager/proxy
 */

import type { Context } from '@deepseek-ai/cordis'
import { getServer } from './registry-store.ts'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { mcpGuidanceSectionName, mcpGuidanceSectionText } from './mcp-guidance.ts'
import {
  filterIndexEntries,
  MCP_INDEX_TOOL_DESCRIPTION,
  MCP_INDEX_TOOL_NAME,
  MCP_LOAD_TOOL_DESCRIPTION,
  MCP_LOAD_TOOL_NAME,
  mcpIndexSectionName,
  mcpIndexSectionText,
  mcpIndexToolParameters,
  mcpLoadToolParameters,
  renderIndexDetail,
  renderLoadResult,
  type McpIndexCatalogEntry,
  type McpIndexQuery,
} from './mcp-index.ts'
import type { McpLeaseOwner, McpPoolTool } from './pool.ts'
import { publicToolName } from './tool-naming.ts'

/** 插件名（preset 行的 `name` 是包名，这里是 cordis 插件自身的名字）。 */
export const name = 'corum-mcp-proxy'
/** 依赖声明：池（红线 1 的宿主单例）与工具注册面。 */
export const inject: string[] = ['corumMcpPool', 'tools']

/** 挂载模式：`eager` = 挂载即注册全部工具（改造前行为）；`index` = 渐进式索引（默认）。 */
export type McpProxyMode = 'index' | 'eager'

/** 缺省模式（决策 D-A：新 profile 默认渐进，`eager` 作回退口）。 */
export const DEFAULT_MCP_PROXY_MODE: McpProxyMode = 'index'

/** 本行的配置（由 compile.ts 写成 `{ serverName }`）。 */
export interface McpProxyConfig {
  /** 注册表里的服务名（= `~/.corum/mcp-servers.json` 的 `name`）。 */
  readonly serverName: string
  /**
   * 挂载模式（缺省 {@link DEFAULT_MCP_PROXY_MODE} = `index`）。
   *
   * `eager` 保留逐字不变的旧行为，供"重 MCP 工作流"或排障时回退；见本文件头注「两种挂载模式」。
   */
  readonly mcpMode?: McpProxyMode
  /**
   * 首次同步（连接 + 注册工具）的等待上限（ms，默认 {@link DEFAULT_INITIAL_SYNC_TIMEOUT_MS}）。
   *
   * 只给测试/排障用；`compile.ts` 不写它。
   */
  readonly initialSyncTimeoutMs?: number
}

/**
 * 首次同步的等待上限。
 *
 * ## 为什么首次同步必须**有界地 await**（2026-09-27 实机缺陷）
 *
 * 原先首次同步是 fire-and-forget。冷启动时它要做的事是**真连一次 MCP server**（几百 ms 起），
 * 而 agent 回合的工具面在更早的时刻就快照了 ⇒ 实机复现：**冷启动后第一条泳道的首回合报
 * 「无 mcp__ 工具」，第二回合才有 5 个**（池已连上后不再复现）。工具缺席对用户就是"配了没用"。
 *
 * 有界（而不是无限等）：连不上**绝不能**把 preset 挂载卡死——超时后照常挂载并 `warn`，
 * 后续由工具表变更通知补上（`onToolsChanged` 那条路仍在）。
 */
const DEFAULT_INITIAL_SYNC_TIMEOUT_MS = 5_000

/** 模型可见内容块（本地收窄；官方 `ContentBlock` 的超集足够我们用）。 */
interface ContentBlockLike {
  readonly type: 'text'
  readonly text: string
}

/** 一次工具调用的上下文（官方 `ToolRunContext` 里我们真正用到的字段）。 */
interface McpProxyRunContext {
  /** 「The agent on whose behalf the call runs」——租约归属就取这里。 */
  readonly agent?: { readonly id?: string; readonly session?: { readonly id?: string } }
  /** 调用方取消信号（turn 结束/用户打断）⇒ 透传到协议层，租约在 `finally` 归还。 */
  readonly signal?: AbortSignal
}

/** 工具注册面（本地能力接口）。 */
interface McpProxyToolRegistryFace {
  register(definition: McpProxyToolDefinition): () => void
}

/** 我们要交给 `tools.register` 的定义形态（结构上兼容官方 `ToolDefinition`）。 */
interface McpProxyToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: unknown, value: McpCanonicalValue) => readonly ContentBlockLike[]
  }
  readonly execute: (args: unknown, exec: McpProxyRunContext) => Promise<McpCanonicalValue>
}

/** `output.schema` 约束的 canonical 值。 */
interface McpCanonicalValue {
  readonly content: readonly unknown[]
  readonly structuredContent?: unknown
}

/** 池上本行用到的能力面。 */
interface McpPoolFace {
  retain(serverName: string): () => void
  listTools(serverName: string): Promise<readonly McpPoolTool[]>
  onToolsChanged(serverName: string, listener: (tools: readonly McpPoolTool[]) => void): () => void
  callTool(
    serverName: string,
    tool: string,
    args: unknown,
    owner: McpLeaseOwner,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>
  /**
   * 池自己的日志出口（可选）。
   *
   * 代理**必须复用它**而不是自己写 `ctx.logger`：2026-09-27 实测 dev 宿主的 `ctx.logger` 不落盘，
   * 于是代理的 "N tool(s) available" / "首次同步仍在跑" 这类关键行全丢了（排查竞态时因此多花了一轮）。
   */
  log?(level: 'info' | 'warn', message: string): void
}

/** 日志出口。 */
type ProxyLog = (level: 'info' | 'warn', message: string) => void

/**
 * `systemPrompt` 服务的能力面（红线 3：本包不引官方类型包，只按需收窄到用到的两处）。
 *
 * 该服务是**可选**依赖（guidance 是附加能力，缺它不该影响挂载），故不写进插件级
 * `inject`（那会让缺服务的宿主整行都不挂载），而是用 `ctx.get('systemPrompt')` 探测。
 */
interface GuidableSystemPrompt {
  section(options: { name: string; order: number; text: string }): () => void
  getSectionOrder(id: string): number
}

/** 把服务端返回的内容块投影成模型文本（与官方 `extractText` 同语义：文本块换行合并，非文本 JSON 化）。 */
function renderText(content: unknown, rawName: string): string {
  const blocks = Array.isArray(content) ? content : []
  const parts: string[] = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
      continue
    }
    try {
      parts.push(JSON.stringify(block))
    } catch {
      parts.push(String(block))
    }
  }
  if (parts.length === 0) return `(${rawName} returned no model-facing content)`
  return parts.join('\n')
}

/**
 * canonical 输出契约（照官方 `createOutput` 的形状）。
 *
 * 与官方唯一的有意差异：`structuredContent` 声明为**可选**。官方会在服务端声明了 outputSchema 时
 * 把它标成 required，但那需要先校验服务端 schema 的合法性；我们不校验，标成可选就不会因为
 * 服务端 schema 花哨而把**整个结果**判成非法（`INVALID_TOOL_OUTPUT` 会吞掉结果，这条踩过）。
 */
function outputOf(rawName: string): McpProxyToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: {},
      },
      required: ['content'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: renderText(value.content, rawName) }],
  }
}

/** 租约归属：优先用真实 Agent/session id，拿不到才退化（拒绝文本仍然可读）。 */
export function ownerOf(exec: McpProxyRunContext | undefined): McpLeaseOwner {
  const agentId = exec?.agent?.id
  const sessionId = exec?.agent?.session?.id
  return {
    agentId: typeof agentId === 'string' && agentId !== '' ? agentId : 'unknown-agent',
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
  }
}

/**
 * 把 MCP 结果映射成 canonical 值；`isError` **抛错**（官方同款：让 ToolRuntime 走错误路径，
 * 模型看到的是一条失败的工具结果而不是"成功但内容是错误文本"）。
 */
export function canonicalResultOf(result: unknown, rawName: string): McpCanonicalValue {
  const record = (result ?? {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown }
  const content = Array.isArray(record.content) ? record.content : [{ type: 'text', text: renderText(undefined, rawName) }]
  if (record.isError === true) throw new Error(renderText(content, rawName))
  return {
    content,
    ...(record.structuredContent !== undefined ? { structuredContent: record.structuredContent } : {}),
  }
}

/**
 * 造一条工具定义（把原始名与公共名分开持有：**协议层只用原始名**）。
 *
 * 调用一律走池的**串行**租约（2026-09-27 用户决定：产品层面只保留串行，按资源分桶 / 并发上限 /
 * skipLease 等概念已全部移除，见 pool.ts 头注与 `docs/LESSONS.md`）。
 */
function createDefinition(serverName: string, tool: McpPoolTool, pool: McpPoolFace): McpProxyToolDefinition {
  const rawName = tool.name
  return {
    name: publicToolName(serverName, rawName),
    description: tool.description ?? '',
    // 服务端 schema 原样透传（官方亦然）。
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    output: outputOf(rawName),
    execute: async (args, exec) => {
      const result = await pool.callTool(serverName, rawName, args, ownerOf(exec), {
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      })
      return canonicalResultOf(result, rawName)
    },
  }
}

/**
 * 建同步器：按当前工具表**换代**注册（官方 `syncTools` 的两阶段换法）。
 *
 * 顺序很重要：**先取完新一代 → 再 dispose 旧的 → 再注册新的**；注册中途失败则把本次已注册的
 * 全部回滚（宁可这个 server 零工具，也不要半代工具）。工具表没变时不必重新注册。
 */
function createSyncer(
  serverName: string,
  pool: McpPoolFace,
  tools: McpProxyToolRegistryFace,
  log: ProxyLog,
): () => Promise<void> {
  let disposers = new Map<string, () => void>()
  return async (): Promise<void> => {
    let listed: readonly McpPoolTool[]
    try {
      listed = await pool.listTools(serverName)
    } catch (error: unknown) {
      // MCP 连不上不该让 preset 挂载失败，也不该把已有工具面撤掉（池还有重连机会）。
      log('warn', `corum-mcp-proxy(${serverName}): tools/list failed: ${String(error)}`)
      return
    }
    const definitions = new Map<string, McpProxyToolDefinition>()
    for (const tool of listed) {
      const publicName = publicToolName(serverName, tool.name)
      if (definitions.has(publicName)) {
        log('warn', `corum-mcp-proxy(${serverName}): server listed "${tool.name}" more than once — ignoring this generation`)
        return
      }
      definitions.set(publicName, createDefinition(serverName, tool, pool))
    }
    const previous = disposers
    disposers = new Map()
    for (const dispose of previous.values()) dispose()
    try {
      for (const [publicName, definition] of definitions) disposers.set(publicName, tools.register(definition))
    } catch (error: unknown) {
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
      log('warn', `corum-mcp-proxy(${serverName}): registration failed, no tools registered: ${String(error)}`)
      return
    }
    log('info', `corum-mcp-proxy(${serverName}): ${disposers.size} tool(s) available through the host pool`)
  }
}

// ───────────────────────────── index 模式：scope 协调态 + 共享工具 ─────────────────────────────

/** index 模式下**一个 server 一行**的运行时面（行卸载即失效）。 */
interface IndexScopeEntry {
  readonly serverName: string
  readonly pool: McpPoolFace
  /** 本行所在的 `tools` 注册面（preset 常驻 scope 的那一个）。 */
  readonly registry: McpProxyToolRegistryFace
  readonly log: ProxyLog
  /** 可选能力（宿主不一定提供 `systemPrompt` 服务）。 */
  readonly systemPrompt: GuidableSystemPrompt | undefined
  /** 当前工具表（索引数据）。由 {@link refreshIndexEntry} 维护。 */
  listed: readonly McpPoolTool[]
  /** 已加载工具：**原始名** → disposer（幂等判据 + 卸载清理）。 */
  readonly loaded: Map<string, () => void>
  /** 本行注入的索引段 disposer（换代时先摘旧的：同名重复注册会抛）。 */
  indexDispose?: (() => void) | undefined
  /** 本行注入的 guidance 段 disposer（**load 时**才注入，见 {@link injectLoadedGuidance}）。 */
  guidanceDispose?: (() => void) | undefined
}

/** 一个 preset scope 的索引协调态（`mcp_index` / `mcp_load` 每 scope 只注册一次）。 */
interface IndexScopeState {
  /** 键 = `tools` 注册面实例（就是撞名域的边界），值 = 该 scope 的协调态。 */
  readonly registry: McpProxyToolRegistryFace
  readonly entries: Map<string, IndexScopeEntry>
  /** 已挂载的 index 行数：最后一行卸载 ⇒ 收掉共享工具并摘掉本状态。 */
  rows: number
  sharedDispose?: (() => void) | undefined
}

/**
 * scope 协调态表。键是**注册面对象**而不是行 ctx：每个 proxy 行都是各自 cordis fiber，
 * 行 ctx 互不相同，而同一 preset scope 的注册面是同一个实例（见本文件头注）。
 */
/**
 * scope 协调态的存放键（**挂在池服务实例上，不是模块级**）。
 *
 * 2026-11-13 实机事故（两层根因）：
 * ① cordis loader 逐行独立加载插件模块，模块级 WeakMap 按行分裂——同一 preset 的两个
 *    MCP 行各自拿到空协调态，`mcp_load` 只认得第一个注册的 server；
 * ② `tools.register` 按 **scope 分层**（registry 对象同一、注册落各 ctx 的 scope 层）——
 *    协调态若按 registry 对象共享，standing 与 per-agent 两个 scope 会误共用一份态：
 *    先挂的 scope 注册了共享工具，后挂的 scope 见 `sharedDispose` 已设就跳过本层注册，
 *    会话所在 scope 的工具面里根本没有 mcp_index/mcp_load。
 * 修法：协调态表挂在**池服务实例**上（cordis 单例，跨模块实例天然共享，红线 1 的落点），
 * 键 = `scopeOf(ctx)`（工具注册的分层键；无 scope 的宿主/测试退化为 registry 对象）。
 * 态随 scope 最后一行卸载删除，不泄漏。
 */
const INDEX_SCOPES_KEY = Symbol.for('corum.mcp-manager.indexScopes')

/** 取（或建）池实例上的协调态表（跨模块实例共享）。 */
function scopesTable(pool: McpPoolFace): Map<object | symbol, IndexScopeState> {
  const host = pool as unknown as Record<symbol, Map<object | symbol, IndexScopeState> | undefined>
  return host[INDEX_SCOPES_KEY] ??= new Map()
}

/** 取（或建）某个 scope 的协调态（键 = scope 身份，无 scope 退化 registry）。 */
function scopeStateOf(ctx: Context, pool: McpPoolFace, registry: McpProxyToolRegistryFace): IndexScopeState {
  const key = (scopeOf(ctx) ?? registry) as object | symbol
  const table = scopesTable(pool)
  const existing = table.get(key)
  if (existing !== undefined) return existing
  const created: IndexScopeState = { registry, entries: new Map(), rows: 0 }
  table.set(key, created)
  return created
}

/** 把一行的运行时投影成纯数据（注册表里的用途/指导现读，改注册表即时生效）。 */
function catalogOf(entry: IndexScopeEntry): McpIndexCatalogEntry {
  const record = getServer(entry.serverName)
  const description = record?.description
  const guidance = record?.guidance
  return {
    serverName: entry.serverName,
    ...(description === undefined ? {} : { description }),
    ...(guidance === undefined ? {} : { guidance }),
    tools: entry.listed,
    loaded: [...entry.loaded.keys()],
  }
}

/**
 * 注入（或换代）本 server 的索引段。
 *
 * `systemPrompt.section` 的段名唯一——**重复注册会抛**，故换文本一律走「先摘旧段再插新段」
 * （与工具面的换代同一手法）。没有待加载工具时摘掉该段、不占提示词。
 */
function renderIndexSection(entry: IndexScopeEntry): void {
  const systemPrompt = entry.systemPrompt
  if (systemPrompt === undefined) return
  const text = mcpIndexSectionText(catalogOf(entry))
  entry.indexDispose?.()
  entry.indexDispose = undefined
  if (text === '') return
  try {
    entry.indexDispose = systemPrompt.section({
      name: mcpIndexSectionName(entry.serverName),
      // 排在 guidance 段（-40）之前：同 server 的索引先铺面、加载后指导紧跟其后。
      order: systemPrompt.getSectionOrder('TOOL_BASH') - 45,
      text,
    })
  } catch (error: unknown) {
    entry.log('warn', `corum-mcp-proxy(${entry.serverName}): index section could not be injected: ${String(error)}`)
  }
}

/**
 * 加载该 server 的 guidance 段（每行一次；`mcp_load` 成功后才注入）。
 *
 * 这是 index 模式与 eager 的关键差别：指导文本可能很长（上限 4KB），在模型真的要用这套工具之前
 * 不值得占提示词。
 */
function injectLoadedGuidance(entry: IndexScopeEntry): void {
  if (entry.guidanceDispose !== undefined) return
  const systemPrompt = entry.systemPrompt
  if (systemPrompt === undefined) return
  const text = mcpGuidanceSectionText(entry.serverName, getServer(entry.serverName)?.guidance)
  if (text === '') return
  try {
    entry.guidanceDispose = systemPrompt.section({
      name: mcpGuidanceSectionName(entry.serverName),
      order: systemPrompt.getSectionOrder('TOOL_BASH') - 40,
      text,
    })
  } catch (error: unknown) {
    entry.log('warn', `corum-mcp-proxy(${entry.serverName}): guidance section could not be injected: ${String(error)}`)
  }
}

/** 重取工具表并刷新索引段（首次同步与工具表变更走同一条路）。 */
async function refreshIndexEntry(entry: IndexScopeEntry): Promise<void> {
  let listed: readonly McpPoolTool[]
  try {
    listed = await entry.pool.listTools(entry.serverName)
  } catch (error: unknown) {
    // 连不上不该让 preset 挂载失败（与 eager 同一条纪律）。
    entry.log('warn', `corum-mcp-proxy(${entry.serverName}): tools/list failed: ${String(error)}`)
    return
  }
  entry.listed = listed
  renderIndexSection(entry)
}

/** 在工具表里找一条工具：接受原始名，也接受模型可见的 `mcp__<server>__<tool>` 名。 */
function findListedTool(entry: IndexScopeEntry, name: string): McpPoolTool | undefined {
  return entry.listed.find(tool => tool.name === name || publicToolName(entry.serverName, tool.name) === name)
}

/**
 * 把选定工具注册进本 scope（`mcp_load` 的实现体）。
 *
 * 语义：缺省加载该 server 的**全部**工具；重复 load 幂等（已在场的计入 `already`）；
 * 未知工具名 **fail-loud**（决策 5：不静默跳过——静默会让模型以为加载成功、随后撞
 * "tool not registered"）。
 */
async function loadTools(
  entry: IndexScopeEntry,
  requested: readonly string[] | undefined,
): Promise<{ loaded: string[]; already: string[] }> {
  // 首次同步失败/未完成时补一次：此时索引数据是空的，不补就只能报"未知工具"。
  if (entry.listed.length === 0) await refreshIndexEntry(entry)
  const available = entry.listed
  if (available.length === 0) {
    throw new Error(`corum-mcp-proxy(${entry.serverName}): the server listed no tools — cannot load anything (check that it is running)`)
  }
  const names = requested ?? available.map(tool => tool.name)
  const selected: McpPoolTool[] = []
  const unknown: string[] = []
  for (const name of names) {
    const tool = findListedTool(entry, name)
    if (tool === undefined) {
      unknown.push(name)
      continue
    }
    if (!selected.includes(tool)) selected.push(tool)
  }
  if (unknown.length > 0) {
    throw new Error(
      `corum-mcp-proxy(${entry.serverName}): unknown tool(s) ${unknown.map(name => `"${name}"`).join(', ')}`
      + ` — available: ${available.map(tool => tool.name).join(', ')}`,
    )
  }
  const loaded: string[] = []
  const already: string[] = []
  const disposers: (() => void)[] = []
  try {
    for (const tool of selected) {
      if (entry.loaded.has(tool.name)) {
        already.push(tool.name)
        continue
      }
      const dispose = entry.registry.register(createDefinition(entry.serverName, tool, entry.pool))
      entry.loaded.set(tool.name, dispose)
      disposers.push(dispose)
      loaded.push(tool.name)
    }
  } catch (error: unknown) {
    // 半代工具比零工具更坏（沿用 createSyncer 的回滚判据）。
    for (const dispose of disposers) dispose()
    for (const tool of selected) entry.loaded.delete(tool.name)
    throw new Error(`corum-mcp-proxy(${entry.serverName}): tool registration failed, nothing loaded: ${String(error)}`)
  }
  if (loaded.length > 0) {
    injectLoadedGuidance(entry)
    // 已加载的工具从索引段消失（全加载完 ⇒ 该段整体摘掉）。
    renderIndexSection(entry)
  }
  return { loaded, already }
}

/** 从模型给的 `unknown` 参数里安全取值（畸形参数只当缺省）。 */
function argRecord(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {}
}

/** 取一个非空字符串参数。 */
function argString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** `mcp_index` 的参数解析。 */
function asIndexQuery(args: unknown): McpIndexQuery {
  const record = argRecord(args)
  const server = argString(record, 'server')
  const query = argString(record, 'query')
  return {
    ...(server === undefined ? {} : { server }),
    ...(query === undefined ? {} : { query }),
  }
}

/**
 * `mcp_load` 的参数解析。
 *
 * `server` 必填（fail-loud）：缺省成"加载全部 server"会让一次手误把几十个工具塞进工具面。
 */
function asLoadRequest(args: unknown): { server: string; tools?: readonly string[] } {
  const record = argRecord(args)
  const server = argString(record, 'server')
  if (server === undefined) {
    throw new Error(`corum-mcp-proxy: ${MCP_LOAD_TOOL_NAME} requires {server: "<name>"}`)
  }
  const raw = record.tools
  if (raw === undefined) return { server }
  if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`corum-mcp-proxy: ${MCP_LOAD_TOOL_NAME}.tools must be an array of non-empty tool names`)
  }
  return { server, tools: (raw as string[]).map(name => name.trim()) }
}

/** 该 scope 里全部已授权 server 的名字（错误文案用）。 */
function scopeServerNames(state: IndexScopeState): string {
  return [...state.entries.keys()].join(', ') || '(none)'
}

/** 造 `mcp_index` 定义（纯查询：只读索引数据，不动工具面）。 */
function createIndexTool(state: IndexScopeState): McpProxyToolDefinition {
  return {
    name: MCP_INDEX_TOOL_NAME,
    description: MCP_INDEX_TOOL_DESCRIPTION,
    parameters: mcpIndexToolParameters(),
    output: outputOf(MCP_INDEX_TOOL_NAME),
    execute: async (args) => {
      const { matched, unknownServer } = filterIndexEntries(
        [...state.entries.values()].map(catalogOf),
        asIndexQuery(args),
      )
      if (unknownServer !== undefined) {
        throw new Error(`corum-mcp-proxy: unknown MCP server "${unknownServer}" for ${MCP_INDEX_TOOL_NAME} — authorized in this scope: ${scopeServerNames(state)}`)
      }
      return { content: [{ type: 'text', text: renderIndexDetail(matched) }] }
    },
  }
}

/** 造 `mcp_load` 定义（把选定工具走既有注册路径注册进本 scope）。 */
function createLoadTool(state: IndexScopeState): McpProxyToolDefinition {
  return {
    name: MCP_LOAD_TOOL_NAME,
    description: MCP_LOAD_TOOL_DESCRIPTION,
    parameters: mcpLoadToolParameters(),
    output: outputOf(MCP_LOAD_TOOL_NAME),
    execute: async (args) => {
      const request = asLoadRequest(args)
      const entry = state.entries.get(request.server)
        ?? [...state.entries.values()].find(candidate => candidate.serverName.toLowerCase() === request.server.toLowerCase())
      if (entry === undefined) {
        throw new Error(`corum-mcp-proxy: unknown MCP server "${request.server}" for ${MCP_LOAD_TOOL_NAME} — authorized in this scope: ${scopeServerNames(state)}`)
      }
      const result = await loadTools(entry, request.tools)
      return { content: [{ type: 'text', text: renderLoadResult(entry.serverName, result.loaded, result.already) }] }
    },
  }
}

/**
 * 确保本 scope 里存在 `mcp_index` / `mcp_load`（**每 scope 一次**）。
 *
 * 撞名（另一个插件已占了同名工具）只 `warn` 且**整对回滚**：留一半比没有更坏——模型会看到
 * 索引段却既查不了也加载不了。
 */
function ensureSharedIndexTools(state: IndexScopeState, entry: IndexScopeEntry): void {
  if (state.sharedDispose !== undefined) return
  const disposers: (() => void)[] = []
  try {
    for (const definition of [createIndexTool(state), createLoadTool(state)]) {
      disposers.push(entry.registry.register(definition))
    }
  } catch (error: unknown) {
    for (const dispose of disposers) dispose()
    entry.log(
      'warn',
      `corum-mcp-proxy: shared index tools (${MCP_INDEX_TOOL_NAME}/${MCP_LOAD_TOOL_NAME}) could not be registered — index mode has no loader in this scope: ${String(error)}`,
    )
    return
  }
  state.sharedDispose = () => {
    for (const dispose of disposers) dispose()
    state.sharedDispose = undefined
  }
}

/**
 * index 模式的挂载：注入索引段、注册共享工具、**有界**地等首次索引完成。
 *
 * 不做任何工具注册（加载交给 `mcp_load`）；`tools/list` 失败只 `warn`（fail-soft 同 eager）。
 *
 * @returns 首次索引的**有界** promise；永不 reject。
 */
function mountIndexMode(
  ctx: Context,
  entry: IndexScopeEntry,
  state: IndexScopeState,
  timeoutMs: number,
): Promise<void> {
  state.entries.set(entry.serverName, entry)
  state.rows += 1
  ensureSharedIndexTools(state, entry)
  // 行卸载：摘索引段/guidance 段、注销已加载工具；最后一行卸载 ⇒ 收掉共享工具与 scope 协调态。
  ctx.effect(() => () => {
    entry.indexDispose?.()
    entry.indexDispose = undefined
    entry.guidanceDispose?.()
    entry.guidanceDispose = undefined
    for (const dispose of entry.loaded.values()) dispose()
    entry.loaded.clear()
    if (state.entries.get(entry.serverName) === entry) state.entries.delete(entry.serverName)
    state.rows -= 1
    if (state.rows <= 0) {
      state.sharedDispose?.()
      scopesTable(entry.pool).delete((scopeOf(ctx) ?? entry.registry) as object | symbol)
    }
  }, 'corumMcpProxy.indexScope')
  // 工具表变更（重连后服务端动态改表）⇒ 只刷新索引数据与索引段，不动已加载的工具定义。
  //
  // 已加载定义很薄（转发到池、按**原始名**调用），服务端撤掉某工具时它会 fail-loud 地报错，
  // 而不是静默指向别的工具；MVP 不做「已加载集合换代」（那会让模型手里的工具面无故抖动）。
  ctx.effect(
    () => entry.pool.onToolsChanged(entry.serverName, () => { void refreshIndexEntry(entry) }),
    'corumMcpProxy.indexToolsChanged',
  )
  // 首次索引：有界地等它完成 ⇒ 挂好即索引在场（否则冷启动首回合看不到 MCP 有任何东西）。
  return Promise.race([
    refreshIndexEntry(entry),
    new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        entry.log('warn', `corum-mcp-proxy(${entry.serverName}): initial index sync still running after ${timeoutMs}ms — mounting without waiting (the index appears once it finishes)`)
        resolve()
      }, timeoutMs)
      timer.unref?.()
    }),
  ])
}

/**
 * 挂载一个代理行（由 preset 组合调用）。
 *
 * **fail-soft**：服务不在注册表里 / 连不上 / 注册冲突都只 `warn`，绝不让整个 preset 挂载失败
 * ——MCP 是附加能力，配错了不该把 Agent 弄挂（官方 `dsh-mcp-client` 同样是 fail-soft）。
 *
 * @param ctx - preset scope 的 cordis 上下文。
 * @param config - `{ serverName, mcpMode? }`（`mcpMode` 缺省 `index`）。
 * @returns 首次同步（eager：全部工具注册 / index：索引段就绪）的**有界** promise；cordis loader
 *   会 await 它；永不 reject。
 */
export function apply(ctx: Context, config: McpProxyConfig): void | Promise<void> {
  const serverName = config?.serverName
  if (typeof serverName !== 'string' || serverName.trim() === '') {
    throw new Error('corum-mcp-proxy: config.serverName is required (non-empty string)')
  }
  const pool = (ctx as unknown as { corumMcpPool?: McpPoolFace }).corumMcpPool
  const tools = (ctx as unknown as { tools?: McpProxyToolRegistryFace }).tools
  if (pool === undefined || tools === undefined) {
    ctx.logger.warn(`corum-mcp-proxy(${serverName}): corumMcpPool/tools service missing — no MCP tools registered`)
    return
  }
  // 优先用池的日志出口（可能已被 `CORUM_MCP_POOL_LOG` 接到文件），退化为 ctx.logger。
  const log: ProxyLog = pool.log !== undefined
    ? (level, message) => { pool.log?.(level, message) }
    : (level, message) => {
        if (level === 'warn') ctx.logger.warn(message)
        else ctx.logger.info(message)
      }
  // 引用计数：本行存在期间，该 server 的进程保持存活（最后一行卸载才停）。
  let release: (() => void) | undefined
  try {
    release = pool.retain(serverName)
  } catch (error: unknown) {
    log('warn', `corum-mcp-proxy(${serverName}): cannot retain this server (${String(error)}) — no MCP tools registered`)
    return
  }
  ctx.effect(() => release as () => void, 'corumMcpProxy.retain')
  // 模式：缺省 `index`（渐进）。`eager` 逐字保留改造前行为（见本文件头注「两种挂载模式」）。
  const requestedMode = config.mcpMode
  const mode: McpProxyMode = requestedMode === 'eager' || requestedMode === 'index'
    ? requestedMode
    : DEFAULT_MCP_PROXY_MODE
  if (requestedMode !== undefined && requestedMode !== mode) {
    log('warn', `corum-mcp-proxy(${serverName}): unknown mcpMode "${String(requestedMode)}" — using "${mode}"`)
  }
  const timeoutMs = config.initialSyncTimeoutMs ?? DEFAULT_INITIAL_SYNC_TIMEOUT_MS
  if (mode === 'index') {
    return mountIndexMode(
      ctx,
      {
        serverName,
        pool,
        registry: tools,
        log,
        // 可选能力：宿主不一定提供 systemPrompt 服务。用 `ctx.get` 的理由见下方 eager 分支的说明。
        systemPrompt: ctx.get('systemPrompt') as GuidableSystemPrompt | undefined,
        listed: [],
        loaded: new Map(),
      },
      scopeStateOf(ctx, pool, tools),
      timeoutMs,
    )
  }
  /**
   * 使用指导段（2026-09-27 用户需求）：注册表里该 server 的 `guidance` 进 system prompt。
   *
   * 注入在**本行所在的 preset scope** 上 ⇒ 粒度正好是「这个 profile 授权了这个 server」；
   * 且保存 profile 触发的重挂会重新注入 ⇒ 改指导与改授权同一条路径、都即时生效。
   * 空指导不注入（不占提示词）。能力不可用（老宿主没有 systemPrompt 服务）时静默跳过。
   */
  const guidanceText = mcpGuidanceSectionText(serverName, getServer(serverName)?.guidance)
  if (guidanceText !== '') {
    // 可选能力：宿主不一定提供 systemPrompt 服务。
    //
    // 必须用 `ctx.get`（官方契约：「Read a service from the store **without the inject
    // requirement**」，未提供时返回 `undefined`），**不要**写成 `ctx.systemPrompt`：
    // cordis 的 Context 是 Proxy，读一个未 `inject` 的服务属性会直接抛
    // `cannot get property "systemPrompt" without inject`。更致命的是，该读一旦出现在
    // `if` **条件**里求值，紧随其后的 `try/catch` 根本来不及接住 ⇒ `apply()` 同步抛出
    // ⇒ loader 判本行失败 ⇒ `preset "..." failed to mount`，Agent 完全打不开（issue #3：
    // guidance 非空即触发，而 guidance 是正常功能、不是异常配置）。
    const systemPrompt = ctx.get('systemPrompt') as GuidableSystemPrompt | undefined
    if (systemPrompt !== undefined) {
      try {
        ctx.effect(
          () => systemPrompt.section({
            name: mcpGuidanceSectionName(serverName),
            order: systemPrompt.getSectionOrder('TOOL_BASH') - 40,
            text: guidanceText,
          }),
          'corumMcpProxy.guidance',
        )
      } catch (error: unknown) {
        log('warn', `corum-mcp-proxy(${serverName}): guidance section could not be injected: ${String(error)}`)
      }
    }
  }
  const sync = createSyncer(serverName, pool, tools, log)
  // 工具表变更（重连后服务端动态改表）⇒ 换代注册。
  ctx.effect(() => pool.onToolsChanged(serverName, () => { void sync() }), 'corumMcpProxy.onToolsChanged')
  // 首次同步：**有界地等它完成**，让本行"挂好"时工具已经在场上（否则冷启动那一回合会看不到工具）。
  const initial = sync()
  const bounded = Promise.race([
    initial,
    new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        log('warn', `corum-mcp-proxy(${serverName}): initial sync still running after ${timeoutMs}ms — mounting without waiting (tools appear once it finishes)`)
        resolve()
      }, timeoutMs)
      timer.unref?.()
    }),
  ])
  // 返回 Promise：cordis 的 loader 会 await 插件应用（这是"挂好即工具在场"的关键）。
  // 永不 reject（超时/失败都在 sync 内部收敛成 warn），故不会让 preset 挂载失败。
  return bounded
}
