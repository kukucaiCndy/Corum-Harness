// fork（corum）：orchestrate 编排卡——主 Agent 调 `orchestrate` fan-out 多个子
// Agent 时，在消息瀑布中流出的**流程图卡**（设计稿 `orchestrate-flow-card`，fNng3）。
//
// 对齐设计稿结构（节点坐标实测）：
//   head  = avatar(layers) + meta(标题「编排工作流 · N 任务并行」) + 状态 chip(计数)
//           + 折叠按钮   ← 标题下**没有**副标题（#96 移除：流程图与 chip 已表达同样信息）
//   flow  = 导轨列(node-start x=4 / trunk x=14 竖虚线 / node-close x=4) +
//           分支列(逐 brX: line x=16 + node x=34 + card x=64) +
//           结尾节点(card-close x=64 整行宽、无 brX-line)
//
//   分支卡 = label / 副行(isolation · worktree 或 research · 只读) + 状态 chip + goto
//
//   结尾节点是一个**串行收尾**，与并行分支列表分层渲染：
//   node-close 落在导轨列(x=4，与 node-start 同列)，trunk 从 start 一路延伸到 close
//   承担「N 条并行 → 1 个收尾」的汇聚连接线；card-close 整行宽(x=64)、底色更弱、
//   无 brX-line —— 视觉上明确区别于并行分支行。
//
// 状态色（设计稿两态实测）：
//   running #FFB45C（warn）· done #3EE6B0（success）· failed #FF5C7A（error）
//   收尾：已收尾=done 色 / 队列中=品牌蓝 / 失败=error 色。
//
// 数据源 = 本卡自己的 node data（orchestrate.ts 从 tool/call arguments + 结果正文
// 折叠），无新宿主通路。子会话跳转复用 subagent 卡同一套 runtime 桥。
//
// ★ 2026-10 编排黑盒化（UI 半边）：机制取消了 `merge` 字段，收尾改由机制按隔离实况
//   自动判定的 closer 节点完成（三场景 merge / summarize / research）。于是本卡的
//   「结尾节点」不再由「模型声明了 merge」决定，而是**并行编排恒渲染**，其态读
//   `data.closer`（报告正文也来自 `closer.report`）。详见下面 closeStage 的注释。
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Ban, BookOpen, Check, ChevronDown, ChevronUp, Clock, Cpu, FileText, GitBranch, GitMerge, Info, Layers, Loader, X } from 'lucide-react'
import { subagentOutcomeOf, subagentOutcomeChipTone } from '@corum/corum-api-remotes/corum-events'
import type { SubagentStopReason } from '@corum/corum-api-remotes/corum-events'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { OrchestrateChatData, OrchestrateCloserScenario, OrchestrateTask } from '../contract/orchestrate.ts'
import { summarize } from '../contract/orchestrate.ts'
import { chatRuntimeRef, subagentChildOf, subagentChildSubscribe, subagentChildrenOf, worktreeLedgerSubscribe } from '../chat-runtime.ts'
import { useChildProgress } from './SubagentCard.tsx'
import { SubagentChanges } from './SubagentChanges.tsx'
import { SubagentResult } from './SubagentResult.tsx'
import css from './OrchestrateCard.module.css'

/** 一条分支的渲染态。 */
type BranchState = 'running' | 'done' | 'aborted' | 'failed'

/**
 * 分支状态派生：**终态优先，实时进度兜底**。
 *
 * 工具结果（`data.outcomes`）是整批返回的，所以在并行执行过程中它是空的；旧实现据此
 * 把每个分支恒判为「运行中」，导致**某个分支自己跑完了卡片仍显示运行中，要等整批 settle
 * 才一起翻**（2026-09-12 用户实测）。现在用「该分支自己的子会话实时进度」兜底：
 * 子会话 outcome ⇔ 该分支终态，逐条翻，互不牵连。
 * @param data - 本卡的折叠数据（含终态 outcomes 与 settled 位）。
 * @param index - 分支序号。
 * @param stopReason - 该分支子会话的实时终局原因（undefined = 还没结束）。
 * @returns 分支渲染态。
 */
function branchState(data: OrchestrateChatData, index: number, stopReason?: SubagentStopReason): BranchState {
  const outcome = data.outcomes.get(index)
  if (outcome !== undefined) {
    if (outcome.kind === 'done') return 'done'
    if (outcome.kind === 'aborted') return 'aborted'
    return 'failed'
  }
  // 未 settle：子会话 outcome 给终态（不再等整批）；settle 却无 outcome 仍按失败。
  const live = subagentOutcomeOf(stopReason)
  if (data.settled) {
    if (live === 'completed') return 'done'
    if (live === 'aborted') return 'aborted'
    if (live === 'failed') return 'failed'
    return 'failed'
  }
  if (live === 'completed') return 'done'
  if (live === 'aborted') return 'aborted'
  if (live === 'failed') return 'failed'
  return 'running'
}

/** 分支副行（设计稿 sub）。
 *
 *  ★ 2026-10-19 用户定调：副行**不再出现 `worktree` 这个词**，改成「图标 + slug」——
 *  分支图标 = 隔离写任务，书图标 = 只读调研，图标本身就承担类型信号，文字只留目录名。
 *  判定对齐**机制不变式**：readonly research 不隔离；`isolation === 'main'` 不隔离；
 *  其余写任务**恒隔离**（`worktree` / `always` / `write-tasks` / 未声明，含旧值 `off`
 *  兜底——机制已无 off 逃生口）。
 *  隔离任务的 slug 三层兜底：① 实时台账（推送帧，按 spawn 顺序对齐）→
 *  ② 结果里的 `results[].worktreeSlug`（2026-10 起的可寻址字段，刷新后耐久）→
 *  ③ 泛化文案「隔离运行」。
 *  background 修饰不单独成行（副行保持单行）。
 * @param task - 任务声明。
 * @param worktrees - 当前会话的隔离台账条目。
 * @param slugFallback - 结果里的 slug 兜底。
 * @returns 副行图标语义（kind）与文本（text）。
 */
