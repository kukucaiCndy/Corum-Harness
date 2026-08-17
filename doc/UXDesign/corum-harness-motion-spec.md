# 矩道 Corum Harness — 交互动效规范

> 目标：开发可直接照参数实现。所有动画遵循「液态玻璃」质感 —— 柔、弹、有呼吸感，不生硬。
> 风格基调：**流体能动（fluid motion）**，缓动以 ease-out / spring 为主，避免线性。
> 单位：时长 ms，缓动用 cubic-bezier 或 spring（质量/刚度/阻尼）。

---

## 0. 全局动效基线

| 项 | 值 | 说明 |
|---|---|---|
| 基础缓动 | `cubic-bezier(0.22, 1, 0.36, 1)`（easeOutExpo 系） | 大多数进入/展开 |
| 退场缓动 | `cubic-bezier(0.4, 0, 1, 1)`（easeIn） | 消失/收起，略快 |
| 弹性缓动 | `spring(mass 1, stiffness 260, damping 24)` | 弹窗/浮层/拖拽落点 |
| 微交互 | `cubic-bezier(0.34, 1.56, 0.64, 1)`（easeOutBack） | 按钮/小元素，带回弹 |
| 时长 · 微 | 120ms | hover、icon、checkbox |
| 时长 · 短 | 200ms | 按钮、tab、卡片 hover |
| 时长 · 中 | 280ms | 面板展开、列表项、消息进入 |
| 时长 · 长 | 400ms | 弹窗、抽屉、页面切换 |
| 时长 · 背景 | 600ms+ | 背景、主题切换渐变 |
| 交错 | 每项 30ms | 列表/菜单逐项进入 |
| 降级 | `@media (prefers-reduced-motion: reduce)` 时全部动画 → 0ms / 仅透明度 | 无障碍强制 |

---

## 1. 背景（CG 视频挂载点）

> 背景是 CG 视频（虎鲸蒸汽波），由你方提供。设计稿只定义「如何承载」。

| 项 | 规范 |
|---|---|
| 挂载层 | `ambient` 层（最底），视频 `object-fit: cover` 铺满 |
| 深/浅 | 两个视频文件，随主题切换。切换时 **交叉淡入淡出 600ms**（`opacity 0↔1`，ease-in-out） |
| 播放 | 循环、静音、`playsinline`。深色 = vaporwave-dark.webm，浅色 = vaporwave-light.webm |
| 性能 | 视频之上叠一层 `bg-base` 的 60% 透明蒙版，保证前景可读；`prefers-reduced-motion` 时降级为静态封面帧 |
| 玻璃联动 | 玻璃卡片 `backdrop-filter: blur(20px) saturate(140%)`，让视频透出模糊光感 |

---

## 2. 页面 / 视图切换

### 2.1 三视图切换（会话 / 文件 / 代码）
- **触发**：活动栏图标点击
- **动画**：旧视图 `opacity 1→0 + translateX(-12px)`，新视图 `opacity 0→1 + translateX(12px→0)`
- **参数**：280ms，基础缓动；新旧**交叉**（旧先出 120ms，新进入 200ms，重叠 80ms）
- **活动栏图标**：激活指示条 `scaleX 0→1`，200ms，微交互回弹

### 2.2 拖出为独立窗口（多屏）
- **触发**：拖拽会话/编辑器超过阈值（>80px）或点「拖出」
- **拖拽中**：被拖元素 `scale 0.96 + opacity 0.85 + 阴影加深`，跟随光标；目标区域显示 2px `brand-primary` 落点线
- **松手成窗**：元素 `spring` 弹向屏幕边缘并「飞出」，新窗口从边缘 `scale 0.9→1 + opacity 0→1`，400ms spring
- **dock 回主窗**：反向，窗口 `scale→0.9 + opacity→0` 280ms，主窗对应区域高亮闪烁 1 次（`brand-primary` 描边 pulse 400ms）

---

## 3. Agent 对话区

