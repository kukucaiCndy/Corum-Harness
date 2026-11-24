/**
 * fork（corum, 2026-11-22）：选中→双动作浮条（2026-11-19 入口精简轮重设计）。
 *
 * 用户在主会话区 prose 内选中文本后，在选区**下方**显示深色 glass 圆角横条，
 * 含两个带对话图标的动作 + 中间竖分隔线（照用户参考图形态）：
 *
 * - **「添加到对话 ↵」**：把选中片段追加进当前主会话 composer 草稿
 *   （经 onAddToDraft 回调：现有草稿 + 换行 + 选中文本，然后 focus 输入框）。
 *   **Enter 快捷键**触发此动作（菜单可见时）。
 * - **「在侧边对话中提问」**：现有 askAi(quote) 行为（创建/复用侧边 chat + 分栏
 *   打开 + 草稿预填）。
 *
 * ## 触发条件（全部满足才显示）
 *
 * 1. 选区非折叠（`selection.isCollapsed === false`）。
 * 2. `anchorNode` 落在会话区 prose 内：`closest('[data-slot="conversation.session"]')`
 *    命中，且选区**不在分栏右栏目标会话内**（选区所在 embedded 的
 *    `data-embedded-session` === 右栏 sessionId 时排除）。分栏未开时右栏
 *    sessionId 为 undefined，embedded 全部放行——主视图非 embedded，不受影响。
 *    这样分栏打开时选中左栏主会话片段仍可弹浮条询问右栏 chat（核心用例）。
 * 3. 选区不在按钮/链接上（`closest('a, button, [data-slot-error]')` 未命中）——
 *    不干扰 CodeCard 复制按钮、GridView 拖拽等既有交互。
 *
 * ## 隐藏条件
 *
 * - 选区折叠（`selectionchange`）。
 * - 滚动（`scroll`，capture，passive）。
 * - 点击他处（`mousedown` 且不在浮条上）。
 * - Escape 键。
 *
 * ## 手势冲突防护
 *
 * - 不 `preventDefault` / 不 `stopPropagation`：选中、复制、CodeCard 复制按钮、
 *   GridView 拖拽均不受干扰（AssistantProse onClickCapture 先例：只在 capture
 *   阶段读 target，不拦事件）。
 * - 浮条 portal 到 `document.body`，`z-index` 照 FloatingLayer 纪律（100 以下、
 *   pointer-events:auto 只在浮条本身）。
 *
 * ## 卸载清监听
 *
 * 所有 document/window 监听在 `useEffect` cleanup 中移除。
 *
 * @module corum-ui-conversation/client/SelectionAskPill
 */
import { useEffect, useState, useCallback, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CornerDownLeft, MessageSquare } from 'lucide-react'
import css from './ConversationRoot.module.css'

export interface SelectionAskPillProps {
  /** 「在侧边对话中提问」回调（apply.ts 注入；undefined 时不挂载浮条）。 */
  askAi?: ((quote: string) => void) | undefined
  /**
   * 「添加到对话」回调（apply.ts 注入；undefined 时不挂载浮条）。
   *
   * 接收选中片段文本，追加到当前主会话 composer 草稿末尾（现有草稿 + 换行 +
   * 选中文本）并 focus 输入框。
   */
  onAddToDraft?: ((quote: string) => void) | undefined
  /**
   * 分栏右栏目标 sessionId 的延迟读取（apply.ts 注入）。
   *
   * 浮条 scope 检查时调用：选区所在 embedded 的 `data-embedded-session`
   * === 此值时排除（不在右栏会话内弹浮条）。未开分栏时返回 undefined，
   * embedded 全部放行。`undefined`（能力不具备）等同未开分栏。
   */
  rightPaneSessionId?: (() => string | undefined) | undefined
}

/** 浮条 z-index：低于 FloatingLayer（100），高于普通内容。 */
const PILL_Z_INDEX = 90

/**
 * 判断选区是否在会话 prose 内。
 *
 * 分栏打开时，左栏主会话也是 embedded（`data-embedded-session`），
 * 故不能一刀切排除 embedded——仅排除分栏右栏目标会话本身的选区
 * （选区所在 embedded 的 `data-embedded-session` === 右栏 sessionId）。
 * 分栏未开时右栏 sessionId 为 undefined，embedded 全部放行（主视图非
 * embedded，不受影响）。
 *
 * @param anchor - 选区 anchorNode。
 * @param rightPaneSessionId - 分栏右栏目标 sessionId（未开分栏时 undefined）。
 * @returns 是否有效。
 */
function isSelectionInMainProse(anchor: Node | null, rightPaneSessionId: string | undefined): boolean {
  if (anchor === null) return false
  if (!(anchor instanceof Element)) {
    // Text 节点：取 parentElement
    const parent = anchor.parentNode
    if (parent === null || !(parent instanceof Element)) return false
    return checkElement(parent, rightPaneSessionId)
  }
  return checkElement(anchor, rightPaneSessionId)
}

function checkElement(el: Element, rightPaneSessionId: string | undefined): boolean {
  // 必须在会话槽内（含左栏 embedded 主会话）
  const sessionSlot = el.closest('[data-slot="conversation.session"]')
  if (sessionSlot === null) return false
  // 仅排除分栏右栏目标会话的选区：选区所在 embedded 的 sessionId
  // === 右栏目标 sessionId 时排除（避免在右栏会话里也弹浮条）
  const embedded = el.closest('[data-embedded-session]')
  if (embedded !== null) {
    const embeddedSid = embedded.getAttribute('data-embedded-session')
    if (embeddedSid !== null && embeddedSid === rightPaneSessionId) return false
  }
  // 不在按钮/链接上（不干扰 CodeCard 复制按钮等）
  const interactive = el.closest('a, button, [data-slot-error]')
  if (interactive !== null) return false
  return true
}

