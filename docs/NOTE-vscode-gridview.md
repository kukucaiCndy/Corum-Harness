# NOTE：VSCode 二维网格控件实现研究（为 corum IDE GridView / S1+ 准备）

> 源码：microsoft/vscode main（经 GitHub Contents API 取 raw；raw.githubusercontent.com 被墙）。
> 本地缓存：`/tmp/vscode-sash/`（sash.ts/sash.css/splitview.ts/splitview.css/grid-gridview.ts/dom.ts/event.ts）。
> 本文提炼机制，不贴大段源码。对应我们的实现：`packages/plugins/ui/ide-shell/src/client/{grid.ts,GridView.tsx}`。

---

## 0. 三层控件的职责分工

| 控件 | 职责 | 我们对应 |
|---|---|---|
| **Sash**（sash.ts, 708行） | 单条分割缝的**拖拽手势**：mousedown + window 级 move/up + 全局 cursor/iframe 防护 + hover 高亮。只发事件（start/change/end/reset），不管布局。 | GridView.tsx `Sash` 组件（已照抄） |
| **SplitView**（splitview.ts, 1504行） | **一维**分割：一排 view + 各 view 尺寸 + view 间 sash。负责 resize 让位算法、min/max 夹取、snap 折叠、proportionalLayout 缩放、distributeEmptySpace 消残差。 | grid.ts `resizeBranch`（简版） |
| **GridView**（gridview.ts, 1842行） | **二维**分割：SplitView 的递归嵌套（BranchNode=SplitView，LeafNode=view）。负责 addView/removeView/moveView/swapViews 的树操作、boundarySashes 边界缝、2x2 检测、序列化。 | grid.ts `dropLeaf/prune`（简版） |

关键：**GridView 不重新发明布局**——BranchNode 内部就是一个 SplitView，LeafNode 包装 IView。我们的 grid.ts 把这三层压平成了「树 + weights + flex」，机制对应但简化了很多。

---

## 1. Sash 拖拽手势（已照抄，核心确认）

- **mousedown（非 pointerdown）、无 setPointerCapture**；move/up 挂 `el.ownerDocument.defaultView`（window）——`MouseEventFactory`（sash.ts L181–189）。
- **防文本选择**：mousedown `preventDefault()` + 拖拽期注入 `<style>*{cursor:X!important}</style>`（修 issue #21675）。**无 user-select class、无 cover div**（我们额外加了 user-select:none，更保险）。
- **防 iframe 抢占**：拖拽期给所有 iframe `pointer-events:none`（L539–542）。
- 把手本体就是命中区：`--vscode-sash-size: 4px`、`z-index:35`、`touch-action:none`；hover 高亮条用 `::before`（`pointer-events:none`）。
- hover 延迟 300ms（Delayer，L154）。

## 2. SplitView resize 让位算法（splitview.ts L1235–1321）

拖 sash i 时 `upIndexes=[i..0]`、`downIndexes=[i+1..n-1]`：
1. **先整体夹 delta**：`minDelta = max(Σ_up(min-size), Σ_down(size-max))`、`maxDelta = min(Σ_down(size-min), Σ_up(max-size))`，再与 dragStart 预算的 overloadMin/Max 取交集 → `clamp(delta)`。
2. **再逐 view 吸收**：up 侧从近到远 `clamp(size+delta)`、残差外传；down 侧对称减。**紧邻先动，顶到 min/max 自动传导**。
3. `LayoutPriority.High/Low` 只改 up/down 数组遍历顺序（pushToStart/pushToEnd），决定谁先让位。
4. `distributeEmptySpace()`：总尺寸 vs Σview 的残差，按 priority 逐个吸收，消浮点/夹取误差。
5. **snap**：view 标 `snap:true` 后，拖过 `floor(minSize/2)` 即 `setVisible(false)`（缓存尺寸），反向拖回恢复（L940–960）。

> 我们的 `resizeSash` 已实现 1+2（双向夹取+逐列吸收）。**没做**：snap 折叠、priority、distributeEmptySpace（flex 布局天然消残差，不需要）。

## 3. SplitView proportionalLayout（splitview.ts L841–882）

容器尺寸变化时 `layout(size)`：
- `proportions` 已存（`saveProportions` 在拖拽结束/relayout 时存 `size/contentSize`）→ **按比例分配**：`item.size = clamp(round(proportion*size/total), min, max)`。
- 否则把增量全塞给最后一个 view（走 resize）。
- `proportionalLayout: false` 时可逐 view 关掉比例（保持绝对尺寸）。

> 我们的实现：`computeCellSizes`（GridView.tsx）= proportionalLayout 的对应物——可见格按 weight 占比瓜分容器主轴 span（脱出格 size=0），每格 min 150px 夹取，Σmin 超容器时等比压缩到正好放下。容器尺寸用 ResizeObserver（rAF 节流）监听，useLayoutEffect 里直接写 DOM style，不经 setState。

