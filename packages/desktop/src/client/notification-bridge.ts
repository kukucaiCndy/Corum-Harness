/**
 * 事件 → 通知桥（corum-desktop）：把「用户真正关心」的领域事件接进通知栏。
 *
 * 背景（2026-09-10 用户「我怎么没看到通知栏呢…要把一些常用的事件接入通知栏」）：
 * 通知通道本身早就通了（`notifications.ts` + `NotificationHost`），但**只有两个
 * 消费方**——HMR 失败与两处聊天错误路径，全是罕见失败分支。于是通知栏在日常使用中
 * 从不出现，用户根本看不到它。本模块补上「常用事件」这一层。
 *
 * 选型原则（三条，避免把通知栏做成噪音源）：
 *   ① **只接「用户需要知道、且不在当前视野里」的事件**——异步完成、失败、需要决策。
 *      高频过程事件（`corum/terminal/output`、`corum/file/changed`、
 *      `corum/subagent/progress`）**一律不接**：它们每帧都可能变，接了就是刷屏。
 *   ② **同键去重**：同一实体（同一子会话 / 同一任务 / 同一 worktree）的同类事件
 *      合并成一条并刷新其内容，而不是不断堆新条（否则一次 orchestrate 会吐 N 条）。
 *   ③ **可点击跳转**：通知带 `sessionId` 时，点整条即打开来源会话
 *      （`ctx.sessions.open`）——这是通知从「提示」变成「入口」的关键。
 *
 * 接入清单（`docs/TODO.md` 的「通知栏接入常用事件」）：
 *   - `corum/task/completed`     任务闭环        → success「任务完成」
 *   - `corum/task/stalled`       任务卡住        → warn「任务疑似卡住」
 *   - `corum/task/blocked`       任务遇阻        → warn「任务被阻塞」
 *   - `corum/task/deferred`      派发失败重试    → warn「派发失败，已重试」
 *   - `corum/task/evicted`       未执行被逐出    → error「任务被逐出队列」
 *   - `corum/task/cancelled`     任务中止        → warn「任务已中止」
 *   - `corum/subagent/child` + `corum/subagent/progress` → 子 Agent 完成（同键合并）
 *   - `corum/worktree-ledger`    隔离分支待集成  → info（同 session 合并）
 *   - `corum/artgen/download-progress` / `corum/ollama/download-progress`
 *                                下载完成/失败   → success/error（同槽位合并）
 *
 * @module corum-desktop/client/notification-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { NotificationStore, NotificationTone } from './notifications.ts'
import { isFloatingWindow } from './window-role.ts'
import { subagentOutcomeOf, subagentOutcomeTone } from '@corum/corum-api-remotes/corum-events'
import type { SubagentStopReason } from '@corum/corum-api-remotes/corum-events'

/** `ctx.remote` 的窄化面（只用到转发事件订阅）。 */
interface RemoteFace {
  $on: (event: string, listener: (frame: never) => void) => () => void
}

/** 发通知所需的最小会话打开面（`ctx.sessions.open`）。 */
interface SessionsFace {
  open: (sessionId: never) => void
}

/** 事件帧里可能出现的会话身份字段（按事件类型取其一）。 */
interface SessionBearing {
  sessionId?: string
  resultRef?: { sessionId?: string }
  task?: { sessionId?: string; label?: string; id?: string }
}

/** 任务事件帧（`corum/task/*` 的并集窄化）。 */
interface TaskFrame extends SessionBearing {
  task?: {
    id?: string
    label?: string
    entityId?: string
    profileId?: string
  }
  /** `corum/task/completed` 的完成说明（complete_task 上报原文）。 */
  result?: string
  reason?: string
  idleSec?: number
  fate?: string
  sessionId?: string
}

/** 子 Agent 进度帧（`corum/subagent/progress`）。 */
interface SubagentProgressFrame {
  sessionId?: string
  turn?: number
  step?: number
  currentAction?: string
  stopReason?: string
}

