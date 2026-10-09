/**
 * session-bar —— 会话顶栏的 corum 段（状态胶囊 + 常驻 Agent 胶囊 + 轨迹按钮）。
 *
 * 2026-09-10「顶栏归会话」：这一段原先由壳在**窗口级** float 层渲染
 * （`titlebar-row` 的 `.agentTitleBarSeat`，见 AppFrame 历史），会话拖出为独立
 * 窗口后它仍留在主窗口——独立窗口看不到会话标题/状态/子 Agent。现改为**注册进
 * 会话级槽**：
 *
 *   conversation.session.header.actions   ← 状态胶囊（含常驻 Agent 胶囊段）
 *   conversation.session.header.utilities ← 轨迹按钮（右对齐）
 *
 * 两个槽由 `@corum/corum-ui-conversation` 声明（官方 0.1.3 结构），宿主行是
 * 会话插件 `ConversationSessionHeader` 里的 titleRow（本会话已恢复该行）。
 * 会话拖出为独立窗口时 `?floating=conversation` 挂载 ConversationRoot → 同一
 * header → 本段随之出现（实测：浮动窗会恢复当前会话）。
 *
 * **为什么注册进槽而不是在壳里再画一份**：这两段需要会话作用域（sessionId +
 * 用 `useSessions` 读投影），槽 occupant 天然拿到 `SessionStandardProps`
 * （sessionId）与 `GlobalStandardProps`（useSessions），无需自建上下文桥；
 * 且只有一份实现（历史上曾同时存在壳实现与孤儿 SessionHeaderSlot，已收敛）。
 *
 * 红线：本文件属 corum-ide-ui（壳 bundle），不 import 任何 `@corum/corum-ui-
 * conversation` 的**运行时**导出——只用它的 SlotMap 类型声明（type-only），
 * 与 chat/questions/trajectory 的既有口径一致（见 docs/fork-delta.md §3.1）。
 *
 * @module corum-ide-ui/client/session-bar
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入 corum-ui-conversation 的 SlotMap 声明（header.actions /
// header.utilities 两个槽由它声明），让本文件的槽注册通过类型检查
// （TS 模块合并全局生效；与 corum-ui-questions 拉 conversation.input.dock 同法）。
import type {} from '@corum/corum-ui-conversation/client'
import { useDeveloperMode } from './settings/developer-mode.ts'
import { mergeRosterEntry, type SubagentRosterEntry, type SubagentStopReason } from './subagent-roster-merge.ts'
import css from './AppFrame.module.css'

/** session/list 行 projectionValues 的窄化形（顶栏统计的数据源）。
 *  字段名与官方 `dsh-session-stats/types` 的 `SessionStatsProjection` 同构。 */
