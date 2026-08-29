/**
 * ConversationArea — the IDE conversation column (design.pen ② Agent 对话区
 * yoxDi, vertical gap6). task 模式走 corum 泳道数据通路：host corum-agent-dev
 * 的 task 泳道（corum-task-* session id，agent.session.events → simplifyEventData
 * 投影）经自家 RPC（createTaskAgent / runPromptForTask / getTaskSessionEvents）
 * 拉 SessionEventDto[]，按事件 type 映射到对应设计卡片：
 *   user/message → user 品牌气泡卡；assistant/message → ai 卡（text=Markdown /
 *   reasoning 折叠 / tool-call 行）；tool/call+tool/result → tool 行；
 *   assistant/chunk → 流式中的 ai 卡增量。
 * 发送：官方 session.prompt（决策 A2，泳道在对象层有 binding），异步驱动；发送后
 * 轮询泳道投影增量（readFrom fromSeq=lastSeq+1，含 assistant/chunk 实时增量，
 * write-behind ≤200ms 窗口）——fold chunk 做流式渲染，turn/end 落地终态卡片。
 * 审批 awaiting 卡：读官方 ctx.uiSession.pendingInteractions（泳道在对象层，
 * ui-approval answerer 会把泳道工具审批 publish 进来），PendingApproval.answer()
 * 应答（allowed-once / rejected）。耗时：turn/start→turn/end 的 time 差。
 * Review Card / task-line / 子 Agent 卡仍为设计默认（后续阶段接）。
 */
import { type ISessions, type SessionSummary, type SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ArrowUp, Bot, ChevronDown, ChevronRight, Copy, GitBranch, Loader,
  Mic, Pencil, Plus, RotateCcw, ShieldAlert, Sparkles,
} from 'lucide-react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingInteractionsFace, SessionPendingInteractionLike } from './index.ts'
import { useSyncExternalStore } from 'react'
import css from './ConversationArea.module.css'

/** Injected actions + the live feed (see client/index.ts apply). */
export interface ConversationInjected {
  list: ISessions['list']
  open: (sessionId: string) => void
  callAgent: <T>(method: string, args: Record<string, unknown>) => Promise<T>
  sessionOf: (sessionId: string) => SessionFace | undefined
  /** 官方 pending interaction 快照（审批卡数据源；见 client/index.ts inject）。 */
  pendingInteractions: PendingInteractionsFace
}

/** Composed props: the official conversation slot share + the model-seat render share + this plugin's inject. */
export type ConversationProps =
  & PropsRuntime<'conversation'>
  & PropsRenderSlots<'conversation.input.model'>
  & ConversationInjected

/** Display title for a session row (durable host label, blank fallback). */
function rowTitle(row: SessionSummary): string {
  return row.displayTitle || (row.blank === true ? '新会话' : '未命名会话')
}

// ── task 泳道事件 DTO（与 host simplifyEventData 对应） ──

interface SessionEventDto {
  seq: number
  type: string
  data: unknown
  time: number
}

type ContentPiece = { type: string; text?: string; name?: string; arguments?: unknown }

/** MarkdownText 的 chrome 文案（0.1.2 起 labels 必填；kkc 自研对话区无 locale 体系，给中文常量）。 */
const MARKDOWN_LABELS = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
} as const

