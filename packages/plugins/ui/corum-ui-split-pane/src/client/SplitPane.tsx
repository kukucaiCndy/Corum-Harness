/**
 * SplitPane —— 通用左右分栏容器（可拖拽中缝 + 比例持久化 + 两栏独立滚动）。
 *
 * 设计参照 `@corum/corum-ui-base/src/client/GridView.tsx:59` 的 Sash 机制：
 * 中缝 mousedown 后在 **window 级** 注册 mousemove/mouseup（capture 阶段），
 * 全局拦截指针事件，松开后摘除。纯鼠标数学、无平台分叉（红线 7）。
 *
 * 比例 clamp 在 0.2–0.8 之间，防止任一栏被压到不可见。`storageKey` 时把比例
 * 写入 localStorage 键 `corum.splitpane.<storageKey>`，读时校验非法值回落
 * defaultRatio。样式全用仓内 design token（--corum-* / --dsw-alias-*），禁硬编码。
 *
 * @module corum-ui-split-pane/client/SplitPane
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import css from './SplitPane.module.css'

/** SplitPane 的 props。 */
export interface SplitPaneProps {
  /** 左栏内容。 */
  left: ReactNode
  /** 右栏内容。 */
  right: ReactNode
  /** 初始比例（左栏占总宽的份额，0–1），缺省 0.5。 */
  defaultRatio?: number
  /** 比例变化回调（拖拽松手时触发）。 */
  onRatioChange?: (ratio: number) => void
  /**
   * 比例持久化 key。给出时把比例写入 localStorage 键
   * `corum.splitpane.<storageKey>`，读时校验非法值回落 defaultRatio。
   */
  storageKey?: string
}

/** 比例上下限（防止任一栏被压到不可见）。 */
const RATIO_MIN = 0.2
const RATIO_MAX = 0.8

/** 把比例 clamp 到合法区间。 */
function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r))
}

/** 读取持久化比例；非法值（NaN / 超界 / 缺失）回落 defaultRatio。 */
function readStoredRatio(storageKey: string | undefined, defaultRatio: number): number {
  if (storageKey === undefined) return clampRatio(defaultRatio)
  try {
    const raw = localStorage.getItem(`corum.splitpane.${storageKey}`)
    if (raw === null) return clampRatio(defaultRatio)
    const parsed = Number(raw)
    // NaN 或超界都回落，不信任任何非法存量。
    if (!Number.isFinite(parsed) || parsed < RATIO_MIN || parsed > RATIO_MAX) {
      return clampRatio(defaultRatio)
    }
    return parsed
  } catch {
    // localStorage 不可用（隐私模式 / SSR）——回落默认值。
    return clampRatio(defaultRatio)
  }
}

/** 写入持久化比例（静默失败：隐私模式 / 配额满都不影响拖拽本身）。 */
function writeStoredRatio(storageKey: string | undefined, ratio: number): void {
  if (storageKey === undefined) return
  try {
    localStorage.setItem(`corum.splitpane.${storageKey}`, String(ratio))
  } catch {
    /* 静默——持久化是锦上添花，不阻断功能。 */
  }
}

/**
 * 渲染一个左右分栏容器，中缝可拖拽调比例。
 *
 * @param props - 见 {@link SplitPaneProps}。
 * @returns 分栏容器元素。
 */
export function SplitPane(props: SplitPaneProps): ReactNode {
  const { left, right, defaultRatio = 0.5, onRatioChange, storageKey } = props
  const [ratio, setRatio] = useState<number>(() => readStoredRatio(storageKey, defaultRatio))
  const containerRef = useRef<HTMLDivElement | null>(null)
  /** 拖拽过程中的最新比例（用 ref 避免 mousemove 闭包拿到 stale state）。 */
  const ratioRef = useRef(ratio)
  ratioRef.current = ratio
  /** onRatioChange 回调也走 ref（避免每次渲染重新注册 window listener）。 */
  const onRatioChangeRef = useRef(onRatioChange)
  onRatioChangeRef.current = onRatioChange
  /** storageKey 走 ref（拖拽松手时取最新值写持久化）。 */
  const storageKeyRef = useRef(storageKey)
  storageKeyRef.current = storageKey

  // 持久化比例变化时同步写盘（初始化读出来的也写一次，确保键存在且合法）。
  useLayoutEffect(() => {
    writeStoredRatio(storageKey, ratio)
  }, [ratio, storageKey])

  /** 中缝拖拽：mousedown 后在 window 级捕获 mousemove/mouseup。 */
  const onSashMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const container = containerRef.current
    if (container === null) return
    const rect = container.getBoundingClientRect()
    const width = rect.width
    if (width <= 0) return

    // 全局 cursor 样式（拖拽中禁止文本选中 + 显示 col-resize）。
    const style = document.createElement('style')
    style.textContent = `* { cursor: col-resize !important; user-select: none !important; -webkit-user-select: none !important; }`
    document.head.appendChild(style)

    const onMove = (ev: MouseEvent): void => {
      ev.preventDefault()
      const x = ev.clientX - rect.left
      const next = clampRatio(x / width)
      ratioRef.current = next
      setRatio(next)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      style.remove()
      // 松手时触发回调 + 写持久化（用 ref 取拖拽终态值）。
      onRatioChangeRef.current?.(ratioRef.current)
      writeStoredRatio(storageKeyRef.current, ratioRef.current)
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
  }, [])

  // storageKey 变化时重新读盘（罕见场景：同组件复用于不同 key）。
  useEffect(() => {
    if (storageKey === undefined) return
    setRatio(readStoredRatio(storageKey, defaultRatio))
    // defaultRatio 变化也触发重读（但 storageKey 优先，有存量就用存量）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  const leftWidthPct = `${(ratio * 100).toFixed(4)}%`

  return (
    <div ref={containerRef} className={css.container}>
      <div className={css.leftPane} style={{ width: leftWidthPct }}>
        {left}
      </div>
      <div className={css.sash} onMouseDown={onSashMouseDown} role="separator" aria-orientation="vertical" />
      <div className={css.rightPane}>
        {right}
      </div>
    </div>
  )
}
