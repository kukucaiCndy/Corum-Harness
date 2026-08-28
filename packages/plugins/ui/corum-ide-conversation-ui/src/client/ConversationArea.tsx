/**
 * ConversationArea — the IDE conversation column (design.pen ② Agent 对话区,
 * 浅 CvGoK / 深 GNcz1, flex). Children follow the design frame's order exactly:
 * Convo Header (nkAAA: 对话/轨迹 tab + git-branch/chart-column/× hbtn) →
 * Chat Flow (kEPVP: user + msg-agent + subagent-card + tool-call-row +
 * msg-awaiting) → Review Card (pD6NP) → Chat Input (q3HcU: input-line +
 * toolbar ＋/🛡/@Agent/gauge/模型/🎤/⬆). Glass cards mirror the design tokens
 * exactly; flow carries the design's default content until the message stream
 * is wired.
 */
import { useSyncExternalStore, useState } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ArrowRight, ArrowUp, Bot, ChevronDown, ChevronRight,
  Gauge, Loader, Mic, Plus, ShieldAlert, Sparkles,
} from 'lucide-react'
import type { ISessions, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import css from './ConversationArea.module.css'

/** Injected actions + the live feed (see client/index.ts apply). */
export interface ConversationInjected {
  list: ISessions['list']
  open: (sessionId: string) => void
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

/** The IDE conversation column (see module doc). */
export function ConversationArea({ list, renderSlot, SessionProvider }: ConversationProps) {
  const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot)
  const currentId = snapshot.current
  const current = currentId !== undefined ? snapshot.byId[currentId] : undefined
  void current // 会话标题/状态上移到顶部 Agent 标题栏，保留订阅以便后续接消息流
  const [reviewOpen, setReviewOpen] = useState(true)
  const [subOpen, setSubOpen] = useState(false)
  const [draft, setDraft] = useState('')

  return (
    <div className={css.column}>
      {/* Convo Header 已删除（2026-08-26 设计改版）：会话标题/状态/轨迹上移到
          顶部贯通标题栏的 Agent 标题栏，对话区只留 Chat Flow / Review / Input。 */}

      {/* kEPVP — Chat Flow（唯一滚动区：flex:1 + min-height:0） */}
      <div className={css.flow}>
        {(
          <div className={css.flowInner}>
            {/* R7R8jB — user card（glass-1 r16 pad12 gap4） */}
            <div className={css.userCard}>
              <div className={css.msgHead}>
                <span className={css.msgWho}>You</span>
                <span className={css.msgTime}>14:32</span>
              </div>
              <p className={css.userBody}>把矩道界面改成液态玻璃风格，蒸汽波深色 + 高反差白浅色</p>
            </div>

            {/* jA0u7 — msg-agent（KFBiE，glass-1 r18 pad14 gap8） */}
            <div className={css.agentCard}>
              <div className={css.msgHead}>
                <span className={css.avatar} />
                <span className={css.agentWho}>Corum Agent</span>
                <span className={css.agentDur}>耗时 12s</span>
              </div>
              <p className={css.agentBody}>
                已应用液态玻璃：环境光斑透出 + 半透明卡片 + 光边描边 + 蒸汽波霓虹配色。
              </p>
            </div>

            {/* mfIy6 — subagent-card（bSZm5，glass-1 r14 pad12 gap8） */}
            <div className={css.subCard}>
              <div className={css.subHead}>
                <span className={css.subAvatar}>
                  <Bot size={14} strokeWidth={2} className={css.subAvatarIcon} />
                </span>
                <span className={css.subMeta}>
                  <span className={css.subName}>子 Agent · UI Designer</span>
                  <span className={css.subTask}>设计系统 token 迁移</span>
                </span>
                <span className={css.runChip}>
                  <span className={css.runDot} />
                  Running · Step 3/5
                </span>
                <button
                  type="button"
                  className={css.subAct}
                  title={subOpen ? '收起子任务' : '展开子任务'}
                  onClick={() => setSubOpen(v => !v)}
                >
                  {subOpen
                    ? <ChevronDown size={16} strokeWidth={2} className={css.subActIcon} />
                    : <ChevronRight size={16} strokeWidth={2} className={css.subActIcon} />}
                </button>
                <button type="button" className={css.subAct} title="切换到子 Agent 会话">
                  <ArrowRight size={16} strokeWidth={2} className={css.subGotoIcon} />
                </button>
              </div>
              <div className={css.prog}>
                <div className={css.progBar} style={{ width: '60%' }} />
              </div>
              <div className={css.subStep}>
                <Loader size={14} strokeWidth={2} className={css.subStepIcon} />
                <span className={css.subStepText}>Step 3/5 · 正在生成 theme.css</span>
              </div>
            </div>

            {/* bQKMB — tool-call-row（b5eYVw，glass-2 r12 pad10 gap8） */}
            <div className={css.toolRow}>
              <span className={css.toolDot} />
              <span className={css.toolCmd}>edit_file · packages/layout/views.ts</span>
              <span className={css.toolMeta}>+48</span>
            </div>

            {/* Yh3hq — msg-awaiting（NrFh6，glass-1 r18 warn-border pad14 gap8） */}
            <div className={css.awaitingCard}>
              <div className={css.msgHead}>
                <span className={css.avatar} />
                <span className={css.agentWho}>Corum Agent</span>
                <span className={css.awaitTag}><span className={css.awaitDot} />等待审批</span>
              </div>
              <p className={css.awaitBody}>bash pnpm build && pnpm test</p>
              <div className={css.awaitActions}>
                <button type="button" className={css.btnPrimary}>允许一次</button>
                <button type="button" className={css.btnSecondary}>拒绝</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* pD6NP — Review Card（glass-1 r14 pad[10,14] gap10） */}
      <div className={css.review}>
        <button
          type="button"
          className={css.reviewChev}
          aria-expanded={reviewOpen}
          onClick={() => setReviewOpen((v) => !v)}
        >
          <ChevronRight size={15} strokeWidth={2} className={reviewOpen ? css.reviewChevOpen : undefined} />
        </button>
        <span className={css.reviewTitle}>3 个文件已更改</span>
        <span className={css.reviewDiff}>+128 −40</span>
        <span className={css.spacer} />
        {reviewOpen && (
          <>
            <button type="button" className={css.reviewReject}>全部撤销</button>
            <button type="button" className={css.btnPrimary}>全部保留</button>
          </>
        )}
      </div>

      {/* q3HcU — Chat Input（glass-2 r16 pad[12,12,10,14] gap10）：input-line + toolbar */}
      <div className={css.input}>
        <div className={css.inputLine}>
          <textarea
            className={css.inputField}
            placeholder="描述一个开发任务，用 @ 添加上下文，/ 使用命令"
            value={draft}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && draft.trim() !== '') {
                e.preventDefault()
                setDraft('')
              }
            }}
          />
          <Sparkles size={19} strokeWidth={2} className={css.sparkle} />
        </div>
        <div className={css.toolbar}>
          <button type="button" className={css.tbtn} title="添加上下文">
            <Plus size={19} strokeWidth={2} className={css.tbtnIcon} />
          </button>
          <button type="button" className={css.tbtn} title="授权设置">
            <ShieldAlert size={18} strokeWidth={2} className={css.tbtnShield} />
          </button>
          <button type="button" className={css.tbtnAgent} title="选择 Agent">
            <span className={css.tbtnAgentAt}>@</span>
            <span className={css.tbtnAgentLabel}>Agent</span>
            <ChevronDown size={16} strokeWidth={2} className={css.tbtnChev} />
          </button>
          <span className={css.spacer} />
          <button type="button" className={css.tbtnContext} title="上下文用量">
            <Gauge size={18} strokeWidth={2} className={css.tbtnIcon} />
            <span className={css.tbtnPct}>1%</span>
          </button>
          {/* 模型选择器座位（corum-ui-model-selection 的 ModelSelect 占用）。
              会话作用域子槽：SessionProvider 包出 sessionId；无会话时退回静态占位。 */}
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
          <button type="button" className={css.tbtn} title="语音输入">
            <Mic size={18} strokeWidth={2} className={css.tbtnIcon} />
          </button>
          <button
            type="button"
            className={css.tbtnSend}
            title="发送"
            disabled={draft.trim() === ''}
            onClick={() => setDraft('')}
          >
            <ArrowUp size={19} strokeWidth={2} className={css.tbtnSendIcon} />
          </button>
        </div>
      </div>
    </div>
  )
}
