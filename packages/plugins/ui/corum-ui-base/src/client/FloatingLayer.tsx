/**
 * FloatingLayer —— 通用悬浮层（shell-base）。
 *
 * 与 shell.overlay（帧内浮层，受 frame 的 transform/overflow 约束）不同，
 * FloatingLayer 经 createPortal 挂到 document.body，彻底脱离网格/卡片的
 * 合成层与裁剪上下文，是全应用级模态/悬浮的唯一合法出口：
 *   - 设置面板（官方 ui-settings-general，面板在窗格 DOM 内，需迁移上来）
 *   - 未来的应用内通知、对话框、确认框等
 *
 * 两条使用路径：
 *   1. 注册式（自建内容）：openFloating({ id, content, modal }) ——
 *      内容以 React 元素注册，层内渲染；closeFloating(id) 关闭。
 *   2. 迁移式（第三方/官方组件，组件树不能重建）：floatingLayerHost(el)
 *      拿到容器，把已渲染的 DOM 子树 appendChild 进来，关闭时移回原位。
 *      DOM 移动不触发 React 重建，组件内部 state（如 open）保留。
 *
 * 多个悬浮项按打开顺序堆叠；modal 项带遮罩（点击遮罩关闭该项），
 * 非 modal 项（如通知）不挡下层交互。Escape 关闭最顶层 modal 项。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './FloatingLayer.module.css'

/** 一个悬浮项。 */
export interface FloatingItem {
  /** 唯一 id（重复 open 同 id = 替换内容并置顶）。 */
  id: string
  /** 悬浮内容（注册式）。 */
  content: ReactNode
  /** 是否模态（带遮罩、挡下层交互、Escape/点遮罩关闭）。默认 true。 */
  modal?: boolean
  /** 关闭回调（点遮罩 / Escape / closeFloating 触发）。 */
  onClose?: (() => void) | undefined
}

/** 悬浮层对外面：注册/关闭。 */
export interface FloatingLayerApi {
  openFloating: (item: FloatingItem) => void
  closeFloating: (id: string) => void
}

const FloatingContext = createContext<FloatingLayerApi | null>(null)

/** 在 FloatingLayer 子树内取悬浮层 API（未挂载时返回 null）。 */
export function useFloatingLayer(): FloatingLayerApi | null {
  return useContext(FloatingContext)
}

/**
 * 迁移式使用的宿主容器：全局唯一（应用只挂一个 FloatingLayer）。
 * FloatingLayer 挂载后把容器 DOM 记录到这里，供「把官方组件渲染出的
 * DOM 子树移上来」的场景取用（不经过 React，组件状态不丢）。
 */
let hostElement: HTMLDivElement | null = null

/** 取悬浮层容器（FloatingLayer 已挂载时非 null）。 */
export function floatingLayerHost(): HTMLDivElement | null {
  return hostElement
}

/** 通用悬浮层。挂在壳的 frame 根（应用唯一）。 */
export function FloatingLayer(props: { children?: ReactNode }) {
  const [items, setItems] = useState<readonly FloatingItem[]>([])
  const hostRef = useRef<HTMLDivElement | null>(null)

  const closeFloating = useCallback((id: string) => {
    setItems((prev) => {
      const item = prev.find((i) => i.id === id)
      item?.onClose?.()
      return prev.filter((i) => i.id !== id)
    })
  }, [])

  const openFloating = useCallback((item: FloatingItem) => {
    setItems((prev) => [...prev.filter((i) => i.id !== item.id), item])
  }, [])

  // 记录全局宿主容器（迁移式场景用）。
  useEffect(() => {
    hostElement = hostRef.current
    return () => { hostElement = null }
  }, [])

  // Escape 关闭最顶层 modal 项。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setItems((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].modal !== false) {
            prev[i].onClose?.()
            return [...prev.slice(0, i), ...prev.slice(i + 1)]
          }
        }
        return prev
      })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <FloatingContext.Provider value={{ openFloating, closeFloating }}>
      {props.children}
      {createPortal(
        <div ref={hostRef} className={css.host} data-floating-layer>
          {items.map((item) => (
            <div key={item.id} className={css.item} data-modal={item.modal !== false || undefined}>
              {item.modal !== false && (
                <div className={css.mask} aria-hidden="true" onClick={() => closeFloating(item.id)} />
              )}
              <div className={css.body}>{item.content}</div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </FloatingContext.Provider>
  )
}