### 3.1 消息进入
- **用户消息**：`opacity 0→1 + translateY(8px→0)`，200ms，基础缓动
- **Agent 消息**：同上，但延迟 80ms（模拟「思考」后回应）
- **多条消息**：交错 30ms

### 3.2 流式输出（打字机）
- **文本**：逐字/逐词出现，光标 `|` 闪烁（`opacity 1↔0`，530ms 步进，无限循环）
- **停止按钮**：hover `scale 1.05`，120ms
- **流式结束**：光标淡出 200ms，消息整体 `translateY` 归位

### 3.3 工具调用条
- **进入**：`opacity 0→1 + scaleY(0.9→1)`（从顶部展开），200ms
- **状态点**：运行中 `pulse`（`scale 1→1.3→1 + opacity 1→0.5→1`，1.2s 循环）；完成时变 `state-success` 并 `scale 1→1.4→1` 一次（300ms 弹性）
- **展开/收起输出**：高度 `auto` 过渡 280ms 基础缓动，内容 `opacity` 跟随；chevron 旋转 `0↔90°` 200ms

### 3.4 等待审批
- **出现**：卡片 `opacity 0→1 + translateY(10px→0)`，300ms spring
- **「等待审批」标签**：`state-warn` 色 `pulse`（opacity 1↔0.6，1s 循环），吸引注意
- **按钮**：允许/拒绝 hover `translateY(-1px) + 阴影`，150ms

### 3.5 文件更改审查卡（固定底部，默认折叠）
- **折叠→展开**：高度 `auto` 过渡 300ms 基础缓动 + chevron 旋转 200ms；文件列表逐项 `opacity 0→1 + translateX(-6px→0)` 交错 40ms
- **新更改提示**：卡片顶部 `brand-primary` 描边 pulse 2 次（600ms），提示有新 diff

### 3.6 代码块
- **复制按钮**：hover 显现（`opacity 0→1` 120ms），点击后变「✓ 已复制」并 `scale 1→1.15→1` 回弹 250ms，1.5s 后恢复

---

## 4. 会话列表（Explorer）

### 4.1 列表项 hover / 选中
- **hover**：背景 `transparent→glass-2`，150ms；标题色 `secondary→primary`
- **选中**：背景 `glass-2` + 左侧 2px `brand-primary` 指示条 `scaleY 0→1`，180ms 微回弹
- **状态点变化**：`color` 过渡 200ms；运行中 pulse（同 §3.3）

### 4.2 右键菜单
- **弹出**：`opacity 0→1 + scale 0.92→1`（从点击点为原点），180ms spring
- **菜单项**：逐项 `opacity 0→1 + translateY(-4px→0)` 交错 25ms
- **hover 项**：背景 `glass-2` 120ms
- **危险项（删除）**：hover 时背景 `state-error/10%` + 文字 `state-error` 加深
- **关闭**：`opacity→0 + scale→0.95`，120ms easeIn

### 4.3 拖拽排序
- **抓起**：`scale 1.03 + 阴影加深 + opacity 0.9`，150ms
- **拖拽中**：目标插入位置显示 2px `brand-primary` 横线，跟随移动（50ms 平滑）
- **放下**：元素 `spring` 落入新位置，300ms spring；其他项 `translateY` 让位 250ms 基础缓动

### 4.4 搜索过滤
- **输入**：列表实时过滤，不匹配项 `opacity 1→0 + height→0` 200ms，匹配项 `translateY` 重排 250ms
- **清空**：反向恢复，200ms

### 4.5 骨架屏
- **加载中**：骨架条 `shimmer`（一道高光从左到右扫过，`translateX -100%→100%`，1.4s 循环，ease-in-out）
- **加载完成**：骨架 `opacity→0` 150ms，真实内容 `opacity 0→1` 交错进入

---

## 5. 编辑器区

