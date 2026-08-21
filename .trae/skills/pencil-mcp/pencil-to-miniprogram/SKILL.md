---
name: "pencil-to-miniprogram"
description: "Converts Pencil MCP .pen design files to WeChat Mini Program code (WXML+WXSS+JS) with precise 1:1 visual replication. Invoke when user needs to implement a page from a Pencil design file."
---

# Pencil → 微信小程序 标准工作流

## ⛔ 脑补禁令（最高优先级）

> **设计稿是唯一事实来源。任何代码中的数值、颜色、文本、布局都必须能在设计稿数据中找到对应来源。如数据缺失或不完整，必须重新查询设计稿，禁止凭经验/习惯/审美补全。**

违反禁令的典型行为：
- 设计稿中某个区域的间距未读取到 → 自行估算一个值填进去 ❌
- 某个图标的颜色数据不完整 → 使用常见默认色 ❌
- 看到 `"..."` 截断标记 → 忽略它继续写代码 ❌
- 某个文本节点的内容被截断 → 从截图猜测文字 ❌

**正确做法**：数据不完整 → 提高 readDepth 重新查询 → 仍不完整 → 提高 searchDepth 重新查询 → 确认获取完整数据后才写代码。

## 前置条件

- Pencil MCP 已加载目标 `.pen` 文件
- 已通过 `mcp__pencil__get_editor_state` 确认设计稿处于活动状态
- 已知目标页面的 frame 节点 ID（如 `RweGQ`）

## 核心工具

| 工具 | 调用方式 | 输出 | 用途 |
|------|---------|------|------|
| `get_editor_state` | `mcp__pencil__get_editor_state()` | 顶层节点列表 + schema | **首选**：确认文件已加载，获取页面 ID |
| `batch_get` | `mcp__pencil__batch_get()` | 节点属性树 | **核心**：读取尺寸、颜色、文本、层级 |
| `snapshot_layout` | `mcp__pencil__snapshot_layout()` | 布局矩形 | **辅助**：获取精确 x/y/width/height |
| `get_screenshot` | `mcp__pencil__get_screenshot()` | PNG 截图 | **验证**：开发完成后对照设计稿 |
| `get_variables` | `mcp__pencil__get_variables()` | 设计变量 | **参考**：颜色、字体、间距 token |

## 流程总览

> **⛔ 6 步必须按顺序执行，每步有明确的「进入条件」和「完成标志」。不得跳步、不得合并步骤、不得在数据未完整时进入下一步。**

```
① 读取设计稿数据
   进入条件：Pencil MCP 已加载 .pen ✓
   完成标志：所有 5 个调用返回 ✓ + 无 `"..."` 截断 ✓ + 截断检测通过 ✓
       ↓
② 提取关键信息
   进入条件：① 完成标志全部满足
   完成标志：提取表完整 ✓（文本/尺寸/颜色/字体/间距/效果/图标 7 类全有值）
       ↓
③ 编写 WXML
   进入条件：② 完成标志全部满足
   完成标志：每个设计稿区域都有对应的 WXML 结构 ✓
       ↓
④ 编写 WXSS
   进入条件：③ 完成标志全部满足
   完成标志：每个样式值都从 ② 提取表换算得来 ✓
       ↓
⑤ 对接 JS 和交互
   进入条件：④ 完成标志全部满足
   完成标志：事件绑定 + 默认数据处理完成 ✓
       ↓
⑥ 走查验证
   进入条件：⑤ 完成标志全部满足
   完成标志：3 遍走查全部通过 ✓
```

---

## ① 读取设计稿数据（不可缩减）

> **⛔ 以下 5 个调用缺一不可，必须并行发起。调用完成后，必须先通过「截断检测」和「完整性验证」才能进入 ②。**

### 1.1 并行发起 5 个调用

```javascript
// 1. 确认文件状态和获取顶层节点 ID
mcp__pencil__get_editor_state({ include_schema: true })

// 2. 读取目标页面完整节点树
mcp__pencil__batch_get({
  filePath: ".../design.pen",
  nodeIds: ["目标页面FrameID"],
  readDepth: 8,           // ⚠️ 强制最小 8，不设上限。页面的多层嵌套必须全部展开
  resolveVariables: true   // ⚠️ 必须：获取解析后的 hex 值
})

// 3. 获取精确布局（用于间距计算）
mcp__pencil__snapshot_layout({
  filePath: ".../design.pen",
  parentId: "目标页面FrameID",
  maxDepth: 6              // ⚠️ 强制最小 6，确保穿透所有区域层
})

// 4. 获取截图（第一步就获取，全程对照）
mcp__pencil__get_screenshot({
  filePath: ".../design.pen",
  nodeId: "目标页面FrameID"
})

// 5. 获取设计变量
mcp__pencil__get_variables({ filePath: ".../design.pen" })
```

