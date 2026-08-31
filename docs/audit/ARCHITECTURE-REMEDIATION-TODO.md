# corum-desktop 架构整改待办清单（最高优先 · 先整改后功能）

> **执行约束（用户定）**：架构问题决定项目长期可维护性与稳定性，**当前 Agent 及后续 Agent 须全力完成本清单整改后，才推进其它功能开发**。
> 本文件是跨会话的持久事实源：每个整改项完成后，由执行 Agent 更新状态（`[ ]`→`[x]` + 日期 + 简要说明），并同步 typecheck/build/实机验证结果。
> 依据：`docs/audit/CODE-AUDIT-REPORT.md` + 主 Agent 实证耦合分析（`.dbg/audit-*.md`）。

## 进度图例
`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成 · 每项标注：来源（报告条目）、收益、代价/风险、验证方式。

---

## 第 0 批 · 前置（已完成 ✅）

- [x] **安全整改**（P0-1~P0-4）：corum-fs root 钳制 / CDP 回环 / stdio 校验超时 / combo env 黑名单+原子写。→ typecheck+build PASS。
- [x] **类型防线**（P0-9/P0-10）：21 包恢复 `noImplicitAny:true` + 2 个 statusbar 包槽类型闭合。→ 全仓 28 包 typecheck PASS。
- [x] **实机验证**：cdp.sh 起应用验证改动不破坏运行（见下方「验证记录」）。

---

## 第 1 批 · 立即可做（低风险高收益，先做）

> 目标：消掉「P0 误判修正」遗留 + 职责重叠 + 契约下沉，不碰架构骨架。

- [x] **A1 修正 chat→conversation 依赖声明错位**（✅ 完成；全仓 typecheck PASS、chat build PASS、产物 require 清单不变）
  - `corum-ui-chat/package.json`：把 `@corum/corum-ui-conversation` 从 `dependencies` 挪到 `devDependencies`（官方纪律「browser/type 关系仅 devDependencies」；这是真问题，host 面安装图被绑死）。
  - 去 `corum-ui-chat/src/client/index.ts:44-49` 对 conversation 类型的 re-export（把对方类型变成自己公开面，conversation breaking change 会穿透 chat 公共 API；消费方应直接 type-import conversation）。
  - 删 `corum-ui-chat/tsdown.config.ts` 里 `'@corum/corum-ui-conversation'`、`'/client'` 两条 external（产物证明类型全被擦除，external 是无害死配置；官方 ui-chat 不列）。
  - 同步检查 `corum-ui-approval`（架构报告确认它也把 conversation 放 dependencies）、`corum-ui-questions`。
  - 验证：build chat 产物 require 清单不变；typecheck PASS。
  - 收益：符合官方依赖纪律、安装图脱钩；代价：极小。

- [x] **A2 清理双 AgentRuntime + 死代码处置**（✅ 完成；project-core/ide-test-panel 已删、退役包 README 已标注、build 残留已删、全仓 typecheck PASS 26 包）
  - `corum-project-core/src/runtime.ts`（203 行，dev/test/pm 三角色）已被 `corum-agent-dev/src/runtime.ts`（1222 行，项目×角色×泳道）取代；project-core **零挂载零引用**（不在任何 cordis.patch.yml insert 行、源码零 import），是待爆哑弹。决策后删除/归档（attic/）或标注 deprecated。
  - 顺带：`ide-test-panel` 空壳目录删除（src/client 空、无 package.json、仅 lib 旧产物）；`ide-conversation-ui`/`ide-statusbar-ui` 在包 README 顶部标「已退役-保留备查」；删 `desktop/build/host/cordis.patch.yml` 旧 IPC 方案构建残留（与现行 loopback 架构矛盾，误导后来者）。
  - 验证：grep 确认无引用；typecheck/build PASS。
  - 收益：消除调度分叉哑弹 + 死代码误导；代价：低（确认无引用后删）。

- [x] **A2b 裸事件字符串收编**（✅ 完成；region-events.ts 新增 `OPEN_NEW_TASK_FORM_EVENT`，5 处裸字符串全收编为常量；顺带修了 ui-base barrel 漏 re-export + 3 包补 ui-base 依赖声明，全仓 typecheck PASS）
  - 说明：`'corum:close-region'`（3 处）与 `'corum:open-new-task-form'`（2 处）字面量已全部改用 ui-base 常量。`corum:pending-new-task-form`（sessionStorage 键）属 B1 中期整改，本批未动。

- [x] **A3 会话域共享类型「下沉 contract 包」→ 实证后重定义为「契约边界已成立，无需抽包」**（round 2 主 Agent 实证修正）
  - **结论**：chat 对 conversation 的全部 4 个类型 import（`ConversationNodeDefinition`/`ConversationPromptSnapshot`/`KnownContextForm`/`MessageImageSource`）**都来自 conversation 的 `contract/` 目录**（contract/conversation.ts、request-inspection.ts、context-provenance.ts、slots.ts），**零实现层（conversation/ 目录）依赖**——「依赖契约而非实现」已天然成立。
  - **关键对照**：官方 `dsh-client-ui-chat` 对官方 `dsh-client-ui-conversation` 的消费方式**逐行相同**（官方 ui-chat/tool.ts:3-4 同样 import ConversationMatch/ConversationNodeContext/ConversationNodeDefinition，同样 toolDefinition: ConversationNodeDefinition<ToolState>）。这些契约类型来自官方，corum fork 继承，chat type-only 消费是**官方设计的契约中心辐射**，不是耦合问题。
  - **为何不该抽包**：把官方就有的 contract 类型抽到独立包，会让 corum 文件布局偏离官方，rebase 官方时更痛（官方升级 contract/conversation.ts 需在两包间手动同步）。A1 已把依赖降为 type-only（dependencies→devDependencies），这正是官方做法，已足够。
  - **落地动作**：无需改代码。在 C4 fork 台账中记录「会话域 chat/approval/questions 对 conversation 是 type-only 契约消费、与官方对齐，不做抽包」。
  - 收益：避免一次反向优化；代价：零。

---

## 第 2 批 · 中期（需设计，核心架构自我一致）

> 目标：把壳层 `corum-ide-ui` 理顺——这是架构债最集中的一个包。

- [x] **B1 壳层 CustomEvent/storage 桥 → `ctx.layout` 服务方法**（✅ B1-main 完成并实机验证通过；B1-pre 已产出调研后回退，与 C1 合并为后续专项）
  - 现状（架构报告精确数字）：4 个 CustomEvent（close-region/open-new-task-form/toggle-sidebar/set-region-hidden/reset-layout，常量集中 ui-base/region-events.ts）+ sessionStorage 共享键 `corum:pending-new-task-form`（ide-sidebar→conversation 跨包）+ window 全局挂点 `__corumSidebarMode`（ui-base/sidebar-mode.ts:26-28）+ `__corumNotify`。
  - **拆解决策（round 8 主 Agent，基于投入产出比）**：B1 拆成两半——
    - **B1-pre（ui-base external 化）→ 降级为「共享模块+插件自声明」专项，与 C1 合并，先调研不硬闯**。理由：① `__corumSidebarMode` 是有注释、工作正常的小瑕疵；② slotRegistry 拆分的完整解依赖 C1（插件自声明机制 + visibility 字段 + EXCLUDE 退化），B1-pre 单独做无法兑现该收益；③ 本项目首次建立自定义共享单例模块（无 corum 先例、boot 图机制未明、desktop 壳无 seed 注入点实证路径甲不可行、改坏白屏风险高）。技术勘察见 `.dbg/b1-ui-base-external-plan.md` 与 `.dbg/b1-boot-graph-findings.md`（boot 图机制调研）。
    - **B1-main（事件桥/storage → ctx.layout）→ 立即做，不依赖 ui-base external 化**。已勘察解法（round 5）：`LayoutController.toggleSidebar()` 自己就用 TOGGLE_SIDEBAR_EVENT 桥（service.ts:44），根源是「纯组件 AppFrame 拿不到服务实例」。**真正解法 = 扩展 `attachPanels` 模式**：让 AppFrame 把 grid 显隐/关闭/重置/新建任务 actions 也 attach 给 LayoutController，服务方法直接调 actions 而非 dispatch 事件，即可删 CustomEvent 桥。`corum:pending-new-task-form` storage 键收编为 conversation inject 面 observable。`__corumSidebarMode` 挂点留待 B1-pre 专项处理（本步不动）。
  - 验证：起实机，拖区域/新建任务/侧栏切换全链路回归（corum-cdp-verify）。
  - 收益：架构自我一致（B1-main 独立可兑现）；代价：中（B1-main 动 service.ts + AppFrame + sidebar/conversation 联动，需实机回归）。
  - **B1-main 完成实录（round 21 主 Agent 实机验证）**：`LayoutController` 扩展 `GridActions` 接口 + `attachGrid`（与 attachPanels 同「采纳 bound actions」模式）；AppFrame 经 inject 桥接面把 grid 显隐/关闭/重置/新建任务 actions 交回；全部消费方（sidebar/BottomPanel/FileExplorer/EditorColumn/PluginManagerPanel/EmptyStateHero）经槽位 inject 面改调 `ctx.layout`；region-events.ts 整个删除、sessionStorage `corum:pending-new-task-form` 键收编为 openNewTaskForm 的 pending 认领。**实机验证**：白屏修复（bodyTextLen 0→287，IDE 壳完整渲染）、侧栏折叠经 ctx.layout.toggleSidebar 正常（300→56）、无 JS 报错、全仓 typecheck PASS。
  - **B1-pre 收尾（round 21 + round 36 归因确认）**：子 Agent 曾把 ui-base external 化走通（路径乙：模块表单例、内联副本清零、编译/bundle 三层 PASS）。round 36 在稳定基线（B1-main 完成）上重试 external 化实机验证时**白屏**（boot 图 42 entries 含 ui-base、`#root` 空、无 JS 报错——UI 静默不挂载）；**回退 external 化（保留 B2）后立即恢复正常**，确凿证明 **external 化本身是白屏根因**（非之前的 B1-main 半成品）。结论：ui-base external 化（自定义共享单例模块）在当前机制下会致白屏，**技术上不可行/风险过高，放弃**。产出调研笔记 `.dbg/b1-boot-graph-findings.md` 留存完整机制结论。**`__corumSidebarMode`/slotRegistry 拆分问题改由 C1（插件自声明槽）或其它低风险方案处理，不再走 external 化**。

