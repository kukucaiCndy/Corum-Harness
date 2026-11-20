// fork（corum）：子 Agent 进度卡——主 Agent 召唤子 Agent（delegation）时在消息瀑布
// 中流出的玻璃卡。对齐设计稿「子Agent卡 交互改动稿（4 项）」（q0T81）：
//   head = avatar(bot) + meta(name 16 / task 14 / 模型行 13) + chip(纯状态 Running/Done)
//          + act-expand(∨/∧ 展开任务详情) + act-goto(→ 跳子会话)
//   prog = 4px 进度条（step 驱动渐近；无 progress 时不确定动画）——常驻
//   step = loader + 「Step n · currentAction」实时行——**常驻**（不收进下拉）
//   任务详情（展开区）= 父 Agent 注入的提示词全文（host getSubagentSessionMeta 提取
//   子会话首条 user/message）——仅展开时显示
// 进度数据源（统一事件中心三-3，轮询 → 推送）：
//   主路径 = 'corum/subagent/progress' $on 推送帧（host corumAgent 在
//   session/event 追加点 O(1) 增量折叠并 emit，帧即最终进度，client 零 RPC）；
//   冷启动基线 = 挂载时一次性 RPC getChildSessionProgress（回填推送开始前
//   的历史）；降级兜底 = 订阅宽限期内零推送帧（旧 host 不 emit）回退 2s 轮询。
// 模型行读官方 session/list 行的 modelSelection 投影（挂载时读一次——模型在
// 会话生命周期内基本不变，原 4s 轮询已删）。
// 跨 bundle 句柄（当前会话 id + RPC connection + 跳子会话桥）经 chatRuntime
// cordis 服务消费（统一事件中心二期 window 全局迁移；同 bundle 模块级
// chatRuntimeRef 拿服务实例，见 ../chat-runtime.ts）。
import { memo, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, Ban, Bot, Check, ChevronDown, ChevronUp, Cpu, FileText, GitBranch, GitFork, Loader, Search, Wrench, X } from 'lucide-react'
import { subagentProgressStateOf, subagentStateChipTone } from '@corum/corum-api-remotes/corum-events'
import type { SubagentChangeSummary, SubagentDelegationRole, SubagentStopReason, SubagentTodoItem } from '@corum/corum-api-remotes/corum-events'
import type { ChatNodeViewProps } from '../contract/slots.ts'

/**
 * 委派角色 → 头像图标 + 文案 key（**卡片与会话条共用同一角色集**，口径一致）。
 *
 * 角色来自父会话日志里那条 `tool/call` 的**工具名**（`SubagentInvocation.role`）：
 * `subagent_research` → 放大镜（只读调研）、`subagent` → 扳手（委派执行）、
 * `subagent_fork` → 分叉（继承上下文）。**绝不按 label 文案猜**——label 是模型写的
 * 自然语言，同一角色会被写成「调研」「recon」「查一下」。取不到工具名的路径
 * （历史截断 / orchestrate 派出的子会话）退回通用 `Bot` 图标，不冒充角色。
 */
export const SUBAGENT_ROLE_VISUAL: Readonly<Record<SubagentDelegationRole, {
  readonly icon: typeof Bot
  readonly labelKey: 'subagent.role.research' | 'subagent.role.worker' | 'subagent.role.fork'
}>> = {
  research: { icon: Search, labelKey: 'subagent.role.research' },
  worker: { icon: Wrench, labelKey: 'subagent.role.worker' },
  fork: { icon: GitFork, labelKey: 'subagent.role.fork' },
}

/**
 * 卡片**标题前缀**的角色短名（2026-09-15 用户要求：`研究· 标题` / `工作· 标题`）。
 *
 * 与 {@link SUBAGENT_ROLE_VISUAL} 分开而不是复用它的 `labelKey`：那些是**长解释**
 * （「调研子 Agent（只读调查）」，用于 avatar 的 title/aria-label 与无障碍语义），
 * 而标题前缀要的是**一到两个字**的短名。两者用途不同，故各自成键。
 *
 * ⚠️ 只用 `role`（工具名派生）取值；**取不到 role 时不要用这张表** ——
 * 调用方退回 `subagent.name`（见渲染处注释）。
 */
