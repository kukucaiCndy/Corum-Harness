/**
 * corum 领域事件的 cordis `Events` 声明 + Remote 转发选择面（自包含）。
 *
 * fork（corum）：本文件从 `@corum/corum-agent/src/events.ts:212-238` **复制**
 * 12 个领域事件的 `declare module '@deepseek-ai/cordis'` 声明（外加本期新增的
 * 第 13 个 `corum/terminal/output`，见 UNIFIED-EVENT-BUS §3），**不
 * type-import corum-agent**——它是 host-only 包，其 events.ts 有 node-only 值
 * 导入（`./event-log.ts` 追加 jsonl），被拖进 client 编译面会炸。载荷类型在此
 * 自包含重声明（结构以 corum-agent/events.ts 为事实源，均为纯 JSON）。
 *
 * 同时照 `@deepseek-ai/dsh-api-session-controller/src/remote-events.ts:9-12`
 * 的写法，把 corum 事件并入 `TypertRemoteEventSelection`——renderer
 * `ctx.remote.$on('corum/...', cb)` 的 key 面与 listener 签名由此投影。
 *
 * @module @corum/corum-api-remotes/corum-events
 */

// waterfall 事件的 Scoped<Agent> this 参数类型（与 approval/request 同形）。
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'

// ── 载荷类型（自包含重声明；事实源 = corum-agent/src/events.ts）──────────────

/** 队列条目实体类型（轻量指针，全文在 ctx.project 共享实体）。 */
export type TaskEntityType = 'task' | 'bug' | 'requirement' | 'discussion' | 'review'

/** 队列条目来源通道（谁提交的、经哪条路进入调度）。 */
export type TaskVia = 'transfer' | 'bug-report' | 'user-instruction' | 'dependency' | 'pm-decision'

/** 队列条目来源追溯（提交方组装谁填；支撑回溯与依赖追踪）。 */
export interface TaskSource {
  /** 提交方：角色 profileId、'user' 或 'runtime'。 */
  readonly submitter: string
  readonly via: TaskVia
  readonly at: number
  /** 因果链（阻塞派生/依赖解除/转交等）。 */
  readonly cause?: {
    readonly kind: 'blocked-by' | 'depends-on' | 'assigned' | 'reported'
    readonly byTaskId?: string
  }
}

/** 任务的领域引用（队列条目的 JSON-safe 快照）。 */
export interface TaskRef {
  readonly id: string
  /** 所属项目 id（调度隔离边界）。 */
  readonly projectId: string
  /** 目标角色 = AgentProfile id。 */
  readonly profileId: string
  /** 实体类型（轻量指针指向的共享实体类别；调度期临时任务也用 task）。 */
  readonly entityType: TaskEntityType
  /** 指向 ctx.project 共享实体的 id（未接实体时缺省，队列 id 即临时实体引用）。 */
  readonly entityId?: string
  /** 泳道路由标签：关联需求时为 `<requirementId>:<type>`，否则兼容退化为 `<type>`。 */
  readonly label: string
  /** 工作类型 slug（泳道语义仍保留；路由键是 label）。 */
  readonly type: string
  /** 关联需求 id（label 的需求段；未关联缺省）。 */
  readonly requirementId?: string
  /** 任务摘要。 */
  readonly summary: string
  /** 增量 context（提交方组装，可选）。 */
  readonly transferNote?: string
  /** 来源追溯（提交方/通道/时间/因果）。 */
  readonly source: TaskSource
  /** 优先级（0-3，可选；排序策略后续接）。 */
  readonly priority?: number
}

/** corum/task/assigned：任务入队。 */
export interface TaskAssignedEvent {
  readonly task: TaskRef
  /** 派发者：派活的角色 profileId、'user'（界面/RPC）或 'runtime'（调度器自派生）。 */
  readonly actor: string
  /** 入队后该「项目 × 角色」的队列长度（水位信号）。 */
  readonly queueLength: number
}

/** corum/task/started：任务已派进泳道会话。 */
export interface TaskStartedEvent {
  readonly task: TaskRef
  /** 承载该任务的泳道会话 id。 */
  readonly sessionId: string
  /** 任务占用该会话的起始 seq（团队日志 → Agent 工作现场的下钻起点）。 */
  readonly fromSeq: number
}

/** 指向泳道会话日志里一段工作成果的引用（TEAM-SCHEDULER-EVENT-LOG §6）。 */
export interface SessionResultRef {
  /** 泳道会话 id（官方 session 日志身份）。 */
  readonly sessionId: string
  /** 任务占用该会话的 seq 区间起点。 */
  readonly fromSeq: number
  /** 区间终点（completed 时补齐）。 */
  readonly toSeq: number
}

/** corum/task/completed：任务闭环。 */
export interface TaskCompletedEvent {
  readonly task: TaskRef
  /** 成果落点引用（下钻路径：resultRef → 官方 session 日志 readFrom(sessionId, fromSeq)）。 */
  readonly resultRef: SessionResultRef
  /** 执行侧的完成说明（complete_task 上报原文）。 */
  readonly result: string
}

/** corum/task/deferred：派发失败，任务放回队首重试（泳道会话未建立，无 sessionId）。 */
export interface TaskDeferredEvent {
  readonly task: TaskRef
  /** 失败原因（真实异常摘要）。 */
  readonly reason: string
}

/** corum/task/evicted：任务未执行即被逐出队列。 */
export interface TaskEvictedEvent {
  readonly task: TaskRef
  /** 逐出原因（如成员被移出项目组）。 */
  readonly reason: string
}

