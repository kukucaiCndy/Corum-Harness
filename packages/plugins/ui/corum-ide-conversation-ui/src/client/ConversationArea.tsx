/**
 * ConversationArea — the IDE conversation column (design.pen ② Agent 对话区
 * yoxDi, vertical gap6). 接真实会话消息流：当前会话的 ConversationSnapshot
 * （ctx.sessions.binding(current).session，ObservableSnapshot）经 uSES 订阅，
 * 消息按 ConversationNode.kind 映射到对应设计卡片：
 *   user → user 品牌气泡卡；assistant → ai 卡（Markdown 文本 + 工具块）；
 *   tool-result → tool 行；pending(approval) → awaiting 审批卡；
 *   其余（reasoning 折叠进 ai 卡 / context / steering / retry / error / command
 *   / compaction / unknown）按设计语义归并或降级。
 * Review Card / task-line / 子 Agent 卡仍为设计默认（真实数据后续阶段接）。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ArrowUp, Bot, ChevronDown, ChevronRight, Copy, GitBranch, Loader,
  Mic, Pencil, Plus, RotateCcw, ShieldAlert, Sparkles,
} from 'lucide-react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ISessions, SessionFace, SessionSummary,
  ConversationNode, AssistantBlock, PendingInteraction,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ContentBlock } from '@deepseek-ai/dsh-api-remotes/client'
import css from './ConversationArea.module.css'

/** Injected actions + the live feed (see client/index.ts apply). */
export interface ConversationInjected {
  list: ISessions['list']
  open: (sessionId: string) => void
  sessionOf: (sessionId: string) => SessionFace | undefined
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

/** 提取 ContentBlock[] 的可见纯文本（user/steering/context 消息体）。 */
function blocksText(content: readonly ContentBlock[]): string {
  return content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter((s) => s !== '')
    .join('\n')
}

/** 时间戳 → HH:MM（卡片头时间）。 */
function timeLabel(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** assistant 耗时（timing.completed − stepStart，秒）；无 stepStart 退回首 token 差。 */
function durationLabel(node: { timing?: { stepStartTime: number | null; firstTokenTime: number | null; completedTime: number } }): string | null {
  const t = node.timing
  if (t === undefined) return null
  const start = t.stepStartTime ?? t.firstTokenTime
  if (start === null) return null
  const s = Math.max(0, Math.round((t.completedTime - start) / 1000))
  return `耗时 ${s}s`
}

/** tool-result 的简要描述（工具名 · 参数摘要）。 */
function toolCmdLabel(name: string | null, argsRaw: string | null): string {
  if (name === null) return 'tool'
  // edit_file · path / bash · command 这类「工具名 · 主参数」一行展示。
  let arg = ''
  if (argsRaw !== null && argsRaw !== '') {
    try {
      const parsed = JSON.parse(argsRaw) as Record<string, unknown>
      arg = String(parsed.path ?? parsed.file ?? parsed.command ?? parsed.cmd ?? parsed.filePath ?? '')
    } catch { arg = '' }
  }
  return arg === '' ? name : `${name} · ${arg}`
}

/** tool-result 的 diff 增删（meta 里常见的 linesAdded/linesRemoved）。 */
function toolDiff(node: { meta?: unknown }): { add: number; del: number } | null {
  const m = node.meta as Record<string, unknown> | undefined
  if (m === undefined || m === null) return null
  const add = Number(m.linesAdded ?? m.added ?? m.additions ?? 0)
  const del = Number(m.linesRemoved ?? m.removed ?? m.deletions ?? 0)
  if (!Number.isFinite(add) && !Number.isFinite(del)) return null
  if (add === 0 && del === 0) return null
  return { add, del }
}

/** The IDE conversation column (see module doc). */
export function ConversationArea({ sessionOf, useSession, sessionId, renderSlot, SessionProvider }: ConversationProps) {
  // 会话快照走框架的 useSession selector hook（SessionStandardProps，session 作用域
  // 注入）——它绑定的是本 slot 所在会话的「已打开窗口」ConversationSnapshot，处理
  //  staged/opened 生命周期（只有 staged session 才投影消息）。不能绕路用
  //  ctx.sessions.binding().session 自订阅：那拿到的是未打开窗口的对象层快照，
  //  新会话发消息后 nodes 不投影（曾导致消息流空）。
  const convo = useSession((s) => s)
  const session = sessionId !== undefined ? sessionOf(sessionId) : undefined

  const [reviewOpen, setReviewOpen] = useState(true)
  const [subOpen, setSubOpen] = useState(false)
  const [taskOpen, setTaskOpen] = useState(false)
  const [allowMenuOpen, setAllowMenuOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const running = convo?.running === true
  const nodes = convo?.nodes ?? []
  const pending = convo?.pending ?? []
  const firstApproval = pending.find((p) => p.kind === 'approval')

  // 临时调试：把会话快照真实状态渲染到 DOM（诊断消息流空）。
  const debugInfo = JSON.stringify({
    convoUndefined: convo === undefined,
    openState: convo?.openState ?? null,
    nodesLen: convo?.nodes?.length ?? null,
    chatLegacyLen: convo?.chat?.legacy?.nodes?.length ?? null,
    chatOrderLen: convo?.chat?.order?.length ?? null,
    running: convo?.running ?? null,
    blank: convo?.blank ?? null,
    composerPhase: convo?.composerPhase ?? null,
    sessionId: sessionId ?? null,
  })

  // 发送一条用户消息（queue 模式追加轮次）。
  const send = () => {
    const text = draft.trim()
    if (text === '' || session === undefined) return
    void session.prompt([{ type: 'text', text }], 'queue')
      .then(() => setDraft(''))
      .catch((err: unknown) => { console.error('[conversation] 发送失败', err) })
  }

  // 审批回应（允许一次 / 拒绝；「始终允许」官方 outcome 暂无，暂以 allowed-once 占位）。
  const answerApproval = (p: PendingInteraction, outcome: 'allowed-once' | 'rejected') => {
    if (p.kind !== 'approval') return
    void p.respond({
      ok: true,
      value: { sessionId: p.sessionId, approvalId: p.payload.approvalId, outcome },
    } as never).catch((err: unknown) => { console.error('[conversation] 审批回应失败', err) })
  }

  // ── 消息节点 → 设计卡片 ──
  const renderNode = (node: ConversationNode): ReactNode => {
    switch (node.kind) {
      case 'user': {
        const text = blocksText(node.content)
        return (
          <div key={node.seq} className={css.user}>
            <div className={css.userBubble}>
              <div className={css.userBubbleHead}>
                <span className={css.userWho}>You</span>
                <span className={css.userTime}>{timeLabel(node.time)}</span>
              </div>
              <p className={css.userBody}>{text}</p>
            </div>
            <div className={css.userActions}>
              <button type="button" className={css.miniAct} title="修改"><Pencil size={16} strokeWidth={2} /></button>
              <button type="button" className={css.miniAct} title="复制" onClick={() => void navigator.clipboard?.writeText(text)}><Copy size={16} strokeWidth={2} /></button>
              <button type="button" className={css.miniAct} title="回退"><RotateCcw size={16} strokeWidth={2} /></button>
            </div>
          </div>
        )
      }

      case 'assistant': {
        const dur = durationLabel(node)
        return (
          <div key={node.seq} className={css.ai}>
            <div className={css.aiHead}>
              <span className={css.aiAvatar} />
              <span className={css.aiWho}>Corum Agent</span>
              <span className={css.aiDur}>{timeLabel(node.time)}</span>
            </div>
            <AssistantBlocks blocks={node.blocks} streaming={false} />
            <div className={css.aiActions}>
              <span className={css.aiDurTime}>{dur ?? ''}</span>
              <span className={css.spacer} />
              <button type="button" className={css.miniAct} title="分叉"><GitBranch size={16} strokeWidth={2} /></button>
              <button type="button" className={css.miniAct} title="复制"><Copy size={16} strokeWidth={2} /></button>
            </div>
          </div>
        )
      }

      case 'tool-result': {
        const diff = toolDiff(node)
        return (
          <div key={node.seq} className={css.toolRow}>
            <span className={node.isError ? css.toolDotError : css.toolDot} />
            <span className={css.toolCmd}>{toolCmdLabel(node.call?.name ?? null, node.call?.argsRaw ?? null)}</span>
            {diff !== null && (
              <span className={css.toolMeta}>
                {diff.add > 0 && <span className={css.toolAdd}>+{diff.add}</span>}
                {diff.del > 0 && <span className={css.toolDel}>−{diff.del}</span>}
              </span>
            )}
          </div>
        )
      }

      case 'turn-error':
        return (
          <div key={node.seq} className={css.toolRow}>
            <span className={css.toolDotError} />
            <span className={css.toolCmd}>错误：{node.message}</span>
          </div>
        )

      case 'steering':
      case 'context':
      case 'model-retry':
      case 'turn-max-tokens':
      case 'command':
      case 'compaction':
      case 'unknown':
      default:
        // 暂不映射到设计卡片的节点类型（reasoning 已并入 ai 卡）——降级隐藏，
        // 后续按设计语义补卡（context/steering/命令/压缩标记等）。
        return null
    }
  }

  return (
    <div className={css.column}>
      {/* lrEmq — Chat Flow（唯一滚动区）：gutter 步点轨 + messages（真实消息流） */}
      <div className={css.flow}>
        <div className={css.gutter} aria-hidden="true">
          <span className={css.gutterDot} />
          <span className={css.gutterDot} />
          <span className={css.gutterDot} />
          <span className={css.gutterDot} />
          <span className={`${css.gutterDot} ${css.gutterDotActive}`} />
        </div>

        <div className={css.messages}>
          {/* 临时调试输出（诊断后移除）。 */}
          <div data-convo-debug style={{ display: 'none' }}>{debugInfo}</div>
          {/* 空态：无会话或无消息。 */}
          {nodes.length === 0 && !running && firstApproval === undefined && (
            <div className={css.emptyFlow}>
              {convo === null || convo === undefined
                ? '选择或新建一个会话开始'
                : convo.composerPhase === 'blank'
                  ? '描述一个开发任务，开始第一轮对话'
                  : '暂无消息'}
            </div>
          )}

          {/* 真实消息流。 */}
          {nodes.map(renderNode)}

          {/* 流式中的 assistant 部分输出（partial）。 */}
          {convo?.partial != null && convo.partial.blocks.length > 0 && (
            <div className={css.ai}>
              <div className={css.aiHead}>
                <span className={css.aiAvatar} />
                <span className={css.aiWho}>Corum Agent</span>
                <span className={css.aiDur}>…</span>
              </div>
              <AssistantBlocks blocks={convo.partial.blocks} streaming />
            </div>
          )}

          {/* 运行中的工具调用（runningCalls：call 已发、result 未回）。 */}
          {(convo?.runningCalls ?? []).map((c) => (
            <div key={c.callId} className={css.toolRow}>
              <span className={`${css.toolDot} ${css.toolDotRunning}`} />
              <span className={css.toolCmd}>{toolCmdLabel(c.name, c.argsRaw)}</span>
              <Loader size={14} strokeWidth={2} className={css.toolRunningIcon} />
            </div>
          ))}

          {/* 子 Agent 卡（设计默认假数据；真实子 Agent 路由后续阶段接）。 */}
          {subOpen !== undefined && false && (
            <div className={css.subCard}>
              <div className={css.subHead}>
                <span className={css.subAvatar}><Bot size={16} strokeWidth={2} className={css.subAvatarIcon} /></span>
                <span className={css.subMeta}>
                  <span className={css.subName}>子 Agent</span>
                  <span className={css.subTask}>—</span>
                </span>
              </div>
            </div>
          )}

          {/* N1EDZ — awaiting 审批卡（真实 pending approval）。 */}
          {firstApproval !== undefined && firstApproval.kind === 'approval' && (
            <div className={css.awaitingCard}>
              <div className={css.aiHead}>
                <span className={css.aiAvatar} />
                <span className={css.aiWho}>Corum Agent</span>
                <span className={css.awaitTag}>● 等待审批</span>
              </div>
              <p className={css.awaitBody}>
                {firstApproval.payload.reason ?? firstApproval.payload.toolName}
              </p>
              <div className={css.awaitActions}>
                <span className={css.allowSplit}>
                  <button type="button" className={css.allowMain} onClick={() => answerApproval(firstApproval, 'allowed-once')}>允许一次</button>
                  <span className={css.allowDivider} />
                  <button
                    type="button"
                    className={css.allowChev}
                    title="更多允许方式"
                    aria-expanded={allowMenuOpen}
                    onClick={() => setAllowMenuOpen(v => !v)}
                  >
                    <ChevronDown size={16} strokeWidth={2} />
                  </button>
                </span>
                <button type="button" className={css.denyBtn} onClick={() => answerApproval(firstApproval, 'rejected')}>拒绝</button>
              </div>
              {allowMenuOpen && (
                <div className={css.allowMenu}>
                  <button type="button" className={`${css.allowMenuItem} ${css.allowMenuItemActive}`} onClick={() => { setAllowMenuOpen(false); answerApproval(firstApproval, 'allowed-once') }}>
                    允许一次
                  </button>
                  <button type="button" className={css.allowMenuItem} title="官方审批暂无『始终允许』outcome，暂以允许一次代替" onClick={() => { setAllowMenuOpen(false); answerApproval(firstApproval, 'allowed-once') }}>
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

      {/* htxWi — Chat Input（接真实发送）。 */}
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
                send()
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
            title={running ? '会话进行中' : '发送'}
            disabled={draft.trim() === ''}
            onClick={send}
          >
            <ArrowUp size={19} strokeWidth={2} className={css.tbtnSendIcon} />
          </button>
        </div>
      </div>
    </div>
  )
}

/** assistant 消息体：按 AssistantBlock.kind 渲染（text=Markdown / reasoning 折叠 / tool-call 占位 / image）。 */
function AssistantBlocks({ blocks, streaming }: { blocks: readonly AssistantBlock[]; streaming: boolean }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'text':
            return (
              <div key={i} className={css.aiBody}>
                <MarkdownText text={b.text} streaming={streaming} />
              </div>
            )
          case 'reasoning':
            return (
              <details key={i} className={css.reasoning}>
                <summary className={css.reasoningSummary}>思考过程</summary>
                <div className={css.reasoningBody}><MarkdownText text={b.text} streaming={streaming} /></div>
              </details>
            )
          case 'tool-call':
            return (
              <div key={i} className={css.toolRow}>
                <span className={css.toolDot} />
                <span className={css.toolCmd}>{toolCmdLabel(b.name, b.argsRaw)}</span>
              </div>
            )
          case 'image':
          case 'other':
          default:
            return null
        }
      })}
    </>
  )
}
