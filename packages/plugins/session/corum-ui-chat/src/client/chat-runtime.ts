import type { SubagentTodoItem } from '@corum/corum-api-remotes/corum-events'
/**
 * fork（corum）：子 Agent 卡的「当前会话 id + RPC connection + 跳子会话桥」
 * 运行时服务（统一事件中心二期 window 全局迁移）。
 *
 * 原实现把这套动态值挂 window 全局（`__corumChatRuntime` / `__corumOpenSession`，
 * 见 apply.ts 旧版）——跨 bundle 共享可变状态挂 window 违反红线 1。本服务把它
 * 收敛为 cordis 服务 + uSES 源：
 *   - apply（激活期）`ctx.provide('chatRuntime', runtime)`——cordis 服务实例的
 *     唯一性由 root context `reflect.store` 保证，跨 bundle 天然单例
 *     （实证 .dbg/cordis-singleton-probe.md）。
 *   - 服务面：`sessionIdSnapshot()`（uSES getSnapshot 契约，稳定引用）+
 *     `onSessionIdChange(listener)`（uSES subscribe 契约）+ `connection`（只读
 *     引用）+ `openSession(id)`（替代 `__corumOpenSession`）。
 *   - SubagentCard（同 bundle 纯组件，无 inject 面）经下方模块级 `chatRuntimeRef`
 *     拿到服务实例——同 bundle 模块单例是合法的（不跨 bundle；cordis provide
 *     同时让其他 bundle 可 inject 本服务）。
 *
 * 时序（C1 教训）：cordis 模块顶层 = 加载期（apply 未跑），apply = 激活期。
 * 本服务的后端实例在 apply 才 new 出并写入 `chatRuntimeRef`——组件首次渲染晚于
 * 注册它的 slot 激活（apply 已跑），故渲染时 `chatRuntimeRef.current` 必然非空；
 * 防御性地保留「ref 未挂时返回 undefined」的窄化（与旧 window 全局未挂同语义）。
 *
 * 本文件保持 cordis-free（纯库纪律）：无任何 cordis import，Context 合并由
 * apply.ts 侧声明。
 *
 * 统一事件中心三-3：SubagentCard 的进度数据源从 2s 定时轮询迁移到
 * `ctx.remote.$on('corum/subagent/progress')` 推送（host corumAgent 在
 * `session/event` 追加点对 origin='subagent' 会话做 O(1) 增量折叠并 emit）。
 * 本服务的 remote 面引用 + 订阅登记（`subagentProgressSubscribe` 见下）即
 * 该推送通道进入本 bundle 的入口；订阅句柄记录活性供组件做降级判定。
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientRemote } from '@corum/corum-api-remotes/client'
import type { CorumWorktreeLedgerFrameEvent, SubagentChildEvent, SubagentProgressEvent } from '@corum/corum-api-remotes/corum-events'

/** uSES 源契约（getSnapshot 稳定引用 + subscribe）。 */
/**
 * 官方 `session/list` 行的**窄化形**（只承诺本仓消费的字段）。
 *
 * 单一事实源：卡片不再各自声明一份（原先 `SubagentCard` / `OrchestrateCard` 各有一份同形窄化）。
 */
/**
 * `corumAgent/getChildSessionProgress` 返回值的窄化形（只承诺卡片消费的字段）。
 */
export interface CorumChildProgressValue {
  readonly progress?: {
    readonly turn: number
    readonly step: number
    readonly currentAction?: string
    readonly done: boolean
    readonly stopReason?: string
    readonly interrupted?: boolean
    readonly todos?: readonly SubagentTodoItem[]
  }
}

/**
 * 子会话进度**终态**结果的缓存时长（ms）。
 *
 * 为什么要缓存（2026-09-28 实测，`docs/PENDING-ui-lag-multiround.md` §2.13）：卡片每次挂载（切会话、
 * 跳轮次、重渲染）都会拉一次基线，一轮动作实测 **128 次** `getChildSessionProgress`（~270 ms/次）。
 * 而**终态是稳定事实**（`done`）——同一批已结束的子会话会被反复拉，纯属重复劳动。
 * 只缓存终态：运行中的进度必须实时（推送帧 + 基线），缓存它会显示过期状态。
 */
export const CHILD_PROGRESS_TERMINAL_TTL_MS = 5 * 60_000

