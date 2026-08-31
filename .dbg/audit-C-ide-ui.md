# 子 Agent C 报告：IDE UI 插件群（已收）

架构理解到位、官方扩展点用得规范（SlotMap 声明合并 + slots.register/inject + ctx.effect；ctx.layout 保持官方 ILayout 语义；patch 层只禁用+插入）。GridView 自由网格是官方没有的差异化，数据模型质量高。主要问题：已退役/脚手架包滞留 workspace、壳层用 window CustomEvent 桥 + querySelector 轮询绕开自建槽位体系、布局持久化无版本迁移、硬编码假数据+文案不走 locale、noImplicitAny 全群关闭+多处跨边界 cast。

## P0/P1
1. AppFrame.tsx:144-191 Agent 标题栏全硬编码假数据（"7轮·12m34s·In12.4k/Out3.1k·命中61%" L182，轨迹按钮无 onClick）呈现在正式主界面每屏。应接 dsh-session-stats，未接通前隐藏。
2. AppFrame.tsx:587 每 400ms 全文档 querySelector 轮询对齐标题栏（依赖 GridView 内部 DOM 结构，脆弱且浪费）。应从 grid state + computeCellSizes 直接算或订阅布局回调。
3. grid.ts:16 + ide-layout.ts:16 布局持久化无版本迁移（key "corum.ide.grid.v3" 的 v3 只是字符串，deserializeGrid 无版本字段）。建议序列化包 {v:N,tree}，版本不符回退默认。
4. index.tsx:367-408 读 __DSH_BOOT__.entries 用不存在的字段（绕过官方 parseBootManifest 校验读裸 wire）+ 36 条硬编码 EXCLUDE 清单猜「哪些插件有 UI」。应经 parseBootManifest 解析 / 长期改插件自声明 dsh.client 元数据。
5. corum-ide-conversation-ui 整包已退役仍在 workspace + EXCLUDE 引用（patch.yml:174-178 自认退役；src 仍有 1588 行含 streamFollow 200ms 轮询重复造轮子——正是被替换原因）。corum-ide-statusbar-ui 注册 corum.statusBar 槽但该槽已无人声明（误挂载运行时抛 slot not declared）。建议移出 workspace 到 attic/ 或删。
6.【架构核心】壳层事件桥绕过自建槽位/服务模型：AppFrame.tsx:421-557 挂 4 个 window CustomEvent（SET_REGION_HIDDEN/CLOSE_REGION/TOGGLE_SIDEBAR/RESET_LAYOUT），BottomPanel.tsx:40 硬编码字符串 'corum:close-region' 而非 import 常量（架空 region-events.ts）；另有 corum:open-new-task-form + sessionStorage 跨包字符串耦合无单一事实源。应做成 LayoutController 方法经 ctx.layout 调用，删全部 CustomEvent。
7. 脚手架滞留正式 workspace：ide-test-panel 孤儿目录（无 package.json、src/scripts 空、只剩 lib 残留，全仓无引用，应整目录删）；3 个 test 插件（S0 探针，S1/S2 早已替换，仍在 desktop-host+desktop 的 dependencies + EXCLUDE 清单）；corum-ide-ui/TestModule.tsx 死 import（从未使用）。
8. noImplicitAny:false 全插件群统一关闭（14 个包 tsconfig 逐字节相同，覆盖根 base 的 true），违反官方 strict。应恢复 true 逐个修。
9. UI 文案硬编码中文不走 locale（违反官方 locale-owned）：AppFrame 全部 aria-label/title、PluginManagerPanel 整面板、SidebarSkeleton tab、BottomPanel、StatusBar。设置壳走 locale 值得肯定，应推广。

