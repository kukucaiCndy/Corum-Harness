/**
 * GridView —— 递归渲染布局树：分支（row/column split）按 weights 分配空间，
 * 相邻子节点间一条 sash（复用 VSCode Sash 拖拽机制）；叶子是模块窗格
 * （标题栏可拖 + 槽位内容）。拖标题到另一窗格四边 → split，中心 → 交换。
 *
 * 纯组件：树与回调经 props 传入，槽位内容经 renderSlot 解析。
 */
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { BranchNode, DropZone, GridNode, GridSlot, LeafNode } from './grid.ts'
import { subtreeMinSize, isPinnedSlot, slotCollapsedWidth, nodeAllHidden } from './grid.ts'
import { RegionCard, INTERACTIVE_SELECTOR } from './RegionCard.tsx'
import css from './GridView.module.css'

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
  /** 关闭某槽位（不显示，可在状态栏恢复）。 */
  onClose?: (slot: GridSlot) => void
  /** 从面板拖入新槽位到 target leaf 的某侧。 */
  onDropNewSlot?: (slot: GridSlot, targetId: string, zone: DropZone) => void
  /** 已脱出到浮动窗的槽位集合——运行时折叠（树不动）。 */
  detachedSlots?: ReadonlySet<string>
  /** 透明整卡的槽位（子卡独立、间隙透出背景，不垫外层玻璃卡）。由子壳按设计注入。 */
  transparentSlots?: ReadonlySet<string>
  /** 顶层 row 分支各格内容顶部下移像素（design.pen：titlebar-row 只压左列，
   *  sidebar/conversation 格内容让位标题栏，right-col 格顶到容器顶）。
   *  沿主轴按 child 下标取数（root row 的格序固定）。 */
  leafTopOffset?: readonly number[]
  /**
   * 折叠收起的槽位集合（如 IDE 侧栏收成 56px 图标轨）：这些 leaf 渲染为各自
   *  SlotMeta.collapsedWidth 的固定宽（不参与 weight 分配、两侧 sash 隐藏不可
   *  拖），不再是 detached 的 0 宽。与 grid.ts 的 setSlotCollapsed 同步——
   *  subtreeMinSize 在折叠态取 collapsedWidth，窗口自适应不会拉回展开宽。
   */
  collapsedSlots?: ReadonlySet<string>
}

/** 每格主轴最小尺寸来自各子树的 subtreeMinSize（grid.ts 注册表 + 兜底），本文件不再持有硬编码常量。 */

/** 一条 sash（沿用 AppFrame 验证过的 VSCode 机制）；ref 透传给分支布局写位置。 */
const Sash = forwardRef<HTMLDivElement, { direction: 'row' | 'column'; onDrag: (delta: number) => void }>(function Sash(props, ref) {
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

  return <div ref={ref} className={vertical ? css.sashV : css.sashH} onMouseDown={onMouseDown} data-sash={props.direction} />
})