/** corum/task/blocked：任务遇阻塞即停，挂起（单阻塞链：同刻至多一个阻塞源）。 */
export interface TaskBlockedEvent {
  readonly task: TaskRef
  /** 阻塞原因（执行侧陈述缺什么前置信息）。 */
  readonly reason: string
  /** 派生的「解除阻塞」任务 id（阻塞源；它完成时本任务被反查唤醒）。 */
  readonly blockedByTaskId: string
}

/** corum/task/unblocked：依赖任务完成，挂起任务回队列（调度器反查推导，C 无需知道 B）。 */
export interface TaskUnblockedEvent {
  readonly task: TaskRef
  /** 解除阻塞的任务 id（刚 completed 的那个）。 */
  readonly unblockedByTaskId: string
}

/** corum/task/stalled：执行中任务超过阈值无活动（卡住感知；不改变任务状态）。 */
export interface TaskStalledEvent {
  readonly task: TaskRef
  /** 距最后活动的秒数。 */
  readonly idleSec: number
}

/** corum/task/steered：对执行中任务插入引导（下一步边界生效，不打断）。 */
export interface TaskSteeredEvent {
  readonly task: TaskRef
  /** 引导内容（收敛指令）。 */
  readonly note: string
  /** 操作者（'pm' | 'user'）。 */
  readonly by: string
}

/** corum/task/cancelled：中止执行中/挂起任务。 */
export interface TaskCancelledEvent {
  readonly task: TaskRef
  /** 中止原因。 */
  readonly reason: string
  /** 处置：requeue（回队重派）| evicted（废弃）| reassigned（改派他人，新 assigned 另发）。 */
  readonly fate: 'requeue' | 'evicted' | 'reassigned'
  /** 操作者（'pm' | 'user'）。 */
  readonly by: string
}

/** 项目组成员（引用式；与 corum-agent/project.ts 的 ProjectGroupMember 同构）。 */
export interface ProjectGroupMember {
  readonly profileId: string
  /** 调度角色：pm（会话统筹 + 人机交互入口）或 member（普通执行成员）。 */
  readonly role: 'pm' | 'member'
  /** 数据层专业角色（权限网关用，可选）。 */
  readonly profession?: 'pd' | 'techLead' | 'dev' | 'qa'
  /** 来源团队 id（可追溯「这个成员来自哪个团队」；独立 Agent 无此字段）。 */
  readonly fromTeam?: string
}

/** corum/group/member-added：成员加入项目组。 */
export interface GroupMemberAddedEvent {
  readonly projectId: string
  /** 加入的成员（引用式：profileId + role + 可选 fromTeam）。 */
  readonly member: ProjectGroupMember
}

/** corum/group/member-removed：成员被移出项目组（调度器据此回收其运行时）。 */
export interface GroupMemberRemovedEvent {
  readonly projectId: string
  readonly profileId: string
}

/** corum/terminal/output：终端 pty 输出推送（统一事件中心一期真实迁移；host corumTerminal 在 proc.onData 里 emit）。 */
export interface TerminalOutputEvent {
  /** 终端会话 id（corumTerminal/create 返回）。 */
  readonly id: string
  /** 本帧 pty 输出（原始字节串，含 ANSI 控制序列）。 */
  readonly data: string
  /**
   * 帧序号（会话内单调递增；断链补帧用）。renderer 发现 `seq > lastSeq + 1`
   * 即判定断链窗口丢帧，经 `corumTerminal/snapshot(id, lastSeq)` 补拉。
   */
  readonly seq: number
}

/** corum/file/changed 单条变更（与 host corum-fs changeLog 条目同构）。 */
export interface FileChangeEntry {
  /** 相对项目根的路径（/ 开头）。 */
  readonly path: string
  /** fs watch 事件类型：rename（创建/删除/改名）或 change（内容变更）。 */
  readonly kind: 'rename' | 'change'
}

/** corum/file/changed：项目根递归 watch 的去抖批量变更推送（统一事件中心二期真实迁移；host corumFs 在 watcher 去抖回调里 emit——一个去抖窗口发一帧，载荷是该窗口累积的 changes 数组）。 */
export interface FileChangedEvent {
  /** 本去抖窗口累积的变更（批量；与 pollChanges 取走的 changeLog 同构）。 */
  readonly changes: FileChangeEntry[]
}

/**
 * corum/subagent/progress：子 Agent 会话进度增量推送（统一事件中心三期真实
 * 迁移；host corumAgent 在官方 `session/event` 追加点对 origin='subagent'
 * 会话维护 O(1) 折叠状态，仅在折叠快照变化时 emit——取代 SubagentCard 的
 * 2s 全量重读轮询，折叠口径与 corumAgent/getChildSessionProgress 一致）。
 */
/**
 * 子 Agent 终态推导的唯一口径家（corum fork 增量）。
 *
 * 根因：`done` 布尔只表达「最新 turn 已闭合（turn/end）」，中断同样闭合 turn，
 * 于是 done=true 被渲染成成功。这里用 `turn/end.reason.kind` 推导真正的终局
 * 原因，再映射成三态终态（completed / aborted / failed），供所有消费方统一走。
 *
 * 与 `corum-subagent/src/lifecycle.ts:236-261` 的 `epochStopReason` 同语义
 * （那份在字节锁定文件里，不可 import）。未知原因绝不能算成功 → 归为 error。
 */