- [x] **B2 动态网格槽 key 收敛为 SlotMap 联合类型**（✅ 完成并实机验证通过；最终落地为**务实版**，round 22-44 经多轮迭代收敛）
  - **最终落地方案（务实版，实测自洽）**：
    ① `grid.ts` **保持 cordis-free 零 import、运行时零变化**——树操作回到 string 域，仅保留两处泛型默认值桥：`GridSlot<T extends string = string> = T`、`registerSlot<T extends string = string>(key: T, meta)`（让 ide-layout 能传字面量又不破坏现有 string 用法）。
    ② `ide-layout.ts` 定义 `IDE_GRID_SLOTS` 常量数组（含 details，**单一事实源**）+ `IdeGridSlot` 推导；registerSlot×5 + ideDefaultGrid 全部 leafNode 均 `satisfies IdeGridSlot`（**定义处拼写/重命名编译期校验**）。
    ③ `AppFrame` grid state 回 `GridNode`（string 域，**不强求收窄**——运行时动态槽本就该是 string，强行收窄是过度工程且有白屏风险）；renderSlot 强转收敛为 1 处 `renderDynamicSlot` 边界 helper（带注释：动态槽进 SlotMap 的唯一收窄点），两个调用点零强转；FLOATABLE_SLOTS 改用 `new Set(IDE_GRID_SLOTS)`（单一事实源）。
  - **核心价值达成（B2 的真正目标）**：① registerSlot 定义处 `satisfies` 拼写/重命名编译期校验（**实证**：ide-layout.ts 拼错 `'corum.sidebr'` 被 tsc 捕获 `error TS1360: does not satisfy "corum.sidebar" | ...`）✓；② renderSlot 强转收敛为边界 helper（全仓 `renderSlot as` 仅 helper 内 1 处）✓。
  - **踩坑与收敛过程**：曾因主 Agent 矛盾指导在「全收窄」（grid.ts 全量泛型 + `GridNode<IdeGridSlot|string>` state）与「务实版」间反复；子 Agent 实机验证发现「`corum.floating` kind 改 floating + inject 闭包引用 `ctx.slots.renderSlot` 会白屏（`data-slot-error="root"`）」——证明全收窄风险过高。最终主 Agent 决策**冻结务实版**（自洽、核心价值达成、零白屏风险），推翻全收窄重建（过度工程）。
  - **实机验证**：全仓 26 包 typecheck PASS、grid.ts cordis-free（0 import）、IDE 壳正常渲染、侧栏折叠正常（300↔56）。
  - **关键归因（round 36）**：曾叠加 B1-pre external 化验证时白屏，**回退 external 化（保留 B2）后恢复正常**——确凿证明白屏是 external 化所致、B2 运行时正常。故 B1-pre external 化已回退（ui-base 恢复指 src、消费包恢复内联），B2 保留。