### 1.2 截断检测（强制，调用返回后立即执行）

> **关键**：`batch_get` 返回的节点属性中，如果值显示为 `"..."` 字符串，说明 readDepth 不够深，该节点的内部属性被截断了。**必须立即重新查询，不得带着截断数据进入 ②。**

**检测方法**：逐节点检查 batch_get 返回结果中每个子节点的以下属性：
- `children`：是否为 `"..."` → 子节点被截断
- `fontSize`、`fontFamily`、`fontWeight`：是否为 `"..."` → 文本样式被截断
- `padding`、`gap`：是否为 `"..."` → 布局属性被截断
- 任何属性值为 `"..."` → **截断确认**

**截断处理流程**：

```
检测到任何 "..." 截断
       ↓
提高 readDepth：当前值 × 2（如 8→16）
       ↓
重新调用 batch_get（保持其他参数不变）
       ↓
再次截断检测
       ↓ 仍有截断
继续提高 readDepth（不设上限，直到无截断）
       ↓ 无截断
进入 1.3 完整性验证
```

### 1.3 完整性验证（截断检测通过后执行）

> **确认获取了页面的所有信息，没有任何遗漏。**

| 验证项 | 检查方法 | 不通过处理 |
|--------|---------|-----------|
| 所有 texto 节点的 `content` 可读 | 逐 text 节点检查无截断 | 提高 readDepth 重新查询 |
| 所有 frame 节点的 `width`/`height` 可读 | 逐 frame 节点检查尺寸为具体数值 | 提高 readDepth 重新查询 |
| 所有颜色值为具体 hex（非 `$primary` 等引用） | `resolveVariables: true` 确保了解析 | 确认参数后重新查询 |
| 所有 icon 节点的 `icon` 和 `library` 可读 | 逐 icon 节点检查 | 提高 readDepth 重新查询 |
| 所有 effect 节点的 shadow 属性完整 | 逐 effect 检查 blur/color/offset | 提高 readDepth 重新查询 |
| snapshot_layout 返回了所有区域的坐标 | 对比 batch_get 的 frame 数量与 snapshot 的矩形数量 | 提高 maxDepth 重新查询 |

> **⛔ 完整性验证不通过 → 回到 1.2 重新查询。全部通过后才能进入 ②。**

---

## ② 提取关键信息（防止遗漏，禁止脑补）

> **⛔ 本步骤的目标：将第 ① 步返回的所有设计稿数据整理为结构化的提取表。表中每个值都必须能从设计稿数据中找到来源行。本步骤不写任何代码，只产出提取表。**

### 2.0 先输出提取表，后写代码

> **顺序铁律**：在开始编写 WXML 之前，必须先把以下 7 张提取表全部输出。表中任何一个「—」空值都是未提取完成的信号，不得进入 ③。

> **⛔ 强制确认机制**：提取表输出后，**必须暂停并等待用户确认**。话术：
> "以上是设计稿数据提取表，请核对数值是否与设计稿一致。确认无误后回复「确认」，我将开始编写代码。"
>
> **不得在同一轮回复中连续输出提取表和代码。** 用户回复「确认」或「无误」后，才进入 §③。

### 2.1 必须提取的七类信息

| 类别 | 提取内容 | 用途 | 缺失处理 |
|------|---------|------|---------|
| **文本** | 所有 `text` 节点的 `content` | 确保 WXML 无遗漏 | 提高 readDepth 重新 batch_get |
| **尺寸** | `width`, `height`, `x`, `y` | 换算 rpx，计算间距 | 用 snapshot_layout 补全 |
| **颜色** | `fill`, `color`, `stroke` | WXSS 精确还原 | 提高 readDepth 重新 batch_get |
| **字体** | `fontFamily`, `fontSize`, `fontWeight` | 字体栈 + rpx 换算 | 提高 readDepth 重新 batch_get |
| **间距** | `padding`, `gap`, `layout` | flex 布局参数 | 提高 readDepth 重新 batch_get |
| **效果** | `cornerRadius`, `effect`(shadow) | 圆角 + 阴影换算 | 提高 readDepth 重新 batch_get |
| **图标** | `icon`, `library`, `fill` | 导出 PNG 或映射替代方案 | 提高 readDepth 重新 batch_get |

> **⛔ 以上 7 类的任何缺失都不是跳过该类的理由，而是重新查询设计稿的命令。**

