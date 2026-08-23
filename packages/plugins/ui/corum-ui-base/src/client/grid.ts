/**
 * GridView 布局树 —— VSCode editor-group 式自由二维网格的数据模型。
 *
 * 布局是一棵分割树：
 *   - Leaf：一个模块窗格（持有 slotKey，渲染对应槽位内容）。
 *   - Branch：一个水平(row)或垂直(column) split，含若干子节点 + 各子节点
 *     占比 weight（相对份额，渲染时换算成 px/fr），子节点间是 sash。
 *
 * 本包（shell-base）只提供通用机制：树类型 + 全部树操作 + 槽位注册表 +
 * 构造 helper（leafNode/rowBranch/columnBranch）+ 持久化（key 可配）。
 * 不含任何内置槽位与默认布局——子壳用 registerSlot() 注册自己的槽位、
 * 用构造 helper 写字面量布局树作为初始布局。
 *
 * 这棵树是唯一事实源，持久化到 localStorage（尺寸份额 + 结构）。
 */

/** 可进网格的槽位 key（任意字符串，运行时动态注册）。 */
export type GridSlot = string

/** 槽位元数据：显示名 + 默认权重。 */
export interface SlotMeta {
  label: string
  defaultWeight: number
}

/**
 * 槽位注册表——运行时可扩展。子壳/插件可调 registerSlot() 注册自己的槽位，
 * 注册后即出现在「添加区域」面板里，用户可自由拖入网格。
 */
const slotRegistry = new Map<string, SlotMeta>()

/** 注册一个槽位（重复注册覆盖旧元数据）。 */
export function registerSlot(key: string, meta: SlotMeta): void {
  slotRegistry.set(key, meta)
}

/** 查询某槽位的元数据。 */
export function getSlotMeta(key: string): SlotMeta | undefined {
  return slotRegistry.get(key)
}

/** 列出所有已注册的槽位 key（有序）。 */
export function getAllRegisteredSlots(): string[] {
  return [...slotRegistry.keys()]
}

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

// ── 构造 helper（帮子壳省 nid 细节，直接写字面量布局树）────────────────

/** 构造一个叶子节点。 */
export function leafNode(slot: GridSlot): LeafNode {
  return { type: 'leaf', id: nid('l'), slot }
}

/** 构造一个水平分支（左右排列）。weights 缺省时每格 400。 */
export function rowBranch(children: GridNode[], weights?: number[]): BranchNode {
  return { type: 'branch', id: nid('b'), direction: 'row', children, weights: weights ?? children.map(() => 400) }
}