/** 一个叶子窗格：标准区域卡片（RegionCard 基座）+ grid 拖放高亮。 */
function LeafView(props: {
  leaf: LeafNode
  renderSlot: (slot: GridSlot) => ReactNode
  onDrop: GridViewProps['onDrop']
  onPopOut?: GridViewProps['onPopOut']
  onDropNewSlot?: GridViewProps['onDropNewSlot']
  transparentSlots?: ReadonlySet<string> | undefined
}) {
  const { leaf, renderSlot, onDrop, onPopOut, onDropNewSlot, transparentSlots } = props
  // 钉住的 leaf（如 IDE 侧栏）不参与自由组合：不作拖拽源（不可拖走/脱出）、
  // 不响应 dragover/drop（不可被拖入 split/swap）。
  const pinned = isPinnedSlot(leaf.slot)
  const [zone, setZone] = useState<DropZone | null>(null)
  /** 当前叶子是否为拖拽源：拖拽源自身不响应 dragover（落到自己是 no-op，不该高亮）。 */
  const [sourceDragging, setSourceDragging] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  /** 当前拖拽的 ghost 克隆移除句柄（dragstart 设置，dragend 清理——所有结束路径）。 */
  const ghostCleanupRef = useRef<(() => void) | null>(null)

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

  // 接受两种 drag 类型：已有窗格拖拽（corum/leaf-id）和面板新槽位拖入（corum/new-slot）
  const hasDropType = (types: readonly string[]) => types.includes('corum/leaf-id') || types.includes('corum/new-slot')

  // 网格内重排 + 拖出浮动窗的统一拖拽源：整叶 draggable（设计稿无区域标题栏）。
  // 让位只排除「明确交互控件 + 已选中文字」，其余区域按下拖动即发起
  // corum/leaf-id：窗口内释放 → 网格内 split/swap；拖出窗口外 → 浮动窗。
  const onLeafDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    // 钉住的 leaf 不作拖拽源（位置固定，不可拖走/脱出浮动窗）。
    if (pinned) { e.preventDefault(); return }
    const target = e.target as HTMLElement
    // 让位：交互控件（按钮/输入/Monaco/图片等）上的按下不触发整叶拖拽。
    // 注意 INTERACTIVE_SELECTOR 不能含 [draggable="true"]，否则会命中整叶根
    // 自身，导致每次 dragstart 都被 preventDefault、整叶永远拖不动。
    if (target.closest(INTERACTIVE_SELECTOR)) { e.preventDefault(); return }
    const selection = window.getSelection()
    if (selection !== null && !selection.isCollapsed) { e.preventDefault(); return }
    e.dataTransfer.setData('corum/leaf-id', leaf.id)
    e.dataTransfer.effectAllowed = 'move'
    setSourceDragging(true)
    // 显式 drag image（2026-08-30 两回归修复终版）：leaf 的 will-change:transform
    // 独立合成层 + 0.1.2 会话区换肤的 backdrop-filter 玻璃层组合下，Chromium 的
    // 「整页 native ghost 快照」行为分裂——空态拍出整页（把导航/编辑器/终端等相邻
    // 区域都带进 ghost = 「拖动带动相邻区域」回归）、非空态（消息流玻璃卡渲染后）
    // 直接放弃快照（无 ghost）。因此不做整页快照：克隆 leaf 为「只含本区域、剥离
    // backdrop-filter 的静态快照」作 drag image——空/非空都有 ghost，且只含被拖
    // 区域（leaf 自身 overflow:hidden 裁掉 Monaco 虚拟画布等超大内容）。
    const sourceEl = e.currentTarget
    const rect = sourceEl.getBoundingClientRect()
    const ghost = sourceEl.cloneNode(true) as HTMLElement
    ghost.setAttribute('data-drag-ghost', '')
    ghost.style.width = `${rect.width}px`
    ghost.style.height = `${rect.height}px`
    ghost.style.position = 'fixed'
    ghost.style.left = '0'
    // 移出视口（负 top），仍可被 Chromium 快照（在文档内、visibility:visible、
    // 非 display:none），但不占任何屏幕像素——挂 documentElement 避免压进页面
    // 堆叠（z-index:-1 在含背景/transform 的祖先下压不住，曾致克隆残留在左上角
    // 导航栏下方可见）。
    ghost.style.top = `${-Math.ceil(rect.height) - 100}px`
    ghost.style.margin = '0'
    ghost.style.pointerEvents = 'none'
    document.documentElement.appendChild(ghost)
    e.dataTransfer.setDragImage(
      ghost,
      Math.round(e.clientX - rect.left),
      Math.round(e.clientY - rect.top),
    )
    // 克隆移除统一收进 onLeafDragEnd（React dragend——所有拖拽结束路径都走：
    // 窗口内 drop / 窗口外释放 / Esc 取消）；此闭包只保留「窗口外释放 → 脱出」。
    ghostCleanupRef.current = () => ghost.remove()
    // 拖出主窗口外 → 该区域脱出为独立浮动窗。document 的 dragend 在窗口外释放
    // 时也触发；释放点坐标越界（离开窗口可视区）视为「拖到 APP 外」，触发脱出
    // 而非网格内拆分。网格内释放则走各 leaf 的 onDrop（split / swap）。
    const onDragEndDoc = (ev: DragEvent) => {
      document.removeEventListener('dragend', onDragEndDoc, true)
      const outX = ev.clientX <= 0 || ev.clientX >= window.innerWidth
      const outY = ev.clientY <= 0 || ev.clientY >= window.innerHeight
      if ((outX || outY) && onPopOut) onPopOut(leaf.slot)
    }
    document.addEventListener('dragend', onDragEndDoc, true)
  }
  const onLeafDragEnd = (): void => {
    ghostCleanupRef.current?.()
    ghostCleanupRef.current = null
    setSourceDragging(false)
    setZone(null)
  }

  return (
    <div
      ref={ref}
      className={css.leaf}
      data-slot={leaf.slot}
      data-drop-zone={zone ?? undefined}
      data-pinned={pinned || undefined}
      draggable={!pinned}
      onDragStart={onLeafDragStart}
      onDragEnd={onLeafDragEnd}
      onDragOver={(e) => {
        if (sourceDragging) return // 拖拽源自身不响应 dragover
        if (pinned) return // 钉住的 leaf 不可被拖入 split/swap，不显示 drop hint
        if (!hasDropType(e.dataTransfer.types)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes('corum/new-slot') ? 'copy' : 'move'
        setZone(zoneFromPoint(e.clientX, e.clientY))
      }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        const newSlot = e.dataTransfer.getData('corum/new-slot') as GridSlot | ''
        const sourceId = e.dataTransfer.getData('corum/leaf-id')
        setZone(null)
        if (newSlot !== '') {
          e.preventDefault()
          onDropNewSlot?.(newSlot, leaf.id, zoneFromPoint(e.clientX, e.clientY))
        } else if (sourceId !== '') {
          e.preventDefault()
          onDrop(sourceId, leaf.id, zoneFromPoint(e.clientX, e.clientY))
        }
      }}
    >
      <RegionCard
        slotKey={leaf.slot}
        transparent={transparentSlots?.has(leaf.slot) ?? false}
      >
        {renderSlot(leaf.slot)}
      </RegionCard>
      {zone !== null && <div className={css.dropHint} data-zone={zone} aria-hidden="true" />}
    </div>
  )
}