function branchSubtitle(
  task: OrchestrateTask,
  worktrees: readonly { readonly slug: string; readonly branch: string }[],
  slugFallback: string | undefined,
): { kind: 'branch' | 'book' | 'plain'; text: string } {
  if (task.research === true) return { kind: 'book', text: '只读调研' }
  if (task.isolation === 'main') return { kind: 'plain', text: '主树直跑' }
  const entry = worktrees[task.index]
  const slug = entry?.slug ?? slugFallback
  return { kind: 'branch', text: slug === undefined ? '隔离运行' : slug }
}

/** chip 语义色键的并集（分支 chip / 卡头 chip / 收尾 chip 共用）。 */
type ChipTone = 'queued' | 'running' | 'done' | 'aborted' | 'failed' | 'pending'

/** 状态 chip 文案 + 语义色键。tone 直接复用 `subagentOutcomeChipTone`（词表逐项
 *  一致：running→运行中 / done→已完成 / aborted→手动终止 / failed→失败）。
 *
 *  ⚠️ 文案走**编排卡自己的** `orchestrate.state.*`，不复用 `subagent.*`：后者中英文
 *  混排（`subagent.running` 在 zh 词典里就是 'Running'，因为子 Agent 卡的设计稿用的
 *  就是英文），复用会让编排卡渲染成「Done / Running」而设计稿是中文（2026-10-19 实测）。 */
function chipOf(state: BranchState, t: ChatNodeViewProps<'orchestrate-call'>['t']): { text: string; tone: 'running' | 'done' | 'aborted' | 'failed' } {
  const outcome = state === 'done' ? 'completed' : state === 'running' ? undefined : state
  const tone = subagentOutcomeChipTone(outcome)
  const text = tone === 'done' ? t('orchestrate.state.done')
    : tone === 'aborted' ? t('orchestrate.state.stopped')
    : tone === 'failed' ? t('orchestrate.state.failed')
    : t('orchestrate.state.running')
  return { text, tone }
}

/**
 * 状态 chip 左侧图标（2026-10-19 用户定调：**所有** chip 统一成「图标 + 文案」）。
 *
 * 旧实现只有「运行中」带一个脉冲圆点，其余全是纯文字——同一张卡里两种样式，而且
 * 那个圆点纯装饰（不旋转、不表意）。现在按状态给同一个 11px 图标：
 * 运行中/收尾中=loader（复用 `.chipSpin`，与分支节点同一旋转语义）、已完成=check、
 * 失败=x、手动终止=ban、已集成=git-merge、队列中=clock。
 * 颜色不在这里定——图标继承 chip 的 `color`（描边同色），故肉眼永远是「该状态的色」。
 *
 * ⚠️ `.chipSpin` 按 #97 的教训**必须**挂在每一处 loader 上，漏一处就是「状态没有动画」。
 * @param tone - chip 语义色键。
 * @returns 图标元素。
 */
function ChipIcon({ tone }: { tone: ChipTone }) {
  const size = 12
  switch (tone) {
    case 'queued':
      return <Clock size={size} strokeWidth={2.5} />
    case 'running':
    case 'pending':
      return <Loader size={size} strokeWidth={2.5} className={css.chipSpin} />
    case 'done':
      return <Check size={size} strokeWidth={3} />
    case 'aborted':
      return <Ban size={size} strokeWidth={2.5} />
    case 'failed':
      return <X size={size} strokeWidth={3} />
  }
}

/** 子会话跳转：宿主 spawn 广播（'corum/subagent/child'）给出的精确 id。
 *
 * ⚠️ orchestrate 的 N 个任务**共享父侧同一个 callId**（宿主对每个任务都用
 * `exec.callId` 广播，只有 label 不同），故必须按 `(callId, label)` 取——旧实现
 * 按 callId 存单条，后到任务覆盖先到的，卡片上只有一个/零个 goto 按钮。
 * label 对不上时按 spawn 顺序回退（宿主广播顺序 ≈ `tasks[]` 顺序）。
 */
function useChildOfTask(
  callId: string,
  label: string,
  index: number,
  fallbackId: string | undefined,
): string | undefined {
  const resolve = (): string | undefined => {
    const all = subagentChildrenOf(callId)
    // ① label 精确（同 callId 多任务的正解）
    const byLabel = all.find(entry => entry.label === label)
    if (byLabel !== undefined) return byLabel.childSessionId
    // ② spawn 顺序对齐（宿主按 tasks[] 顺序 spawn，故下标可用）
    if (all[index] !== undefined) return all[index].childSessionId
    // ③ fold 侧的历史兜底（页面刷新后无广播帧；来自 session/list 时间就近）
    return fallbackId ?? subagentChildOf(callId)?.childSessionId
  }
  const [child, setChild] = useState<string | undefined>(resolve)
  useEffect(() => {
    setChild(resolve())
    const sub = subagentChildSubscribe((frame) => {
      if (frame.callId !== callId) return
      setChild(resolve())
    })
    return () => { sub.unsubscribe() }
  }, [callId, label, index, fallbackId])
  return child
}

