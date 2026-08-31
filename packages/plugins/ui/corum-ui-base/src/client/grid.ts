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

/**
 * 可进网格的槽位 key。泛型槽域：默认 `string`（运行时动态注册，行为与历史
 * 完全一致）；子壳可用字面量联合实例化（如 ide-shell 的 IdeGridSlot）让
 * registerSlot 等定义处获得拼写/重命名的编译期保障。纯类型层——本文件保持
 * cordis-free（零 import），运行时零变化；树结构 GridNode 仍是 string 槽域
 * （运行时本就可容纳动态注册的任意槽，不做静态收窄）。
 */
export type GridSlot<T extends string = string> = T

/** 槽位元数据：显示名 + 默认权重 + 区域最小尺寸（可选）。 */
export interface SlotMeta {
  label: string
  defaultWeight: number
  /**
   * 区域最小宽度（px）：叶子落在 row 分支（左右并排）时，sash 拖拽收窄的
   * 下限。不声明时用 SLOT_FALLBACK_MIN_WIDTH 兜底，保证基本浏览体验。
   */
  minWidth?: number
  /** 区域最小高度（px）：叶子落在 column 分支（上下叠放）时的下限；缺省 SLOT_FALLBACK_MIN_HEIGHT。 */
  minHeight?: number
  /**
   * 钉住（pinned）：该槽位的 leaf 在网格中位置/归属固定，不参与自由组合——
   * 不可被 drop 拖走（作 source）、不可被拖入 split/swap（作 target）、不可被
   * 摘除。用于 IDE 侧栏这类「位置固定、其余区域自由组合」的壳。sash 拖拽不
   * 受此限（它只调相邻权重、不移动 leaf 位置；钉住叶独立成列后天然不被其它
   * sash 影响）。缺省 false（全部区域自由组合）。
   */
  pinned?: boolean
  /**
   * 折叠宽（px）：该槽位可被「折叠收起」为一条窄轨（如 IDE 侧栏收成 56px
   * 图标轨）。声明后 GridView 经 `collapsedSlots` 运行时状态把它渲染成此固定
   * 宽（不参与 weight 分配、不可 sash 拖），同时 subtreeMinSize 在折叠态取此值
   * （替代 minWidth——窗口自适应不会把它拉回展开宽）。缺省不可折叠。
   */
  collapsedWidth?: number
}

/**
 * 槽位注册表——运行时可扩展。子壳/插件可调 registerSlot() 注册自己的槽位，
 * 注册后即出现在「添加区域」面板里，用户可自由拖入网格。
 */
const slotRegistry = new Map<string, SlotMeta>()

/** 注册一个槽位（重复注册覆盖旧元数据）。泛型 T 让子壳把注册 key 收窄进
 *  自己的字面量槽域（拼错即编译错，B2）；缺省 string 与历史一致。 */
export function registerSlot<T extends string = string>(key: T, meta: SlotMeta): void {
  slotRegistry.set(key, meta)
}

/** 查询某槽位的元数据。 */
export function getSlotMeta(key: string): SlotMeta | undefined {
  return slotRegistry.get(key)
}

/** 该槽位是否被钉住（位置/归属固定，不参与 drop 自由组合）。 */
export function isPinnedSlot(key: string): boolean {
  return slotRegistry.get(key)?.pinned === true
}

/**
 * 槽位折叠运行时状态（GridView `collapsedSlots` 的镜像，供 leafMinSize 取
 * 折叠宽）。由 AppFrame 这类壳在切换折叠时同步写入；与 collapsedWidth 声明
 * 配合——只有声明了 collapsedWidth 的槽位才接受折叠（未声明时写入被忽略）。
 */
const collapsedSlots = new Set<string>()

/** 折叠/展开一个槽位（未声明 collapsedWidth 的槽位调用无效）。 */
export function setSlotCollapsed(key: string, collapsed: boolean): void {
  const meta = slotRegistry.get(key)
  if (meta?.collapsedWidth === undefined) return
  if (collapsed) collapsedSlots.add(key)
  else collapsedSlots.delete(key)
}

/** 该槽位当前是否处于折叠态。 */
export function isSlotCollapsed(key: string): boolean {
  return collapsedSlots.has(key)
}

/** 槽位折叠后的宽度（未声明/未折叠返回 undefined）。 */
export function slotCollapsedWidth(key: string): number | undefined {
  return collapsedSlots.has(key) ? slotRegistry.get(key)?.collapsedWidth : undefined
}

/** 列出所有已注册的槽位 key（有序）。 */
export function getAllRegisteredSlots(): string[] {
  return [...slotRegistry.keys()]
}

