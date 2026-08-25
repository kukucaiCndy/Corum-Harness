/**
 * DomainEventsPanel —— 项目级调度领域事件的可视化面板。
 *
 * 数据源：corumRuntime/getDomainEvents RPC（事实源 =
 * $CORUM_HOME/projects/<id>/scheduler-events.jsonl 持久日志，重启不丢）。
 * 2s 增量轮询（fromSeq 游标），事件去重追加；支持类型过滤（task/group）。
 *
 * 验证路径：入队任务 / 增删项目组成员 → 这里实时出现
 * task.assigned/started/completed 与 group.member-added/removed 事件，
 * 重启应用后事件仍在（持久化验证）。
 * @module @corum/corum-agent-ui-dev/client/DomainEventsPanel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RefreshCw, ScrollText, Trash2 } from 'lucide-react'
import css from './DomainEventsPanel.module.css'

// ── RPC 类型（镜像 @corum/corum-agent-dev/event-log.ts + events.ts） ──

interface TaskRef {
  id: string
  projectId: string
  profileId: string
  entityType?: string
  entityId?: string
  label?: string
  type: string
  requirementId?: string
  summary: string
  transferNote?: string
  source?: { submitter: string; via: string; at: number }
  priority?: number
}

interface SchedulerEvent {
  seq: number
  id: string
  type: string
  projectId: string
  causedBy: readonly string[]
  payload: Record<string, unknown>
  at: number
  version: 1
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

// ── 事件类型展示 ────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  'corum/task/assigned': '任务指派',
  'corum/task/started': '任务开始',
  'corum/task/completed': '任务完成',
  'corum/task/deferred': '任务重试',
  'corum/task/evicted': '任务逐出',
  'corum/task/blocked': '任务挂起',
  'corum/task/unblocked': '任务唤醒',
  'corum/task/stalled': '疑似卡住',
  'corum/task/steered': '插入引导',
  'corum/task/cancelled': '任务中止',
  'corum/group/member-added': '成员加入',
  'corum/group/member-removed': '成员移除',
}

const TYPE_KIND: Record<string, 'task' | 'group'> = {
  'corum/task/assigned': 'task',
  'corum/task/started': 'task',
  'corum/task/completed': 'task',
  'corum/task/deferred': 'task',
  'corum/task/evicted': 'task',
  'corum/task/blocked': 'task',
  'corum/task/unblocked': 'task',
  'corum/task/stalled': 'task',
  'corum/task/steered': 'task',
  'corum/task/cancelled': 'task',
  'corum/group/member-added': 'group',
  'corum/group/member-removed': 'group',
}

type Filter = 'all' | 'task' | 'group'

function timeOf(at: number): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** 事件载荷的一行摘要。 */
function payloadSummary(ev: SchedulerEvent): string {
  const p = ev.payload
  const task = p.task as TaskRef | undefined
  if (task !== undefined) {
    const parts = [`${task.profileId}/${task.label ?? task.type}「${task.summary}」`]
    if (task.source !== undefined) parts.push(`via ${task.source.via}`)
    if (typeof p.actor === 'string') parts.push(`by ${p.actor}`)
    if (typeof p.result === 'string') parts.push(`→ ${p.result}`)
    if (typeof p.reason === 'string') parts.push(`原因：${p.reason}`)
    if (typeof p.blockedByTaskId === 'string') parts.push(`阻塞源 ${p.blockedByTaskId.slice(0, 14)}…`)
    if (typeof p.unblockedByTaskId === 'string') parts.push(`因 ${p.unblockedByTaskId.slice(0, 14)}… 完成而唤醒`)
    if (typeof p.idleSec === 'number') parts.push(`${p.idleSec} 秒无活动`)
    if (typeof p.note === 'string') parts.push(`引导：${p.note}`)
    if (typeof p.fate === 'string') parts.push(`处置：${p.fate}`)
    if (typeof p.by === 'string' && p.by !== '') parts.push(`by ${p.by}`)
    if (typeof p.sessionId === 'string' && p.sessionId !== '') {
      const fromSeq = typeof p.fromSeq === 'number' ? ` [${p.fromSeq}→]` : ''
      parts.push(`会话 ${p.sessionId}${fromSeq}`)
    }
    const ref = p.resultRef as { sessionId?: string; fromSeq?: number; toSeq?: number } | undefined
    if (ref !== undefined && typeof ref.sessionId === 'string' && ref.sessionId !== '') {
      parts.push(`成果 ${ref.sessionId} [${ref.fromSeq ?? 0}→${ref.toSeq ?? '?'}]`)
    }
    return parts.join(' · ')
  }
  if (ev.type === 'corum/group/member-added') {
    const member = p.member as { profileId: string; role: string; fromTeam?: string } | undefined
    if (member !== undefined) {
      return `${member.profileId}（${member.role}）${member.fromTeam !== undefined ? ` 来自团队 ${member.fromTeam}` : ''}`
    }
  }
  if (ev.type === 'corum/group/member-removed') {
    return `${String(p.profileId ?? '')}`
  }
  return JSON.stringify(p)
}