## P2
10. ctx.get('connection') as ConnectionHandle 9 处 + ctx as unknown as {uiSession} 3 处穿透官方类型边界（官方已做声明合并，应 type-only import 后 ctx.connection / ctx.uiSession）。
11. renderSlot 两处强转任意签名（AppFrame.tsx:708,785）——动态槽 key(string) vs 官方编译期 SlotMap 的本质张力。应封装带注释 helper。
12. AppFrame.tsx:719 等 eslint-disable exhaustive-deps 掩盖缺失依赖；模块级常量列进依赖是噪音。
13. index 键（AgentTestPanel/McpManagerPanel KvEditor 删中间行复用错 DOM state/RuntimeTestPanel）；FileExplorer.tsx:128-138 在 setState updater 内发网络请求（updater 须纯函数，StrictMode 双调发两次）。
14. 轮询 effect 依赖高频状态（eventSeq/fromSeq）→ interval 反复销毁重建。应改 ref。
15. 构建脚本复制粘贴：13 个 inline-css.mjs（md5 全不同但实质相同）、14 份 tsconfig 逐字节相同、11 份 tsdown 结构相同。官方有共享 tsdown.client.ts 先例。应收敛。
16. theme-presenter.ts fork 落后官方（51 行 vs 官方 68 行，缺 --dsh-content-font-size 字号轴）+ 被 4 个 bundle 各自内联实例化（dev 模式若官方 ui-layout 未禁用会双 presenter 写同一 body）。应从官方新版重 fork。
17. 命名/打包一致性：types 指 src vs lib 混用、default 指 src；sidebar.module.css 裸 css 子路径导出被 3 插件各自编译（1371 行 CSS 打进 3+ bundle，CARD_SELECTOR 依赖 [class*="_sr"] 哈希类名子串匹配极脆）；-dev 后缀与 test- 前缀混用；skill/team 两包无 dsh.client 纯组件库却做成插件形态（与 rpc-client 纯库不一致）。
18. plugin-meta.ts:18-174 手写 ~150 个官方包中文元数据表（官方包增删即漂移，fallbackName 格式化出半吊子名）。维护策略需明确。

## P2 小项
useTheme(p=>p) 恒等选择器；空 catch 注释信息量低；McpManagerPanel toastTimer 未 unmount 清理；GridView computeCellSizes 大量非空断言 cast；FloatingLayer.tsx:91 在 updater 内调 onClose 副作用；sidebar-mode.ts 挂 window.__corumSidebarMode（tsdown 各自内联倒逼的运行时变通，把 corum 包加入 external 可恢复模块单例）。

## ide-ui 区域模型评估（对照 README 哲学）
- 壳只定义几何+注册表：达成但有漏（壳又持有 NavTitleBar/AgentTitleBar/PluginManagerPanel/SettingsShell 大量业务 chrome，「壳无业务」只成立一半）。
- 插件运行时动态注册槽位：部分达成（区域槽 GridSlot 运行时注册，但内容槽仍是编译期 SlotMap，两套槽位概念靠 AppFrame.renderGridSlot 手工缝合 + cast——与官方模型最大张力）。建议网格槽 key 收敛为 SlotMap 已知 key 联合类型两全。
- 自由 split/swap/浮动：达成且质量高（dropLeaf/resizeBranch/computeCellSizes 纯函数+min 传导）。已知粗糙：HTML5 DnD ghost 克隆 hack、拖出窗口误触发。
- 布局持久化：达成但无迁移。

## 与官方差异
自由网格/浮动窗/液态玻璃是官方没有的差异化（合理非重复造轮子）；SlotMap 沿用度高用法标准；ctx.layout 面保持兼容但实现引入事件桥；ThemePresenter fork 漂移；SettingsShell fork 理由充分（portal 被网格 transform 困住）但上游修复不会回流；裸读 __DSH_BOOT__ 绕过校验；RPC makeCorumRpcCall 薄封装合理但 9 处 cast 抵消价值；文案 locale-owned 明显偏离；类型纪律（关 noImplicitAny+cast）明显偏离。streamFollow 重复造轮子已被团队自我纠偏（B 方案 fork 替换），剩下是清理。

## 值得肯定
cordis.ide.patch.yml 组合纪律极佳（每行禁用写明原因/接管方/后果，官方包零改动）；grid.ts 树操作纯函数+cloneNode 防御分支周到；uSES 契约用得熟（双键缓存/hiddenCache 防无限重渲染/方法绑定防丢 this）；注释文化接近官方标准；设置壳 fork 保持官方契约形状 feature 注册方零感知（fork 正确姿势）。
