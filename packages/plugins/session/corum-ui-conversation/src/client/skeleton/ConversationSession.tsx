/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useEffect } from 'react'
import clsx from 'clsx'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps,
} from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
  readonly subagent: boolean
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({
      id: summary.id,
      displayTitle: summary.displayTitle,
      subagent: summary.origin === 'subagent',
    })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

/**
 * Renders the Session band inside the unified titlebar.
 *
 * CORUM-PATCH(P2, 2026-09-30)：本组件从「对话区 leaf 内的会话顶栏卡片」搬到
 * **统一标题栏的会话段**（occupant = `corum.titlebar.session`，宿主 = 插件
 * @corum/corum-ui-titlebar）。为什么必须搬：这条 40px 带子此前被两个 owner 分别
 * 持有（壳的窗口按钮行 + 本卡片/空态拖拽带），折叠侧栏后本卡片的
 * `app-region: drag` 整片盖住壳的控件层——drag 位图不遵守 z-index、显式 `no-drag`
 * 也凿不掉 ⇒ 物理鼠标点「展开」被判成拖窗（双击还触发 macOS 标题栏缩放）。
 *
 * 搬动带来的三处形态变化（其余逐行保留）：
 *   ① 拖拽不再是本组件的职责（带子的填充矩形产生 drag），本组件只留
 *      「交互元素显式 no-drag」；容器尺寸/外边距交给带子（占满会话段、无自身高度）。
 *   ② 多视图 tabs 行不再渲染（40px 放不下；IDE 组合里 conversation.view 只有 chat
 *      一个 occupant ⇒ tabs.length > 1 不可达）——登记为 R2，需要时改回 leaf 内条。
 *   ③ 不再需要会话 store（tabs 是它唯一的消费者）。
 * `<header>` 语义容器保留：状态胶囊的详情浮层靠 `closest('header')` 测锚点。
 * @param props - Strict Session store, navigation, render, and locale shares.
 * @returns the hidden blank-session band or the visible title with corum chrome.
 */
export function ConversationSessionHeader({
  sessionId, useSession, useSessions, useConversation, renderSlot, open, t,
}: ConversationSessionHeaderProps) {
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const hideChrome = session.blank && conversationPhase(session, conversation) === 'blank'

  return (
    <header
      className={clsx(css.header, hideChrome && css.headerHidden)}
      aria-hidden={hideChrome || undefined}
    >
      {!hideChrome && (
        <>
          {/* 标题行（2026-09-10 恢复，官方 0.1.3 结构）。
             2026-08-29 曾整块删除（理由：壳的 Agent 标题栏已显示会话标题，避免重复）；
             2026-09-10「顶栏归会话」把壳的 Agent 标题栏拆掉、会话段迁回会话级槽后，
             该理由不再成立——本行重新成为会话顶栏的宿主：
               crumbs（当前会话标题/子会话面包屑） + actions（壳贡献的合并胶囊）
               + utilities（壳贡献的轨迹按钮，右对齐）。
             .actions/.utilities 两个 list 子槽由 apply.ts 声明、由本行渲染——壳经它们
             贡献 corum 专属 chrome，无需改本组件逻辑。

             fork（corum，2026-09-10）：**刻意不 renderSlot 官方 lineage 槽**
             官方 ui-subagent 往它注册 `SubagentHeaderLineage`（「N 个子代理 ⌄」），
             那是顶栏的**第二个下拉**——用户定调「顶部下拉按钮只有一个」，子 Agent
             信息一律走壳那个合并胶囊的浮层（见 corum-ide-ui/session-bar.tsx 的
             AgentStatusDetail）。P2 起该槽的声明也随宿主退役（该包在 IDE 组合里
             永久 pending，注册从未发生）。 */}
          <div className={css.titleRow}>
            <div className={css.titleCluster}>
              <nav className={css.crumbs} aria-label={t('session.hierarchy')}>
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1
                  return (
                    <span key={summary.id} className={css.crumbSeg}>
                      {index > 0 && <span className={css.crumbSep}>/</span>}
                      <button
                        type="button"
                        className={clsx(
                          css.crumb,
                          summary.subagent && css.crumbSubagent,
                          last && css.crumbCurrent,
                        )}
                        disabled={last}
                        onClick={() => { open(summary.id) }}
                      >
                        {summary.displayTitle}
                      </button>
                    </span>
                  )
                })}
                {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
              </nav>
            </div>
            <div className={css.headerUtilities}>
              {renderSlot('conversation.session.header.utilities', {})}
            </div>
          </div>
          {cwd && <div className={css.projectBinding} title={cwd}>项目 · {cwd.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)}</div>}
          <div className={css.headerActions}>{renderSlot('conversation.session.header.actions', {})}</div>
        </>
      )}
    </header>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession({
  useSession, useConversation, useConversationViews, useInput, inputActions, useStore, actions,
  renderSlot, bindDraftMirror, openView,
}: ConversationSessionProps) {
  const tabs = useConversationViews(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  const viewRequest = useStore(s => s.viewRequest ?? null)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  if (session.blank && conversationPhase(session, conversation) === 'blank') return null
  return (
    <div className={css.viewArea}>
      {active !== undefined && renderSlot('conversation.view', {
        viewRequest,
        openView,
        completeViewRequest: actions.completeViewRequest,
      }, { only: active.id })}
    </div>
  )
}