/** 子 Agent 终局原因（自包含重声明；事实源 corum-subagent/src/types.ts:215-229）。 */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/**
 * 宿主侧推导：`turn/end.reason.kind` → `SubagentStopReason`。
 * aborted|interrupted → 'aborted'；max-tokens → 'max-tokens'；
 * error → 'error'；blocked → 'refusal'；completed|undefined → 'completed'；
 * 其它未知 → 'error'（未知原因绝不能算成功）。
 */
export function stopReasonOfTurnEnd(kind: string | undefined): SubagentStopReason {
  switch (kind) {
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'max-tokens':
      return 'max-tokens'
    case 'error':
      return 'error'
    case 'blocked':
      return 'refusal'
    case 'completed':
    case undefined:
      return 'completed'
    default:
      return 'error'
  }
}

/**
 * 委派角色（UI 图标/小标用）——**只从委派工具名派生，绝不按 label 文案猜**
 * （2026-09-12 用户定调）。
 *
 * - `research`：只读调研子 Agent（`subagent_research` 工具实例，工具层硬只读）；
 * - `fork`：上下文继承子 Agent（`subagent_fork` 工具实例，官方 fork 语义 + corum 机制）；
 * - `worker`：常规执行委派（`subagent`）；orchestrate/orchestrate 脚本派出的子 Agent
 *   也归此类（它们没有父侧 tool/call 名，取不到即按执行算，不冒充调研/分叉）。
 */
export type SubagentDelegationRole = 'worker' | 'research' | 'fork'

/**
 * 委派工具名 → 角色。工具名是父会话日志里那条 `tool/call` 的 `name`（权威面）。
 * @param toolName - 委派工具名（`subagent` / `subagent_research` / `subagent_fork`）。
 * @returns 角色；不是已知的 corum 委派工具名时返回 undefined（调用方决定兜底）。
 */
export function subagentDelegationRoleOf(toolName: string | undefined): SubagentDelegationRole | undefined {
  if (toolName === 'subagent_research') return 'research'
  if (toolName === 'subagent_fork') return 'fork'
  if (toolName === 'subagent') return 'worker'
  return undefined
}

/** 子 Agent 终态（三态；运行中 = undefined）。 */
export type SubagentOutcome = 'completed' | 'aborted' | 'failed'

/**
 * stopReason → 终态；undefined（还没结束）→ undefined。
 * completed → 'completed'；aborted → 'aborted'；
 * error|max-tokens|refusal → 'failed'；undefined → undefined。
 */
export function subagentOutcomeOf(stopReason: SubagentStopReason | undefined): SubagentOutcome | undefined {
  switch (stopReason) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'aborted'
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return 'failed'
    case undefined:
      return undefined
  }
}

/** 终态 → 通知色调（与 notifications.ts 的 NotificationTone 同词）。 */
export function subagentOutcomeTone(outcome: SubagentOutcome): 'success' | 'warn' | 'error' {
  switch (outcome) {
    case 'completed':
      return 'success'
    case 'aborted':
      return 'warn'
    case 'failed':
      return 'error'
  }
}

/** 终态 → 卡片/chip 色调词表（running/done/aborted/failed）。 */
export function subagentOutcomeChipTone(outcome: SubagentOutcome | undefined): 'running' | 'done' | 'aborted' | 'failed' {
  switch (outcome) {
    case 'completed':
      return 'done'
    case 'aborted':
      return 'aborted'
    case 'failed':
      return 'failed'
    case undefined:
      return 'running'
  }
}

/**
 * 子 Agent 展示态（**五态**：含运行中，与「半途失去运行」的 interrupted）。
 *
 * 2026-09-13 收口（用户实测「卡片停在 Running」修复的尾巴）：`interrupted` 此前只在
 * 卡片一处落地，会话条花名册/胶囊仍把它算成「已完成」——**同一个终态在两处不同源**。
 * 这类「判据与展示不同源」是 BUG-31 的同族病（见 LESSONS §6.25），故把分类提成
 * 唯一函数，卡片、花名册、通知桥都走它。
 */
export type SubagentProgressState = 'running' | 'completed' | 'aborted' | 'failed' | 'interrupted'

/** 已结束的展示态（通知/色调只对它们有意义）。 */
export type SubagentTerminalState = Exclude<SubagentProgressState, 'running'>

/**
 * 进度投影 → 展示态（**唯一判据家**）。输入的**优先级从高到低**：
 * 1. `stopReason`：`turn/end.reason.kind` 推出的**权威**终局原因——有它就以它记账；
 * 2. `interrupted`：宿主判定「这个子会话半途失去运行」（进程被杀/重启把未闭合的
 *    `turn/start` 留在 log 里；见 `corum-agent/src/agent-service.ts` 的判据注释）。
 *    宿主**只在拿不到 `stopReason` 时**才置它，故它是「没有原因时的诚实补标」，
 *    而不是用来覆盖权威原因的；它也优先于下面的 done 兜底（这类条目 done 也是 true）。
 * 3. `delegationFailed`：父侧 `tool/result` 报错（`isError`）——**子会话从未创建**时
 *    的唯一失败证据（2026-09-19 用户实测：模型不可用在 spawn 期预检失败，子会话不存在，
 *    故没有任何 stopReason / interrupted 可给，卡片就会永远转圈）。它排在 `done` 之前：
 *    一次已报错的委派不可能「已完成」。
 * 4. `done`：turn 已闭合/宿主已判终局、但拿不到原因（历史条目、冷恢复）→ 按「已完成」
 *    兜底（与 BUG-31 的折叠判据同源：不能因为拿不到原因就永远算运行中）。
 */