### 2.2 提取表输出格式（模板）

提取完成后，必须以下列格式输出。**每行标注数据来源（batch_get 节点路径 或 snapshot_layout 坐标）。**

```
=== 页面：[页面名称] (FrameID: xxx) ===

## 文本提取表
| 节点路径 | 文本内容 | 用途（标题/按钮/标签/描述） |
|---------|---------|-------------------------|
| Header/Title | "我的学习" | 页面标题 |

## 尺寸提取表
| 节点路径 | W(px) | H(px) | X(px) | Y(px) | 数据来源 |
|---------|-------|-------|-------|-------|---------|
| PageFrame | 375 | 812 | 0 | 0 | snapshot_layout |

## 颜色提取表
| 节点路径 | 属性 | Hex 值 | 用途 |
|---------|------|--------|------|
| Header | fill | #FFFFFF | 导航栏背景 |

## 字体提取表
| 节点路径 | fontFamily | fontSize(px) | fontWeight | 数据来源 |
|---------|-----------|-------------|------------|---------|
| HeroCard/Title | Inter | 18 | 600 | batch_get readDepth:8 |

## 间距提取表
| 父节点路径 | 属性 | 值(px) | 影响子节点 |
|-----------|------|--------|-----------|
| QuickActionsRow | gap | 12 | actionBtn1, actionBtn2... |

## 效果提取表
| 节点路径 | cornerRadius(px) | shadow blur(x,y,color) | 数据来源 |
|---------|-----------------|----------------------|---------|
| HeroCard | 16 | (0,6,20,#2D3E5F25) | batch_get readDepth:8 |

## 图标提取表
| 节点路径 | library | icon | fill | 处理方案 |
|---------|---------|------|------|---------|
| QuickActions/Btn1 | lucide | trophy | #2D3E5F | export_nodes→PNG |
```

### 2.3 提取表完整性检查

> **输出提取表后，逐项检查以下条件。任何一项不满足 → 不得进入 ③。**

| # | 条件 | 不满足则 |
|---|------|---------|
| 1 | 每个文本节点都有内容且无 `"..."` | 提高 readDepth 重新 batch_get |
| 2 | 每个 frame 节点都有 width/height 数值 | 用 snapshot_layout 补全 |
| 3 | 所有颜色值都是 hex（非 `$primary` 引用） | 检查 resolveVariables，重新 batch_get |
| 4 | 所有字体值都是具体数值 | 提高 readDepth 重新 batch_get |
| 5 | 所有 gap/padding 都是具体 px 数值 | 提高 readDepth 重新 batch_get |
| 6 | 每个 icon 节点都有 library+icon+fill | 提高 readDepth 重新 batch_get |
| 7 | 间距交叉计算表已生成（见下方） | 补充计算 |

### 间距交叉计算表（⚠️ 必须执行）

提取所有 section 的 `y` 和 `height`，计算相邻 gap。不计算直接写 margin 必出错。

```
Section          y(px)  h(px)  bottom(px)  y(rpx)  h(rpx)  bottom(rpx)  gap(rpx)
Header            0      96      96          0      192      192          -
HeroCard         100    160     260        200     320      520          520-192=8
QuickActions     274     82     356        548     164      712          712-520=28  (用 snapshot_layout!)
ProgressSection  366    152     518        732     304     1036         1036-712=20
RecommendSection 524    182     706       1048     364     1412         1412-1036=12
TabBar           728     84     812       1456     168     1624         1624-1412=48
```

**⚠️ 关键**：`batch_get` 返回的 x/y 是设计值（可能有 0.5px 偏移），`snapshot_layout` 返回的才是实际渲染位置。间距大时优先用 snapshot_layout 数据。

### 父子 gap 优先级规则（⚠️ 高频遗漏点）

设计稿中父容器 `gap` 控制子元素间距时，**子元素不应再设置 margin**，否则间距叠加翻倍。

```
正确：父 gap + 子无 margin → 间距 = gap
错误：父 gap + 子 margin-bottom → 间距 = gap + margin  ❌ 双重叠加
```

走查时，必须逐区检查：
1. 父容器是否有 `gap` 属性？→ 用 `gap: Npx → 2N rpx` 写在父级 CSS
2. 子元素是否有自己的 `margin-top/bottom`？→ 如果父已有 gap，移除子上的 margin
3. 子元素的排列顺序是否与设计稿一致？→ 装饰元素（金线等）作为最后一个子节点时，CSS 顺序也必须匹配

### 阴影透明度换算表

Hex alpha 最后两位 → rgba 小数：

