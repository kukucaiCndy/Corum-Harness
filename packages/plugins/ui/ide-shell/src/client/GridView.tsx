/**
 * GridView —— 递归渲染布局树：分支（row/column split）按 weights 分配空间，
 * 相邻子节点间一条 sash（复用 VSCode Sash 拖拽机制）；叶子是模块窗格
 * （标题栏可拖 + 槽位内容）。拖标题到另一窗格四边 → split，中心 → 交换。
 *
 * 纯组件：树与回调经 props 传入，槽位内容经 renderSlot 解析。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { BranchNode, DropZone, GridNode, GridSlot, LeafNode } from './grid.ts'
import css from './GridView.module.css'

/** 每个叶子窗格的标题（槽位 → 显示名）。 */
const SLOT_TITLES: Record<GridSlot, string> = {
  'corum.sidebar': '会话列表',
  'conversation': '对话区',
  'corum.editor': '编辑器',
  'corum.explorer': '资源管理器',
  'corum.panel': '底部面板',
  'corum.statusBar': '状态栏',
}

/** GridView 的整体 props。 */
export interface GridViewProps {
  root: GridNode
  /** 槽位内容渲染（壳的 renderSlot）。 */
  renderSlot: (slot: GridSlot) => ReactNode
  /** sash 拖拽：branchId + 子节点下标 + 份额 delta。 */
  onResize: (branchId: string, sashIndex: number, deltaFraction: number) => void
  /** 拖放：source leaf id → target leaf id 的 zone。 */
  onDrop: (sourceId: string, targetId: string, zone: DropZone) => void
  /** 脱出某槽位到浮动窗（可选）。 */
  onPopOut?: (slot: GridSlot) => void
  /** 已脱出到浮动窗的槽位集合——这些 leaf 显示「已脱出」占位而非内容。 */
  detachedSlots?: ReadonlySet<string>
}

/** 一条 sash（沿用 AppFrame 验证过的 VSCode 机制）。 */
function Sash(props: { direction: 'row' | 'column'; onDrag: (delta: number) => void }) {
  const vertical = props.direction === 'row' // row 分支的 sash 是竖条（拖左右）
  const origin = useRef(0)
  const cbRef = useRef(props.onDrag)
  cbRef.current = props.onDrag

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    origin.current = vertical ? e.clientX : e.clientY
    const cursor = vertical ? 'col-resize' : 'row-resize'
    const style = document.createElement('style')
    style.textContent = `* { cursor: ${cursor} !important; user-select: none !important; -webkit-user-select: none !important; }`
    document.head.appendChild(style)
    const onMove = (ev: MouseEvent) => {
      ev.preventDefault()
      cbRef.current((vertical ? ev.clientX : ev.clientY) - origin.current)
      origin.current = vertical ? ev.clientX : ev.clientY
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      style.remove()
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
  }, [vertical])

  return <div className={vertical ? css.sashV : css.sashH} onMouseDown={onMouseDown} data-sash={props.direction} />
}