/**
 * Agent 目录快照（task 会话 → profileId、profileId → 显示名）。
 *
 * 为什么要合并成一次（2026-09-28 打包态实测，`docs/PENDING-ui-lag-multiround.md` §2.23）：
 * `apply.ts` 的 `getAgentName` 回调每被消费一次就发 `listTaskAgents` + `listProfiles` **两个** RPC；
 * 一次「打开重会话」实测各打 **6 次**（合计 ≈2.1 s 的主机工作）。这两份数据在一次交互里根本不变。
 */
export interface CorumAgentDirectory {
  /** task 会话 id → profileId。 */
  readonly taskProfiles: ReadonlyMap<string, string>
  /** profileId → 显示名（nickname 优先，其次 title）。 */
  readonly profileNames: ReadonlyMap<string, string>
}

/**
 * Agent 目录快照的缓存时长（ms）：profile 与会话归属在一次交互里不变，10 s 足够覆盖一轮挂载风暴。
 */
/**
 * Agent 目录快照的缓存时长（ms）。
 *
 * 取值依据（2026-09-28 实验）：一度用 10 分钟做「E1 是否生效」的判定实验 —— 结论是**页面里没跑这份代码**
 * （TTL 长短都不影响那 5+5 次调用），详见 `docs/PENDING-ui-lag-multiround.md` §2.23/§2.24。
 * 60 s：足够覆盖一轮挂载风暴，又不至于让 profile 改动长时间不被看到。
 */
export const AGENT_DIRECTORY_TTL_MS = 60_000

export interface CorumSessionListRow {
  readonly sessionId?: string
  readonly projections?: { readonly values?: { readonly modelSelection?: CorumModelSelectionProjection } }
}

/** `projections.values.modelSelection` 的窄化形。 */
export interface CorumModelSelectionProjection {
  readonly lastUsed?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
  readonly next?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
}

/**
 * 共享会话行的缓存时长（ms）。
 *
 * 为什么要缓存（2026-09-27 打包态实测）：卡片原先**各自**在挂载时调一次 `session/list`
 * （`limit: 200` ⇒ 实测 **651 KB / 1.3 s**）⇒ 47 轮会话 30+ 张卡片 = 同一份列表被拉几十次，
 * 主线程被大 payload 解析占满（`docs/PENDING-ui-lag-multiround.md` §2.10）。模型选择在会话
 * 生命周期内基本不变，故短 TTL 足够。
 */
export const SESSION_ROWS_TTL_MS = 15_000

export interface SessionIdSource {
  getSnapshot: () => string | undefined
  subscribe: (listener: () => void) => () => void
}

/** chatRuntime 服务面（cordis 服务 + SubagentCard 消费面）。 */
export interface ChatRuntimeService {
  /** 当前会话 id 的 uSES 源（getSnapshot 稳定引用；值不变时返回同一引用）。 */
  sessionIdSnapshot(): SessionIdSource
  /** 订阅会话 id 变化（uSES subscribe 契约；返回退订函数）。 */
  onSessionIdChange(listener: () => void): () => void
  /** RPC connection 只读引用（子会话进度基线/兜底拉取的数据源；可能尚未挂载）。 */
  readonly connection: ConnectionHandle | undefined
  /**
   * 官方 `session/list` 的**共享**读取：并发去重 + {@link SESSION_ROWS_TTL_MS} 缓存。
   *
   * @returns 行数组；无连接 / 调用失败时 `undefined`。
   */
  sessionRows(): Promise<readonly CorumSessionListRow[] | undefined>
  /**
   * 子会话进度基线（**终态结果共享缓存** + 并发去重）。
   *
   * @param sessionId - 子会话 id。
   * @returns 进度值；失败/无连接时 `undefined`。
   */
  childProgress(sessionId: string): Promise<CorumChildProgressValue | undefined>
  /**
   * 作废某个子会话的终态进度缓存（`corum/subagent/progress` 说它又在跑时调用）。
   *
   * @param sessionId - 子会话 id。
   */
  invalidateChildProgress(sessionId: string): void
  /**
   * Agent 目录快照（**并发去重 + TTL**）：一次交互里 `getAgentName` 会被消费多次，不能每次两个 RPC。
   *
   * @returns task 归属与 profile 显示名；无连接 / 失败时给空表（调用方按“未记录”降级）。
   */
  agentDirectory(): Promise<CorumAgentDirectory>
  /** Remote 事件面只读引用（'corum/subagent/progress' 推送订阅入口）。 */
  readonly remote: ClientRemote | undefined
  /** 跳子会话桥（替代 `__corumOpenSession`；官方 sessions.open 寻址，同步幂等）。 */
  openSession(id: string): void
  /**
   * 在**当前父会话瀑布**里把某个子 Agent 卡滚到视野中央并短暂高亮。
   *
   * 为什么需要它（用户 2026-09-18）：「主 Agent 的会话瀑布会冲走这些卡片」——会话时间线是
   * **事件窗口分页**的（窗口外的节点根本不渲染），所以详情卡「子 Agent」/「并行工作区」那些
   * 行光有「进入子会话」不够，用户还需要一个「就在这一页里带我去看那张卡」的入口。
   *
   * 与 `openSession` 的分工：本方法**不切换会话**，只在本页定位；找不到时如实返回原因，
   * 由调用方决定是否退化为 `openSession`。
   *
   * @param childSessionId - 子会话 id（与 `SubagentChildEvent.childSessionId` 同源）。
   * @returns 定位结果（含是否翻页、失败原因）。
   */
  revealSubagentCard(childSessionId: string): Promise<RevealSubagentCardResult>
  /**
   * 在内置编辑器打开「改动前后」diff tab（与 apply.ts ReviewDock 的 openDiff 同款，
   * 经 corumEditor cordis 服务直调）。SubagentChanges 用它打开子会话的文件改动对比。
   */
  openContentDiff?: (input: {
    absolutePath: string
    originalContent: string
    /** 改后内容的内存副本（审查卡在 worktree 已被回收时用；见 host `corumReview/fileAfter`）。 */
    modifiedContent?: string | undefined
    note?: string | undefined
  }) => Promise<{ ok: boolean; error?: string }>
  /**
   * 打开文件并滚动定位到指定行（「编辑未命中」卡候选行号点击跳转，2026-09-13）。
   * apply 注入（corumEditor.openFile + monaco-bridge reveal）。
   */
  openFileAtLine?: (path: string, line: number) => Promise<{ ok: boolean; error?: string }>
  /**
   * 当前（父）会话 cwd（2026-09-13 问题 1-③ 收口）。
   * SubagentChanges 非隔离 diff 打开的路径解析基准：resolveWorkspacePath(cwd, path)。
   * apply 在 view 挂载时注入（ctx.sessions.list 快照）；未注入时返回 undefined。
   */
  sessionCwd?: () => string | undefined
}

