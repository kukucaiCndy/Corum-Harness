/**
 * ConversationArea — the IDE conversation column (design.pen ② Agent 对话区
 * yoxDi, vertical gap6). Children follow the design frame's order exactly:
 *   Chat Flow (lrEmq: gutter + messages[user 气泡卡 / ai 卡 / subagent 卡 /
 *   tool 行 / awaiting 审批卡]) → Review Card (nzgrI) → task-line (sKrdG:
 *   任务进度步点) → Chat Input (htxWi: input-line + toolbar ＋/🛡/@Agent/模型/🎤/⬆).
 * Glass cards mirror the design tokens exactly; flow carries the design's
 * default content until the message stream is wired (接真实数据在下一阶段).
 */
import { useSyncExternalStore, useState } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ArrowRight, ArrowUp, Bot, Check, ChevronDown, ChevronRight, Copy,
  GitBranch, Loader, Mic, Pencil, Plus, RotateCcw, ShieldAlert, Sparkles,
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
  const [taskOpen, setTaskOpen] = useState(false)
  const [allowMenuOpen, setAllowMenuOpen] = useState(false)
  const [draft, setDraft] = useState('')

  return (
    <div className={css.column}>
      {/* Convo Header 已删除（2026-08-26 设计改版）：会话标题/状态/轨迹上移到
          顶部贯通标题栏的 Agent 标题栏，对话区只留 Chat Flow / Review / task-line / Input。 */}

      {/* lrEmq — Chat Flow（唯一滚动区：flex:1 + min-height:0）：gutter 步点轨 + messages */}
      <div className={css.flow}>
        {/* vESwF — gutter（8px 竖排步点轨，与 task-line 步点同源示意）。 */}
        <div className={css.gutter} aria-hidden="true">
          <span className={css.gutterDot} />
          <span className={css.gutterDot} />
          <span className={css.gutterDot} />
          <span className={css.gutterDot} />
          <span className={`${css.gutterDot} ${css.gutterDotActive}`} />
        </div>

        {/* wJLY6 — messages（vertical gap6）。 */}
        <div className={css.messages}>
          {/* r6SOa6 — user 卡（alignItems:end 靠右；bubble 品牌色 r[14,14,4,14] + user-actions）。 */}
          <div className={css.user}>
            <div className={css.userBubble}>
              <div className={css.userBubbleHead}>
                <span className={css.userWho}>You</span>
                <span className={css.userTime}>14:32</span>
              </div>
              <p className={css.userBody}>把矩道界面改成液态玻璃风格，蒸汽波深色 + 高反差白浅色</p>
            </div>
            <div className={css.userActions}>
              <button type="button" className={css.miniAct} title="修改"><Pencil size={16} strokeWidth={2} /></button>
              <button type="button" className={css.miniAct} title="复制"><Copy size={16} strokeWidth={2} /></button>
              <button type="button" className={css.miniAct} title="回退"><RotateCcw size={16} strokeWidth={2} /></button>
            </div>
          </div>

          {/* N91GH — ai 卡（glass-1 r18 pad14 gap8；head + body + ai-actions）。 */}
          <div className={css.ai}>
            <div className={css.aiHead}>
              <span className={css.aiAvatar} />
              <span className={css.aiWho}>Corum Agent</span>
              <span className={css.aiDur}>14:32</span>
            </div>
            <p className={css.aiBody}>
              已应用液态玻璃：环境光斑透出 + 半透明卡片 + 光边描边 + 蒸汽波霓虹配色。
            </p>
            <div className={css.aiActions}>
              <span className={css.aiDurTime}>耗时 12s</span>
              <span className={css.spacer} />
              <button type="button" className={css.miniAct} title="分叉"><GitBranch size={16} strokeWidth={2} /></button>
              <button type="button" className={css.miniAct} title="复制"><Copy size={16} strokeWidth={2} /></button>
            </div>
          </div>

          {/* bSZm5 — subagent 卡（glass-1 r14 pad12 gap8；head + prog + step）。 */}
          <div className={css.subCard}>
            <div className={css.subHead}>
              <span className={css.subAvatar}>
                <Bot size={16} strokeWidth={2} className={css.subAvatarIcon} />
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
                aria-expanded={subOpen}
                onClick={() => setSubOpen(v => !v)}
              >
                {subOpen
                  ? <ChevronDown size={17} strokeWidth={2} className={css.subActIcon} />
                  : <ChevronRight size={17} strokeWidth={2} className={css.subActIcon} />}
              </button>
              <button type="button" className={css.subAct} title="切换到子 Agent 会话">
                <ArrowRight size={17} strokeWidth={2} className={css.subGotoIcon} />
              </button>
            </div>
            <div className={css.prog}>
              <div className={css.progBar} style={{ width: '60%' }} />
            </div>
            <div className={css.subStep}>
              <Loader size={15} strokeWidth={2} className={css.subStepIcon} />
              <span className={css.subStepText}>Step 3/5 · 正在生成 theme.css</span>
            </div>
          </div>

          {/* i4m5N — tool 行（glass-2 r12 pad10 gap8；dot + cmd + add/del）。 */}
          <div className={css.toolRow}>
            <span className={css.toolDot} />
            <span className={css.toolCmd}>edit_file · packages/layout/views.ts</span>
            <span className={css.toolMeta}>
              <span className={css.toolAdd}>+48</span>
              <span className={css.toolDel}>−12</span>
            </span>
          </div>

          {/* N1EDZ — awaiting 审批卡（glass-1 r18 warn-border pad14 gap8；
              head + body + actions(拆分允许一次▾ + 拒绝) + menu(默认收起)）。 */}
          <div className={css.awaitingCard}>
            <div className={css.aiHead}>
              <span className={css.aiAvatar} />
              <span className={css.aiWho}>Corum Agent</span>
              <span className={css.awaitTag}>● 等待审批</span>
            </div>
            <p className={css.awaitBody}>bash pnpm build && pnpm test</p>
            <div className={css.awaitActions}>
              <span className={css.allowSplit}>
                <button type="button" className={css.allowMain}>允许一次</button>
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
              <button type="button" className={css.denyBtn}>拒绝</button>
            </div>
            {allowMenuOpen && (
              <div className={css.allowMenu}>
                <button type="button" className={`${css.allowMenuItem} ${css.allowMenuItemActive}`}>
                  <Check size={16} strokeWidth={2} className={css.allowMenuCheck} />
                  允许一次
                </button>
                <button type="button" className={css.allowMenuItem}>
                  <span className={css.allowMenuCk} />
                  始终允许
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* nzgrI — Review Card（glass-1 r14 pad[10,14] gap10；chev ▸ + t + diff + sp + reject + accept）。 */}
      <div className={css.review}>
        <button
          type="button"
          className={css.reviewChev}
          aria-expanded={reviewOpen}
          title={reviewOpen ? '收起变更' : '展开变更'}
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
            <button type="button" className={css.reviewAccept}>全部保留</button>
          </>
        )}
      </div>

      {/* sKrdG — task-line（glass-1 r14 h40 pad[0,16]；任务进度步点 0-6 + 连接线 + 展开钮）。 */}
      <div className={css.taskLine}>
        {['done', 'done', 'done', 'active', 'todo', 'todo', 'todo'].map((st, i, arr) => (
          <span key={i} className={css.taskSeg}>
            {st === 'active'
              ? (
                <span className={css.taskDotActiveWrap}>
                  <span className={css.taskDotHalo} />
                  <span className={css.taskDotActive} />
                </span>
              )
              : <span className={st === 'done' ? css.taskDotDone : css.taskDotTodo} />}
            {i < arr.length - 1 && (
              <span className={`${css.taskConn} ${st === 'done' ? css.taskConnDone : ''}`} />
            )}
          </span>
        ))}
        <button
          type="button"
          className={css.taskExpand}
          title={taskOpen ? '收起任务进度' : '展开任务进度'}
          aria-expanded={taskOpen}
          onClick={() => setTaskOpen(v => !v)}
        >
          <ChevronDown size={13} strokeWidth={2} className={taskOpen ? css.taskExpandOpen : undefined} />
        </button>
      </div>

      {/* htxWi — Chat Input（glass-2 r16 pad[12,12,10,14] gap10）：input-line + toolbar */}
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