/** 递归渲染一个节点。 */
function NodeView(props: GridViewProps & { node: GridNode; depth?: number }) {
  const { node, depth = 0, ...rest } = props
  if (node.type === 'leaf') {
    return <LeafView leaf={node} renderSlot={rest.renderSlot} onDrop={rest.onDrop} onPopOut={rest.onPopOut} onDropNewSlot={rest.onDropNewSlot} transparentSlots={rest.transparentSlots} />
  }
  return <BranchView branch={node} depth={depth} {...rest} />
}

/**
 * 计算一个分支各格的主轴像素（VSCode SplitView proportionalLayout 的对应物，
 * splitview.ts L856–873）：可见格按 weight 占比瓜分容器主轴 span，脱出的格
 * size=0（不占 offset），Σmin > span 时等比压缩到正好放下（不溢出截断）。
 * weights 即各格目标像素；sash 拖动只在相邻两格转移 weight（Σ不变），所以
 * 非相邻格的计算结果像素严格不变——不传导。
 */
function computeCellSizes(weights: number[], detached: boolean[], mins: number[], span: number, locked: readonly (number | null)[] = []): number[] {
  const n = weights.length
  // locked 格：宽度锁定（折叠轨），从 span 先扣除，不参与 weight 分配。
  let lockedTotal = 0
  for (let i = 0; i < n; i++) if (locked[i] != null) lockedTotal += locked[i] as number
  const freeSpan = span - lockedTotal
  const visible = weights.map((_, i) => !detached[i] && locked[i] == null)
  const visCount = visible.filter(Boolean).length
  const result: number[] = weights.map((_, i) => (locked[i] != null ? (locked[i] as number) : 0))
  if (visCount === 0 || freeSpan <= 0) return result
  let total = 0
  for (let i = 0; i < n; i++) if (visible[i]) total += Math.max(0, weights[i] ?? 0)
  if (total <= 0) {
    // 防御：可见格 weight 全 0（非法树）——均分。
    const each = freeSpan / visCount
    for (let i = 0; i < n; i++) if (visible[i]) result[i] = each
    return result
  }
  let sizes = weights.map((w, i) => (visible[i] ? (Math.max(0, w) / total) * freeSpan : 0))
  // 各格最小尺寸（脱出的格不参与求和——它不占空间）。
  let minTotal = 0
  for (let i = 0; i < n; i++) if (visible[i]) minTotal += mins[i] ?? 0
  if (minTotal >= freeSpan) {
    // 容器太窄：按各格 min 比例分配（而非等比平分）——保住各区域声明的
    // 最小比，小窗不丢布局、大窗恢复后仍贴近用户拖的比例，绝不溢出截断。
    for (let i = 0; i < n; i++) if (visible[i]) result[i] = ((mins[i] ?? 0) / minTotal) * freeSpan
    return result
  }
  // 夹各格自己的 min，夹取的差额从仍有富余的格里按比例补给（保持 Σ = freeSpan）。
  let deficit = 0
  sizes = sizes.map((s, i) => {
    if (!visible[i]) return 0
    const min = mins[i] ?? 0
    if (s < min) { deficit += min - s; return min }
    return s
  })
  if (deficit > 0) {
    const slack = sizes.reduce((a, s, i) => a + Math.max(0, s - (visible[i] ? mins[i] ?? 0 : 0)), 0)
    if (slack > 0) {
      sizes = sizes.map((s, i) => {
        const min = visible[i] ? mins[i] ?? 0 : 0
        return s > min ? s - (Math.max(0, s - min) / slack) * deficit : s
      })
    }
  }
  for (let i = 0; i < n; i++) if (visible[i]) result[i] = sizes[i]
  return result
}