/** 未声明 minWidth 的槽位在 row 分支里的最小宽度兜底（px）——保证基本浏览与交互。 */
export const SLOT_FALLBACK_MIN_WIDTH = 200

/** 未声明 minHeight 的槽位在 column 分支里的最小高度兜底（px）——与宽度兜底同为 200 正方形。 */
export const SLOT_FALLBACK_MIN_HEIGHT = 200

/** 叶子在指定轴上的最小尺寸：折叠态取 collapsedWidth；否则 SlotMeta 声明优先，缺省走兜底。 */
function leafMinSize(slot: GridSlot, isRow: boolean): number {
  const meta = slotRegistry.get(slot)
  // 折叠态（仅 row 轴的宽度方向生效——折叠收的是宽）：min 取折叠宽，
  // 窗口自适应 rescaleGrid 不会把它拉回展开宽。
  if (isRow && collapsedSlots.has(slot) && meta?.collapsedWidth !== undefined) {
    return meta.collapsedWidth
  }
  const declared = isRow ? meta?.minWidth : meta?.minHeight
  return declared ?? (isRow ? SLOT_FALLBACK_MIN_WIDTH : SLOT_FALLBACK_MIN_HEIGHT)
}

/**
 * 子树在指定轴上的最小尺寸（sash 拖拽 / 窗口自适应 / 渲染夹取三处统一取值）：
 *   - 同轴分支（row 分支求宽度 / column 分支求高度）= 各子最小之和（并排需同时满足）；
 *   - 正交分支（row 分支求高度 / column 分支求宽度）= 各子最小的最大值
 *     （叠放共用同一主轴宽度，取最宽需求）。
 * 整体隐藏的子树（nodeAllHidden：leaf hidden，或 branch 所有后代 leaf 全 hidden）
 * min=0——它已不占空间，若仍计入 min 会让兄弟格被「隐形 min」顶住、无法在
 * computeCellSizes 里填满（2026-08-28 走查：隐藏编辑器+资源管理器后终端不铺满，
 * 除 detached 误判外，subtreeMinSize 把全隐藏 top-row 的 min 633 也算进 minTotal）。
 * 部分隐藏的 branch 仍按可见子树计 min（可见部分需要下限）；单 leaf hidden 同理
 * 取 0。
 */