- [x] **B3 `corum-ide-ui` 壳/契约分离 + 上帝壳拆解 → 实证后关闭（伪需求）**（round 42 主 Agent 实证）
  - **实证结论**：9 个 feature 包对 ide-ui 的依赖**全部是 `import type {}`（空 type-only 导入）**——`grep` 证实 0 个具名 import、0 个值/实现引用。所谓「ide-ui 被 9 个 feature 静态依赖（Ca=10）」是架构报告把「含 type 的扇入统计」误读成了耦合，**没区分 type-only 的 SlotMap 声明合并 vs 值/实现耦合**。
  - **官方对照（决定性）**：官方 feature 插件注册到壳槽时，也是 `import type {} from '@deepseek-ai/dsh-client-ui-layout/client'`（ui-chat/apply.ts:12、ui-conversation/contract/slots.ts:13、ui-sidebar/contract/slots.ts:14）——**与 corum 的 9 个 `import type {}` 模式完全相同**。且官方壳 ui-layout 也集中声明 SlotMap 槽。「feature type-import 壳的槽声明以注册进去」是**官方设计的正常模式**，壳集中定义槽、插件注册，是天然正确关系，不是病。
  - **为何不抽 contract 包**：要抽的「契约」就是 ide-ui 的 SlotMap 声明（corum.* 槽）——但 feature 包本就需要知道壳定义了哪些槽才能类型安全注册。把 SlotMap 声明抽到独立 contract 包会让壳的槽定义与壳分离（偏离官方「壳集中声明槽」的布局），rebase 官方时更痛，且**不解决任何真实耦合**（本无值/实现耦合）。
  - **ide-ui 真正的「上帝壳」问题在别处**（非 B3 范畴）：它自身承担过多业务 chrome（PluginManagerPanel/SettingsShell/settings-chrome/SettingsGeneralSection/theme-layer/AppFrame 896 行）——这是「壳无业务只成立一半」的内聚度问题，与「壳/契约分离」是两回事；拆解成本高收益低，**降级为可选优化，不单列**。
  - 收益：避免一次反向优化（抽不必要的 contract 包、偏离官方布局）；代价：零。