export function subagentProgressStateOf(progress: {
  readonly stopReason?: SubagentStopReason
  readonly done?: boolean
  readonly interrupted?: boolean
  /** 父侧工具结果报错（本次委派失败，且子会话可能从未创建）。 */
  readonly delegationFailed?: boolean
}): SubagentProgressState {
  const outcome = subagentOutcomeOf(progress.stopReason)
  if (outcome !== undefined) return outcome
  if (progress.interrupted === true) return 'interrupted'
  if (progress.delegationFailed === true) return 'failed'
  return progress.done === true ? 'completed' : 'running'
}

/** 已结束态 → 通知色调；interrupted 与 aborted 同档（warn）——都不是成功。 */
export function subagentTerminalTone(state: SubagentTerminalState): 'success' | 'warn' | 'error' {
  switch (state) {
    case 'completed':
      return 'success'
    case 'aborted':
    case 'interrupted':
      return 'warn'
    case 'failed':
      return 'error'
  }
}

/**
 * 展示态 → chip 色调词表。**不扩词表**：interrupted 复用 aborted 档
 * （都不是成功；点色/底色的 CSS 词表只有 running/done/aborted/failed 四档）。
 */
export function subagentStateChipTone(state: SubagentProgressState): 'running' | 'done' | 'aborted' | 'failed' {
  if (state === 'interrupted') return 'aborted'
  return subagentOutcomeChipTone(state === 'running' ? undefined : state)
}

/**
 * 子 Agent 终态时的改动摘要（corum fork 增量）。
 *
 * 数据源 = host `corumReview.snapshot(childSessionId)`（子会话轮次的影子 git
 * 快照）+ worktree 台账状态（隔离时按 slug 相关）。仅终态帧携带（terminal
 * backfill），运行中帧缺省——卡片在子 Agent 完成后才展示「改动」区。
 * 所有字段可选：host 不带 corumReview 或取不到时整段缺省，卡片降级为「无改动」。
 */
export interface SubagentChangeSummary {
  /** 改动文件数。 */
  readonly filesChanged: number
  /** 逐文件改动行数（±N）；可能缺省（host 取不到 diff 时只给 count）。 */
  readonly files?: readonly {
    /** 相对路径（子会话 cwd 下）。 */
    readonly path: string
    /** 新增行数。 */
    readonly added: number
    /** 删除行数。 */
    readonly removed: number
    /**
     * 改前内容状态（2026-09-13 收口，问题 1-④⑤）。
     * `unavailable` = 过大/二进制/影子仓库里没有改前版本——常见成因是轮末并集
     * 兜底把「窗口内 mtime 变脏但非本 Agent 所写」的路径补进了本轮；UI 把这种
     * 行置灰（不可点 diff、不可撤销，标注「无可撤销内容」）。
     */
    readonly status?: 'content' | 'absent' | 'unavailable' | 'missing'
  }[]
  /** 隔离 worktree slug（隔离时携带，非隔离缺省）。 */
  readonly worktreeSlug?: string
  /** 隔离 worktree 分支名（隔离时携带）。 */
  readonly worktreeBranch?: string
  /** 隔离 worktree 完整路径（供 diff 打开时拼绝对路径；隔离时携带）。 */
  readonly worktreePath?: string
  /** 是否已在 worktree 分支内提交（committed）。 */
  readonly committed?: boolean
  /** 是否已集成回主工作区（台账 status='integrated'）。 */
  readonly integrated?: boolean
}

/**
 * ⚠️ UI 口径规矩（硬要求）：UI 里禁止用 `done` 布尔表达「结束了」。
 * `done` 只表示「最新 turn 已闭合」，中断同样闭合 turn。任何终态判定必须走
 * `subagentOutcomeOf(stopReason)`。
 */
/**
 * 子 Agent 的计划项（与 `@deepseek-ai/dsh-tool-todo` 的 `TodoItem` 结构同构）。
 * 结构镜像而非导入，避免给 corum-api-remotes 增加 dsh-tool-todo 依赖（该包
 * 只做事件声明/转发，不应耦合工具实现包）。
 */
export interface SubagentTodoItem {
  /** 任务内容（一句短祈使句）。 */
  readonly content: string
  /** 生命周期状态。 */
  readonly status: 'pending' | 'in_progress' | 'completed'
}

export interface SubagentProgressEvent {
  /** 子会话 id（origin='subagent' 的 UUID id）。 */
  readonly sessionId: string
  /** 最新已开启 turn（0 = 尚未开 turn）。 */
  readonly turn: number
  /** 当前 turn 已闭合 step 数。 */
  readonly step: number
  /** 当前动作（最新工具调用名）；无进行中动作时缺省。 */
  readonly currentAction?: string
  /**
   * 最新 turn 已闭合（turn/end）。
   * ⚠️ 不代表终态，只表示 turn 闭合；中断同样闭合 turn。终态看 `stopReason`。
   */
  readonly done: boolean
  /** 终局原因；仅在该 turn 闭合时给出（undefined = 运行中/未结束）。 */
  readonly stopReason?: SubagentStopReason
  /** 触发本帧的源事件时间（ms epoch）。 */
  readonly lastActive: number
  /**
   /**
    * 子 Agent 的当前计划列表（`todo/write` 折叠；`turn/start` 时重置为空）。
    * 缺省表示无计划（子 Agent 未用 todo 工具）——消费者应隐藏计划区。
    */
  readonly todos?: readonly SubagentTodoItem[]
  /**
    * 终态改动摘要（corum fork 增量）。
    *
    * 仅在终态帧（`done=true`）的 terminal backfill 路径填充——host 从
    * `corumReview.snapshot(childSessionId)` 取改动文件列表 ±N，从 worktree
    * 台账取 committed/integrated 状态。运行中帧缺省；卡片据此决定是否渲染
    * 「改动」区。所有子字段可选：取不到时卡片降级。
    */
  readonly changeSummary?: SubagentChangeSummary
}

