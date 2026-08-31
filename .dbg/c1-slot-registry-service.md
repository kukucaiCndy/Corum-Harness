# C1：插件自声明 UI 能力（slotRegistry cordis 服务化）—— 完成记录

> 专项：`docs/audit/NEXT-PHASE-DEFERRED.md` §1 C1。模式复用 C3a（`.dbg/c3a-sidebar-mode-service.md`）：
> cordis 服务作为跨 bundle 单例载体（实证 `.dbg/cordis-singleton-probe.md`），无需 ui-base external 化。

## 改了什么

| 包 | 改动 |
|---|---|
| `corum-ui-base` | `grid.ts`：① `SlotMeta` 加 `visibility?: 'fixed'\|'addable'\|'hidden'`（缺省 addable，与历史一致）；② 注册表读写（`registerSlot`/`getSlotMeta`/`getAllRegisteredSlots`）改为**每次调用时解析后端**——window 桥 `__corumSlotRegistry` 已挂则直达 cordis 服务，未挂落模块级 fallback Map；③ 新增 `drainPendingSlots(face)` 供壳合并早期注册。文件保持 cordis-free（纯库纪律）。 |
| `corum-ide-ui` | `index.tsx`：① apply 里 `ctx.reflect.provide('slotRegistry', impl)` + 挂 window 桥 + `drainPendingSlots`；② `declare module cordis` 加 `Context.slotRegistry`；③ **24 条硬编码 EXCLUDE 清单删除**，扫描逻辑收敛为一条规则——「插件已自声明 ⇒ 尊重；未自声明 ⇒ `visibility:'hidden'`」。`ide-layout.ts`：5 个内建槽标 `visibility:'fixed'`。`PluginManagerPanel.tsx`：视图管理只列 `visibility==='addable'` 的槽。 |
| `corum-agent-ui-dev` | `client/index.tsx`：插件自声明示例——apply 里 `registerSlot('@corum/corum-agent-ui-dev', { label: 'Agent 测试', visibility: 'addable' })`（IDE combo 下可被用户添加进网格；dev-agent combo 无壳扫描为无害 no-op）。 |

## 关键设计决策

1. **服务载体 + window 桥解析（非 bind 一次性赋值）**：cordis 插件**模块顶层**在「加载依赖图」
   阶段执行（壳 apply 未跑、服务未 provide），**apply** 才在「激活」阶段执行。ide-layout.ts
   的内建槽注册在模块顶层——若用「模块级 backend 变量 + bind 后直读」（第一版方案），顶层
   注册会被永久锁进 fallback Map（实机 trace 实证：5 个内建槽 `backend=NULL`，其后扫描的
   41 条 `backend=SVC`）。**解法：后端解析推迟到每次调用时**（`resolveBackend()` 读 window
   桥），顶层注册暂存 fallback，壳 apply 时 `drainPendingSlots` 合并进服务。window 桥是
   合法挂载（written once, read-only，规范 §1 例外，与 `window.corumDesktop` 同类）。

2. **visibility 三态替代 EXCLUDE 清单**：
   - `fixed`——壳/专职插件固定占位槽（侧栏/对话区/编辑器/资源管理器/终端），不进视图管理；
   - `addable`（缺省）——用户可经添加区域/视图管理自由拖入网格，与历史行为一致；
   - `hidden`——无独立 UI 的插件（纯服务/加载器/壳自身/测试占位），不进任何清单。
   壳不再枚举业务插件：未自声明的 boot entry 一律 hidden，插件要进网格自己声明。

3. **视图管理语义不变**：`isRegionSlot`（在网格树中）过滤保留——视图管理管「已在网格的
   区域显隐」，新 addable 槽经「添加区域」进网格后才出现。只叠了 visibility 过滤。

## 验证（CDP 实机，combo=coding）

- ✅ **三包 build + typecheck 全绿**。
- ✅ **服务单例汇聚**：注册表 total=46——5 个内建槽（fixed，label/pinned/collapsedWidth
  完整）+ 41 条扫描 hidden 条目，同一服务实例。
- ✅ **跨 bundle 读写**：window 桥动态注册 `visibility:'addable'` 槽，服务侧立即可读；
  GridView 按服务 meta 渲染（侧栏宽 300 = minWidth，pinned 生效）。
- ✅ **视图管理过滤**：fixed/hidden 槽不出现（视图管理空——所有在网格的槽都是 fixed，
  符合设计）；addable 槽通过 visibility 过滤条件。
- ✅ **UI 健康**：`#root` 1 子节点、侧栏/对话区渲染、`__corumSidebarMode` 不存在、无白屏。

## 时序教训（对后续 cordis 服务化的价值）

**cordis 两阶段模型**：模块顶层 = 加载期（apply 未跑），apply = 激活期。任何「模块顶层
写、服务化读」的状态，不能用「bind 一次性赋值后端」——顶层写会锁进 fallback。必须
「每次调用时解析后端 + drain 合并早期写」。本项的 `resolveBackend()` + `drainPendingSlots`
是该模式的参考实现。