- [x] **B4 ide-* 插件 import ide-ui 的 sidebar.module.css 跨包 CSS 耦合**（✅ 完成并实机验证通过；round 37-41）
  - **整改**：`sidebar.module.css`（1371 行，ide-ui 自己不用、专为 3 包服务）用 `git mv` 迁到 `corum-ui-base/src/client/`（共享基座，单一事实源）；ui-base exports 加 `./sidebar.module.css` 子路径、ide-ui exports 移除；3 个消费包（ProjectPane/SidebarSkeleton/SessionsPane）import 改指 `@corum/corum-ui-base/sidebar.module.css`。
  - **实机验证**：全仓 typecheck PASS、build PASS、应用正常渲染（bodyTextLen=286、无「Failed to load / missed the module table」）、侧栏样式完整（historyRow/groupRow/btnNew 元素在、computed style padding 6px 8px/borderRadius 8px 已应用、侧栏 300px）。
  - **重要技术结论（round 40-41 诊断修正）**：初次 build 后曾白屏报错「require sidebar.module.css missed the module table」，初诊为「tsdown 跨包 css 子路径 import 不可行」；**经全量重建+实机复验修正——白屏实为 build 产物时序/缓存问题（首次 build 时 ui-base css 子路径产物未就绪致 tsdown resolve 错乱），跨包 css 子路径 import 本身可行**（消费包 bundle 已正确内联 sidebar 样式类，无 external require）。诊断过程存 `.dbg/B4-cross-package-css-issue.md`（含「若复现先用全量重建排除缓存」的提醒）。
  - 收益：共享样式归共享基座（ui-base），消除「跨包依赖 ide-ui 产物」的错位耦合，单一事实源。

