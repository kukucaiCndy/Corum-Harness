/**
 * ConversationArea — the IDE conversation column (design.pen ② Agent 对话区
 * yoxDi, vertical gap6). task 模式走 corum 泳道数据通路：host corum-agent-dev
 * 的 task 泳道（corum-task-* session id，agent.session.events → simplifyEventData
 * 投影）经自家 RPC（createTaskAgent / runPromptForTask / getTaskSessionEvents）
 * 拉 SessionEventDto[]，按事件 type 映射到对应设计卡片：
 *   user/message → user 品牌气泡卡；assistant/message → ai 卡（text=Markdown /
 *   reasoning 折叠 / tool-call 行）；tool/call+tool/result → tool 行；
 *   assistant/chunk → 流式中的 ai 卡增量。
 * 发送：runPromptForTask（host 等 Agent 跑完返回回复+事件），随后重拉事件流。
 * Review Card / task-line / 子 Agent 卡 / 审批卡仍为设计默认（后续阶段接）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ArrowUp, Bot, ChevronDown, ChevronRight, Copy, GitBranch, Loader,
  Mic, Pencil, Plus, RotateCcw, ShieldAlert, Sparkles,
} from 'lucide-react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ISessions, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { useSyncExternalStore } from 'react'
import css from './ConversationArea.module.css'

/** Injected actions + the live feed (see client/index.ts apply). */
export interface ConversationInjected {
  list: ISessions['list']
  open: (sessionId: string) => void
  callAgent: <T>(method: string, args: Record<string, unknown>) => Promise<T>
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

/** The IDE conversation column (see module doc). */
export function ConversationArea({ list, callAgent, renderSlot, SessionProvider }: ConversationProps) {
  const listSnap = useSyncExternalStore(list.subscribe, list.getSnapshot)
  const currentId = listSnap.current
  const current = currentId !== undefined ? listSnap.byId[currentId] : undefined
  // task 泳道按 cwd 寻址：当前会话的工作目录（兜底进程 cwd）。
  const cwd = current?.cwd ?? ''

  const [events, setEvents] = useState<readonly SessionEventDto[]>([])
  const [busy, setBusy] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(true)
  const [taskOpen, setTaskOpen] = useState(false)
  const [subOpen, setSubOpen] = useState(false)
  const [allowMenuOpen, setAllowMenuOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const flowRef = useRef<HTMLDivElement | null>(null)

  // 拉取 task 泳道事件流（先确保会话存在，再读历史）。
  const refresh = useCallback(async (workspaceCwd: string) => {
    if (workspaceCwd === '') return
    try {
      const created = await callAgent<{ sessionId: string }>('createTaskAgent', { cwd: workspaceCwd })
      setSessionId(created.sessionId)
      const r = await callAgent<{ events: SessionEventDto[] }>('getTaskSessionEvents', { cwd: workspaceCwd, fromSeq: 0 })
      setEvents(r.events)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [callAgent])

  useEffect(() => { void refresh(cwd) }, [cwd, refresh])

  // 发送一条用户消息（host 跑完返回后重拉事件流）。
  const send = useCallback(async () => {
    const text = draft.trim()
    if (text === '' || cwd === '' || busy) return
    setBusy(true)
    try {
      await callAgent('runPromptForTask', { cwd, prompt: text })
      setDraft('')
      await refresh(cwd)
    } catch (err) {
      console.error('[conversation] 发送失败', err)
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [draft, cwd, busy, callAgent, refresh])

  // 事件流到底部（新事件/发送后）。
  useEffect(() => {
    const el = flowRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [events, busy])

  // ── 事件 → 卡片 ──
  const cards = useMemo(() => buildCards(events), [events])

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
              {cwd === '' ? '选择或新建一个会话开始' : '描述一个开发任务，开始第一轮对话'}
            </div>
          )}

          {cards}

          {busy && (
            <div className={css.ai}>
              <div className={css.aiHead}>
                <span className={css.aiAvatar} />
                <span className={css.aiWho}>Corum Agent</span>
                <span className={css.aiDur}>…</span>
              </div>
              <div className={css.aiBody}><Loader size={16} strokeWidth={2} className={css.toolRunningIcon} /> 正在思考…</div>
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
                {() => (
                  <span className={css.modelSeat}>
                    {renderSlot('conversation.input.model', { locked: false })}
                  </span>
                )}
              </SessionProvider>
            )
            : null}
          <button type="button" className={css.tbtn} title="语音输入"><Mic size={18} strokeWidth={2} className={css.tbtnIcon} /></button>
          <button
            type="button"
            className={css.tbtnSend}
            title={busy ? '会话进行中' : '发送'}
            disabled={draft.trim() === '' || busy || cwd === ''}
            onClick={() => void send()}
          >
            <ArrowUp size={19} strokeWidth={2} className={css.tbtnSendIcon} />
          </button>
        </div>
      </div>
    </div>
  )
}

/** 把 task 泳道事件流折叠成卡片序列（user / ai / tool 行，按 seq 排序、tool call+result 配对）。 */
function buildCards(events: readonly SessionEventDto[]): ReactNode[] {
  const out: ReactNode[] = []
  // tool/call 与 tool/result 按 callId 配对（result 覆盖 call 行，带 isError）。
  const resultByCallId = new Map<string, SessionEventDto>()
  for (const e of events) {
    if (e.type === 'tool/result') {
      const callId = (e.data as { callId?: string } | undefined)?.callId ?? ''
      if (callId !== '') resultByCallId.set(callId, e)
    }
  }

  // 连续 assistant/message 不重复 ai 卡头——每条 assistant/message 一张卡。
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
              <div className={css.reasoningBody}><MarkdownText text={r} /></div>
            </details>
          ))}
          {texts.map((t, i) => (
            <div key={`t${i}`} className={css.aiBody}><MarkdownText text={t} /></div>
          ))}
          {toolCalls.map((c, i) => (
            <div key={`c${i}`} className={css.toolRow}>
              <span className={css.toolDot} />
              <span className={css.toolCmd}>{c.label}</span>
            </div>
          ))}
          <div className={css.aiActions}>
            <span className={css.aiDurTime} />
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
    // tool/result 已并入 tool/call 行（isError），不单独成卡。
    // assistant/chunk / turn/* / step/* 不成卡（流式由 busy 占位 + message 终态承载）。
  }
  return out
}
