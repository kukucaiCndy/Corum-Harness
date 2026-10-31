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

import {
  CdpError,
  click,
  connectSession,
  captureScreenshot,
  insertText,
  listPages,
  pressKey,
  redactUrl,
  resize,
  type CdpPage,
  type CdpSession,
} from './cdp-client.ts'
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

// ── runScript 类型 ───────────────────────────────────────────────────────────

/** runScript 中的一个步骤（action + 该 action 的字段）。 */
export interface ScriptStep {
  readonly action: 'click' | 'type' | 'key' | 'wait' | 'eval' | 'resize' | 'screenshot' | 'assert'
  /** 可选标签，出现在结果的 label 字段里。 */
  readonly label?: string
  // click
  readonly selector?: string
  readonly clickJs?: boolean | string
  // type
  readonly text?: string
  readonly into?: string
  readonly submit?: boolean
  readonly expectValue?: string
  // key
  readonly key?: string
  // wait
  readonly wait?: number
  // eval
  readonly eval?: string
  // resize
  readonly resize?: { width: number; height: number } | { reset: true }
  // screenshot
  readonly screenshot?: string
  // assert
  readonly exists?: boolean
  readonly count?: number
  readonly textContains?: string
  readonly textEquals?: string
  readonly style?: Record<string, string>
  readonly js?: string
  readonly expect?: unknown
}

/** runScript 的入参。 */
export interface RunScriptInput {
  readonly targetId: string
  /** 页面 URL 子串匹配（如 `floating=someSlot`），用于多窗口/浮窗分流。 */
  readonly pageUrlIncludes?: string
  readonly steps: readonly ScriptStep[]
  /** 整体超时（毫秒），默认 60000。 */
  readonly timeoutMs?: number
  /** 某步失败时是否立刻停止。默认 true —— 搜集证据后继续需要显式设 false。 */
  readonly failFast?: boolean
}

/** 单步执行结果。 */
export interface StepResult {
  readonly index: number
  readonly action: string
  readonly label: string
  readonly ok: boolean
  readonly error?: string
  /** assert 步骤的观测值（诊断用）。 */
  readonly observed?: string
  /** screenshot 步骤的截图名（base64 在顶层 screenshots 数组里）。 */
  readonly screenshot?: string
}