---

## 第 3 批 · 长期（架构演进）

- [x] **C1 插件自声明 UI 能力替代壳层 EXCLUDE 清单硬编码 → 实证后关闭（前置不成立 + parseBootManifest 子项亦伪需求）**（round 43/46 主 Agent 评估）
  - 现状（架构报告精确数字）：`corum-ide-ui/index.tsx:370-396` **24 条**硬编码 EXCLUDE + 裸读 `__DSH_BOOT__.entries`（绕过官方 parseBootManifest）+ 对未排除者 registerSlot 时 label 从包名推导——插件可见性由壳反推而非自声明。
  - **前置障碍（关键）**：C1 的核心「各 feature 插件在自己 apply 里 registerSlot 自己的槽」**依赖 slotRegistry 跨 bundle 单例**（否则插件 A 注册的槽在插件 B/壳的 bundle 里不可见）。而 slotRegistry 单例化需 ui-base external 化——**B1-pre 已实机证明 external 化会白屏、已放弃**（round 36 归因）。**故 C1 的前置技术条件当前不成立，硬做会重蹈白屏。**
  - **可独立推进的低风险子项 → 实证亦不可行（round 46 主 Agent）**：`ide-ui/index.tsx` 改经官方 `parseBootManifest` 校验**做不到**——`parseBootManifest` 是 `dsh-client-modules` **loader 内部**的解析器（只被 loader 自己用，manifest.ts:167），**不在模块表基线**（seed.ts 无它）、ide-ui 未声明也无法在 client bundle 里 require 它。普通 client 插件读 `__DSH_BOOT__.entries` **只能裸读**（client 侧唯一方式）。架构报告说「ide-ui 绕过官方 parseBootManifest 校验」是误判——parseBootManifest 本就不给插件用，ide-ui 没有「绕过」，只是用了 client 侧唯一可用方式。**故 C1 子项（改 parseBootManifest）是伪需求/不可行，关闭**。EXCLUDE 清单收敛（插件自声明 visibility）需待跨 bundle 单例化可行后再评估（前置不成立，同 C1 整体）。
  - 收益：愿景落地（高，但前置不成立）；代价：高。**建议：暂缓整体，只做 parseBootManifest 低风险子项；单例化待官方模块表机制对「自定义共享模块」支持明朗后再重启。**

- [x] **C2 统一包形态（纯库 vs 插件）+ skill/team 双重身份拆分**（✅ 完成——按「只加注释警示」方案落地，round 44）
  - 现状：skill-manager-ui-dev/team-ui-dev 有 host apply/inject（shell 服务面）+ `dsh.client: null`（无 client 半），同时被 agent-ui-dev 内联 Panel 组件（AgentTestPanel.tsx:21-22 值 import）。
  - **风险评估**：「若被 insert 进 patch 面板会渲染两份、RPC 绑两次」是**假设性风险**——这两包是 dev 工具（dev-agent combo 专用），当前**没有**被 insert（只被 agent-ui-dev 内联），无人会把它们 insert。真实风险低。
  - **整改（已落地）**：给 skill-manager-ui-dev/team-ui-dev 两包的 package.json description 加「【注意】本包是被 agent-ui-dev 内联的组件库（src/index.ts 的 apply 仅为占位），**勿 insert 进 cordis patch**（否则面板渲染两份、RPC 绑两次）」警示注释（零风险、一行）。不动结构（去 apply 或改 insert 涉及 dev-agent patch 调整，中代价低收益，且风险本是假设性的）。
  - 收益：消假设性风险（注释警示防未来误 insert）；代价：一行注释。