/** 一个叶子窗格：标题栏（可拖）+ 槽位内容 + drop 高亮。 */
function LeafView(props: {
  leaf: LeafNode
  renderSlot: (slot: GridSlot) => ReactNode
  onDrop: GridViewProps['onDrop']
  onPopOut?: GridViewProps['onPopOut']
  detachedSlots?: ReadonlySet<string> | undefined
}) {
  const { leaf, renderSlot, onDrop, onPopOut, detachedSlots } = props
  const isDetached = detachedSlots?.has(leaf.slot) ?? false
  const [zone, setZone] = useState<DropZone | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  const zoneFromPoint = (clientX: number, clientY: number): DropZone => {
    const el = ref.current
    if (el === null) return 'center'
    const r = el.getBoundingClientRect()
    const fx = (clientX - r.left) / r.width
    const fy = (clientY - r.top) / r.height
    const EDGE = 0.25
    if (fx < EDGE) return 'left'
    if (fx > 1 - EDGE) return 'right'
    if (fy < EDGE) return 'top'
    if (fy > 1 - EDGE) return 'bottom'
    return 'center'
  }

  return (
    <div
      ref={ref}
      className={css.leaf}
      data-slot={leaf.slot}
      data-drop-zone={zone ?? undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('corum/leaf-id')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setZone(zoneFromPoint(e.clientX, e.clientY))
      }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        const sourceId = e.dataTransfer.getData('corum/leaf-id')
        setZone(null)
        if (sourceId === '') return
        e.preventDefault()
        onDrop(sourceId, leaf.id, zoneFromPoint(e.clientX, e.clientY))
      }}
    >
      <div
        className={css.leafTitle}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('corum/leaf-id', leaf.id)
          e.dataTransfer.effectAllowed = 'move'
          // 拖出主窗口外 → 该区域直接脱出为独立浮动窗。document 的 dragend
          // 在窗口外释放时也会触发；若释放点已离开窗口可视区（坐标越界），
          // 视为「拖到 APP 外」，触发脱出而非网格内拆分。
          const onDragEnd = (ev: DragEvent) => {
            document.removeEventListener('dragend', onDragEnd, true)
            const outX = ev.clientX <= 0 || ev.clientX >= window.innerWidth
            const outY = ev.clientY <= 0 || ev.clientY >= window.innerHeight
            if ((outX || outY) && onPopOut) onPopOut(leaf.slot)
          }
          document.addEventListener('dragend', onDragEnd, true)
        }}
        title="拖到另一窗格的上/下/左/右拆分，拖到中心交换；拖出窗口外脱出为浮动窗"
      >
        <span className={css.leafGrip} aria-hidden="true">⠿</span>
        <span className={css.leafName}>{SLOT_TITLES[leaf.slot]}</span>
        <span className={css.leafSlot}>{leaf.slot}</span>
        {onPopOut && (
          <button
            type="button"
            className={css.leafPopOut}
            onClick={() => onPopOut(leaf.slot)}
            title="脱出为独立浮动窗口"
          >
            ⇱
          </button>
        )}
      </div>
      <div className={css.leafBody}>
        {isDetached
          ? (
            <div className={css.detachedPlaceholder}>
              <span className={css.detachedIcon}>⇱</span>
              <span>已脱出到浮动窗</span>
              <span className={css.detachedHint}>拖回主窗口或关闭浮动窗即恢复</span>
            </div>
          )
          : renderSlot(leaf.slot)}
      </div>
      {zone !== null && <div className={css.dropHint} data-zone={zone} aria-hidden="true" />}
    </div>
  )
}

/** 递归渲染一个节点。 */
function NodeView(props: GridViewProps & { node: GridNode }) {
  const { node, ...rest } = props
  if (node.type === 'leaf') {
    return <LeafView leaf={node} renderSlot={rest.renderSlot} onDrop={rest.onDrop} onPopOut={rest.onPopOut} detachedSlots={rest.detachedSlots} />
  }
  return <BranchView branch={node} {...rest} />
}

/** 渲染一个分支：children 按 weights（像素份额）用 flexBasis 分配，相邻间一条 sash。
 *  关键：cell 用 flexBasis:<weight>px + flexGrow:0 + flexShrink:0（不是 flexGrow
 *  比例），这样拖一条 sash 只在相邻两格间转移像素，其它格的像素严格不变——
 *  flex 比例布局会在 min-width 约束/总份额变化时把影响传导到非相邻格，正是
 *  「拖一条缝、远处列也变」的根因。weights 即像素，sash 拖动直接转移 px。 */