/**
 * 收尾节点（closer）子会话 id。
 *
 * 两条来源，**运行期优先**：① `corum/subagent/child` 广播里 label 命中收尾节点的
 * 那次 spawn；② 结果里的 `closer.childSessionId`（**durable**）——推送帧不重放，
 * 刷新/重启后只有它还在。两条都没有就不渲染按钮（宁可不给入口，也不给错的）。
 *
 * ⚠️ label 是**两个**（2026-10 迁移点）：黑盒化后 closer 的 spawn label 是
 * `'closer'`；历史会话里集成者的 label 是 `'integrate'`。只认后者会让新会话的
 * 「进入会话」按钮永不出现（运行期没有 durable id，结果回来前完全没入口）。
 * @param callId - 本次 orchestrate 的 callId。
 * @param fromResult - 结果里带的收尾子会话 id（缺省 = 结果还没到或没有 closer）。
 * @returns 可跳转的子会话 id，或 undefined。
 */
function useIntegratorChild(callId: string, fromResult: string | undefined): string | undefined {
  const resolve = (): string | undefined =>
    subagentChildrenOf(callId).find(entry => entry.label === 'closer' || entry.label === 'integrate')?.childSessionId
    ?? fromResult
  const [child, setChild] = useState<string | undefined>(resolve)
  useEffect(() => {
    setChild(resolve())
    const sub = subagentChildSubscribe((frame) => {
      if (frame.callId !== callId) return
      setChild(resolve())
    })
    return () => { sub.unsubscribe() }
  }, [callId, fromResult])
  return child
}

/** 会话 id 的取用（本卡所在会话；供隔离台账按父会话过滤）。uSES 源契约。 */
function useCurrentSessionId(): string | undefined {
  const source = useMemo(() => chatRuntimeRef.current?.sessionIdSnapshot(), [])
  const [id, setId] = useState<string | undefined>(() => source?.getSnapshot())
  useEffect(() => {
    if (source === undefined) return undefined
    setId(source.getSnapshot())
    return source.subscribe(() => { setId(source.getSnapshot()) })
  }, [source])
  return id
}

/**
 * 隔离 worktree 台账（设计稿分支副行的 `worktree · wt-xxxxxx`）。
 *
 * 数据源 = 'corum/worktree-ledger' 推送帧（宿主 fork #10 发射，按父 sessionId 过滤）。
 * ⚠️ 与 SubagentCard 的「并行工作区」chip 同源——那个 chip 的**渲染**在 commit
 * c0e69443（P8 按次成节点）被删掉后成了孤儿（组件还在、没人 render），用户反馈
 * 「隔离分支之前有显示、现在不显示」即此。本卡把 worktree 名放回分支副行。
 * @returns 当前会话的台账条目（无台账时为空数组）。
 */
function useWorktreeLedger(): readonly { readonly slug: string; readonly branch: string; readonly status: string }[] {
  const sessionId = useCurrentSessionId()
  const [entries, setEntries] = useState<readonly { slug: string; branch: string; status: string }[]>([])
  useEffect(() => {
    if (sessionId === undefined) return undefined
    const sub = worktreeLedgerSubscribe((frame) => {
      if (frame.sessionId !== sessionId) return
      setEntries(frame.entries)
    })
    return () => { sub.unsubscribe() }
  }, [sessionId])
  return entries
}

/**
 * 子会话模型显示（读官方 session/list 行的 `modelSelection` 投影，与 SubagentCard 同源）。
 *
 * 任务级 `model` 声明优先（机制锁定，见 contract/orchestrate.ts）；没声明时子 Agent
 * 跟随实例/全局默认，只有子会话自己的投影知道最终用了哪个模型。
 * @param childSessionId - 子会话 id（未关联时 undefined）。
 * @returns 形如 `deepseek-v4-pro · high`；取不到时 undefined。
 */
function useChildModel(childSessionId: string | undefined): string | undefined {
  const [label, setLabel] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined) { setLabel(undefined); return undefined }
    let cancelled = false
    void (async () => {
      const runtime = chatRuntimeRef.current
      if (runtime === null) return
      try {
        // 共享读取（并发去重 + TTL 缓存）：几十张卡片只打一次 session/list。
        const rows = await runtime.sessionRows()
        if (cancelled) return
        const row = (rows ?? []).find(item => item.sessionId === childSessionId)
        const last = row?.projections?.values?.modelSelection?.next ?? row?.projections?.values?.modelSelection?.lastUsed
        if (last?.model === undefined) return
        setLabel([last.model, last.reasoningEffort].filter(part => part !== undefined && part !== '').join(' · '))
      } catch {
        // 拉取失败留空（模型行不渲染）。
      }
    })()
    return () => { cancelled = true }
  }, [childSessionId])
  return label
}

/**
 * 一条并行分支（设计稿 brX 三件套：横线 + 状态节点 + 分支卡）。
 *
 * 独立成组件而非内联 map：每条分支要用**自己的** hook 取子会话 id 与模型
 * （React 不允许在循环里调 hook）。
 * @param props - 父 callId、任务声明、派生状态。
 */