export const SUBAGENT_ROLE_TITLE_KEY: Readonly<Record<SubagentDelegationRole, 'subagent.title.research' | 'subagent.title.worker' | 'subagent.title.fork'>> = {
  research: 'subagent.title.research',
  worker: 'subagent.title.worker',
  fork: 'subagent.title.fork',
}
import type { SubagentProgressSnapshot } from '../contract/subagent.ts'
import { chatRuntimeRef, subagentChildOf, subagentChildSubscribe, subagentProgressSubscribe } from '../chat-runtime.ts'
import { SubagentPlan } from './SubagentPlan.tsx'
import css from './SubagentCard.module.css'
import { SubagentChanges } from './SubagentChanges.tsx'
import { SubagentResult } from './SubagentResult.tsx'

/** 子会话进度 RPC 返回形（与 host getChildSessionProgress 对齐）。 */
interface ChildProgressValue {
  progress?: {
    turn: number
    step: number
    currentAction?: string
    done: boolean
    stopReason?: string
    /** 中途失去运行（进程退出/被丢弃）——宿主补的诚实终态标记（2026-09-12）。 */
    interrupted?: boolean
    lastActive: number
    todos?: readonly SubagentTodoItem[]
  }
}

/** 合法化跨包 JSON 面的 stopReason（不认识的字符串不当成功）。 */
const VALID_STOP_REASONS = new Set(['completed', 'aborted', 'error', 'max-tokens', 'refusal'])

function normalizeStopReason(raw: string | undefined): SubagentStopReason | undefined {
  if (raw === undefined) return undefined
  return VALID_STOP_REASONS.has(raw) ? raw as SubagentStopReason : undefined
}

/** 子会话 meta RPC 返回形（与 host getSubagentSessionMeta 对齐）。 */
interface SubagentMetaValue {
  meta?: { prompt?: string }
}

/** session/list 行 projections.values.modelSelection 的窄化形。 */
interface ModelSelectionProjection {
  lastUsed?: { provider?: string; model?: string; reasoningEffort?: string }
  next?: { provider?: string; model?: string; reasoningEffort?: string }
}

/** 已知 provider/model 段的官方显示名（kebab 段的非常规大小写映射）。 */
const MODEL_SEGMENT_DISPLAY: Readonly<Record<string, string>> = {
  deepseek: 'DeepSeek',
}

/** 模型显示文案：「DeepSeek-V4-Flash · High」——model 字段 kebab 段映射显示名。 */
function modelLabel(projection: ModelSelectionProjection | undefined): string | undefined {
  const m = projection?.next ?? projection?.lastUsed
  if (m?.model === undefined || m.model === '') return undefined
  const name = m.model
    .split('-')
    .map(part => MODEL_SEGMENT_DISPLAY[part]
      ?? (part === 'v' || /^\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
  const effort = m.reasoningEffort === undefined || m.reasoningEffort === ''
    ? undefined
    : m.reasoningEffort.charAt(0).toUpperCase() + m.reasoningEffort.slice(1)
  return effort === undefined ? name : `${name} · ${effort}`
}

/** 读子会话模型显示（官方 session/list RPC 行的 projectionValues.modelSelection 投影）。 */
function useChildModel(childSessionId: string | undefined): string | undefined {
  const [label, setLabel] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined) { setLabel(undefined); return undefined }
    let cancelled = false
    const read = async () => {
      const runtime = chatRuntimeRef.current
      if (runtime === null) return
      try {
        // 共享读取（并发去重 + TTL 缓存）：几十张卡片只打一次 session/list。
        const rows = await runtime.sessionRows()
        if (cancelled) return
        const row = (rows ?? []).find(item => item.sessionId === childSessionId)
        setLabel(modelLabel(row?.projections?.values?.modelSelection))
      } catch {
        // 单次失败留空（模型行缺省不显示）。
      }
    }
    // 统一事件中心三-3：模型在会话生命周期内基本不变（缺省随父 profile
    // 编译期注入），原 4s setInterval 轮询已删——挂载时读一次即可。
    void read()
    return () => { cancelled = true }
  }, [childSessionId])
  return label
}