| Hex Alpha | rgba 小数 | 示例 |
|-----------|----------|------|
| FF | 1.0 | #FFFFFF |
| 80 | 0.502 | #FFFFFF80 |
| 25 | 0.145 | #2D3E5F25 |
| 20 | 0.125 | #FFFFFF20 |
| 10 | 0.0625 | #00000010 |
| 06 | 0.0235 | #00000006 |
| 0A | 0.0392 | #0000000A |
| 04 | 0.0156 | #00000004 |

### 图标处理决策树（⚠️ 高频出错点）

```
设计稿中的 icon 节点
  ├── library: "lucide" / "feather" 等矢量图标库
  │     └── ⚠️ 小程序无法直接使用！必须导出为 PNG
  │           1. mcp__pencil__export_nodes({ nodeIds: [iconFrameId], scale: 2 })
  │           2. 保存到 /assets/images/icons/
  │           3. 用 <image> 标签引用
  │           ❌ 禁止：用 deco 通用装饰图替代
  │           ❌ 禁止：用 emoji 替代（渲染不一致）
  │
  ├── type: "image" fill（已生成图片）
  │     └── 直接使用 url 指向的图片路径
  │
  └── 纯 CSS 可实现（简单几何形状）
        └── 用 WXSS 绘制
```

### 尺寸换算规则（px → rpx）

微信小程序以 iPhone 6/7/8 的 375px 宽度为基准，换算关系：

```
1 px = 2 rpx
```

| px | rpx | 常见场景 |
|:--:|:---:|:---------|
| 8 | 16 | 进度条粗、缩略图圆角 |
| 10 | 20 | tab标签/状态标签字号、圆角 |
| 11 | 22 | 描述文字 |
| 12 | 24 | 间距/内边距/图标圆角 |
| 13 | 26 | 标签/按钮字号 |
| 14 | 28 | 导航/状态栏字号 |
| 15 | 30 | 条目标题字号 |
| 16 | 32 | 卡片圆角/section字号 |
| 18 | 36 | 应用名/导航标题 |
| 20 | 40 | tab图标/大标题/按钮圆角 |
| 24 | 48 | 头像圆角 |

### 阴影换算规则

```
设计稿: blur:20, color:#2D3E5F25, offset:{x:0, y:6}
→ WXSS: box-shadow: 0 12rpx 40rpx rgba(45, 62, 95, 0.15);

规则: offsetX×2, offsetY×2, blur×2, 颜色不变
```

---

## ③ 编写 WXML

### 核心原则

1. **`<image>` 标签代替 WXSS background-image**

   > ⚠️ **关键限制**：微信小程序 WXSS 中不能使用本地资源路径作为 `background-image`。必须改用 `<image>` 标签。

   ```xml
   <!-- ❌ 错误：WXSS 中不能使用 -->
   <!-- .card { background-image: url('/assets/images/bg.png'); } -->

   <!-- ✅ 正确：使用 <image> 标签绝对定位 -->
   <view class="card">
     <image class="bg-image" src="/assets/images/bg/bg_card.png" mode="aspectFill" />
     <view class="card-content">
       <!-- 内容 -->
     </view>
   </view>
   ```

   ```css
   .card {
     position: relative;
     overflow: hidden;
   }
   .bg-image {
     position: absolute;
     top: 0;
     left: 0;
     width: 100%;
     height: 100%;
     z-index: 0;
   }
   .card-content {
     position: relative;
     z-index: 1;
   }
   ```

2. **结构分层**：每个需要背景图的容器都使用 `position: relative` + `overflow: hidden`，内部用 `.bg-image` + `.card-content`

3. **装饰元素**：使用 `position: absolute` 精确定位，添加 `pointer-events: none` 和 `z-index: 2`

4. **scroll-view 注意事项**：
   - padding 放在 inner 容器上，不要直接放在 scroll-view 上
   - 如果装饰元素需要跟随滚动，放在 scroll-inner 内；如果固定，放在 scroll-view 外
   - ⚠️ **scroll-view 不能用 `flex:1` 自适应高度**：微信小程序 `scroll-view` 组件对 CSS `flex:1` 支持不可靠，会按**内容实际高度**渲染而非 flex 分配高度。在底部弹窗 / 固定头尾布局中，会导致内容撑破父容器，把底部按钮推出 `overflow:hidden` 可见区被裁掉。
   - ⚠️ **`calc(vh - rpx)` 混单位也不可靠**：`height: calc(92vh - 268rpx)` 混用视口百分比和响应式像素两种基准不同的单位，部分基础库版本计算不正确。
   - ✅ **推荐方案：绝对定位**。父容器 `position: relative`，scroll-view 用 `position: absolute; top: 固定头高度; bottom: 固定尾高度;` 占据中间区域，底部按钮用 `position: absolute; bottom: 0;` 固定。完全不依赖 flex 或 calc：
     ```css
     /* ❌ 错误方案1：flex:1 在 scroll-view 中无效 */
     .scroll-area { flex: 1; min-height: 0; }

     /* ❌ 错误方案2：calc 混用 vh 和 rpx 不可靠 */
     .scroll-area { height: calc(92vh - 268rpx); }

     /* ✅ 正确方案：绝对定位，100% 可靠 */
     .sheet { height: 92vh; position: relative; overflow: hidden; }
     .scroll-area { position: absolute; top: 132rpx; left: 0; right: 0; bottom: 136rpx; }
     .actions { position: absolute; bottom: 0; left: 0; right: 0; height: 136rpx; }
     ```

