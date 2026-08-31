/**
 * RuntimeTestPanel —— AgentRuntime「任务 List + 可阻塞循环」的验证面板。
 *
 * 通过桌面 IPC 桥调 /api/corumRuntime/* RPC 端点：
 *   - listTasks：列出所有 profile 的任务队列 + 当前任务
 *   - enqueue：往指定 profile 入队一个任务，唤醒其可阻塞循环
 *
 * 验证路径：选 profile → 输入任务摘要 → 入队 → 观察该 profile 的
 * 「当前任务」从 pending 变 running → Agent 调用 complete_task → 出队。
 * 面板内置 2s 轮询 listTasks，实时反映队列/当前任务状态。
 * @module @corum/corum-agent-ui-dev/client/RuntimeTestPanel
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, ListChecks, Plus, RefreshCw } from 'lucide-react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
// C3b：dev-agent 跨域 RPC 契约——方法名常量 + args/result 类型（type-only）。
import {
  CORUM_PROJECT_METHODS,
  type ListGroupMembersArgs, type ListGroupMembersResult,
} from '@corum/corum-agent-dev/contract'
import css from './RuntimeTestPanel.module.css'

/** MarkdownText chrome 文案（0.1.2 起 labels 必填；中文常量）。 */
const MARKDOWN_LABELS = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
} as const

// ── RPC 类型（镜像 @corum/corum-agent-dev/runtime.ts） ─────────────

type TaskStatus = 'pending' | 'running' | 'done'

interface Task {
  id: string
  projectId: string
  profileId: string
  entityType?: 'task' | 'bug' | 'requirement' | 'discussion' | 'review'
  entityId?: string
  label?: string
  type: string
  requirementId?: string
  summary: string
  transferNote?: string
  source?: { submitter: string; via: string; at: number }
  priority?: number
  status: TaskStatus
}

interface ProfileTasks {
  projectId: string
  profileId: string
  current: Task | null
  queue: Task[]
  suspended?: Task[]
  currentStartedAt?: number | null
  lastActivityAt?: number | null
  stalled?: boolean
}

interface RuntimeEventDto {
  seq: number
  type: string
  data: unknown
  time: number
}

/** 泳道状态（镜像 corumRuntime/listLanes）。 */
interface LaneDto {
  key?: string
  type: string
  requirementId?: string | null
  sessionId: string | null
  status: 'idle' | 'busy'
  currentTaskId: string | null
  lastUsedAt: number
}

interface LanePoolDto {
  projectId: string
  profileId: string
  lanes: LaneDto[]
}

/** 项目（从 AgentTestPanel 项目条传入）。 */
interface ProjectProp {
  id: string
  name: string
}

/** 工作类型（当前项目的类型表）。 */
interface WorkTypeProp {
  slug: string
  label: string
  description?: string
  builtin: boolean
}

/** 项目组成员（运行时边界；任务只能入队给项目组成员）。 */
interface GroupMemberProp {
  profileId: string
  role: 'pm' | 'member'
  fromTeam?: string
}

// contract 的 ProjectGroupMember 与 GroupMemberProp 同形（结构兼容）。

/** 面板对外依赖：corumRuntime / corumProject 两个命名空间的 RPC caller（0.1.2 起走官方 connection.rpc）。 */
export interface RuntimeTestPanelProps {
  readonly project: ProjectProp | null
  readonly workTypes: readonly WorkTypeProp[]
  readonly callRemote: <T>(service: string, method: string, args: Record<string, unknown>) => Promise<T>
}

// ── 状态徽标 ────────────────────────────────────────────────────────

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待处理',
  running: '执行中',
  done: '已完成',
}