/** 时间戳 → HH:MM。 */
function timeLabel(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 提取 user 消息文本。 */
function userText(data: unknown): string {
  const content = (data as { content?: ContentPiece[] } | undefined)?.content ?? []
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n').trim()
}

/** assistant 消息的 text/reasoning/tool-call 分块。 */
function assistantParts(data: unknown): { texts: string[]; reasonings: string[]; toolCalls: Array<{ label: string }> } {
  const content = (data as { content?: ContentPiece[] } | undefined)?.content ?? []
  const texts: string[] = []
  const reasonings: string[] = []
  const toolCalls: Array<{ label: string }> = []
  for (const c of content) {
    if (c.type === 'text' && (c.text ?? '') !== '') texts.push(c.text ?? '')
    else if (c.type === 'reasoning' && (c.text ?? '') !== '') reasonings.push(c.text ?? '')
    else if (c.type === 'tool-call') toolCalls.push({ label: toolCallLabel({ name: c.name, arguments: c.arguments }) })
  }
  return { texts, reasonings, toolCalls }
}

/** tool/call 的展示标签（工具名 · 主参数）。 */
function toolCallLabel(data: unknown): string {
  const d = data as { name?: string; arguments?: unknown } | undefined
  const name = d?.name ?? 'tool'
  let arg = ''
  if (d?.arguments !== undefined) {
    const a = typeof d.arguments === 'string' ? safeParse(d.arguments) : d.arguments
    if (a !== null && typeof a === 'object') {
      const o = a as Record<string, unknown>
      arg = String(o.path ?? o.file ?? o.command ?? o.cmd ?? o.filePath ?? '')
    }
  }
  return arg === '' ? name : `${name} · ${arg}`
}
function safeParse(s: string): unknown { try { return JSON.parse(s) } catch { return null } }

/** tool/result 是否错误。 */
function toolResultIsError(data: unknown): boolean {
  return (data as { isError?: boolean } | undefined)?.isError === true
}

/**
 * 流式增量跟随：官方 prompt 异步入队后，增量轮询泳道投影（readFrom fromSeq=lastSeq+1，
 * inclusive 语义下不重复）。write-behind ≤200ms 窗口 + checkpoint 自动 flush（pre-step /
 * 工具派发前），chunk 实时可见——fold assistant/chunk 进事件数组即得流式渲染。
 * 终止：见到新 turn/end（本轮回复落地）后补一次终态对齐（readFrom 全量前缀已含
 * assistant/message 终态，chunk 与 message 共存，buildCards 只渲染 message 终态卡）。
 * 兜底：~120s 超时 / 连续无增长 20 次（≈6s，长工具执行保护）退出。
 */
async function streamFollow(
  callAgent: ConversationInjected['callAgent'],
  sessionId: string,
  setEvents: (updater: (prev: readonly SessionEventDto[]) => readonly SessionEventDto[]) => void,
): Promise<void> {
  const deadline = Date.now() + 120_000
  // 基线：发送前最后一条事件 seq（增量起点）。
  let lastSeq = -1
  let turnStartSeq = -1
  try {
    const before = await callAgent<{ events: SessionEventDto[] }>('getTaskSessionEvents', { sessionId, fromSeq: 0 })
    for (const e of before.events) lastSeq = Math.max(lastSeq, e.seq)
    setEvents(() => before.events)
  } catch { /* 基线失败不阻塞 */ }
  let stagnant = 0
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
    let batch: SessionEventDto[] = []
    try {
      const r = await callAgent<{ events: SessionEventDto[] }>('getTaskSessionEvents', { sessionId, fromSeq: lastSeq + 1 })
      batch = r.events
    } catch { continue /* 单次轮询失败重试 */ }
    if (batch.length === 0) {
      stagnant += 1
      if (stagnant >= 30) break
      continue
    }
    stagnant = 0
    let sawTurnEnd = false
    for (const e of batch) {
      lastSeq = Math.max(lastSeq, e.seq)
      if (e.type === 'turn/start') turnStartSeq = e.seq
      if (e.type === 'turn/end' && e.seq > turnStartSeq) sawTurnEnd = true
    }
    const incoming = batch
    setEvents(prev => {
      // 去重拼接（增量区间严格递增，正常无重叠；重叠时按 seq 过滤）。
      const base = incoming.length > 0 ? prev.filter(e => e.seq < incoming[0].seq) : prev
      return [...base, ...incoming]
    })
    if (sawTurnEnd) return
  }
}