5. **布局策略决策树（⚠️ 高频出错点）**：

> **关键**：设计稿父节点的 `layout` 属性决定了 WXSS 的布局策略。选择错误的布局策略是页面对不齐、溢出的根源。

```
设计稿父节点 layout 属性？
├── "vertical" / "horizontal"
│   → 子元素用流式布局
│   → WXSS: display:flex; flex-direction:column/row; gap:Nrpx
│   → 子元素 margin 由父 gap 控制，不得自行加 margin
│
└── "none"（绝对定位，每个子元素有精确 x/y）
    ├── 整个 page 都是 layout: "none"
    │   → 所有子元素用 position: absolute; top/left 精确还原
    │   → ⛔ 禁止给父容器加 display:flex / align-items:center
    │   → ⛔ 禁止依赖 margin 模拟间距（设计稿无 margin 概念）
    │   → 子元素 top = y × 2 rpx, left = x × 2 rpx
    │
    └── 仅部分装饰元素是绝对定位
        → 主体用流式布局，装饰元素用 position: absolute
        → 装饰元素添加 pointer-events: none
```

**⛔ layout: "none" 的常见错误**：

| 错误做法 | 为什么错 | 正确做法 |
|---------|---------|---------|
| 给父容器加 `display:flex` + `align-items:center` | 设计稿是绝对定位，x/y 坐标表达了精确位置；flex 居中会覆盖 x 坐标，元素全部居中偏移 | 父容器 `position: relative`，子元素逐个 `position: absolute; top; left` |
| 用 `margin-top` 模拟子元素间距 | 设计稿无 margin 概念，间距来自 y 坐标差；margin 依赖流式布局，绝对定位下无效 | 间距 = 相邻子元素的 `(y₂ - y₁ - h₁)`，通过 top 差自然表达 |
| 忽略 x 坐标，默认子元素 `left: 0` | 设计稿 x=16 的元素会错位到左边缘 | 逐元素提取 x 坐标，设置 `left: x×2 rpx` |

---

## ④ 编写 WXSS

### 全局规则（必须写在页面级样式最前面）

```css
/* 所有元素统一盒模型 */
* {
  box-sizing: border-box;
}
```

> **⛔ box-sizing 铁律**：有 `border` 或 `padding` 的元素必须设置 `box-sizing: border-box`。否则实际渲染宽度 = 声明宽度 + border-left + border-right + padding-left + padding-right，会超出声明宽度导致溢出屏幕。

### 逐属性对照表

| 设计稿属性 | → WXSS | 换算规则 |
|:----------|:-------|:---------|
| `width/height` px | → rpx | `px × 2` |
| `font-size` px | → rpx | `px × 2` |
| `border-radius` px | → rpx | `px × 2` |
| `padding / margin` px | → rpx | `px × 2` |
| `box-shadow` | → rpx | `offset×2, blur×2`，颜色不变 |
| `background-color` / `color` | → 同 | `rgba(R,G,B,A) → #HEX`，透明度不变 |
| `position: absolute` + `top/left` | → 判断归属 | 用 top 归属图判断元素在哪个区域内 |

### 字体栈映射

| 设计稿字体 | 小程序替代方案 |
|:----------|:-------------|
| Playfair Display | `'Times New Roman', 'Georgia', serif` |
| Inter | `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` |

### 阴影结构决策树（⚠️ 高频出错点）

> **关键**：设计稿中的阴影有两种实现方式，对应完全不同的 DOM 结构。