/**
 * corum/subagent/child：宿主 spawn 子 Agent 时发出的**精确父子映射**
 * （2026-09-09 用户反馈「子 Agent 处理时无法进入子会话实时查看」）。
 *
 * 背景：SubagentCard 过去只能靠「会话列表里 origin='subagent' 且时间最近的
 * 一行」猜 childSessionId——父会话在等工具结果时不再产生事件、卡片不重算，
 * 于是整个运行期拿不到 id（goto 按钮 disabled、进度帧也过滤不了），只有子会话
 * 结束、父会话追加工具结果后才匹配上。宿主在 `subagents.start()` 返回的同一刻
 * 就知道 `run.id`（= 子会话 id），按父侧 tool/call id 精确广播即可让卡片在
 * 第一帧就能跳转与订阅进度。
 */
/**
 * `corum/subagent/interrupted` 帧（corum fork 增量，2026-09-13 用户定调「要发通知」）。
 *
 * 为什么需要它：`interrupted`（半途失去运行）**不是事件**——它是宿主对「上一个进程
 * 生命周期留下的未闭合 turn」的判定，只能在**读取**（`corumAgent/getChildSessionProgress`）
 * 时得出。而通知桥只消费推送帧，于是这种子 Agent 此前完全静默（用户 2026-09-12
 * 实测：8 张卡里 1 张「已中断」，通知栏一条都没有）。
 *
 * 故宿主在**发现点**（RPC 里第一次判出 interrupted）补发这一帧，进程内按子会话去重
 * （同一子会话只广播一次，见 agent-service 的 `notifiedInterrupted`）。语义上这是
 * 「事实被知晓」的一次性广播，不是状态轮询——消费者只需把它翻成一条通知。
 */
export interface SubagentInterruptedEvent {
  /** 被中断的子会话 id（origin='subagent'）。 */
  readonly sessionId: string
  /** 父会话 id（通知的跳转目标；宿主认不出归属时缺省）。 */
  readonly parentSessionId?: string
  /** 宿主判定依据：`not-running`（registry 说它没在跑）/ `pre-boot`（最后事件早于本进程启动）。 */
  readonly reason: 'not-running' | 'pre-boot'
  /** 未闭合 turn 的序号（0 = 连 turn 都没开全）。 */
  readonly turn: number
  /** 该 turn 已闭合的 step 数。 */
  readonly step: number
  /** 最后一条事件的时间（ms epoch）。 */
  readonly lastActive: number
}

export interface SubagentChildEvent {
  /** 父会话 id（卡片按当前会话过滤）。 */
  readonly parentSessionId: string
  /** 父侧 tool/call id（卡片按它精确匹配本次委托）。 */
  readonly callId: string
  /** 子会话 id（origin='subagent'）。 */
  readonly childSessionId: string
  /** 委托标签（工具 description / 任务 label）。 */
  readonly label: string
  /** 是否隔离到独立 worktree（false = 直接在主工作区）。 */
  readonly isolated: boolean
  /**
   * 委派角色（父侧 tool/call 的工具名派生；取不到工具名的路径缺省）。
   * 卡片图标与会话条角色小标只认这个字段——**不按 label 文案猜**。
   */
  readonly role?: SubagentDelegationRole
  /** 前台一次性（父等结果）还是后台 agent（父继续干活、可续接）。 */
  readonly mode: 'foreground' | 'background'
  /** 隔离时的 worktree 三件套（台账 chip 与卡片提示用）。 */
  readonly worktree?: { readonly slug: string; readonly branch: string; readonly path: string }
  /**
   * 本次 spawn 的真实生效模型路由（UI 侧花名册行 / 工作区行的模型 chip 用）。
   *
   * 取值 = `request.agentOptions` 的 provider/model/reasoningEffort（锁定路径 =
   * 角色锁模型；非锁定/fork 路径 = 从父合并来的父真实路由）；若缺失则退回
   * `corumEffectiveModel`；两者都无则不写该字段（不伪造空对象）。reasoningEffort
   * 缺失时省略该键。
   */
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  /** 广播时间（ms epoch）。 */
  readonly time: number
}

/**
 * corum/artgen/download-progress：文生图引擎/模型下载进度推送（P2-7；
 * host corumArtGen 的 downloadSlots 每次写入即 emit——取代设置页 500ms 轮询
 * `corumArtGen/getDownloadProgress`）。
 */
export interface ArtgenDownloadProgressEvent {
  /** 槽位：engine（sd-cli 二进制）或 model（SD 模型）。 */
  readonly key: 'engine' | 'model'
  readonly percent: number
  readonly downloadedBytes: number
  readonly totalBytes: number
  /** 下载状态（'downloading' | 'done' | 'error' | 'idle'）。 */
  readonly status: string
  /** 失败原因（status='error' 时）。 */
  readonly error?: string
  /** 下载目标文件名（模型 = 文件名；引擎 = sd-cli-download.zip）。2026-09-09 新增。 */
  readonly target?: string
  /** 瞬时下载速度（字节/秒；滑动窗口）。2026-09-09 新增。 */
  readonly bytesPerSecond?: number
  /** 预计剩余秒数。2026-09-09 新增。 */
  readonly etaSeconds?: number
}

