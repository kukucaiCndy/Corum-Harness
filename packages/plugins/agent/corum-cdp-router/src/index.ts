/**
 * corum-cdp-router —— CDP 路由（corum 本体标准插件）。
 *
 * ## 它是什么
 *
 * 把「连到任意 Corum 实例的 CDP 端口、在它的页面里执行代码 / 调它的 host RPC」
 * 做成一等能力。**这是所有跨实例测试装置的地基**：
 *
 * ```
 * 测试装置（CorumTestSuite 等）
 *    │ 依赖本服务的 evaluate / callRpc
 *    ▼
 * corum-cdp-router（本插件，装在被测方之外的「测试方」实例里）
 *    │ CDP WebSocket
 *    ▼
 * 被测实例（零安装：不装插件、不需要 token）
 * ```
 *
 * ## 为什么它必须是「测别人」而不是「测自己」
 *
 * 用户口径（2026-10-29）：「这个插件用来测试的是另外的实例，永远不是测试自己」。
 * 自测没有意义 —— 它证明不了「同一个用例在另一个基座版本上是否还成立」。
 * 所以本插件一切能力的入口都带 `targetId`，**没有「默认测自己」的分支**。
 *
 * ## 两层暴露面
 *
 * 1. **cordis 服务**（`super(ctx, 'cdpRouter')`）：`@Remote` RPC，供同进程的插件调用
 *    （如 CorumTestSuite）。
 * 2. **Agent 标准工具**（`defineAgentTool`）：Agent 可直接用，**不需要任何 MCP 配置**
 *    —— 这是与旧方案（扩展包里的 stdio MCP server）的根本区别。
 *
 * ## 为什么 inject 里只有 `tools`
 *
 * `tools` 是注册 Agent 工具的必要条件（`ctx.tools.register`），且必须在 `apply` 里
 * **同步**注册（工具面在每回合开头快照）。其余能力（文件读写、CDP）都是自足的，
 * 不依赖别的 cordis 服务 —— 这保证了它在不同基座版本上的可移植性。
 *
 * @module @corum/corum-cdp-router
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineAgentTool, registerAgentTool, type ToolDefinition } from '@corum/plugin-sdk'

import { CdpError, connectSession, listPages, redactUrl, type CdpPage } from './cdp-client.ts'
import { discover, type DiscoveredTarget, type DiscoverResult } from './discover.ts'
import { callRpcOnSession, readRemoteIdentity, wrapArgs, type RemoteRpcResult, type RpcShape } from './remote-rpc.ts'
import {
  CDP_TARGETS_FILENAME,
  CDP_TARGETS_VERSION,
  CdpTargetsConfigError,
  MAIN_INSTANCE_PORT,
  disabledReason,
  readConfig,
  resolveConfigPath,
  sampleConfig,
  validateConfig,
  writeConfig,
  type CdpTarget,
  type CdpTargetsConfig,
} from './targets.ts'

/** 服务名（决定 RPC 前缀 `/api/cdpRouter/*`）。 */
export const name = 'cdpRouter'

/**
 * 只 inject `tools` —— 见模块头注释。
 *
 * ⚠️ 漏声明会在 `ctx.tools` 上抛 `cannot get property "tools" without inject`
 * （本仓已付学费）。
 */
export const inject = ['tools']

/** 目标清单的解析结果（含来源与是否首次）。 */
export interface TargetListResult {
  readonly configPath: string
  readonly generation: number
  readonly autoDiscover: boolean
  readonly targets: readonly (CdpTarget & { readonly disabled: string | null })[]
  readonly lastError: string | null
}

/** `evaluate` 的入参。 */
export interface EvaluateInput {
  /** 目标 id（`listTargets` 返回的那个）。**没有默认值**——不测自己。 */
  readonly targetId: string
  /** 要执行的表达式（可 await，本服务已开 awaitPromise）。 */
  readonly expression: string
  /** 求值超时（毫秒）。 */
  readonly timeoutMs?: number
}

