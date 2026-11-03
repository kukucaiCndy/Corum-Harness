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
  readViewport,
  redactUrl,
  resize,
  type CdpPage,
  type CdpSession,
  type ViewportInfo,
} from './cdp-client.ts'
import { discover, probePort, type DiscoveredTarget, type DiscoverResult } from './discover.ts'
import { callRpcOnSession, readRemoteIdentity, wrapArgs, type RemoteRpcResult, type RpcShape } from './remote-rpc.ts'
import {
  CDP_TARGETS_FILENAME,
  CDP_TARGETS_VERSION,
  CdpTargetsConfigError,
  MAIN_INSTANCE_PORT,
  SCAN_INTERVAL_DEFAULT_MS,
  SCAN_INTERVAL_MAX_MS,
  SCAN_INTERVAL_MIN_MS,
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

/**
 * 一条已配置目标的运行期视图（配置字段 + 两条独立的判定轴）。
 *
 * `disabled`（策略）与 `reachable`（现场）**不能合并成一个字段**：前者是「允不允许连」，
 * 后者是「此刻连不连得上」。合并会导致「允许但对方没起」被误报成「被护栏禁用」，
 * 用户就失去了修复方向（该去启动实例，还是该去改 allowMain）。
 */
export interface ProbedTarget extends CdpTarget {
  /** 非 null = 策略禁止连接（护栏原因）。 */
  readonly disabled: string | null
  /** 此刻 `/json/version` 是否应答（`disabled` 非 null 时恒为 false，不探）。 */
  readonly reachable: boolean
  /** 探活失败的原因（`reachable === true` 时为 null）。 */
  readonly probeError: string | null
}

/** 目标清单的解析结果（含来源与是否首次）。 */
export interface TargetListResult {
  readonly configPath: string
  readonly generation: number
  readonly autoDiscover: boolean
  readonly targets: readonly ProbedTarget[]
  readonly lastError: string | null
}

/**
 * 自动扫描设置的对外视图（`scanSettings` / `setScanSettings` 的返回）。
 *
 * `scanIntervalMs` 是**配置值**，`activeIntervalMs` 是**定时器真正在用的值**。
 * 两者分开暴露是有意的：配置改了却没重挂时它们不一致，页面据此能显示
 * 「设置已保存，但当前生效的仍是 X」而不是假装一致。
 */
export interface ScanSettingsView {
  /** 开关：关掉即不挂定时器、启动也不扫。 */
  readonly autoDiscover: boolean
  /** 配置里的扫描间隔（毫秒）。 */
  readonly scanIntervalMs: number
  /** 定时器当前实际使用的间隔；未挂定时器为 null。 */
  readonly activeIntervalMs: number | null
  /** 定时器是否真的挂着。 */
  readonly timerActive: boolean
  /** 允许的最小间隔（毫秒），供 UI 校验与提示。 */
  readonly minIntervalMs: number
  /** 允许的最大间隔（毫秒）。 */
  readonly maxIntervalMs: number
  /** 缺省间隔（毫秒）。 */
  readonly defaultIntervalMs: number
  /** 上次扫描时刻（ISO）；null = 还没扫过。 */
  readonly lastScanAt: string | null
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
  /**
   * 显式放行「模拟视口截图」（默认 false）：仅当调用方就是要在模拟视口下看布局时
   * 置 true。缺省时若视口非真实（inner !== outer），screenshot 步骤直接 `ok: false`
   * —— 静默产出「看起来正常但其实是假视口」的图正是 2026-11-02 事故的根源。
   */
  readonly emulatedViewportOk?: boolean
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
  /**
   * 会话结束时的视口实测值（读失败则省略，不让整个脚本因此失败）。
   * `emulated: true` 表示截图/断言是在模拟视口下产生的 —— 不可作为真实窗口证据。
   */
  readonly viewport?: ViewportInfo
  /** 失败时的错误码（整体失败）。 */
  readonly error?: { code: string; message: string }
}

/** 一次服务实例的状态（不跨实例共享；随 ctx.effect 清理）。 */
/** 扫描调度决策（把「配置」翻译成「挂不挂定时器、要不要立刻扫一次」）。 */
export interface ScanSchedule {
  /** 要用的间隔（毫秒）；`null` = 不挂定时器（开关已关）。 */
  readonly intervalMs: number | null
  /** 挂定时器之前是否立刻扫一次。 */
  readonly scanImmediately: boolean
}

/**
 * 从配置算出扫描调度（**纯函数**：不碰定时器、不做 IO）。
 *
 * 抽出来是为了可测：`applyScanSchedule` 挂在 `TypertRemoteService` 上，构造必须落在
 * 真实 cordis 上下文里；而「开关关掉就别扫」「间隔原样用」这两条判据本身与宿主无关，
 * 放在纯函数里才测得动。
 *
 * 开关优先：`autoDiscover: false` 时**间隔不生效**（否则会变成「我关了它还在扫」）。
 *
 * @param config - 已校验的配置
 * @returns 调度决策
 */
export function resolveScanSchedule(config: CdpTargetsConfig): ScanSchedule {
  if (!config.autoDiscover) return { intervalMs: null, scanImmediately: false }
  // 开着就先扫一次：用户打开应用就想看到现场，不该等第一个间隔到点。
  return { intervalMs: config.scanIntervalMs, scanImmediately: true }
}

interface RouterState {
  /** 上次成功加载的配置代际（用于诊断「配置变了吗」）。 */
  generation: number
  /**
   * **最近一次自动扫描的结果**（进程生命周期内缓存）。
   *
   * 为什么缓存在服务上而不是每次让界面现扫：扫描要读 pid 记录 + 逐个探
   * `/json/version`，是**跨进程 IO**，界面每次挂载都跑一遍会让设置页开得慢，
   * 而且开页这个动作本身不改变现场。口径是「**按 `scanIntervalMs` 周期扫**（见
   * `applyScanSchedule`），用户点「重新扫描」显式刷新」。
   */
  scan: DiscoverResult | null
  /** 扫描发生时刻（ISO）；`null` = 还没扫过。 */
  scannedAt: string | null
  /** 正在扫描中（防抖：避免并发点击打出一堆探测）。 */
  scanning: boolean
  /** 当前生效的定时器（`autoDiscover: false` 时为 null）。 */
  timer: ReturnType<typeof setInterval> | null
  /** 当前定时器生效的间隔（毫秒）；仅用于诊断「配置改了但还没重挂」。 */
  activeIntervalMs: number | null
}

/**
 * CDP 路由服务。
 */
export class CdpRouterService extends TypertRemoteService {
  private readonly state: RouterState = {
    generation: 0,
    scan: null,
    scannedAt: null,
    scanning: false,
    timer: null,
    activeIntervalMs: null,
  }

  constructor(ctx: Context) {
    super(ctx, 'cdpRouter')
    ctx.effect(() => () => {
      this.state.scan = null
      this.state.scannedAt = null
      this.stopScanTimer()
    })
  }

  /**
   * 按当前配置挂上（或撤掉）自动扫描定时器，并在启用时先扫一次。
   *
   * 用户口径（2026-11-03）：「增加一个自动扫描开关和间隔设置，用户可以关闭并设置
   * 扫描间隔」。所以「扫不扫」「多久扫」**都来自配置**，不是常量：
   *  - `autoDiscover: false` ⇒ **不挂定时器**，启动时也不扫（关掉就该真关掉）；
   *  - `autoDiscover: true` ⇒ 先扫一次，此后每 `scanIntervalMs` 扫一次。
   *
   * 幂等 + 可重挂：配置改了（UI 存盘 / 手改文件）后调本方法即可换间隔，
   * 不会留下两个并发的定时器。
   *
   * 注入 `timer`/`clear` 是为了可测：测试传假定时器，不真等 5 分钟。
   *
   * @param options.current - 当前配置（不传则现读文件）
   * @param options.timer - 定时器工厂（默认 `setInterval`）
   * @param options.clear - 定时器清理（默认 `clearInterval`）
   * @returns 生效的间隔（毫秒）；关闭时为 null
   */
  applyScanSchedule(options: {
    current?: CdpTargetsConfig
    timer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
    clear?: (handle: ReturnType<typeof setInterval>) => void
  } = {}): number | null {
    const clear = options.clear ?? clearInterval
    this.stopScanTimer(clear)

    const plan = resolveScanSchedule(options.current ?? this.loadTargets().config)
    if (plan.intervalMs === null) {
      // 关掉 = 不挂定时器、也不做启动扫描。缓存留着（页面仍能显示上次结果）。
      return null
    }

    // 启用时先扫一次：用户打开应用就想看到现场，不该等第一个间隔到点。
    if (plan.scanImmediately) void this.runScan()

    const timer = options.timer ?? setInterval
    this.state.timer = timer(() => { void this.runScan() }, plan.intervalMs)
    this.state.activeIntervalMs = plan.intervalMs
    return plan.intervalMs
  }

  /**
   * 撤掉现有定时器（幂等）。
   *
   * @param clear - 清理函数（默认 `clearInterval`；测试可注入）
   */
  private stopScanTimer(clear: (handle: ReturnType<typeof setInterval>) => void = clearInterval): void {
    if (this.state.timer !== null) {
      clear(this.state.timer)
      this.state.timer = null
    }
    this.state.activeIntervalMs = null
  }

  /**
   * 执行一次扫描并写进状态（并发安全：同一时刻只跑一趟）。
   *
   * `scanPorts` **默认开**：这是通用 CDP 扫描器，不是「corum 实例扫描器」。
   * 用户手起一个 `chrome --remote-debugging-port=N` 也是合格目标（本插件存在的理由
   * 正是「不想为每个客户端写死端口」），只扫 pid 记录会永远看不到它。
   *
   * @param scanPorts - 是否做监听端口扫描（默认开；关掉只扫 pid 记录，快很多）
   * @returns 扫描结果
   */
  private async runScan(scanPorts = true): Promise<DiscoverResult> {
    if (this.state.scanning) return this.state.scan ?? { targets: [], problems: [] }
    this.state.scanning = true
    try {
      // pid 记录优先（带 home/combo/role），端口扫描兜住「没有 pid 记录的端点」：
      // 手起的 Chrome、别的 home 起的实例。
      const result = await discover({ scanPorts })
      this.state.scan = result
      this.state.scannedAt = new Date().toISOString()
      return result
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const failed: DiscoverResult = { targets: [], problems: [`扫描失败：${message}`] }
      this.state.scan = failed
      this.state.scannedAt = new Date().toISOString()
      return failed
    } finally {
      this.state.scanning = false
    }
  }

  /**
   * 解析目标清单（每次调用都重读，配置改了即时生效 —— 与 `cdpTargets` 同口径）。
   *
   * 返回的是**纯配置视图**（`reachable` 一律按 `false` 占位）：探活是 IO，
   * 只有对外的 `listTargets` 才付这个代价。内部判定（`requireTarget`）只需要
   * 知道「配置里有没有这条、是否被护栏禁掉」，不该因为一个用来找 id 的调用
   * 去打一圈端口。
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
        targets: config.targets.map(t => ({ ...t, disabled: disabledReason(t), reachable: false, probeError: null })),
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
   * 列目标（**含真实可达性**）。
   *
   * ## 为什么要探活，而不是只报「配置合法」
   *
   * 旧实现的状态只来自 `disabledReason()`（护栏：9222 需 allowMain），于是
   * 一条指向**早已关闭**端口的配置照样显示「可用」。用户实测踩到：配置里三条
   * （9333 / 9400 / 9346）全部不通，界面却全绿 —— 状态是**谎报**，比不显示更糟。
   *
   * 现在每条并发探一次 `/json/version`（默认 900ms 超时，串起来也不会卡太久；
   * 端口数通常个位数）。`reachable` 与 `disabled` 是**两条独立的轴**：
   *  - `disabled !== null`：策略上禁止连（护栏），优先级最高；
   *  - `reachable === false`：策略允许，但**此刻没人接**（实例没起 / 端口变了）。
   *
   * @param input - `{ probe?: boolean }`，`probe: false` 可跳过探活（只读配置，极快）
   * @returns 清单与诊断
   */
  @Remote('listTargets')
  async listTargetsRemote(input: Record<string, unknown> | undefined): Promise<TargetListResult> {
    const { config, ...rest } = this.loadTargets()
    // `probe: false` = 只读配置，一条端口都不打（界面首屏可用它先渲染出骨架）。
    // 此时 `reachable` 一律 false 且 `probeError` 说明「未探测」，**不能用它当作
    // 「不通」的证据** —— 页面要按 `probeError` 区分「没探」与「探了不通」。
    if (input?.probe === false) {
      return {
        ...rest,
        targets: config.targets.map(t => ({
          ...t,
          disabled: disabledReason(t),
          reachable: false,
          probeError: '未探测（probe: false）',
        })),
      }
    }
    const probed: ProbedTarget[] = await Promise.all(config.targets.map(async (t) => {
      const disabled = disabledReason(t)
      // 被护栏禁掉的条目**不再探端口**：结论已经定了，多探一次只是浪费。
      if (disabled !== null) return { ...t, disabled, reachable: false as const, probeError: null }
      // ⚠️ `probePort` 走**返回值**表达失败（不可达时回 `reachable: false` 的 blank 对象），
      // **不抛错**。写成 `await probePort(...)` 然后当成功，会让每个死端口都报「在线」——
      // 那正是本次要修的那类谎报，换了个地方复发。判据必须读返回值本身。
      const probe = await probePort(t.port, 900)
      if (probe.reachable) return { ...t, disabled: null, reachable: true as const, probeError: null }
      return {
        ...t,
        disabled: null,
        reachable: false as const,
        probeError: `端口 ${t.port} 无应答（/json/version 未响应）`,
      }
    }))
    return { ...rest, targets: probed }
  }

  /**
   * 显式重新扫描本机实例（用户点「重新扫描」走这里）。
   *
   * `listTargets` 的 `targets` 是**配置里有什么**；本方法是**现场有什么** ——
   * 两者是不同的问题，页面上也分开呈现（「已采纳的目标」vs「扫描到的实例」）。
   *
   * @param input - `{ scanPorts?: boolean }`
   * @returns 扫描结果 + 扫描时刻
   */
  @Remote('rescan')
  async rescanRemote(input: Record<string, unknown> | undefined): Promise<DiscoverResult & { scannedAt: string | null }> {
    // 用户点「重新扫描」要的是**最全**的现场，故默认带端口扫描（`scanPorts: false` 可显式关闭）。
    const result = await this.runScan(input?.scanPorts !== false)
    return { ...result, scannedAt: this.state.scannedAt }
  }

  /**
   * 读**上次扫描的缓存结果**（不触发新扫描）。
   *
   * 页面首屏用它：插件启动时已经扫过一次（`startAutoScan`），首屏直接展示那次
   * 结果即可，不必每次开设置页都重新打端口。
   *
   * @returns 缓存结果（`scannedAt === null` 表示还没扫过）
   */
  @Remote('lastScan')
  lastScanRemote(_input: Record<string, unknown> | undefined): DiscoverResult & { scannedAt: string | null; scanning: boolean } {
    return {
      targets: this.state.scan?.targets ?? [],
      problems: this.state.scan?.problems ?? [],
      scannedAt: this.state.scannedAt,
      scanning: this.state.scanning,
    }
  }

  /**
   * 读自动扫描设置（开关 + 间隔 + 生效状态）。
   *
   * 页面要能回答「它现在到底扫不扫、多久扫一次」，所以除配置值外还回报**生效值**
   * （`activeIntervalMs`）与定时器是否真的挂着 —— 配置改了但没重挂时两者会不一致，
   * 那正是需要看得见的诊断。
   *
   * @returns 开关、配置间隔、生效间隔、是否已挂定时器
   */
  @Remote('scanSettings')
  scanSettingsRemote(_input: Record<string, unknown> | undefined): ScanSettingsView {
    const { config, lastError } = this.loadTargets()
    // 配置读坏了（lastError 非空）时按示例回退，别让设置页整页不可用。
    const effective = lastError === null ? config : sampleConfig()
    return {
      autoDiscover: effective.autoDiscover,
      scanIntervalMs: effective.scanIntervalMs,
      activeIntervalMs: this.state.activeIntervalMs,
      timerActive: this.state.timer !== null,
      minIntervalMs: SCAN_INTERVAL_MIN_MS,
      maxIntervalMs: SCAN_INTERVAL_MAX_MS,
      defaultIntervalMs: SCAN_INTERVAL_DEFAULT_MS,
      lastScanAt: this.state.scannedAt,
    }
  }

  /**
   * 改自动扫描设置（开关 / 间隔），写盘后**立刻重挂定时器**。
   *
   * 为什么写盘后自己重挂而不是等下次重启：用户改完开关期待「立刻不扫了」，
   * 让他手动重启插件不可接受。
   *
   * `autoDiscover: true` 且此前是关的 ⇒ 重挂会先扫一次（见 `applyScanSchedule`），
   * 所以「打开开关」也顺带把现场刷新了一遍。
   *
   * @param input - `{ autoDiscover?: boolean, scanIntervalMs?: number }`（都可选，只改给的）
   * @returns 写完后的设置视图（同 `scanSettings`）
   * @throws 间隔超出允许区间或不是整数
   */
  @Remote('setScanSettings')
  setScanSettingsRemote(input: Record<string, unknown> | undefined): ScanSettingsView {
    const configPath = resolveConfigPath()
    const { config } = readConfig(configPath)

    const autoDiscover = typeof input?.autoDiscover === 'boolean' ? input.autoDiscover : config.autoDiscover
    let scanIntervalMs = config.scanIntervalMs
    if (input?.scanIntervalMs !== undefined) {
      const raw = input.scanIntervalMs
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw new Error('scanIntervalMs 必须是整数毫秒')
      }
      if (raw < SCAN_INTERVAL_MIN_MS || raw > SCAN_INTERVAL_MAX_MS) {
        throw new Error(`扫描间隔必须在 ${SCAN_INTERVAL_MIN_MS / 1000}~${SCAN_INTERVAL_MAX_MS / 1000} 秒之间`)
      }
      scanIntervalMs = raw
    }

    writeConfig(configPath, {
      version: CDP_TARGETS_VERSION,
      autoDiscover,
      scanIntervalMs,
      targets: config.targets,
    })
    // 立刻按新配置重挂（关掉会撤定时器；打开会先扫一次）。
    this.applyScanSchedule()
    return this.scanSettingsRemote(undefined)
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
      const pages = await listPages(target.port, 2000, target.ip)
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
      session = await connectSession(target.port, { ip: target.ip })
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
      session = await connectSession(target.port, { ip: target.ip })
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
      session = await connectSession(target.port, { ip: target.ip, ...(pageUrlIncludes !== undefined ? { pageUrlIncludes } : {}) })
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
    // 2026-11-02 事故修复：resize（非 reset）会留下 Emulation override，用完必须 clear。
    // 「靠调用方自觉 reset」不可靠（clear 后视口也不一定立即恢复），所以作用域收在
    // runScript 自己手里：本次跑过非 reset 的 resize，finally 里强制 clear。
    let viewportOverridden = false
    // 会话结束时的视口实测值（读失败则省略）。
    let viewport: ViewportInfo | undefined

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
          // resize 的作用域状态：非 reset 设覆盖（true），reset 复原（false）。
          if (step.action === 'resize' && step.resize !== undefined) {
            viewportOverridden = !('reset' in step.resize && step.resize.reset === true)
          }
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
      // 作用域收尾：先 clear override（失败要大声说 —— 视口可能仍被覆盖，需重启实例），
      // 再读一次视口实测值（RunScriptOutput.viewport），最后关会话。中途抛错也走到这里。
      if (viewportOverridden) {
        try {
          await session.send('Emulation.clearDeviceMetricsOverride', {})
        } catch (clearError: unknown) {
          console.error('[cdp-router] Emulation.clearDeviceMetricsOverride 失败：'
            + '目标实例视口可能仍被覆盖，需重启该实例。'
            + `原因：${clearError instanceof Error ? clearError.message : String(clearError)}`)
        }
      }
      // 视口实测：读失败不致命（省略字段），但这正是「不能假装知道视口是什么」的降级。
      try {
        viewport = await readViewport(session)
      } catch {
        // 省略 viewport 字段
      }
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
      ...(viewport !== undefined ? { viewport } : {}),
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
      // 保住用户的扫描间隔：upsert 一条目标不该把间隔重置成默认值。
      scanIntervalMs: config.scanIntervalMs,
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
      scanIntervalMs: config.scanIntervalMs,
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
    // 与 `rescan` 走同一个 `runScan`（同一趟逻辑、同一份缓存）：否则「Agent 工具看到的
    // 现场」与「设置页看到的现场」迟早会漂成两种数字。
    if (maxScan !== undefined) {
      return await discover({ scanPorts, maxScan })
    }
    return await this.runScan(scanPorts)
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
      scanIntervalMs: config.scanIntervalMs,
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
      // 截图前校验「视口是真实的」：inner !== outer 说明有 Emulation override 残留
      // 或窗口几何异常，这样的截图不可作为真实窗口证据（2026-11-02 事故的根源就是
      // 拿假视口截图当证据）。显式 `emulatedViewportOk: true` 才放行。
      // 读不出视口（evaluate 挂了等）不拦截图 —— 不能因校验装置自身故障吞掉证据，
      // 但也不假装校验过：observed 里如实标注。
      let vp: ViewportInfo | undefined
      try {
        vp = await readViewport(session)
      } catch { /* vp 保持 undefined */ }
      if (vp?.emulated === true && step.emulatedViewportOk !== true) {
        return {
          index,
          action: 'screenshot',
          label,
          ok: false,
          error: `视口非真实（inner=${vp.innerWidth}x${vp.innerHeight}, outer=${vp.outerWidth}x${vp.outerHeight}）`
            + '，截图不可作为证据。若确需在模拟视口下截图，请在该步骤显式声明 emulatedViewportOk: true。',
        }
      }
      const shot = await captureScreenshot(session)
      const finalName = vp?.emulated === true ? `${name}-emulated` : name
      screenshots.push({ name: finalName, base64: shot.base64, size: shot.size })
      return {
        index,
        action: 'screenshot',
        label,
        ok: true,
        screenshot: finalName,
        observed: vp === undefined
          ? '视口读取失败（未校验真实性）'
          : `视口 ${vp.innerWidth}x${vp.innerHeight}${vp.emulated ? '（emulated，调用方已显式放行）' : ''}`,
      }
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
    // 与 screenshot action 同一套防护：假视口截图默认判 FAIL（2026-11-02 事故）。
    // 读不出视口不拦截图（校验装置自身故障不吞证据），observed 如实标注未校验。
    let vp: ViewportInfo | undefined
    try {
      vp = await readViewport(session)
    } catch { /* vp 保持 undefined */ }
    if (vp?.emulated === true && step.emulatedViewportOk !== true) {
      return {
        index,
        action: 'assert',
        label,
        ok: false,
        observed: `视口非真实（inner=${vp.innerWidth}x${vp.innerHeight}, outer=${vp.outerWidth}x${vp.outerHeight}），截图不可作为证据`
          + '（确需模拟视口截图时显式声明 emulatedViewportOk: true）',
      }
    }
    const shot = await captureScreenshot(session)
    const finalName = vp?.emulated === true ? `${name}-emulated` : name
    screenshots.push({ name: finalName, base64: shot.base64, size: shot.size })
    return {
      index,
      action: 'assert',
      label,
      ok: true,
      screenshot: finalName,
      observed: vp === undefined
        ? `${shot.size} bytes · 视口读取失败（未校验真实性）`
        : `${shot.size} bytes · 视口 ${vp.innerWidth}x${vp.innerHeight}${vp.emulated ? '（emulated，已显式放行）' : ''}`,
    }
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
  // 按配置挂自动扫描（用户口径 2026-11-03：开关与间隔都可配）。关掉时不挂定时器、
  // 也不做启动扫描；打开时先扫一次，此后每 scanIntervalMs 扫一次。故意不 await ——
  // 扫描是跨进程 IO，装配不该等它。
  service.applyScanSchedule()
}

export { CdpError, redactUrl, disabledReason, readConfig, writeConfig, validateConfig, resolveConfigPath }
export { CDP_TARGETS_FILENAME, CDP_TARGETS_VERSION, MAIN_INSTANCE_PORT, CdpTargetsConfigError }
export { discover, inferRole, readPidRecords, probePort, listListeningPorts, readAppVersion, defaultHomes, suggestId, resolveEndpointIdentity } from './discover.ts'
export type { EndpointIdentity } from './discover.ts'
export type { DiscoveredTarget, DiscoverResult, DiscoverOptions, InstanceRole } from './discover.ts'
export type { CdpTarget, CdpTargetsConfig, RemoteRpcResult, RpcShape }
export { buildRpcExpression, wrapArgs, normalizeResult, callRpc, callRpcOnSession, readRemoteIdentity } from './remote-rpc.ts'
export { listPages, connectSession, evaluateOnPort, click, insertText, pressKey, captureScreenshot, resize, readViewport, buildFinder } from './cdp-client.ts'
export type { CdpSession, CdpPage, CdpParams, Evidence, ConsoleEntry, NetworkEntry, NetworkFailure, ClickResult, InsertTextResult, ScreenshotResult, ResizeOptions, ConnectOptions, ViewportInfo } from './cdp-client.ts'
