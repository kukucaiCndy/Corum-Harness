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
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// 只取类型：这个 import 同时把 `declare module '@deepseek-ai/cordis'` 的增强带进来
// （`ctx.settings` 的类型就是这么来的；不 import 它 TS 会报 Property 'settings' does not exist）。
// rc3（0.2.1-rc.3）适配：`SettingsForms.register()` 已删除，settings 命名空间改由
// 插件 Config（volatile 字段）自动发现 —— 详见下方 `Config` 与 `readStoredScan()`。
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineAgentTool, registerAgentTool, type ToolDefinition } from '@corum/plugin-sdk'

import {
  CdpError,
  VIEWPORT_NOT_RESTORED,
  click,
  connectSession,
  captureScreenshot,
  contextMenu,
  describeViewport,
  drag,
  ensureRealViewport,
  reloadPageAndWait,
  hover,
  insertText,
  listPages,
  pressKey,
  readViewport,
  redactUrl,
  resize,
  type CdpPage,
  type CdpSession,
  type Point,
  type ViewportInfo,
} from './cdp-client.ts'
import { discover, probePort, type DiscoveredTarget, type DiscoverResult } from './discover.ts'
import {
  SCAN_INTERVAL_MAX_MS,
  SCAN_INTERVAL_MIN_MS,
  SCAN_SETTINGS_DEFAULT,
  SCAN_SETTINGS_NAMESPACE,
  normalizeScanSettings,
  resolveScanSchedule,
  type ScanSettings,
} from './scan-settings.ts'
import { callRpcOnSession, readRemoteIdentity, wrapArgs, type RemoteRpcResult, type RpcShape } from './remote-rpc.ts'
import {
  CDP_TARGETS_FILENAME,
  CDP_TARGETS_VERSION,
  CdpTargetsConfigError,
  MAIN_INSTANCE_PORT,
  disabledReason,
  readConfig,
  readLegacyScanInterval,
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
 * 只 inject `tools` / `settings` —— 见模块头注释。
 *
 * ⚠️ 漏声明会在 `ctx.tools` 上抛 `cannot get property "tools" without inject`
 * （本仓已付学费）；`settings` 同理（构造函数里要访问 `ctx.settings`，见下方
 * `settingsForms` 的注释）。
 *
 * ## `settings` 为什么必须在这里声明（2026-11-03 实测崩溃）
 *
 * 第一版写成 `(ctx as unknown as { settings?: ... }).settings` —— 只是绕过**类型检查**，
 * cordis 运行时仍会拦：`cannot get property "settings" without inject` ⇒ 该 loader
 * entry apply 失败 ⇒ **整个插件树起不来**（宿主在启动动画就退出，code 1）。
 *
 * 所以它必须在模块级 inject 里声明（红线 4：不要用 ctx.get 摸未装配的服务）。
 * 代价是「缺 settings 的宿主上本插件不挂载」—— 这比「静默不挂」好：本仓的历史教训是
 * 静默少一批能力比硬失败更难查（见 `docs/LESSONS.md` §4.51）。
 */
export const inject = ['tools', 'settings']

/**
 * settings 命名空间 `corum-cdp-router` 的 **rc3 Config 声明**。
 *
 * 0.1.5 线（main 上的原实现）用 `ctx.settings.register(ns, schema, { base })` 拿
 * scope；rc3 的 `SettingsForms` 已删除 `register()` —— 命名空间由插件 Config
 * （volatile 字段）声明后经 `settings.describe()` 自动发现，**settings ns =
 * entry id**（cordis.patch.yml 的 insert 行 id `corum-cdp-router`）。读写 =
 * `ctx.settings.update(ns, patch)` / `describe()`（与 corum-web-search /
 * corum-memory 的 rc3 迁移同款，见 `docs/` 各自的 rc3 迁移注释）。
 *
 * `scan` 字段故意 `.default(undefined)`：保持「用户没写过 = 未设置」的语义，
 * `scanSettings()` 的旧配置迁移兜底（`readLegacyScanInterval`）才能生效——
 * 若 schema 给了非 undefined 的缺省，describe 恒回填一个值，迁移路径就被短路了。
 */
export interface Config {
  scan: Volatile<ScanSettings | undefined>
}

export const Config = z.object({
  scan: z.object({
    autoScan: z.boolean().default(SCAN_SETTINGS_DEFAULT.autoScan),
    scanIntervalMs: z.number().default(SCAN_SETTINGS_DEFAULT.scanIntervalMs),
  }).default(undefined as unknown as ScanSettings).volatile(),
})

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
  /**
   * 动作。
   *
   * **真实输入步**：`click` / `key` / `type` / `hover` / `contextmenu` / `drag`
   * ——全部走 CDP `Input.*` 域派发**真实**事件（`isTrusted:true`）；
   * 判据/证据步：`assert` / `eval` / `wait` / `resize` / `screenshot`。
   */
  readonly action:
    | 'click' | 'type' | 'key' | 'wait' | 'eval' | 'resize' | 'screenshot' | 'assert'
    | 'hover' | 'contextmenu' | 'drag'
  /** 可选标签，出现在结果的 label 字段里。 */
  readonly label?: string
  // click / hover / contextmenu / drag（源）
  readonly selector?: string
  readonly clickJs?: boolean | string
  /**
   * `drag` 的终点：元素选择器（与 `to` 二选一）。元素必须可见。
   *
   * 与 `selector` 一起表达「把 selector 拖到 toSelector 上」——这是拖拽排序/移动
   * 这类用例的最小输入面。
   */
  readonly toSelector?: string
  /** `drag` 的终点：显式视口坐标（与 `toSelector` 二选一，只校验有限数字）。 */
  readonly to?: Point
  /** `drag` 的中间 `mouseMoved` 步数（默认 4，最少 1）。 */
  readonly dragMoves?: number
  /**
   * `drag` 是否补发**原生 HTML5 拖放**事件（默认 `true`）。
   *
   * 置 `false` 只在一种场合有意义：页面里自己实现了指针驱动的拖放，且对多余的
   * `dragEnter/dragOver/drop` 会做出错误反应。源元素不是 `draggable` 时该字段无效果
   * （本来就没有原生拖放可补）。
   */
  readonly dragNative?: boolean
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
  /**
   * **只对本步**放行 failFast（默认 false，即失败即停）。
   *
   * 仅用于「证据步骤」——截图/诊断这类失败不该让后续断言不跑，但**绝不能**全局
   * `failFast: false`：那会把真正的行为失败一路放过去，把红报告成绿（T7）。
   *
   * 语义边界：
   * - 该步失败仍然 `ok: false`，顶层 `ok` 仍为 `false`（失败不会被掩盖）；
   * - 只是**不 break**，后续步骤照常执行并各自记录结果；
   * - 只有调用方在**该步**显式写 `nonBlocking: true` 才生效。
   */
  readonly nonBlocking?: boolean
  /**
   * **条件步**（只允许真实输入步：`click` / `key` / `hover` / `contextmenu` / `drag`，
   * 2026-11-07）：执行前先在目标页里求值这段表达式
   * （`Runtime.evaluate`，`awaitPromise: true` + `returnByValue: true`），按真值归一
   * （`Boolean(...)`，非布尔值不报错）。
   *
   * 语义：
   * - truthy ⇒ 本步照旧派发**真实 Input**（`Input.dispatchMouseEvent` /
   *   `Input.dispatchKeyEvent`），结果与无条件步一致；
   * - falsy ⇒ **跳过**本步：本步 `ok: true`，但没有派发任何 Input，`observed` 与
   *   `skipped` 里留 `{ skipped: true, reason: 'when-false' }` 证据（跳步不是失败，
   *   也不是「跑过了」）；
   * - 表达式**抛错 / 求值超时** ⇒ 本步 `ok: false`（fail closed）：读不到前置条件时
   *   既不能假装跳过、也不能硬点下去。
   *
   * 为什么别的 action 不接受 `when`：条件能跳过判据步，就等于可以把 assert/eval/type
   * 静默掏空，一份「全绿」报告可能一条真实行为都没验证。写错位置直接报
   * `run-script/when-unsupported`（不静默忽略 —— 忽略同样等于没写）。
   */
  readonly when?: string
}