interface SessionStatsProjection {
  turns?: number
  steps?: number
  llmMs?: number
  toolMs?: number
  /** 首词元延迟合计（`step/start` → 首个非空 delta），配合 ttftSteps 求平均。 */
  ttftMs?: number
  /** 带首词元记录（= 可用于求 TTFT 平均）的 step 数。 */
  ttftSteps?: number
  /** 解码墙钟合计（首词元 → assistant/message），配合 decodeTokens 求平均速度。 */
  decodeMs?: number
  /** 与 decodeMs 同口径的服务方输出词元数。 */
  decodeTokens?: number
}
interface TokenUsageProjection {
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
interface ContextPressureProjection {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}
interface ContextBreakdownProjection {
  systemTokens?: number
  toolsTokens?: number
  messageTokens?: number
}
interface AgentSessionProjections {
  sessionStats?: SessionStatsProjection
  tokenUsage?: TokenUsageProjection
  contextPressure?: ContextPressureProjection
  contextBreakdown?: ContextBreakdownProjection
}

/**
 * 官方 SessionListState 的结构窄化（与 dsh-api-session-controller/client 同名
 * 类型同构；包未直接依赖该 controller——结构窄化避免新增运行时依赖，红线 3）。
 */
interface SessionListState {
  current?: string | undefined
  byId: Record<string, {
    blank?: boolean
    displayTitle?: string
    projectionValues?: unknown
    /** 该会话此刻是否在跑。 */
    running?: boolean
    /**
     * 会话的工作目录（官方 summary 自带；**判「是否隔离」的 durable 依据**——
     * 隔离子会话的 cwd 就是 `<repo>/.corum-worktrees/<slug>`）。结构窄化只声明用到的字段。
     */
    cwd?: string
  } | undefined>
  /**
   * 官方「直接子会话目录」（durable catalog，key = 父会话 id）。**子 Agent 花名册的
   * 权威冷启动基线**：它由宿主 `subagent.list` 读子会话血缘得到，durable、随会话
   * 选择自动拉一次、并在 `setCatalogOpen` 期间随成员变更增量刷新。
   *
   * 为什么不用 `byId` 血缘兜底（前一版的错）：官方 `SessionSummary` 的字段名是
   * `parentId`（不是 `parentSessionId`），而且 `byId` **只装列表根行 + 当前寻址的
   * 面包屑链**，普通子 Agent 会话根本不在里面 —— 于是基线恒为空，胶囊与浮层都
   * 不显示子 Agent（就是用户实测到的现象）。
   */
  subagentsByParent?: Record<string, SessionCatalogSnapshot | undefined>
}

/** 官方子会话目录快照的窄化形（只读消费；结构同构于 `SubagentCatalogSnapshot`）。 */
interface SessionCatalogSnapshot {
  entries?: ReadonlyArray<SessionCatalogRow | undefined>
  state?: 'loading' | 'ready' | 'error'
}

/** 目录中的一行（只取本组件渲染所需字段；`diagnostic` 行没有 `activity`）。 */
interface SessionCatalogRow {
  kind?: 'child' | 'diagnostic'
  id?: string
  /** `inactive` = 只存在于持久化里（已不在跑）→ 展示为「已完成」。 */
  activity?: 'running' | 'inactive'
  /** 官方续聊能力（`one-shot` 不可续聊、`continuable` 可续聊）。 */
  mode?: 'one-shot' | 'continuable'
  label?: string
  hasChildren?: boolean
}

/**
 * `ctx.sessions` 的目录能力面（红线 3/4：由 inject 下发的本地能力接口收窄，
 * 不 import 官方 controller 实现包）。
 */
export interface SubagentCatalogFace {
  /** 主动拉一次直接子会话目录。 */
  refresh: (parentSessionId: string) => void
  /** 声明「本会话的目录有消费方」：为真期间官方按成员变更增量重拉，卸载后释放。 */
  setCatalogOpen: (parentSessionId: string, open: boolean) => void
}

/** 会话列表 selector hook（本组件只读血缘 / 标题 / 运行态）。 */
type UseSessionsHook = <T>(selector: (state: SessionListState) => T) => T

/** `ctx.remote` 的窄化面（只用到转发事件订阅）。 */
export interface RemoteEventFace {
  $on: (event: string, listener: (frame: never) => void) => () => void
}

/** 紧凑时长：12m 34s / 3.8秒（顶栏摘要 + 详情 Active 共用）。 */
function compactDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/** 紧凑词元：12.4k / 3.1k / 178.3k（千分位紧凑，详情行用全量 toLocaleString）。 */
function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 解码速度文案：42 词元/s（中文口径——用户定：中文用「词元」，英文界面才用 tok/s）。 */
function compactTps(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return '—'
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} 词元/s`
}

/**
 * 顶栏合并胶囊的统计段（设计稿 ①②④ 的 status-pill stats 文案）。
 *
 * 口径（用户定调）：
 * - 轮次与步骤合并成 `X 轮 / X 步`（原为两个独立事实，占宽且信息密度低）；
 * - **词元输入/输出改为 context 占用百分比**（用户 2026-09-10：收起态不需要累计
 *   账单量，占用率才是「还能聊多久」的可执行信息；累计词元量保留在展开浮层的
 *   指标格里，一个事实一个家）。
 * - 命中率只留数值（缓存命中曲线已按用户要求删除）。
 *
 * @param p - 会话投影（可为 undefined，未上报时整段显示 —）。
 * @returns 形如 `4 轮 / 20 步 · 31m 26s · 上下文 2.1% · 命中 90%`。
 */
function agentStatsSummary(p: AgentSessionProjections | undefined): string {
  if (p === undefined) return '—'
  const turns = p.sessionStats?.turns ?? 0
  const steps = p.sessionStats?.steps ?? 0
  const active = (p.sessionStats?.llmMs ?? 0) + (p.sessionStats?.toolMs ?? 0)
  const input = (p.tokenUsage?.uncachedInputTokens ?? 0) + (p.tokenUsage?.cacheReadTokens ?? 0) + (p.tokenUsage?.cacheWriteTokens ?? 0)
  const cacheRead = p.tokenUsage?.cacheReadTokens ?? 0
  const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0
  return `${turns} 轮 / ${steps} 步 · ${compactDuration(active)} · 上下文 ${contextPercent(p)} · 命中 ${hit}%`
}

/**
 * context 占用百分比文案（`2.1%`；窗口未上报时 `—`）。
 *
 * 保留一位小数：窗口常是 1000k 量级，整数会把 0.4% 与 1.4% 都显示成「1%」，
 * 在低占用阶段丢掉全部分辨率（实测本会话 20.6k/1000k = 2.1%）。
 * @param p - 会话投影。
 * @returns 百分比文案（含 % 号）。
 */
function contextPercent(p: AgentSessionProjections | undefined): string {
  const used = p?.contextPressure?.pressureTokens ?? 0
  const window = p?.contextPressure?.contextWindow ?? 0
  if (window <= 0) return '—'
  return `${Math.round((used / window) * 1000) / 10}%`
}

/**
 * 每个 step 的解码速度采样点（设计稿 chart-speed 实时曲线的数据单元）。
 * `tps = 该步输出词元 / 该步解码秒数`。
 */
interface SpeedSample {
  /** step 序号（用于 React key 与「第 N 步」提示）。 */
  readonly step: number
  /** 该步解码速度（词元/s）。 */
  readonly tps: number
}

/** 曲线最多保留的采样点数（超出丢最旧；浮层宽度约 300px，40 点已足够密）。 */
const SPEED_SERIES_CAP = 40

/**
 * `useTrajectory` 快照的窄化面（只取 eventNodes；见下方 useSpeedSeries 的取数注释）。
 * 该 hook 由 corum-ui-trajectory 经 `SessionStandardProps` 模块合并声明，
 * 会话作用域 occupant 都能拿到——结构窄化避免本包新增运行时依赖（红线 3）。
 */
interface TrajectorySnapshotLike {
  readonly eventNodes?: readonly TrajectoryNodeLike[]
}
/** 轨迹事件节点里与吞吐曲线相关的字段（AssistantMessageNode 的子集）。 */
interface TrajectoryNodeLike {
  kind?: string
  turn?: number
  step?: number
  usage?: { outputTokens?: number } | undefined
  timing?: {
    stepStartTime?: number | null
    firstTokenTime?: number | null
    completedTime?: number
  } | undefined
}
export type UseTrajectoryHook = <T>(selector: (snapshot: TrajectorySnapshotLike) => T) => T

/** 空轨迹快照（缺省 hook 的返回值；模块级常量保证引用稳定，避免每次渲染换新数组）。 */
const EMPTY_TRAJECTORY_NODES: readonly TrajectoryNodeLike[] = []

/**
 * 缺省轨迹 hook（`useTrajectory` 未注入时的替身）。
 *
 * ⚠️ Rules of Hooks：不能按「prop 有没有」改变 hook 调用数量，故本函数**不调用任何
 * hook**（真实 `useTrajectory` 内部会调 useStore 之类）。两支的 hook 数因此不同，
 * 但该分支只随插件装配变化——本项目里 corum-ui-trajectory 是常驻插件
 * （见 `__DSH_BOOT__` 的 application 批），运行期不会翻转；真换成没装该插件的
 * 精简装配时需要重新挂载，属可接受边界（已在 docs/TODO.md 登记）。
 */
function useEmptyTrajectory<T>(_selector: (snapshot: TrajectorySnapshotLike) => T): T {
  return EMPTY_TRAJECTORY_NODES as unknown as T
}

/** 从一步 assistant 节点算解码速度（词元/s）；不可算返回 null。 */
function stepTps(node: TrajectoryNodeLike): number | null {
  const first = node.timing?.firstTokenTime
  const done = node.timing?.completedTime
  const tokens = node.usage?.outputTokens
  if (typeof first !== 'number' || typeof done !== 'number' || typeof tokens !== 'number') return null
  const decodeMs = Math.max(0, done - first)
  // 解码时长过短（<50ms）说明该步几乎瞬时结束，速度会是噪声级大数，跳过。
  if (decodeMs < 50 || tokens <= 0) return null
  const tps = tokens / (decodeMs / 1000)
  return Number.isFinite(tps) && tps > 0 ? tps : null
}

/**
 * 逐步解码速度序列（设计稿 chart-speed「生成速度」实时曲线）。
 *
 * **取数与可行性（用户 2026-09-10 点名要评估）**：
 * - 逐词元的 `assistant/live-chunk` 事件带 seq/time，但被 conversation 装配器内部
 *   消费，官方 `ISession` 面只暴露生命周期 + 行为动词 —— 槽位占用者拿不到事件窗口，
 *   故**不做**逐词元订阅（那需要新增宿主事件通路 + 重启，即 docs/TODO.md 的 B 档）。
 * - 这里走**真实历史**：`useTrajectory().eventNodes` 是本会话装配好的 assistant
 *   节点序列，每个节点自带 `timing`（stepStartTime/firstTokenTime/completedTime）
 *   与 `usage.outputTokens` —— 与官方 TrajectoryTable 算 TTFT/吞吐同源。
 *   于是 `tps = outputTokens / ((completedTime - firstTokenTime)/1000)` 得到每一步的
 *   真实速度，**已结束的会话也有完整曲线**（投影增量方案只能从挂载点开始累积，
 *   对历史会话恒为空——这正是第一版曲线画不出东西的原因，实测已证）。
 *
 * 仅取可算的步；按到达顺序（= step 升序）保留，超上限丢最旧。
 *
 * @param useTrajectory - 会话作用域标准 props 的轨迹快照 hook（缺失时用空实现）。
 * @returns 按时间升序的速度采样点。
 */
function useSpeedSeries(useTrajectory: UseTrajectoryHook | undefined): readonly SpeedSample[] {
  const hook = useTrajectory ?? useEmptyTrajectory
  const nodes = hook(s => s.eventNodes ?? EMPTY_TRAJECTORY_NODES)
  return useMemo(() => {
    const out: SpeedSample[] = []
    for (const node of nodes) {
      if (node.kind !== 'assistant') continue
      const tps = stepTps(node)
      if (tps === null) continue
      out.push({ step: node.step ?? out.length + 1, tps })
    }
    return out.slice(-SPEED_SERIES_CAP)
  }, [nodes])
}

/**
 * 生成速度曲线（设计稿 chart-speed）：折线 + 面积，横轴 = 步，纵轴 = 词元/s。
 *
 * 采样不足（<2 点）时**不画假曲线**，改为一条虚线基线。原因：本组件装在会话顶栏，
 * 页面刷新后历史帧不重放，`useSpeedSeries` 从当次挂载才开始累积，已结束的会话
 * 永远只有 0~1 个点——画成实心块会被误读为「速度恒为 0」。
 *
 * @param samples - 速度采样点（按时间升序）。
 * @param width - 画布宽（px）。
 * @param height - 画布高（px）。
 * @returns 折线 + 面积（或空态基线）的 SVG。
 */
function SpeedChart({ samples, width = 300, height = 138 }: {
  samples: readonly SpeedSample[]
  width?: number
  height?: number
}) {
  const pad = 10
  const inner = height - pad * 2
  // 纵轴上限：取样本最大值再上浮 15%（避免顶点贴底/贴顶），下限 10 防止除零。
  const peak = samples.length > 0 ? Math.max(...samples.map(s => s.tps)) : 0
  const maxV = Math.max(10, peak * 1.15)
  const n = samples.length
  if (n < 2) {
    // 空态：虚线基线（不填充），避免被读成「速度 0」的实心块。
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={css.statusDetailTrend}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          x1="0" y1={height / 2} x2={width} y2={height / 2}
          stroke="var(--corum-glass-border, rgba(185,140,255,.3))"
          strokeWidth="1" strokeDasharray="4 4"
        />
      </svg>
    )
  }
  const pts = samples.map((s, i) => [
    (i / (n - 1)) * width,
    pad + (1 - s.tps / maxV) * inner,
  ] as const)
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={css.statusDetailTrend}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={`${line} L${width} ${height} L0 ${height} Z`} fill="var(--dsw-alias-brand-primary)" opacity="0.18" stroke="none" />
      <path d={line} fill="none" stroke="var(--dsw-alias-brand-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 子 Agent 终局原因（与 `@corum/corum-api-remotes/corum-events` 的
 *  `SubagentStopReason` 同构；本包不 import 该包——红线 3：跨 bundle 用本地
 *  能力接口收窄，与 `WorktreeLedgerFrame` 窄化注释同惯例。声明在
 *  `subagent-roster-merge`（花名册合并规则的单一家），此处只是同包内复用）。 */

/** RPC 返回的 stopReason 合法化（不认识的字符串不当成功）。 */
const VALID_STOP_REASONS = new Set<string>(['completed', 'aborted', 'error', 'max-tokens', 'refusal'])

/** stopReason → 三态终态（undefined = 运行中/未结束）；与 `subagentOutcomeOf` 同语义。 */
function subagentOutcomeOf(stopReason: SubagentStopReason | undefined): 'completed' | 'aborted' | 'failed' | undefined {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'aborted': return 'aborted'
    case 'error': case 'max-tokens': case 'refusal': return 'failed'
    case undefined: return undefined
  }
}

/**
 * 五态展示态（本包不 import `@corum/corum-api-remotes`——红线 3：跨 bundle 用本地
 * 能力接口收窄）。语义与那边的 `subagentProgressStateOf` **逐条一致**，由
 * `corum-api-remotes/tests/remote-events.host.spec.ts` 的镜像对账单测钉住。
 *
 * 优先级（与那边同序，改一处就得改另一处）：
 * 1. `stopReason`：权威终局原因，有它就以它记账；
 * 2. `interrupted`：宿主判定的「半途失去运行」（进程被杀/重启把未闭合的 `turn/start`
 *    留在 log 里）——宿主只在**拿不到原因时**才置它；它优先于下面的 done 兜底
 *    （这类条目 `done` 也是 true，但既不是完成也不是手动终止）。2026-09-13 之前它只
 *    落在子 Agent 卡片上，花名册把它算成「已完成」，同一个终态两处不同源（BUG-31 同族病）；
 * 3. `done`：拿不到原因的终局（历史条目/冷恢复）按「已完成」兜底，不永远算运行中。
 */
type SubagentState = 'running' | 'completed' | 'aborted' | 'failed' | 'interrupted'
function subagentStateOf(e: {
  readonly stopReason?: SubagentStopReason
  readonly done?: boolean
  readonly interrupted?: boolean
}): SubagentState {
  const outcome = subagentOutcomeOf(e.stopReason)
  if (outcome !== undefined) return outcome
  if (e.interrupted === true) return 'interrupted'
  return e.done === true ? 'completed' : 'running'
}

/**
 * 花名册一行（**运行中区与终态折叠区共用**）。
 *
 * 2026-09-13 抽出的原因：两处此前各写一遍同样的 JSX，标签逻辑一旦分叉就是
 * 「同一终态两处不同源」——「已中断」只落到卡片、花名册却仍写「已完成」正是这个
 * 结构的产物（BUG-31 同族病）。共用之后，终态文案只有一处可改。
 */
/** `revealSubagentCard` 的结果（chatRuntime 服务面的窄化；红线 3：只声明用到的字段）。 */
export interface RevealOutcome {
  readonly ok: boolean
  readonly reason?: 'not-ready' | 'not-open' | 'not-loaded'
  readonly pagesLoaded?: number
}

/** 用户可见失败反馈（与 SubagentChanges/apply 同款，`__corumNotify` 一次性只读桥）。 */
function notifyUser(title: string, message?: string): void {
  const notify = (window as unknown as { __corumNotify?: (n: { tone: 'error'; title: string; message?: string }) => void }).__corumNotify
  notify?.({ tone: 'error', title, ...message === undefined ? {} : { message } })
}

/**
 * 「在主会话瀑布里定位这张卡」的跳转按钮（用户 2026-09-18 定调）。
 *
 * 为什么单独一个按钮、而不是改行的点击语义：行的点击早已是「进入子会话」（打开子会话），
 * 用户明确要求**保留**它、另给一个「点了就过去」的入口。两者分工：
 *   - 行（→）：切到子会话去看它的完整过程；
 *   - 本按钮（⌖）：**不切会话**，在父会话瀑布里把那张子 Agent 卡滚到中央并短暂高亮。
 * 定位走 `chatRuntime.revealSubagentCard`（cordis 服务，红线 1）；找不到时**不静默** ——
 * 退化为「进入子会话」并如实说明原因，让这个手势永远有结果。
 */
function RevealCardButton({ childSessionId, label, revealCard, fallback }: {
  readonly childSessionId: string
  /** 无障碍名里的对象描述（子 Agent 标签 / 分支名）。 */
  readonly label: string
  readonly revealCard?: ((childSessionId: string) => Promise<RevealOutcome>) | undefined
  /** 找不到时的退化动作（打开子会话）。 */
  readonly fallback?: ((sessionId: string) => void) | undefined
}) {
  const [busy, setBusy] = useState(false)
  const onClick = (): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        const result = await revealCard?.(childSessionId)
        if (result?.ok === true) return
        // 如实说明 + 给可执行出路：卡片不在当前加载的窗口里就带用户进子会话。
        const why = result?.reason === 'not-loaded'
          ? '该子 Agent 的卡片不在当前已加载的会话窗口内（会话较长，窗口外的节点未渲染）'
          : result?.reason === 'not-open'
            ? '当前打开的会话不是该子 Agent 的父会话'
            : '瀑布视图尚未就绪'
        notifyUser('没能在会话里定位这张卡', `${why}；已为你打开子会话`)
        fallback?.(childSessionId)
      } finally {
        setBusy(false)
      }
    })()
  }
  return (
    <button
      type="button"
      className={css.statusDetailAgentJump}
      data-jump
      disabled={busy}
      title="在会话里定位这张卡（不切换会话，只在当前页面滚动并高亮）"
      aria-label={`在会话里定位 ${label}`}
      onClick={onClick}
    >
      {/* 与行尾 `→`（进入子会话）区分开的「定位」字形：靶心。本文件的图标惯例是文本字形
          （`⑂` 工作树 / `▸` 折叠），不引入图标库；`⌖` 实测渲染得像加号、紧挨 `→` 会误读。 */}
      ◎
    </button>
  )
}

function RosterRow({ entry, openSession, revealCard }: {
  readonly entry: SubagentRosterEntry
  // exactOptionalPropertyTypes：调用方会把 `openSession`（可能 undefined）原样传进来。
  readonly openSession?: ((sessionId: string) => void) | undefined
  readonly revealCard?: ((childSessionId: string) => Promise<RevealOutcome>) | undefined
}) {
  const state = subagentStateOf(entry)
  // chip 色调档只有四档（running/done/aborted/failed）：interrupted 复用 aborted，
  // 与卡片 `subagentStateChipTone` 同一口径。
  const tone = state === 'running' ? undefined : state === 'interrupted' ? 'aborted' : state
  const statusText = state === 'interrupted' ? '已中断'
    : state === 'aborted' ? '手动终止'
      : state === 'failed' ? '失败'
        : state === 'completed' ? '已完成'
          : `Step ${entry.step}${entry.currentAction === undefined ? '' : ` · ${entry.currentAction}`}`
  return (
    <div
      className={css.statusDetailAgentRow}
      data-done={state === 'running' ? undefined : true}
      data-outcome={tone}
      data-state={state}
    >
      {/* ⚠️ 行不能是 <button> 了：跳转按钮要作为它的**兄弟**（按钮嵌按钮是非法 HTML）。 */}
      <button
        type="button"
        className={css.statusDetailAgentHit}
        title={`进入子会话 ${entry.childSessionId}`}
        aria-label={`进入子会话 ${entry.label}`}
        onClick={() => { openSession?.(entry.childSessionId) }}
      >
      <span className={css.statusDetailAgentDot} data-outcome={tone} />
      <span className={css.statusDetailAgentLabel}>{entry.label}</span>
      <span className={css.statusDetailAgentStep}>{statusText}</span>
      <span className={css.statusDetailAgentBadge} data-model={entry.model?.model ?? '未记录'} title={entry.model !== undefined ? `模型提供方 ${entry.model.provider}` : '模型未记录'}>
        {entry.model?.model ?? '未记录'}
      </span>
      {entry.role !== undefined && (
        <span className={css.statusDetailAgentRole} data-role={entry.role}>
          {SUBAGENT_ROLE_BADGE[entry.role]}
        </span>
      )}
      {entry.isolated === true && <span className={css.statusDetailAgentBadge}>隔离</span>}
      {entry.mode === 'background' && <span className={css.statusDetailAgentBadge}>后台</span>}
        <span className={css.statusDetailAgentGo} aria-hidden="true">→</span>
      </button>
      <RevealCardButton
        childSessionId={entry.childSessionId}
        label={entry.label}
        revealCard={revealCard}
        fallback={openSession}
      />
    </div>
  )
}

/** 花名册内帧形（corum/subagent/child 与 corum/subagent/progress 的并集窄化）。 */
interface ChildFrame {
  parentSessionId?: string
  callId?: string
  childSessionId?: string
  label?: string
  mode?: 'foreground' | 'background'
  isolated?: boolean
  /** child 帧携带的委派角色（工具名派生；卡片与会话条同源）。 */
  role?: 'worker' | 'research' | 'fork'
  /** child 帧携带的 worktree 三件套（仅隔离时非空；用于 slug→model 关联）。 */
  worktree?: { slug?: string; branch?: string; path?: string }
  /** child 帧携带的真实生效模型路由（progress 帧不带）。 */
  model?: { provider?: string; model?: string; reasoningEffort?: string }
  sessionId?: string
  turn?: number
  step?: number
  currentAction?: string
  done?: boolean
  stopReason?: SubagentStopReason
  lastActive?: number
}

/**
 * 当前会话的子 Agent 花名册（2026-09-10 用户定调：常驻胶囊与状态展示合并）。
 *
 * 数据源 = 统一事件中心转发帧（`corum/subagent/child` 精确父子映射 +
 * `corum/subagent/progress` 进度推送），按父会话过滤后折叠成条目；运行中在前、
 * 最近活动排序。页面刷新后无回放帧，花名册从空开始，下一次派遣即恢复
 * （与 SubagentCard 的「广播优先、时间就近兜底」同源，这里只取精确通道）。
 */
/**
 * 子 Agent 花名册 = **官方直接子会话目录（durable 基线）** + **corum 推送帧增量**。
 *
 * ① 基线为什么必须有：推送帧（`corum/subagent/child` / `corum/subagent/progress`）只在
 *    **变更时**发，页面刷新 / 应用重启 / 会话切走再切回**都不会重放** —— 纯推送订阅会让
 *    「已经跑完的子 Agent」永远消失。用户实测到的「胶囊与展开浮层都不显示子 Agent」
 *    就是这么来的：设计稿的浮层明确要求列出 `2 运行中 · 1 已完成`，而 roster 是空的。
 *    这与 host `getWorktreeLedger` 注释记载的是同一个坑（推送为主 + 快照冷启动基线）。
 *    基线源 = 官方 `ctx.sessions` 同步过来的 `subagentsByParent`（宿主 `subagent.list`
 *    读子会话血缘，durable、零新增 RPC）；编排模式下派出的子 Agent 同样是 subagent
 *    会话，所以一并覆盖。
 *
 * ② 「是否还在跑」以目录行的 `activity` 为准（`running` / `inactive`）；推送帧的
 *    `done` 只在目录里找不到该子会话时兜底（避免帧停在旧状态）。
 *
 * ③ 目录的**新鲜度**靠 `setCatalogOpen(parent, true)`：官方在成员变更帧到达时防抖重拉
 *    该父的目录，本组件常驻会话顶栏，所以整个会话生命周期内都订阅（见下方 effect）。
 */
/**
 * 共享进度能力（bundle B `chatRuntime.childProgress` 的窄化面；同 bundle 内共享类型）。
 *
 * 为什么要它（2026-09-28 实测，`docs/PENDING-ui-lag-multiround.md` §2.13）：本 hook 的种子为每个
 * 已结束子会话拉一次进度，而视图每次激活都重新挂载 ⇒ 一轮动作实测 ~30 次 `getChildSessionProgress`
 * （~270 ms/次）。走共享缓存后终态结果整页只拉一次；取不到能力（bundle B 未挂载）⇒ 回落直连 RPC，
 * 行为与今天一致。
 */
export type ReadChildProgress = (sessionId: string) => Promise<
  | {
      role?: 'worker' | 'research' | 'fork'
      isolated?: boolean
      progress?: { stopReason?: string; interrupted?: boolean }
    }
  | undefined
>

function useSubagentRoster(
  remote: RemoteEventFace | undefined,
  sessionId: string | undefined,
  useSessions: UseSessionsHook,
  catalog: SubagentCatalogFace | undefined,
  connection: RpcFace | undefined,
  readChildProgress?: ReadChildProgress,
): readonly SubagentRosterEntry[] {
  const rows = useSessions((state: SessionListState) => {
    return sessionId === undefined ? undefined : state.subagentsByParent?.[sessionId]?.entries
  })
  /**
   * 子会话 id → cwd（官方 session summary 自带，**durable**）。
   *
   * 用它判「是否隔离」：隔离子会话的工作目录就是 worktree 根下的
   * `<repo>/.corum-worktrees/<slug>`。为什么不能只靠 `corum/subagent/child` 帧里的
   * `isolated`：帧**不重放**——刷新/重启后整个「隔离」分类会消失（2026-09-12 用户实测
   * 「下拉的悬浮窗中无法看到隔离任务的分类了」）。cwd 是会话自己的持久事实，随时可查。
   */
  const childCwds = useSessions((state: SessionListState) => state.byId)
  /**
   * 打开目录订阅（官方机制）：
   * `refresh` 补一次立即拉取；`setCatalogOpen(true)` 让官方在**成员变更帧**到达时
   * 防抖重拉——这是「新派出的子 Agent 无需刷新页面就出现在胶囊里」的唯一正路
   * （推送帧 `corum/subagent/*` 不重放，只做增量覆盖）。卸载时释放，避免常驻订阅。
   */
  useEffect(() => {
    if (sessionId === undefined || catalog === undefined) return undefined
    catalog.refresh(sessionId)
    catalog.setCatalogOpen(sessionId, true)
    return () => { catalog.setCatalogOpen(sessionId, false) }
  }, [catalog, sessionId])
  const baseline = useMemo((): readonly SubagentRosterEntry[] => {
    const out: SubagentRosterEntry[] = []
    if (rows === undefined) return out
    for (const row of rows) {
      // `diagnostic` 行是目录读取失败的占位（没有 activity/label），不进花名册。
      if (row === undefined || row.kind !== 'child' || row.id === undefined) continue
      out.push({
        childSessionId: row.id,
        label: row.label !== undefined && row.label !== '' ? row.label : row.id,
        // mode/isolated 故意**不给默认值**（官方目录没有这两轴，见类型注释）；
        // step 先给 0，corum 推送帧到了由下面的合并覆盖。
        step: 0,
        // 目录基线只有 running/inactive 两态，无法区分 aborted：
        // inactive 可能是已完成、也可能是手动终止——此处作为无推送帧时的兜底，
        // 真正的终态判定以推送帧的 stopReason 为准（见合并与渲染）。
        done: row.activity !== 'running',
        lastActive: 0,
      })
    }
    return out
  }, [rows])