/** RuntimeTestPanel —— 任务运行时验证面板。 */
export function RuntimeTestPanel({ project, workTypes, callRemote }: RuntimeTestPanelProps): ReactNode {
  // 任务入队的可选角色 = 当前项目组成员（项目边界，非成员不参与调度）
  const [groupMembers, setGroupMembers] = useState<readonly GroupMemberProp[]>([])
  const [taskList, setTaskList] = useState<readonly ProfileTasks[]>([])
  const [lanePools, setLanePools] = useState<readonly LanePoolDto[]>([])
  const [profileId, setProfileId] = useState('')
  const [workType, setWorkType] = useState('general')
  const [summary, setSummary] = useState('')
  const [transferNote, setTransferNote] = useState('')
  const [requirementId, setRequirementId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 当前选中 profile 的事件流（实时观察 Agent 思考/工具/输出）
  const [events, setEvents] = useState<readonly RuntimeEventDto[]>([])
  const [eventSeq, setEventSeq] = useState(0)

  const projectId = project?.id ?? ''

  // 加载当前项目组成员（任务入队的可选角色）
  const loadProfiles = useCallback(async () => {
    if (projectId === '') { setGroupMembers([]); return }
    try {
      const args: ListGroupMembersArgs = { id: projectId }
      const { members } = await callRemote<ListGroupMembersResult>('corumProject', CORUM_PROJECT_METHODS.listGroupMembers, args)
      setGroupMembers(members)
      if (members.length > 0 && !members.some(m => m.profileId === profileId)) {
        setProfileId(members[0].profileId)
      }
    } catch {
      // corumProject 服务不可用时静默
    }
  }, [projectId, profileId, callRemote])

  const loadTasks = useCallback(async () => {
    try {
      const { profiles: p } = await callRemote<{ profiles: ProfileTasks[] }>('corumRuntime', 'listTasks', {})
      setTaskList(p)
      const { pools } = await callRemote<{ pools: LanePoolDto[] }>('corumRuntime', 'listLanes', {})
      setLanePools(pools)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [callRemote])

  // 拉取选中「项目 × 角色」的事件流（增量）
  const loadEvents = useCallback(async (seq: number) => {
    if (projectId === '' || profileId === '') return
    try {
      const { events: evts, lastSeq } = await callRemote<{ events: RuntimeEventDto[]; lastSeq: number }>('corumRuntime', 'getTaskEvents', { projectId, profileId, fromSeq: seq })
      if (evts.length > 0) {
        setEvents(prev => {
          // 去重：只保留 seq 大于已有的
          const known = new Set(prev.map(e => e.seq))
          const appended = evts.filter(e => !known.has(e.seq))
          return [...prev, ...appended]
        })
        setEventSeq(lastSeq + 1)
      }
    } catch {
      // 静默
    }
  }, [projectId, profileId, callRemote])

  // 2s 轮询刷新任务状态 + 事件流
  useEffect(() => {
    void loadProfiles()
    void loadTasks()
    const timer = setInterval(() => {
      void loadTasks()
      void loadEvents(eventSeq)
    }, 2000)
    return () => { clearInterval(timer) }
  }, [loadProfiles, loadTasks, loadEvents, eventSeq])

  // 切换项目 / profile 时重置事件流
  useEffect(() => {
    setEvents([])
    setEventSeq(0)
  }, [projectId, profileId])

  const onEnqueue = useCallback(async () => {
    if (projectId === '' || profileId === '' || summary.trim() === '') return
    setBusy(true)
    setError(null)
    setEvents([])
    setEventSeq(0)
    try {
      await callRemote('corumRuntime', 'enqueue', {
        projectId,
        profileId,
        type: workType,
        summary: summary.trim(),
        ...(transferNote.trim() === '' ? {} : { transferNote: transferNote.trim() }),
        options: requirementId.trim() === '' ? {} : { requirementId: requirementId.trim() },
      })
      setSummary('')
      setTransferNote('')
      setRequirementId('')
      await loadTasks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [projectId, profileId, workType, summary, transferNote, requirementId, loadTasks, callRemote])

  return (
    <div className={css.root}>
      {/* 左侧栏：入队表单 + 任务队列 */}
      <aside className={css.sidebar}>
        <section className={css.form}>
          <div className={css.formTitle}>
            <Plus size={14} />
            <span>入队任务</span>
          </div>
          {project === null ? (
            <div className={css.empty}>请先在顶部项目条选择一个项目，再入队任务</div>
          ) : (
            <>
              <div className={css.formRow}>
                <label className={css.label}>项目</label>
                <div className={css.projectEcho}>{project.name}<span className={css.projectEchoId}>{project.id}</span></div>
              </div>
              <div className={css.formRow}>
                <label className={css.label}>目标角色（Profile）</label>
                <select
                  className={css.select}
                  value={profileId}
                  onChange={e => { setProfileId(e.target.value) }}
                >
                  {groupMembers.length === 0 && <option value="">项目组暂无成员，请在对话 tab 的「管理」拉人</option>}
                  {groupMembers.map(m => (
                    <option key={m.profileId} value={m.profileId}>
                      {m.profileId}{m.role === 'pm' ? '（PM）' : ''}{m.fromTeam !== undefined ? ` · ${m.fromTeam}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className={css.formRow}>
                <label className={css.label}>工作类型（泳道）</label>
                <select
                  className={css.select}
                  value={workType}
                  onChange={e => { setWorkType(e.target.value) }}
                >
                  {workTypes.map(t => <option key={t.slug} value={t.slug}>{t.label}（{t.slug}）</option>)}
                </select>
              </div>
              <div className={css.formRow}>
                <label className={css.label}>关联需求 ID（可选）</label>
                <input
                  className={css.select}
                  value={requirementId}
                  onChange={e => { setRequirementId(e.target.value) }}
                  placeholder="填后泳道标签 = 需求ID:类型"
                />
              </div>
              <div className={css.formRow}>
                <label className={css.label}>任务摘要</label>
                <textarea
                  className={css.textarea}
                  value={summary}
                  onChange={e => { setSummary(e.target.value) }}
                  rows={2}
                  placeholder="例如：实现用户登录接口并自测"
                />
              </div>
              <div className={css.formRow}>
                <label className={css.label}>增量上下文（可选）</label>
                <textarea
                  className={css.textarea}
                  value={transferNote}
                  onChange={e => { setTransferNote(e.target.value) }}
                  rows={2}
                  placeholder="提交方推理结论 / 说明（可选）"
                />
              </div>
              <button
                type="button"
                className={css.enqueueBtn}
                disabled={busy || profileId === '' || summary.trim() === ''}
                onClick={() => { void onEnqueue() }}
              >
                <Plus size={14} /> 入队并唤醒循环
              </button>
              {error !== null && <div className={css.error}>{error}</div>}
            </>
          )}
        </section>

        <section className={css.list}>
          <div className={css.listHead}>
            <span className={css.listTitle}><ListChecks size={14} /> 任务队列</span>
            <button type="button" className={css.refreshBtn} onClick={() => { void loadTasks() }}>
              <RefreshCw size={13} /> 刷新
            </button>
          </div>
          {taskList.length === 0 && (
            <div className={css.empty}>暂无任务。入队一个任务后，这里会显示各角色的队列与当前任务。</div>
          )}
          {taskList.map(rt => (
            <div key={`${rt.projectId}${rt.profileId}`} className={css.profileBlock}>
              <div className={css.profileHead}>
                <span className={css.profileName}>{rt.profileId}</span>
                <span className={css.profileProject}>{rt.projectId}</span>
                <span className={css.count}>队列 {rt.queue.length} · 当前 {rt.current !== null ? 1 : 0}</span>
              </div>
              <LaneChips lanes={lanePools.find(p => p.projectId === rt.projectId && p.profileId === rt.profileId)?.lanes ?? []} />
              {rt.current !== null && (
                <>
                  <TaskRow task={rt.current} current />
                  <CurrentTaskHealth rt={rt} onAction={void 0} projectId={rt.projectId} onRefresh={() => { void loadTasks() }} callRemote={callRemote} />
                </>
              )}
              {rt.queue.length === 0 && rt.current === null && (
                <div className={css.idle}>空闲（循环阻塞等待任务）</div>
              )}
              {rt.queue.map(t => <TaskRow key={t.id} task={t} />)}
              {(rt.suspended ?? []).map(t => (
                <div key={t.id} className={css.taskRow} data-status="suspended">
                  <span className={css.taskStatus}>挂起</span>
                  <div className={css.taskBody}>
                    <span className={css.taskSummary}>{t.summary}</span>
                    <span className={css.taskType}>{t.type} · 等依赖解除</span>
                    <span className={css.taskId}>{t.id}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </section>
      </aside>

      {/* 右侧：事件流（实时观察 Agent 思考/工具/输出） */}
      <section className={css.events}>
        <div className={css.listHead}>
          <span className={css.listTitle}><Activity size={14} /> Agent 执行事件流（{profileId || '未选择'}{projectId !== '' ? ` · ${projectId}` : ''}）</span>
          <button
            type="button"
            className={css.refreshBtn}
            onClick={() => { setEvents([]); setEventSeq(0) }}
          >
            清空
          </button>
        </div>
        {events.length === 0 && (
          <div className={css.empty}>入队任务后，这里会实时显示 Agent 的思考、工具调用与输出事件。</div>
        )}
        <div className={css.eventList}>
          {groupEventRows(events).map((row, i) => row.kind === 'chunk'
            ? <ChunkStreamRow key={`chunk-${i}`} group={row} />
            : <EventRow key={row.ev.seq} ev={row.ev} />)}
        </div>
      </section>
    </div>
  )
}

/**
 * 事件行视图：单个事件，或一聚合同 turn+step 的连续流式 chunk。
 * chunk 增量聚合成「流式增量」块——同 turn+step 的连续 chunk 合并显示
 * 累积文本（像官方 conversation 那样实时拼接），避免一个 token 一行刷屏。
 */
type EventRowView =
  | { kind: 'event'; ev: RuntimeEventDto }
  | { kind: 'chunk'; turn: number; step: number; text: string; reasoning: string; toolName?: string; toolArgs: string; count: number; finished: boolean }

/** 把连续同 turn+step 的 assistant/chunk 聚合成一条「流式增量」块。 */
function groupEventRows(events: readonly RuntimeEventDto[]): EventRowView[] {
  const rows: EventRowView[] = []
  let cur: Extract<EventRowView, { kind: 'chunk' }> | null = null
  const flush = (): void => { if (cur !== null) { rows.push(cur); cur = null } }
  for (const ev of events) {
    if (ev.type === 'assistant/chunk') {
      const d = ev.data as {
        turn?: number; step?: number; chunkType?: string
        text?: string; name?: string; argumentsDelta?: string; reason?: string
      }
      const turn = d.turn ?? 0
      const step = d.step ?? 0
      if (cur === null || cur.turn !== turn || cur.step !== step) {
        flush()
        cur = { kind: 'chunk', turn, step, text: '', reasoning: '', toolArgs: '', count: 0, finished: false }
      }
      cur.count += 1
      if (d.chunkType === 'text-delta') cur.text += d.text ?? ''
      else if (d.chunkType === 'reasoning-delta') cur.reasoning += d.text ?? ''
      else if (d.chunkType === 'tool-call-delta') {
        if (d.name !== undefined) cur.toolName = d.name
        cur.toolArgs += d.argumentsDelta ?? ''
      } else if (d.chunkType === 'finish') cur.finished = true
      continue
    }
    flush()
    rows.push({ kind: 'event', ev })
  }
  flush()
  return rows
}

/** 一聚合同 turn+step 的流式 chunk 增量块（模型边想边写的过程）。 */
function ChunkStreamRow({ group }: { group: Extract<EventRowView, { kind: 'chunk' }> }): ReactNode {
  const [open, setOpen] = useState(true)
  const hasReasoning = group.reasoning.trim() !== ''
  const hasText = group.text.trim() !== ''
  const hasTool = group.toolName !== undefined
  return (
    <div className={css.eventRow} data-type="assistant/chunk">
      <span className={css.eventType}>stream</span>
      <div className={css.eventBody}>
        <div className={css.chunkStream}>
          <button type="button" className={css.chunkStreamHead} onClick={() => { setOpen(o => !o) }}>
            <span className={css.reasoningChevron}>{open ? '▾' : '▸'}</span>
            <span className={css.chunkStreamLabel}>
              流式增量 · turn {group.turn} step {group.step}{group.finished ? '（完成）' : '…'}
            </span>
            <span className={css.chunkStreamCount}>{group.count}</span>
          </button>
          {open && (
            <div className={css.chunkStreamBody}>
              {hasReasoning && (
                <div className={css.chunkReasoning}>
                  <div className={css.chunkPartLabel}>思考</div>
                  <MarkdownText text={group.reasoning} labels={MARKDOWN_LABELS} />
                </div>
              )}
              {hasText && (
                <div className={css.chunkText}>
                  <div className={css.chunkPartLabel}>正文</div>
                  <MarkdownText text={group.text} labels={MARKDOWN_LABELS} />
                </div>
              )}
              {hasTool && (
                <div className={css.chunkTool}>
                  <span className={css.toolCallName}>⚙ {group.toolName}</span>
                  <span className={css.toolCallArgs}>{group.toolArgs}</span>
                </div>
              )}
              {!hasReasoning && !hasText && !hasTool && (
                <div className={css.chunkEmpty}>（增量元数据）</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 执行时长/最后活动的人性化格式。 */
function ageText(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} 秒`
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
}

/** 当前任务健康行：执行时长 + 最后活动 + 卡住高亮 + 干预按钮（steer/cancel/reassign）。 */
function CurrentTaskHealth({ rt, projectId, onRefresh, callRemote }: { rt: ProfileTasks; projectId: string; onAction?: void; onRefresh: () => void; callRemote: RuntimeTestPanelProps['callRemote'] }): ReactNode {
  const [busy, setBusy] = useState(false)
  const now = Date.now()
  const startedAt = rt.currentStartedAt ?? null
  const lastActivity = rt.lastActivityAt ?? null
  const stalled = rt.stalled === true
  if (rt.current === null) return null

  const act = async (method: string, args: Record<string, unknown>) => {
    setBusy(true)
    try {
      await callRemote('corumRuntime', method, args)
      onRefresh()
    } catch {
      // 静默（轮询会反映结果）
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.healthRow} data-stalled={stalled || undefined}>
      <span className={css.healthText}>
        {startedAt !== null && `已执行 ${ageText(now - startedAt)}`}
        {lastActivity !== null && ` · 最后活动 ${ageText(now - lastActivity)}前`}
        {stalled && ' · ⚠ 疑似卡住'}
      </span>
      <span className={css.healthActions}>
        <button
          type="button"
          className={css.healthBtn}
          disabled={busy}
          title="插入引导（不打断，下一步边界生效）"
          onClick={() => {
            const note = window.prompt('给执行者的收敛引导：', '编译通过即可，不必起服务自测，直接 complete_task 收尾。')
            if (note !== null && note.trim() !== '') void act('steerTask', { projectId, profileId: rt.profileId, note: note.trim() })
          }}
        >引导</button>
        <button
          type="button"
          className={css.healthBtn}
          disabled={busy}
          title="中止当前任务并回队重派"
          onClick={() => {
            const reason = window.prompt('中止原因（任务将回队重派）：', '卡住/跑偏，重新来过')
            if (reason !== null) void act('cancelTask', { projectId, profileId: rt.profileId, reason: reason.trim() || '用户中止' })
          }}
        >中止</button>
        <button
          type="button"
          className={css.healthBtn}
          disabled={busy}
          title="中止当前任务并改派其他成员"
          onClick={() => {
            const target = window.prompt('改派给哪个成员（profileId）：')
            if (target !== null && target.trim() !== '') {
              const note = window.prompt('改派说明：', '') ?? ''
              void act('reassignTask', { projectId, profileId: rt.profileId, targetProfileId: target.trim(), note })
            }
          }}
        >改派</button>
      </span>
    </div>
  )
}

/** 泳道池 chips：每个工作类型泳道的状态（busy 高亮 + sessionId 尾部）。 */
function LaneChips({ lanes }: { lanes: readonly LaneDto[] }): ReactNode {
  if (lanes.length === 0) return null
  return (
    <div className={css.laneRow}>
      {lanes.map(l => (
        <span key={l.key ?? l.type} className={css.laneChip} data-status={l.status} title={l.sessionId ?? '会话未建立'}>
          {l.key ?? l.type}
          {l.status === 'busy' ? ' · 占用' : ' · 空闲'}
          {l.sessionId !== null && <span className={css.laneSid}>{l.sessionId.slice(-4)}</span>}
        </span>
      ))}
    </div>
  )
}

function TaskRow({ task, current = false }: { task: Task; current?: boolean }): ReactNode {
  return (
    <div className={css.taskRow} data-status={task.status} data-current={current || undefined}>
      <span className={css.taskStatus}>{STATUS_LABEL[task.status]}</span>
      <div className={css.taskBody}>
        <span className={css.taskSummary}>{task.summary}</span>
        <span className={css.taskType}>{task.label ?? task.type}{task.source !== undefined ? ` · ${task.source.via}` : ''}</span>
        {task.transferNote !== undefined && task.transferNote !== '' && (
          <span className={css.taskNote}>上下文：{task.transferNote}</span>
        )}
        <span className={css.taskId}>{task.id}</span>
      </div>
    </div>
  )
}

/** 单条会话事件渲染。按事件类型分组展示，assistant 用 MarkdownText 渲染。 */
function EventRow({ ev }: { ev: RuntimeEventDto }): ReactNode {
  const data = ev.data as Record<string, unknown> | null
  return (
    <div className={css.eventRow} data-type={ev.type}>
      <span className={css.eventType}>{ev.type}</span>
      <div className={css.eventBody}>
        <EventBody type={ev.type} data={data} />
      </div>
    </div>
  )
}

/** 事件正文：assistant/reasoning 用 MarkdownText，工具用紧凑行。 */
function EventBody({ type, data }: { type: string; data: Record<string, unknown> | null }): ReactNode {
  if (data === null || data === undefined) return null
  // assistant/message：content 数组里 text 用 MarkdownText 渲染，reasoning 折叠
  const content = data.content as Array<{ type?: string; text?: string; reasoning?: string; name?: string }> | undefined
  if (type === 'assistant/message' && Array.isArray(content)) {
    return (
      <>
        {content.map((b, i) => {
          if (b.type === 'reasoning') {
            return <ReasoningBlock key={i} text={b.reasoning ?? ''} />
          }
          if (b.type === 'text' && (b.text ?? '') !== '') {
            return <MarkdownText key={i} text={b.text ?? ''} labels={MARKDOWN_LABELS} />
          }
          if (b.type === 'tool-call') {
            return (
              <div key={i} className={css.toolCallLine}>
                <span className={css.toolCallName}>⚙ {b.name}</span>
              </div>
            )
          }
          return null
        })}
      </>
    )
  }
  // tool/call：显示工具名 + 参数
  if (type === 'tool/call') {
    const name = data.name as string | undefined
    const args = data.arguments as unknown
    return (
      <div className={css.toolCallLine}>
        <span className={css.toolCallName}>⚙ {name ?? ''}</span>
        <span className={css.toolCallArgs}>{JSON.stringify(args)}</span>
      </div>
    )
  }
  // tool/result：显示工具输出文本（用 MarkdownText 渲染）
  if (type === 'tool/result') {
    const resultContent = data.content as Array<{ type?: string; text?: string }> | undefined
    if (data.error !== undefined) {
      return <div className={css.toolResultError}>✗ {String(data.error)}</div>
    }
    const text = (resultContent ?? [])
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('\n')
    if (text !== '') return <MarkdownText text={text} labels={MARKDOWN_LABELS} />
    return <div className={css.toolResultDone}>✓ 完成</div>
  }
  // turn/start, turn/end, step/start, step/end：边界标记，紧凑显示
  if (type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end') {
    return <span className={css.boundary}>{JSON.stringify(data)}</span>
  }
  // 其他：JSON 兜底
  return <span className={css.jsonFallback}>{JSON.stringify(data)}</span>
}

/** reasoning 折叠块：默认折叠，点击展开（模拟官方 ReasoningRow）。 */
function ReasoningBlock({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const firstLine = text.split('\n')[0] ?? ''
  return (
    <div className={css.reasoning}>
      <button type="button" className={css.reasoningToggle} onClick={() => { setOpen(o => !o) }}>
        <span className={css.reasoningChevron}>{open ? '▾' : '▸'}</span>
        <span className={css.reasoningLabel}>Think</span>
        <span className={css.reasoningSummary}>{firstLine}</span>
      </button>
      {open && <div className={css.reasoningBody}>{text}</div>}
    </div>
  )
}