### 5.1 编辑器 tab
- **切换**：激活 tab 底部 `brand-primary` 指示条 `translateX` 滑动到新 tab，250ms 基础缓动（共享布局动画 layoutId）
- **新建**：新 tab 从右侧 `opacity 0→1 + translateX(8px→0)`，200ms
- **关闭**：tab `opacity→0 + width→0` 200ms，后续 tab 左移补位
- **hover 显 ×**：`opacity 0→1` 120ms

### 5.2 dirty 未保存
- **dirty 点出现**：`scale 0→1` 弹性 250ms
- **关闭确认弹窗**：见 §6 弹窗

### 5.3 编辑器状态栏（行/列/编码）
- **值变化**：数字 `opacity 1→0.3→1` 闪烁 200ms（提示更新）

---

## 6. 弹窗 / 浮层（L4）

### 6.1 通用弹窗（删除确认 / 保存日志 / 重命名 / 未保存）
- **遮罩**：`opacity 0→1`（`bg-base/60%` + backdrop blur），250ms
- **弹窗体**：`opacity 0→1 + scale 0.94→1 + translateY(8px→0)`，320ms spring（质量1/刚度300/阻尼26）
- **关闭**：反向 200ms easeIn
- **危险确认（删除）**：图标 `warn` 容器 `scale 0.8→1` 回弹 300ms + 删除按钮默认**不**聚焦（防误触，默认焦点在「取消」）

### 6.2 状态栏 hover 详情卡
- **触发**：hover 状态栏 200ms 延迟后弹出（防误触）
- **弹出**：`opacity 0→1 + translateY(6px→0)`，180ms spring
- **消失**：hover 移出后 `opacity→0` 150ms

### 6.3 主题切换（设置 · 外观）
- **选中项**：`brand-primary` 描边 + check 点 `scale 0→1` 弹性 250ms
- **全局换肤**：所有 token 颜色 600ms 平滑过渡（背景视频交叉淡入淡出，见 §1）

---

## 7. 底部面板 / 状态栏

### 7.1 底部面板展开/收起
- 高度 `0↔200px` 过渡 300ms 基础缓动；tab 切换内容 `opacity` 交叉 200ms

### 7.2 待办勾选
- checkbox `scale 0.9→1` 回弹 + 文字 `strikethrough` 划线 200ms + 文字色 `primary→tertiary`

### 7.3 状态栏
- **连接状态点**：Connected `state-success` 常亮；Reconnecting `state-warn` pulse（1s 循环）；Disconnected `state-error`
- **运行 chip**：`Running · Step n/m` 的步骤数字变化时 `translateY` 滚动替换 200ms

---

## 8. 光标 / 焦点 / 可访问性

| 项 | 规范 |
|---|---|
| 焦点环 | 2px `brand-primary` + 2px 偏移，`opacity 0→1` 120ms（键盘 Tab 触发，鼠标点击不显） |
| 输入框聚焦 | 描边 `glass-border→brand-primary` 200ms + 轻微 `scale 1.005` |
| 减少动效 | `prefers-reduced-motion`：所有 transform/位移动画移除，仅保留 150ms 透明度过渡；视频背景换静态帧 |

---

## 9. 缓动曲线速查

```
基础进入   cubic-bezier(0.22, 1, 0.36, 1)   /* easeOutExpo 系 */
退场       cubic-bezier(0.4, 0, 1, 1)       /* easeIn */
微回弹     cubic-bezier(0.34, 1.56, 0.64, 1)/* easeOutBack */
弹性弹簧   spring(mass=1, stiffness=260, damping=24)
强弹簧     spring(mass=1, stiffness=300, damping=26)  /* 弹窗 */
```

---

## 10. 交付备注

- **背景 CG 视频**：由你方提供（深/浅两个 webm），设计稿已留 `ambient` 挂载层 + 主题联动 + 可读性蒙版
- **实现栈建议**：Web 端用 CSS transition + `framer-motion`（spring 参数直接对应）；桌面 Electron 同
- 所有时长可在 `theme.motion` 统一配置，支持全局减速/关闭
