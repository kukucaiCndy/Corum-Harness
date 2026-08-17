/**
 * GridView 布局树 —— VSCode editor-group 式自由二维网格的数据模型。
 *
 * 布局是一棵分割树：
 *   - Leaf：一个模块窗格（持有 slotKey，渲染对应槽位内容）。
 *   - Branch：一个水平(row)或垂直(column) split，含若干子节点 + 各子节点
 *     占比 weight（相对份额，渲染时换算成 px/fr），子节点间是 sash。
 *
 * 初始布局 = 现四列（一个 row split，4 个 leaf：sidebar / conversation /
 * editor / explorer）。拖一个模块标题到另一模块的上/下/左/右边缘 → 在该
 * 方向 split 出新 leaf 插入；拖到中心 → 交换两格内容；源格拖空 → 树剪枝
 * （删 leaf，父分支只剩一个子时提升该子）。
 *
 * 这棵树是唯一事实源，持久化到 localStorage（尺寸份额 + 结构）。
 */

/** 可进网格的槽位（与 AppFrame.FLOATABLE_SLOTS 对齐 + sidebar）。 */
export type GridSlot =
  | 'corum.sidebar'
  | 'conversation'
  | 'corum.editor'
  | 'corum.explorer'
  | 'corum.panel'
  | 'corum.statusBar'

export interface LeafNode {
  type: 'leaf'
  id: string
  slot: GridSlot
}

export interface BranchNode {
  type: 'branch'
  id: string
  /** row = 水平排列（左右分，sash 垂直）；column = 垂直排列（上下分，sash 水平）。 */
  direction: 'row' | 'column'
  children: GridNode[]
  /** 与 children 等长的相对份额（渲染换算；拖拽 sash 改它）。 */
  weights: number[]
}

export type GridNode = LeafNode | BranchNode

let idSeq = 0
const nid = (p: string) => `${p}-${++idSeq}-${Math.random().toString(36).slice(2, 7)}`

/** 默认四列布局（design.pen L1 主界面）。 */
export function defaultGrid(): GridNode {
  return {
    type: 'branch',
    id: nid('b'),
    direction: 'row',
    children: [
      { type: 'leaf', id: nid('l'), slot: 'corum.sidebar' },
      { type: 'leaf', id: nid('l'), slot: 'conversation' },
      { type: 'leaf', id: nid('l'), slot: 'corum.editor' },
      { type: 'leaf', id: nid('l'), slot: 'corum.explorer' },
    ],
    // 280 / flex / 430 / 210 的相对份额（center 取一个较大 flex 值）。
    weights: [280, 800, 430, 210],
  }
}

/** 深拷贝（操作用纯函数，返回新树）。 */
export function cloneNode(node: GridNode): GridNode {
  if (node.type === 'leaf') return { ...node }
  return { ...node, children: node.children.map(cloneNode), weights: [...node.weights] }
}

/** 按 id 找节点 + 其父分支 + 在父中的下标。 */
export function findNode(root: GridNode, id: string): { node: GridNode; parent: BranchNode | null; index: number } | null {
  if (root.id === id) return { node: root, parent: null, index: -1 }
  if (root.type === 'branch') {
    for (let i = 0; i < root.children.length; i++) {
      const found = findNode(root.children[i], id)
      if (found) {
        return found.parent === null && found.node.id === root.children[i].id
          ? { node: found.node, parent: root, index: i }
          : found
      }
    }
  }
  return null
}

/** 找到某 leaf 的第一个匹配（按 slot）。 */
export function findLeafBySlot(root: GridNode, slot: GridSlot): LeafNode | null {
  if (root.type === 'leaf') return root.slot === slot ? root : null
  for (const child of root.children) {
    const found = findLeafBySlot(child, slot)
    if (found) return found
  }
  return null
}

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

/**
 * 把 `sourceId` 的 leaf 放到 `targetId` 的 leaf 的某个 zone：
 *  - 四边：在该方向 split —— 若目标父分支方向与该边一致则直接插入相邻位，
 *    否则把目标 leaf 包成一个新分支（两个子节点），source 插入对应侧。
 *  - center：交换两格的 slot。
 * 源格从原位置摘除；剪枝后返回新树。source === target 时 no-op。
 */