function BranchRow({ callId, task, data, onLiveSettled, worktrees, fallbackChildId, slugFallback, branchFallback, t }: {
  callId: string
  task: OrchestrateTask
  /** 本卡的折叠数据（含终态 outcomes 与 settled 位）。 */
  data: OrchestrateChatData
  /** 该分支的子会话刚 settle 时上报终态（供卡头计数同步，见 OrchestrateCardImpl）。 */
  onLiveSettled: (index: number, outcome: 'completed' | 'aborted' | 'failed') => void
  worktrees: readonly { readonly slug: string; readonly branch: string; readonly status: string }[]
  fallbackChildId: string | undefined
  slugFallback: string | undefined
  /** 结果里的 `results[].branch`（台账缺失时的耐久兜底）。 */
  branchFallback: string | undefined
  t: ChatNodeViewProps<'orchestrate-call'>['t']
}) {
  const child = useChildOfTask(callId, task.label, task.index, fallbackChildId)
  /**
   * 展开区（2026-10-04 用户实测缺陷①）：分支卡原先只看得到 label/副行/chip，
   * 与 SubagentCard 不一致——用户无法查看该分支的**任务提示词**与**改动内容**。
   * 展开态放组件顶部，hooks 顺序恒定。
   */
  const [expanded, setExpanded] = useState(false)
  /**
   * **逐分支实时状态**（2026-09-12 用户实测缺陷修复）：工具结果整批返回，运行中它是空的，
   * 旧实现于是把每条分支恒判为「运行中」，某个分支自己跑完也不翻，必须等全部完成才一起翻。
   * 这里用该分支**自己子会话**的进度兜底：outcome 给终态（aborted 不算完成，终态=failed 时不覆盖）。
   */
  const live = useChildProgress(child)
  // 终态判定走 branchState 三参签名：data.outcomes + data.settled + 实时 stopReason，
  // 静态分支与 live 覆盖走同一判定（不再靠 outcomeState override）。
  const state = branchState(data, task.index, live?.stopReason)
  const liveOutcome = subagentOutcomeOf(live?.stopReason)
  useEffect(() => {
    if (liveOutcome !== undefined) onLiveSettled(task.index, liveOutcome)
  }, [liveOutcome, onLiveSettled, task.index])
  const chip = chipOf(state, t)
  // 模型：优先任务级声明（`tasks[i].model`），否则读子会话的 modelSelection 投影
  // （与 SubagentCard 同源——机制锁定的模型只有子会话自己知道）。
  const childModel = useChildModel(child)
  const model = task.model ?? childModel
  // 改动区需要的 worktree 三件套：slug 可得才给（SubagentChanges 缺 summary 时自返 null）。
  // branch 三层同 slug：实时台账 → 结果里的 `results[].branch` → 空串（SubagentChanges 自兜底）。
  const slug = worktrees[task.index]?.slug ?? slugFallback
  const worktreeForChanges = slug === undefined
    ? undefined
    : { slug, branch: worktrees[task.index]?.branch ?? branchFallback ?? '' }
  const sub = branchSubtitle(task, worktrees, slugFallback)
  return (
    <div className={css.branchRowWrap} data-state={state} data-expanded={expanded || undefined}>
      <div className={css.branchRow}>
        <span className={css.branchLine} data-tone={chip.tone} />
        <span className={css.branchNode} data-tone={chip.tone}>
          {state === 'running' && <span className={css.branchNodeDot} />}
          {state === 'done' ? <Check size={8} strokeWidth={3} /> : state === 'failed' ? <X size={8} strokeWidth={3} /> : state === 'aborted' ? <Ban size={8} strokeWidth={2.5} /> : <Loader size={6} strokeWidth={2.5} className={css.chipSpin} />}
        </span>
        {/* ★ 锚点（2026-09-18）：分支行就是该子会话在瀑布里的「卡片」——详情卡的跳转按钮按
            `data-child-session-id` 定位，缺了它就只对 SubagentCard 生效、对编排模式失效。 */}
        <div className={css.branchCard} data-child-session-id={child || undefined}>
          <span className={css.branchTx}>
            <span className={css.branchLabel}>{task.label}</span>
            {/* 副行 = 图标 + 文本：分支图标（隔离写任务，按状态着色）/ 书图标（只读调研，
                保持中性灰）。文字里不再出现 `worktree` 这个词。 */}
            <span className={css.branchSub} data-kind={sub.kind} data-tone={chip.tone}>
              {sub.kind === 'branch' && <GitBranch size={11} strokeWidth={2.5} className={css.branchSubIcon} />}
              {sub.kind === 'book' && <BookOpen size={11} strokeWidth={2.5} className={css.branchSubIcon} />}
              <span className={css.branchSubText}>{sub.text}</span>
            </span>
            {model !== undefined && (
              <span className={css.branchModel}>
                <Cpu size={11} strokeWidth={2} />
                <span className={css.branchModelText}>{model}</span>
              </span>
            )}
          </span>
          <span className={css.branchChip} data-tone={chip.tone}>
            <ChipIcon tone={chip.tone} />
            {chip.text}
          </span>
          <button
            type="button"
            className={css.gotoBtn}
            aria-expanded={expanded}
            aria-label={expanded ? t('subagent.collapse') : t('subagent.expand')}
            title={expanded ? t('subagent.collapse') : t('subagent.expand')}
            onClick={() => { setExpanded(open => !open) }}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {child !== undefined && (
            <button
              type="button"
              className={css.gotoBtn}
              aria-label={`进入子会话 ${task.label}`}
              title={`进入子会话 ${child}`}
              onClick={() => { chatRuntimeRef.current?.openSession?.(child) }}
            >
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className={css.branchDetail}>
          <div className={css.branchDetailHead}>
            <FileText size={13} strokeWidth={2} className={css.branchDetailIcon} />
            <span className={css.branchDetailTitle}>{t('subagent.taskDetail')}</span>
          </div>
          <div className={css.branchDetailBody}>
            {task.prompt ?? t('subagent.noTaskDetail')}
          </div>
          {/* 设计稿 Dt4fG（pending-hint）：执行中时在任务详情下方给一条 `$orch-code` 底的
              提示，说明结果/改动要等终态才出现。**只在 running 渲染**——终态后它还挂着
              会误导（用户以为数据没到）。以前这段只在设计稿里有、实现里缺。 */}
          {state === 'running' && (
            <div className={css.branchPendingHint}>
              <Loader size={12} strokeWidth={2.5} className={css.branchPendingIcon} />
              <span className={css.branchPendingText}>{t('orchestrate.pendingHint')}</span>
            </div>
          )}
          {/* 段间分隔线（设计稿 branch-expanded 里「任务详情 → 结果 → 改动」三段靠 1px
              弱线区隔，不是三张各自带底的卡）。 */}
          <div className={css.branchDivider} />
          {/* 结果区（#98）：这条分支的子 Agent **最终返回**了什么。
              与任务详情（父注入的指令）分两段，用户不必点进子会话。
              与子 Agent 卡共用 ./SubagentResult.tsx，只是换 branch 样式族。
              `settled` = 该分支已到终态：running→done 翻转时自动重拉一次，
              否则展开那一刻（子 Agent 还在跑）拉到的空结果会一直挂在卡上。 */}
          <SubagentResult childSessionId={child} t={t} settled={state !== 'running'} variant="branch" />
          <SubagentChanges childSessionId={child} worktree={worktreeForChanges} t={t} />
        </div>
      )}
    </div>
  )
}

