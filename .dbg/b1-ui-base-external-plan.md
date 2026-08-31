# B1 ui-base external 化 — 技术勘察与实施方案（round 4 主 Agent 摸底）

## 模块表机制（已实证）
- 官方模块表两个来源：
  (a) **静态 seed**：`dsh-client-web/src/seed.ts` 的 `getStaticModules()`，硬编码 8 个 PLATFORM_MODULES（react/react-dom/cordis/dsh-client-store/dsh-client-ui-slots/dsh-client-ui-primitives），静态 import 保证单例。
  (b) **动态 client bundle**：每个 `dsh.client` 插件的 client bundle 经 `__DSH_BOOT__.entries` + Loader `loadBundle` 加载进模块表，包名成为可 require 模块。
- **单例语义是模块系统核心**（`dsh-client-modules/src/client/manifest.ts`）：每个模块只 materialize 一次，materialized record 被所有 require 共享。动态 bundle 与静态 seed 同为单例。
- `__ModuleLoader__` 暴露 `{mode, pendingQueue, load, create}`，模块表是闭包内部状态，渲染层读不到内部（只能源码层面确认语义）。

## 关键前提（已证实成立）
**若 ui-base 成为模块表条目（路径 b），多包 external 它时就是单例** → `__corumSidebarMode`（ui-base/sidebar-mode.ts:26-28 挂 window 全局）与 slotRegistry 按 bundle 拆分的问题迎刃而解。这是 B1 的技术根基。

## ui-base 当前分发方式（问题所在）
- `./client` exports：`default: './src/client/index.ts'`（**源码 TS**），消费包 bundler 直接编译 ui-base 源码 = **内联**。
- 消费包 tsdown：`noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true)` —— 非 external 的一律内联。
- 证实：sidebar bundle 内含 `__corumSidebarMode`/`slotRegistry` 痕迹（内联了独立一份）。
- ui-base 无 dsh.client 声明、无 apply()、不在 boot 图、未被 seed → 不是模块表条目，每个消费 bundle 各存一份。
- ui-base 已有 lib/client.js 产物（60KB），但 `./client` default 没指向它。

## corum 插件 external 现状
- 4 个 session 包的 `dsh.client.external` 声明的都是**官方基线模块**（react/store/ui-slots/ui-primitives/settings/api-session-controller）——其中多数本就在 PLATFORM_MODULES 基线里，可能冗余（待核查，非本任务重点）。
- **无任何 corum 包把 @corum/corum-ui-base 声明为 external**。

## B1-pre 实施链（ui-base external 化，纯机制第一步）
1. **ui-base 身份转变**：从「被内联的源码库」→「独立 dsh.client 插件 + 模块表条目」。
   - ui-base `./client` default 从 `./src/client/index.ts` 改为 `./lib/client.js`（指向构建产物 bundle）。
   - ui-base 需有 client bundle 入口被模块表发现（加 dsh.client 声明 + 确保进 boot 图；注意 ui-base 现在无 apply()，需评估是否给它一个 no-op apply 或确认纯模块无需 apply 也能被 load）。
2. **desktop 壳 seed / boot 图**：确认 corum 包的 client bundle 如何进 `__DSH_BOOT__.entries`（corum-ide-ui/index.tsx:364-397 读的 boot.entries 来源）；ui-base 的 client bundle 需出现在其中。
3. **各消费包改 external**（17 个依赖 ui-base 的包）：`dsh.client.external` 加 `@corum/corum-ui-base`（或 `/client`）+ tsdown CLIENT_EXTERNALS 同步加。
4. **实机回归**：sidebar 模式切换、grid 区域跨包一致性、`__corumSidebarMode` 是否可删。

## 风险与次序建议
- **风险**：ui-base 含 GridView/RegionCard/FloatingLayer/grid.ts/sidebar-mode/theme-presenter 核心，改坏 → IDE 壳白屏。必须改后立即实机验证。
- **次序**：先做 B1-pre（本方案，ui-base 单例化，可独立验证），再做 B1-main（事件桥/storage→ctx.layout 行为改造）。B4（跨包 CSS）依赖 ui-base 稳定，B2/B3 依赖 B1 完成。
- **待确认开放点**：ui-base 无 apply()，纯模块库能否作为 client bundle 进 boot 图被模块表加载？（官方 dsh.client 插件都有 apply；需确认 cordis 对「只有 client bundle 无 apply」的包如何处理——可能需要一个 no-op apply 或确认 loader 只 materialize 不调用 apply。）

## 结论
B1 技术前提成立、路径清晰，但实施链长、风险高（白屏），且有一个「无 apply 纯库能否进 boot 图」的开放点需先确认。建议拆分 B1-pre（机制）由专注子 Agent 执行 + 主 Agent 实机监控回归。

## B1-main 补充勘察（round 5 主 Agent）：ctx.layout 现状与事件桥根源
- `corum-ide-ui/src/client/service.ts` 的 `LayoutController implements ILayout`（toggleSidebar/openDetails/closeDetails）保持官方 ILayout 语义。
- **关键发现**：`toggleSidebar()` 自己就用 `TOGGLE_SIDEBAR_EVENT` 桥（service.ts:44）——因为「纯组件 AppFrame（网格树所有者）拿不到本服务实例」（service.ts:41-43 注释自承）。
- **B1-main 的真正解法**：不是简单删事件，而是让 LayoutController 能直接操作 grid state——把「区域显隐/关闭/重置/新建任务」动作从 AppFrame 组件提升到一个 LayoutController 可访问的层（grid controller 单例 / LayoutController 持有 grid store 引用，类似 attachPanels 已采纳的 store actions 模式）。
- 现有 `attachPanels(actions)` 已是「采纳 bound store actions」的先例——B1-main 可扩展此模式：让 AppFrame 把 grid 的显隐/关闭/重置 actions 也 attach 给 LayoutController，服务方法直接调 actions 而非 dispatch 事件。事件桥即可删除。
- 依赖：B1-pre（ui-base external 化）完成后，grid/slotRegistry 单例化，此改造才跨包一致。