function BranchView(props: Omit<GridViewProps, 'root'> & { branch: BranchNode }) {
  const { branch, ...rest } = props
  const containerRef = useRef<HTMLDivElement | null>(null)

  // sash 拖动：把 px delta 直接当像素转移（weights 就是像素），交给上层改树。
  const makeSashDrag = (sashIndex: number) => (pxDelta: number) => {
    rest.onResize(branch.id, sashIndex, pxDelta)
  }

  const cells: ReactNode[] = []
  branch.children.forEach((child, i) => {
    if (i > 0) {
      cells.push(<Sash key={`sash-${i}`} direction={branch.direction} onDrag={makeSashDrag(i - 1)} />)
    }
    const weight = branch.weights[i] ?? 1
    cells.push(
      <div
        key={child.id}
        className={css.branchCell}
        style={{ flexBasis: `${weight}px`, flexGrow: 0, flexShrink: 0 }}
      >
        <NodeView {...rest} root={child} node={child} />
      </div>,
    )
  })

  return (
    <div
      ref={containerRef}
      className={branch.direction === 'row' ? css.branchRow : css.branchColumn}
      data-branch={branch.id}
      data-direction={branch.direction}
    >
      {cells}
    </div>
  )
}

/** 顶层 GridView：网格 + 浮动窗拖回的实时插入预览。 */
export function GridView(props: GridViewProps) {
  const gridRef = useRef<HTMLDivElement | null>(null)
  // 浮动窗拖回预览：{x, y} 相对网格左上角；dragging=false 时清除。
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const bridge = (window as unknown as { corumDesktop?: { onFloatingDrag?: (cb: (p: { dragging: boolean; x?: number; y?: number }) => void) => () => void } }).corumDesktop
    if (bridge?.onFloatingDrag === undefined) return
    return bridge.onFloatingDrag((p) => {
      const grid = gridRef.current
      if (grid === null) return
      if (!p.dragging || p.x === undefined || p.y === undefined) {
        setPreview(null)
        return
      }
      // p.x/p.y 是相对主窗口左上角的屏幕坐标；换算成相对网格的坐标。
      const r = grid.getBoundingClientRect()
      setPreview({ x: p.x - r.left, y: p.y - r.top })
    })
  }, [])

  // 命中的窗格 + zone：从预览坐标向下找 leaf，再按相对位置判 zone。
  const previewTarget = preview === null ? null : (() => {
    const grid = gridRef.current
    if (grid === null) return null
    const r = grid.getBoundingClientRect()
    const el = document.elementFromPoint(r.left + preview.x, r.top + preview.y)
    const leafEl = el?.closest('[data-slot][class*="leaf"]') as HTMLElement | null
    if (leafEl == null) return null
    const lr = leafEl.getBoundingClientRect()
    const fx = (r.left + preview.x - lr.left) / lr.width
    const fy = (r.top + preview.y - lr.top) / lr.height
    const EDGE = 0.25
    const zone = fx < EDGE ? 'left' : fx > 1 - EDGE ? 'right' : fy < EDGE ? 'top' : fy > 1 - EDGE ? 'bottom' : 'center'
    // 预览块的几何：zone 覆盖 leaf 的一半，center 覆盖全部（相对网格坐标）。
    let rect: { left: number; top: number; width: number; height: number }
    const relLeft = lr.left - r.left
    const relTop = lr.top - r.top
    if (zone === 'left') rect = { left: relLeft, top: relTop, width: lr.width / 2, height: lr.height }
    else if (zone === 'right') rect = { left: relLeft + lr.width / 2, top: relTop, width: lr.width / 2, height: lr.height }
    else if (zone === 'top') rect = { left: relLeft, top: relTop, width: lr.width, height: lr.height / 2 }
    else if (zone === 'bottom') rect = { left: relLeft, top: relTop + lr.height / 2, width: lr.width, height: lr.height / 2 }
    else rect = { left: relLeft, top: relTop, width: lr.width, height: lr.height }
    return { rect, zone }
  })()

  return (
    <div className={css.grid} ref={gridRef} style={{ position: 'relative' }}>
      <NodeView {...props} node={props.root} />
      {previewTarget !== null && (
        <div
          className={css.dockPreview}
          data-zone={previewTarget.zone}
          style={{
            left: previewTarget.rect.left,
            top: previewTarget.rect.top,
            width: previewTarget.rect.width,
            height: previewTarget.rect.height,
          }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