## 4. GridView 树操作（gridview.ts）

### GridLocation = number[]
每个 view 的地址是**路径下标数组**（`[分支下标, 子下标, 孙下标, …]`），`tail()` 取末位下标+剩余路径。我们用 **节点 id + findNode 递归** 替代（React key 也需要稳定 id），语义等价。

### addView（L1209）—— 拆分插入
- 目标是 BranchNode 的子位 → 直接 `parent.addChild(node, size, index)`（同向插入）。
- 目标是 LeafNode → **包装**：`grandParent.removeChild(parentIndex)` → 新建 `BranchNode(parent.orientation)` 放回原位 → 旧 leaf 和新 leaf 作为两个子加进去。即「反向拆分时把目标包成新分支」。
- `Sizing.Split(n)` = 从被拆的 view 分出 n px。

> 我们的 `dropLeaf` 四边拆分已实现这套（同向 splice / 反向包 wrapper），语义一致。

### removeView + 树剪枝
- removeView 后若分支只剩一个子 → 该子提升（collapse 单子分支）。我们的 `prune()` 同款。
- `DistributeSizing` / `AutoSizing`：删 view 后空间怎么分给邻居（我们让 flex 自动吸收，更简单）。

### moveView / swapViews（L1356/1378）
- moveView = 同分支内 `moveChild(from, to)`（重排）。
- swapViews = 两 leaf 交换 view 引用 + 保留各自尺寸。
> 我们的 center drop = 交换 slot（内容）而非交换 leaf——等价且更简单（尺寸天然跟随窗格不动）。

### boundarySashes（L364–390，深读）
GridView 特有：相邻**大分支之间**的边界缝（跨整个网格的连续 sash 线）。机制是**四边界引用 + 递归下发**：
- 每个 BranchNode 记 `{start, end, orthogonalStart, orthogonalEnd}` 四条边界 Sash（前两条是自身主轴方向、后两条是正交方向）。
- 父节点 `set boundarySashes` 时递归下发给每个子节点（L378–389）：
  - **正交边界直接透传**：`start/end`（子的）= 父的 `orthogonalStart/orthogonalEnd`。
  - **主轴边界按位置继承**：首子的 `orthogonalStart` = 父的 `start`，末子的 `orthogonalEnd` = 父的 `end`；中间子的对应边界 = 它在父 splitview 里相邻的 `sashes[index-1]`/`sashes[index]`。
- 同时把 `orthogonalStart/End` 写进自己的 `splitview.orthogonalStartSash/orthogonalEndSash`——SplitView 用这两条决定**角把手**（orthogonal-drag-handle，all-scroll 光标，同时调两维）的位置。

**效果**：多层嵌套时，跨分支的 sash 在视觉上连成一条直线，拖一条边界缝能同时调整多个嵌套层级（因为它实际是同一条 Sash 对象的引用，一处 drag 触发所有持有它的 splitview 联动）。
**配套的 edgeSnapping（L392–408）**：递归开关 + `updateSplitviewEdgeSnappingEnablement()`，控制 sash 拖到容器边缘时的吸附/折叠使能。

> 我们暂未做——目前嵌套浅（≤2 层），sash 在各分支内独立。**S1+ 深嵌套要补的核心**：给 grid.ts 的分支节点记四边界 sash 引用，set 时按上规则递归下发；React 里可把 sash 做成共享对象（同一缝多处渲染、一处 drag 联动）。

### LayoutController / ILayoutContext / onDidSashReset（深读补充）
- **LayoutController**（L200）极简：只持 `isLayoutEnabled` 开关，门控整个网格是否响应布局。
- **ILayoutContext**（L216–222）：布局时沿树下发的上下文 `{orthogonalSize, absoluteOffset, absoluteOrthogonalOffset, absoluteSize, absoluteOrthogonalSize}`——**绝对坐标**。BranchNode.layout 时累加自己的 offset（L491–498）再下发。用途之一是 `updateSplitviewEdgeSnappingEnablement`（L731–732）：`startSnappingEnabled = edgeSnapping || absoluteOrthogonalOffset > 0`、`endSnappingEnabled = edgeSnapping || absoluteOrthogonalOffset + size < absoluteOrthogonalSize`——即**只有贴到容器边缘的 sash 才允许吸附折叠**，中间的缝不吸附。
- **onDidSashReset（双击 sash 重置）**：SplitView 的 `onDidSashReset(index)` 经 `Event.map(i => [i])` 包装、再沿子链 `Event.map(c.onDidSashReset, loc => [i, ...loc])` 逐级前缀，冒泡成 GridView 顶层 `Event<GridLocation>`（L359/462/663–665）——**双击任意嵌套层的 sash，顶层能拿到完整路径**，上层据此均分该分支（VSCode 编辑器「双击缝等宽」）。
- **cachedVisibleSize**（L636）：snap 折叠（`setVisible(false)`）后 splitview 记住该 view 折叠前尺寸，`getChildCachedVisibleSize` 取出供 addView 时以 `Sizing.Invisible(cached)` 恢复（L1223–1227）——**折叠再展开能回到原尺寸**。