/** DomainEventsPanel —— 项目调度领域事件流（持久日志回放）。 */
export function DomainEventsPanel({ project }: { project: { id: string; name: string } | null }): ReactNode {
  const [events, setEvents] = useState<readonly SchedulerEvent[]>([])
  const [fromSeq, setFromSeq] = useState(0)
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  const projectId = project?.id ?? ''

  // 增量拉取（fromSeq 游标；去重追加）
  const load = useCallback(async (seq: number) => {
    if (projectId === '') return
    try {
      const { events: batch, lastSeq } = await callRemote<{ events: SchedulerEvent[]; lastSeq: number }>(
        'getDomainEvents', { projectId, fromSeq: seq },
      )
      if (batch.length > 0) {
        setEvents(prev => {
          const known = new Set(prev.map(e => e.seq))
          return [...prev, ...batch.filter(e => !known.has(e.seq))]
        })
      }
      setFromSeq(lastSeq)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [projectId])

  // 2s 轮询
  useEffect(() => {
    void load(0)
    const timer = setInterval(() => { void load(fromSeq) }, 2000)
    return () => { clearInterval(timer) }
  }, [load, fromSeq])

  // 切换项目时重置
  useEffect(() => {
    setEvents([])
    setFromSeq(0)
  }, [projectId])

  // 新事件自动滚到底（用户上翻则不打扰）
  useEffect(() => {
    const el = listRef.current
    if (el !== null && stickBottom.current) el.scrollTop = el.scrollHeight
  }, [events])

  const onScroll = useCallback(() => {
    const el = listRef.current
    if (el === null) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  const visible = events.filter(e => filter === 'all' || TYPE_KIND[e.type] === filter)

  return (
    <div className={css.root}>
      <div className={css.head}>
        <span className={css.title}>
          <ScrollText size={14} /> 领域事件
          {project !== null && <span className={css.projectTag}>{project.name} · {project.id}</span>}
        </span>
        <div className={css.controls}>
          {(['all', 'task', 'group'] as const).map(f => (
            <button
              key={f}
              type="button"
              className={css.filterBtn}
              data-active={filter === f || undefined}
              onClick={() => { setFilter(f) }}
            >
              {f === 'all' ? '全部' : f === 'task' ? '任务' : '成员'}
            </button>
          ))}
          <button type="button" className={css.iconBtn} title="刷新" onClick={() => { void load(0); setEvents([]) }}>
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className={css.iconBtn}
            title="清空视图（只清屏，日志文件不受影响）"
            onClick={() => { setEvents([]) }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {project === null && (
        <div className={css.empty}>请先在顶部项目条选择一个项目。项目的事件日志（scheduler-events.jsonl）会实时显示在这里。</div>
      )}
      {project !== null && visible.length === 0 && (
        <div className={css.empty}>
          暂无{filter === 'task' ? '任务' : filter === 'group' ? '成员' : ''}事件。
          入队任务或增删项目组成员后，这里会实时出现对应事件；重启应用事件仍在。
        </div>
      )}
      {error !== null && <div className={css.error}>{error}</div>}
      <div className={css.list} ref={listRef} onScroll={onScroll}>
        {visible.map(ev => (
          <div key={ev.seq} className={css.row} data-kind={TYPE_KIND[ev.type] ?? 'task'}>
            <span className={css.seq}>#{ev.seq}</span>
            <span className={css.time}>{timeOf(ev.at)}</span>
            <span className={css.type} data-type={ev.type}>{TYPE_LABEL[ev.type] ?? ev.type}</span>
            <span className={css.summary}>{payloadSummary(ev)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default DomainEventsPanel