/**
 * corum/artgen/job-progress：文生图任务进度推送（P2-7；host corumArtGen 的
 * txt2imgJobs 每次 percent/phase/终态变更即 emit——取代设置页 400ms 轮询
 * `corumArtGen/getTxt2ImgJob`）。
 */
export interface ArtgenJobProgressEvent {
  readonly jobId: string
  readonly status: 'running' | 'done' | 'error'
  readonly percent: number
  /** 阶段（queued / starting / generating / sampling / decoding / done）。 */
  readonly phase: string
  /** 失败原因（status='error' 时）。 */
  readonly error?: string
}

/**
 * corum/ollama/download-progress：本地 LLM 引擎（ollama 二进制）下载进度推送
 * （P2-7；host localLlm 的 downloadProgress 每次写入即 emit——取代设置页
 * 500ms 轮询 `localLlm/getDownloadProgress`）。模型拉取本身走 Ollama HTTP
 * 流式接口（client 直读 ReadableStream），不经本事件。
 */
export interface OllamaDownloadProgressEvent {
  readonly percent: number
  readonly downloadedBytes: number
  readonly totalBytes: number
  /** 下载状态（'idle' | 'downloading' | 'done' | 'error'）。 */
  readonly status: string
  /** 失败原因（status='error' 时）。 */
  readonly error?: string
  /** 瞬时下载速度（字节/秒；滑动窗口，仅 downloading 时有）。2026-09-09 新增。 */
  readonly bytesPerSecond?: number
  /** 预计剩余秒数（有总大小且速度 > 0 时）。2026-09-09 新增。 */
  readonly etaSeconds?: number
}

// ── fork（corum）：模型不可用提问的独立通路 ──────────────────────────────────

/** corum/model-ask/request 的提问载荷（host → client）。 */
export interface CorumModelAskRequestEvent {
  /**
   * 发起询问的父 Agent（waterfall 的 scope 载体；`TypertAgentScopedRequest`
   * 硬要求载荷带 `agent`，否则该事件不进可转发联合）。
   */
  readonly agent: Agent
  /** 哪个子 Agent（label，给人话上下文）。 */
  readonly label: string
  /** 用户为该角色配置的模型路由（不可用的那个）。 */
  readonly configured: { provider: string; model: string }
  /** 机制将采用的回退路由（主 Agent 的真实路由）。 */
  readonly fallback: { provider: string; model: string }
  /** 失败原因原文。 */
  readonly cause: string
  /** 该角色（决定永久档写 subagentModel 还是 researchModel）。 */
  readonly role: 'worker' | 'research'
  /**
   * 档位清单（host 是机制词汇表的唯一事实源，client 只渲染）。
   *
   * 为什么随载荷下发而不是 client 硬编码：client 多画一个没有对应处置的档位，用户点了
   * 会静默落进 dismissed；少画一个则某档位不可达。两边必须同源。
   */
  readonly options: readonly {
    readonly kind: 'temporary' | 'permanent-follow' | 'permanent-route' | 'decline'
    readonly label: string
    readonly description: string
  }[]
  /** 可用的模型路由清单（供「永久改指定模型」内嵌选择；列举失败时为空数组）。 */
  readonly catalog: readonly {
    provider: string
    label: string
    models: readonly { model: string; label: string }[]
  }[]
}

/** corum/model-ask/request 的用户决定（client → host）。 */
export interface CorumModelAskOutcomeEvent {
  /** 用户选中的档位。 */
  readonly kind: 'temporary' | 'permanent-follow' | 'permanent-route' | 'decline' | 'dismissed'
  /** 临时/永久路由（kind=temporary 或 permanent-route 时携带）。 */
  readonly route?: { provider: string; model: string; reasoningEffort?: string }
}

/**
 * fork（corum）2026-09-26：corum/escalation/ask 的提问载荷（host → client）。
 *
 * 子 Agent 撞到沙箱墙、想用更宽的档位重试时，机制**以父 Agent 为载体**问用户。
 *
 * 为什么**不**复用官方 `approval/request`：官方 outcome 词汇表封闭，且归一化发生在
 * `ApprovalService.request()` **内部**（`user-approval/src/index.ts:288`）⇒ 三档里的
 * 「总是允许」传不过去（会被归一成 `unavailable`）。corum 自有 waterfall 的返回值
 * **不**经过那层归一化，所以只有它能携带自己的答案词汇表。先例：`corum/model-ask/request`。
 */
export interface CorumEscalationAskRequestEvent {
  /**
   * 发起询问的父 Agent（waterfall 的 scope 载体；`TypertAgentScopedRequest`
   * **硬要求载荷带 `agent`**，否则该事件不进可转发联合 —— 与 `corum/model-ask/request` 同款）。
   */
  readonly agent: Agent
  /**
   * **父会话** id（卡片该渲染到哪个会话）。
   *
   * 为什么随载荷下发而不是只让 client 自己用 `ctx.sessions.scopeOf(owner)` 推：
   * 实机（2026-09-26）出现「corum waterfall 被派发、但客户端未认领 ⇒ 静默走兜底」，
   * 而 `scopeOf` 解析失败是两种嫌疑之一。随载荷带上会话身份可以**绕开**这条依赖
   * （官方 `approval/request` 那条之所以好，是因为它由官方服务派发、载体形状是被验证过的）。
   */
  readonly sessionId?: string
  /** 子 Agent 请求的目标档位（官方封闭的提权目标词汇）。 */
  readonly mode: 'workspace-write' | 'danger-full-access'
  /** 模型给的一句话理由（可缺省；仅用于呈现）。 */
  readonly justification?: string
}