/** 结尾节点（收尾）的渲染态。见 OrchestrateCardImpl 里的状态表。 */
type CloseStageState = 'queued' | 'closing' | 'done' | 'failed' | 'pending'

/** chip 的语义色键（复用卡片既有 token；`queued` 走品牌蓝，与「运行中」区分）。 */
type CloseChipTone = 'queued' | 'running' | 'done' | 'failed' | 'pending'

/**
 * 收尾报告正文的摘要（收起态用）。
 *
 * 黑盒化后 closer 的报告就是各任务正文的唯一去处，长度不可控（N 个任务的汇总），
 * 卡上直接铺全文会把瀑布流撑爆。故收起态只给**前几行（且不超过一定字符）**，
 * 全文走展开态或「进入子会话」。按行截断优先：报告是 markdown，断在行边界才不会
 * 切坏表格/代码块；行内过长（单行巨型表格）再由字符上限兜底。
 * @param report - `closer.report` 全文。
 * @returns 摘要文本与是否被截断。
 */
function reportPreviewOf(report: string): { text: string; truncated: boolean } {
  const MAX_LINES = 6
  const MAX_CHARS = 480
  const lines = report.split('\n')
  let text = lines.slice(0, MAX_LINES).join('\n')
  let truncated = lines.length > MAX_LINES
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS)
    truncated = true
  }
  return { text: text.trimEnd(), truncated }
}

/**
 * 结尾节点的文案（副行 + chip）。五个态各一句；`done` 再按机制判定的三场景分岔
 * （merge / summarize / research）——**这是「这次到底有没有合并」的唯一权威回答**。
 *
 * 为什么集中在这里：这段文案原先在 JSX 里嵌了五层三元，加场景维度会变成不可读的
 * 嵌套；抽成纯函数后每个态一行、每个场景一行，改文案不用碰渲染结构。
 * @param state - 结尾节点态。
 * @param scenario - 机制判定的收尾场景（undefined = 还没回，不猜）。
 * @param t - i18n。
 * @param detail - 该态的补充说明（历史会话 `integration.reason` / `closer.error`）；
 *   缺省时用该态的通用文案。
 * @returns 标题、副行、chip 文案与色键。
 */
function closeStageCopy(
  state: CloseStageState,
  scenario: OrchestrateCloserScenario | undefined,
  t: ChatNodeViewProps<'orchestrate-call'>['t'],
  detail?: string,
): { title: string; sub: string; chip: string; tone: CloseChipTone } {
  const title = t('orchestrate.close.title')
  if (state === 'queued') {
    return { title, sub: t('orchestrate.close.queuedSub'), chip: t('orchestrate.close.queued'), tone: 'queued' }
  }
  if (state === 'closing') {
    return { title, sub: t('orchestrate.close.closingSub'), chip: t('orchestrate.close.closing'), tone: 'running' }
  }
  if (state === 'failed') {
    return { title, sub: detail ?? t('orchestrate.close.failedSub'), chip: t('orchestrate.close.failed'), tone: 'failed' }
  }
  if (state === 'pending') {
    return { title, sub: detail ?? t('orchestrate.close.pendingSub'), chip: t('orchestrate.close.pending'), tone: 'pending' }
  }
  // done：三场景各一句话（这是「有没有合并」的唯一权威回答）。
  if (scenario === 'summarize') {
    return { title, sub: t('orchestrate.close.doneSummarize'), chip: t('orchestrate.close.summarized'), tone: 'done' }
  }
  if (scenario === 'research') {
    return { title, sub: t('orchestrate.close.doneResearch'), chip: t('orchestrate.close.researched'), tone: 'done' }
  }
  return { title, sub: t('orchestrate.close.doneMerge'), chip: t('orchestrate.close.merged'), tone: 'done' }
}

/**
 * 编排卡组件。
 * @param props - 槽运行时 share（node.data = 本卡的折叠结果）与 i18n。
 * @returns 设计稿 orchestrate-flow-card 的渲染。
 */