/** 推送通道宽限期（ms）：$on 订阅建立后这么久仍零推送帧 → 判定推送未生效（旧 host 不 emit），回退轮询。 */
/**
 * 是否还需要降级轮询。
 *
 * 为什么需要这条判据（2026-09-28 实测，`docs/PENDING-ui-lag-multiround.md` §2.12）：
 * 推送只在**进度变化**时发帧，而**已结束**的子会话不会再变 ⇒ 重启后（或晚开的卡片）宽限期内
 * 永远零帧 ⇒ 每张卡都无条件回退 2s 轮询，实测一轮动作打 **132 次** `getChildSessionProgress`，
 * 主机被逐卡轮询占满——这是卡顿的主要量级来源。终态是稳定事实，不需要再轮询。
 *
 * @param progress - 已知的最新进度快照（未拉到时为 `undefined`）。
 * @returns 是否应当进入/继续降级轮询。
 */
export function shouldFallbackPoll(progress: SubagentProgressSnapshot | undefined): boolean {
  if (progress === undefined) return true // 还没拿到基线：值得再拉一次
  if (progress.done) return false // 终态：稳定事实，再拉也不变
  if (progress.stopReason !== undefined) return false
  return true // 仍在跑：轮询到它结束
}

const PROGRESS_PUSH_GRACE_MS = 2500
/** 降级兜底轮询周期（ms）：推送未生效时的拉取节奏（与迁移前一致）。 */
const PROGRESS_FALLBACK_POLL_MS = 2000

/**
 * 子会话精确进度（统一事件中心三-3：推送主路径 + 冷启动基线 + 降级轮询）。
 *
 * 主路径：$on('corum/subagent/progress') 帧直收（host 已按同口径折叠好，
 * 零 RPC）；挂载时一次性 RPC 基线回填推送开始前已发生的历史；宽限期内零
 * 推送帧（旧 host 不 emit）回退 2s RPC 轮询，一旦有帧到达轮询永不起动。
 */
/**
 * 子会话精确进度（推送主路径 + 冷启动基线 + 降级轮询）。
 *
 * **导出给编排卡复用**（2026-09-12）：`orchestrate` 的每个分支也要按自己子会话的实时
 * 进度翻状态，否则并行任务各自完成后仍显示「运行中」，要等整批 settle 才一起翻。
 */
export function useChildProgress(childSessionId: string | undefined): SubagentProgressSnapshot | undefined {
  const [progress, setProgress] = useState<SubagentProgressSnapshot | undefined>(undefined)
  /** 最新快照的同步副本（降级轮询要用它判「是否已终态」；effect 闭包里的 state 是旧值）。 */
  const latestRef = useRef<SubagentProgressSnapshot | undefined>(undefined)
  const apply = (next: SubagentProgressSnapshot): void => {
    latestRef.current = next
    setProgress(next)
  }
  useEffect(() => {
    if (childSessionId === undefined) return undefined
    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    /** 拉一次基线/兜底进度（经 chatRuntime 共享缓存：终态结果不重复拉）。 */
    const fetchOnce = async () => {
      const runtime = chatRuntimeRef.current
      if (runtime === null) return
      try {
        const value = await runtime.childProgress(childSessionId)
        if (cancelled) return
        if (value !== undefined) {
          if (value.progress !== undefined) {
            const p = value.progress
            const sr = normalizeStopReason(p.stopReason)
            apply({
              turn: p.turn,
              step: p.step,
              ...p.currentAction === undefined ? {} : { currentAction: p.currentAction },
              done: p.done,
              ...sr === undefined ? {} : { stopReason: sr },
              // ⚠️ 这里是**逐字段重建**——新增字段必须显式搬运，否则会被静默丢掉
              //（2026-09-12 实测：宿主已返回 interrupted，卡片却仍停在 Running）。
              ...p.interrupted === true ? { interrupted: true } : {},
              ...p.todos === undefined ? {} : { todos: p.todos },
            })
          }
        }
      } catch {
        // 单次拉取失败静默；会话不存在时 host 返回 {}，progress 维持 undefined。
      }
    }

    // 冷启动基线：推送只覆盖订阅建立之后的事件——卡片晚开（子会话已在跑/
    // 已完成）时历史进度靠这一次全量折叠回填。
    void fetchOnce()

    // 主路径：推送帧直收（帧即最终进度，按 sessionId 过滤本卡子会话）。
    const sub = subagentProgressSubscribe((frame) => {
      if (cancelled || frame.sessionId !== childSessionId) return
      const sr = normalizeStopReason(frame.stopReason as string | undefined)
      apply({
        turn: frame.turn,
        step: frame.step,
        ...frame.currentAction === undefined ? {} : { currentAction: frame.currentAction },
        done: frame.done,
        ...sr === undefined ? {} : { stopReason: sr },
        ...(frame as { interrupted?: boolean }).interrupted === true ? { interrupted: true } : {},
        ...frame.todos === undefined ? {} : { todos: frame.todos },
      })
    })

    // 降级兜底：宽限期内任何会话的推送帧都没到（旧 host 不 emit / 通道未
    // 生效）→ 回退 2s 轮询（自循环 setTimeout，拉取失败下轮重试）。
    graceTimer = setTimeout(() => {
      graceTimer = undefined
      if (cancelled || sub.framesSeen() > 0) return
      // 终态不再轮询（见 shouldFallbackPoll 的说明）。
      if (!shouldFallbackPoll(latestRef.current)) return
      const poll = async () => {
        await fetchOnce()
        // 拉到终态就停：既省 RPC，也让「已结束」的卡片彻底安静下来。
        if (cancelled || !shouldFallbackPoll(latestRef.current)) return
        pollTimer = setTimeout(() => { void poll() }, PROGRESS_FALLBACK_POLL_MS)
      }
      void poll()
    }, PROGRESS_PUSH_GRACE_MS)

    return () => {
      cancelled = true
      sub.unsubscribe()
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
    }
  }, [childSessionId])
  return progress
}