export function dropLeaf(root: GridNode, sourceId: string, targetId: string, zone: DropZone): GridNode {
  if (sourceId === targetId) return root
  const tree = cloneNode(root)
  const src = findNode(tree, sourceId)
  const tgt = findNode(tree, targetId)
  if (!src || !tgt || src.node.type !== 'leaf' || tgt.node.type !== 'leaf') return root

  const srcLeaf = src.node as LeafNode
  const tgtLeaf = tgt.node as LeafNode

  if (zone === 'center') {
    // 交换两格内容。
    const tmp = srcLeaf.slot
    srcLeaf.slot = tgtLeaf.slot
    tgtLeaf.slot = tmp
    return tree
  }

  // 先从原位置摘除 source。
  removeLeaf(tree, sourceId)
  // 摘除后 tgt 的父/下标可能变化，重新定位。
  const tgtAfter = findNode(tree, targetId)
  if (!tgtAfter || !tgtAfter.parent) return tree
  const parent = tgtAfter.parent
  const index = tgtAfter.index

  const wantDirection: BranchNode['direction'] = (zone === 'left' || zone === 'right') ? 'row' : 'column'
  const insertBefore = (zone === 'left' || zone === 'top')

  if (parent.direction === wantDirection) {
    // 父分支同向：直接插入目标相邻位。
    const at = insertBefore ? index : index + 1
    parent.children.splice(at, 0, srcLeaf)
    // 目标原份额拆分：source 拿目标份额的一半。
    const targetWeight = parent.weights[index] ?? 1
    const srcWeight = targetWeight / 2
    parent.weights[index] = targetWeight / 2
    parent.weights.splice(at, 0, srcWeight)
  } else {
    // 父分支反向：把目标 leaf 包成一个新分支（两个子节点）。
    const wrapper: BranchNode = {
      type: 'branch',
      id: nid('b'),
      direction: wantDirection,
      children: insertBefore ? [srcLeaf, tgtAfter.node] : [tgtAfter.node, srcLeaf],
      weights: [1, 1],
    }
    parent.children[index] = wrapper
  }
  return tree
}

/** 从树里摘除一个 leaf 并剪枝（父分支只剩一个子时提升该子）。 */
export function removeLeaf(root: GridNode, id: string): GridNode {
  const found = findNode(root, id)
  if (!found || !found.parent) return root
  const parent = found.parent
  parent.children.splice(found.index, 1)
  parent.weights.splice(found.index, 1)
  return prune(root)
}

/** 剪枝：任何只剩一个子的分支被该子替换（自底向上）。 */
export function prune(node: GridNode): GridNode {
  if (node.type === 'leaf') return node
  node.children = node.children.map(prune)
  // 移除非法空分支。
  node.children = node.children.filter((c) => c.type === 'leaf' || c.children.length > 0)
  if (node.children.length === 1) return node.children[0]
  // 权重长度对齐 children（防御）。
  if (node.weights.length !== node.children.length) {
    node.weights = node.children.map((_, i) => node.weights[i] ?? 1)
  }
  return node
}

/**
 * 调整某分支里两个相邻子节点间的 sash：把 delta（fr 份额）从 fromIndex 子
 * 节点转移到 fromIndex+1 子节点，夹取最小份额。
 */
export function resizeBranch(root: GridNode, branchId: string, sashIndex: number, delta: number, minWeight = 0.05): GridNode {
  const tree = cloneNode(root)
  const found = findNode(tree, branchId)
  if (!found || found.node.type !== 'branch') return root
  const branch = found.node
  const i = sashIndex
  if (i < 0 || i >= branch.weights.length - 1) return root
  const a = branch.weights[i]
  const b = branch.weights[i + 1]
  const total = a + b
  let newA = a + delta
  newA = Math.max(minWeight, Math.min(total - minWeight, newA))
  branch.weights[i] = newA
  branch.weights[i + 1] = total - newA
  return tree
}

// ── 持久化 ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'corum.ide.grid.v1'

/** 序列化树（weights 保留两位小数）。 */
export function serializeGrid(node: GridNode): string {
  const strip = (n: GridNode): unknown => n.type === 'leaf'
    ? { t: 'l', slot: n.slot }
    : { t: 'b', d: n.direction, c: n.children.map(strip), w: n.weights.map((w) => Math.round(w * 100) / 100) }
  return JSON.stringify(strip(node))
}

/** 反序列化（重新发 id，结构非法时回退默认布局）。 */
export function deserializeGrid(json: string): GridNode | null {
  try {
    const build = (raw: unknown): GridNode | null => {
      if (typeof raw !== 'object' || raw === null) return null
      const r = raw as Record<string, unknown>
      if (r.t === 'l' && typeof r.slot === 'string') return { type: 'leaf', id: nid('l'), slot: r.slot as GridSlot }
      if (r.t === 'b' && (r.d === 'row' || r.d === 'column') && Array.isArray(r.c) && Array.isArray(r.w)) {
        const children = r.c.map(build).filter((c): c is GridNode => c !== null)
        if (children.length === 0) return null
        return { type: 'branch', id: nid('b'), direction: r.d, children, weights: r.w.map((w) => (typeof w === 'number' ? w : 1)) }
      }
      return null
    }
    return build(JSON.parse(json))
  } catch {
    return null
  }
}

/** 读持久化布局；无则默认。 */
export function loadGrid(): GridNode {
  if (typeof localStorage === 'undefined') return defaultGrid()
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return defaultGrid()
  return deserializeGrid(raw) ?? defaultGrid()
}

/** 写持久化布局。 */
export function saveGrid(node: GridNode): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, serializeGrid(node))
  } catch { /* quota/private mode — non-fatal */ }
}

/** 清空持久化（恢复默认四列）。 */
export function resetGridStorage(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(STORAGE_KEY)
}