/** 子 Agent spawn 帧（`corum/subagent/child`）。 */
interface SubagentChildFrame {
  parentSessionId?: string
  callId?: string
  childSessionId?: string
  label?: string
  mode?: 'foreground' | 'background'
}

/**
 * 「子 Agent 半途失去运行」帧（`corum/subagent/interrupted`）。
 *
 * 与 progress 帧的区别：它**不是事件驱动**的，而是宿主在读取进度时判出事实后补发的
 * 一次性广播（见 corum-api-remotes 的 `SubagentInterruptedEvent` 注释）。
 */
interface SubagentInterruptedFrame {
  sessionId?: string
  parentSessionId?: string
  reason?: 'not-running' | 'pre-boot'
  turn?: number
  step?: number
}

/** 隔离台账帧（`corum/worktree-ledger`）。 */
interface WorktreeLedgerFrame {
  sessionId?: string
  entries?: ReadonlyArray<{ slug?: string; branch?: string; status?: string }>
  pending?: number
}

/** 下载进度帧（artgen / ollama 共用字段子集）。 */
interface DownloadFrame {
  key?: 'engine' | 'model'
  percent?: number
  status?: string
  error?: string
  target?: string
}

/** 沉淀完成帧（`corum/distill/completed`）。 */
interface DistillCompletedFrame {
  jobId?: string
  sessionId?: string
  factCount?: number
}

/** `ctx.layout` 的窄化面（只用到 openSettingsSection）。 */
interface LayoutFace {
  openSettingsSection: (id: string) => void
}

/**
 * 去重键 → 已发通知 id 的登记表。
 *
 * ⚠️ 为什么在模块级（而非闭包里）：同一个键的事件可能跨越多次 `apply`
 * （插件重载）；放模块级保证重载后仍能续用同一条通知、不重复堆。
 * 这是「进程内 UI 记账」，不是跨 bundle 共享状态，故不违反红线 1。
 */
const liveByKey = new Map<string, string>()

/** 取任务的展示名（label 优先，兜底 id 末段）。 */
function taskLabel(frame: TaskFrame): string {
  const label = frame.task?.label
  if (label !== undefined && label !== '') return label
  const id = frame.task?.id
  if (id !== undefined && id !== '') return id.length > 18 ? `${id.slice(0, 18)}…` : id
  return '未命名任务'
}

/** 取帧里携带的会话 id（任务事件给 resultRef.sessionId，子 Agent 给 sessionId）。 */
function frameSessionId(frame: SessionBearing): string | undefined {
  return frame.sessionId ?? frame.resultRef?.sessionId ?? frame.task?.sessionId
}

/** 截断长文案（通知副文案是单行，过长会被 ellipsis 吃掉关键信息）。 */
function clip(text: string, max = 90): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** 高亮态持续时长（ms）：到点后撤销 data-reveal。 */
const REVEAL_HIGHLIGHT_MS = 1600
/** 滚到卡片的重试上限（每次 rAF，约 20 帧 ≈ 1s 内找到即停）。 */
const REVEAL_MAX_ATTEMPTS = 20

/**
 * 在同文档里按 childSessionId 找到子 Agent 卡片并滚动到它、短暂高亮。
 *
 * 两个 bundle 跑在同一个 renderer document 里，故 DOM 查询直连。sessions.open
 * 后 React 重渲染是异步的，卡片可能还没挂载 → rAF 重试，找到即停、找不到静默
 * 放弃（导航本身已发生，不报错）。高亮用临时 `data-reveal` 属性 + CSS 动画，
 * 到点撤销，不留持久态。
 */
function revealSubagentCard(childSessionId: string): void {
  const selector = `[data-child-session-id="${CSS.escape(childSessionId)}"]`
  let attempts = 0
  const tryReveal = (): void => {
    attempts += 1
    const card = document.querySelector(selector)
    if (card !== null) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' })
      card.setAttribute('data-reveal', '')
      setTimeout(() => { card.removeAttribute('data-reveal') }, REVEAL_HIGHLIGHT_MS)
      return
    }
    if (attempts < REVEAL_MAX_ATTEMPTS) {
      requestAnimationFrame(tryReveal)
    }
  }
  requestAnimationFrame(tryReveal)
}