> React 移植要点：绝对 offset 可用 CSS 布局替代（不需要手算）；sash 双击重置 = 给 sash 加 `onDoubleClick` 冒泡 branchId，上层均分 weights；snap 折叠恢复 = 收起时把 weights 存进节点，展开时还原。

### 2x2 检测（trySet2x2）
VSCode 检测「正好 4 个 view 成 2x2」时给特殊的四向 sash 交点把手（corner，all-scroll 光标，同时调两个维度）。
> 未做。低优先级。

### maximizeView（L1542）
某 view 最大化（其余隐藏），exitMaximizedView 恢复。编辑器「 maximize group 」。
> 未做。可作为 S1 增强（窗格标题加「最大化」按钮）。

## 5. 序列化（L1700+）

- `toJSON()`：树递归序列化（branch={orientation, children, size/orthogonalSize}，leaf=view 数据），ISerializableView + deserializer 复活。
- 我们的 `serializeGrid/deserializeGrid`（grid.ts）同款，但**尺寸用 weights（相对份额）而非绝对 px**——更适配窗口 resize（比例布局），重启后不需按当时窗口宽重标定。这是有意简化。

## 6. 我们与 VSCode 的关键取舍

| 维度 | VSCode | 我们（grid.ts/GridView.tsx） | 理由 |
|---|---|---|---|
| 布局 | absolute + JS 算 left/top | 绝对定位 + JS 计算（照 SplitView layoutViews：容器 relative，cell absolute，主轴累加 offset，ResizeObserver + useLayoutEffect 直接写 DOM style） | flex flexGrow 会在 sash 拖动改份额时把影响传导到非相邻格；flexBasis 像素又失去窗口缩放自适应——只能照 SplitView 用 JS 布局同时满足「拖动不传导 + resize 等比」 |
| 尺寸 | 绝对 px + proportions | weights 存像素（主轴目标尺寸），proportionalLayout 式按占比重标定 + min 150 夹取（Σmin 超容器时等比压缩） | sash 拖动只转移相邻两格像素（resizeBranch），非相邻格严格不变；容器变化按占比缩放 |
| 定位 | GridLocation=number[] 路径 | 节点 id + findNode | React key 需稳定 id；语义等价 |
| 交换 | swapViews 换 view 引用 | center drop 换 slot | 尺寸跟随窗格，更简单 |
| snap 折叠 | 有 | 无（用脱出借位） | 脱出/收起已覆盖类似诉求 |
| 边界 sash | boundarySashes 对齐 | 未做（嵌套浅） | S1+ 深嵌套时补 |
| 最大化 | 有 | 未做 | S1 增强项 |

## 7. 对 S1+ 的建议

1. **深嵌套 boundarySashes**：若用户拖出 3+ 层嵌套，相邻大分支的 sash 线断开难看——实现 gridview.ts 的 boundarySashes 对齐机制（每个分支记四边界 sash，递归下发）。
2. **窗格最大化**：leaf 标题加「最大化」按钮 → maximizeView（其余 sibling 临时隐藏），再点恢复。
3. **snap 折叠**：sash 拖过 `floor(minWidth/2)` 时窗格临时收起（`setVisible(false)` + 缓存尺寸），反向拖回恢复——比现在的「脱出/关闭」更轻量。
4. **2x2 角把手**：四格成 2x2 时给中心交点一个 all-scroll 把手，同时调两维。
5. **触屏**：现在 sash/DnD 都是 mousedown/HTML5 DnD（桌面鼠标）。若支持触屏需换 pointer events + VSCode Gesture 那套。
6. **拖拽中的 ghost/preview**：VSCode 编辑器拖放有半透明 ghost 跟随鼠标 + 目标区实时预览拆分线。我们目前只有目标区高亮，可加 ghost 提升手感。
7. **序列化版本迁移**：STORAGE_KEY 已带 `v1`，结构演进时 bump + 迁移函数。

---

## 附：关键常量

- `SASH_SIZE = 4px`（命中区=把手本体）；`z-index 35`（sash）/ 100（角把手）
- hover 延迟 300ms；snap 阈值 `floor(minSize/2)`
- `proportionalLayout` 默认 true；`Sizing.Split/Invisible/Distribute/Auto`
- GridLocation = number[] 路径