/** 拉取父 Agent 注入的提示词（任务详情展开区数据源，仅展开时拉一次）。 */
function useSubagentPrompt(childSessionId: string | undefined, expanded: boolean): string | undefined {
  const [prompt, setPrompt] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined || !expanded || prompt !== undefined) return undefined
    let cancelled = false
    void (async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) return
      try {
        const result = await conn.rpc.call('/api', 'corumAgent/getSubagentSessionMeta', {
          args: { sessionId: childSessionId },
        })
        if (cancelled) return
        if (result.ok && result.value !== undefined) {
          const value = result.value as SubagentMetaValue
          if (value.meta?.prompt !== undefined) setPrompt(value.meta.prompt)
        }
      } catch {
        // 拉取失败留空（展开区降级为「无任务详情」）。
      }
    })()
    return () => { cancelled = true }
  }, [childSessionId, expanded, prompt])
  return prompt
}

/** 进度条填充比例：以 step 步数为最小步进（无总步数，单调爬升渐近 100%）。 */
function progressRatio(progress: SubagentProgressSnapshot): number {
  // 终态（含 interrupted）直接满格——判据同源，别在这里再写一遍 done/stopReason 的组合。
  if (subagentProgressStateOf(progress) !== 'running') return 1
  return Math.min(0.1 + progress.step * 0.18, 0.9)
}

/** 底部 step 行文案：「Step n · action」/「Step n」/ prompt 摘要 / 默认 working。 */
function runningStepText(
  progress: SubagentProgressSnapshot | undefined,
  prompt: string | undefined,
  t: ChatNodeViewProps<'subagent-call'>['t'],
): string {
  if (progress === undefined) return prompt ?? t('subagent.working')
  const stepLabel = t('subagent.step', { n: progress.step })
  return progress.currentAction === undefined
    ? stepLabel
    : `${stepLabel} · ${progress.currentAction}`
}

/**
 * 子会话身份（id + 前台/后台模式）的实时解析（2026-09-09）。
 *
 * 顺序：宿主 spawn 广播（'corum/subagent/child'，精确 id + 权威 mode）> 本进程
 * 已观测缓存 > fold 出的历史匹配（summary 时间就近给 id、工具参数给 mode，仅页面
 * 刷新后兜底）。广播到达即触发重渲染，于是 goto 按钮、进度订阅与模式徽标在运行期
 * 第一帧就可用，不必等子会话结束。
 * @param callId - 父侧 tool/call id（卡片身份）。
 * @param fallbackId - conversation fold 给出的兜底 id（可能 undefined）。
 * @param fallbackMode - conversation fold 从工具参数推出的兜底模式（可能 undefined）。
 * @returns 当前可用的子会话 id 与模式。
 */