/** 发布/更新一条通知（同键合并：已有则先撤旧的再发新的）。 */
function publish(
  store: NotificationStore,
  key: string,
  input: { tone: NotificationTone; title: string; message?: string },
  onOpen?: (() => void) | undefined,
): void {
  const previous = liveByKey.get(key)
  if (previous !== undefined) {
    store.dismiss(previous)
    liveByKey.delete(key)
  }
  const id = store.notify({
    tone: input.tone,
    title: input.title,
    ...input.message === undefined ? {} : { message: input.message },
    ...onOpen === undefined ? {} : { onOpen },
  })
  // 偏好拦截期（勿扰/总开关关）notify 返回 ''：不登记 ⇒ 偏好恢复后同键
  // 新事件不会被「撤旧条」逻辑误伤，也不会留下指向不存在通知的死登记。
  if (id !== '') liveByKey.set(key, id)
}

/** `window.corumDesktop` 的窄化面（只用到系统通知两项；本地能力接口，红线 3）。 */
interface NativeNotifyBridge {
  notifyNative?: (request: {
    title: string
    body?: string
    silent?: boolean
    notificationId?: string
  }) => Promise<{ ok: boolean; error?: string }>
  onNativeNotificationClick?: (callback: (payload: { notificationId: string | null }) => void) => () => void
}

/** 取桌面桥（非桌面壳环境返回 undefined，调用方静默降级）。 */
function nativeBridge(): NativeNotifyBridge | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { corumDesktop?: NativeNotifyBridge }).corumDesktop
}

/**
 * 把应用内通知**镜像到 macOS 系统通知中心**（2026-09-10 用户定调「先做 macOS」）。
 *
 * 三条设计规则（决定用户体验好坏，不是可选项）：
 *   ① **只在窗口失焦/隐藏时发**——窗口在前台时应用内 toast 已经够，再弹系统通知
 *      是重复打扰。判据 `document.hasFocus() && document.visibilityState === 'visible'`。
 *   ② **点击走既有 `onOpen` 通路**——主进程负责唤醒窗口，renderer 收到点击回传后
 *      调用 `store.open(id)`，于是「打开来源会话」等动作全部复用，无需第二套语义。
 *   ③ **失败静默降级**——非 macOS / 权限被拒 / 平台不支持时 `notifyNative` 返回
 *      `ok:false`，应用内 toast 仍在，用户不会失去信息（只是少了系统级提示）。
 *
 * @param store - 通知 store（作为「新通知出现」的事件源）。
 * @returns 退订函数。
 */
export function installNativeNotificationMirror(store: NotificationStore): () => void {
  // 同样只装主窗（浮窗没有通知 UI，也无从判断全局焦点语义）。
  if (isFloatingWindow()) return () => {}
  const bridge = nativeBridge()
  if (bridge?.notifyNative === undefined) return () => {}

  // 已镜像过的通知 id（store 是快照订阅，同一条会在多次 emit 里重复出现）。
  const mirrored = new Set<string>()

  // 点击回传：主进程已唤醒窗口，这里执行通知自带的动作。
  const disposeClick = bridge.onNativeNotificationClick?.((payload) => {
    const id = payload.notificationId
    if (id === null || id === '') return
    store.open(id)
    store.setPanelOpen(false)
  }) ?? (() => {})

  const unsubscribe = store.subscribe(() => {
    const next = store.getSnapshot()
    // 窗口在前台：不镜像（应用内 toast 已足够）。
    const focused = typeof document !== 'undefined'
      && document.hasFocus()
      && document.visibilityState === 'visible'
    if (!focused) {
      for (const item of next) {
        if (mirrored.has(item.id)) continue
        mirrored.add(item.id)
        void bridge.notifyNative?.({
          title: item.title,
          ...item.message === undefined ? {} : { body: item.message },
          notificationId: item.id,
        })
      }
    } else {
      // 前台时也登记 id：切到后台后不该把「刚才前台已看到」的旧通知补弹一遍。
      for (const item of next) mirrored.add(item.id)
    }
  })

  // 首帧快照（挂载前已存在的通知不补发——它们多半已被看到）。
  for (const item of store.getSnapshot()) mirrored.add(item.id)

  return () => {
    unsubscribe()
    disposeClick()
  }
}

