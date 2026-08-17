/**
 * GridView —— 递归渲染布局树：分支（row/column split）按 weights 分配空间，
 * 相邻子节点间一条 sash（复用 VSCode Sash 拖拽机制）；叶子是模块窗格
 * （标题栏可拖 + 槽位内容）。拖标题到另一窗格四边 → split，中心 → 交换。
 *
 * 纯组件：树与回调经 props 传入，槽位内容经 renderSlot 解析。
 */
import { useCallback, useRef, useState } from 'react'
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
}) {
  const { leaf, renderSlot, onDrop, onPopOut } = props
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
        }}
        title="拖到另一窗格的上/下/左/右拆分，拖到中心交换"
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
        {renderSlot(leaf.slot)}
      </div>
      {zone !== null && <div className={css.dropHint} data-zone={zone} aria-hidden="true" />}
    </div>
  )
}

/** 递归渲染一个节点。 */
function NodeView(props: GridViewProps & { node: GridNode }) {
  const { node, ...rest } = props
  if (node.type === 'leaf') {
    return <LeafView leaf={node} renderSlot={rest.renderSlot} onDrop={rest.onDrop} onPopOut={rest.onPopOut} />
  }
  return <BranchView branch={node} {...rest} />
}

/** 渲染一个分支：children 按 weights 用 flex 分配，相邻间一条 sash。 */
function BranchView(props: Omit<GridViewProps, 'root'> & { branch: BranchNode }) {
  const { branch, ...rest } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const total = branch.weights.reduce((a, b) => a + b, 0)

  // sash 拖动：把 px delta 换算成份额 delta，交给上层改树。
  const makeSashDrag = (sashIndex: number) => (pxDelta: number) => {
    const el = containerRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const span = branch.direction === 'row' ? rect.width : rect.height
    if (span <= 0) return
    const fractionDelta = (pxDelta / span) * total
    rest.onResize(branch.id, sashIndex, fractionDelta)
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
        style={{ flexGrow: weight, flexBasis: 0 }}
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

/** 顶层 GridView。 */
export function GridView(props: GridViewProps) {
  return (
    <div className={css.grid}>
      <NodeView {...props} node={props.root} />
    </div>
  )
}