/** `evaluate` 的结果。 */
export interface EvaluateOutput {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string }
  /** 目标页 URL（已脱敏）。 */
  readonly pageUrl: string | null
  /** 目标实例身份（基座版本等），便于留档判断「测的是哪个版本」。 */
  readonly identity: {
    readonly releaseVersion: string | null
    readonly releaseCommit: string | null
    readonly rev: string | null
    readonly bootEntries: number
    readonly origin: string | null
  } | null
}

/** `callRpc` 的入参。 */
export interface CallRpcInput {
  readonly targetId: string
  readonly namespace: string
  readonly method: string
  /** args 形状：`none` 或 `named`（键 = 目标方法的形参名）。 */
  readonly shape?: RpcShape
  readonly payload?: Record<string, unknown>
  readonly timeoutMs?: number
}

/** `callRpc` 的结果。 */
export interface CallRpcOutput extends RemoteRpcResult {
  readonly targetId: string
}

/** 一次服务实例的状态（不跨实例共享；随 ctx.effect 清理）。 */
interface RouterState {
  /** 上次成功加载的配置代际（用于诊断「配置变了吗」）。 */
  generation: number
}

/**
 * CDP 路由服务。
 */
export class CdpRouterService extends TypertRemoteService {
  private readonly state: RouterState = { generation: 0 }

  constructor(ctx: Context) {
    super(ctx, 'cdpRouter')
  }

  /**
   * 解析目标清单（每次调用都重读，配置改了即时生效 —— 与 `cdpTargets` 同口径）。
   *
   * @returns 清单与诊断
   */
  private loadTargets(): TargetListResult & { readonly config: CdpTargetsConfig } {
    const configPath = resolveConfigPath()
    try {
      const { config, exists } = readConfig(configPath)
      this.state.generation += 1
      return {
        configPath,
        generation: this.state.generation,
        autoDiscover: config.autoDiscover,
        config,
        targets: config.targets.map(t => ({ ...t, disabled: disabledReason(t) })),
        lastError: exists ? null : `配置文件不存在，已按示例处理（autoDiscover: ${config.autoDiscover}，targets: 0）`,
      }
    } catch (error: unknown) {
      const message = error instanceof CdpTargetsConfigError
        ? `${error.code}: ${error.message}`
        : error instanceof Error ? error.message : String(error)
      this.state.generation += 1
      const fallback = sampleConfig()
      return {
        configPath,
        generation: this.state.generation,
        autoDiscover: false,
        config: fallback,
        targets: [],
        lastError: message,
      }
    }
  }

  /**
   * 按 id 找一个可用的 target。
   *
   * 三重校验：存在、未被护栏禁用、端口可达（可达性由调用处探测，这里只做前两项）。
   *
   * @param targetId - 目标 id
   * @returns target
   * @throws {Error} 找不到或被禁用（消息里列出可用 id —— 不让人猜）
   */
  private requireTarget(targetId: string): CdpTarget {
    const listed = this.loadTargets()
    const hit = listed.config.targets.find(t => t.id === targetId)
    if (hit === undefined) {
      const available = listed.config.targets.map(t => t.id)
      throw new Error(
        `未知 targetId ${JSON.stringify(targetId)}。可用：${available.length === 0 ? '(无，请先在 cdp-targets.json 里加一条)' : available.join(', ')}`
      )
    }
    const blocked = disabledReason(hit)
    if (blocked !== null) throw new Error(`拒绝连接 target ${hit.id}：${blocked}`)
    return hit
  }

  /**
   * 列目标。
   * @returns 清单与诊断
   */
  @Remote('listTargets')
  listTargetsRemote(_input: Record<string, unknown> | undefined): TargetListResult {
    const { config: _c, ...rest } = this.loadTargets()
    return rest
  }