/**
 * fork（corum）2026-09-26：corum/escalation/ask 的用户决定（client → host）。
 *
 * 三档语义（用户 2026-09-26 裁定）：
 * - `allowed-once`：只批这一次；
 * - `always-allow`：**本会话内后续同类请求免问**（机制按父会话记一条授权，本次同样放行）；
 * - `rejected`：拒绝（对这条命令是终局）。
 *
 * ⚠️ 第 3 档「自动」（记录允许情况 + 后台 AI 生成批准策略 + 落盘跨会话）按用户裁定**预留**，
 * 故此处刻意**没有**对应取值 —— UI 上以禁用按钮占位。
 */
export type CorumEscalationAskOutcomeEvent =
  | { readonly kind: 'allowed-once' }
  | { readonly kind: 'always-allow' }
  | { readonly kind: 'rejected' }

// ── fork（corum）2026-10-08：turn-stopping 阻塞式提交卡片的独立通路 ──────────────

/**
 * `corum/commit-card/request` 的 host → client 载荷（提交卡片初始状态）。
 *
 * 与 `corum/model-ask/request` 同款走 corum 自有 waterfall，但卡片**无按钮**——
 * 回传立即解析为 `{ kind: 'shown' }`，阻塞由机制保证（agent/turn-stopping 的
 * serial dispatch + steer LLM 自己处理），不依赖用户操作。
 */
export interface CorumCommitCardRequestEvent {
  /** 发起卡片的 Agent（waterfall 的 scope 载体；TypertAgentScopedRequest 硬要求带 agent）。 */
  readonly agent: Agent
  /** 会话 id（卡片归属会话）。 */
  readonly sessionId: string
  /** turn 编号。 */
  readonly turn: number
  /** 初始状态。 */
  readonly status: 'pending' | 'progress' | 'done' | 'stashed'
  /** 非产物改动文件数。 */
  readonly effectiveFiles: number
  /** 总改动文件数（含产物）。 */
  readonly totalFiles: number
  /** diff --stat 摘要行（非产物，最多 3 行）。 */
  readonly diffLines: readonly string[]
  /** 还有多少产物文件被排除。 */
  readonly excludedArtifacts: number
}

/** `corum/commit-card/update` 的 host → client 状态更新（emit 通道）。 */
export interface CorumCommitCardUpdateEvent {
  /** 会话 id。 */
  readonly sessionId: string
  /** turn 编号。 */
  readonly turn: number
  /** 新状态。 */
  readonly status: 'pending' | 'progress' | 'done' | 'stashed'
  /** 已完成的提交列表（仅 done 态有值）。 */
  readonly commits?: readonly { readonly type: string; readonly scope?: string; readonly message: string }[]
  /** 进度描述（进行中态用）。 */
  readonly progressText?: string
}

/** client → host 的回传（立即解析——卡片无按钮，阻塞由机制保证）。 */
export interface CorumCommitCardOutcomeEvent {
  readonly kind: 'shown'
}