```
设计稿阴影来源？
├── effect.shadow 属性（box-shadow 类型）
│   → WXSS: box-shadow: offset×2rpx offset×2rpx blur×2rpx color;
│   → 阴影是本元素的 CSS 属性，无需额外 DOM 节点
│
└── 独立矩形节点（fill #2D2D2D / 深色，与本体有 x/y 偏移）
    → 阴影是独立于本体的兄弟节点
    → ⚠️ 必须做成兄弟结构，不可做成父子包含
    → DOM 结构：
      <view class="save-btn-wrap">
        <view class="save-btn-shadow" />  <!-- 阴影在下 -->
        <view class="save-btn">保存</view>  <!-- 主体在上 -->
      </view>
    → 阴影 z-index 低于主体，靠偏移量产生手绘错位效果
    → 阴影偏移 = (shadow.x - body.x, shadow.y - body.y) × 2 rpx
```

**⛔ 阴影结构的常见错误**：

| 错误做法 | 为什么错 | 正确做法 |
|---------|---------|---------|
| 把阴影做成主体父节点，主体是子节点 | 阴影 fill 盖在按钮上，按钮文字/背景不可见 | 阴影和主体是兄弟关系，共用一个 wrap 父容器 |
| 阴影和主体同级但阴影在上（z-index 更高） | 阴影会遮盖按钮文字 | 阴影 `z-index: 0`，主体 `z-index: 1` |

---

## ⑤ 对接 JS 和交互

### 必须处理的三个问题

1. **默认数据**：如果设计稿中某区域有静态内容（如推荐卡片），但 API 可能返回空，需要在 `data` 或 `catch` 中设置默认值

2. **事件绑定**：所有可点击元素必须绑定 `bindtap`，包括：
   - 按钮/标签（如"继续学习"、"详情 ›"）
   - 卡片（如 HeroCard、RecCard）
   - Tab 切换

3. **共享组件**：TabBar 等共享组件修改需谨慎，保持与项目现有路由一致

---

## ⑥ 走查验证（不可跳过）

> **⛔ 走查的每一项必须引用设计稿数据源。对照不是"看看像不像"，而是"逐行核对每个值是否与提取表一致"。**

### 三遍走查法

**第 1 遍：WXML vs 提取表 — 结构一致性**

对照 ② 的文本提取表、图标提取表：

| # | 检查项 | 数据源 | 核对方式 |
|---|--------|--------|---------|
| 1.1 | 每个文本提取表中的「文本内容」在 WXML 中都有对应 | 文本提取表 | 逐行对比，确认无遗漏 |
| 1.2 | 容器嵌套层次与 batch_get 返回的 children 顺序一致 | batch_get 节点树 | 对比 children 数组 |
| 1.3 | 所有 icon 提取表中的节点已处理（lucide→导出PNG / image fill→直接引用） | 图标提取表 | 逐行确认处理方案已执行 |
| 1.4 | `<image>` 标签已替代所有 WXSS background-image | 颜色/效果提取表 | 逐区检查 |
| 1.5 | scroll-view 内 padding 放在 inner 容器上 | batch_get 节点属性 | 检查 scroll-view 的 padding 值 |

**第 2 遍：WXSS vs 提取表 — 数值换算一致性**

对照 ② 的尺寸/颜色/字体/间距/效果提取表：

| # | 检查项 | 数据源 | 换算规则 | 核对方式 |
|---|--------|--------|---------|---------|
| 2.1 | 每个 `background-color` 值与颜色提取表一致 | 颜色提取表 hex 值 | 直接使用 | 逐色值对比 |
| 2.2 | 每个 `width`/`height` 值为提取表尺寸 × 2 rpx | 尺寸提取表 | px×2 | 逐尺寸对比 |
| 2.3 | 每个 `font-size` 值为提取表 fontSize × 2 rpx | 字体提取表 | px×2 | 逐字体对比 |
| 2.4 | 每个 `border-radius` 值为提取表 cornerRadius × 2 rpx | 效果提取表 | px×2 | 逐圆角对比 |
| 2.5 | 每个 `box-shadow` 按规则换算 | 效果提取表 shadow 值 | offset×2, blur×2 | 逐阴影对比 |
| 2.6 | 区域间距与交叉计算表的 gap(rpx) 列一致 | 交叉计算表 | 直接使用 | 逐间距对比 |
| 2.7 | 父容器有 `gap` 时子元素无 margin（防止叠加） | 间距提取表 | — | 逐区检查 |

**第 3 遍：截图对照 — 视觉效果一致性**

| # | 检查项 | 核对方式 |
|---|--------|---------|
| 3.1 | 背景图是否正确显示 | 对照第 ① 步获取的截图 |
| 3.2 | 颜色氛围是否一致 | 对照截图，重点检查卡片/导航栏/按钮主色 |
| 3.3 | 字体大小层级是否正确 | 对照截图，检查标题/正文/辅助文字的比例 |
| 3.4 | 图标是否与设计稿一致（非通用替代图） | 逐个图标对照截图 |
| 3.5 | 装饰元素是否可见且位置正确 | 对照截图检查 deco 元素坐标 |