/** `when` 为假而跳过本步的证据（**不是失败**：该步没有派发任何真实 Input）。 */
export interface StepSkipEvidence {
  readonly skipped: true
  readonly reason: 'when-false'
  /** 求值为假的 `when` 表达式原文（回放/定位用）。 */
  readonly when: string
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
  /**
   * 该步失败但被 `nonBlocking: true` 显式放行（仅为诊断可见性而回显，T7）。
   * 出现本字段**不改变** `ok: false` 的事实，也不改变顶层 `ok`。
   */
  readonly nonBlocking?: boolean
  /**
   * 该步被 `when` 条件判为假而**跳过**（此时 `ok: true`）。
   *
   * 与 `nonBlocking` 的区别：那是「失败了但放行」，这是「前置条件不成立，本来就不该做」。
   * 出现本字段意味着**没有派发任何真实 Input**，所以既不能读成「跑过了」，也不能读成失败。
   */
  readonly skipped?: StepSkipEvidence
}

/** runScript 的结果。 */
export interface RunScriptOutput {
  readonly ok: boolean
  readonly targetId: string
  /**
   * **本次实际执行所在页面的 URL**（已脱敏，不含 token）。
   *
   * 为什么必须由 router 给（2026-11-07 裁决 5）：脚本跑在哪个窗口/页面，调用方事后无法
   * 从别处知道 —— 多窗口目标上「浮窗还是主窗」直接决定证据指向对不对。旧实现只能靠
   * 「再 evaluate 一次默认页」猜，那与真相不是一个东西。
   *
   * 建连失败 / 目标不存在时为 `null`（`error` 说明原因）；只要能建连就一定有值。
   */
  readonly pageUrl: string | null
  readonly results: readonly StepResult[]
  /**
   * **本次窗口**的 console 增量（屏障之后）。
   * `preExisting` 是 `Runtime.enable`/`Log.enable` 回放出来的存量条目数，不计入
   * `count`/`errors`；`windowStartMs` 是屏障时刻（epoch 毫秒），没有则为 `null`。
   * 旧 CTS 只读 `count`/`errors`，语义未变（只是不再把历史错误算进本次）。
   */
  readonly console: {
    readonly count: number
    readonly errors: readonly string[]
    readonly preExisting: number
    readonly windowStartMs: number | null
  }
  readonly network: { readonly count: number; readonly failed: readonly { url: string; errorText: string; canceled: boolean; blockedReason?: string }[] }
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
   * `geometry` 三态见 {@link ViewportInfo}（`unmeasurable` 时**不可**当真实证据）。
   */
  readonly viewport?: ViewportInfo
  /**
   * 本次会话里的 Emulation override 是否已复原（T1）。
   * - `true` —— 走过 override，clear 成功**且复核视口不再是 emulated**；
   * - `false` —— 走过 override，但 clear 抛错**或复核仍 emulated**（视口被钉住，
   *   该实例后续截图不可当真实证据，需重载页面或重启目标实例）；
   * - 字段缺省 —— 本次没动过视口，无需复原。
   */
  readonly viewportRestored?: boolean
  /** 复原失败的原因（仅当 `viewportRestored === false` 时给出）。 */
  readonly clearError?: string
  /**
   * 本案例**开始**时发现并自愈了残留 override（上一个案例/会话留下的假视口）。
   *
   * 只有「开局测量是 emulated、clear 后复测恢复真实」才为 `true`；自愈失败不会走到
   * 这里 —— 那是 fail-closed 的 `cdp/viewport-not-restored`（见 {@link RunScriptOutput.error}）。
   */
  readonly viewportSelfHealed?: boolean
  /** 失败时的错误码（整体失败）。 */
  readonly error?: { code: string; message: string }
}