  /** 冷启动终态种子：目录基线只区分 running/inactive，已结束（inactive）的子会话
   *  无法区分「正常完成」与「手动终止」。推送帧不重放（刷新/重启/切走后丢失），
   *  故对已结束的子会话一次性 RPC 拉 stopReason，只填补、不覆盖推送帧的权威值。
   *  会话切走/换 sessionId 时重置已拉记录。 */
  const [seededStopReason, setSeededStopReason] = useState<ReadonlyMap<string, SubagentStopReason>>(new Map())
  /** 冷启动补来的「半途失去运行」（同一条 RPC；帧不重放也不会带它——它是宿主对
   *  「上个进程生命周期留下的未闭合 turn」的判定，不是事件）。 */
  const [seededInterrupted, setSeededInterrupted] = useState<ReadonlySet<string>>(new Set())
  /** 冷启动补来的委派角色（见下方种子的说明；推送帧不重放）。 */
  const [seededRole, setSeededRole] = useState<ReadonlyMap<string, 'worker' | 'research' | 'fork'>>(new Map())
  /** 冷启动补来的「是否隔离」（同上：帧不重放，用宿主 durable 判据）。 */
  const [seededIsolated, setSeededIsolated] = useState<ReadonlyMap<string, boolean>>(new Map())
  const seededRef = useRef<Set<string>>(new Set())
  // 已结束的子会话 id 列表（只在成员变化时变，不受 step 等增量字段影响）。
  const finishedIds = useMemo(
    () => baseline.filter(e => e.done).map(e => e.childSessionId),
    [baseline],
  )
  useEffect(() => {
    // 会话切换时清空种子与已拉记录，避免跨会话串数据。
    seededRef.current = new Set()
    setSeededStopReason(new Map())
    setSeededInterrupted(new Set())
    setSeededRole(new Map())
    setSeededIsolated(new Map())
    if (connection === undefined || sessionId === undefined) return undefined
    let cancelled = false
    for (const id of finishedIds) {
      // 只拉尚未拉过的子会话（running 的不在 finishedIds 里）。
      if (seededRef.current.has(id)) continue
      seededRef.current.add(id)
      void (async () => {
        try {
          // 优先走共享缓存（终态结果整页只拉一次）；能力不可用时回落直连 RPC。
          const resolved = readChildProgress === undefined
            ? await connection.rpc.call('/api', 'corumAgent/getChildSessionProgress', { args: { sessionId: id } })
              .then(result => (result.ok && result.value !== undefined ? result.value : undefined))
            : await readChildProgress(id)
          if (cancelled || resolved === undefined) return
          const value = resolved as {
            role?: 'worker' | 'research' | 'fork'
            isolated?: boolean
            progress?: { stopReason?: string; interrupted?: boolean }
          }
          // 隔离徽标：推送帧不重放，靠宿主的 durable 判据（子会话 cwd 在 .corum-worktrees 下）
          // 补标——否则刷新/重启后「隔离」整列消失（2026-09-12 用户实测）。
          if (value.isolated !== undefined) {
            setSeededIsolated(prev => {
              if (prev.get(id) === value.isolated) return prev
              const next = new Map(prev)
              next.set(id, value.isolated === true)
              return next
            })
          }
          // 角色：与 stopReason 同一条冷启动路（推送帧不重放，不补就只有「本页之后新建的
          // 子 Agent」才带角色）。只认白名单里的三个值，别的一律不挂小标。
          const seeded = value.role === 'worker' || value.role === 'research' || value.role === 'fork'
            ? value.role
            : undefined
          if (seeded !== undefined) {
            setSeededRole(prev => {
              if (prev.get(id) === seeded) return prev
              const next = new Map(prev)
              next.set(id, seeded)
              return next
            })
          }
          // 「半途失去运行」：宿主唯一能判它的人（见 agent-service 的判据注释）。
          // **必须放在下面 stopReason 的早退之前**——interrupted 条目恰恰没有
          // stopReason，写在后面就永远填不上（2026-09-13 收口时踩到过一次）。
          if (value.progress?.interrupted === true) {
            setSeededInterrupted(prev => {
              if (prev.has(id)) return prev
              const next = new Set(prev)
              next.add(id)
              return next
            })
          }
          const raw = value.progress?.stopReason
          if (raw === undefined) return
          if (!VALID_STOP_REASONS.has(raw)) return
          const sr = raw as SubagentStopReason
          setSeededStopReason(prev => {
            const next = new Map(prev)
            next.set(id, sr)
            return next
          })
        } catch {
          // 拉取失败静默忽略（与兜底风格一致：可见性增强，绝不影响会话）。
        }
      })()
    }
    return () => { cancelled = true }
  }, [connection, sessionId, finishedIds])