- [x] **C3 会话域「壳状态写权」回收**（✅ **C3b 完成 + 主 Agent 实机验证通过**；C3a 暂缓——round 43/48）
  - **C3a（sidebarMode 服务化）→ 前置不成立，暂缓**：`__corumSidebarMode` 挂 window 全局的根因是 ui-base 未 external 化（sidebar-mode.ts 每 bundle 一份）。要「sidebarMode 演进为 IDE 壳 cordis 服务」需跨 bundle 服务单例——**与 B1-pre external 化同一堵墙（已证明白屏、放弃）**。故 C3a 前置条件不成立，**保留 `__corumSidebarMode`（有注释、工作正常），暂缓**。
  - **C3b（agent RPC 契约包）→ ✅ 已完成（主 Agent round 48 实机验证通过）**：agent-dev 抽 `src/contract/` 子路径导出（`CORUM_AGENT_METHODS` 12 端点 + `CORUM_PROJECT_METHODS` 11 端点方法名常量 + 每端点 Args/Result 类型 + 端点描述表），`package.json` 加 `./contract` 子路径；类型与 host 实现同源 re-export，**Args 用 `type` 别名**（type alias 的 object 有隐式索引兼容性、可赋给 caller 的 `Record<string, unknown>` 形参，interface 无此兼容——干净对齐，无需改 rpc-client）。5 个消费包 30+ 调用点改 type-only 引用 + 方法名常量 + args 类型标注，补 agent-dev devDependencies + pnpm install 建链接。**验证**：全仓 typecheck PASS、build PASS、**类型保障实证**（conversation 删 `CreateTaskAgentArgs.cwd` → tsc 报 `Property 'cwd' is missing ... required in CreateTaskAgentArgs` ✓）、应用实机正常（bodyTextLen=329、无错误）。
  - **整改即修真实 bug**：conversation apply.ts 的 `openProject` 原传 `{ projectId }` 与 host `@Remote('openProject')(id)` 签名错位（wire 参数名是 id），契约类型编译期拦截并纠正为 `{ id: projectId }`。
  - **验证**：全仓 typecheck PASS；agent-dev + 5 消费包 + desktop build PASS；类型保障实证（createTaskAgent 删必填 cwd → TS2741、openProject 传 projectId → TS2353，均编译期报错）；运行时不变实证（contract 产物仅方法名常量字符串、无服务逻辑；client bundle 只内联 contract 常量、无 host 依赖 import；常量值 == @Remote 字符串逐一核对一致）。
  - 收益：C3b 跨域 RPC 类型保障（✅ 已落地）；C3a 暂缓。

- [x] **C4 会话域 2 万行 fork 差异台账 + 升级 runbook**（✅ 完成；`docs/fork-delta.md` 257 行，基于真实 diff 实证）
  - 交付：6 个 fork 包逐文件差异分类（相同 103/仅改名 26/实质 65/新增 19/删除 11）+ 每处实质差异原因 + 🔴🟡🟢 rebase 风险 + 升级 runbook + 「不做抽包」实证记录（防反向优化）。
  - **修正事实**：官方基线实为 `0.1.2-alpha.2`（非 alpha.1），corum 各 fork dependencies 仍锁 alpha.1，双向差一代（已记录）。
  - **新发现 5 项**（审计未覆盖）：错误码命名空间欠债（conversation 4 处停 alpha.1 裸码，Host 升级后静默失效）、chat 缺官方 `message.turnTime.*` 4 键、questions 缺 plan-review 渲染器、chat/contract/slots.ts:129 包内反向依赖、官方 TurnUsagePanel 与 corum TurnUsageDisclosure 方向相反的结构性冲突源。
  - 收益：fork 升级成本从考古变按单执行。

- [~] **C5 agent 域归并**（⚠️ **大工程高风险，暂缓**——round 43 主 Agent 评估）
  - 现状：agent-dev 单包 5.9k 行包揽 profile/compile/runtime/project/team/event-log 六个子域（agent-service.ts 1577 行）。
  - **评估**：拆 3 包（agent-profile/agent-runtime/project-data）是大工程，涉及 RPC 命名空间稳定性（`corumAgent`/`corumProject`/`corumRuntime` 等 @Remote 端点被 conversation/ide-sidebar/agent-ui-dev 消费，拆包若改服务名会破坏跨域调用）。A2 已删 project-core 消除双运行时哑弹（H3 的核心风险已解）。**六子域解耦是「整洁性」收益，非「正确性」必需**，当前单包内聚可接受。
  - **可独立推进的低风险子项**：agent-service.ts（1577 行）等超大文件**包内拆分**（不拆包、只把单文件按职责拆成同包多文件），降可读性——零 RPC 风险。
  - 收益：解耦（整洁性，非必需）；代价：高（RPC 稳定性风险）。**建议：暂缓拆包；如需改善可读性只做包内文件拆分。**