  /**
   * 探测某个目标是否可达（只连 `/json/version`，不建 WebSocket）。
   * @param input - `{ targetId }`
   * @returns 可达性与身份
   */
  @Remote('probeTarget')
  async probeTargetRemote(input: Record<string, unknown> | undefined): Promise<{
    targetId: string
    reachable: boolean
    pages: readonly { id: string; url: string }[]
    error?: string
  }> {
    const targetId = typeof input?.targetId === 'string' ? input.targetId : ''
    const target = this.requireTarget(targetId)
    try {
      const pages = await listPages(target.port)
      return { targetId, reachable: true, pages: pages.map(p => ({ id: p.id, url: p.safeUrl })) }
    } catch (error: unknown) {
      return {
        targetId,
        reachable: false,
        pages: [],
        error: error instanceof CdpError ? error.message : String(error),
      }
    }
  }

  /**
   * 在目标实例的页面里执行一段 JS。
   *
   * 这是本服务的核心能力：目标实例**零安装** —— 不需要在它上面装任何插件，
   * 也不需要拿它的 token（页面自带）。
   *
   * @param input - `{ targetId, expression, timeoutMs? }`
   * @returns 求值结果 + 目标身份
   */
  @Remote('evaluate')
  async evaluateRemote(input: Record<string, unknown> | undefined): Promise<EvaluateOutput> {
    const targetId = typeof input?.targetId === 'string' ? input.targetId : ''
    const expression = typeof input?.expression === 'string' ? input.expression : ''
    const timeoutMs = typeof input?.timeoutMs === 'number' ? input.timeoutMs : 15000
    if (expression.trim() === '') {
      return { ok: false, error: { code: 'cdp-router/empty-expression', message: 'expression 不能为空' }, pageUrl: null, identity: null }
    }
    let target: CdpTarget
    try {
      target = this.requireTarget(targetId)
    } catch (error: unknown) {
      return {
        ok: false,
        error: { code: 'cdp-router/unknown-target', message: error instanceof Error ? error.message : String(error) },
        pageUrl: null,
        identity: null,
      }
    }
    let session
    try {
      session = await connectSession(target.port)
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: error instanceof CdpError ? error.code : 'cdp-router/connect-failed',
          message: error instanceof Error ? error.message : String(error),
        },
        pageUrl: null,
        identity: null,
      }
    }
    try {
      const identity = await readRemoteIdentity(session)
      const value = await session.evaluate(expression, timeoutMs)
      return { ok: true, value, pageUrl: session.pageUrl, identity }
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: error instanceof CdpError ? error.code : 'cdp-router/evaluate-failed',
          message: error instanceof Error ? error.message : String(error),
        },
        pageUrl: session.pageUrl,
        identity: null,
      }
    } finally {
      session.close()
    }
  }

  /**
   * 调目标实例的 host RPC（经页面内 fetch，自带鉴权）。
   *
   * @param input - `{ targetId, namespace, method, shape?, payload?, timeoutMs? }`
   * @returns RPC 结果
   */
  @Remote('callRpc')
  async callRpcRemote(input: Record<string, unknown> | undefined): Promise<CallRpcOutput> {
    const targetId = typeof input?.targetId === 'string' ? input.targetId : ''
    const namespace = typeof input?.namespace === 'string' ? input.namespace : ''
    const method = typeof input?.method === 'string' ? input.method : ''
    if (namespace === '' || method === '') {
      return { targetId, ok: false, httpStatus: 0, error: { code: 'cdp-router/bad-args', message: 'namespace 与 method 必填' } }
    }
    const shape = (input?.shape ?? { kind: 'none' }) as RpcShape
    const payload = (input?.payload ?? {}) as Record<string, unknown>
    const timeoutMs = typeof input?.timeoutMs === 'number' ? input.timeoutMs : 20000

    let target: CdpTarget
    try {
      target = this.requireTarget(targetId)
    } catch (error: unknown) {
      return {
        targetId,
        ok: false,
        httpStatus: 0,
        error: { code: 'cdp-router/unknown-target', message: error instanceof Error ? error.message : String(error) },
      }
    }
    let session
    try {
      session = await connectSession(target.port)
    } catch (error: unknown) {
      return {
        targetId,
        ok: false,
        httpStatus: 0,
        error: {
          code: error instanceof CdpError ? error.code : 'cdp-router/connect-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
    try {
      const result = await callRpcOnSession(session, namespace, method, wrapArgs(shape, payload), timeoutMs)
      return { targetId, ...result }
    } finally {
      session.close()
    }
  }

  /**
   * 往目标清单里加/改一条（写盘）。
   * @param input - `{ target, autoDiscover? }`
   * @returns 写入后的清单
   */
  @Remote('upsertTarget')
  upsertTargetRemote(input: Record<string, unknown> | undefined): TargetListResult {
    const raw = input?.target
    if (raw === null || typeof raw !== 'object') {
      throw new Error('upsertTarget 需要 { target: { id, ip, port } }')
    }
    const configPath = resolveConfigPath()
    const { config } = readConfig(configPath)
    const incoming = raw as CdpTarget
    const idx = config.targets.findIndex(t => t.id === incoming.id)
    const nextTargets = idx === -1
      ? [...config.targets, incoming]
      : [...config.targets.slice(0, idx), incoming, ...config.targets.slice(idx + 1)]
    const next: CdpTargetsConfig = {
      version: CDP_TARGETS_VERSION,
      autoDiscover: typeof input?.autoDiscover === 'boolean' ? input.autoDiscover : config.autoDiscover,
      targets: nextTargets,
    }
    writeConfig(configPath, next)
    const { config: _c, ...rest } = this.loadTargets()
    return rest
  }

  /**
   * 从清单里移除一条。
   * @param input - `{ id }`
   * @returns 写入后的清单
   */
  @Remote('removeTarget')
  removeTargetRemote(input: Record<string, unknown> | undefined): TargetListResult {
    const id = typeof input?.id === 'string' ? input.id : ''
    if (id === '') throw new Error('removeTarget 需要 { id }')
    const configPath = resolveConfigPath()
    const { config } = readConfig(configPath)
    const next: CdpTargetsConfig = {
      version: CDP_TARGETS_VERSION,
      autoDiscover: config.autoDiscover,
      targets: config.targets.filter(t => t.id !== id),
    }
    writeConfig(configPath, next)
    const { config: _c, ...rest } = this.loadTargets()
    return rest
  }

  /**
   * **自动发现本机正在运行的 Corum 实例**（不写配置，只报告）。
   *
   * 为什么这个能力必须内建：「不同的人、不同的机器端口不同」，靠手写配置必然过时。
   * 发现走三条源：pid 记录（带 home/combo/role）→ `/json/version` 身份探测 →
   * CDP 读 `__DSH_BOOT__.release`（基座版本）。
   *
   * 它**只读不写**：发现的实例要不要进 `cdp-targets.json` 由调用方决定
   * （`upsertTarget`）。这样「发现」与「采纳」是两步，用户能先看清再决定。
   *
   * @param input - `{ scanPorts?: boolean, maxScan?: number }`
   * @returns 发现的实例 + 诊断问题
   */
  @Remote('discoverTargets')
  async discoverTargetsRemote(input: Record<string, unknown> | undefined): Promise<DiscoverResult> {
    const scanPorts = input?.scanPorts === true
    const maxScan = typeof input?.maxScan === 'number' ? input.maxScan : undefined
    return await discover({
      scanPorts,
      ...(maxScan === undefined ? {} : { maxScan }),
    })
  }

  /**
   * 把当前发现结果**整体采纳**进配置（按 id 合并，已有则更新）。
   *
   * 与 `discoverTargets` 分成两步的理由：发现是「看清现场」，采纳是「改变配置」。
   * 合并策略：同 id 覆盖、新 id 追加；**不删除**已有但这次没发现的（实例可能只是
   * 暂时没起来，自动删掉会让用户下次启动时丢目标）。
   *
   * @param input - `{ scanPorts?, maxScan? }`
   * @returns 采纳后的清单
   */
  @Remote('adoptDiscovered')
  async adoptDiscoveredRemote(input: Record<string, unknown> | undefined): Promise<TargetListResult & { adopted: number }> {
    const scanPorts = input?.scanPorts === true
    const result = await discover({ scanPorts })
    const configPath = resolveConfigPath()
    const { config } = readConfig(configPath)
    const merged = new Map(config.targets.map(t => [t.id, t]))
    let adopted = 0
    for (const found of result.targets) {
      const label = found.role === 'main' ? '主实例' : found.role === 'verify' ? '验证实例' : '实例'
      const version = found.releaseVersion === null ? '基座版本未知' : `基座 ${found.releaseVersion}`
      merged.set(found.id, {
        id: found.id,
        ip: '127.0.0.1',
        port: found.port,
        readOnly: false,
        ...(found.role === 'main' ? { allowMain: false } : {}),
        description: `自动发现 · ${label} · ${version}${found.releaseCommit === null ? '' : `@${found.releaseCommit}`}`,
        discovered: {
          role: found.role,
          releaseVersion: found.releaseVersion,
          releaseCommit: found.releaseCommit,
          electronVersion: found.electronVersion,
          home: found.home,
          source: found.source,
        },
      })
      adopted += 1
    }
    writeConfig(configPath, {
      version: CDP_TARGETS_VERSION,
      autoDiscover: config.autoDiscover,
      targets: [...merged.values()],
    })
    const { config: _c, ...rest } = this.loadTargets()
    return { ...rest, adopted }
  }

  /**
   * 写一份示例配置（只在文件不存在时写；已存在绝不覆盖）。
   * @returns 写入结果
   */
  @Remote('ensureSampleConfig')
  ensureSampleConfigRemote(_input: Record<string, unknown> | undefined): { created: boolean; configPath: string } {
    const configPath = resolveConfigPath()
    if (existsSync(configPath)) return { created: false, configPath }
    writeConfig(configPath, sampleConfig())
    return { created: true, configPath }
  }
}

/**
 * 构造 Agent 可用的标准工具（不走 MCP 配置）。
 *
 * 工具名用 `cdp_` 前缀，与旧 MCP 版本保持认知连续；但**不再需要任何 MCP 配置**。
 *
 * @param service - 已构造的服务实例
 * @returns 工具定义数组
 */
export function buildAgentTools(service: CdpRouterService): ToolDefinition[] {
  const listTool = defineAgentTool({
    name: 'cdp_list_targets',
    description:
      '列出可用的 CDP 目标（被测 Corum 实例）。每个目标带 id/端口/基座版本/是否被护栏禁用。'
      + '测试前先用它确认「要测的是哪个实例」。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
    },
    async execute() {
      const listed = service['listTargetsRemote']({})
      return JSON.stringify(listed, null, 2)
    },
  })

  const evaluateTool = defineAgentTool({
    name: 'cdp_evaluate',
    description:
      '在**指定目标实例**的页面里执行一段 JS 并返回结果。目标实例零安装：不需要装插件、不需要 token。'
      + '典型用途：读取目标页面状态、调它的 host RPC（页内 fetch）、断言。',
    parameters: {
      targetId: { type: 'string', description: '目标 id（先用 cdp_list_targets 查看）' },
      expression: { type: 'string', description: '要执行的 JS 表达式（可 await）' },
      timeoutMs: { type: 'number', description: '求值超时，默认 15000' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
    },
    async execute(args: Record<string, unknown>) {
      const out = await service['evaluateRemote'](args)
      return JSON.stringify(out, null, 2)
    },
  })

  const callRpcTool = defineAgentTool({
    name: 'cdp_call_rpc',
    description:
      '调**指定目标实例**的 host RPC（经它页面内的 fetch，自带鉴权）。'
      + 'args 形状必须与方法形参名一致：`none` 表示无参，`named` 时 payload 会被包在 shape.key 下。',
    parameters: {
      targetId: { type: 'string', description: '目标 id' },
      namespace: { type: 'string', description: '服务名，如 agentPresets' },
      method: { type: 'string', description: '方法名，如 list' },
      shapeKey: { type: 'string', description: 'args 要包在哪个键下（留空=无参）。如 _request / request / input' },
      payloadJson: { type: 'string', description: 'args 内容（JSON 字符串），无参时留空' },
      timeoutMs: { type: 'number', description: '页内超时，默认 20000' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
    },
    async execute(args: Record<string, unknown>) {
      const shapeKey = typeof args.shapeKey === 'string' ? args.shapeKey : ''
      let payload: Record<string, unknown> = {}
      if (typeof args.payloadJson === 'string' && args.payloadJson.trim() !== '') {
        try {
          payload = JSON.parse(args.payloadJson) as Record<string, unknown>
        } catch (error: unknown) {
          return JSON.stringify({
            ok: false,
            error: { code: 'cdp-router/bad-payload', message: `payloadJson 不是合法 JSON：${String(error)}` },
          })
        }
      }
      const out = await service['callRpcRemote']({
        targetId: args.targetId,
        namespace: args.namespace,
        method: args.method,
        shape: shapeKey === '' ? { kind: 'none' } : { kind: 'named', key: shapeKey },
        payload,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      })
      return JSON.stringify(out, null, 2)
    },
  })

  const discoverTool = defineAgentTool({
    name: 'cdp_discover_targets',
    description:
      '自动发现本机正在运行的 Corum 实例（读 pid 记录 + 探测 CDP + 读基座版本）。'
      + '**只读不写**：发现的实例要不要采纳进配置，由你决定后调 cdp_adopt_discovered。'
      + '用途：用户说「测另一个实例」时，先看现场有哪些实例、各是什么基座版本。',
    parameters: {
      scanPorts: { type: 'boolean', description: '是否做端口扫描兜底（慢，默认 false）' },
      maxScan: { type: 'number', description: '端口扫描上限，默认 40' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
    },
    async execute(args: Record<string, unknown>) {
      const out = await service['discoverTargetsRemote'](args)
      return JSON.stringify(out, null, 2)
    },
  })

  const adoptTool = defineAgentTool({
    name: 'cdp_adopt_discovered',
    description:
      '把自动发现的实例采纳进 cdp-targets.json（按 id 合并：同 id 覆盖、新 id 追加、'
      + '**不删除**已有但这次未发现的）。采纳后即可用 cdp_evaluate / cdp_call_rpc 测它。',
    parameters: {
      scanPorts: { type: 'boolean', description: '是否做端口扫描兜底（默认 false）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
    },
    async execute(args: Record<string, unknown>) {
      const out = await service['adoptDiscoveredRemote'](args)
      return JSON.stringify(out, null, 2)
    },
  })

  return [listTool, discoverTool, adoptTool, evaluateTool, callRpcTool]
}

/**
 * 插件入口：构造服务 + 同步注册 Agent 工具。
 *
 * ⚠️ 工具必须在 `apply` 里**同步**注册（工具面在每回合开头快照）；不要 `await`
 * 之后再注册，否则「第一回合没工具、第二回合才有」。
 *
 * @param ctx - 宿主上下文
 */
export function apply(ctx: Context): void {
  const service = new CdpRouterService(ctx)
  const tools = buildAgentTools(service)
  for (const tool of tools) {
    const dispose = registerAgentTool(ctx.tools, tool)
    ctx.effect(() => dispose)
  }
}

export { CdpError, redactUrl, disabledReason, readConfig, writeConfig, validateConfig, resolveConfigPath }
export { CDP_TARGETS_FILENAME, CDP_TARGETS_VERSION, MAIN_INSTANCE_PORT, CdpTargetsConfigError }
export { discover, inferRole, readPidRecords, probePort, listListeningPorts, readAppVersion, defaultHomes, suggestId } from './discover.ts'
export type { DiscoveredTarget, DiscoverResult, DiscoverOptions, InstanceRole } from './discover.ts'
export type { CdpTarget, CdpTargetsConfig, RemoteRpcResult, RpcShape, CdpPage }
export { buildRpcExpression, wrapArgs, normalizeResult, callRpc, callRpcOnSession, readRemoteIdentity } from './remote-rpc.ts'
export { listPages, connectSession, evaluateOnPort } from './cdp-client.ts'