  /**
   * 冷启动模型补强：基线（官方目录）不带模型字段，页面刷新后推送帧不重放。
   * 按 SubagentCard.useChildModel 同口径一次性拉 session/list（limit 200），
   * 批量映射 childSessionId → modelSelection.lastUsed。拉不到或不在表里 →
   * 保持 undefined（渲染时显式显示「未记录」）。
   *
   * 并行工作区行不由此补强：台账 slug 无法经 session/list 关联，刷新后
   * 显示「未记录」是预期且可接受的——不硬造数据。
   */
  const [seededModel, setSeededModel] = useState<ReadonlyMap<string, { provider: string; model: string }>>(new Map())
  useEffect(() => {
    setSeededModel(new Map())
    if (connection === undefined || sessionId === undefined) return undefined
    let cancelled = false
    void (async () => {
      try {
        const result = await connection.rpc.call('/api', 'session/list', { args: { _request: { limit: 200 } } })
        if (cancelled || !result.ok || result.value === undefined) return
        const value = result.value as {
          items?: ReadonlyArray<{
            sessionId?: string
            projections?: { values?: { modelSelection?: { lastUsed?: { provider?: string; model?: string } } } }
          }>
        }
        const map = new Map<string, { provider: string; model: string }>()
        for (const item of value.items ?? []) {
          if (item.sessionId === undefined) continue
          const m = item.projections?.values?.modelSelection?.lastUsed
          if (m?.model === undefined || m.model === '' || m.provider === undefined) continue
          map.set(item.sessionId, { provider: m.provider, model: m.model })
        }
        if (map.size === 0) return
        if (cancelled) return
        setSeededModel(map)
      } catch {
        // 单次失败静默忽略（模型行缺省显示「未记录」）。
      }
    })()
    return () => { cancelled = true }
  }, [connection, sessionId])

  const live = useLiveRoster(remote, sessionId)
  return useMemo(() => {
    const merged = new Map<string, SubagentRosterEntry>()
    for (const entry of baseline) merged.set(entry.childSessionId, entry)
    /** cwd → 是否隔离（worktree 路径约定；取不到 cwd 则不猜）。 */
    const isolatedOf = (id: string): boolean | undefined => {
      const cwd = childCwds[id]?.cwd
      return cwd === undefined ? undefined : /(^|[\\/])\.corum-worktrees([\\/]|$)/.test(cwd)
    }
    for (const [id, entry] of [...merged]) {
      if (entry.isolated !== undefined) continue
      const isolated = isolatedOf(id)
      if (isolated !== undefined) merged.set(id, { ...entry, isolated })
    }
    // 冷启动种子填补 stopReason（仅当推送帧未给时；推送帧的值更权威）。
    for (const [id, sr] of seededStopReason) {
      const entry = merged.get(id)
      if (entry !== undefined && entry.stopReason === undefined) {
        merged.set(id, { ...entry, stopReason: sr })
      }
    }
    // 冷启动种子填补 interrupted（帧永远不带它——它是宿主对「上个进程生命周期的
    // 未闭合 turn」的判定，不是事件；不填就只剩卡片知道、花名册仍算「已完成」）。
    for (const id of seededInterrupted) {
      const entry = merged.get(id)
      if (entry !== undefined && entry.interrupted !== true) {
        merged.set(id, { ...entry, interrupted: true })
      }
    }
    // 冷启动种子填补 role（仅当推送帧没给时）。
    for (const [id, role] of seededRole) {
      const entry = merged.get(id)
      if (entry !== undefined && entry.role === undefined) {
        merged.set(id, { ...entry, role })
      }
    }
    // 冷启动种子填补 isolated（仅当推送帧没给时）。
    for (const [id, isolated] of seededIsolated) {
      const entry = merged.get(id)
      if (entry !== undefined && entry.isolated === undefined) {
        merged.set(id, { ...entry, isolated })
      }
    }
    // 冷启动种子填补 model（仅当基线 / 推送帧都没给时；推送帧的值更权威）。
    for (const [id, m] of seededModel) {
      const entry = merged.get(id)
      if (entry !== undefined && entry.model === undefined) {
        merged.set(id, { ...entry, model: m })
      }
    }
    for (const entry of live) {
      const prior = merged.get(entry.childSessionId)
      // done/stopReason 以推送帧（live）为准：目录基线只有 running/inactive 两态，
      // 无法区分 aborted（见基线注释）；推送帧带 stopReason 时它才是权威终态。
      // model 同步用与 label/step 同款的继承语义：live 无 model 时继承 prior（基线
      // 或 session/list 补强的值），避免 progress 帧把已有 model 抹掉。
      merged.set(entry.childSessionId, {
        ...entry,
        ...prior === undefined ? {} : { label: entry.label === '' ? prior.label : entry.label },
        ...prior !== undefined && entry.step === 0 ? { step: prior.step } : {},
        ...(entry.model === undefined && prior?.model !== undefined ? { model: prior.model } : {}),
        // role 只来自 child 帧 / 冷启动种子：progress 帧不带它，别把已知角色抹掉。
        ...(entry.role === undefined && prior?.role !== undefined ? { role: prior.role } : {}),
        // isolated 同理：progress 帧不带它，别把已知值抹掉。
        ...(entry.isolated === undefined && prior?.isolated !== undefined ? { isolated: prior.isolated } : {}),
        // interrupted 同理：只有冷启动种子会给，progress 帧不带。
        ...(entry.interrupted === undefined && prior?.interrupted !== undefined ? { interrupted: prior.interrupted } : {}),
      })
    }
    return [...merged.values()]
  }, [baseline, live, seededStopReason, seededInterrupted, seededModel, seededRole, seededIsolated, childCwds])
}

/** 推送帧累积（历史上的唯一来源；现在只作基线之上的增量）。 */
function useLiveRoster(remote: RemoteEventFace | undefined, sessionId: string | undefined): readonly SubagentRosterEntry[] {
  const [entries, setEntries] = useState<readonly SubagentRosterEntry[]>([])
  useEffect(() => {
    if (remote === undefined || sessionId === undefined) { setEntries([]); return undefined }
    setEntries([])
    const upsert = (patch: Partial<SubagentRosterEntry> & { childSessionId: string }): void => {
      setEntries((prev) => {
        const index = prev.findIndex(e => e.childSessionId === patch.childSessionId)
        if (index < 0) {
          if (patch.label === undefined) return prev
          return [...prev, {
            childSessionId: patch.childSessionId,
            label: patch.label,
            ...(patch.mode === undefined ? {} : { mode: patch.mode }),
            ...(patch.isolated === undefined ? {} : { isolated: patch.isolated }),
            ...(patch.model === undefined ? {} : { model: patch.model }),
            step: patch.step ?? 0,
            ...(patch.currentAction === undefined ? {} : { currentAction: patch.currentAction }),
            done: patch.done ?? false,
            ...(patch.stopReason === undefined ? {} : { stopReason: patch.stopReason }),
            lastActive: patch.lastActive ?? Date.now(),
          }]
        }
        const next = [...prev]
        next[index] = mergeRosterEntry(next[index], patch)
        return next
      })
    }
    const disposeChild = remote.$on('corum/subagent/child', (frame: ChildFrame) => {
      if (frame.parentSessionId !== sessionId || frame.childSessionId === undefined) return
      upsert({
        childSessionId: frame.childSessionId,
        ...(frame.label === undefined ? {} : { label: frame.label }),
        ...(frame.mode === undefined ? {} : { mode: frame.mode }),
        ...(frame.isolated === undefined ? {} : { isolated: frame.isolated }),
        ...(frame.role === undefined ? {} : { role: frame.role }),
        ...(frame.model === undefined || frame.model.model === undefined || frame.model.provider === undefined
          ? {}
          : { model: { provider: frame.model.provider, model: frame.model.model } }),
        lastActive: Date.now(),
      })
    })
    const disposeProgress = remote.$on('corum/subagent/progress', (frame: ChildFrame) => {
      if (frame.sessionId === undefined) return
      upsert({
        childSessionId: frame.sessionId,
        ...(frame.step === undefined ? {} : { step: frame.step }),
        ...(frame.currentAction === undefined ? {} : { currentAction: frame.currentAction }),
        ...(frame.done === undefined ? {} : { done: frame.done }),
        ...(frame.stopReason === undefined ? {} : { stopReason: frame.stopReason }),
        ...(frame.lastActive === undefined ? {} : { lastActive: frame.lastActive }),
      })
    })
    return () => { disposeChild(); disposeProgress() }
  }, [remote, sessionId])
  return entries
}

