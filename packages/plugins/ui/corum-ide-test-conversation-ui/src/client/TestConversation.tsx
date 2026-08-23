/**
 * TestConversation — the S0 placeholder for the conversation slot: a self-
 * identifying center module ("对话区槽") + live session fact + an openDetails
 * button wired to ctx.layout (via the registration inject factory), proving
 * the center column composes AND the details-drawer action crosses the
 * shell/plugin boundary. Token-only styles.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TestConversation.module.css'

/** Injected share from the registration's inject factory. */
export interface TestConversationInjected {
  /** Open the details drawer (ctx.layout.openDetails). */
  onOpenDetails: () => void
}

/** Composed props: runtime share (session-maybe standard props) + injected. */
export type TestConversationProps = PropsRuntime<'conversation'> & TestConversationInjected

/** The placeholder center module (see module doc). */
export function TestConversation(props: TestConversationProps) {
  const sessionId = (props as { sessionId?: string }).sessionId
  const floating = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('floating')
  return (
    <div className={css.card} data-testid="corum-conversation-placeholder">
      {/* 浮动窗里隐藏 head——Window Chrome 已标识槽位。 */}
      {!floating && (
        <div className={css.head}>
          <span className={css.slot}>conversation</span>
          <span className={css.badge}>S0 测试模块</span>
        </div>
      )}
      <div className={css.caption}>
        对话区列（② flex 兜底）。S2 由 @corum/corum-ide-conversation-ui（消息流）接管。
      </div>
      <ul className={css.facts}>
        <li>sessionId: {sessionId ?? '(no session)'}</li>
        <li>让位链：对话区吸收剩余宽度（flex 兜底，floor 400）</li>
        <li>scope: session-maybe（无会话也挂载）</li>
      </ul>
      <div className={css.actions}>
        <button type="button" className={css.action} onClick={props.onOpenDetails}>
          打开详情抽屉 (openDetails)
        </button>
      </div>
    </div>
  )
}
