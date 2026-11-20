/**
 * fork（corum, 2026-11-22）：选中→询问 AI 浮条。
 *
 * 用户在主会话区 prose 内选中文本后，在选区上方显示「询问 AI」小浮条。
 * 点击浮条 → 引用选中片段到咨询会话的草稿（经 askAi 回调）。
 *
 * ## 触发条件（全部满足才显示）
 *
 * 1. 选区非折叠（`selection.isCollapsed === false`）。
 * 2. `anchorNode` 落在主会话区 prose 内：`closest('[data-slot="conversation.session"]')`
 *    命中，且**不在** `[data-embedded-session]` 右栏内（排除分栏右栏的选区）。
 * 3. 选区不在按钮/链接上（`closest('a, button, [data-slot-error]')` 未命中）——
 *    不干扰 CodeCard 复制按钮、GridView 拖拽等既有交互。
 *
 * ## 隐藏条件
 *
 * - 选区折叠（`selectionchange`）。
 * - 滚动（`scroll`，capture，passive）。
 * - 点击他处（`mousedown` 且不在浮条上）。
 * - 点击浮条本身（调 askAi 后）。
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
import { useEffect, useState, useCallback, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircle } from 'lucide-react'
import css from './ConversationRoot.module.css'

export interface SelectionAskPillProps {
  /** 「选中→询问 AI」回调（apply.ts 注入；undefined 时不挂载浮条）。 */
  askAi?: ((quote: string) => void) | undefined
}

/** 浮条 z-index：低于 FloatingLayer（100），高于普通内容。 */
const PILL_Z_INDEX = 90

/**
 * 判断选区是否在主会话区 prose 内（不在右栏 embedded session）。
 *
 * @param anchor - 选区 anchorNode。
 * @returns 是否有效。
 */
function isSelectionInMainProse(anchor: Node | null): boolean {
  if (anchor === null) return false
  if (!(anchor instanceof Element)) {
    // Text 节点：取 parentElement
    const parent = anchor.parentNode
    if (parent === null || !(parent instanceof Element)) return false
    return checkElement(parent)
  }
  return checkElement(anchor)
}

function checkElement(el: Element): boolean {
  // 必须在主会话区内
  const sessionSlot = el.closest('[data-slot="conversation.session"]')
  if (sessionSlot === null) return false
  // 不在右栏 embedded session 内（排除分栏右栏的同名 slot）
  const embedded = el.closest('[data-embedded-session]')
  if (embedded !== null) return false
  // 不在按钮/链接上（不干扰 CodeCard 复制按钮等）
  const interactive = el.closest('a, button, [data-slot-error]')
  if (interactive !== null) return false
  return true
}

/**
 * 选中→询问 AI 浮条。
 *
 * 挂载在 ConversationSession 内（有 sessionId + askAi 时才渲染）。
 * document 级监听 mouseup / selectionchange / scroll / mousedown。
 *
 * @param props.askAi - 询问 AI 回调。
 * @returns null（无浮条时）或 portal 到 body 的浮条。
 */
export function SelectionAskPill({ askAi }: SelectionAskPillProps): ReactNode {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  const hide = useCallback(() => { setVisible(false) }, [])

  const show = useCallback(() => {
    const selection = window.getSelection()
    if (selection === null) { setVisible(false); return }
    if (selection.isCollapsed || selection.rangeCount === 0) { setVisible(false); return }
    const text = selection.toString()
    if (text === '' || text.trim() === '') { setVisible(false); return }
    // anchorNode 判断选区是否在主会话区 prose 内
    if (!isSelectionInMainProse(selection.anchorNode)) { setVisible(false); return }
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) { setVisible(false); return }
    // 浮条定位在选区上方（留 6px gap）
    const top = rect.top - 6
    // 水平居中于选区
    const left = rect.left + rect.width / 2
    setPosition({ top, left })
    setVisible(true)
  }, [])

  useEffect(() => {
    if (askAi === undefined) return
    // mouseup：用户松开鼠标后检查选区（主触发点）
    const onMouseUp = (): void => {
      // 延迟一帧让 selectionchange 先 settle（Chrome mouseup 后选区才更新）
      requestAnimationFrame(show)
    }
    // selectionchange：选区变化时重新评估（折叠时隐藏）
    const onSelectionChange = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) { hide(); return }
      // 非折叠但不满足条件也隐藏
      if (!isSelectionInMainProse(selection.anchorNode)) { hide(); return }
    }
    // scroll：滚动即隐藏（选区位置已过时）
    const onScroll = (): void => { hide() }
    // mousedown：点他处隐藏（点浮条本身的 click 另处理）
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target
      if (target instanceof Element && target.closest(`.${css.askPill}`) !== null) return
      hide()
    }

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [askAi, show, hide])

  // 点击浮条：调 askAi → 隐藏浮条 → 清选区
  const onPillClick = useCallback((): void => {
    const selection = window.getSelection()
    const text = selection?.toString() ?? ''
    if (text !== '' && askAi !== undefined) {
      askAi(text)
    }
    // 清选区 + 隐藏浮条
    selection?.removeAllRanges()
    hide()
  }, [askAi, hide])

  if (askAi === undefined || !visible) return null

  const style: CSSProperties = {
    position: 'fixed',
    top: `${position.top}px`,
    left: `${position.left}px`,
    transform: 'translate(-50%, -100%)',
    zIndex: PILL_Z_INDEX,
  }

  return createPortal(
    <button
      type="button"
      className={css.askPill}
      style={style}
      title="询问 AI"
      onMouseDown={(e) => { e.stopPropagation() }}
      onClick={onPillClick}
    >
      <MessageCircle size={14} strokeWidth={2} />
      <span>询问 AI</span>
    </button>,
    document.body,
  )
}