function useLiveChildIdentity(
  callId: string,
  fallbackId: string | undefined,
  fallbackMode: 'foreground' | 'background' | undefined,
): {
  readonly childSessionId: string | undefined
  readonly mode: 'foreground' | 'background' | undefined
  readonly worktree: { readonly slug: string; readonly branch: string } | undefined
} {
  const [live, setLive] = useState(() => subagentChildOf(callId))
  useEffect(() => {
    setLive(subagentChildOf(callId))
    const sub = subagentChildSubscribe((frame) => {
      if (frame.callId !== callId) return
      setLive({
        childSessionId: frame.childSessionId,
        mode: frame.mode,
        ...frame.worktree === undefined ? {} : { worktree: frame.worktree },
      })
    })
    return () => { sub.unsubscribe() }
  }, [callId])
  return {
    childSessionId: live?.childSessionId ?? fallbackId,
    mode: live?.mode ?? fallbackMode,
    worktree: live?.worktree,
  }
}

/** 一个 delegation 召唤的卡片（进度由 'corum/subagent/progress' 推送注入，见 useChildProgress）。 */
function SubagentRow({
  callId, description, prompt: delegationPrompt, childSessionId: foldedChildSessionId,
  mode: foldedMode, role, toolError, t,
}: {
  callId: string
  description: string | undefined
  prompt: string | undefined
  childSessionId: string | undefined
  mode: 'foreground' | 'background' | undefined
  /** 委派角色（父侧工具名派生；见 SubagentInvocation.role）。 */
  role: SubagentDelegationRole | undefined
  /** 父侧 tool/result 的失败原文（子会话从未创建时的唯一失败证据）。 */
  toolError: string | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  // hooks 顺序恒定（React #310）：必须在任何 early return 之前。
  const { childSessionId, mode, worktree } = useLiveChildIdentity(callId, foldedChildSessionId, foldedMode)
  const progress = useChildProgress(childSessionId)
  const model = useChildModel(childSessionId)
  const [expanded, setExpanded] = useState(false)
  const detailPrompt = useSubagentPrompt(childSessionId, expanded)
  /**
   * 展示态走**唯一判据家**（`subagentProgressStateOf`，2026-09-13 收口）：
   * 中途失去运行的子会话（进程退出 / 被丢弃）由宿主在进度投影里补 `interrupted`
   * ——它不是完成、也不是手动终止；拿不到原因但已终局的条目按「已完成」兜底。
   * 不认 `interrupted` 卡片会永远 Running（2026-09-12 用户实测「search agent 结束后
   * 卡片仍然是 running」）；而在卡片一处自判、会话条另判一次，就是「同一终态两处
   * 不同源」（花名册把「已中断」算成「已完成」正是这么来的）。
   *
   * `delegationFailed`（2026-09-19 用户实测：失败后卡片仍 Running）：模型不可用在
   * **spawn 期预检失败**时子会话**从未创建** ⇒ 没有进度、没有终态、没有 id 可关联，
   * `progress` 恒 undefined。此时唯一证据是父侧那条报错的 `tool/result`。它仍走同一个
   * 判据家（不在卡片里另判一次），单源不变。
   */
  const state = subagentProgressStateOf({
    ...progress ?? {},
    ...toolError === undefined ? {} : { delegationFailed: true },
  })
  const running = state === 'running'
  const chipTone = subagentStateChipTone(state)

  const openChild = () => {
    if (childSessionId === undefined) return
    // 子会话查看改分栏，不顶替主视图；能力缺失回落 openSession。
    chatRuntimeRef.current?.openChildInSplit(childSessionId)
  }

  return (
    <div
      className={css.card}
      data-child-session-id={childSessionId || undefined}
    >
      <div className={css.head}>
        <span
          className={css.avatar}
          data-role={role ?? undefined}
          title={role === undefined ? t('subagent.name') : t(SUBAGENT_ROLE_VISUAL[role].labelKey)}
          aria-label={role === undefined ? t('subagent.name') : t(SUBAGENT_ROLE_VISUAL[role].labelKey)}
        >
          {role === undefined
            ? <Bot size={16} strokeWidth={2} className={css.avatarIcon} />
            : (() => { const Icon = SUBAGENT_ROLE_VISUAL[role].icon; return <Icon size={16} strokeWidth={2} className={css.avatarIcon} /> })()}
        </span>
        <span className={css.meta}>
          {/* 标题前缀按**角色**分档（2026-09-15 用户要求）：`研究· 核清 section 语义…`、
              `工作· 整改翻译` —— 前缀紧贴中点，中点后再留一个空格。

              ⚠️ 前缀**只由 `role` 决定**（role 来自父会话日志里那条 `tool/call` 的**工具名**，
              见上方 SUBAGENT_ROLE_VISUAL 的注释纪律：「**绝不按 label 文案猜**」）。
              **role 取不到时退回通用 `subagent.name`（「子 Agent」）** ——
              历史截断 / orchestrate 派出的子会话没有工具名可依，此时硬套「工作」就是**冒充角色**。
              无 description 时只显示前缀本身（不留悬空的分隔符）。 */}
          <span className={css.name}>
            {role !== undefined ? `${t(SUBAGENT_ROLE_TITLE_KEY[role])}· ` : `${t('subagent.name')} · `}
            {description ?? ''}
          </span>
          {model !== undefined && (
            <span className={css.modelRow}>
              <Cpu size={13} strokeWidth={2} className={css.modelIcon} />
              <span className={css.modelText}>{model}</span>
            </span>
          )}
          {/* 隔离 worktree 行（设计稿 sub：`worktree · wt-1b3dcf`）。
              数据源 = 本卡自己那次 spawn 的 'corum/subagent/child' 广播帧
              （携带 worktree 三件套）——**每卡自己的子会话**，故不会像会话级
              台账 chip 那样随节点数重复 N 份（那正是 c0e69443 移除它的原因）。 */}
          {worktree !== undefined && (
            <span className={css.modelRow} title={t('subagent.worktreeTitle')}>
              <GitBranch size={13} strokeWidth={2} className={css.modelIcon} />
              <span className={css.modelText}>{worktree.slug}</span>
            </span>
          )}
        </span>
        {mode !== undefined && (
          <span
            className={mode === 'background' ? css.modeChipBg : css.modeChipFg}
            title={t(mode === 'background' ? 'subagent.mode.backgroundTitle' : 'subagent.mode.foregroundTitle')}
          >
            {t(mode === 'background' ? 'subagent.mode.background' : 'subagent.mode.foreground')}
          </span>
        )}
        <span
          className={chipTone === 'running' ? css.runChip : chipTone === 'done' ? css.doneChip : chipTone === 'aborted' ? css.stopChip : css.failChip}
          data-outcome={state}
        >
          {running
            ? <><span className={css.runDot} />{t('subagent.running')}</>
            : state === 'interrupted'
              ? <><Ban size={12} strokeWidth={2.5} />{t('subagent.interrupted')}</>
              : chipTone === 'done'
                ? <><Check size={12} strokeWidth={2.5} />{t('subagent.done')}</>
                : chipTone === 'aborted'
                  ? <><Ban size={12} strokeWidth={2.5} />{t('subagent.stopped')}</>
                  : <><X size={12} strokeWidth={2.5} />{t('subagent.failed')}</>}
        </span>
        <button
          type="button"
          className={css.actBtn}
          title={expanded ? t('subagent.collapse') : t('subagent.expand')}
          aria-label={expanded ? t('subagent.collapse') : t('subagent.expand')}
          aria-expanded={expanded}
          onClick={() => { setExpanded(open => !open) }}
        >
          {expanded
            ? <ChevronUp size={17} strokeWidth={2} className={css.actIconMuted} />
            : <ChevronDown size={17} strokeWidth={2} className={css.actIconMuted} />}
        </button>
        <button
          type="button"
          className={css.actBtn}
          title={t('subagent.goto')}
          aria-label={t('subagent.goto')}
          disabled={childSessionId === undefined}
          onClick={openChild}
        >
          <ArrowRight size={17} strokeWidth={2} className={css.actIconBrand} />
        </button>
      </div>
      {running && (
        <div className={css.prog}>
          <div
            className={progress === undefined ? `${css.progBar} ${css.progBarIndeterminate}` : css.progBar}
            style={progress === undefined ? undefined : { width: `${Math.round(progressRatio(progress) * 100)}%` }}
          />
        </div>
      )}
      {/* ④ step 行常驻（不收进下拉）：展开/收起两态都显示，运行中实时刷新。 */}
      {running && (
        <div className={css.stepRow}>
          <Loader size={15} strokeWidth={2} className={css.stepIcon} />
          <span className={css.stepText}>{runningStepText(progress, delegationPrompt, t)}</span>
        </div>
      )}
      {/* ② 失败原因（2026-09-19 用户定调「以卡片状态为主」）：委派失败时把父侧
          tool/result 的原文直接摊在卡上，卡片才能替代那条通用工具行——否则藏掉工具行
          用户就看不到为什么失败。恒展开（不是折叠区）：失败是需要立刻看见的事。 */}
      {toolError !== undefined && (
        <div className={css.failReason}>
          <AlertTriangle size={13} strokeWidth={2} className={css.failIcon} />
          <span className={css.failText}>{toolError}</span>
        </div>
      )}
      {/* ③ 子 Agent 计划段（展开区）：子会话 todo/write 折叠列表，无计划时不渲染。 */}
      {expanded && progress?.todos !== undefined && progress.todos.length > 0 && <SubagentPlan todos={progress.todos} />}
      {/* ④ 任务详情（展开区）：父 Agent 注入的提示词全文，仅展开时显示。 */}
      {expanded && (
        <div className={css.detail}>
          <div className={css.detailHead}>
            <FileText size={14} strokeWidth={2} className={css.detailIcon} />
            <span className={css.detailTitle}>{t('subagent.taskDetail')}</span>
          </div>
          <div className={css.detailBody}>
            {detailPrompt ?? delegationPrompt ?? t('subagent.working')}
          </div>
        </div>
      )}
      {/* ⑤ 结果（展开区，#98）：子 Agent **最终返回**的内容（最后一条 assistant/message）。
          与④任务详情（父注入的指令）分开两段：用户要在同一张卡上同时看到
          「让它干什么」与「它回了什么」，而不必点进子会话。
          还没有 assistant 输出时给空态文案（不隐藏整段——否则用户会以为漏了功能）。
          实现抽在 ./SubagentResult.tsx（与编排卡分支行共用，避免两处行为分叉）。
          `settled` = 本卡已终态：running→done 翻转时自动重拉一次（展开那一刻子 Agent
          往往还在跑，否则拉到的空结果会一直挂在卡上）。 */}
      {expanded && <SubagentResult childSessionId={childSessionId} t={t} settled={!running} />}
      {/* ⑥ 改动（展开区）：子会话终态时列出改动文件 ±N + diff + 撤销。
          数据源 = host 终态帧 corum/subagent/progress.changeSummary
          （corumReview.snapshot(childSessionId) + 台账状态）。子 Agent 还在跑
          时 changeSummary 缺省 → 组件返回 null，不占展开区空间。 */}
      {expanded && (
        <SubagentChanges
          childSessionId={childSessionId}
          worktree={worktree}
          t={t}
        />
      )}
    </div>
  )
}

/** 子 Agent 进度卡（一个 Turn 的 delegation 召唤们，各自一张卡）。 */
export const SubagentCard = memo(function SubagentCard({ node, t }: ChatNodeViewProps<'subagent-call'>) {
  const invocations = node.data.invocations
  if (invocations.length === 0) return null
  return (
    <>
      {invocations.map(invocation => (
        <SubagentRow
          key={invocation.callId}
          callId={invocation.callId}
          description={invocation.description}
          prompt={invocation.prompt}
          childSessionId={invocation.childSessionId}
          mode={invocation.mode}
          role={invocation.role}
          toolError={invocation.toolError}
          t={t}
        />
      ))}
      {/* 台账 chip 已移出卡片（2026-09-10 P8）：每次委托一个节点后，卡内渲染会
          随节点数重复 N 份；「并行工作区」改由会话条/统计浮层承载（下一轮）。 */}
    </>
  )
})
