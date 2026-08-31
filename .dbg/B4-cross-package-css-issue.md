# B4 跨包 CSS 子路径 import 的根因（round 40 主 Agent 实机诊断）

## 症状
B4 把 sidebar.module.css 迁到 ui-base、3 消费包改 import `@corum/corum-ui-base/sidebar.module.css` 后，应用报错：
`require("@corum/corum-ui-base/sidebar.module.css") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`

## 根因（实机 + bundle 分析）
- 消费包 tsdown 配置：`noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true)`、`css: { splitting: false }`。
- **tsdown 对「本地 .module.css import」**：抽取成 lib/style.css，再经 scripts/inline-css.mjs 内联进 client.js（sidebar 等成功案例）。
- **tsdown 对「跨包子路径 @corum/corum-ui-base/sidebar.module.css import」**：处理错乱——bundle 的 `//#region ../corum-ui-base/src/client/sidebar.module.css` 区域内容竟是 lucide-react 的 JS（不是 CSS），且残留 `require("@corum/corum-ui-base/sidebar.module.css")` 的 external 引用。模块表无此条目 → 加载失败。
- 即：tsdown 把「跨包 css 子路径 import」当成普通 JS 模块 external/错乱内联，**不像本地 css 那样抽取内联**。

## 结论
「跨包 css 子路径 import」在当前 tsdown 配置下**不可行**（tsdown 对跨包 css 子路径处理错乱）。

## 候选解法
1. 各包本地自带 sidebar 样式（回退单一事实源，但可靠）。
2. 用**物理相对路径** import（`../../corum-ui-base/src/client/sidebar.module.css`）让 tsdown 当本地 css 抽取内联（最可能可行，待验证）。
3. ui-base 经 base-theme.css / 非 module.css 方式提供共享样式。

## 状态
**已修复（方案 2 落地，2026-09）**：3 个消费包 import 改为物理相对路径
`../../../corum-ui-base/src/client/sidebar.module.css`（tsdown 当本地 css 抽取内联）。
验证：external require=0；两包 bundle 含 btnNew×5/historyRow×4/sidebar×5 条
XloQSW 规则 + 1 份 module 映射；typecheck/desktop build PASS；重启后无
「Failed to load / missed the module table」、无白屏、侧栏样式与迁移前一致。

补充观察（与根因不矛盾）：project-ui bundle 的
`#region ../corum-ui-base/src/client/sidebar.module.css` 注释标记错位（标在
lucide-react 块前），但仅为**标注错位**——实际 sidebar CSS 文本与 module 映射
均正确存在且无 external require，应用运行正常。region 标注错乱在两方案下均
出现，是 tsdown/rolldown 的 region 分配瑕疵，非功能缺陷。