/** 构造一个垂直分支（上下排列）。weights 缺省时每格 400。 */
export function columnBranch(children: GridNode[], weights?: number[]): BranchNode {
  return { type: 'branch', id: nid('b'), direction: 'column', children, weights: weights ?? children.map(() => 400) }
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

/** 列出当前在网格中的所有槽位（含 hidden 的）。 */
export function slotsInGrid(root: GridNode): Set<GridSlot> {
  const out = new Set<GridSlot>()
  const walk = (n: GridNode): void => {
    if (n.type === 'leaf') { out.add(n.slot); return }
    n.children.forEach(walk)
  }
  walk(root)
  return out
}

/** 列出当前不在网格中的槽位（可添加的）。 */
export function slotsNotInGrid(root: GridNode): GridSlot[] {
  const inGrid = slotsInGrid(root)
  return getAllRegisteredSlots().filter((s) => !inGrid.has(s))
}

/**
 * 把一个槽位作为新 leaf 添加到网格末尾（根分支右侧）。
 * 如果根不是分支则包一层。返回新树。
 */
export function addSlot(root: GridNode, slot: GridSlot): GridNode {
  const leaf: LeafNode = { type: 'leaf', id: nid('l'), slot }
  const weight = getSlotMeta(slot)?.defaultWeight ?? 400
  if (root.type === 'leaf') {
    return { type: 'branch', id: nid('b'), direction: 'row', children: [root, leaf], weights: [800, weight] }
  }
  const tree = cloneNode(root)
  if (tree.type !== 'branch') return root
  tree.children.push(leaf)
  tree.weights.push(weight)
  return tree
}

/**
 * 把一个新槽位 drop 到网格中已有 leaf 的某侧（split 或包壳）。
 * 与 dropLeaf 类似，但 source 是新创建的 leaf（不从树里摘除）。
 */
export function addSlotAt(root: GridNode, slot: GridSlot, targetId: string, zone: DropZone): GridNode {
  if (zone === 'center') return root // 新槽位不支持 swap
  const tree = cloneNode(root)
  const tgt = findNode(tree, targetId)
  if (!tgt || tgt.node.type !== 'leaf') return root

  const newLeaf: LeafNode = { type: 'leaf', id: nid('l'), slot }
  const wantDirection: BranchNode['direction'] = (zone === 'left' || zone === 'right') ? 'row' : 'column'
  const insertBefore = (zone === 'left' || zone === 'top')

  if (tgt.parent === null) {
    // 目标是根 leaf —— 包成新分支。新叶子按 slot 默认份额，已有叶保留
    // 合理份额（与包壳处「目标份额各半」同思路，基准取 defaultWeight）。
    const newWeight = getSlotMeta(slot)?.defaultWeight ?? 400
    return {
      type: 'branch', id: nid('b'), direction: wantDirection,
      children: insertBefore ? [newLeaf, tree] : [tree, newLeaf],
      weights: insertBefore ? [newWeight, 400] : [400, newWeight],
    }
  }

  const parent = tgt.parent
  const index = tgt.index

  if (parent.direction === wantDirection) {
    const at = insertBefore ? index : index + 1
    const targetWeight = parent.weights[index] ?? 400
    const half = targetWeight / 2
    parent.weights[index] = half
    parent.children.splice(at, 0, newLeaf)
    parent.weights.splice(at, 0, half)
  } else {
    const targetWeight = parent.weights[index] ?? 400
    const half = targetWeight / 2
    const wrapper: BranchNode = {
      type: 'branch', id: nid('b'), direction: wantDirection,
      children: insertBefore ? [newLeaf, tgt.node] : [tgt.node, newLeaf],
      weights: [half, half],
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
 * 调整某分支里两个相邻子节点间的 sash（SplitView 标准：只影响相邻两侧）。
 * 把 delta（份额）从 sashIndex+1 侧转移到 sashIndex 侧（delta>0 = 左/上侧
 * 变大），两侧夹取最小份额后互相消长，**其余子节点的份额一字不动**——因为
 * weights 是相对份额且总量守恒只在相邻两格间转移，其它格的实际像素不变。
 * 相邻两格的最小份额夹取后剩余的 delta 直接丢弃（不向外传导）。
 * minWeight 不传时按分支主轴方向自动选取：row（沿宽度）150，column
 * （沿高度）80——column 分支里 terminal 等格子的最小高度不该占 150。
 */
export function resizeBranch(root: GridNode, branchId: string, sashIndex: number, delta: number, minWeight?: number): GridNode {
  const tree = cloneNode(root)
  const found = findNode(tree, branchId)
  if (!found || found.node.type !== 'branch') return root
  const branch = found.node
  const min = minWeight ?? (branch.direction === 'row' ? 150 : 80)
  const i = sashIndex
  if (i < 0 || i >= branch.weights.length - 1) return root
  const a = branch.weights[i]
  const b = branch.weights[i + 1]
  const total = a + b
  // 只在相邻两格间转移：a 增大多少、b 就减小多少（份额总量不变），双向都
  // 夹到 min 为止，多出的 delta 不传出去。
  const newA = Math.max(min, Math.min(total - min, a + delta))
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
  const scale = (branch: BranchNode, span: number): void => {
    // 主轴方向最小尺寸：row（沿宽度）150，column（沿高度）80。
    const MIN = branch.direction === 'row' ? 150 : 80
    const total = branch.weights.reduce((a, b) => a + b, 0)
    if (total <= 0 || span <= 0) return
    // 先按比例分配。
    let ws = branch.weights.map((w) => (w / total) * span)
    // 每格至少 MIN；但若 ΣMIN 超过可用空间（窗口太窄），按可用空间等比压缩
    // 到正好放下（允许低于 MIN），绝不溢出截断。
    const minTotal = MIN * ws.length
    if (minTotal >= span) {
      const hard = span / ws.length
      branch.weights = ws.map(() => hard)
      return
    }
    // 正常：夹 MIN，夹取的差额从仍有富余的格里补给（保持 Σ = span）。
    let deficit = 0
    ws = ws.map((w) => {
      if (w < MIN) { deficit += MIN - w; return MIN }
      return w
    })
    if (deficit > 0) {
      const slack = ws.reduce((a, w) => a + Math.max(0, w - MIN), 0)
      if (slack > deficit) {
        ws = ws.map((w) => (w > MIN ? w - (Math.max(0, w - MIN) / slack) * deficit : w))
      } else {
        // 富余不够补差额（多格同时低于 MIN）：退化为等比压缩（与
        // minTotal>=span 分支同策略），保证 Σ=span 恒成立、绝不溢出。
        const hard = span / ws.length
        branch.weights = ws.map(() => hard)
        return
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

/** 默认持久化 key；子壳应传自己的 key（如 ide-shell 用 'corum.ide.grid.v3'）。 */
export const DEFAULT_GRID_STORAGE_KEY = 'corum.grid.v1'

/** 序列化树（weights 保留两位小数）。 */
export function serializeGrid(node: GridNode): string {
  const strip = (n: GridNode): unknown => n.type === 'leaf'
    ? (n.hidden === true ? { t: 'l', slot: n.slot, h: 1 } : { t: 'l', slot: n.slot })
    : { t: 'b', d: n.direction, c: n.children.map(strip), w: n.weights.map((w) => Math.round(w * 100) / 100) }
  return JSON.stringify(strip(node))
}

/** 反序列化（重新发 id，结构非法时返回 null，由调用方回退到自己的默认布局）。 */
export function deserializeGrid(json: string): GridNode | null {
  try {
    const build = (raw: unknown): GridNode | null => {
      if (typeof raw !== 'object' || raw === null) return null
      const r = raw as Record<string, unknown>
      if (r.t === 'l' && typeof r.slot === 'string') {
        // 槽位已不在注册表（插件被移除等）——丢弃该叶子，避免永久显示
        // 「此区域暂无内容」且无法从「添加区域」清除。
        if (getSlotMeta(r.slot) === undefined) return null
        return { type: 'leaf', id: nid('l'), slot: r.slot as GridSlot, ...(r.h === 1 ? { hidden: true } : {}) }
      }
      if (r.t === 'b' && (r.d === 'row' || r.d === 'column') && Array.isArray(r.c) && Array.isArray(r.w)) {
        const children = r.c.map(build).filter((c): c is GridNode => c !== null)
        if (children.length === 0) return null
        return { type: 'branch', id: nid('b'), direction: r.d, children, weights: r.w.map((w) => (typeof w === 'number' ? w : 1)) }
      }
      return null
    }
    const tree = build(JSON.parse(json))
    if (tree === null) return null
    // 对齐 weights/children 长度并剪枝（含 slot 校验丢弃叶子后的塌陷）。
    const pruned = prune(tree)
    // 整树被剪空（如只剩一个未注册 slot 的叶子）时回退默认布局。
    if (pruned.type === 'branch' && pruned.children.length === 0) return null
    return pruned
  } catch {
    return null
  }
}

/**
 * 读持久化布局；无或非法时回退 `fallback()`（子壳的默认布局）。
 * key 缺省 DEFAULT_GRID_STORAGE_KEY；子壳传自己的 key 以隔离/兼容存量布局。
 */
export function loadGrid(fallback: () => GridNode, key: string = DEFAULT_GRID_STORAGE_KEY): GridNode {
  if (typeof localStorage === 'undefined') return fallback()
  const raw = localStorage.getItem(key)
  if (raw === null) return fallback()
  return deserializeGrid(raw) ?? fallback()
}

/** 写持久化布局。key 缺省 DEFAULT_GRID_STORAGE_KEY。 */
export function saveGrid(node: GridNode, key: string = DEFAULT_GRID_STORAGE_KEY): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, serializeGrid(node))
  } catch { /* quota/private mode — non-fatal */ }
}

/** 清空持久化（恢复子壳默认布局）。key 缺省 DEFAULT_GRID_STORAGE_KEY。 */
export function resetGridStorage(key: string = DEFAULT_GRID_STORAGE_KEY): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(key)
}