export function subtreeMinSize(node: GridNode, isRow: boolean): number {
  if (node.type === 'leaf') return node.hidden === true ? 0 : leafMinSize(node.slot, isRow)
  const sizes = node.children.map(c => subtreeMinSize(c, isRow))
  return node.direction === (isRow ? 'row' : 'column')
    ? sizes.reduce((a, b) => a + b, 0)
    : sizes.reduce((a, b) => Math.max(a, b), 0)
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

  // 钉住的 leaf 不参与自由组合：source 是 pinned（不可被拖走）或 target 是
  // pinned（不可被拖入 split/swap）都 no-op。
  if (isPinnedSlot(srcLeaf.slot) || isPinnedSlot(tgtLeaf.slot)) return root

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

/**
 * 该节点是否「整体隐藏」——leaf 看自身 hidden；branch 看其**所有后代 leaf 是否
 * 全部 hidden**（全隐藏则整支不占空间，兄弟格填满）。GridView 的 BranchView 用它
 * 判定各格 detached：否则外层分支的直接子是嵌套 branch（如 right-col 里的
 * row(editor,explorer)）时，其内部 leaf 全 hidden 也判不出，导致该支仍按 weight
 * 占位、兄弟格（终端/对话区）不铺满（2026-08-28 走查两问题根因）。
 * detachedSlots（运行时脱出）只作用于 leaf，branch 不判——脱出是临时态。
 */
export function nodeAllHidden(node: GridNode): boolean {
  if (node.type === 'leaf') return node.hidden === true
  return node.children.every(nodeAllHidden)
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

  // 钉住的 leaf 不可被拖入 split（新槽位落到它四边会改变它的位置/归属）。
  if (isPinnedSlot(tgt.node.slot)) return root

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
  // 钉住的 leaf 不可被摘除（防御：drop 拖走的 source 拦截已覆盖，这里兜底）。
  if (found.node.type === 'leaf' && isPinnedSlot(found.node.slot)) return root
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
 * 调整某分支里两个相邻子节点间的 sash（带传导推动）。
 * delta>0 = 左/上侧（sashIndex）变大、推向右/下方；delta<0 = 右/下侧变大、
 * 推向左/上方。份额总量守恒，只在被推动的一侧内部转移：
 *   - 先与紧贴 sash 的邻格互相消长（邻格最多让到自己的 min）；
 *   - 邻格顶到 min 后仍有未消化的 delta 时，**沿推动方向向同分支后续格传导**：
 *     下一格让出自己的富余（当前值 − 自身 min），逐格传递，直到 delta 耗尽或
 *     该方向没有任何余量（2026-08-27 用户定调：隔壁到 min 后推动该方向仍有
 *     余量的区域，直到无余量为止）。传导只在同分支内进行，不跨嵌套下钻。
 * 被拉动侧自身也夹到自己的 min（不会为给对侧让路而压过 min）。
 * 各格最小份额 = 各侧子树的 subtreeMinSize（SlotMeta 声明 + 兜底）；minWeight
 * 显式传入时覆盖紧贴 sash 的两侧（保留给特殊调方）。
 */
export function resizeBranch(root: GridNode, branchId: string, sashIndex: number, delta: number, minWeight?: number): GridNode {
  if (delta === 0) return root
  const tree = cloneNode(root)
  const found = findNode(tree, branchId)
  if (!found || found.node.type !== 'branch') return root
  const branch = found.node
  const i = sashIndex
  if (i < 0 || i >= branch.weights.length - 1) return root
  const isRow = branch.direction === 'row'
  const mins = branch.children.map(c => subtreeMinSize(c, isRow))
  if (minWeight !== undefined) { mins[i] = minWeight; mins[i + 1] = minWeight }

  if (delta > 0) {
    // 左侧 i 要增大：从右侧 i+1, i+2, ... 依次取富余（各让到 min 为止）。
    let want = delta
    // i 自身也有上限？无——i 可以无限增大（只受对侧能让出多少限制）。
    for (let j = i + 1; j < branch.weights.length && want > 0; j++) {
      const slack = Math.max(0, branch.weights[j] - mins[j])
      const give = Math.min(slack, want)
      branch.weights[j] -= give
      want -= give
    }
    const gained = delta - want // 实际从右侧凑到的量
    branch.weights[i] += gained
  } else {
    // 右侧 i+1 要增大：从左侧 i, i-1, ... 依次取富余。
    let want = -delta
    for (let j = i; j >= 0 && want > 0; j--) {
      const slack = Math.max(0, branch.weights[j] - mins[j])
      const give = Math.min(slack, want)
      branch.weights[j] -= give
      want -= give
    }
    const gained = -delta - want
    branch.weights[i + 1] += gained
  }
  return tree
}

/**
 * 窗口尺寸变化时按当前比例重标定所有分支的 weights 到新总宽（自适应）。
 * weights 是像素；窗口缩放时各列等比缩放，不截断、不溢出。row 分支沿宽度
 * 缩放、column 分支沿高度缩放——按方向分别处理。
 */
export function rescaleGrid(node: GridNode, width: number, height: number): GridNode {
  const scale = (branch: BranchNode, span: number): void => {
    // 主轴方向各格最小尺寸 = 各子树的 subtreeMinSize（SlotMeta 声明 + 兜底）。
    const isRow = branch.direction === 'row'
    const mins = branch.children.map(c => subtreeMinSize(c, isRow))
    const total = branch.weights.reduce((a, b) => a + b, 0)
    if (total <= 0 || span <= 0) return
    // 先按比例分配。
    let ws = branch.weights.map((w) => (w / total) * span)
    // 每格至少自己的 min；但若 Σmin 超过可用空间（窗口太窄），按各格 min 的
    // 比例分配（而非等比平分）——保住各区域声明的最小比，小窗不丢布局、
    // 大窗恢复后仍贴近用户拖的比例，绝不溢出截断。
    const minTotal = mins.reduce((a, b) => a + b, 0)
    if (minTotal >= span) {
      branch.weights = mins.map((m) => (m / minTotal) * span)
      return
    }
    // 正常：夹 min，夹取的差额从仍有富余的格里补给（保持 Σ = span）。
    let deficit = 0
    ws = ws.map((w, i) => {
      if (w < mins[i]) { deficit += mins[i] - w; return mins[i] }
      return w
    })
    if (deficit > 0) {
      const slack = ws.reduce((a, w, i) => a + Math.max(0, w - mins[i]), 0)
      if (slack > deficit) {
        ws = ws.map((w, i) => (w > mins[i] ? w - (Math.max(0, w - mins[i]) / slack) * deficit : w))
      } else {
        // 富余不够补差额（多格同时低于 min）：按各格 min 比例分配（与上面
        // minTotal>=span 分支同策略），保证 Σ=span 恒成立、绝不溢出、不丢最小比。
        branch.weights = mins.map((m) => (m / minTotal) * span)
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
