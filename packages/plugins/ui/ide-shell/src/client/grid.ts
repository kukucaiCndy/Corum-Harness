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
  /** 用户关闭（不显示）：保留在树里（可恢复），渲染时折叠为 0 宽、相邻填满。 */
  hidden?: boolean
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

/**
 * 一个 leaf 在树里的路径（从根到它的下标序列）。脱出时记下，dock back 时
 * 沿同一路径插回，还原之前的位置（VSCode cachedVisibleSize 的思路，但记
 * 的是结构路径而非尺寸）。
 */
export type LeafPath = number[]

/** 求某 leaf 的路径；找不到返回 null。 */
export function pathOfLeaf(root: GridNode, leafId: string): LeafPath | null {
  if (root.type === 'leaf') return root.id === leafId ? [] : null
  for (let i = 0; i < root.children.length; i++) {
    const sub = pathOfLeaf(root.children[i], leafId)
    if (sub !== null) return [i, ...sub]
  }
  return null
}

/**
 * 沿路径插回一个 leaf（dock back 还原）。路径可能因期间其它拖放而失效——
 * 逐级防御：分支存在则插入到记录下标（越界则末尾），路径断在某层就插到该
 * 层分支末尾；整棵树已经不是分支就包一层。返回新树。
 */
export function insertLeafAtPath(root: GridNode, leaf: LeafNode, path: LeafPath): GridNode {
  const tree = cloneNode(root)
  if (path.length === 0) {
    // 目标是根本身：包一层 row 分支。
    return { type: 'branch', id: nid('b'), direction: 'row', children: [tree, leaf], weights: [1, 1] }
  }
  let node = tree
  for (let depth = 0; depth < path.length; depth++) {
    if (node.type !== 'branch') {
      // 路径断了（这层已不是分支）——无法继续深入，放弃精确还原。
      return tree
    }
    const index = path[depth]
    if (depth === path.length - 1) {
      // 最后一层：插入到记录下标（越界则末尾）。
      const at = Math.min(index, node.children.length)
      node.children.splice(at, 0, leaf)
      node.weights.splice(at, 0, 1)
      return tree
    }
    const next = node.children[Math.min(index, node.children.length - 1)]
    if (next === undefined || next.type !== 'branch') return tree
    node = next
  }
  return tree
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
  if (!tgtAfter) return tree
  // 根分支被 prune 塌陷成单 leaf（原根只有两格、摘掉一格后剩一格）时
  // tgtAfter.parent === null —— 不能放弃（source 已被摘除，放弃就丢窗格），
  // 把根包成新分支，按 zone 排两个子节点。
  if (tgtAfter.parent === null) {
    const wantDir: BranchNode['direction'] = (zone === 'left' || zone === 'right') ? 'row' : 'column'
    const insertFirst = (zone === 'left' || zone === 'top')
    const remaining = tree // 此时 tree 已是塌陷后的单 leaf（即 tgt）
    return {
      type: 'branch',
      id: nid('b'),
      direction: wantDir,
      children: insertFirst ? [srcLeaf, remaining] : [remaining, srcLeaf],
      weights: [1, 1], // 包成新根分支：两格均分（render 端按容器 flexBasis，均分即各半）
    }
  }
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
    // 父分支反向：把目标 leaf 包成一个新分支（两个子节点）。weights 是像素
    // （flexBasis）——两格按目标格原份额各半，不能写死 [1,1]（那会塌陷成
    // 1px 直到下一次窗口 resize 才修复）。
    const targetWeight = parent.weights[index] ?? 1
    const half = targetWeight / 2
    const wrapper: BranchNode = {
      type: 'branch',
      id: nid('b'),
      direction: wantDirection,
      children: insertBefore ? [srcLeaf, tgtAfter.node] : [tgtAfter.node, srcLeaf],
      weights: [half, half],
    }
    parent.children[index] = wrapper
  }
  return tree
}

/** 按 slot 设置某 leaf 的 hidden（关闭/恢复显示）。树保留该 leaf，只翻标记。 */
export function setLeafHidden(root: GridNode, slot: GridSlot, hidden: boolean): GridNode {
  const tree = cloneNode(root)
  const leaf = findLeafBySlot(tree, slot)
  if (leaf !== null) leaf.hidden = hidden
  return tree
}