/** 一次服务实例的状态（不跨实例共享；随 ctx.effect 清理）。 */
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
 * rc3 `SettingsForms` 上本插件用到的面（窄化，红线 3：不耦合实现包的完整类型面）。
 *
 * 读 = `describe()` 找 ns（`SettingsDescriptor` 只取 ns/value 两字段）；写 =
 * `update(ns, patch)`。旧线的 `register()/scope.get()/scope.update()` 三件套
 * 在 rc3 已整体删除（见上方 `Config` 注释）。
 */
interface SettingsFormsFace {
  describe(options?: unknown): readonly SettingsDescriptor[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
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

  /**
   * settings 面（rc3 `SettingsForms`，ns `corum-cdp-router`）。
   *
   * `settings` 已在模块级 `inject` 里声明，所以构造时**一定**装配好（不声明会被
   * cordis 运行时拦下，整个插件树起不来——见 inject 注释）。ns 本身由模块级
   * `Config` 声明自动进 describe，无需运行期注册。
   */
  private readonly settingsForms: SettingsFormsFace

  constructor(ctx: Context) {
    super(ctx, 'cdpRouter')
    this.settingsForms = ctx.settings as SettingsFormsFace
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
   * @param options.settings - 扫描设置（不传则现读 settings 命名空间）
   * @param options.timer - 定时器工厂（默认 `setInterval`）
   * @param options.clear - 定时器清理（默认 `clearInterval`）
   * @returns 生效的间隔（毫秒）；关闭时为 null
   */
  applyScanSchedule(options: {
    settings?: ScanSettings
    timer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
    clear?: (handle: ReturnType<typeof setInterval>) => void
  } = {}): number | null {
    const clear = options.clear ?? clearInterval
    this.stopScanTimer(clear)

    const plan = resolveScanSchedule(options.settings ?? this.scanSettings())
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
   * 从 settings 面读已存的扫描设置段（raw，未规范化）。
   *
   * rc3 适配：旧线是 `settingsScope.get()`；rc3 改为 `describe()` 找 ns 直读。
   * ns 不在 describe（用户从未写过、且 Config 声明尚未被 configEditor 收录）或
   * describe 抛错时返回 `undefined`，让 `scanSettings()` 走默认/迁移兜底 ——
   * 一个 UI 偏好读取失败不该放大成 CDP 主能力故障。
   *
   * @returns 已存的段（可为空对象）；ns 未注册或读取失败时 undefined
   */
  private readStoredScan(): { scan?: unknown } | undefined {
    try {
      const found = this.settingsForms.describe().find(d => d.ns === SCAN_SETTINGS_NAMESPACE)
      if (found === undefined) return undefined
      return (found.value ?? {}) as { scan?: unknown }
    } catch {
      return undefined
    }
  }

  /**
   * 读当前扫描设置（settings 命名空间 → 规范化后的值）。
   *
   * 迁移兜底：若 settings 里还没写过、而旧配置文件里留有 `scanIntervalMs`，
   * 用那个值作为初始间隔 —— 升级用户的设置不至于悄悄丢回默认。
   *
   * @returns 规范化后的扫描设置
   */
  private scanSettings(): ScanSettings {
    const stored: { scan?: unknown } | undefined = this.readStoredScan()
    if (stored?.scan !== undefined) return normalizeScanSettings(stored.scan)
    const legacy = readLegacyScanInterval(resolveConfigPath())
    return legacy === undefined
      ? SCAN_SETTINGS_DEFAULT
      : normalizeScanSettings({ ...SCAN_SETTINGS_DEFAULT, scanIntervalMs: legacy })
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
    const current = this.scanSettings()
    return {
      autoDiscover: current.autoScan,
      scanIntervalMs: current.scanIntervalMs,
      activeIntervalMs: this.state.activeIntervalMs,
      timerActive: this.state.timer !== null,
      minIntervalMs: SCAN_INTERVAL_MIN_MS,
      maxIntervalMs: SCAN_INTERVAL_MAX_MS,
      defaultIntervalMs: SCAN_SETTINGS_DEFAULT.scanIntervalMs,
      lastScanAt: this.state.scannedAt,
    }
  }

  /**
   * 改自动扫描设置（开关 / 间隔），写 settings 后**立刻重挂定时器**。
   *
   * ## 为什么写 settings 而不写 `cdp-targets.json`
   *
   * 后者是跨版本共享的「测哪个实例」事实源，而旧版对它的未知顶层键是 fail loud 的
   * —— 把一个纯 UI 偏好写进去，会让换回旧版的实例整份配置作废（实测事故，
   * 详见 `scan-settings.ts` 模块头）。settings 天生容忍未知键，是这类偏好的正确归属。
   *
   * @param input - `{ autoDiscover?: boolean, scanIntervalMs?: number }`（都可选）
   * @returns 写完后的设置视图
   * @throws 间隔超出允许区间或不是整数
   */
  @Remote('setScanSettings')
  async setScanSettingsRemote(input: Record<string, unknown> | undefined): Promise<ScanSettingsView> {
    const current = this.scanSettings()
    const autoScan = typeof input?.autoDiscover === 'boolean' ? input.autoDiscover : current.autoScan
    let scanIntervalMs = current.scanIntervalMs
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

    const next: ScanSettings = { autoScan, scanIntervalMs }
    // ⚠️ 必须 await：`update` 落地后才写进 profile patch，而下面的返回值走
    // `scanSettingsRemote()` 重新**从文档读**。不 await 会读到旧值 ⇒ 接口回报的
    // 是上一次的设置（实测踩到：传 autoDiscover:true + 300000，回来却是
    // false + 60000），调用方（设置页）会显示成「没保存成功」。
    // （rc3 适配：旧线是 `settingsScope.update({ scan: next })`；rc3 的
    // `SettingsForms.update(ns, patch)` 落 profile patch，写路径同理必须 await。）
    await this.settingsForms.update(SCAN_SETTINGS_NAMESPACE, { scan: next })
    // 立刻按新设置重挂（关掉会撤定时器；打开会先扫一次）。
    this.applyScanSchedule({ settings: next })
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
   * **单步放行（T7）**：`failFast: true` 下仍可用该步自己的 `nonBlocking: true` 让
   * **这一步**失败不中断后续（典型：截图/证据步失败后还要跑断言）。它只放行本步、
   * 不改全局 —— 该步仍 `ok: false`、顶层仍 `ok: false`。
   *
   * ## 证据窗口（T3）
   *
   * `Runtime.enable` / `Log.enable` 会**回放**目标页的历史 console。本方法在 enable
   * 之后立刻打屏障（`evidence.markStart()`），屏障前的条目只计 `console.preExisting`，
   * 屏障后的才算本次的 `count`/`errors`。不用 `Log.clear`（那会清掉目标实例真实的
   * 日志缓冲，副作用外泄）。
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
   * ## 条件步（`when`，只给真实输入步 click/key/hover/contextmenu/drag）
   *
   * 每步执行**前**在目标页求值 `when`（`awaitPromise` + 真值归一）：
   * truthy 才派发原真实 Input；falsy 直接 `ok: true` + `{skipped:true,reason:'when-false'}`
   * 证据（**不发任何 Input**）；表达式抛错/超时本步 `ok: false`。
   * assert/eval/type/... 上写 `when` 一律报 `run-script/when-unsupported`。
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
        pageUrl: null,
        results: [],
        console: { count: 0, errors: [], preExisting: 0, windowStartMs: null },
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
        pageUrl: null,
        results: [],
        console: { count: 0, errors: [], preExisting: 0, windowStartMs: null },
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
        pageUrl: null,
        results: [],
        console: { count: 0, errors: [], preExisting: 0, windowStartMs: null },
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
    // 屏障（T3）：enable 会回放目标页的历史 console —— 屏障之前的一律只计
    // `console.preExisting`，不进本次的 count/errors。刻意**不用** `Log.clear`：
    // 那会清掉目标实例真实的日志缓冲（副作用外泄到被观测端）。
    session.evidence.markStart()

    let identity: RunScriptOutput['identity'] = null
    try {
      identity = await readRemoteIdentity(session)
    } catch {
      // 身份读取失败不致命
    }

    // ── 开局视口预检 + 残留 override 自愈（2026-11-07 事故：305 张假视口截图）──
    //
    // 事故链路：A3 的 resize 留下的 override 没复原 ⇒ 从 A4 起每个案例测到的视口都是
    // emulated ⇒ 截图守卫全判失败 ⇒ 305 张截图「丢失」，而批次还继续往下跑。
    //
    // 这里在**任何步骤之前**复核一次：残留就 best-effort clear + 复测；清不掉就
    // fail-closed（具名 `cdp/viewport-not-restored`，一个步骤都不执行）—— 绝不允许
    // 继续 click/assert/screenshot 假装带路完成。测量不到（unmeasurable）不算残留，
    // 不拦截（无头/隐藏窗口量不到 outer），交给截图守卫按 unverified 处理。
    let viewportSelfHealed: boolean | undefined
    let startupRestore: { viewport: ViewportInfo; cleared: boolean; restored: boolean } | undefined
    let viewportReload: { reloaded: boolean; waitedMs: number } | undefined
    try {
      startupRestore = await ensureRealViewport(session)
      /**
       * 清不掉就先**重载页面**再复核一次（2026-11-07 rc3 实机）。
       *
       * 实测：一条 resize 用例把页面留在 1219x427 之后，同一轮后续每条用例都在开局
       * fail-closed —— 装置把「上一案留下的残留」判成「本案环境不可用」，一次全量 run
       * 被一条用例整死。`Page.reload()` 能把它拉回真实窗口（实测 1280x860），所以先救；
       * 救不回来才 fail-closed（判据仍是实测，不是 reload 的应答）。
       */
      if (startupRestore !== undefined && !startupRestore.restored) {
        const reload = await reloadPageAndWait(session)
        const after = await ensureRealViewport(session)
        if (after.restored) {
          startupRestore = after
          viewportSelfHealed = true
        } else {
          startupRestore = after
          viewportReload = reload
        }
      }
    } catch {
      // 读不到视口不致命（等同 unmeasurable）：截图守卫会标注 unverified。
      startupRestore = undefined
    }
    if (startupRestore !== undefined && !startupRestore.restored) {
      const detail = `开局复核视口仍非真实（实测 ${describeViewport(startupRestore.viewport)}）`
        + (viewportReload === undefined
          ? ''
          : `；已尝试重载页面（${viewportReload.reloaded ? '已执行' : '未执行'}，耗时 ${viewportReload.waitedMs}ms）仍不真实`)
      // 复原尝试的结果要如实回传（CTS 证据读 clearError/viewportRestored）。
      const failOut: RunScriptOutput = {
        ok: false,
        targetId,
        // 已经建连：如实回传实际所在页（fail-closed 也要能回答「是在哪一页发现视口坏了」）
        pageUrl: session.pageUrl,
        results: [],
        console: session.evidence.summary().console,
        network: session.evidence.summary().network,
        screenshots: [],
        identity,
        viewport: startupRestore.viewport,
        viewportRestored: false,
        clearError: `${VIEWPORT_NOT_RESTORED}: ${detail}；`
          + 'Emulation.clearDeviceMetricsOverride 是该会话的 no-op（override 按 CDP 会话持有，'
          + '前一会话残留的层新会话清不掉），重载页面也没能拉回真实窗口，'
          + '需重启目标实例后再跑。',
        durationMs: Date.now() - start,
        error: {
          code: VIEWPORT_NOT_RESTORED,
          message: `${detail}；开局即视口不真实，本案例不执行任何步骤（fail-closed），`
            + '需重载该页面或重启目标实例。',
        },
      }
      session.close()
      return failOut
    }
    if (startupRestore !== undefined && startupRestore.cleared && startupRestore.restored) {
      // 只有**复核实测到真实几何**才算自愈成功；unmeasurable 只是「没证据说被覆盖」，
      // 不能写成 selfHealed（那是把「量不出来」冒充成「修好了」）。
      if (startupRestore.viewport.geometry === 'real') viewportSelfHealed = true
    }

    const results: StepResult[] = []
    const screenshots: { name: string; base64: string; size: number }[] = []
    let hadFailure = false
    // 2026-11-02 事故修复：resize（非 reset）会留下 Emulation override，用完必须 clear。
    // 「靠调用方自觉 reset」不可靠（clear 后视口也不一定立即恢复），所以作用域收在
    // runScript 自己手里：本次跑过非 reset 的 resize，finally 里强制 clear。
    //
    // T1 收紧：置位时机从「runStep 成功返回」提前到「**进入 set 之前**」。CDP 命令
    // 抛错不代表 override 没生效（命令可能已下发、只是应答丢了），所以只要试图 set
    // 过，finally 就必须尝试 clear。只有 reset **成功**才清标志。
    let overrideMaybe = false
    // 会话结束时的视口实测值（读失败则省略）。
    let viewport: ViewportInfo | undefined
    // finally 的复原结果（T1）：走过 override 才有值；clear 失败如实回传，不只用
    // console.error 说一下就算完。
    let viewportRestored: boolean | undefined
    let clearError: string | undefined

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!
        const label = step.label ?? `${step.action}#${i}`
        const stepStart = Date.now()

        // 整体超时检查（超时不受 nonBlocking 放行：预算已耗尽，继续跑只会再超时）
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

        const isSetResize = step.action === 'resize'
          && step.resize !== undefined
          && !('reset' in step.resize && step.resize.reset === true)
        const isResetResize = step.action === 'resize'
          && step.resize !== undefined
          && 'reset' in step.resize && step.resize.reset === true

        try {
          // set 之前就记「可能已覆盖」（见 overrideMaybe 的注释）。
          if (isSetResize) overrideMaybe = true
          const result = await runStep(session, step, i, screenshots, { overrideActive: overrideMaybe })
          // 只有 reset **成功**才清标志；失败（或抛错走到 catch）仍保持 true。
          if (isResetResize && result.ok) overrideMaybe = false
          const blocked = step.nonBlocking === true
          results.push(blocked && !result.ok ? { ...result, nonBlocking: true } : result)
          if (!result.ok) {
            hadFailure = true
            if (failFast && !blocked) break
          }
        } catch (error: unknown) {
          const errMsg = error instanceof CdpError
            ? `${error.code}: ${error.message}`
            : error instanceof Error ? error.message : String(error)
          const blocked = step.nonBlocking === true
          results.push({
            index: i,
            action: step.action,
            label,
            ok: false,
            error: errMsg,
            ...(blocked ? { nonBlocking: true } : {}),
          })
          hadFailure = true
          if (failFast && !blocked) break
        }

        // 避免单步卡死（0 超时保护：stepStart 只用于诊断，不实际限制）
        void stepStart
      }
    } finally {
      // 作用域收尾：先 clear override（只要**试过** set 就清），再**复核**是否真的复原
      // （2026-11-07：clear 的应答不代表复原 —— 见 cdp-client 里 resize/ensureRealViewport
      // 的实机注释），最后关会话。中途抛错也走到这里。
      /** 收尾复核实测到的视口（成功时直接当 viewport 用，省一次读取）。 */
      let restoredViewport: ViewportInfo | undefined
      if (overrideMaybe) {
        try {
          const outcome = await ensureRealViewport(session, { force: true })
          restoredViewport = outcome.viewport
          if (outcome.restored) {
            overrideMaybe = false
            // **只有测量到真实几何**才声称`viewportRestored: true`。outer 量不出来
            //（无头/隐藏窗口）时判 unmeasurable —— 那是「没法证明」，不是「已复原」，
            // 如实留空（字段缺省 = 未验证），不伪写 true。
            if (outcome.viewport.geometry === 'real') viewportRestored = true
          } else {
            // clear 命令成功但视口仍是 emulated：如实报失败，不能写 viewportRestored=true。
            viewportRestored = false
            clearError = `${VIEWPORT_NOT_RESTORED}: clear 已下发但复核仍非真实`
              + `（实测 ${describeViewport(outcome.viewport)}）；`
              + 'override 按 CDP 会话持有，需重载该页面或重启目标实例。'
            console.error('[cdp-router] 视口未能复原：'
              + `实测 ${describeViewport(outcome.viewport)}`
              + '——目标实例后续截图不可作为真实窗口证据，需重载页面或重启该实例。')
          }
        } catch (clearErr: unknown) {
          viewportRestored = false
          clearError = clearErr instanceof Error ? clearErr.message : String(clearErr)
          // 仍然大声 log（人有可能会看日志），但**结果里也如实回传**（T1：不能只靠日志）。
          console.error('[cdp-router] Emulation.clearDeviceMetricsOverride 失败：'
            + '目标实例视口可能仍被覆盖，需重启该实例。'
            + `原因：${clearError}`)
        }
      }
      // 视口实测：读失败不致命（省略字段），但这正是「不能假装知道视口是什么」的降级。
      // clear 失败时 overrideActive 仍为 true ⇒ 视图判 emulated（不把残留覆盖说成真实）。
      if (restoredViewport !== undefined) {
        viewport = restoredViewport
      } else {
        try {
          viewport = await readViewport(session, { overrideActive: overrideMaybe })
        } catch {
          // 省略 viewport 字段
        }
      }
      session.close()
    }

    const evSummary = session.evidence.summary()

    return {
      ok: !hadFailure,
      targetId,
      pageUrl: session.pageUrl,
      results,
      console: evSummary.console,
      network: evSummary.network,
      screenshots,
      identity,
      ...(viewport !== undefined ? { viewport } : {}),
      ...(viewportRestored !== undefined ? { viewportRestored } : {}),
      ...(clearError !== undefined ? { clearError } : {}),
      ...(viewportSelfHealed !== undefined ? { viewportSelfHealed } : {}),
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
      // 扫描间隔已搬到 settings 命名空间（见 scan-settings.ts），这里不再携带；
      // 写回配置时也不产生该键 —— 否则旧版读到未知键会作废整份配置。
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
      // 描述里只写**已知**的身份。`releaseVersion` 是 corum 特有字段（读目标页面的
      // `__DSH_BOOT__.release`），本地/开发构建读不到；此时写「基座版本未知」会把
      // 「我给不出这个信息」变成一句像故障的噪声，也会让同一批自动采纳的条目
      // 描述里混进 corum 专有词汇（通用调试端口根本不谈基座）。
      const version = found.releaseVersion === null ? '' : ` · 基座 ${found.releaseVersion}`
      merged.set(found.id, {
        id: found.id,
        ip: '127.0.0.1',
        port: found.port,
        readOnly: false,
        ...(found.role === 'main' ? { allowMain: false } : {}),
        description: `自动发现 · ${label}${version}${found.releaseCommit === null ? '' : `@${found.releaseCommit}`}`,
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

/** 步骤执行上下文（来自 runScript 的作用域状态）。 */
export interface StepContext {
  /**
   * 会话里**已知**设过 `Emulation.setDeviceMetricsOverride` 且尚未复原（T1）。
   * 置 true 时截图前无需测量即可判 `emulated` —— 比测量更可靠（override 生效中
   * inner/outer 可能恰好相等，测量会把它误判成真实窗口）。
   */
  readonly overrideActive?: boolean
}

/**
 * 截图前的视口读取（**不抛**）：读不出返回 undefined。
 *
 * 为什么吞异常：校验装置自身故障不该吞掉证据。但调用方必须把 undefined 当作
 * 「未校验」而非「真实」—— 见 {@link describeScreenshotEvidence}。
 *
 * @param session - 已连上的会话
 * @param context - 步骤上下文（`overrideActive`）
 * @returns 视口，或 undefined（读不出）
 */
async function readViewportForEvidence(
  session: CdpSession,
  context: StepContext,
): Promise<ViewportInfo | undefined> {
  try {
    return await readViewport(session, { overrideActive: context.overrideActive === true })
  } catch {
    return undefined
  }
}

/**
 * 依视口判定生成**证据可信度自述**：截图名后缀 + observed 文本。
 *
 * 三态（T1）：
 * - `real` → 名字不加后缀，可作为真实窗口证据；
 * - `emulated` → `-emulated` 后缀（调用方已显式放行模拟视口）；
 * - `unmeasurable` / 读不出 → `-unverified` 后缀，**不可**作为真实窗口证据。
 *
 * @param name - 调用方给的截图名
 * @param vp - 视口（undefined = 读不出）
 * @param size - 截图字节数（诊断用）
 * @returns 最终名字 + observed 文本
 */
export function describeScreenshotEvidence(
  name: string,
  vp: ViewportInfo | undefined,
  size: number,
): { finalName: string; observed: string } {
  if (vp === undefined) {
    return {
      finalName: `${name}-unverified`,
      observed: `${size} bytes · 视口读取失败（未校验真实性；**不可作为真实窗口证据**）`,
    }
  }
  if (vp.geometry === 'emulated') {
    return {
      finalName: `${name}-emulated`,
      observed: `${size} bytes · 视口 ${vp.innerWidth}x${vp.innerHeight}（emulated，已显式放行）`,
    }
  }
  if (vp.geometry === 'unmeasurable') {
    return {
      finalName: `${name}-unverified`,
      observed: `${size} bytes · 视口不可测量（outer=${vp.outerWidth}x${vp.outerHeight}，无头/隐藏窗口；`
        + '**不可作为真实窗口证据**）',
    }
  }
  return {
    finalName: name,
    observed: `${size} bytes · 视口 ${vp.innerWidth}x${vp.innerHeight}`,
  }
}

/**
 * 接受 `when` 的 action 白名单。
 *
 * **只有真实输入步**（click/key/hover/contextmenu/drag）能带条件：判据步
 * （assert/eval/type/wait/resize/screenshot）一旦能被条件跳过，全绿报告就可能
 * 一条真实行为都没验证。
 */
const WHEN_ACTIONS: readonly string[] = ['click', 'key', 'hover', 'contextmenu', 'drag']

/** 已知 action 列表（只用于「when 写在不接受的 action 上」时的措辞，未知 action 另有报错）。 */
const KNOWN_ACTIONS: readonly string[] = [
  'click', 'type', 'key', 'wait', 'eval', 'resize', 'screenshot', 'assert',
  'hover', 'contextmenu', 'drag',
]

/**
 * 在目标页里求值一段 `when` 表达式，把结果**归一成严格布尔**。
 *
 * 两处归一都必须有：
 *  - **页内** `Boolean(await (expr))`：DOM 节点/数组/数字不能直接 `returnByValue`（节点会
 *    序列化失败），也顺手支持 `await` / Promise / 返回 Promise 的表达式；
 *  - **宿主侧** `Boolean(value)`：保底防御（换执行器/假会话时不依赖页内包装）。
 *
 * 抛错与超时**不在这里吞**：调用方（runStep）必须把它折成 `ok: false`，
 * 读不到前置条件时既不能假装跳过、也不能硬点下去。
 *
 * @param session - 已连上的会话
 * @param when - `when` 表达式原文
 * @returns 归一后的真值
 */
export async function evaluateWhen(session: CdpSession, when: string): Promise<boolean> {
  const value = await session.evaluate(`(async () => Boolean(await (${when})))()`)
  return Boolean(value)
}

/**
 * 把一点坐标格式化成 `x,y`（整数化，避免 0.30000000000000004 这类噪声进证据）。
 *
 * @param point - 视口坐标
 * @returns `x,y` 文本
 */
function formatPoint(point: Point): string {
  return `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`
}

/**
 * 真实输入原语（hover / contextmenu / drag）的 observed 证据：目标几何 + 派发坐标。
 *
 * 为什么要写几何而不只写坐标：坐标是**派发出去**的，尺寸/位置是**读回来**的。
 * 只有坐标时，「元素只有 0 高、事件落在边缘」和「元素正常」在报告里长得一样。
 *
 * 不读元素文本/value 等敏感内容：证据需要的是「打到了哪个位置、多大」，不是页面里写了什么。
 *
 * @param result - 原语结果（可能没有坐标）
 * @returns observed 文本
 */
function describePointerEvidence(result: {
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
}): string {
  const at = result.x === undefined || result.y === undefined
    ? '坐标未回传'
    : formatPoint({ x: result.x, y: result.y })
  const size = result.width === undefined || result.height === undefined
    ? '尺寸未知'
    : `${Math.round(result.width)}x${Math.round(result.height)}`
  return `${at} · 元素 ${size}`
}

/**
 * 执行单个 step，返回结构化结果。
 *
 * 导出供测试直接驱动（假 CdpSession 驱动 steps）。
 *
 * ## 条件步（`when`，仅真实输入步 click/key/hover/contextmenu/drag）
 *
 * 见 {@link ScriptStep.when}：truthy 才派发原真实 Input；falsy 返回 `ok: true` +
 * `{ skipped: true, reason: 'when-false' }` 证据且**不发任何 Input**；求值抛错/超时
 * 本步 `ok: false`。
 *
 * @param session - 已连上的会话（证据域已 enable）
 * @param step - 步骤定义
 * @param index - 步骤序号（用于截图命名）
 * @param screenshots - 截图累积数组（screenshot 步骤往里推）
 * @param context - 视口上下文（`overrideActive`），缺省视为无 override
 * @returns 步骤结果
 */
export async function runStep(
  session: CdpSession,
  step: ScriptStep,
  index: number,
  screenshots: { name: string; base64: string; size: number }[],
  context: StepContext = {},
): Promise<StepResult> {
  const label = step.label ?? `${step.action}#${index}`

  if (step.when !== undefined) {
    // ① 只有真实输入步（WHEN_ACTIONS = click/key/hover/contextmenu/drag）接受 when；
    //    写错位置**报错**而不是忽略（忽略等于没写）。
    if (!WHEN_ACTIONS.includes(step.action) && KNOWN_ACTIONS.includes(step.action)) {
      return {
        index,
        action: step.action,
        label,
        ok: false,
        error: `run-script/when-unsupported: when 只允许真实输入步（click/key/hover/contextmenu/drag），${step.action} 不接受`
          + '（判据步必须实际执行，不能被条件跳过）',
      }
    }
    if (typeof step.when !== 'string' || step.when.trim() === '') {
      return { index, action: step.action, label, ok: false, error: 'run-script/when-empty: when 必须是非空表达式字符串' }
    }
    // ② 求值：抛错/超时 ⇒ fail closed（不是 skip）。
    let truthy: boolean
    try {
      truthy = await evaluateWhen(session, step.when)
    } catch (error: unknown) {
      const msg = error instanceof CdpError
        ? `${error.code}: ${error.message}`
        : error instanceof Error ? error.message : String(error)
      return {
        index,
        action: step.action,
        label,
        ok: false,
        error: `run-script/when-threw: when 求值失败（${msg}）—— 前置条件未知时既不跳过也不硬执行`,
      }
    }
    // ③ falsy ⇒ 跳过：ok:true（没失败），但证据里留 skip 标记，且不派发任何 Input。
    if (!truthy) {
      const skipped: StepSkipEvidence = { skipped: true, reason: 'when-false', when: step.when }
      return {
        index,
        action: step.action,
        label,
        ok: true,
        observed: JSON.stringify(skipped),
        skipped,
      }
    }
  }

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

    case 'hover': {
      const selector = step.selector ?? ''
      if (selector === '') {
        return { index, action: 'hover', label, ok: false, error: 'hover 需要 selector' }
      }
      const result = await hover(session, selector)
      return { index, action: 'hover', label, ok: true, observed: describePointerEvidence(result) }
    }

    case 'contextmenu': {
      const selector = step.selector ?? ''
      if (selector === '') {
        return { index, action: 'contextmenu', label, ok: false, error: 'contextmenu 需要 selector' }
      }
      const result = await contextMenu(session, selector)
      return { index, action: 'contextmenu', label, ok: true, observed: describePointerEvidence(result) }
    }

    case 'drag': {
      const selector = step.selector ?? ''
      if (selector === '') {
        return { index, action: 'drag', label, ok: false, error: 'drag 需要 selector（拖拽源）' }
      }
      if (step.toSelector === undefined && step.to === undefined) {
        return { index, action: 'drag', label, ok: false, error: 'drag 需要 toSelector 或 to{x,y}（终点）' }
      }
      const result = await drag(session, selector, {
        ...(step.toSelector === undefined ? {} : { toSelector: step.toSelector }),
        ...(step.to === undefined ? {} : { to: step.to }),
        ...(typeof step.dragMoves === 'number' ? { moves: step.dragMoves } : {}),
        ...(step.dragNative === undefined ? {} : { native: step.dragNative }),
      })
      const from = result.from ?? { x: result.x ?? 0, y: result.y ?? 0 }
      const to = result.to ?? from
      return {
        index,
        action: 'drag',
        label,
        ok: true,
        observed: `${describePointerEvidence(result)} 拖到 ${formatPoint(to)}（中间 ${result.moves ?? 0} 步 mouseMoved`
          + `${result.nativeDrag === true
            ? ' + 原生 dragEnter/dragOver/drop'
            : step.dragNative === false
              ? '；已按 dragNative:false 关闭原生 DnD'
              : '；源元素不是 draggable，未补发原生 DnD 事件'}）`,
      }
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
      // 读不出视口（evaluate 挂了等）或量不出窗口外框（outer<=0，无头/隐藏窗口）
      // 都**不拦截图** —— 不能因校验装置自身故障吞掉证据；但也不假装校验过：
      // 截图名带 `-unverified`、observed 如实标注，**不可作为真实窗口证据**（T1）。
      const vp = await readViewportForEvidence(session, context)
      if (vp?.geometry === 'emulated' && step.emulatedViewportOk !== true) {
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
      const { finalName, observed } = describeScreenshotEvidence(name, vp, shot.size)
      screenshots.push({ name: finalName, base64: shot.base64, size: shot.size })
      return {
        index,
        action: 'screenshot',
        label,
        ok: true,
        screenshot: finalName,
        observed,
      }
    }

    case 'assert': {
      return runAssertion(session, step, index, label, screenshots, context)
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
  context: StepContext = {},
): Promise<StepResult> {
  // screenshot assert（ui-verify 把 screenshot 归到 assert 里）
  if (step.screenshot !== undefined) {
    const name = step.screenshot
    // 与 screenshot action 同一套防护：假视口截图默认判 FAIL（2026-11-02 事故）。
    // 读不出视口不拦截图（校验装置自身故障不吞证据），observed 如实标注未校验，
    // 且截图名带 `-unverified`（T1：不可当真实窗口证据）。
    const vp = await readViewportForEvidence(session, context)
    if (vp?.geometry === 'emulated' && step.emulatedViewportOk !== true) {
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
    const { finalName, observed } = describeScreenshotEvidence(name, vp, shot.size)
    screenshots.push({ name: finalName, base64: shot.base64, size: shot.size })
    return {
      index,
      action: 'assert',
      label,
      ok: true,
      screenshot: finalName,
      observed,
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
      '在**指定目标实例**上执行一组 CDP 脚本步骤'
      + '（click/type/key/wait/eval/resize/screenshot/assert/hover/contextmenu/drag）。'
      + '一次连接顺序执行全部 steps，返回每步结果 + console/网络证据 + 截图 + 目标身份。'
      + 'assert 变体：exists/count/textContains/textEquals/style/js{expression,expect?}。'
      + '单步可用 `nonBlocking: true` 放行 failFast（仅证据步；该步仍 ok:false、顶层仍 ok:false）。'
      + '真实指针步：hover（只 mouseMoved，不按键）、contextmenu（真实右键 pressed/released）、'
      + 'drag（mouseMoved→mousePressed(left)→多步 mouseMoved→mouseReleased；终点用 toSelector 或 to{x,y}，'
      + '中间步数 dragMoves 默认 4）。源元素是 draggable 时额外补发原生 dragEnter/dragOver/drop'
      + '（实测：合成 mouse 事件在 Chromium 里起不了原生拖放，必须走 Input.dispatchDragEvent；'
      + 'observed 里写明是否补发，仍在「步骤 ok」之外自己断言拖后状态）。'
      + '三者都先做可见性/几何检查，不可见即 fail-closed，'
      + '绝不用页内合成事件。hover/contextmenu 留下的浮层与菜单**不会自动收口**：'
      + '下一步被遮罩挡住是真实行为，脚本要自己收（Escape / 点空白处 / 点菜单项）。'
      + 'click/key/hover/contextmenu/drag 可带 `when` 表达式（页面内求值，truthy 才真发 Input；'
      + 'falsy 本步 ok:true 但记 skipped，不发 Input；求值抛错本步 fail）；'
      + 'assert/eval/type 不接受 when。'
      + '截图只传 base64+name（由调用方决定落盘）。',
    parameters: {
      targetId: { type: 'string', description: '目标 id' },
      pageUrlIncludes: { type: 'string', description: '页面 URL 子串匹配（如 floating=someSlot），用于多窗口/浮窗分流' },
      stepsJson: {
        type: 'string',
        description: 'steps 数组的 JSON 字符串：'
          + '[{action:"click",selector:"...",label:"..."}, '
          + '{action:"click",selector:"...",when:"!!document.querySelector(...)"}, '
          + '{action:"hover",selector:"..."}, '
          + '{action:"contextmenu",selector:"..."}, '
          + '{action:"drag",selector:"...",toSelector:"...",dragMoves:4}]',
      },
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
export { listPages, connectSession, evaluateOnPort, click, insertText, pressKey, captureScreenshot, resize, readViewport, buildFinder, ensureRealViewport, reloadPageAndWait, describeViewport, VIEWPORT_NOT_RESTORED, hover, contextMenu, drag, visibleElementBox, DRAG_DEFAULT_MOVES } from './cdp-client.ts'
export type { PointerResult, DragOptions, DragResult, ElementBox, Point } from './cdp-client.ts'
export type { CdpSession, CdpPage, CdpParams, Evidence, EvidenceSummary, NetworkTimeSource, ConsoleEntry, NetworkEntry, NetworkFailure, ClickResult, InsertTextResult, ScreenshotResult, ResizeOptions, ConnectOptions, ViewportInfo, ViewportRestoreOutcome, ViewportRestoreOptions } from './cdp-client.ts'
