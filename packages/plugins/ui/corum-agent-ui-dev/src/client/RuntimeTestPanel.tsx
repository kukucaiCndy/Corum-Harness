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
import css from './RuntimeTestPanel.module.css'

// ── RPC 类型（镜像 @corum/corum-agent-dev/runtime.ts） ─────────────

type TaskStatus = 'pending' | 'running' | 'done'

interface Task {
  id: string
  projectId: string
  profileId: string
  type: string
  summary: string
  transferNote?: string
  status: TaskStatus
}

interface ProfileTasks {
  projectId: string
  profileId: string
  current: Task | null
  queue: Task[]
}

interface RuntimeEventDto {
  seq: number
  type: string
  data: unknown
  time: number
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

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

async function callRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `corumRuntime/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/corumRuntime/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`corumRuntime/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { type: string; rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error('rpcId mismatch')
  if (!envelope.result.ok) throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`)
  return envelope.result.value
}

/** 调 corumAgent 服务的 RPC（与 corumRuntime 服务不同）。 */
async function callCorumAgent<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `corumAgent/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/corumAgent/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`corumAgent/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { type: string; rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error('rpcId mismatch')
  if (!envelope.result.ok) throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`)
  return envelope.result.value
}

// ── 状态徽标 ────────────────────────────────────────────────────────

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待处理',
  running: '执行中',
  done: '已完成',
}

/** RuntimeTestPanel —— 任务运行时验证面板。 */
export function RuntimeTestPanel({ project, workTypes }: { project: ProjectProp | null; workTypes: readonly WorkTypeProp[] }): ReactNode {
  const [profiles, setProfiles] = useState<readonly string[]>([])
  const [taskList, setTaskList] = useState<readonly ProfileTasks[]>([])
  const [profileId, setProfileId] = useState('')
  const [workType, setWorkType] = useState('general')
  const [summary, setSummary] = useState('')
  const [transferNote, setTransferNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 当前选中 profile 的事件流（实时观察 Agent 思考/工具/输出）
  const [events, setEvents] = useState<readonly RuntimeEventDto[]>([])
  const [eventSeq, setEventSeq] = useState(0)

  const projectId = project?.id ?? ''

  // 加载 profile 列表（复用 corumAgent.listProfiles）
  const loadProfiles = useCallback(async () => {
    try {
      const { profiles: p } = await callCorumAgent<{ profiles: Array<{ id: string }> }>('listProfiles', {})
      setProfiles(p.map(x => x.id))
      if (p.length > 0 && profileId === '') setProfileId(p[0].id)
    } catch {
      // corumAgent 服务不可用时静默
    }
  }, [profileId])

  const loadTasks = useCallback(async () => {
    try {
      const { profiles: p } = await callRemote<{ profiles: ProfileTasks[] }>('listTasks', {})
      setTaskList(p)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // 拉取选中「项目 × 角色」的事件流（增量）
  const loadEvents = useCallback(async (seq: number) => {
    if (projectId === '' || profileId === '') return
    try {
      const { events: evts, lastSeq } = await callRemote<{ events: RuntimeEventDto[]; lastSeq: number }>('getTaskEvents', { projectId, profileId, fromSeq: seq })
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
  }, [projectId, profileId])

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
      await callRemote('enqueue', {
        projectId,
        profileId,
        type: workType,
        summary: summary.trim(),
        ...(transferNote.trim() === '' ? {} : { transferNote: transferNote.trim() }),
      })
      setSummary('')
      setTransferNote('')
      await loadTasks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [projectId, profileId, workType, summary, transferNote, loadTasks])

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
                  {profiles.length === 0 && <option value="">暂无 Profile，请先在 Profile 配置 tab 创建</option>}
                  {profiles.map(id => <option key={id} value={id}>{id}</option>)}
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
              {rt.current !== null && (
                <TaskRow task={rt.current} current />
              )}
              {rt.queue.length === 0 && rt.current === null && (
                <div className={css.idle}>空闲（循环阻塞等待任务）</div>
              )}
              {rt.queue.map(t => <TaskRow key={t.id} task={t} />)}
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
          {events.map(ev => <EventRow key={ev.seq} ev={ev} />)}
        </div>
      </section>
    </div>
  )
}

function TaskRow({ task, current = false }: { task: Task; current?: boolean }): ReactNode {
  return (
    <div className={css.taskRow} data-status={task.status} data-current={current || undefined}>
      <span className={css.taskStatus}>{STATUS_LABEL[task.status]}</span>
      <div className={css.taskBody}>
        <span className={css.taskSummary}>{task.summary}</span>
        <span className={css.taskType}>{task.type}</span>
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
            return <MarkdownText key={i} text={b.text ?? ''} />
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
    if (text !== '') return <MarkdownText text={text} />
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