function OrchestrateCardImpl({ node, t }: ChatNodeViewProps<'orchestrate-call'>) {
  const data = node.data
  const [expanded, setExpanded] = useState(true)
  // 隔离台账（分支 chip 显示 worktree 名；恢复被 c0e69443 孤立的可见性）。
  const worktrees = useWorktreeLedger()
  const summary = summarize(data)
  /**
   * 逐分支实时终态集合（子 BranchRow 上报）。工具结果是整批返回的，只用
   * `summary.done` 会让卡头计数在整批 settle 前一直停在 0/N，与分支 chip 不一致。
   * aborted / failed 另记实时集合，保证卡头汇总也能区分。
   */
  const [liveCompleted, setLiveCompleted] = useState<ReadonlySet<number>>(() => new Set())
  const [liveAborted, setLiveAborted] = useState<ReadonlySet<number>>(() => new Set())
  const [liveFailed, setLiveFailed] = useState<ReadonlySet<number>>(() => new Set())
  const markLiveSettled = useCallback((index: number, outcome: 'completed' | 'aborted' | 'failed'): void => {
    if (outcome === 'completed') {
      setLiveCompleted(prev => prev.has(index) ? prev : new Set(prev).add(index))
    } else if (outcome === 'aborted') {
      setLiveAborted(prev => prev.has(index) ? prev : new Set(prev).add(index))
    } else {
      setLiveFailed(prev => prev.has(index) ? prev : new Set(prev).add(index))
    }
  }, [])
  /**
   * 全部任务是否都已拿到终态（实时或结果）。机制在任务全 settle 后**串行派发**
   * closer，所以「全终态 ∧ 结果未回」正是收尾节点在跑的那段窗口——别用「工具是否
   * settled」单独判：任务还在跑时它同样是 false。
   */
  const branchesAllTerminal = summary.total > 0
    && (Math.max(summary.done, Math.min(liveCompleted.size, summary.total))
      + Math.max(summary.aborted, liveAborted.size)
      + Math.max(summary.failed, liveFailed.size)) >= summary.total
  /**
   * 结尾节点（收尾）的渲染门 —— **并行编排恒渲染**（2026-10 迁移点，用户定调「有头有尾」）。
   *
   * 旧门是 `hasMerge || integration !== undefined`：`merge` 字段取消后 `hasMerge` 对新会话
   * **恒 false**，而新结果也不再产生 `integration` ⇒ 门恒假 ⇒ 整段结尾节点消失，卡片变成
   * 「有头无尾」（用户完全看不到这次编排是怎么收的）。
   *
   * 新门：`tasks ≥ 2`（并行编排）就恒渲染，态由 `data.closer` 决定；另外三条是**历史回放**
   * 的兼容项——旧会话可能只有 `integration`，或声明了 `merge` 却在收尾前就中止（只有
   * `hasMerge` 可依）。脚本模式（tasks 为空）不适用「并行」判据，有 closer 才渲染。
   */
  const showCloseStage = data.tasks.length >= 2
    || data.closer !== undefined
    || data.integration !== undefined
    || data.hasMerge
  const closer = data.closer
  /**
   * 结尾节点的五态（2026-10 三态 + 运行期两态）：
   *
   * | 态 | 判据 | 含义 |
   * |---|---|---|
   * | `queued` | 结果未回 ∧ 还有任务在跑 | 机制在等并行任务收尾 |
   * | `closing` | 结果未回 ∧ 任务全终态 | closer 正在跑（机制串行派发） |
   * | `done` | `closer` 在场 ∧ 无 error | 收尾成功（按 scenario 分三句话） |
   * | `failed` | `closer.error` 在场，或结果已回却什么都没有 ∧ 工具报错 | 收尾失败 |
   * | `pending` | 结果已回、无 closer、无 integration、工具未报错 | 历史/异常结果，见任务结果 |
   *
   * ⚠️ `failed` 必须区分「closer 自己失败」与「工具整体报错」：前者的 `results[]` 是完整的
   * （任务级引用照旧可用，损失面可见），后者才是整批失败。
   */
  const closeStage: CloseStageState = closer !== undefined
    ? closer.error === undefined ? 'done' : 'failed'
    : !data.settled
      ? branchesAllTerminal ? 'closing' : 'queued'
      : data.integration !== undefined
        ? data.integration.kind === 'integrated' ? 'done' : 'pending'
        : data.errored ? 'failed' : 'pending'
  /**
   * 结尾节点按哪个场景说话。closer 未回时**不猜**（场景是机制按隔离实况判的，猜错就是
   * 假信息）；历史会话只有 `integration` 时按 `merge` 讲（那时它只可能是集成者）。
   */
  const closeScenario: OrchestrateCloserScenario | undefined =
    closer?.scenario ?? (data.integration === undefined ? undefined : 'merge')
  // 收尾者子会话（运行期靠 spawn 广播 label 'closer'/'integrate'；刷新后靠结果里的 id）。
  const integratorChild = useIntegratorChild(
    data.callId,
    closer?.childSessionId ?? (data.integration?.kind === 'integrated' ? data.integration.childSessionId : undefined),
  )
  /**
   * 该态的补充说明：closer 自身失败的原因（`closer.error`）或历史会话的
   * `integration.reason`（如「2 个分支待集成」）——比通用文案信息量大得多，
   * 有就必须显示。其余态给 undefined，由 closeStageCopy 用通用文案。
   */
  const closeDetail = closer?.error
    ?? (data.integration !== undefined && data.integration.kind === 'pending' ? data.integration.reason : undefined)
  const closeCopy = closeStageCopy(closeStage, closeScenario, t, closeDetail)
  /**
   * 失败分支自己的理由（收尾失败展开区的「失败原因」段）。
   *
   * `closeDetail`（closer.error）说的是**收尾者**为什么失败，但用户更关心**哪条分支**
   * 挂了。两者不重叠：closer 可能压根没跑起来（分支先失败），此时只有任务级 error。
   * 故这里把每个 failed outcome 的 error 逐条列出，优先级低于 closeDetail（上游更强）。
   * 逐条带 label 前缀，免得「2 个分支都失败」时看不出是哪一个。
   */
  const failedReasons = useMemo<readonly string[]>(() => {
    const out: string[] = []
    for (const task of data.tasks) {
      const outcome = data.outcomes.get(task.index)
      if (outcome?.kind !== 'failed') continue
      const reason = outcome.error.trim()
      out.push(reason === '' ? task.label : `${task.label} · ${reason}`)
    }
    return out
  }, [data.tasks, data.outcomes])
  /**
   * 收尾报告正文（`closer.report`）——编排黑盒化后的**主交付**：各任务的正文不再进
   * `results[]`，而是汇总在这里。收起态给**截断摘要**，展开态给全文（可滚动），
   * 并给出「进入子会话看全文」的入口（`closer.childSessionId`）。
   */
  const [reportOpen, setReportOpen] = useState(false)
  const report = closer?.report
  const reportPreview = report === undefined ? undefined : reportPreviewOf(report)
  const doneCount = Math.max(summary.done, Math.min(liveCompleted.size, summary.total))
  const abortedCount = Math.max(summary.aborted, liveAborted.size)
  const failedCount = Math.max(summary.failed, liveFailed.size)
  // 整体状态：有失败=failed；否则全部有终态且 total>0 → 有 aborted 则 aborted，否则 done；否则 running。
  const failed = failedCount > 0 || (data.errored && !data.settled)
  const allSettled = failedCount === 0 && abortedCount === 0 && summary.total > 0 && doneCount === summary.total
  const allSettledWithAborted = failedCount === 0 && summary.total > 0 && (doneCount + abortedCount) === summary.total
  const overall: 'running' | 'done' | 'aborted' | 'failed' = failed ? 'failed' : allSettled ? 'done' : allSettledWithAborted ? 'aborted' : 'running'
  const overallText = overall === 'done'
    ? `${doneCount}/${summary.total} 完成`
    : overall === 'failed'
      ? `${doneCount}/${summary.total} · ${failedCount} 失败`
      : overall === 'aborted'
        ? `${doneCount}/${summary.total} 完成 · ${abortedCount} 已终止`
        : `并行执行中 · ${doneCount}/${summary.total}`

  return (
    <div className={css.card} data-state={overall} data-errored={data.errored || undefined}>
      <div className={css.head}>
        <span className={css.avatar}><Layers size={13} className={css.avatarIcon} /></span>
        <span className={css.meta}>
          <span className={css.name}>{summary.title}</span>
        </span>
        <span className={css.chip} data-tone={overall}>
          <ChipIcon tone={overall} />
          <span className={css.chipText}>{overallText}</span>
        </span>
        <button
          type="button"
          className={css.actBtn}
          aria-expanded={expanded}
          aria-label={expanded ? t('orchestrate.state.close') : t('orchestrate.state.open')}
          onClick={() => { setExpanded(open => !open) }}
        >
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>
      {expanded && (
        <div className={css.flow}>
          {/* 导轨列（设计稿 x=4）：node-start + trunk 虚线主干向下延伸。
              ★ 2026-10-19 结构变更：收尾节点**不再在导轨列**——收尾行已移出 flow
              改通栏（用户定调：收尾卡 x=0，不内缩到 60）。trunk 仍延伸到底部
              视觉上引导到下方的收尾行。 */}
          <div className={css.rail}>
            <span className={css.startNode}><span className={css.startDot} /></span>
            <span className={css.trunk} data-extend={showCloseStage || undefined} />
          </div>
          {/* 分支列（仅并行分支行，不含收尾节点）。 */}
          <div className={css.flowBody}>
            <div className={css.branches}>
              {data.tasks.map(task => (
                <BranchRow
                  key={task.index}
                  callId={data.callId}
                  task={task}
                  data={data}
                  onLiveSettled={markLiveSettled}
                  worktrees={worktrees}
                  fallbackChildId={data.childSessionIds?.[task.index]}
                  slugFallback={data.worktreeSlugs?.get(task.index)}
                  branchFallback={data.worktreeBranches?.get(task.index)}
                  t={t}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      {/* 收尾行（2026-10-19 用户定调）——**外层结构**，不与 work 项平级。
          已移出 flow：通栏宽（x=0，不内缩到 60）。
          收尾节点（mergeNode）与收尾卡（mergeCard）在同一行垂直居中。
          ★ 2026-10 编排黑盒化：并行编排恒有收尾节点，三场景由机制判定。
          五态见 closeStage 状态表。 */}
      {expanded && showCloseStage && (
        <div className={css.mergeStage} data-close-stage>
          <div className={css.mergeRow}>
            <span className={css.mergeNode} data-state={
              closeStage === 'done' ? 'done'
              : closeStage === 'failed' ? 'failed'
              : closeStage === 'closing' ? 'closing'
              : closeStage === 'queued' ? 'queued'
              : closeStage === 'pending' ? 'pending' : 'idle'
            }>
              {closeStage === 'failed'
                ? <X size={8} strokeWidth={3} />
                : closeStage === 'done' ? <Check size={8} strokeWidth={3} />
                : closeStage === 'closing' ? <Loader size={6} strokeWidth={2.5} className={css.chipSpin} />
                : <GitMerge size={8} />}
            </span>
            <div className={css.mergeCard} data-closer
              data-child-session-id={integratorChild || undefined}
              data-scenario={closeScenario}
              data-state={closeStage}>
              <span className={css.mergeIcon}>
                {closeStage === 'closing'
                  ? <Loader size={16} className={css.spin} />
                  : closeStage === 'failed' ? <X size={16} /> : <GitMerge size={16} />}
              </span>
              <span className={css.branchTx}>
                <span className={css.branchLabel}>{closeCopy.title}</span>
                <span className={css.branchSub}>{closeCopy.sub}</span>
              </span>
              {/* 控件顺序与子 Agent 行**严格一致**（2026-10-19 用户定调）：
                  状态 chip → chevron（展开收尾报告）→ arrow-right（进收尾者会话）。
                  旧顺序是 chevron → 箭头 → chip，导致两行的按钮组落不到同一列。
                  chevron 在**没有报告可展开**时也保留（disabled 语义换成「展开失败原因」），
                  这样右侧按钮组的位置在两态之间不会跳动。 */}
              <span className={css.branchChip} data-close-chip data-tone={closeCopy.tone}>
                <ChipIcon tone={closeCopy.tone} />
                {closeCopy.chip}
              </span>
              <button
                type="button"
                className={css.gotoBtn}
                aria-expanded={reportOpen}
                aria-label={reportOpen ? t('orchestrate.close.reportCollapse') : t('orchestrate.close.reportExpand')}
                title={reportOpen ? t('orchestrate.close.reportCollapse') : t('orchestrate.close.reportExpand')}
                onClick={() => { setReportOpen(open => !open) }}
              >
                {reportOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {/* 进入收尾者子会话看详情：closer 就是一次普通子会话，运行中即可点进去
                  看它到底在干什么。刷新后靠 `closer.childSessionId`（durable）。
                  **失败态也保留**——那时用户正需要看它为什么没收尾。 */}
              {integratorChild !== undefined && (
                <button
                  type="button"
                  className={css.gotoBtn}
                  title={t('orchestrate.close.gotoTitle', { session: integratorChild })}
                  aria-label={t('orchestrate.close.gotoAria')}
                  onClick={() => { chatRuntimeRef.current?.openSession?.(integratorChild) }}
                >
                  <ArrowRight size={16} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
          {/* 展开区（2026-10-19 用户拍板）：**失败时保留 chevron，但给「有内容的
              空态」而不是空壳**。报告确实没有产出，所以：
                · 标题不叫「收尾报告」，改叫「收尾结果」（不能对不存在的字段撒谎）；
                · 右侧等宽 tag 标明真实字段状态 `closer.report 未产出`；
                · 第一段解释「为什么这里是空的」；
                · 再把「失败原因」与「下一步」分成两段（原因=事实，下一步=行动）。
              成功态仍是原先的报告正文（截断摘要 → 全文）。 */}
          {report !== undefined ? (
            // 默认收起 = 什么都不渲染（用户要的「默认就是一张矩形卡」）；
            // 点卡头 chevron 才把摘要展出来。
            reportOpen ? (
              <div className={css.reportBox} data-report>
                <div className={css.reportBody} data-expanded>
                  {report}
                </div>
                {closer?.childSessionId !== undefined && (
                  <span className={css.reportHint}>{t('orchestrate.close.reportFullHint')}</span>
                )}
              </div>
            ) : (
              <span className={css.reportHint} data-collapsed-hint>
                {reportPreview?.truncated === true
                  ? t('orchestrate.close.reportTruncated')
                  : t('orchestrate.close.reportExpand')}
              </span>
            )
          ) : closeStage === 'failed' ? (
            // 失败态同样**默认收起**：卡头 chevron 是唯一的展开开关，
            // 展开后才出「为什么空 / 失败原因 / 下一步」三段。
            reportOpen ? (
              <div className={css.reportBox} data-report data-failure>
                <span className={css.reportAbsentTag}>{t('orchestrate.close.failReportAbsent')}</span>
                <div className={css.reportBody} data-expanded>
                  {t('orchestrate.close.failReportBody')}
                </div>
                <div className={css.reportDivider} />
                <span className={css.reportSectionTitle} data-tone="failed">{t('orchestrate.close.failReasonsTitle')}</span>
                <div className={css.reportList}>
                  {/* closer 自报的错误优先；没有则用本轮失败任务的理由；再没有给一句兜底。 */}
                  {(closeDetail !== undefined && closeDetail !== '' ? [closeDetail] : failedReasons).map((reason, index) => (
                    <div key={index} className={css.reportListItem}>{reason}</div>
                  ))}
                  {closeDetail === undefined && failedReasons.length === 0 && (
                    <div className={css.reportListItem}>{t('orchestrate.close.failReasonDefault')}</div>
                  )}
                </div>
                <div className={css.reportDivider} />
                <span className={css.reportSectionTitle} data-tone="brand">{t('orchestrate.close.nextStepsTitle')}</span>
                <div className={css.reportList}>
                  <div className={css.reportListItem}>{t('orchestrate.close.nextStepInspect')}</div>
                  <div className={css.reportListItem}>{t('orchestrate.close.nextStepRedispatch')}</div>
                </div>
              </div>
            ) : null
          ) : null}
          {/* 机制在编排期间收拢的内部说明（原本会以 notice 注入父会话的那些）——
              黑盒化后它们是**唯一**能告诉用户「子 Agent 的 settle 被谁吞了」的线索。 */}
          {closer?.internalNotes !== undefined && closer.internalNotes.length > 0 && (
            <div className={css.reportBox} data-notes>
              <span className={css.notesTitle}>{t('orchestrate.close.notesTitle', { count: closer.internalNotes.length })}</span>
              {closer.internalNotes.map((note, index) => (
                <div key={index} className={css.notesItem}>{note}</div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* 折叠态弱提示（设计稿 J6SbNw 的 collapsed-note Z0FTFz）：
          折叠态只保留卡头：标题 + 状态 chip + 计数，点击 chevron 展开完整流程。 */}
      {!expanded && (
        <div className={css.collapsedNote}>
          <Info size={11} strokeWidth={2.5} />
          <span className={css.collapsedNoteText}>{t('orchestrate.collapsedHint')}</span>
        </div>
      )}
    </div>
  )
}

export const OrchestrateCard = memo(OrchestrateCardImpl)