### 高频缺陷自查清单

| # | 缺陷 | 检查方法 | 数据源 |
|---|------|---------|--------|
| 1 | lucide 图标被 deco 通用图替代 | 每个 icon 节点确认已导出 PNG | 图标提取表 |
| 2 | 区域间距使用估算值非精确计算 | 对照交叉计算表的 gap 列 | 交叉计算表 |
| 3 | resolveVariables 未开启导致颜色偏差 | 确认 hex 值不是 $primary 引用 | 颜色提取表 |
| 4 | 阴影透明度 hex→rgba 转换不精确 | 对照换算表 | 效果提取表 |
| 5 | snapshot_layout 数据未使用 | 间距以 batch_get 的 x/y 为准（有偏移） | snapshot_layout |
| 6 | TabBar 等共享组件未按设计更新 | 组件文件也需走读设计稿对应区域 | batch_get 节点树 |
| 7 | 父 gap + 子 margin 双重叠加 | 检查父容器是否有 gap；若有则子元素须移除 margin | 间距提取表 |
| 8 | 装饰元素插入位置错误 | 对照 design 稿子节点列表确认顺序 | batch_get children 数组 |
| 9 | readDepth 过浅导致漏读内部属性 | 确认 readDepth ≥ 8 且无 "..." 截断 | 1.2 截断检测 |
| 10 | scroll-view 用 flex:1 或 calc(vh-rpx) 高度失效 | 改用绝对定位方案 | 见 §③.4 |
| 11 | **代码中的数值在提取表中找不到来源** | 逐个代码值回查提取表 | 所有提取表 |
| 12 | **截断数据未重新查询直接脑补** | 检查 1.2 截断检测是否全部通过 | 截断检测日志 |
| 13 | **元素实际宽度溢出屏幕/父容器** | 逐元素计算 `margin-left + width + border + padding ≤ 750rpx` | 尺寸提取表 + 效果提取表 border |
| 14 | **有 border/padding 未设 box-sizing: border-box** | 搜索 css 中 `border:` 声明，确认同选择器有 `box-sizing: border-box` | WXSS 文件 |
| 15 | **layout: none 页面误用 align-items:center** | 对照设计稿 x 坐标，确认非居中布局（x≠0 的元素）未用 flex 居中 | 尺寸提取表 x 列 |

---

## 常见坑点速查

| 坑点 | 现象 | 解决方案 |
|------|------|---------|
| WXSS background-image 本地资源 | 渲染层网络层错误，图片不显示 | 改用 `<image>` 标签绝对定位 |
| `wx:if` 导致区域不显示 | 截图中缺少某个 section | 添加默认数据或移除条件渲染 |
| scroll-view 直接设 padding | 子元素 `width:100%` 溢出 | padding 放在 inner 容器上 |
| emoji 图标颜色无法控制 | 图标显示为系统默认彩色 | 使用图片 + CSS filter，或替换为 iconfont |
| 共享组件样式不一致 | TabBar 等组件样式被覆盖 | 在组件内部修改，保持路由逻辑不变 |
| 装饰元素位置错乱 | 装饰元素不跟随滚动或位置偏移 | 确认 absolute 定位的父容器是 relative |
| **父容器 gap + 子 margin 叠加** | 间距比设计稿大一倍 | 父用 `gap` 后，子禁用 margin；用交叉计算表逐区核对 |
| **子节点顺序与设计稿不一致** | 装饰元素卡在错误的位置 | 对照 batch_get 返回的 children 数组顺序放置元素 |
| **scroll-view 用 flex:1 / calc(vh-rpx) 高度失效** | 底部按钮被裁掉不可见、内容区出现大片留白 | 小程序 scroll-view 不支持 flex:1，calc 混用 vh/rpx 也不可靠；改用**绝对定位**方案 |
| **有 border 未设 box-sizing** | 元素实际宽度超声明宽度，溢出屏幕 | 添加全局 `* { box-sizing: border-box; }`，见 §④ |
| **独立矩形阴影做成父子结构** | 阴影 fill 盖在按钮上，按钮文字不可见 | 阴影和主体是兄弟节点，wrap > shadow + body，shadow z-index < body z-index |
| **layout:none 页面误用 flex 居中** | 子元素全部居中偏移，x 坐标失效，溢出屏幕 | 绝对定位页面用 position:absolute + top/left 精确还原，禁止加 display:flex / align-items:center |