/**
 * 「在父会话瀑布里定位某个子 Agent 卡」的结果。
 *
 * ⚠️ 找不到时**必须**如实说明原因（`ok:false` + `reason`）：跳转按钮是用户的主诉动作，
 * 静默放弃会变成「点了没反应」。调用方据此给出可执行的下一步（见 session-bar 的按钮）。
 */
export interface RevealSubagentCardResult {
  readonly ok: boolean
  /**
   * 失败原因：
   *   - `not-ready`：瀑布视图还没挂载（服务已注入但列表不可用）；
   *   - `not-open`：当前打开的会话不是该卡的父会话（卡片根本不在这一页）；
   *   - `not-loaded`：会话历史已翻到头仍未找到该卡（卡片超出可加载范围）。
   */
  readonly reason?: 'not-ready' | 'not-open' | 'not-loaded'
  /** 实际向前翻了几页才找到（0 = 本来就在已加载窗口里）。 */
  readonly pagesLoaded?: number
}

/** 内部可变状态 + 监听器集（服务实现的私有后端）。 */
class ChatRuntimeImpl implements ChatRuntimeService {
  #sessionId: string | undefined
  #connection: ConnectionHandle | undefined
  #remote: ClientRemote | undefined
  #openSessionFn: (id: string) => void = () => {}
  #revealSubagentCardFn: ((childSessionId: string) => Promise<RevealSubagentCardResult>) | undefined
  readonly #listeners = new Set<() => void>()
  /** 共享会话行缓存（并发去重用的 in-flight promise 与它配对）。 */
  #sessionRowsCache: { readonly at: number; readonly rows: readonly CorumSessionListRow[] } | undefined
  #sessionRowsInFlight: Promise<readonly CorumSessionListRow[] | undefined> | undefined
  /** 终态进度缓存（sessionId → 值 + 写入时刻）。运行中的结果**不**进这里。 */
  readonly #terminalProgress = new Map<string, { readonly at: number; readonly value: CorumChildProgressValue }>()
  readonly #progressInFlight = new Map<string, Promise<CorumChildProgressValue | undefined>>()
  /** Agent 目录缓存（含 in-flight 复用）。 */
  #agentDirectory: { readonly at: number; readonly value: CorumAgentDirectory } | undefined
  #agentDirectoryInFlight: Promise<CorumAgentDirectory> | undefined
  /** uSES 源对象（稳定引用——getSnapshot/subscribe 闭包绑定本实例，值经 #sessionId 读）。 */
  readonly #source: SessionIdSource = {
    getSnapshot: () => this.#sessionId,
    subscribe: (fn) => this.onSessionIdChange(fn),
  }

  async sessionRows(): Promise<readonly CorumSessionListRow[] | undefined> {
    const cached = this.#sessionRowsCache
    if (cached !== undefined && Date.now() - cached.at < SESSION_ROWS_TTL_MS) return cached.rows
    const inFlight = this.#sessionRowsInFlight
    if (inFlight !== undefined) return inFlight
    const conn = this.#connection
    if (conn === undefined) return undefined
    const promise = (async () => {
      try {
        const result = await conn.rpc.call('/api', 'session/list', { args: { _request: { limit: 200 } } })
        if (!result.ok || result.value === undefined) return undefined
        const rows = (result.value as { items?: readonly CorumSessionListRow[] }).items ?? []
        this.#sessionRowsCache = { at: Date.now(), rows }
        return rows
      } catch {
        return undefined
      } finally {
        this.#sessionRowsInFlight = undefined
      }
    })()
    this.#sessionRowsInFlight = promise
    return promise
  }

  /**
   * 丢弃某个子会话的**终态**缓存（推送帧说「它又在跑了」时调用）。
   *
   * 为什么需要（2026-10-09 收口）：终态缓存只按 TTL 过期，不看后续事件。同一个子会话
   * 被重新唤醒/续跑时，`done:false` 的帧到了、卡片也翻回了 Running，但缓存里那份
   * 旧的 `done:true` 还活着——卡片一旦重新挂载（切会话、翻轮次）走 `fetchOnce` 兜底，
   * 就把 Running 盖回 Done（且最长持续 {@link CHILD_PROGRESS_TERMINAL_TTL_MS}）。
   * 缓存的前提是「终态是稳定事实」，而这条帧恰好证伪了那个前提。
   *
   * 刻意不做成 `childProgress` 的公开面：它是**帧通道内部**的失效钩子，不进跨 bundle 消费面。
   */
  invalidateChildProgress(sessionId: string): void {
    this.#terminalProgress.delete(sessionId)
  }

  async childProgress(sessionId: string): Promise<CorumChildProgressValue | undefined> {
    const cached = this.#terminalProgress.get(sessionId)
    if (cached !== undefined) {
      if (Date.now() - cached.at < CHILD_PROGRESS_TERMINAL_TTL_MS) return cached.value
      this.#terminalProgress.delete(sessionId)
    }
    const inFlight = this.#progressInFlight.get(sessionId)
    if (inFlight !== undefined) return inFlight
    const conn = this.#connection
    if (conn === undefined) return undefined
    const promise = (async () => {
      try {
        const result = await conn.rpc.call('/api', 'corumAgent/getChildSessionProgress', { args: { sessionId } })
        if (!result.ok || result.value === undefined) return undefined
        const value = result.value as CorumChildProgressValue
        // 只缓存**终态**：稳定事实，重复拉纯属浪费；运行中的进度必须实时。
        if (value.progress?.done === true || value.progress?.stopReason !== undefined) {
          this.#terminalProgress.set(sessionId, { at: Date.now(), value })
        }
        return value
      } catch {
        return undefined
      } finally {
        this.#progressInFlight.delete(sessionId)
      }
    })()
    this.#progressInFlight.set(sessionId, promise)
    return promise
  }

  async agentDirectory(): Promise<CorumAgentDirectory> {
    const cached = this.#agentDirectory
    if (cached !== undefined && Date.now() - cached.at < AGENT_DIRECTORY_TTL_MS) return cached.value
    const inFlight = this.#agentDirectoryInFlight
    if (inFlight !== undefined) return inFlight
    const conn = this.#connection
    const empty: CorumAgentDirectory = { taskProfiles: new Map(), profileNames: new Map() }
    if (conn === undefined) return empty
    const promise = (async () => {
      try {
        const taskProfiles = new Map<string, string>()
        const profileNames = new Map<string, string>()
        const tasks = await conn.rpc.call('/api', 'corumAgent/listTaskAgents', { args: {} })
        if (tasks.ok && tasks.value !== undefined) {
          for (const task of (tasks.value as { tasks?: readonly { sessionId?: string; profileId?: string }[] }).tasks ?? []) {
            if (task.sessionId !== undefined && task.profileId !== undefined) taskProfiles.set(task.sessionId, task.profileId)
          }
        }
        const profiles = await conn.rpc.call('/api', 'corumAgent/listProfiles', { args: {} })
        if (profiles.ok && profiles.value !== undefined) {
          for (const profile of (profiles.value as { profiles?: readonly { id?: string; nickname?: string; title?: string }[] }).profiles ?? []) {
            if (profile.id !== undefined) profileNames.set(profile.id, profile.nickname ?? profile.title ?? profile.id)
          }
        }
        const value: CorumAgentDirectory = { taskProfiles, profileNames }
        this.#agentDirectory = { at: Date.now(), value }
        return value
      } catch {
        return empty
      } finally {
        this.#agentDirectoryInFlight = undefined
      }
    })()
    this.#agentDirectoryInFlight = promise
    return promise
  }

  sessionIdSnapshot(): SessionIdSource {
    return this.#source
  }

  onSessionIdChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  get connection(): ConnectionHandle | undefined {
    return this.#connection
  }

  get remote(): ClientRemote | undefined {
    return this.#remote
  }

  openSession(id: string): void {
    this.#openSessionFn(id)
  }

  /**
   * ⚠️ 刻意写成**实例箭头属性**（不是原型方法）：本方法要被**另一个 bundle** 经窄化能力面
   * 消费（`corum-ide-ui` 拿到的是一个函数引用），摘下调用极易发生 —— 而原型方法体访问私有
   * 字段 `#revealSubagentCardFn`，receiver 一丢就抛
   * `Cannot read properties of undefined (reading '#revealSubagentCardFn')`
   * （同类缺陷见 `tests/chat-runtime-detached.spec.ts` 的记录）。绑定后摘不摘都安全。
   */
  readonly revealSubagentCard = (childSessionId: string): Promise<RevealSubagentCardResult> => {
    // 视图未挂载（未注入实现）时如实报 not-ready —— 调用方会退化为「进入子会话」。
    return this.#revealSubagentCardFn?.(childSessionId) ?? Promise.resolve({ ok: false, reason: 'not-ready' })
  }

  /** 瀑布视图挂载时注入定位实现（幂等；卸载时传 undefined 撤销）。 */
  setRevealSubagentCard(fn: ((childSessionId: string) => Promise<RevealSubagentCardResult>) | undefined): void {
    this.#revealSubagentCardFn = fn
  }

  /** apply 挂载时注入 remote 事件面（'corum/subagent/progress' 订阅入口，幂等）。 */
  setRemote(remote: ClientRemote): void {
    this.#remote = remote
  }

  /** apply 挂载时更新当前会话 id + connection（view 挂载即调；id 变化才广播）。 */
  setSession(sessionId: string | undefined, connection: ConnectionHandle | undefined): void {
    this.#connection = connection
    if (sessionId === this.#sessionId) return
    this.#sessionId = sessionId
    for (const fn of this.#listeners) fn()
  }

  /** apply 挂载时注入跳子会话桥（幂等）。 */
  setOpenSession(fn: (id: string) => void): void {
    this.#openSessionFn = fn
  }

  /** openContentDiff 桥（SubagentChanges 用；apply 注入，幂等）。 */
  #openContentDiff: ((input: { absolutePath: string; originalContent: string; modifiedContent?: string | undefined; note?: string | undefined }) => Promise<{ ok: boolean; error?: string }>) | undefined
  /** apply 挂载时注入 openContentDiff 桥（SubagentChanges 用；幂等）。 */
  setOpenContentDiff(fn: (input: { absolutePath: string; originalContent: string; modifiedContent?: string | undefined; note?: string | undefined }) => Promise<{ ok: boolean; error?: string }>): void {
    this.#openContentDiff = fn
  }
  /** SubagentChanges 经此桥打开 diff tab（apply 已注入 corumEditor 直调）。 */
  openContentDiff(input: { absolutePath: string; originalContent: string; modifiedContent?: string | undefined; note?: string | undefined }): Promise<{ ok: boolean; error?: string }> {
    if (this.#openContentDiff === undefined) return Promise.resolve({ ok: false, error: '编辑器服务未就绪' })
    return this.#openContentDiff(input)
  }

  /** openFileAtLine 桥（「编辑未命中」卡用；apply 注入，幂等）。 */
  #openFileAtLine: ((path: string, line: number) => Promise<{ ok: boolean; error?: string }>) | undefined
  /** apply 挂载时注入 openFileAtLine 桥（幂等）。 */
  setOpenFileAtLine(fn: (path: string, line: number) => Promise<{ ok: boolean; error?: string }>): void {
    this.#openFileAtLine = fn
  }
  /** 「编辑未命中」卡经此桥打开文件并定位行（apply 已注入 corumEditor + monaco reveal）。 */
  openFileAtLine(path: string, line: number): Promise<{ ok: boolean; error?: string }> {
    if (this.#openFileAtLine === undefined) return Promise.resolve({ ok: false, error: '编辑器服务未就绪' })
    return this.#openFileAtLine(path, line)
  }

  /** 当前会话 cwd 读取桥（apply 注入；问题 1-③ 收口，SubagentChanges diff 打开用）。 */
  #sessionCwdFn: (() => string | undefined) | undefined
  /** apply 挂载时注入 cwd 读取桥（幂等）。 */
  setSessionCwd(fn: () => string | undefined): void {
    this.#sessionCwdFn = fn
  }
  /** SubagentChanges 经此桥取当前会话 cwd（apply 已注入 sessions 快照读取）。 */
  sessionCwd(): string | undefined {
    return this.#sessionCwdFn?.()
  }
}

/**
 * 服务实例的同 bundle 模块级引用（SubagentCard 消费入口）。apply new 出实例后
 * 写入；同 bundle 模块单例是合法的（不跨 bundle）。cordis provide 让其他
 * bundle 可经 inject 拿同一实例。
 */
export const chatRuntimeRef: { current: ChatRuntimeImpl | null } = { current: null }

/** 创建服务实例（apply 调用；同时写入模块级 ref 供同 bundle 组件消费）。 */
export function createChatRuntime(): ChatRuntimeImpl {
  const impl = new ChatRuntimeImpl()
  chatRuntimeRef.current = impl
  return impl
}

// ── 子 Agent 进度推送（'corum/subagent/progress'）订阅登记 ──────────────────
//
// 单例 listener 集 + 懒挂底层 $on 订阅：SubagentCard 每张卡注册自己的帧监听，
// 首个订阅者挂载时才真正 `ctx.remote.$on`（remote 面由 apply 提前 setRemote
// 注入，组件挂载晚于 slot 激活，必然非空；防御性保留未挂判空），最后一个
// 退订时 dispose。帧计数经订阅句柄的 framesSeen() 暴露，供组件做「推送通道
// 活性」降级判定（宽限期内零帧 → 旧 host 不 emit → 回退 RPC 轮询）。

/** 订阅句柄：退订 + 活性读数（订阅存活期内全通道见过的推送帧数）。 */
export interface SubagentProgressSubscription {
  readonly unsubscribe: () => void
  readonly framesSeen: () => number
}

const subagentProgressListeners = new Set<(frame: SubagentProgressEvent) => void>()
let subagentProgressDispose: (() => void) | null = null
let subagentProgressFrames = 0

/**
 * 注册一个 'corum/subagent/progress' 帧监听（SubagentCard 每卡一个）。
 * @param listener - 帧回调（自行按 frame.sessionId 过滤本卡子会话）。
 * @returns 订阅句柄（退订 + 本订阅存活期内的推送帧计数）。
 */
export function subagentProgressSubscribe(
  listener: (frame: SubagentProgressEvent) => void,
): SubagentProgressSubscription {
  let framesAtStart = subagentProgressFrames
  subagentProgressListeners.add(listener)
  if (subagentProgressDispose === null) {
    const remote = chatRuntimeRef.current?.remote
    if (remote !== undefined) {
      subagentProgressDispose = remote.$on('corum/subagent/progress', (frame) => {
        subagentProgressFrames += 1
        // 帧说「turn 又开着」⇒ 旧的终态缓存已作废（同一子会话被重新唤醒/续跑）。
        // 不在这里失效的话，卡片重挂载时的 fetchOnce 会用旧终态把 Running 盖回 Done。
        // 只在 done===false 时失效：终态帧重复到达不该白白丢掉刚建立的缓存。
        if (frame.done === false) {
          chatRuntimeRef.current?.invalidateChildProgress(frame.sessionId)
        }
        for (const fn of subagentProgressListeners) fn(frame)
      })
    }
  }
  return {
    framesSeen: () => subagentProgressFrames - framesAtStart,
    unsubscribe: () => {
      subagentProgressListeners.delete(listener)
      framesAtStart = Number.POSITIVE_INFINITY // 退订后 framesSeen 不再误导降级判定。
      if (subagentProgressListeners.size === 0 && subagentProgressDispose !== null) {
        subagentProgressDispose()
        subagentProgressDispose = null
      }
    },
  }
}

// ── 'corum/worktree-ledger' 订阅（「并行工作区」chip 数据源；fork #10 发射）──
let worktreeLedgerDispose: (() => void) | null = null
const worktreeLedgerListeners = new Set<(frame: CorumWorktreeLedgerFrameEvent) => void>()

/** 注册一个 'corum/worktree-ledger' 帧监听（每 chip 一个；自行按 sessionId 过滤）。 */
export function worktreeLedgerSubscribe(
  listener: (frame: CorumWorktreeLedgerFrameEvent) => void,
): { unsubscribe: () => void } {
  worktreeLedgerListeners.add(listener)
  if (worktreeLedgerDispose === null) {
    const remote = chatRuntimeRef.current?.remote
    if (remote !== undefined) {
      worktreeLedgerDispose = remote.$on('corum/worktree-ledger', (frame) => {
        for (const fn of worktreeLedgerListeners) fn(frame)
      })
    }
  }
  return {
    unsubscribe: () => {
      worktreeLedgerListeners.delete(listener)
      if (worktreeLedgerListeners.size === 0 && worktreeLedgerDispose !== null) {
        worktreeLedgerDispose()
        worktreeLedgerDispose = null
      }
    },
  }
}

// ── 'corum/subagent/child' 订阅（卡片精确 childSessionId；fork #10 发射）──────
//
// 2026-09-09：卡片过去只能靠会话列表「时间就近」猜 childSessionId，运行期猜不
// 出来（父会话等工具结果 → 不产生事件 → 卡片不重算）→ goto 按钮恒 disabled、
// 进度帧也过滤不了。宿主在 spawn 那一刻按父侧 tool/call id 广播真实 id，卡片据
// 此在运行中即可跳转/订阅；历史回放仍走原有 summary 兜底匹配。
let subagentChildDispose: (() => void) | null = null
const subagentChildListeners = new Set<(frame: SubagentChildEvent) => void>()
/**
 * callId → 子会话身份（id + 前台/后台模式）进程内缓存
 * （本 bundle 单例；页面刷新后由 summary/args 兜底）。
 *
 * ⚠️ 必须支持**一个 callId 多个子会话**：`subagent` 是「一次调用一个子 Agent」，
 * 但 `orchestrate` 的 N 个任务**共享父侧同一个 callId**（宿主对每个任务都
 * `corumEmitChildStarted(..., exec.callId, ...)`），只是 label 不同。
 * 旧实现是 `Map<callId, 单条>`，后到的任务**覆盖**先到的 → orchestrate 卡上
 * 只有最后一个任务能拿到 childSessionId（goto 按钮因此只出现一个/不出现）。
 * 现按 `callId + '\u0000' + label` 复合键存，单发 delegation 行为不变。
 */
const subagentChildByCall = new Map<string, { readonly childSessionId: string; readonly mode: 'foreground' | 'background'; readonly worktree?: { readonly slug: string; readonly branch: string; readonly path: string } }>()
/** callId → 该调用观测到的全部子会话（保序，供 orchestrate 逐任务取值）。 */
const subagentChildrenByCall = new Map<string, { readonly childSessionId: string; readonly label: string; readonly mode: 'foreground' | 'background'; readonly worktree?: { readonly slug: string; readonly branch: string; readonly path: string } }[]>()
/** 缓存上限（超限按插入序淘汰最旧——长会话里 delegation 可能很多，防无界增长）。 */
const SUBAGENT_CHILD_CACHE_MAX = 1000

/** 复合键：同一 callId 下按 label 区分多个并发子会话。 */
function childKey(callId: string, label: string): string {
  return `${callId}\u0000${label}`
}

/**
 * 已观测到的精确子会话身份（'corum/subagent/child' 广播过即命中）。
 *
 * 供卡片与 conversation fold 在同一进程内复用精确映射——fold 过去只能按时间
 * 就近猜，多子 Agent 并行时会串；精确值优先、猜值兜底。`mode` 是宿主在 spawn
 * 那一刻定下的前台一次性 / 后台 agent（卡片据此显示徽标）。
 *
 * ⚠️ 不传 label 时返回**最后一个**观测到的子会话（单发 delegation 的兼容语义）；
 * orchestrate 这类一个 callId 多任务的场景请用 {@link subagentChildrenOf} 或
 * 传 label 精确取。
 * @param callId - 父侧 tool/call id。
 * @param label - 任务标签（orchestrate 的 `tasks[i].label`）；省略则取该 callId 最新一条。
 * @returns 子会话 id 与模式，未广播过时 undefined。
 */
export function subagentChildOf(
  callId: string,
  label?: string,
): { readonly childSessionId: string; readonly mode: 'foreground' | 'background'; readonly worktree?: { readonly slug: string; readonly branch: string; readonly path: string } } | undefined {
  if (label !== undefined) return subagentChildByCall.get(childKey(callId, label))
  const all = subagentChildrenByCall.get(callId)
  if (all !== undefined && all.length > 0) {
    const last = all[all.length - 1]
    return { childSessionId: last.childSessionId, mode: last.mode, ...last.worktree === undefined ? {} : { worktree: last.worktree } }
  }
  return subagentChildByCall.get(callId)
}

/**
 * 一个 callId 下观测到的全部子会话（orchestrate fan-out 逐任务取用）。
 *
 * 顺序 = 宿主 spawn 顺序（≈ `tasks[]` 顺序）；同 label 重复 spawn 时后者覆盖前者
 * （保持「一个 label 一个子会话」的语义）。
 * @param callId - 父侧 tool/call id。
 * @returns 子会话列表（可能为空）。
 */
export function subagentChildrenOf(callId: string): readonly { readonly childSessionId: string; readonly label: string; readonly mode: 'foreground' | 'background'; readonly worktree?: { readonly slug: string; readonly branch: string; readonly path: string } }[] {
  return subagentChildrenByCall.get(callId) ?? []
}

/** 注册一个 'corum/subagent/child' 帧监听（每卡一个；自行按 callId 过滤）。 */
export function subagentChildSubscribe(
  listener: (frame: SubagentChildEvent) => void,
): { unsubscribe: () => void } {
  subagentChildListeners.add(listener)
  if (subagentChildDispose === null) {
    const remote = chatRuntimeRef.current?.remote
    if (remote !== undefined) {
      subagentChildDispose = remote.$on('corum/subagent/child', (frame) => {
        subagentChildByCall.set(childKey(frame.callId, frame.label), {
          childSessionId: frame.childSessionId,
          mode: frame.mode,
          ...frame.worktree === undefined ? {} : { worktree: frame.worktree },
        })
        // 逐任务列表（orchestrate fan-out）：同 label 覆盖，新 label 追加。
        const list = subagentChildrenByCall.get(frame.callId) ?? []
        const index = list.findIndex(entry => entry.label === frame.label)
        const entry = {
          childSessionId: frame.childSessionId,
          label: frame.label,
          mode: frame.mode,
          ...frame.worktree === undefined ? {} : { worktree: frame.worktree },
        }
        if (index >= 0) list[index] = entry
        else list.push(entry)
        subagentChildrenByCall.set(frame.callId, list)
        if (subagentChildByCall.size > SUBAGENT_CHILD_CACHE_MAX) {
          const oldest = subagentChildByCall.keys().next().value
          if (oldest !== undefined) subagentChildByCall.delete(oldest)
        }
        if (subagentChildrenByCall.size > SUBAGENT_CHILD_CACHE_MAX) {
          const oldest = subagentChildrenByCall.keys().next().value
          if (oldest !== undefined) subagentChildrenByCall.delete(oldest)
        }
        for (const fn of subagentChildListeners) fn(frame)
      })
    }
  }
  return {
    unsubscribe: () => {
      subagentChildListeners.delete(listener)
      if (subagentChildListeners.size === 0 && subagentChildDispose !== null) {
        subagentChildDispose()
        subagentChildDispose = null
      }
    },
  }
}

/**
 * apply 激活期提前建立订阅：即使卡片尚未挂载，spawn 广播也会进缓存——卡片挂载后
 * 经 {@link subagentChildOf} 立刻拿到精确 id（避免「广播早于订阅」的竞态）。
 * @returns 退订函数（挂到 ctx.effect 随插件生命周期释放）。
 */
export function primeSubagentChildCache(): () => void {
  return subagentChildSubscribe(() => {}).unsubscribe
}

/**
 * apply 激活期提前订阅 `corum/subagent/progress`：**只为让终态缓存失效保持常开**。
 *
 * 为什么必须提前挂（2026-10-09）：失效动作写在共享 `$on` 的回调里，而那条 `$on` 是
 * 「首个订阅者到达才挂」的懒订阅。用户报告的场景恰恰发生在**卡片没挂载**的时候
 * （子会话已结束、卡片已滚出视野，父 Agent 又重新派发它）——那种时刻没有订阅者，
 * 帧根本不到，失效也就不会发生，卡片再挂载时仍然读到旧终态。这里挂一个空监听把
 * 通道点亮，让「重新在跑」这件事总能作废缓存。
 *
 * @returns 退订函数（挂到 ctx.effect 随插件生命周期释放）。
 */
export function primeSubagentProgressChannel(): () => void {
  return subagentProgressSubscribe(() => {}).unsubscribe
}