/** 列出当前关闭（hidden）的槽位。 */
export function hiddenSlots(root: GridNode): GridSlot[] {
  const out: GridSlot[] = []
  const walk = (n: GridNode): void => {
    if (n.type === 'leaf') { if (n.hidden === true) out.push(n.slot); return }
    n.children.forEach(walk)
  }
  walk(root)
  return out
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
 * 调整某分支里两个相邻子节点间的 sash（SplitView 标准：只影响相邻两侧）。
 * 把 delta（份额）从 sashIndex+1 侧转移到 sashIndex 侧（delta>0 = 左/上侧
 * 变大），两侧夹取最小份额后互相消长，**其余子节点的份额一字不动**——因为
 * weights 是相对份额且总量守恒只在相邻两格间转移，其它格的实际像素不变。
 * 相邻两格的最小份额夹取后剩余的 delta 直接丢弃（不向外传导）。
 */
export function resizeBranch(root: GridNode, branchId: string, sashIndex: number, delta: number, minWeight = 150): GridNode {
  const tree = cloneNode(root)
  const found = findNode(tree, branchId)
  if (!found || found.node.type !== 'branch') return root
  const branch = found.node
  const i = sashIndex
  if (i < 0 || i >= branch.weights.length - 1) return root
  const a = branch.weights[i]
  const b = branch.weights[i + 1]
  const total = a + b
  // 只在相邻两格间转移：a 增大多少、b 就减小多少（份额总量不变），双向都
  // 夹到 minWeight 为止，多出的 delta 不传出去。
  const newA = Math.max(minWeight, Math.min(total - minWeight, a + delta))
  branch.weights[i] = newA
  branch.weights[i + 1] = total - newA
  return tree
}

/**
 * 窗口尺寸变化时按当前比例重标定所有分支的 weights 到新总宽（自适应）。
 * weights 是像素；窗口缩放时各列等比缩放，不截断、不溢出。row 分支沿宽度
 * 缩放、column 分支沿高度缩放——按方向分别处理。
 */
export function rescaleGrid(node: GridNode, width: number, height: number): GridNode {
  const MIN = 150
  const scale = (branch: BranchNode, span: number): void => {
    const total = branch.weights.reduce((a, b) => a + b, 0)
    if (total <= 0 || span <= 0) return
    // 先按比例分配。
    let ws = branch.weights.map((w) => (w / total) * span)
    // 每列至少 MIN；但若 ΣMIN 超过可用空间（窗口太窄），按可用空间等比压缩
    // 到正好放下（允许低于 MIN），绝不溢出截断。
    const minTotal = MIN * ws.length
    if (minTotal >= span) {
      const hard = span / ws.length
      branch.weights = ws.map(() => hard)
      return
    }
    // 正常：夹 MIN，夹取的差额从仍有富余的列里补给（保持 Σ = span）。
    let deficit = 0
    ws = ws.map((w) => {
      if (w < MIN) { deficit += MIN - w; return MIN }
      return w
    })
    if (deficit > 0) {
      const slack = ws.reduce((a, w) => a + Math.max(0, w - MIN), 0)
      if (slack > 0) {
        ws = ws.map((w) => (w > MIN ? w - (Math.max(0, w - MIN) / slack) * deficit : w))
      }
    }
    branch.weights = ws
  }
  const walk = (n: GridNode, w: number, h: number): void => {
    if (n.type === 'leaf') return
    const isRow = n.direction === 'row'
    scale(n, isRow ? w : h)
    // 子分支的正交尺寸 = 父分支该方向尺寸；子分支沿其主轴的尺寸 = 它自己的 weight。
    n.children.forEach((child, i) => {
      const cw = isRow ? n.weights[i] : w
      const ch = isRow ? h : n.weights[i]
      walk(child, cw, ch)
    })
  }
  const tree = cloneNode(node)
  walk(tree, width, height)
  return tree
}

// ── 持久化 ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'corum.ide.grid.v1'

/** 序列化树（weights 保留两位小数）。 */
export function serializeGrid(node: GridNode): string {
  const strip = (n: GridNode): unknown => n.type === 'leaf'
    ? (n.hidden === true ? { t: 'l', slot: n.slot, h: 1 } : { t: 'l', slot: n.slot })
    : { t: 'b', d: n.direction, c: n.children.map(strip), w: n.weights.map((w) => Math.round(w * 100) / 100) }
  return JSON.stringify(strip(node))
}

/** 反序列化（重新发 id，结构非法时回退默认布局）。 */
export function deserializeGrid(json: string): GridNode | null {
  try {
    const build = (raw: unknown): GridNode | null => {
      if (typeof raw !== 'object' || raw === null) return null
      const r = raw as Record<string, unknown>
      if (r.t === 'l' && typeof r.slot === 'string') return { type: 'leaf', id: nid('l'), slot: r.slot as GridSlot, ...(r.h === 1 ? { hidden: true } : {}) }
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