// ── cordis Events 声明（host emit 与 renderer $on 共享的事实签名）────────────

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** corum/task/assigned：任务入队到「项目 × 角色」队列。 */
    'corum/task/assigned'(data: TaskAssignedEvent): void
    /** corum/task/started：任务派进泳道会话（followup 已发出）。 */
    'corum/task/started'(data: TaskStartedEvent): void
    /** corum/task/completed：任务闭环（complete_task 上报）。 */
    'corum/task/completed'(data: TaskCompletedEvent): void
    /** corum/task/deferred：派发失败，任务放回队首重试。 */
    'corum/task/deferred'(data: TaskDeferredEvent): void
    /** corum/task/evicted：任务未执行即被逐出队列。 */
    'corum/task/evicted'(data: TaskEvictedEvent): void
    /** corum/task/blocked：任务遇阻塞挂起（单阻塞链）。 */
    'corum/task/blocked'(data: TaskBlockedEvent): void
    /** corum/task/unblocked：依赖解除，挂起任务回队列。 */
    'corum/task/unblocked'(data: TaskUnblockedEvent): void
    /** corum/task/stalled：执行中任务超时无活动（卡住感知）。 */
    'corum/task/stalled'(data: TaskStalledEvent): void
    /** corum/task/steered：对执行中任务插入引导。 */
    'corum/task/steered'(data: TaskSteeredEvent): void
    /** corum/task/cancelled：中止任务（fate=requeue/evicted/reassigned）。 */
    'corum/task/cancelled'(data: TaskCancelledEvent): void
    /** corum/group/member-added：项目组成员加入。 */
    'corum/group/member-added'(data: GroupMemberAddedEvent): void
    /** corum/group/member-removed：项目组成员移除（调度器回收其运行时）。 */
    'corum/group/member-removed'(data: GroupMemberRemovedEvent): void
    /** corum/terminal/output：终端 pty 输出推送（统一事件中心一期；终端轮询迁移的承载事件）。 */
    'corum/terminal/output'(data: TerminalOutputEvent): void
    /** corum/file/changed：项目根递归 watch 去抖批量变更推送（统一事件中心二期；文件 watch 轮询迁移的承载事件）。 */
    'corum/file/changed'(data: FileChangedEvent): void
    /** corum/subagent/progress：子 Agent 会话进度增量推送（统一事件中心三期；SubagentCard 进度轮询迁移的承载事件）。 */
    'corum/subagent/progress'(data: SubagentProgressEvent): void
    /** corum/subagent/child：宿主 spawn 子 Agent 的精确父子映射（卡片运行中即可跳子会话）。 */
    'corum/subagent/child'(data: SubagentChildEvent): void
    /** corum/subagent/interrupted：宿主在**发现点**判定某子会话半途失去运行的一次性广播（通知栏承载）。 */
    'corum/subagent/interrupted'(data: SubagentInterruptedEvent): void
    /** corum/worktree-ledger：子 Agent 隔离台账快照（fork #10 发射；「并行工作区」chip 订阅源）。 */
    'corum/worktree-ledger'(data: CorumWorktreeLedgerFrameEvent): void
    /** corum/artgen/download-progress：文生图引擎/模型下载进度（P2-7）。 */
    'corum/artgen/download-progress'(data: ArtgenDownloadProgressEvent): void
    /** corum/ollama/download-progress：本地 LLM 引擎下载进度（P2-7）。 */
    'corum/ollama/download-progress'(data: OllamaDownloadProgressEvent): void
    /** corum/artgen/job-progress：文生图任务进度（P2-7）。 */
    'corum/artgen/job-progress'(data: ArtgenJobProgressEvent): void
    /**
     * corum/model-ask/request：子 Agent 模型不可用 ⇒ 机制问用户（独立通路，不经 userQuestions）。
     * @param data - 失败事实 + 可用模型清单。
     * @mode waterfall
     */
    'corum/model-ask/request'(
      this: Scoped<Agent>,
      data: CorumModelAskRequestEvent,
      next: () => Promise<CorumModelAskOutcomeEvent>,
    ): Promise<CorumModelAskOutcomeEvent>
    /**
     * corum/escalation/ask：子 Agent 请求更宽沙箱档位 ⇒ 机制以父 Agent 为载体问用户
     * （三档：允许一次 / 总是允许 / 拒绝；第 3 档「自动」按用户裁定预留）。
     *
     * `this` 是**载体 scope**（父 Agent）⇒ 客户端 `scopeOf(owner)` 解析出**父会话**，
     * 卡就渲染在用户正在看的那个会话里。
     * @param data - 请求的档位 + 模型给的理由。
     * @mode waterfall
     */
    'corum/escalation/ask'(
      this: Scoped<Agent>,
      data: CorumEscalationAskRequestEvent,
      next: () => Promise<CorumEscalationAskOutcomeEvent>,
    ): Promise<CorumEscalationAskOutcomeEvent>
    /**
     * corum/commit-card/request：turn-stopping 阻塞式提交卡片（fork corum 2026-10-08）。
     *
     * turn 将关时出卡片展示 diff 摘要，LLM 自己分笔提交。卡片无按钮——回传立即解析
     * 为 `{ kind: 'shown' }`，阻塞由机制保证（serial dispatch + steer），不依赖用户操作。
     * @param data - 提交卡片初始状态（diff 摘要 + 文件数）。
     * @mode waterfall
     */
    'corum/commit-card/request'(
      this: Scoped<Agent>,
      data: CorumCommitCardRequestEvent,
      next: () => Promise<CorumCommitCardOutcomeEvent>,
    ): Promise<CorumCommitCardOutcomeEvent>
    /**
     * corum/commit-card/update：提交卡片状态更新（pending → progress → done/stashed）。
     * @param data - 状态更新载荷。
     * @mode emit
     */
    'corum/commit-card/update'(data: CorumCommitCardUpdateEvent): void
  }
}

/** corum/worktree-ledger 帧（与 fork #10 CorumWorktreeLedgerFrame 同构，自包含声明）。 */
export interface CorumWorktreeLedgerFrameEvent {
  readonly sessionId: string
  readonly entries: readonly {
    readonly slug: string
    readonly branch: string
    readonly path: string
    readonly status: 'active' | 'settled' | 'integrated' | 'discarded'
    readonly runId?: string
    readonly childSessionId?: string
  }[]
  readonly pending: number
}

// ── Remote 转发选择面（renderer $on 的 key 面）──────────────────────────────

/** 并入转发 allowlist 的 corum 事件名（12 个领域事件 + 终端输出 + 文件变更 + 子 Agent 进度 + 台账 + 两个下载进度）。 */
export type CorumForwardedEvent =
  | 'corum/task/assigned'
  | 'corum/task/started'
  | 'corum/task/completed'
  | 'corum/task/deferred'
  | 'corum/task/evicted'
  | 'corum/task/blocked'
  | 'corum/task/unblocked'
  | 'corum/task/stalled'
  | 'corum/task/steered'
  | 'corum/task/cancelled'
  | 'corum/group/member-added'
  | 'corum/group/member-removed'
  | 'corum/terminal/output'
  | 'corum/file/changed'
  | 'corum/subagent/progress'
  | 'corum/subagent/child'
  | 'corum/subagent/interrupted'
  | 'corum/worktree-ledger'
  | 'corum/artgen/download-progress'
  | 'corum/ollama/download-progress'
  | 'corum/artgen/job-progress'
  | 'corum/model-ask/request'
  | 'corum/escalation/ask'
  | 'corum/commit-card/request'
  | 'corum/commit-card/update'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<CorumForwardedEvent, true> {}
}