---

## 第 4 批 · 安全整改遗留（来自安全 Agent 清单外发现，并入架构期处理）

- [x] **S1 `no-sandbox` 收敛**（✅ 完成；main.ts no-sandbox 收敛为「仅未打包 dev 构建」追加：复用现有 `isPackaged()`（检测 Resources/host/lib/bridge.js），dev 追加、打包签名版不追加恢复 Chromium 沙盒；`CORUM_NO_SANDBOX=0/1` 可显式覆盖。typecheck+build PASS）
- [x] **S2 combo `patches`/`cwd` 校验**（✅ 完成；combos.ts 在 readUserCombos 解析入口新增 `sanitizeComboCwd`（非空必须是存在的绝对路径目录，否则降级为空+warn）与 `sanitizeComboPatches`（每条必须存在且是 .yml/.yaml 文件，否则剔除+warn），告警风格对齐 sanitizeComboEnv。typecheck+build PASS）
- [x] **S3 `dispose()` 清 pending op**（✅ 完成；bridge-client.ts dispose() 在 kill 前调用 `this.failAllPending('host disposed')`（复用 restart 的现有私有方法），悬挂 op 立即失败而非等满超时。typecheck+build PASS）
- [x] **S4 `sessionId` 字符集校验**（✅ 完成；结论：encodeSegment 逐字符白名单编码（`A-Za-z0-9._-` 原样，其余含 `/`/`\`/`..` 全转 `~XXXX`），输出绝无路径分隔符/父目录引用，**已防注入**；补注释确认，无需额外 slug 校验。typecheck+build PASS）

---

## 验证记录（每批完成后更新）

| 批次 | 日期 | typecheck | build | 实机验证 | 备注 |
|---|---|---|---|---|---|
| 第 0 批 | （本次） | 28 包 PASS | desktop PASS | 已实机（cdp.sh 重启 coding combo，渲染正常无 JS 错，corum-fs 钳制/超时/CDP 回环已入产物） | 安全+类型 |
| 第 1 批 | （本次） | 26 包 PASS（删 project-core/ide-test-panel 后） | desktop PASS + chat PASS | 代码层验证（产物 require 清单不变、裸字符串清零）；实机回归待 B1 后统一做 | A1 依赖降级 / A2 死代码+双运行时 / A2b 事件收编 / A3 实证重定义（契约边界已成立，无需抽包） |
| 第 4 批 | （本次） | desktop PASS | desktop PASS | 代码层验证（git diff 自审仅 4 处目标改动；S4 经读 encodeSegment 源码判定已防注入） | S1 no-sandbox 收敛（dev 禁用/pack 恢复）/ S2 combo patches+cwd 校验 / S3 dispose 清 pending op / S4 encodeSegment 补注释确认 |
| C3b | （本次） | 全仓 PASS | agent-dev + 5 消费包 + desktop PASS | 代码层验证（类型保障实证：createTaskAgent 删 cwd → TS2741、openProject 传 projectId → TS2353；运行时不变实证：contract 产物仅常量字符串、client bundle 只内联常量的无 host import；顺带修 apply.ts openProject 参数名 bug） | agent-dev `contract/` 子路径（方法名常量 + Args/Result 类型 + 端点描述表），5 消费包 30+ 调用点 type-only 引用 |

---

## 给后续 Agent 的接力说明
1. 开工前先读本文件 + `docs/audit/CODE-AUDIT-REPORT.md`，按批次顺序推进（第 1 批→第 2 批→第 3 批；第 4 批安全可穿插）。
2. 每完成一项：更新 `[x]` + 日期 + 验证结果，跑 `pnpm -r --filter './packages/**' run typecheck` 与 desktop `pnpm run build`，涉及 UI/host 行为的用 `corum-cdp-verify` skill 实机验证。
3. **不要**在本清单未完成前启动新功能开发（用户硬性约束）。
4. 改 `packages/desktop` 与改 `packages/plugins` 的任务可并行子 Agent（文件集不重叠）；同包内的改动串行。