/**
 * `corum/worktree-ledger` 转发帧的窄化形（宿主 fork #10 发射，按父 sessionId 过滤）。
 * 字段与 `@corum/corum-api-remotes/corum-events` 的 `CorumWorktreeLedgerFrameEvent`
 * 结构同构——本包不 import 该包（红线 3：跨 bundle 用本地能力接口收窄）。
 */
interface WorktreeLedgerFrame {
  sessionId?: string
  entries?: ReadonlyArray<{
    slug?: string
    branch?: string
    path?: string
    status?: string
    /** 与 childSessionId 同值（存量台账可能只有这个）——行可点性的兜底来源。 */
    runId?: string
    /** 现场已回收标记（见 WorktreeEntry.reclaimed）。 */
    reclaimed?: boolean
    childSessionId?: string
  }>
  pending?: number
}

/** 一条隔离工作区（渲染用，字段已归一）。 */
interface WorktreeEntry {
  readonly slug: string
  readonly branch: string
  readonly status: string
  /** 现场（worktree 目录 + 分支）已回收；与 `status==='integrated'` 组合出
   *  「已集成 · 现场已回收」，与 discarded（真丢弃）区分开（2026-09-12 用户定调）。 */
  readonly reclaimed?: boolean
  /** 该工作区对应的子 Agent 真实模型（child 帧 worktree.slug 关联）。 */
  readonly model?: { provider: string; model: string }
  /** 子会话 id（绑定 runId 后才有；有则行可点 → 进入子会话）。 */
  readonly childSessionId?: string
}

/**
 * 委派角色 → 会话条短标（调研 / 执行 / 分叉）。
 *
 * 与 `SubagentCard` 的 `SUBAGENT_ROLE_VISUAL`（图标 + 长文案）**同一角色集**，
 * 只是本处是紧凑列表，用两字短标；角色来源同为父侧 tool/call 的工具名。
 */
const SUBAGENT_ROLE_BADGE: Readonly<Record<'worker' | 'research' | 'fork', string>> = {
  research: '调研',
  worker: '执行',
  fork: '分叉',
}

/**
 * 台账条目的状态文案：`integrated + reclaimed` → 「已集成 · 现场已回收」。
 * @param entry - 渲染形工作区条目。
 * @returns 中文状态文案。
 */
function worktreeStatusLabel(entry: { readonly status: string; readonly reclaimed?: boolean }): string {
  if (entry.status === 'integrated' && entry.reclaimed === true) return '已集成 · 现场已回收'
  return WORKTREE_STATUS_LABEL[entry.status] ?? entry.status
}

/** 台账状态文案（与 SubagentCard 的 WORKTREE_STATUS_LABEL 同口径）。
 *
 * `integrated + reclaimed` 单列成「已集成 · 现场已回收」：工作确实进了主树，只是
 * worktree/分支被安全回收了——它**不是**「已丢弃」（那份工作没进主树才会是丢弃）。
 * 2026-09-12 用户实测：旧口径把成功集成写成「已丢弃」，折叠行读起来像把工作扔了。
 */
const WORKTREE_STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  settled: '待集成',
  integrated: '已集成',
  discarded: '已丢弃',
}

/**
 * 当前会话的隔离 worktree 台账（「并行工作区」区的数据源）。
 *
 * 为什么搬到这里：`SubagentCard` 卡内的「并行工作区」chip 在 P8（逐次成节点）后
 * 被移除——按次成节点会让它在每张卡上重复 N 份。用户定调的新家 = **会话条状态
 * 胶囊的展开浮层**（与子 Agent 区并列），一个会话一处、不重复。
 *
 * @param remote - 统一事件中心 remote 面（缺省不订阅）。
 * @param sessionId - 当前��话 id（按父会话过滤帧）。
 * @returns 台账条目（无台账时为空数组）。
 */
function useWorktreeLedger(
  remote: RemoteEventFace | undefined,
  sessionId: string | undefined,
  connection: RpcFace | undefined,
): readonly WorktreeEntry[] {
  const [entries, setEntries] = useState<readonly WorktreeEntry[]>([])
  // slug → model 映射：child 帧携带 worktree.slug + model，隔离子 Agent 的
  // 工作区行据此关联模型。台账帧本身不带 model（不改 CorumWorktreeEntry）。
  // 用 ref 而非 state——避免 child 帧到达时 effect 重跑（effect 依赖里没有它）。
  const slugModelRef = useRef<ReadonlyMap<string, { provider: string; model: string }>>(new Map())
  useEffect(() => {
    if (sessionId === undefined) { setEntries([]); slugModelRef.current = new Map(); return undefined }
    setEntries([])
    slugModelRef.current = new Map()
    // child 帧的 model 写入 slug→model 映射（只取隔离帧的 worktree.slug）。
    const disposeChild = remote?.$on('corum/subagent/child', (frame: ChildFrame) => {
      if (frame.parentSessionId !== sessionId) return
      const slug = frame.worktree?.slug
      const m = frame.model
      if (slug === undefined || m?.provider === undefined || m?.model === undefined) return
      // 提取为非可选 string 常量，避免闭包内类型收窄丢失。
      const provider = m.provider
      const model = m.model
      const existing = slugModelRef.current.get(slug)
      if (existing !== undefined && existing.provider === provider && existing.model === model) return
      const next = new Map(slugModelRef.current)
      next.set(slug, { provider, model })
      slugModelRef.current = next
      // 若已有该 slug 的台账行，就地更新 model 字段（台账帧不重放，child 帧后到时
      // 需主动刷一次 entries）。
      setEntries(prev => {
        const idx = prev.findIndex(e => e.slug === slug)
        if (idx < 0) return prev
        const updated = [...prev]
        updated[idx] = { ...updated[idx], model: { provider, model } }
        return updated
      })
    })
    /** 帧 → 渲染形（归一字段、跳过畸形条目、合并 slug→model）。 */
    const apply = (frame: WorktreeLedgerFrame): void => {
      const next: WorktreeEntry[] = []
      for (const entry of frame.entries ?? []) {
        if (entry.slug === undefined || entry.branch === undefined) continue
        const m = slugModelRef.current.get(entry.slug)
        // 子会话 id：`childSessionId` 缺省时回退 `runId`——两者同值（见 CorumWorktreeEntry
        // 注释），但存量台账（2026-09-12 之前的结算回退路径）只有 runId，只认
        // childSessionId 的话工作区行会渲染成**不可点的死行**（无 → 与 title）。
        const childId = entry.childSessionId ?? entry.runId
        next.push({
          slug: entry.slug,
          branch: entry.branch,
          status: entry.status ?? 'active',
          ...(entry.reclaimed === true ? { reclaimed: true } : {}),
          ...(childId !== undefined ? { childSessionId: childId } : {}),
          ...m !== undefined ? { model: m } : {},
        })
      }
      setEntries(next)
    }
    // 冷启动基线：台账推送只在**变更时** emit，页面刷新后不重放——不拉一次的话
    // 历史会话永远看到空台账（而「待集成」正是刷新后最需要看的信息）。
    let cancelled = false
    const pullBaseline = async (): Promise<void> => {
      if (connection === undefined) return
      try {
        const result = await connection.rpc.call('/api', 'corumAgent/getWorktreeLedger', { args: { sessionId } })
        if (cancelled || !result.ok || result.value === undefined) return
        apply(result.value as WorktreeLedgerFrame)
      } catch {
        // 拉取失败保持空台账（推送帧仍会补齐）。
      }
    }
    void pullBaseline()
    const disposeLedger = remote?.$on('corum/worktree-ledger', (frame: WorktreeLedgerFrame) => {
      if (frame.sessionId !== sessionId) return
      apply(frame)
    })
    return () => {
      cancelled = true
      disposeChild?.()
      disposeLedger?.()
    }
  }, [remote, sessionId, connection])
  return entries
}

/** 运行中（无终态）在前、已结束在后，最近活动倒序（胶囊取第一个当「当前子 Agent」）。 */
function rankRoster(entries: readonly SubagentRosterEntry[]): readonly SubagentRosterEntry[] {
  return [...entries].sort((a, b) => {
    const aEnded = subagentStateOf(a) !== 'running'
    const bEnded = subagentStateOf(b) !== 'running'
    return (Number(aEnded) - Number(bEnded)) || (b.lastActive - a.lastActive)
  })
}

/**
 * 状态栏详情卡（设计稿 ④ J3tMzR「合并态下拉浮层」）：点击 status-pill 展开的
 * 会话统计浮层。结构自上而下（与设计稿逐段对应）：
 *   1. 标题行（状态点 + `会话统计 · <会话名>`）
 *   2. 3 列指标格 ×2 行：轮次/步骤（合并）· 工作时长 · LLM 思考
 *                       词元输入 · 词元输出 · 工具调用
 *   3. 两列图表：左 = 生成速度实时曲线（+ 平均 / 首词元平均）；右 = 上下文 donut + 图例
 *   4. 分隔线 + 子 Agent 列表（运行中在前，可点击进入子会话）
 *
 * 用户 2026-09-10 定调：轮次与步骤合并成 `X 轮 / X 步`；「LLM 思考」用
 * `sessionStats.llmMs`（= step/start → assistant/message，与工具调用相加 = 工作时长）；
 * 缓存命中与累计费用**不画曲线**（命中率数值仍在顶栏胶囊；基座无会话级费用投影）。
 *
 * 上下文 donut 的口径（修 2026-09-10 发现的 129% bug）：只画**当前占用**的构成
 * （对话消息 / 系统提示词 / 工具 / 未用，合计恒为 100%）。旧实现把累计账单量
 * `tokenUsage`（整段日志累加）和当前占用 `contextPressure.pressureTokens` 混在
 * 同一个饼里，四段相加 129.3%——几何上不成立。累计账单留在上方指标格的
 * 「词元输入/输出」。`contextBreakdown` 是启发式构成近似（基座注释：never as a total），
 * 故这里用它只表达占比，且与 pressureTokens 的差额归入「未用」以保证合计闭合。
 */
