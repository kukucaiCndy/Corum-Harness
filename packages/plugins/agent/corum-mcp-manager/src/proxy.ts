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
 * ## 跨 bundle 类型面（红线 3）
 *
 * `tools` 服务的类型来自官方 `@deepseek-ai/dsh-tools`；本包不为**类型**再引一个依赖，
 * 故用本地能力接口收窄 + `inject` 声明（红线 4：服务装配由 inject 保证，不靠 `ctx.get` 赌顺序）。
 *
 * @module @corum/corum-mcp-manager/proxy
 */

import type { Context } from '@deepseek-ai/cordis'
import { getServer } from './registry-store.ts'
import { mcpGuidanceSectionName, mcpGuidanceSectionText } from './mcp-guidance.ts'
import type { McpLeaseOwner, McpPoolTool } from './pool.ts'
import { publicToolName } from './tool-naming.ts'

/** 插件名（preset 行的 `name` 是包名，这里是 cordis 插件自身的名字）。 */
export const name = 'corum-mcp-proxy'
/** 依赖声明：池（红线 1 的宿主单例）与工具注册面。 */
export const inject: string[] = ['corumMcpPool', 'tools']

/** 本行的配置（由 compile.ts 写成 `{ serverName }`）。 */
export interface McpProxyConfig {
  /** 注册表里的服务名（= `~/.corum/mcp-servers.json` 的 `name`）。 */
  readonly serverName: string
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

/**
 * 挂载一个代理行（由 preset 组合调用）。
 *
 * **fail-soft**：服务不在注册表里 / 连不上 / 注册冲突都只 `warn`，绝不让整个 preset 挂载失败
 * ——MCP 是附加能力，配错了不该把 Agent 弄挂（官方 `dsh-mcp-client` 同样是 fail-soft）。
 *
 * @param ctx - preset scope 的 cordis 上下文。
 * @param config - `{ serverName }`。
 * @returns 首次同步的**有界** promise（cordis loader 会 await 它）；永不 reject。
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
  const timeoutMs = config.initialSyncTimeoutMs ?? DEFAULT_INITIAL_SYNC_TIMEOUT_MS
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