/** The IDE conversation column (see module doc). */
export function ConversationArea({ list, callAgent, sessionOf, pendingInteractions, renderSlot, SessionProvider }: ConversationProps) {
  const listSnap = useSyncExternalStore(list.subscribe, list.getSnapshot)
  const currentId = listSnap.current
  // 寻址：官方 list.current 选中的泳道 sessionId（侧栏 open() 驱动联动）。只接 task
  // 泳道（corum-task-*）；非泳道（官方 session-* 测试残留/无会话）显示空态。
  const sessionId = currentId !== undefined && String(currentId).startsWith('corum-task-') ? String(currentId) : null
  const session = sessionId !== null ? sessionOf(sessionId) : undefined

  // ── 审批 awaiting：订阅官方 pending interaction 快照，取当前泳道的一条（kind=approval）。
  const pendingSnap = useSyncExternalStore(pendingInteractions.subscribe, pendingInteractions.getSnapshot)
  const approval = useMemo(() => {
    if (sessionId === null) return null
    const p = pendingSnap.get(sessionId)
    return p !== undefined && p.kind === 'approval' ? p : null
  }, [pendingSnap, sessionId])

  // 应答：PendingApproval.answer（经官方 waterfall 回传 host）。
  const answerApproval = useCallback(async (outcome: 'allowed-once' | 'rejected') => {
    if (approval?.answer === undefined) return
    setAllowMenuOpen(false)
    try {
      await approval.answer(outcome)
    } catch (err) {
      console.error('[conversation] 审批应答失败', err)
    }
  }, [approval])

  const [events, setEvents] = useState<readonly SessionEventDto[]>([])
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(true)
  const [taskOpen, setTaskOpen] = useState(false)
  const [subOpen, setSubOpen] = useState(false)
  const [allowMenuOpen, setAllowMenuOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const flowRef = useRef<HTMLDivElement | null>(null)

  // 拉取选中泳道的事件流（按 sessionId，不再每次新建会话——修重复建会话 bug）。
  // fromSeq=0 全量（冷回填 / 终态对齐）；增量见 streamFollow 的 readFrom(lastSeq+1)。
  const refresh = useCallback(async (sid: string) => {
    try {
      const r = await callAgent<{ events: SessionEventDto[] }>('getTaskSessionEvents', { sessionId: sid, fromSeq: 0 })
      setEvents(r.events)
      setLoadError(null)
      return r.events
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }, [callAgent])

  useEffect(() => {
    if (sessionId !== null) void refresh(sessionId)
    else setEvents([])
  }, [sessionId, refresh])

  // 发送一条用户消息：官方 session.prompt（决策 A2，异步入队），随后流式增量轮询。
  const send = useCallback(async () => {
    const text = draft.trim()
    if (text === '' || sessionId === null || session === undefined || busy) return
    setBusy(true)
    try {
      const result = await session.prompt([{ type: 'text', text }], 'queue')
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setDraft('')
      await streamFollow(callAgent, sessionId, setEvents)
    } catch (err) {
      console.error('[conversation] 发送失败', err)
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
    // streamFollow 在模块作用域（见下），不依赖 busy 闭包。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, sessionId, session, busy, callAgent])

  // 事件流到底部（新事件/流式增量/发送后）。
  useEffect(() => {
    const el = flowRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [events, busy])

  // ── 事件 → 卡片（含流式中的 partial ai 卡） ──
  const cards = useMemo(() => buildCards(events, busy), [events, busy])

  return (
    <div className={css.column}>
      <div className={css.flow} ref={flowRef}>
        <div className={css.gutter} aria-hidden="true">
          <span className={css.gutterDot} />
          <span className={css.gutterDot} />
          <span className={css.gutterDot} />
          <span className={css.gutterDot} />
          <span className={`${css.gutterDot} ${css.gutterDotActive}`} />
        </div>

        <div className={css.messages}>
          {loadError !== null && (
            <div className={css.emptyFlow}>task 泳道连接失败：{loadError}</div>
          )}
          {loadError === null && cards.length === 0 && !busy && (
            <div className={css.emptyFlow}>
              {sessionId === null ? '选择或新建一个 task 会话开始' : '描述一个开发任务，开始第一轮对话'}
            </div>
          )}

          {cards}

          {/* 流式中 busy 占位（无流式内容时的「正在思考」；有 chunk 后由 partial ai 卡接管）。 */}
          {busy && (
            <div className={css.ai} data-busy-placeholder>
              <div className={css.aiHead}>
                <span className={css.aiAvatar} />
                <span className={css.aiWho}>Corum Agent</span>
                <span className={css.aiDur}>…</span>
              </div>
              <div className={css.aiBody}><Loader size={16} strokeWidth={2} className={css.toolRunningIcon} /> 正在思考…</div>
            </div>
          )}

          {/* N1EDZ — 审批 awaiting 卡（真实 pending interaction；泳道在官方对象层，
              ui-approval answerer publish 进 pendingInteractions，answer() 应答）。 */}
          {approval !== null && (
            <div className={css.awaitingCard}>
              <div className={css.aiHead}>
                <span className={css.aiAvatar} />
                <span className={css.aiWho}>Corum Agent</span>
                <span className={css.awaitTag}>● 等待审批</span>
              </div>
              <p className={css.awaitBody}>{approvalBody(approval)}</p>
              <div className={css.awaitActions}>
                <div className={css.allowSplit}>
                  <button type="button" className={css.allowMain} onClick={() => void answerApproval('allowed-once')}>允许一次</button>
                  <span className={css.allowDivider} />
                  <button
                    type="button"
                    className={css.allowChev}
                    aria-expanded={allowMenuOpen}
                    title="允许方式"
                    onClick={() => setAllowMenuOpen(v => !v)}
                  >
                    <ChevronDown size={14} strokeWidth={2} />
                  </button>
                </div>
                <button type="button" className={css.denyBtn} onClick={() => void answerApproval('rejected')}>拒绝</button>
              </div>
              {allowMenuOpen && (
                <div className={css.allowMenu}>
                  <button type="button" className={`${css.allowMenuItem} ${css.allowMenuItemActive}`} onClick={() => void answerApproval('allowed-once')}>
                    允许一次
                  </button>
                  <button type="button" className={css.allowMenuItem} disabled title="会话级始终允许暂未接入（需写回 approval/policy）">
                    始终允许
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* nzgrI — Review Card（设计默认假数据；真实文件变更后续阶段接）。 */}
      <div className={css.review}>
        <button type="button" className={css.reviewChev} aria-expanded={reviewOpen} title={reviewOpen ? '收起变更' : '展开变更'} onClick={() => setReviewOpen((v) => !v)}>
          <ChevronRight size={15} strokeWidth={2} className={reviewOpen ? css.reviewChevOpen : undefined} />
        </button>
        <span className={css.reviewTitle}>3 个文件已更改</span>
        <span className={css.reviewDiff}>+128 −40</span>
        <span className={css.spacer} />
        {reviewOpen && (
          <>
            <button type="button" className={css.reviewReject}>全部撤销</button>
            <button type="button" className={css.reviewAccept}>全部保留</button>
          </>
        )}
      </div>

      {/* sKrdG — task-line（设计默认假数据；真实任务进度后续阶段接）。 */}
      <div className={css.taskLine}>
        {['done', 'done', 'done', 'active', 'todo', 'todo', 'todo'].map((st, i, arr) => (
          <span key={i} className={css.taskSeg}>
            {st === 'active'
              ? <span className={css.taskDotActiveWrap}><span className={css.taskDotHalo} /><span className={css.taskDotActive} /></span>
              : <span className={st === 'done' ? css.taskDotDone : css.taskDotTodo} />}
            {i < arr.length - 1 && <span className={`${css.taskConn} ${st === 'done' ? css.taskConnDone : ''}`} />}
          </span>
        ))}
        <button type="button" className={css.taskExpand} title={taskOpen ? '收起任务进度' : '展开任务进度'} aria-expanded={taskOpen} onClick={() => setTaskOpen(v => !v)}>
          <ChevronDown size={13} strokeWidth={2} className={taskOpen ? css.taskExpandOpen : undefined} />
        </button>
      </div>

      {/* htxWi — Chat Input（接 task 泳道发送）。 */}
      <div className={css.input}>
        <div className={css.inputLine}>
          <textarea
            className={css.inputField}
            placeholder="描述一个开发任务，用 @ 添加上下文，/ 使用命令"
            value={draft}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && draft.trim() !== '') {
                e.preventDefault()
                void send()
              }
            }}
          />
          <Sparkles size={19} strokeWidth={2} className={css.sparkle} />
        </div>
        <div className={css.toolbar}>
          <button type="button" className={css.tbtn} title="添加上下文"><Plus size={19} strokeWidth={2} className={css.tbtnIcon} /></button>
          <button type="button" className={css.tbtn} title="授权设置"><ShieldAlert size={18} strokeWidth={2} className={css.tbtnShield} /></button>
          <button type="button" className={css.tbtnAgent} title="选择 Agent">
            <span className={css.tbtnAgentAt}>@</span>
            <span className={css.tbtnAgentLabel}>Agent</span>
            <ChevronDown size={16} strokeWidth={2} className={css.tbtnChev} />
          </button>
          <span className={css.spacer} />
          {SessionProvider !== undefined
            ? (
              <SessionProvider empty={() => (
                <span className={css.tbtnModel}><span className={css.tbtnModelLabel}>选择模型</span></span>
              )}>
                <span className={css.modelSeat}>
                  {renderSlot('conversation.input.model', { locked: false })}
                </span>
              </SessionProvider>
            )
            : null}
          <button type="button" className={css.tbtn} title="语音输入"><Mic size={18} strokeWidth={2} className={css.tbtnIcon} /></button>
          <button
            type="button"
            className={css.tbtnSend}
            title={busy ? '会话进行中' : '发送'}
            disabled={draft.trim() === '' || busy || sessionId === null}
            onClick={() => void send()}
          >
            <ArrowUp size={19} strokeWidth={2} className={css.tbtnSendIcon} />
          </button>
        </div>
      </div>
    </div>
  )
}

/** 流式增量聚合态（fold assistant/chunk，turn+step 为聚合键）。 */
interface StreamAccum {
  turn: number
  step: number
  texts: string[]
  reasonings: string[]
  /** 当前块（block-start..block-end 之间）的类型与下标。 */
  curType: '' | 'text' | 'reasoning'
  curIndex: number
  sawFinish: boolean
}

/** 毫秒 → 「N.Ns」耗时标签。 */
function durLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 审批卡 body 文案（对齐设计稿 mono 命令语义）：reason 优先（escalation 形如
 * 「escalate sandbox to workspace-write: <justification>」），否则 toolName。
 */
function approvalBody(p: SessionPendingInteractionLike): string {
  const tool = p.toolName ?? 'tool'
  if (p.reason !== undefined && p.reason !== '') return `${tool} — ${p.reason}`
  return `${tool} 请求授权以继续`
}

/**
 * 把 task 泳道事件流折叠成卡片序列（user / ai / tool 行 + 流式中的 partial ai 卡）。
 * - tool/call+result 按 callId 配对；assistant/message → 终态 ai 卡（带 turn 耗时）。
 * - assistant/chunk 不成卡：fold 进「最后一个 open turn」的流式聚合，busy 且未落
 *   assistant/message 时渲染为 partial ai 卡（流式增量）；message 落地后由终态卡承载。
 */
function buildCards(events: readonly SessionEventDto[], busy: boolean): ReactNode[] {
  const out: ReactNode[] = []
  // tool/call 与 tool/result 按 callId 配对（result 覆盖 call 行，带 isError）。
  const resultByCallId = new Map<string, SessionEventDto>()
  // turn 边界（耗时统计：turn/start→turn/end 的 time 差）。
  const turnStart = new Map<number, number>()
  const turnEnd = new Map<number, number>()
  for (const e of events) {
    if (e.type === 'tool/result') {
      const callId = (e.data as { callId?: string } | undefined)?.callId ?? ''
      if (callId !== '') resultByCallId.set(callId, e)
    } else if (e.type === 'turn/start') {
      turnStart.set((e.data as { turn?: number }).turn ?? 0, e.time)
    } else if (e.type === 'turn/end') {
      turnEnd.set((e.data as { turn?: number }).turn ?? 0, e.time)
    }
  }
  const turnDur = (turn: number): number | undefined => {
    const s = turnStart.get(turn)
    const t = turnEnd.get(turn)
    return s !== undefined && t !== undefined ? t - s : undefined
  }

  // 流式聚合：fold 最后一个 open turn（turn/start 后无 turn/end）的 chunk。
  let lastOpenTurn = -1
  for (const e of events) {
    if (e.type === 'turn/start') lastOpenTurn = (e.data as { turn?: number }).turn ?? lastOpenTurn
    else if (e.type === 'turn/end') lastOpenTurn = -1
  }
  const stream: StreamAccum = { turn: lastOpenTurn, step: 0, texts: [], reasonings: [], curType: '', curIndex: 0, sawFinish: false }
  if (lastOpenTurn >= 0) {
    for (const e of events) {
      if (e.type !== 'assistant/chunk') continue
      const d = e.data as { turn?: number; step?: number; chunkType?: string; text?: string }
      if ((d.turn ?? 0) !== lastOpenTurn) continue
      const ct = d.chunkType ?? ''
      if (ct === 'block-start') {
        // 新块开始：text/reasoning 各开新段（按出现顺序）。
        if (d.text !== undefined) { /* block-start 不带 text */ }
        stream.curIndex += 1
        stream.curType = '' // 类型由首个 *-delta 决定
      } else if (ct === 'text-delta') {
        if (stream.curType !== 'text') { stream.curType = 'text'; stream.texts.push('') }
        stream.texts[stream.texts.length - 1] += d.text ?? ''
      } else if (ct === 'reasoning-delta') {
        if (stream.curType !== 'reasoning') { stream.curType = 'reasoning'; stream.reasonings.push('') }
        stream.reasonings[stream.reasonings.length - 1] += d.text ?? ''
      } else if (ct === 'block-end') {
        stream.curType = ''
      } else if (ct === 'finish') {
        stream.sawFinish = true
      }
    }
  }
  const hasStreamContent = stream.texts.some(t => t !== '') || stream.reasonings.some(r => r !== '')

  // 本 turn 是否已落地 assistant/message（落地后流式聚合由终态卡接管，不重复渲染）。
  const messageLandedInOpenTurn = lastOpenTurn >= 0 && events.some(
    e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === lastOpenTurn,
  )

  for (const e of events) {
    if (e.type === 'user/message') {
      const text = userText(e.data)
      if (text === '') continue
      out.push(
        <div key={`u${e.seq}`} className={css.user}>
          <div className={css.userBubble}>
            <div className={css.userBubbleHead}>
              <span className={css.userWho}>You</span>
              <span className={css.userTime}>{timeLabel(e.time)}</span>
            </div>
            <p className={css.userBody}>{text}</p>
          </div>
          <div className={css.userActions}>
            <button type="button" className={css.miniAct} title="修改"><Pencil size={16} strokeWidth={2} /></button>
            <button type="button" className={css.miniAct} title="复制" onClick={() => void navigator.clipboard?.writeText(text)}><Copy size={16} strokeWidth={2} /></button>
            <button type="button" className={css.miniAct} title="回退"><RotateCcw size={16} strokeWidth={2} /></button>
          </div>
        </div>,
      )
    } else if (e.type === 'assistant/message') {
      const { texts, reasonings, toolCalls } = assistantParts(e.data)
      if (texts.length === 0 && reasonings.length === 0 && toolCalls.length === 0) continue
      const turn = (e.data as { turn?: number }).turn ?? -1
      const dur = turn >= 0 ? turnDur(turn) : undefined
      out.push(
        <div key={`a${e.seq}`} className={css.ai}>
          <div className={css.aiHead}>
            <span className={css.aiAvatar} />
            <span className={css.aiWho}>Corum Agent</span>
            <span className={css.aiDur}>{timeLabel(e.time)}</span>
          </div>
          {reasonings.map((r, i) => (
            <details key={`r${i}`} className={css.reasoning}>
              <summary className={css.reasoningSummary}>思考过程</summary>
              <div className={css.reasoningBody}><MarkdownText text={r} labels={MARKDOWN_LABELS} /></div>
            </details>
          ))}
          {texts.map((t, i) => (
            <div key={`t${i}`} className={css.aiBody}><MarkdownText text={t} labels={MARKDOWN_LABELS} /></div>
          ))}
          {toolCalls.map((c, i) => (
            <div key={`c${i}`} className={css.toolRow}>
              <span className={css.toolDot} />
              <span className={css.toolCmd}>{c.label}</span>
            </div>
          ))}
          <div className={css.aiActions}>
            <span className={css.aiDurTime}>{dur !== undefined ? `耗时 ${durLabel(dur)}` : ''}</span>
            <span className={css.spacer} />
            <button type="button" className={css.miniAct} title="分叉"><GitBranch size={16} strokeWidth={2} /></button>
            <button type="button" className={css.miniAct} title="复制" onClick={() => void navigator.clipboard?.writeText(texts.join('\n'))}><Copy size={16} strokeWidth={2} /></button>
          </div>
        </div>,
      )
    } else if (e.type === 'tool/call') {
      const callId = (e.data as { callId?: string } | undefined)?.callId ?? ''
      const result = callId !== '' ? resultByCallId.get(callId) : undefined
      const isError = result !== undefined && toolResultIsError(result.data)
      const done = result !== undefined
      out.push(
        <div key={`tc${e.seq}`} className={css.toolRow}>
          <span className={isError ? css.toolDotError : done ? css.toolDot : `${css.toolDot} ${css.toolDotRunning}`} />
          <span className={css.toolCmd}>{toolCallLabel(e.data)}</span>
          {!done && <Loader size={14} strokeWidth={2} className={css.toolRunningIcon} />}
        </div>,
      )
    }
    // tool/result 已并入 tool/call 行（isError）；assistant/chunk 由流式聚合成卡。
  }

  // 流式 partial ai 卡：busy 且 open turn 有增量且尚未落地 message。
  if (busy && lastOpenTurn >= 0 && hasStreamContent && !messageLandedInOpenTurn) {
    out.push(
      <div key="streaming" className={css.ai} data-streaming>
        <div className={css.aiHead}>
          <span className={css.aiAvatar} />
          <span className={css.aiWho}>Corum Agent</span>
          <span className={css.aiDur}><Loader size={13} strokeWidth={2} className={css.toolRunningIcon} /></span>
        </div>
        {stream.reasonings.map((r, i) => (
          <details key={`sr${i}`} className={css.reasoning} open>
            <summary className={css.reasoningSummary}>思考过程</summary>
            <div className={css.reasoningBody}><MarkdownText text={r} labels={MARKDOWN_LABELS} /></div>
          </details>
        ))}
        {stream.texts.map((t, i) => (
          <div key={`st${i}`} className={css.aiBody}><MarkdownText text={t} labels={MARKDOWN_LABELS} /></div>
        ))}
      </div>,
    )
  }
  return out
}