/**
 * 渲染一个分支（VSCode SplitView 式绝对定位）：容器 position:relative，每格
 * position:absolute，left/top/width/height 由 JS 沿主轴累加 offset 算出并
 * 直接写 DOM style（不经 setState，避免每格重渲染）。容器尺寸用
 * ResizeObserver 监听（rAF 节流），变化时按 weights 占比重标定（自适应）。
 * sash 位置 = 相邻格边界；相邻有脱出格时该缝隐藏（拖它会改隐藏格 weight，
 * 经比例分配传导到非相邻格，违背「只相邻两格变」）。
 */
function BranchView(props: Omit<GridViewProps, 'root'> & { branch: BranchNode; depth?: number }) {
  const { branch, depth = 0, ...rest } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cellRefs = useRef(new Map<string, HTMLDivElement>())
  const innerRefs = useRef(new Map<string, HTMLDivElement>())
  const sashRefs = useRef(new Map<number, HTMLDivElement>())

  // 折叠 = 运行时脱出（detachedSlots）或持久化关闭（hidden）。两者都折叠为
  // 0 宽、相邻填满；hidden 进持久化（重启保持关闭），detached 是临时的。
  // 注意：直接子可能是嵌套 branch（如 right-col 里的 row(editor,explorer)）——
  // 不能只看 c.type==='leaf' 的 c.hidden，否则 branch 子其内部 leaf 全 hidden 也
  // 判不出，该支仍按 weight 占位、兄弟格（终端/对话区）不铺满。branch 子用
  // nodeAllHidden 递归判「所有后代 leaf 全 hidden」（detachedSlots 只作用于
  // leaf，branch 不判——脱出是临时态）。
  const detached = branch.children.map((c) =>
    c.type === 'leaf'
      ? ((rest.detachedSlots?.has(c.slot) ?? false) || c.hidden === true)
      : nodeAllHidden(c))
  // 折叠收起（collapsedSlots）：leaf 锁定为各自 collapsedWidth 的固定宽（非 0），
  // 不参与 weight 分配、两侧 sash 隐藏不可拖。取 grid.ts 的运行时折叠态（与
  // setSlotCollapsed 同步）——leafMinSize 同时已把 min 换成 collapsedWidth。
  const locked = branch.children.map((c) => {
    if (c.type !== 'leaf') return null
    if (!(rest.collapsedSlots?.has(c.slot) ?? false)) return null
    return slotCollapsedWidth(c.slot) ?? null
  })

  // 每次渲染重建的最新 layout 闭包（读最新 branch/detached/locked），供 RO/rAF 调用。
  const layoutRef = useRef<() => void>(() => {})
  layoutRef.current = () => {
    const el = containerRef.current
    if (el === null) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w <= 0 || h <= 0) return
    const isRow = branch.direction === 'row'
    const span = isRow ? w : h
    const mins = branch.children.map(c => subtreeMinSize(c, isRow))
    const sizes = computeCellSizes(branch.weights, detached, mins, span, locked)
    // 顶层 row 的 leafTopOffset：内容格 top 下移、height 相应缩短（绝对定位格
    // 自身仍占满全高，内容格让位）。只作用于 depth=0 的 row 分支。
    const topOffsets = depth === 0 && isRow ? rest.leafTopOffset : undefined
    let offset = 0
    for (let i = 0; i < branch.children.length; i++) {
      const size = sizes[i] ?? 0
      // sash i-1 在 cell i 的左/上边界上。
      if (i > 0) {
        const sash = sashRefs.current.get(i - 1)
        if (sash) {
          // 折叠轨相邻的 sash 隐藏（折叠格宽度锁定不可拖；拖它会改锁定格）。
          const show = size > 0 && (sizes[i - 1] ?? 0) > 0 && locked[i] == null && locked[i - 1] == null
          sash.style.visibility = show ? 'visible' : 'hidden'
          if (isRow) {
            sash.style.left = `${offset - 4}px`
            sash.style.top = '0px'
            sash.style.height = `${h}px`
          } else {
            sash.style.top = `${offset - 4}px`
            sash.style.left = '0px'
            sash.style.width = `${w}px`
          }
        }
      }
      const cell = cellRefs.current.get(branch.children[i].id)
      if (cell) {
        if (size <= 0) {
          cell.style.visibility = 'hidden'
        } else {
          cell.style.visibility = 'visible'
          if (isRow) {
            cell.style.left = `${offset}px`
            cell.style.top = '0px'
            cell.style.width = `${size}px`
            cell.style.height = `${h}px`
            // 内容格让位：top 下移 offset、height 缩短 offset（卡片从标题栏下方开始）。
            const inner = innerRefs.current.get(branch.children[i].id)
            if (inner) {
              const topOff = topOffsets?.[i] ?? 0
              inner.style.top = `${topOff}px`
              inner.style.height = `${Math.max(0, h - topOff)}px`
            }
          } else {
            cell.style.top = `${offset}px`
            cell.style.left = '0px'
            cell.style.height = `${size}px`
            cell.style.width = `${w}px`
          }
        }
      }
      offset += size
    }
  }

  // 渲染后（paint 前）重排：树 weights / detached / 方向任何变化都立刻反映。
  useLayoutEffect(() => {
    layoutRef.current()
  })

  // 容器尺寸变化（窗口缩放 / 父格重排）→ rAF 节流后按占比重标定 + layout。
  useEffect(() => {
    const el = containerRef.current
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        layoutRef.current()
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // sash 拖动：把 px delta 直接当像素转移（weights 就是像素），交给上层改树。
  const makeSashDrag = (sashIndex: number) => (pxDelta: number) => {
    rest.onResize(branch.id, sashIndex, pxDelta)
  }

  const cells: ReactNode[] = []
  branch.children.forEach((child, i) => {
    if (i > 0) {
      const sashIndex = i - 1
      cells.push(
        <Sash
          key={`sash-${i}`}
          ref={(el) => {
            if (el) sashRefs.current.set(sashIndex, el)
            else sashRefs.current.delete(sashIndex)
          }}
          direction={branch.direction}
          onDrag={makeSashDrag(sashIndex)}
        />,
      )
    }
    cells.push(
      <div
        key={child.id}
        ref={(el) => {
          if (el) cellRefs.current.set(child.id, el)
          else cellRefs.current.delete(child.id)
        }}
        className={css.branchCell}
        data-detached={detached[i] || undefined}
      >
        <div
          ref={(el) => {
            if (el) innerRefs.current.set(child.id, el)
            else innerRefs.current.delete(child.id)
          }}
          className={css.branchInner}
        >
          {detached[i] ? null : <NodeView {...rest} root={child} node={child} depth={depth + 1} />}
        </div>
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
    // LeafView 根同时带 data-slot 与 draggable（RegionCard 的 data-slot 在内层、无
    // draggable），用「draggable 的网格叶子」精确命中，避免双条件选择器落空。
    const leafEl = el?.closest('[data-slot][draggable="true"]') as HTMLElement | null
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