/**
 * 选中→双动作浮条。
 *
 * 挂载在 ConversationSession 内（有 askAi 或 onAddToDraft 时才渲染）。
 * document 级监听 mouseup / selectionchange / scroll / mousedown / keydown。
 *
 * @param props.askAi - 「在侧边对话中提问」回调。
 * @param props.onAddToDraft - 「添加到对话」回调。
 * @returns null（无浮条时）或 portal 到 body 的浮条。
 */
export function SelectionAskPill({ askAi, onAddToDraft, rightPaneSessionId }: SelectionAskPillProps): ReactNode {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  // ref 持有最新选中文本，供 keydown Enter / Escape handler 读。
  const selectedTextRef = useRef('')

  const hide = useCallback(() => { setVisible(false) }, [])

  const show = useCallback(() => {
    const selection = window.getSelection()
    if (selection === null) { setVisible(false); return }
    if (selection.isCollapsed || selection.rangeCount === 0) { setVisible(false); return }
    const text = selection.toString()
    if (text === '' || text.trim() === '') { setVisible(false); return }
    // anchorNode 判断选区是否在会话 prose 内（排除右栏目标会话）
    const rightSid = rightPaneSessionId?.()
    if (!isSelectionInMainProse(selection.anchorNode, rightSid)) { setVisible(false); return }
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) { setVisible(false); return }
    selectedTextRef.current = text
    // 浮条定位在选区下方（留 6px gap）
    const top = rect.bottom + 6
    // 水平居中于选区
    const left = rect.left + rect.width / 2
    setPosition({ top, left })
    setVisible(true)
  }, [rightPaneSessionId])

  useEffect(() => {
    // 两个回调都缺失时不挂监听（浮条无意义）。
    if (askAi === undefined && onAddToDraft === undefined) return
    // mouseup：用户松开鼠标后检查选区（主触发点）
    const onMouseUp = (): void => {
      // 延迟一拍让 selectionchange 先 settle（Chrome mouseup 后选区才更新）
      // rAF 在 document.hidden 窗口永不回调（verify 环境实测），setTimeout 更健壮；聚焦窗口两者时序等价
      setTimeout(show, 0)
    }
    // selectionchange：选区变化时重新评估（折叠时隐藏）
    const onSelectionChange = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) { hide(); return }
      // 非折叠但不满足条件也隐藏
      const rightSid = rightPaneSessionId?.()
      if (!isSelectionInMainProse(selection.anchorNode, rightSid)) { hide(); return }
    }
    // scroll：滚动即隐藏（选区位置已过时）
    const onScroll = (): void => { hide() }
    // mousedown：点他处隐藏（点浮条本身的 click 另处理）
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target
      if (target instanceof Element && target.closest(`.${css.askPill}`) !== null) return
      hide()
    }
    // keydown：Escape 关闭浮条；Enter 触发「添加到对话」（菜单可见时）
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!visible) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        hide()
      } else if (e.key === 'Enter' && onAddToDraft !== undefined) {
        e.stopPropagation()
        e.preventDefault()
        const text = selectedTextRef.current
        if (text !== '') {
          onAddToDraft(text)
        }
        window.getSelection()?.removeAllRanges()
        hide()
      }
    }

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [askAi, onAddToDraft, rightPaneSessionId, show, hide, visible])

  // 「添加到对话」：追加选中文本到主会话草稿 + focus 输入框。
  const onAddToDraftClick = useCallback((): void => {
    const text = selectedTextRef.current
    if (text !== '' && onAddToDraft !== undefined) {
      onAddToDraft(text)
    }
    window.getSelection()?.removeAllRanges()
    hide()
  }, [onAddToDraft, hide])

  // 「在侧边对话中提问」：调 askAi → 隐藏浮条 → 清选区
  const onAskAiClick = useCallback((): void => {
    const text = selectedTextRef.current
    if (text !== '' && askAi !== undefined) {
      askAi(text)
    }
    window.getSelection()?.removeAllRanges()
    hide()
  }, [askAi, hide])

  if ((askAi === undefined && onAddToDraft === undefined) || !visible) return null

  const style: CSSProperties = {
    position: 'fixed',
    top: `${position.top}px`,
    left: `${position.left}px`,
    transform: 'translateX(-50%)',
    zIndex: PILL_Z_INDEX,
  }

  return createPortal(
    <div
      className={css.askPill}
      style={style}
      onMouseDown={(e) => { e.stopPropagation() }}
    >
      {onAddToDraft !== undefined && (
        <button
          type="button"
          className={css.askPillAction}
          title="添加到对话"
          onClick={onAddToDraftClick}
        >
          <MessageSquare size={14} strokeWidth={2} />
          <span>添加到对话</span>
          <CornerDownLeft size={12} strokeWidth={2} className={css.askPillShortcut} />
        </button>
      )}
      {onAddToDraft !== undefined && askAi !== undefined && (
        <span className={css.askPillDivider} />
      )}
      {askAi !== undefined && (
        <button
          type="button"
          className={css.askPillAction}
          title="在侧边对话中提问"
          onClick={onAskAiClick}
        >
          <MessageSquare size={14} strokeWidth={2} />
          <span>在侧边对话中提问</span>
        </button>
      )}
    </div>,
    document.body,
  )
}