---

## 文件存放规范

```
pages/{page}/
├── {page}.wxml          # WXML 模板
├── {page}.wxss          # WXSS 样式
├── {page}.js            # JS 逻辑
├── {page}.json          # 页面配置
└── design-screenshot.png # 设计稿截图（用于走查）
```

---

## 示例：HeroCard 背景图改造

### 设计稿属性
- `type: frame`, `width: 327`, `height: 162`
- `fill: { mode:"fill", type:"image", url:"../../assets/images/bg/bg_hero_card.png" }`
- `cornerRadius: 16`

### 错误写法（WXSS background-image）
```css
.hero-card {
  background-image: url('/assets/images/bg/bg_hero_card.png');
  background-size: cover;
}
```

### 正确写法（<image> 标签）
```xml
<view class="hero-card">
  <image class="bg-image" src="/assets/images/bg/bg_hero_card.png" mode="aspectFill" />
  <view class="card-content">
    <text class="hero-title">Python 基础 · 第3章</text>
  </view>
</view>
```

```css
.hero-card {
  position: relative;
  width: calc(100% - 96rpx);
  height: 324rpx;
  border-radius: 32rpx;
  overflow: hidden;
}
.bg-image {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
}
.card-content {
  position: relative;
  z-index: 1;
  padding: 40rpx;
}
```

---

## 复刻案例复盘：2026-06-12 主页 (RweGQ)

### 背景
对主页 (RweGQ) 进行 1:1 复刻，首轮完成后用户反馈两个问题：
1. QuickActions 图标未复刻
2. 整体并非完美 1:1

### 首轮缺陷清单

| # | 缺陷 | 严重度 | 根因 | 修正 |
|---|------|--------|------|------|
| 1 | **lucide 图标用 deco 图替代** | 🔴 高 | 未意识到需要从 Pencil 导出图标；用 deco_star/deco_spiral/deco_circle 充当 trophy/rotate-ccw/chart-column/star | `export_nodes` 导出 4 个 icon frame (2x) → 96×96px PNG |
| 2 | **区域间距全部算错** | 🔴 高 | 首轮没用 snapshot_layout；margin 值靠目测估算 | 逐区计算交叉表：8/28/20/12rpx |
| 3 | **HeroCard margin-top 写 16rpx** | 🟡 中 | 凭感觉填值 | 按 y:100→200rpx，Header bottom 192rpx，gap=200-192=**8rpx** |
| 4 | **QuickActions margin-top 写 18rpx** | 🟡 中 | 同上 | y:274→548rpx，HeroCard bottom 520rpx，gap=548-520=**28rpx** |
| 5 | **resolveVariables 首轮未开** | 🟡 中 | batch_get 未传 resolveVariables:true | 虽然有设计变量表，但 batch_get 直接返回解析值更可靠 |
| 6 | **阴影透明度换算不精确** | 🟢 低 | #00000010→0.06 应为 0.0625 | 对照换算表修正 |
| 7 | **readDepth 设 3 太浅** | 🟢 低 | 部分深层嵌套节点信息被 `"..."` 截断 | 设 readDepth:6 |

### 流程改进（已更新到上文各节）

1. **图标决策树**：新增加入 ② 提取阶段 → 图标处理决策树
2. **间距交叉计算表**：新增加入 ② 提取阶段 → 必须生成 gap 计算表
3. **阴影换算表**：新增加入 ② 提取阶段 → hex alpha→rgba 对照
4. **resolveVariables 强制**：在 ① 读取阶段标注 ⚠️ must
5. **readDepth 建议值**：3→6，避免节点信息截断
6. **自查清单**：在 ⑥ 走查阶段新增 checkbox 清单
7. **截图时机**：从"最终对照"改为"第一步获取，全程对照"

### 关键教训

> **不要用通用资源替代精确资源。** deco 图片只用于装饰元素（背景波浪/圆点/星星），功能图标必须从设计稿导出。每个 `type: "icon"` 节点都必须经过"判断→导出→引用"流程。

> **间距永远用计算值，不用估算值。** snapshot_layout 给出精确坐标，交叉计算表给出精确 gap，直接填入 margin。目测必出错。

> **5 个工具调用缺一不可。** editor_state + batch_get(resolveVariables=true) + snapshot_layout + screenshot + variables，并行调用不省任何一个。

> **设计稿数据是唯一事实来源。任何代码中的值都必须在提取表中有对应行。** 提取表有空值 → 重新查询设计稿 → 不得脑补。看到 `"..."` 截断 → 提高 readDepth → 不得猜测。这是 1:1 像素级还原的基础，不可妥协。