/**
 * 把常用事件接进通知栏。
 *
 * 调用方应在 `ctx.inject(['remote','sessions','notifications'], …)` 内调用，
 * 并把返回的清理函数挂到 `ctx.effect`（随插件生命周期退订）。
 * @param ctx - 已解析出 three 个依赖的上下文。
 * @param store - 通知 store（`ctx.notifications`）。
 * @returns 退订函数。
 */
export function installNotificationBridge(ctx: Context, store: NotificationStore): () => void {
  // 通知是**应用级能力，只归属主窗口**（用户 2026-09-10 定调：「悬浮窗只在主窗口，
  // 拖出会话后，通知也只通知到主窗口」）。
  //
  // ⚠️ 为什么必须在这里拦：浮窗与主窗**同源同 bundle**，两边的 `ctx.remote`
  // 都订阅同一批宿主事件；而每个窗口各有**独立的 store 实例**（renderer 进程隔离）。
  // 浮窗虽然以 `direct` 档挂了 toast（保留本窗直接反馈），但**全局事件不该进浮窗**：
  // 同一事件会在两处各弹一份，而浮窗没有 bell / 通知中心，条目 5s 后即销毁 →
  // 用户回头去主窗找时反而没有（真正的信箱只该在主窗）。故事件桥只装主窗。
  if (isFloatingWindow()) return () => {}
  const remote = ctx.get('remote') as RemoteFace | undefined
  const sessions = ctx.get('sessions') as SessionsFace | undefined
  const layout = ctx.get('layout' as never) as unknown as LayoutFace | undefined
  if (remote === undefined) return () => {}

  /** 打开来源会话（无 sessions 面或 sessionId 时不挂跳转）。 */
  const opener = (sessionId: string | undefined): (() => void) | undefined => {
    if (sessionId === undefined || sessionId === '' || sessions === undefined) return undefined
    return () => { sessions.open(sessionId as never) }
  }

  /**
   * 子 Agent 通知的点击动作：先打开**父会话**（卡片的家），再在同文档里按
   * childSessionId 找到子 Agent 卡片、滚到它、短暂高亮。
   *
   * 判定顺序的理由：卡片挂在父会话的瀑布里，所以父会话是定位的锚点；
   * 没有 parentSessionId 时退回打开子会话本身——至少让用户到达那个会话，
   * 只是看不到卡片上下文。sessions.open 后 React 重渲染是异步的，卡片可能
   * 还没挂载，故用 rAF 重试（最多约 20 次 / 1s），找到即停、找不到静默放弃
   * （导航已发生，不报错）。
   */
  const subagentOpener = (
    parentSessionId: string | undefined,
    childSessionId: string | undefined,
  ): (() => void) | undefined => {
    if (sessions === undefined) return undefined
    // 有父会话：打开父会话 + 滚到卡片。
    if (parentSessionId !== undefined && parentSessionId !== '') {
      return () => {
        sessions.open(parentSessionId as never)
        if (childSessionId === undefined || childSessionId === '') return
        revealSubagentCard(childSessionId)
      }
    }
    // 无父会话：退回打开子会话本身（至少到达那个会话）。
    if (childSessionId !== undefined && childSessionId !== '') {
      return () => { sessions.open(childSessionId as never) }
    }
    return undefined
  }

  const disposers: Array<() => void> = []
  const on = <T>(event: string, handler: (frame: T) => void): void => {
    disposers.push(remote.$on(event, handler as (frame: never) => void))
  }

  // ── 任务事件（corum/task/*）────────────────────────────────────────────
  on<TaskFrame>('corum/task/completed', (frame) => {
    const label = taskLabel(frame)
    publish(store, `task:${frame.task?.id ?? label}:completed`, {
      tone: 'success',
      title: '任务完成',
      message: clip(frame.result ?? `${label} 已闭环`),
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/stalled', (frame) => {
    const label = taskLabel(frame)
    const idle = frame.idleSec
    publish(store, `task:${frame.task?.id ?? label}:stalled`, {
      tone: 'warn',
      title: '任务疑似卡住',
      message: idle === undefined ? label : `${label} · 已 ${Math.round(idle)}s 无活动`,
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/blocked', (frame) => {
    const label = taskLabel(frame)
    publish(store, `task:${frame.task?.id ?? label}:blocked`, {
      tone: 'warn',
      title: '任务被阻塞',
      message: clip(`${label}：${frame.reason ?? '等待前置信息'}`),
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/deferred', (frame) => {
    const label = taskLabel(frame)
    publish(store, `task:${frame.task?.id ?? label}:deferred`, {
      tone: 'warn',
      title: '派发失败，已放回队列重试',
      message: clip(`${label}：${frame.reason ?? '未知原因'}`),
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/evicted', (frame) => {
    const label = taskLabel(frame)
    publish(store, `task:${frame.task?.id ?? label}:evicted`, {
      tone: 'error',
      title: '任务被逐出队列',
      message: clip(frame.reason === undefined ? `${label} 未执行即被逐出` : `${label}：${frame.reason}`),
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/cancelled', (frame) => {
    const label = taskLabel(frame)
    const fate = frame.fate
    publish(store, `task:${frame.task?.id ?? label}:cancelled`, {
      tone: 'warn',
      title: '任务已中止',
      message: `${label}${fate === undefined ? '' : ` · ${fate}`}`,
    }, opener(frameSessionId(frame)))
  })

  // ── 子 Agent：spawn 记账 + 结算通知（同 callId 合并）──────────────────
  //
  // 机制：`corum/subagent/child`（spawn 那一刻的精确父子映射）建账，
  // `corum/subagent/progress`（子会话事件增量折叠）按 stopReason 判终态，
  // 仅在 settle 时发通知。启动提示属于「已经知道的事」（父 Agent 刚派发），
  // 且 orchestrate 会一次派 N 个，逐条提示就是刷屏（选型原则①）。
  const childLabels = new Map<string, { label: string; parentSessionId?: string }>()
  on<SubagentChildFrame>('corum/subagent/child', (frame) => {
    const child = frame.childSessionId
    if (child === undefined || child === '') return
    childLabels.set(child, {
      label: frame.label === undefined || frame.label === '' ? '子 Agent' : frame.label,
      ...frame.parentSessionId === undefined ? {} : { parentSessionId: frame.parentSessionId },
    })
  })

  // 「子 Agent 半途失去运行」：宿主在**发现点**（读进度时判出）补发的一次性广播。
  // 用户 2026-09-13 定调：这种情况要提示，不能静默——它意味着那一轮工作没有产出，
  // 而推送帧永远不会带这条事实（它是对「上个进程生命周期留下的未闭合 turn」的判定，
  // 不是事件）。色调取 warn，与「手动终止」同档：都不是成功。
  //
  // **按父会话合并成一条**（选型原则①：同一批不刷屏）：一次重启会留下 N 个被中断的
  // 子 Agent（本机实测 9 个），逐条提示就是连刷 9 个 toast。故 key 按父会话复用
  // ——`publish` 对同 key 是「替换」语义，于是同一条通知的文案随计数更新。
  const interruptedCounts = new Map<string, number>()
  on<SubagentInterruptedFrame>('corum/subagent/interrupted', (frame) => {
    const child = frame.sessionId
    if (child === undefined || child === '') return
    const known = childLabels.get(child)
    childLabels.delete(child)
    const parent = known?.parentSessionId ?? frame.parentSessionId
    const key = `subagent:interrupted:${parent ?? child}`
    const seen = (interruptedCounts.get(key) ?? 0) + 1
    interruptedCounts.set(key, seen)
    publish(store, key, {
      tone: 'warn',
      title: '子 Agent 已中断',
      message: clip(seen > 1 ? `${seen} 个子 Agent · 上次运行未正常结束` : `${known?.label ?? '子 Agent'} · 上次运行未正常结束`),
    }, subagentOpener(parent, child))
  })

  on<SubagentProgressFrame>('corum/subagent/progress', (frame) => {
    // 合法化跨包 JSON 面的 stopReason（不认识的字符串不当成功）。
    const VALID_STOP_REASONS = new Set(['completed', 'aborted', 'error', 'max-tokens', 'refusal'])
    const sr = frame.stopReason !== undefined && VALID_STOP_REASONS.has(frame.stopReason)
      ? frame.stopReason as SubagentStopReason
      : undefined
    const outcome = subagentOutcomeOf(sr)
    if (outcome === undefined) return // 还在跑不提示（保持「只在结束时提示」的既有选型）。
    const child = frame.sessionId
    if (child === undefined || child === '') return
    const known = childLabels.get(child)
    const label = known?.label ?? '子 Agent'
    // 结算后清账（下次同名 label 是新的一轮）。
    childLabels.delete(child)
    const title = outcome === 'completed'
      ? '子 Agent 完成'
      : outcome === 'aborted'
        ? '子 Agent 已终止'
        : '子 Agent 运行失败'
    publish(store, `subagent:${child}:settled`, {
      tone: subagentOutcomeTone(outcome),
      title,
      message: frame.step === undefined ? label : `${label} · Step ${frame.step}`,
    }, subagentOpener(known?.parentSessionId, child))
  })

  // ── 隔离分支待集成（同父会话合并成一条）──────────────────────────────
  on<WorktreeLedgerFrame>('corum/worktree-ledger', (frame) => {
    const parent = frame.sessionId
    const pending = frame.pending ?? 0
    if (parent === undefined || parent === '') return
    if (pending === 0) {
      // 全部集成/丢弃 → 撤掉待集成提示（不留过期通知）。
      const stale = liveByKey.get(`worktree:${parent}`)
      if (stale !== undefined) { store.dismiss(stale); liveByKey.delete(`worktree:${parent}`) }
      return
    }
    const branches = (frame.entries ?? [])
      .filter(entry => entry.status === 'active' || entry.status === 'settled')
      .map(entry => entry.branch ?? entry.slug ?? '')
      .filter(branch => branch !== '')
    publish(store, `worktree:${parent}`, {
      tone: 'info',
      title: `${pending} 个隔离分支待集成`,
      message: clip(branches.join(' · ')),
    }, opener(parent))
  })

  // ── 下载完成 / 失败（同槽位合并；下载中是高频过程事件，不提示）────────
  const download = (slot: string) => (frame: DownloadFrame): void => {
    const status = frame.status
    if (status !== 'done' && status !== 'error') return
    const what = frame.target ?? (slot === 'artgen'
      ? (frame.key === 'engine' ? '文生图引擎' : '文生图模型')
      : 'Ollama 模型')
    const key = `download:${slot}:${frame.key ?? ''}:${frame.target ?? ''}`
    if (status === 'done') {
      publish(store, key, { tone: 'success', title: '下载完成', message: what })
    } else {
      publish(store, key, {
        tone: 'error',
        title: '下载失败',
        message: clip(`${what}${frame.error === undefined ? '' : `：${frame.error}`}`),
      })
    }
  }
  on<DownloadFrame>('corum/artgen/download-progress', download('artgen'))
  on<DownloadFrame>('corum/ollama/download-progress', download('ollama'))

  // ── 经验沉淀完成（点击跳转记忆页）──────────────────────────────────────
  on<DistillCompletedFrame>('corum/distill/completed', (frame) => {
    const factCount = frame.factCount ?? 0
    if (factCount === 0) return // 无可沉淀内容不提示（与「下载完成」同款——只报有意义的完成）
    const key = `distill:${frame.jobId ?? frame.sessionId ?? ''}:completed`
    publish(store, key, {
      tone: 'success',
      title: '经验沉淀完成',
      message: `已写入 ${factCount} 条记忆`,
    }, layout === undefined ? undefined : () => { layout.openSettingsSection('memory-agent') })
  })

  return () => { for (const dispose of disposers) dispose() }
}