/** runScript 的结果。 */
export interface RunScriptOutput {
  readonly ok: boolean
  readonly targetId: string
  readonly results: readonly StepResult[]
  readonly console: { count: number; errors: readonly string[] }
  readonly network: { count: number; failed: readonly { url: string; errorText: string; canceled: boolean; blockedReason?: string }[] }
  /** 所有截图（base64 + name，让调用方决定落盘）。 */
  readonly screenshots: readonly { name: string; base64: string; size: number }[]
  /** 目标身份（基座版本等）。 */
  readonly identity: {
    readonly releaseVersion: string | null
    readonly releaseCommit: string | null
    readonly rev: string | null
    readonly bootEntries: number
    readonly origin: string | null
  } | null
  readonly durationMs: number
  /** 失败时的错误码（整体失败）。 */
  readonly error?: { code: string; message: string }
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
   * **长会话脚本执行**：一次 connectSession 顺序执行全部 steps，返回每步结果 +
   * console/网络证据 + 截图 + 目标身份。
   *
   * 这是自测中心的核心入口：每条用例的 CDP 脚本经本路由执行。步骤语义照搬
   * ui-verify.mjs（runStep/runAssertion，319–469 行）—— 已验证的成熟实现。
   *
   * ## failFast 语义
   *
   * 默认 `failFast: true`：某步失败时**标记该步 fail 后停止剩余步骤**，但仍收集
   * 到该步为止的证据。设 `false` 时继续执行后续步骤（用于「收集尽可能多证据」的场景）。
   * 未知 action 始终报 `run-script/unknown-action` 并标记该步 fail。
   *
   * ## assert 变体（与 ui-verify 一致）
   *
   * - `exists: true/false` → 选择器是否存在
   * - `count: N` → 选择器匹配数
   * - `textContains: '...'` → innerText 是否包含
   * - `textEquals: '...'` → innerText trim 后是否相等
   * - `style: { prop: value }` → getComputedStyle 对比
   * - `js: 'expression'` + `expect?: value` → 执行 JS，与 expect 比对（无 expect 时判 truthy）
   *
   * @param input - `{ targetId, pageUrlIncludes?, steps, timeoutMs?, failFast? }`
   * @returns 每步结果 + 证据 + 截图
   */
  @Remote('runScript')
  async runScriptRemote(input: Record<string, unknown> | undefined): Promise<RunScriptOutput> {
    const start = Date.now()
    const targetId = typeof input?.targetId === 'string' ? input.targetId : ''
    const pageUrlIncludes = typeof input?.pageUrlIncludes === 'string' ? input.pageUrlIncludes : undefined
    const steps = Array.isArray(input?.steps) ? input!.steps as readonly ScriptStep[] : []
    const timeoutMs = typeof input?.timeoutMs === 'number' ? input.timeoutMs : 60000
    const failFast = input?.failFast !== false // 默认 true

    // targetId 空拒
    if (targetId === '') {
      return {
        ok: false,
        targetId: '',
        results: [],
        console: { count: 0, errors: [] },
        network: { count: 0, failed: [] },
        screenshots: [],
        identity: null,
        durationMs: Date.now() - start,
        error: { code: 'run-script/empty-target', message: 'targetId 不能为空' },
      }
    }

    let target: CdpTarget
    try {
      target = this.requireTarget(targetId)
    } catch (error: unknown) {
      return {
        ok: false,
        targetId,
        results: [],
        console: { count: 0, errors: [] },
        network: { count: 0, failed: [] },
        screenshots: [],
        identity: null,
        durationMs: Date.now() - start,
        error: { code: 'cdp-router/unknown-target', message: error instanceof Error ? error.message : String(error) },
      }
    }

    let session: CdpSession
    try {
      session = await connectSession(target.port, pageUrlIncludes !== undefined ? { pageUrlIncludes } : {})
    } catch (error: unknown) {
      return {
        ok: false,
        targetId,
        results: [],
        console: { count: 0, errors: [] },
        network: { count: 0, failed: [] },
        screenshots: [],
        identity: null,
        durationMs: Date.now() - start,
        error: {
          code: error instanceof CdpError ? error.code : 'cdp-router/connect-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }

    // enable 证据域（必须在任何操作之前，否则丢首批事件）
    try {
      await session.send('Runtime.enable', {})
      await session.send('Log.enable', {})
      await session.send('Network.enable', {})
      await session.send('Page.enable', {})
    } catch {
      // enable 失败不致命：某些目标可能不支持全部域，继续执行
    }

    let identity: RunScriptOutput['identity'] = null
    try {
      identity = await readRemoteIdentity(session)
    } catch {
      // 身份读取失败不致命
    }

    const results: StepResult[] = []
    const screenshots: { name: string; base64: string; size: number }[] = []
    let hadFailure = false

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!
        const label = step.label ?? `${step.action}#${i}`
        const stepStart = Date.now()

        // 整体超时检查
        if (Date.now() - start > timeoutMs) {
          results.push({
            index: i,
            action: step.action,
            label,
            ok: false,
            error: `整体超时（${timeoutMs}ms）`,
          })
          hadFailure = true
          if (failFast) break
          continue
        }

        try {
          const result = await runStep(session, step, i, screenshots)
          results.push(result)
          if (!result.ok) {
            hadFailure = true
            if (failFast) break
          }
        } catch (error: unknown) {
          const errMsg = error instanceof CdpError
            ? `${error.code}: ${error.message}`
            : error instanceof Error ? error.message : String(error)
          results.push({
            index: i,
            action: step.action,
            label,
            ok: false,
            error: errMsg,
          })
          hadFailure = true
          if (failFast) break
        }

        // 避免单步卡死（0 超时保护：stepStart 只用于诊断，不实际限制）
        void stepStart
      }
    } finally {
      session.close()
    }

    const evSummary = session.evidence.summary()

    return {
      ok: !hadFailure,
      targetId,
      results,
      console: evSummary.console,
      network: evSummary.network,
      screenshots,
      identity,
      durationMs: Date.now() - start,
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

// ── runScript 的步骤执行器 ─────────────────────────────────────────────────────
//
// 语义照搬 ui-verify.mjs 的 runStep（319–396 行）与 runAssertion（415–468 行）。
// 它是已验证的成熟实现，字段语义一致。

/**
 * 执行单个 step，返回结构化结果。
 *
 * 导出供测试直接驱动（假 CdpSession 驱动 steps）。
 *
 * @param session - 已连上的会话（证据域已 enable）
 * @param step - 步骤定义
 * @param index - 步骤序号（用于截图命名）
 * @param screenshots - 截图累积数组（screenshot 步骤往里推）
 * @returns 步骤结果
 */
export async function runStep(
  session: CdpSession,
  step: ScriptStep,
  index: number,
  screenshots: { name: string; base64: string; size: number }[],
): Promise<StepResult> {
  const label = step.label ?? `${step.action}#${index}`

  switch (step.action) {
    case 'wait': {
      const ms = typeof step.wait === 'number' ? step.wait : 0
      await new Promise<void>(r => setTimeout(r, ms))
      return { index, action: 'wait', label, ok: true }
    }

    case 'click': {
      const selector = step.selector ?? ''
      if (selector === '') {
        return { index, action: 'click', label, ok: false, error: 'click 需要 selector' }
      }
      const result = await click(session, selector, step.clickJs !== undefined ? { clickJs: step.clickJs } : {})
      return { index, action: 'click', label, ok: true, observed: result.x !== undefined ? `${result.x},${result.y}` : 'js' }
    }

    case 'type': {
      const text = step.text ?? ''
      if (text === '' && step.expectValue === undefined) {
        return { index, action: 'type', label, ok: false, error: 'type 需要 text' }
      }
      const result = await insertText(session, text, {
        ...(step.into !== undefined ? { into: step.into } : {}),
        ...(step.submit === true ? { submit: true } : {}),
        ...(step.expectValue !== undefined ? { expectValue: step.expectValue } : {}),
      })
      return {
        index,
        action: 'type',
        label,
        ok: result.matched !== false,
        ...(result.observed !== undefined ? { observed: result.observed } : {}),
        ...(result.matched === false ? { error: `expectValue 不符：期望 ${JSON.stringify(step.expectValue)} 实得 ${JSON.stringify(result.observed)}` } : {}),
      }
    }

    case 'key': {
      const key = step.key ?? ''
      if (key === '') {
        return { index, action: 'key', label, ok: false, error: 'key 步骤需要 key 字段' }
      }
      await pressKey(session, key)
      return { index, action: 'key', label, ok: true }
    }

    case 'eval': {
      const expr = step.eval ?? ''
      if (expr === '') {
        return { index, action: 'eval', label, ok: false, error: 'eval 步骤需要 eval 字段' }
      }
      const value = await session.evaluate(expr)
      return { index, action: 'eval', label, ok: true, observed: JSON.stringify(value) }
    }

    case 'resize': {
      if (step.resize === undefined) {
        return { index, action: 'resize', label, ok: false, error: 'resize 步骤需要 resize 字段' }
      }
      await resize(session, step.resize)
      return { index, action: 'resize', label, ok: true }
    }

    case 'screenshot': {
      const name = step.screenshot ?? `shot-${index}`
      const shot = await captureScreenshot(session)
      screenshots.push({ name, base64: shot.base64, size: shot.size })
      return { index, action: 'screenshot', label, ok: true, screenshot: name }
    }

    case 'assert': {
      return runAssertion(session, step, index, label, screenshots)
    }

    default: {
      // 未知 action：报 run-script/unknown-action（与 brief 要求一致）
      return {
        index,
        action: String(step.action),
        label,
        ok: false,
        error: `run-script/unknown-action: ${JSON.stringify(step.action)}`,
      }
    }
  }
}

/**
 * 执行一个 assert 步骤。语义照搬 ui-verify.mjs 的 runAssertion（415–468 行）。
 */
export async function runAssertion(
  session: CdpSession,
  step: ScriptStep,
  index: number,
  label: string,
  screenshots: { name: string; base64: string; size: number }[] = [],
): Promise<StepResult> {
  // screenshot assert（ui-verify 把 screenshot 归到 assert 里）
  if (step.screenshot !== undefined) {
    const name = step.screenshot
    const shot = await captureScreenshot(session)
    screenshots.push({ name, base64: shot.base64, size: shot.size })
    return { index, action: 'assert', label, ok: true, screenshot: name, observed: `${shot.size} bytes` }
  }

  const selector = step.selector ?? 'body'
  const selJson = JSON.stringify(selector)

  // exists
  if (step.exists !== undefined) {
    const n = await session.evaluate(`document.querySelectorAll(${selJson}).length`) as number
    return {
      index,
      action: 'assert',
      label,
      ok: (n > 0) === step.exists,
      observed: `count=${n}（期望 exists=${step.exists}）`,
    }
  }

  // count
  if (step.count !== undefined) {
    const n = await session.evaluate(`document.querySelectorAll(${selJson}).length`) as number
    return {
      index,
      action: 'assert',
      label,
      ok: n === step.count,
      observed: `count=${n}（期望 ${step.count}）`,
    }
  }

  // textContains / textEquals
  if (step.textContains !== undefined || step.textEquals !== undefined) {
    const txt = await session.evaluate(`(() => { const el = document.querySelector(${selJson}); return el ? (el.innerText || '') : null })()`) as string | null
    if (txt === null) {
      return { index, action: 'assert', label, ok: false, observed: `选择器无匹配：${selector}` }
    }
    if (step.textContains !== undefined) {
      return {
        index,
        action: 'assert',
        label,
        ok: txt.includes(step.textContains),
        observed: step.textContains,
      }
    }
    // textEquals
    return {
      index,
      action: 'assert',
      label,
      ok: txt.trim() === step.textEquals,
      observed: `实际=${JSON.stringify(txt.trim().slice(0, 80))}`,
    }
  }

  // style
  if (step.style !== undefined) {
    const names = Object.keys(step.style)
    const got = await session.evaluate(`(() => {
      const el = document.querySelector(${selJson}); if (!el) return null
      const cs = getComputedStyle(el)
      const names = ${JSON.stringify(names)}
      const out = {}
      for (const n of names) out[n] = String(cs.getPropertyValue(n) || cs[n] || '').trim()
      return out
    })()`) as Record<string, string> | null
    if (got === null) {
      return { index, action: 'assert', label, ok: false, observed: `选择器无匹配：${selector}` }
    }
    const bad = names.filter(n => String(got[n] ?? '').trim() !== String(step.style![n]).trim())
    return {
      index,
      action: 'assert',
      label,
      ok: bad.length === 0,
      observed: bad.length === 0
        ? names.map(n => `${n}=${step.style![n]}`).join(' ')
        : bad.map(n => `${n}: 期望 ${step.style![n]} 实得 ${String(got[n]).trim()}`).join('; '),
    }
  }

  // js
  if (step.js !== undefined) {
    const got = await session.evaluate(step.js)
    const ok = step.expect === undefined ? Boolean(got) : JSON.stringify(got) === JSON.stringify(step.expect)
    return {
      index,
      action: 'assert',
      label,
      ok,
      observed: `实得 ${JSON.stringify(got)}${step.expect === undefined ? '' : `（期望 ${JSON.stringify(step.expect)}）`}`,
    }
  }

  // 没有 assert 子字段 → 未知断言
  return {
    index,
    action: 'assert',
    label,
    ok: false,
    error: 'run-script/unknown-assert: assert 步骤缺少 exists/count/textContains/textEquals/style/js 字段',
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

  const runScriptTool = defineAgentTool({
    name: 'cdp_run_script',
    description:
      '在**指定目标实例**上执行一组 CDP 脚本步骤（click/type/key/wait/eval/resize/screenshot/assert）。'
      + '一次连接顺序执行全部 steps，返回每步结果 + console/网络证据 + 截图 + 目标身份。'
      + 'assert 变体：exists/count/textContains/textEquals/style/js{expression,expect?}。'
      + '截图只传 base64+name（由调用方决定落盘）。',
    parameters: {
      targetId: { type: 'string', description: '目标 id' },
      pageUrlIncludes: { type: 'string', description: '页面 URL 子串匹配（如 floating=someSlot），用于多窗口/浮窗分流' },
      stepsJson: { type: 'string', description: 'steps 数组的 JSON 字符串：[{action:"click",selector:"...",label:"..."}, ...]' },
      timeoutMs: { type: 'number', description: '整体超时（毫秒），默认 60000' },
      failFast: { type: 'boolean', description: '某步失败时是否停止（默认 true）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
    },
    async execute(args: Record<string, unknown>) {
      let steps: readonly ScriptStep[] = []
      if (typeof args.stepsJson === 'string' && args.stepsJson.trim() !== '') {
        try {
          const parsed = JSON.parse(args.stepsJson)
          if (!Array.isArray(parsed)) {
            return JSON.stringify({ ok: false, error: { code: 'cdp-router/bad-steps', message: 'stepsJson 必须是数组' } })
          }
          steps = parsed as readonly ScriptStep[]
        } catch (error: unknown) {
          return JSON.stringify({
            ok: false,
            error: { code: 'cdp-router/bad-steps', message: `stepsJson 不是合法 JSON：${String(error)}` },
          })
        }
      }
      const out = await service['runScriptRemote']({
        targetId: args.targetId,
        ...(typeof args.pageUrlIncludes === 'string' ? { pageUrlIncludes: args.pageUrlIncludes } : {}),
        steps,
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        ...(typeof args.failFast === 'boolean' ? { failFast: args.failFast } : {}),
      })
      return JSON.stringify(out, null, 2)
    },
  })

  return [listTool, discoverTool, adoptTool, evaluateTool, callRpcTool, runScriptTool]
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
export type { CdpTarget, CdpTargetsConfig, RemoteRpcResult, RpcShape }
export { buildRpcExpression, wrapArgs, normalizeResult, callRpc, callRpcOnSession, readRemoteIdentity } from './remote-rpc.ts'
export { listPages, connectSession, evaluateOnPort, click, insertText, pressKey, captureScreenshot, resize, buildFinder } from './cdp-client.ts'
export type { CdpSession, CdpPage, CdpParams, Evidence, ConsoleEntry, NetworkEntry, NetworkFailure, ClickResult, InsertTextResult, ScreenshotResult, ResizeOptions, ConnectOptions } from './cdp-client.ts'