function AgentStatusDetail({ title, projections: p, anchor, roster, openSession, revealCard, speedSeries, worktrees }: {
  title: string
  projections: AgentSessionProjections | undefined
  /** 会话顶栏行在**包含块坐标系**中的盒子（left/width），详情卡据此水平居中
   *  （见 SessionStatusPill 的锚点测量注释：fixed 的包含块不是视口）。 */
  anchor: { left: number; width: number }
  /** 子 Agent 花名册（用户 2026-09-10：下拉浮层在下方追加 subagent 信息）。 */
  roster: readonly SubagentRosterEntry[]
  /** 打开会话（子 Agent 行点击 → 进入该子会话）。 */
  openSession?: ((sessionId: string) => void) | undefined
  /** 在父会话瀑布里定位子 Agent 卡（cordis 服务 chatRuntime 的窄化能力）。 */
  revealCard?: ((childSessionId: string) => Promise<RevealOutcome>) | undefined
  /** 生成速度采样序列（useSpeedSeries；空序列时曲线画基线占位）。 */
  speedSeries: readonly SpeedSample[]
  /** 隔离工作区台账（用户 2026-09-10：P8 后 chip 的新家 = 本浮层）。 */
  worktrees: readonly WorktreeEntry[]
}) {
  const stats = p?.sessionStats
  const usage = p?.tokenUsage
  const pressure = p?.contextPressure
  const breakdown = p?.contextBreakdown
  const turns = stats?.turns ?? 0
  const steps = stats?.steps ?? 0
  const llmMs = stats?.llmMs ?? 0
  const toolMs = stats?.toolMs ?? 0
  const active = llmMs + toolMs
  const input = (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)
  const output = usage?.outputTokens ?? 0
  const cacheRead = usage?.cacheReadTokens ?? 0
  const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0
  const ctxUsed = pressure?.pressureTokens ?? 0
  const ctxWindow = pressure?.contextWindow ?? 0
  const ctxPct = ctxWindow > 0 ? Math.round((ctxUsed / ctxWindow) * 1000) / 10 : 0
  const system = breakdown?.systemTokens ?? 0
  const tools = breakdown?.toolsTokens ?? 0
  const messages = breakdown?.messageTokens ?? 0
  // 平均解码速度（整段累计口径：decodeTokens / decodeMs）与首词元平均延迟。
  const decodeMs = stats?.decodeMs ?? 0
  const decodeTokens = stats?.decodeTokens ?? 0
  const avgTps = decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : 0
  const ttftSteps = stats?.ttftSteps ?? 0
  const avgTtftMs = ttftSteps > 0 ? (stats?.ttftMs ?? 0) / ttftSteps : 0
  // 当前占用构成（设计稿 chart-context 的 donut）：三段启发式 + 未用补数。
  //
  // ⚠️ 「未用」必须由**三段之和**反推，不能用 `ctxWindow - ctxUsed`：`ctxUsed`
  // （provider 锚定的 pressureTokens）与 `contextBreakdown` 的启发式三段是两个
  // 不同估计器，基座注释明确说二者**不会相等**。若拿 ctxUsed 求补数，图例四项
  // 之和会超过窗口上限（实测 1002.8k / 1000k），饼图几何上不成立——这正是旧实现
  // 四段相加 129% 的同类错误。这里以三段之和为分母保证**合计恒等于窗口**，
  // 环心仍显示权威占用率 ctxPct（两者微小差异属估计器固有，见基座注释）。
  const ctxParts = messages + system + tools
  const ctxFree = Math.max(0, ctxWindow - ctxParts)
  const ctxSum = ctxParts + ctxFree || 1
  const pctOf = (n: number): number => Math.round((n / ctxSum) * 1000) / 10
  // 曲线读数：latest = 最近一步速度（无序列时退回整段平均，避免空态显示「—」）；峰值 = 样本最大。
  const nowTps = speedSeries.length > 0 ? (speedSeries[speedSeries.length - 1]?.tps ?? avgTps) : avgTps
  const peakTps = speedSeries.length > 0 ? Math.max(...speedSeries.map(s => s.tps)) : 0
  // BUG-26：终态子 Agent / 已结工作区折叠。运行中条目**永不折叠**——
  // 真运行中的条目始终逐条渲染，不受折叠开关影响。
  const [terminalFoldOpen, setTerminalFoldOpen] = useState(false)
  const [worktreeFoldOpen, setWorktreeFoldOpen] = useState(false)
  // 子 Agent 终态判据 = 「有 outcome」**或** `entry.done`。必须两者取或：`done` 是宿主
  // 自己的终局标志（turn/end 落定、以及冷恢复时只存在于持久化里的 `inactive` 条目，
  // 见本文件 roster 组装的注释），而 `stopReason` 只在能拿到终局原因时才有——进程被杀 /
  // 冷恢复 / 异常结束的条目是 `done: true` + `stopReason: undefined`。旧实现只用
  // stopReason 分类，于是这些条目**行内已经显示「已完成」却永不折叠**：
  // 2026-09-12 真机实测（重启杀掉的 2 个子 Agent）浮层里就有 2 行这样的僵尸条目，
  // BUG-26 的「条目越多越看不全」在它们身上依旧复现。
  const rankedRoster = rankRoster(roster)
  const isTerminalEntry = (e: SubagentRosterEntry): boolean => subagentStateOf(e) !== 'running'
  const terminalEntries = rankedRoster.filter(isTerminalEntry)
  const runningEntries = rankedRoster.filter(e => !isTerminalEntry(e))
  // 四档计数都走**同一个 subagentStateOf**（2026-09-13 收口）：此前「完成」档用「不是
  // aborted 也不是 failed」反推，于是「已中断」被静静算进「已完成」——同一个终态在两处
  // 不同源，正是 BUG-31 的同族病。
  const terminalCompleted = terminalEntries.filter(e => subagentStateOf(e) === 'completed').length
  const terminalAborted = terminalEntries.filter(e => subagentStateOf(e) === 'aborted').length
  const terminalFailed = terminalEntries.filter(e => subagentStateOf(e) === 'failed').length
  const terminalInterrupted = terminalEntries.filter(e => subagentStateOf(e) === 'interrupted').length
  // 工作区：integrated/discarded 折叠；active/settled 始终单独渲染。
  const worktreeTerminal = worktrees.filter(e => e.status === 'integrated' || e.status === 'discarded')
  const worktreeActive = worktrees.filter(e => e.status === 'active' || e.status === 'settled')
  const worktreeIntegrated = worktreeTerminal.filter(e => e.status === 'integrated').length
  const worktreeDiscarded = worktreeTerminal.filter(e => e.status === 'discarded').length
  // 曲线：本条会话的真实逐步速度；空序列时弧长/顶点都退化，交给 SpeedChart 画基线。
  // 3 列指标格（设计稿 ④）：key 上 / value 下，两行共 6 项。
  const metrics: ReadonlyArray<readonly [string, string]> = [
    ['轮次 / 步骤', `${turns} 轮 / ${steps} 步`],
    ['工作时长 Active', compactDuration(active)],
    ['LLM 思考', compactDuration(llmMs)],
    ['词元输入 Input', compactTokens(input)],
    ['词元输出 Output', compactTokens(output)],
    ['工具调用 Tool', `${toolMs > 0 ? compactDuration(toolMs) : '—'}${hit > 0 ? ` · 命中 ${hit}%` : ''}`],
  ]
  return (
    <div
      className={css.statusDetail}
      role="dialog"
      aria-label="会话统计详情"
      style={{ left: anchor.left + anchor.width / 2 }}
    >
      <div className={css.statusDetailHead}>
        <span className={css.statusDetailDot} />
        <span className={css.statusDetailTitle}>会话统计 · {title}</span>
      </div>
      {/* 3 列指标格 ×2 行（设计稿 ④ mrow/stat/k/v）。 */}
      <div className={css.statusDetailGrid}>
        {metrics.map(([k, v]) => (
          <div key={k} className={css.statusDetailStat}>
            <span className={css.statusDetailStatKey}>{k}</span>
            <span className={css.statusDetailStatValue}>{v}</span>
          </div>
        ))}
      </div>
      {/* 图表两列（设计稿 ④ charts）：左 = 生成速度实时曲线，右 = 上下文 donut+图例。 */}
      <div className={css.statusDetailChartsRow}>
        {/* 生成速度（chart-speed）：实时曲线 + 平均 / 首词元平均。 */}
        <div className={css.statusDetailChartCol}>
          <span className={css.statusDetailChartColHead}>
            <span className={css.statusDetailChartColLabel}>生成速度</span>
            <span className={css.statusDetailChartColSpacer} />
            <span className={css.statusDetailPulse} />
            <span className={css.statusDetailChartLive}>{compactTps(nowTps)}</span>
          </span>
          <SpeedChart samples={speedSeries} width={300} height={138} />
          <span className={css.statusDetailSpeedFoot}>
            <span className={css.statusDetailSpeedItem}>
              <span className={css.statusDetailSpeedKey}>平均</span>
              <span className={css.statusDetailSpeedValue}>{compactTps(avgTps)}</span>
            </span>
            <span className={css.statusDetailSpeedItem}>
              <span className={css.statusDetailSpeedKey}>首词元平均</span>
              <span className={css.statusDetailSpeedValue}>{avgTtftMs > 0 ? compactDuration(avgTtftMs) : '—'}</span>
            </span>
            {peakTps > 0 && (
              <span className={css.statusDetailSpeedItem}>
                <span className={css.statusDetailSpeedKey}>峰值</span>
                <span className={css.statusDetailSpeedValue}>{compactTps(peakTps)}</span>
              </span>
            )}
          </span>
        </div>
        {/* 上下文占用（chart-context）：donut（构成占比，合计 100%）+ 图例。 */}
        <div className={css.statusDetailChartCol}>
          <span className={css.statusDetailChartColLabel}>
            上下文 Context{ctxWindow > 0 ? ` · 上限 ${compactTokens(ctxWindow)}` : ''}
          </span>
          {ctxWindow > 0 ? (
            <>
              <span className={css.statusDetailDonut} style={{
                background: `conic-gradient(var(--dsw-alias-brand-primary) 0deg ${pctOf(messages) * 3.6}deg, `
                  + `var(--dsw-alias-state-warn-primary) ${pctOf(messages) * 3.6}deg ${(pctOf(messages) + pctOf(system)) * 3.6}deg, `
                  + `var(--corum-brand-accent, #FF71CE) ${(pctOf(messages) + pctOf(system)) * 3.6}deg ${(pctOf(messages) + pctOf(system) + pctOf(tools)) * 3.6}deg, `
                  + `var(--corum-glass-2, rgba(42,24,64,.85)) ${(pctOf(messages) + pctOf(system) + pctOf(tools)) * 3.6}deg 360deg)`,
              }}>
                <span className={css.statusDetailDonutCenter}>
                  <span className={css.statusDetailDonutPct}>{ctxPct}%</span>
                  <span className={css.statusDetailDonutCap}>已用 {compactTokens(ctxUsed)}</span>
                </span>
              </span>
              <span className={css.statusDetailLegend}>
                {([
                  ['var(--dsw-alias-brand-primary)', '对话消息', messages],
                  ['var(--dsw-alias-state-warn-primary)', '系统提示词', system],
                  ['var(--corum-brand-accent, #FF71CE)', '工具', tools],
                  ['var(--corum-glass-2, rgba(42,24,64,.85))', '未用', ctxFree],
                ] as const).map(([color, label, n]) => (
                  <span key={label} className={css.statusDetailLegendRow}>
                    <span className={css.statusDetailLegendDot} style={{ background: color }} />
                    <span className={css.statusDetailLegendLabel}>{label}</span>
                    <span className={css.statusDetailLegendValue}>{compactTokens(n)}</span>
                  </span>
                ))}
              </span>
            </>
          ) : (
            <span className={css.statusDetailChartEmpty}>暂未上报上下文占用</span>
          )}
        </div>
      </div>
      <div className={css.statusDetailDivider} />
      {/* 子 Agent 区（用户 2026-09-10：下拉浮层在下方追加 subagent 信息，与统计同卡统一）。
           运行中在前、已结束在后；每行 = 状态点 + 标签 + Step + 前后台/隔离徽标，
           点击进入该子会话（官方 lineage 下拉已按「顶栏只保留一个下拉」屏蔽）。
           BUG-26：终态条目（completed/aborted/failed）默认折叠为一行摘要，
           点击展开；运行中（outcome === undefined）条目始终逐条渲染，永不折叠。 */}
      {roster.length > 0 && (
        <div className={css.statusDetailAgents}>
          <div className={css.statusDetailAgentsHead}>
            <span className={css.statusDetailAgentsTitle}>子 Agent</span>
            <span className={css.statusDetailAgentsCount}>
              {runningEntries.length} 运行中{' · '}
              {terminalCompleted} 已完成
              {terminalAborted > 0 && ` · ${terminalAborted} 已终止`}
              {terminalInterrupted > 0 && ` · ${terminalInterrupted} 已中断`}
              {terminalFailed > 0 && ` · ${terminalFailed} 失败`}
            </span>
          </div>
          {/* 运行中条目：始终逐条渲染（BUG-26 不变式）。 */}
          {runningEntries.map(entry => (
            <RosterRow key={entry.childSessionId} entry={entry} openSession={openSession} revealCard={revealCard} />
          ))}
          {/* 终态条目折叠摘要行（有终态条目时才出现）。 */}
          {terminalEntries.length > 0 && (
            <>
              <button
                type="button"
                className={css.statusDetailFoldRow}
                aria-expanded={terminalFoldOpen}
                aria-label={`已完成 ${terminalCompleted}·已终止 ${terminalAborted + terminalFailed}·已中断 ${terminalInterrupted}，${terminalFoldOpen ? '折叠' : '展开'}`}
                onClick={() => { setTerminalFoldOpen(v => !v) }}
              >
                <span className={css.statusDetailFoldChevron} aria-hidden="true">▸</span>
                已完成 {terminalCompleted}{' · '}已终止 {terminalAborted + terminalFailed}
                {terminalInterrupted > 0 && ` · 已中断 ${terminalInterrupted}`}
              </button>
              {terminalFoldOpen && (
                <div className={css.statusDetailFoldList}>
                  {terminalEntries.map(entry => (
                    <RosterRow key={entry.childSessionId} entry={entry} openSession={openSession} revealCard={revealCard} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {/* 并行工作区（隔离 worktree 台账）。用户 2026-09-10：P8 逐次成节点后卡内
           chip 会重复 N 份，故搬到本浮层——一个会话一处。数据源 = 宿主
           'corum/worktree-ledger' 转发帧（按父会话过滤）。
           BUG-26：integrated/discarded 条目默认折叠为一行摘要，点击展开；
           active/settled 条目始终逐条渲染，永不折叠。本区工作区行元素不改（另一任务管）。 */}
      {worktrees.length > 0 && (
        <div className={css.statusDetailAgents}>
          <div className={css.statusDetailAgentsHead}>
            <span className={css.statusDetailAgentsTitle}>并行工作区</span>
            <span className={css.statusDetailAgentsCount}>
              {worktreeActive.length} 待集成
              {' · '}
              {worktrees.length} 个隔离工作区
            </span>
          </div>
          {/* active/settled 条目：始终逐条渲染（BUG-26 不变式）。
              wt-8921e4：有 childSessionId 的条目渲染为可点 <button data-navigable>。 */}
          {worktreeActive.map(entry => {
            const childId = entry.childSessionId
            if (childId !== undefined) {
              return (
            <div
              className={css.statusDetailAgentRow}
              data-worktree
              data-navigable
              >
            <button
              type="button"
              className={css.statusDetailAgentHit}
              title={`进入子会话 ${childId}`}
              aria-label={`进入子会话 ${entry.branch}`}
              onClick={() => { openSession?.(childId) }}
            >
              <span className={css.statusDetailWorktreeIcon} aria-hidden="true">⑂</span>
              <span className={css.statusDetailAgentLabel} title={entry.branch}>{entry.branch}</span>
              <span className={css.statusDetailAgentStep}>{entry.slug}</span>
              <span className={css.statusDetailAgentBadge} data-model={entry.model?.model ?? '未记录'} title={entry.model !== undefined ? `模型提供方 ${entry.model.provider}` : '模型未记录'}>
                {entry.model?.model ?? '未记录'}
              </span>
              <span className={css.statusDetailAgentBadge} data-status={entry.status}>
                {worktreeStatusLabel(entry)}
              </span>
              <span className={css.statusDetailAgentGo} aria-hidden="true">→</span>
            </button>
            <RevealCardButton
              childSessionId={childId}
              label={entry.branch}
              revealCard={revealCard}
              fallback={openSession}
            />
          </div>
              )
            }
            // 无 childSessionId → 只读展示（不可点，保持灰态）。
            return (
            <div key={entry.slug} className={css.statusDetailAgentRow} data-worktree>
              <span className={css.statusDetailWorktreeIcon} aria-hidden="true">⑂</span>
              <span className={css.statusDetailAgentLabel} title={entry.branch}>{entry.branch}</span>
              <span className={css.statusDetailAgentStep}>{entry.slug}</span>
              <span className={css.statusDetailAgentBadge} data-model={entry.model?.model ?? '未记录'} title={entry.model !== undefined ? `模型提供方 ${entry.model.provider}` : '模型未记录'}>
                {entry.model?.model ?? '未记录'}
              </span>
              <span className={css.statusDetailAgentBadge} data-status={entry.status}>
                {worktreeStatusLabel(entry)}
              </span>
            </div>
          )
          })}
          {/* integrated/discarded 折叠摘要行（有终态条目时才出现）。 */}
          {worktreeTerminal.length > 0 && (
            <>
              <button
                type="button"
                className={css.statusDetailFoldRow}
                aria-expanded={worktreeFoldOpen}
                aria-label={`已集成 ${worktreeIntegrated}·已丢弃 ${worktreeDiscarded}，${worktreeFoldOpen ? '折叠' : '展开'}`}
                onClick={() => { setWorktreeFoldOpen(v => !v) }}
              >
                <span className={css.statusDetailFoldChevron} aria-hidden="true">▸</span>
                已集成 {worktreeIntegrated}{' · '}已丢弃 {worktreeDiscarded}
              </button>
              {worktreeFoldOpen && (
                <div className={css.statusDetailFoldList}>
                  {worktreeTerminal.map(entry => {
                    const childId = entry.childSessionId
                    if (childId !== undefined) {
                      return (
                    <div
                      className={css.statusDetailAgentRow}
                      data-worktree
                      data-navigable
                      >
                    <button
                      type="button"
                      className={css.statusDetailAgentHit}
                      title={`进入子会话 ${childId}`}
                      aria-label={`进入子会话 ${entry.branch}`}
                      onClick={() => { openSession?.(childId) }}
                    >
                      <span className={css.statusDetailWorktreeIcon} aria-hidden="true">⑂</span>
                      <span className={css.statusDetailAgentLabel} title={entry.branch}>{entry.branch}</span>
                      <span className={css.statusDetailAgentStep}>{entry.slug}</span>
                      <span className={css.statusDetailAgentBadge} data-model={entry.model?.model ?? '未记录'} title={entry.model !== undefined ? `模型提供方 ${entry.model.provider}` : '模型未记录'}>
                        {entry.model?.model ?? '未记录'}
                      </span>
                      <span className={css.statusDetailAgentBadge} data-status={entry.status}>
                        {worktreeStatusLabel(entry)}
                      </span>
                      <span className={css.statusDetailAgentGo} aria-hidden="true">→</span>
                    </button>
                    <RevealCardButton
                      childSessionId={childId}
                      label={entry.branch}
                      revealCard={revealCard}
                      fallback={openSession}
                    />
                  </div>
                      )
                    }
                    return (
                    <div key={entry.slug} className={css.statusDetailAgentRow} data-worktree>
                      <span className={css.statusDetailWorktreeIcon} aria-hidden="true">⑂</span>
                      <span className={css.statusDetailAgentLabel} title={entry.branch}>{entry.branch}</span>
                      <span className={css.statusDetailAgentStep}>{entry.slug}</span>
                      <span className={css.statusDetailAgentBadge} data-model={entry.model?.model ?? '未记录'} title={entry.model !== undefined ? `模型提供方 ${entry.model.provider}` : '模型未记录'}>
                        {entry.model?.model ?? '未记录'}
                      </span>
                      <span className={css.statusDetailAgentBadge} data-status={entry.status}>
                        {worktreeStatusLabel(entry)}
                      </span>
                    </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** `conversation.session.header.actions` occupant 的业务注入面。 */
export interface SessionStatusInjected {
  /** 统一事件中心 remote 面（子 Agent 花名册订阅源；缺省不渲染胶囊）。 */
  readonly remote?: RemoteEventFace | undefined
  /** 打开会话（浮层子 Agent 行点击 → 进入子会话）。 */
  readonly openSession: (sessionId: string) => void
  /** 在父会话瀑布里定位子 Agent 卡（缺省时跳转按钮只走退化路径）。 */
  readonly revealCard?: ((childSessionId: string) => Promise<RevealOutcome>) | undefined
  /**
   * RPC 面（隔离台账 + 子 Agent 花名册的冷启动基线：推送帧不重放，
   * 刷新后需主动拉一次）。结构窄化到「调用一个具名 RPC」——不 import
   * connection 包的具体类型（红线 3）。
   */
  readonly connection?: RpcFace | undefined
  /**
   * 官方 `ctx.sessions` 的直接子会话目录面（卷取子 Agent 花名册的 durable 基线）。
   * 缺省时花名册退化为「仅推送帧」——旧行为，不会报错。
   */
  readonly catalog?: SubagentCatalogFace | undefined
  /** 共享进度能力（由 index.tsx 从 bundle B 的 `chatRuntime` 服务窄化后注入）。 */
  readonly readChildProgress?: ReadChildProgress | undefined
}

/** `ctx.get('connection')` 的窄化面（只用到一元 RPC 调用）。 */
export interface RpcFace {
  rpc: {
    call: (ns: string, method: string, payload: { args: unknown }) => Promise<{
      ok: boolean
      value?: unknown
    }>
  }
}

/**
 * 状态胶囊 occupant 的完整 props（运行时 share 已含 sessionId + useSessions）。
 *
 * `useTrajectory` 由 corum-ui-trajectory 经
 * `declare module '@deepseek-ai/dsh-client-ui-slots'` 的 `SessionStandardProps`
 * 模块合并注入——本包不 import 该实现包（红线 3：跨 bundle 类型面用本地能力接口
 * 收窄），故这里用 `TrajectoryCapableProps` 显式并上钩子面；运行时由槽的
 * PropsRuntime 实际提供（已实机确认 ConversationSessionHeader 收到的 props 含
 * useTrajectory）。若精简装配里没装轨迹插件，该 prop 为 undefined，曲线退化为
 * 空态基线（不报错）。
 */
export type SessionStatusPillProps =
  PropsRuntime<'conversation.session.header.actions'>
  & SessionStatusInjected
  & TrajectoryCapableProps

/** 会话标准 props 里本组件消费的轨迹能力（本地能力接口，见上注释）。 */
export interface TrajectoryCapableProps {
  readonly useTrajectory?: UseTrajectoryHook | undefined
}

/**
 * 会话顶栏的 corum 状态段：状态胶囊（真实统计）+ 常驻子 Agent 胶囊 + 详情浮层。
 *
 * 锚点：详情浮层按**会话顶栏行的水平中心**居中——行在 `header` 元素内，主窗口
 * 与独立窗口都存在（独立窗口没有网格，故不能再用壳的会话列几何）。
 * @param props - 槽运行时 share（sessionId/useSessions/useTrajectory）+ 业务注入面。
 * @returns 状态胶囊与其展开的统计详情卡。
 */
export function SessionStatusPill({ sessionId, useSessions, remote, openSession, revealCard, useTrajectory, connection, catalog, readChildProgress }: SessionStatusPillProps) {
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [anchor, setAnchor] = useState({ left: 0, width: 0 })
  // 当前会话的统计投影（session/list 行 projectionValues）——真实数据。
  const projections = useSessions((s: SessionListState) => {
    return (s.byId as unknown as Readonly<Record<string, { projectionValues?: AgentSessionProjections }>>)[sessionId]?.projectionValues
  })
  const title = useSessions((s: SessionListState) => s.byId[sessionId]?.displayTitle) ?? '会话'
  // 子 Agent 花名册（2026-09-10 用户定调：胶囊与状态展示合并到同一 pill）。
  const roster = rankRoster(useSubagentRoster(remote, sessionId, useSessions, catalog, connection, readChildProgress))
  // 终态分组（四档全部走同一个 subagentStateOf；见 subagentStateOf 的优先级注释）。
  const running = roster.filter(e => subagentStateOf(e) === 'running')
  const completed = roster.filter(e => subagentStateOf(e) === 'completed')
  const aborted = roster.filter(e => subagentStateOf(e) === 'aborted')
  // 与浮层同源的一档（同一个 subagentStateOf）——胶囊不再把「已中断」算进「已完成」。
  const interruptedCount = roster.filter(e => subagentStateOf(e) === 'interrupted').length
  // 领跑者 = 运行中的第一个；全已结束时为 undefined（胶囊改显示终态计数）。
  const lead = running[0]
  // 全已结束时的胶囊主文案：取**真实占多数的那一档**，不写死「已完成 N」——
  // 全部被中断（已完成 0）时说「已完成 0」是假话（2026-09-13 收口）。
  const terminalHeadline = completed.length > 0
    ? `已完成 ${completed.length}`
    : aborted.length > 0
      ? `已终止 ${aborted.length}`
      : `已中断 ${interruptedCount}`
  // 生成速度序列（chart-speed 实时曲线）：来自轨迹快照的逐步真实速度。
  const speedSeries = useSpeedSeries(useTrajectory)
  // 隔离工作区台账（浮层「并行工作区」区；P8 后 chip 的新家）。
  const worktrees = useWorktreeLedger(remote, sessionId, connection)

  // 详情浮层锚点 = 会话顶栏行在视口中的水平中心（列宽变化/窗口缩放时重测）。
  // 上溯 <header>（会话插件 header 是行的宿主，两种窗口都在）；取不到则退回胶囊自身。
  //
  // ⚠️ 坑（2026-09-10 实测）：详情卡是 `position: fixed`，但它的**包含块不是视口**——
  // 会话列的 leaf 带 `will-change: transform`（GridView 的 .leaf），任何 transform/
  // will-change 都会为 fixed 后代建立包含块，于是内联 `left` 是**相对该 leaf** 的偏移。
  // 故本处把行矩形换算到**包含块坐标系**再存进 anchor（{left,width} 语义 = 行在
  // 包含块坐标系里的盒子），JSX 侧统一算 `left = anchor.left + width/2` 居中对齐。
  // 不换算会整体偏移一个「会话列左缘」的距离（实测偏 300px——旧实现量的是同一坐标系
  // 才碰巧没暴露）。
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (el === null) return undefined
    const measure = (): void => {
      const bar = el.closest('header') ?? el
      const rect = bar.getBoundingClientRect()
      // 包含块左缘：向上找第一个建立包含块的祖先（transform/will-change/filter/…），
      // 都没有则对视口（0）。fixed 的定位基点是该祖先的 padding box 左缘。
      let base = 0
      let node: HTMLElement | null = el.parentElement
      while (node !== null && node !== document.documentElement) {
        const cs = getComputedStyle(node)
        if (cs.transform !== 'none' || cs.willChange.includes('transform')
          || cs.filter !== 'none' || cs.backdropFilter !== 'none'
          || cs.perspective !== 'none' || cs.contain !== 'none') {
          base = node.getBoundingClientRect().left
          break
        }
        node = node.parentElement
      }
      const left = Math.round(rect.left - base)
      const width = Math.round(rect.width)
      setAnchor(prev => (prev.left === left && prev.width === width ? prev : { left, width }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  // 详情卡外点击关闭（Escape 同步关）。
  const detailRef = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    if (!detailOpen) return undefined
    const onPointerDown = (e: PointerEvent): void => {
      if (detailRef.current !== null && !detailRef.current.contains(e.target as Node)) setDetailOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setDetailOpen(false) }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [detailOpen])

  return (
    <>
      <span className={css.agentDivider} />
      {/* 状态胶囊（design.pen status-pill + GpfJh 详情卡）：真实统计 + 点击展开详情。 */}
      <span ref={wrapRef} className={css.agentStatusWrap}>
        <span ref={detailRef} className={css.agentStatusWrap}>
          <button
            type="button"
            className={css.agentStatusPill}
            aria-expanded={detailOpen}
            aria-label="会话统计，点击展开详情"
            onClick={() => { setDetailOpen(open => !open) }}
          >
            <span className={css.agentStatusDot} />
            <span className={css.agentStats}>{agentStatsSummary(projections)}</span>
            {/* 常驻子 Agent 胶囊（用户 2026-09-10 定调：放 Title 右边、与状态展示合并；
                2026-09-11 补充：**已运行结束的与编排模式下派出的子 Agent 也要显示**，
                所以这里不再只认「运行中」——只要名册非空就渲染这一段：
                  有运行中 → `运行中 N` + 领跑者 + `Step x` + `+K`（其余） + `M 已完成`
                  全已结束 → `已完成 M` + 最后一个 + `+K`
                终态判定走 stopReason（aborted 不算「已完成」）；名册本身是
                「会话血缘基线 + 推送帧增量」（见 useSubagentRoster）。 */}
            {roster.length > 0 && (
              <>
                <span className={css.agentCapsuleDivider} />
                <span className={css.agentCapsuleDot} data-done={lead === undefined ? 'true' : undefined} />
                <span className={css.agentCapsuleCount}>
                  {lead === undefined ? terminalHeadline : `运行中 ${running.length}`}
                </span>
                {lead !== undefined
                  ? (
                    <>
                      <span className={css.agentCapsuleLabel}>{lead.label}</span>
                      {/* step 为 0 = 目录基线还没收到 corum 进度帧，此时不假装知道步骤数。 */}
                      {lead.step > 0 && <span className={css.agentCapsuleStep}>Step {lead.step}</span>}
                      {running.length > 1 && <span className={css.agentCapsuleMore}>+{running.length - 1}</span>}
                      {completed.length > 0 && <span className={css.agentCapsuleDone}>{completed.length} 已完成</span>}
                      {aborted.length > 0 && <span className={css.agentCapsuleAborted}>{aborted.length} 手动终止</span>}
                      {interruptedCount > 0 && <span className={css.agentCapsuleAborted}>{interruptedCount} 已中断</span>}
                    </>
                  )
                  : (
                    <>
                      <span className={css.agentCapsuleLabel}>{roster[0]?.label}</span>
                      {roster.length > 1 && <span className={css.agentCapsuleMore}>+{roster.length - 1}</span>}
                      {aborted.length > 0 && <span className={css.agentCapsuleAborted}>{aborted.length} 手动终止</span>}
                      {interruptedCount > 0 && <span className={css.agentCapsuleAborted}>{interruptedCount} 已中断</span>}
                    </>
                  )}
              </>
            )}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`${css.agentChev}${detailOpen ? ` ${css.agentChevOpen}` : ''}`}><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {detailOpen && (
            <AgentStatusDetail
              title={title}
              projections={projections}
              anchor={anchor}
              roster={roster}
              openSession={openSession}
              revealCard={revealCard}
              speedSeries={speedSeries}
              worktrees={worktrees}
            />
          )}
        </span>
      </span>
    </>
  )
}

/** `conversation.session.header.utilities` occupant 的业务注入面。 */
export interface SessionTrajectoryInjected {
  /** 切换「轨迹」区域的显隐（壳网格区域；浮窗内为 no-op）。 */
  readonly toggleTrajectory: () => void
}

/** 轨迹按钮 occupant 的完整 props。 */
export type SessionTrajectoryButtonProps =
  PropsRuntime<'conversation.session.header.utilities'> & SessionTrajectoryInjected

/**
 * 会话顶栏右端：轨迹按钮。
 *
 * fork（corum）：轨迹是开发者功能——仅在「设置 → 高级 → 开发者模式」开启时可见
 * （用户 2026-09-09 定调）。独立窗口没有网格，`toggleTrajectory` 在浮窗内是
 * no-op（轨迹区域属于主窗口的网格树）。
 * @param props - 槽运行时 share + 轨迹切换动作。
 * @returns 轨迹按钮，或开发者模式关闭时的 null。
 */
export function SessionTrajectoryButton({ toggleTrajectory }: SessionTrajectoryButtonProps) {
  const developerMode = useDeveloperMode()
  if (!developerMode) return null
  return (
    <button
      type="button" className={css.agentTrajBtn} title="轨迹" aria-label="打开轨迹视图"
      onClick={() => { toggleTrajectory() }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
    </button>
  )
}

/**
 * 本模块供壳注册用的两个槽 occupant 描述（槽名 + id + 组件 + 注入面工厂）。
 *
 * 注册本身在 `index.tsx` 的 apply 内完成（那里有 `ctx.slots` 的精确类型与
 * `ctx.remote`/`ctx.sessions`/`ctx.layout` 闭包）；本常量只把「注册什么」与
 * 「怎么注册」分开，便于壳在两处复用同一份声明。
 */
export const SESSION_BAR_SLOTS = {
  status: 'conversation.session.header.actions',
  trajectory: 'conversation.session.header.utilities',
} as const

/** 槽 occupant 的注册 id（诊断用；同名槽由 conversation 插件声明）。 */
/**
 * 浮窗里的「收回到主窗口」按钮（占用会话顶栏右端同一个 utilities 槽）。
 *
 * 为什么放在会话顶栏而不是自绘 chrome：承载会话的浮窗**没有独立 chrome 行**
 * （会话顶栏卡片本身就是窗口顶栏，见 AppFrame 的 SELF_CHROME_FLOATING_SLOTS），
 * 所以只有落在这个右端簇里才不会和顶栏内容重叠。非浮窗（普通主窗）返回 null——
 * 这个按钮只在 `?floating=<slotKey>` 窗口里存在。
 *
 * 走 `corumDesktop.closeFloating(slotKey)`（2026-09-12 补的桥方法）：主进程
 * `win.close()` → 既有 `closed` 钩子通知主窗恢复被折叠的列，调用方不必自己改状态。
 */
export function FloatingCloseButton() {
  const slotKey = new URLSearchParams(window.location.search).get('floating')
  if (slotKey === null || slotKey === '') return null
  const bridge = (window as unknown as {
    corumDesktop?: { closeFloating?: (slotKey?: string) => Promise<unknown> }
  }).corumDesktop
  return (
    <button
      type="button"
      className={css.agentTrajBtn}
      title="收回到主窗口"
      aria-label="收回到主窗口"
      onClick={() => { void bridge?.closeFloating?.(slotKey) }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 3H5a2 2 0 0 0-2 2v4" /><path d="M15 21h4a2 2 0 0 0 2-2v-4" />
        <path d="M21 3l-7 7" /><path d="M3 21l7-7" />
      </svg>
    </button>
  )
}

export const SESSION_BAR_IDS = {
  status: 'corum-session-status',
  trajectory: 'corum-session-trajectory',
  floatingClose: 'corum-session-floating-close',
} as const

/** 轨迹按钮点亮的壳网格区域（corum-ide-ui 的轨迹区域槽）。 */
export const TRAJECTORY_REGION = 'corum.trajectory'
