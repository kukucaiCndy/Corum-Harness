# 下一阶段处理清单（暂缓 / 关闭项交接）

> **交接说明**：本清单面向**下一个会话**的 Agent/开发者，汇总本次架构整改（goal `goal-dc9edf6f`，提交 `ce77b13d`）中**被暂缓或关闭**的项，以及每项的**暂缓原因、重启条件、建议切入点**。
> 本次整改已完成项见 `docs/audit/ARCHITECTURE-REMEDIATION-TODO.md`（全部 [x]）。本文档只列**未完成、需在下一阶段决策/处理**的项。
>
> **关键背景**：多项暂缓都指向**同一根因**——dsh 当前模块表机制对「发行版自定义共享模块」没有可靠支持（官方只有 8 个硬编码基线模块，自定义的实机会白屏）。详见下文「根因专项」。
>
> **本专项进展（cordis 服务单例路径）**：根因墙对「**cordis 服务化**」路径不成立——cordis 服务实例的唯一性由 root context 的 `reflect.store` 保证（不经各 bundle 模块实例），跨 bundle 天然单例（实证 `.dbg/cordis-singleton-probe.md`）。**C3a 已借此路径完成**（sidebarMode 服务化，见 §1），C1 前置随之打通。B1-pre（模块级 external 化）仅在还需「非 cordis 服务的模块级共享」时才需重启。

---

## 0. 根因专项（多项暂缓的共同前置，最高优先）

### B1-pre：ui-base external 化（自定义共享单例模块）——已放弃，待官方机制明朗（0.1.2-alpha.2 复核：维持放弃）

- **要解决的问题**：`corum-ui-base` 被各消费包内联（每 bundle 一份），导致 `__corumSidebarMode` 挂 window 全局 + `slotRegistry` 按 bundle 拆分（插件 A 注册的槽在壳/插件 B 的 bundle 不可见）。
- **已做的尝试**：把 ui-base 改造成 `dsh.client` 插件（路径乙：dsh.client 声明 + 指向产物 bundle + 6 消费包 external）——编译/build/内联清除三层验证过，但 **round 36 实机白屏**（boot 图含 ui-base、`#root` 空、无 JS 报错、UI 静默不挂载）；**回退后立即恢复**，确凿证明 external 化本身是白屏根因。
- **暂缓原因**：dsh 共享单例只有 8 个硬编码基线模块（`dsh-client-web/src/seed.ts` 的 `getStaticModules()`：react/cordis/store/ui-slots/ui-primitives 等），desktop 壳**无 seed 注入点**（路径甲不可行），自定义共享模块经 dsh.client 插件路径（路径乙）实机白屏。**当前机制下技术不可行/风险过高**。
- **0.1.2-alpha.2 复核结果（新增，详见 `.dbg/b1-official-mechanism-recheck.md`）**：机制墙依旧（无 seed 注入点/注册 API），且**新增规范墙**——官方 `packages/client/AGENTS.md` §Shared modules 明文「`dsh.client.external` 不是 feature 插件的依赖机制」，`verify-client-packages.ts` 自动拒绝违规声明；官方正解（静态 owner + cordis service）正是 C3a/C1 已落地的路径。**B1-pre 维持关闭**，开发准则已沉淀进 `docs/dev-conventions.md` §3.1/§3.4b。
- **重启条件**（收紧为四条，缺一不可）：① 出现必须「模块级（非 cordis 服务）跨 bundle 共享可变单例」的真实需求；② 官方开放 seed 注入点或文档化该形态（当前文档方向相反）；③ 走 dsh.client 路径时消费包同时 inject+external 被共享包（api-gateway 配对纪律）且声明通过官方校验；④ dev 实机回归覆盖 HMR bundle swap（验证 exports 身份不分裂）。
- **参考资料**：调研笔记 `.dbg/b1-boot-graph-findings.md`（boot 图发现机制 + 「无 apply 纯库需 no-op apply 才能被 cordis 激活」结论 + 完整改造步骤 + 风险点）、`.dbg/b1-ui-base-external-plan.md`（模块表机制勘察）、`.dbg/b1-official-mechanism-recheck.md`（0.1.2-alpha.2 重启条件复核 + round 36 白屏新归因线索）。
- **建议切入点**：重启时先验证「官方是否有 seed 注入 API」；若无，评估「slotRegistry 改为 cordis 服务」（见 C3a 同思路）或「每个 bundle 自带注册表 + 启动时合并」的替代方案（绕开单例化）。

---

## 1. 高价值但前置不成立（依赖根因专项）

### C1：插件自声明 UI 能力替代壳层 EXCLUDE 清单硬编码 —— ✅ 已完成（本专项）

- **已做**：slotRegistry 从 ui-base 模块级 Map（每 bundle 一份）服务化为 IDE 壳的 cordis
  服务 `ctx.slotRegistry`（跨 bundle 单例，复用 C3a 模式）；`SlotMeta` 加 `visibility`
  三态（fixed/addable/hidden）；**24 条硬编码 EXCLUDE 清单已删**，扫描收敛为「插件已自
  声明 ⇒ 尊重；未自声明 ⇒ hidden」一条规则；`corum-agent-ui-dev` 落地首个插件自声明示例
  （`visibility:'addable'`）；PluginManagerPanel 视图管理只列 addable 槽。
- **关键时序教训**：cordis 模块顶层 = 加载期（apply 未跑）、apply = 激活期——模块顶层的
  注册不能用「bind 一次性赋值后端」（会锁进 fallback），必须「每次调用时解析后端 +
  drain 合并早期写」（`resolveBackend()` + `drainPendingSlots`，实证 trace 见
  `.dbg/c1-slot-registry-service.md`）。
- **验证**：三包 build+typecheck 绿；CDP 实机——注册表汇聚 46 条（5 内建 fixed + 41
  hidden）、跨 bundle 动态注册立即可读、GridView 按服务 meta 渲染（侧栏 minWidth/pinned
  生效）、视图管理过滤正确、控制台零报错。
- **记录**：`.dbg/c1-slot-registry-service.md`。

### C3a：sidebarMode 演进为 IDE 壳 cordis 服务 —— ✅ 已完成（本专项）

- **已做**：sidebarMode 从 window 全局 `__corumSidebarMode`（ui-base/sidebar-mode.ts，已删）收敛进 IDE 壳的 cordis 服务 `ctx.layout`（`LayoutController` 同族，跨 bundle 单例）。服务面：`setSidebarMode/getSidebarMode/onSidebarModeChange/sidebarModeSnapshot`（uSES 源）。会话域 4 处越权写（`corum-ui-conversation/apply.ts` openProject/newProject→project、openTask/newTask→task）改经 `ctx.layout.setSidebarMode`；侧栏骨架（`corum-ide-sidebar-ui`）经 inject 面 `useSidebarMode` 选择器读 + `setSidebarMode` 动作写。**无需 external 化**——前置「cordis 服务跨 bundle 单例」已实证（`.dbg/cordis-singleton-probe.md`）。
- **顺带修复**：空态收敛（commit `fb2003e9`）后 `__corumSidebarMode` 唯一读端被删、只剩死写——**侧栏 tab 联动功能实际已退化**（点空态「新建项目/任务」卡侧栏不翻转）。本项经 cordis 服务恢复了该联动（CDP 实证：点「新建项目」卡 → 侧栏 `data-mode` task→project + 项目面板接管）。
- **关键设计**：sidebarMode 挂 `ctx.layout`（不新建服务）——shell/sidebar/conversation 都已 inject 它，零新服务零额外 inject。conversation 类型上用**局部能力接口** `SidebarModeCapableLayout` 收窄 `ctx.layout`（其 inject 的 `ILayout` 来自官方基座 `dsh-client-ui-layout` 窄接口；corum 运行时 `LayoutController` 是超集）——与 C3b 契约同思路，编译期保障、零运行时改动、不强耦合 ide-ui 包。
- **验证**：四包 build+typecheck 绿；CDP 实机——tab 双向切换正常、跨 bundle 联动恢复、`__corumSidebarMode` 已删、控制台零报错、无白屏。
- **对 C1 的意义**：本项实证了「cordis 服务作为跨 bundle 单例载体」的完整模式（provide + inject + uSES 源 + InjectFace 选择器 Hook），`slotRegistry` 可按同思路服务化——C1 前置墙已拆。

---

## 2. 大工程高风险（独立、与根因无关，但收益是整洁性）

### C5：agent 域归并/拆包

- **要做的**：`corum-agent-dev`（5.9k 行，包揽 profile/compile/runtime/project/team/event-log 六子域）拆成 agent-profile / agent-runtime / project-data 三包。
- **暂缓原因**：① RPC 命名空间稳定性风险——`corumAgent`/`corumProject`/`corumRuntime` 等 @Remote 端点被 conversation/ide-sidebar/agent-ui-dev 跨域调用，且 C3b 刚建立契约，拆包改服务名/归属会破坏；② 核心风险（双 AgentRuntime 调度分叉 H3）已在 A2 删 `corum-project-core` 时解决；③ 收益是整洁性（六子域解耦）非正确性必需。
- **重启条件**：有明确的解耦需求（如 agent-dev 继续膨胀、或某子域需独立演进/复用）；且需先冻结 RPC 命名空间（C3b 契约已提供稳定面）。
- **低风险投资替代（可先做的）**：**包内文件拆分**——`agent-service.ts`（1577 行）等超大文件按职责拆成同包多文件（不拆包、不动 RPC），零风险降可读性。建议下一阶段优先做这个而非拆包。

---

## 3. 可选优化（低优先、非阻塞）

### ide-ui 业务 chrome 过多（上帝壳的另一半）—— 🔄 部分完成（插件中心已拆出）

- **问题**：`corum-ide-ui` 除壳/编排外，还承担大量业务 chrome（PluginManagerPanel/SettingsShell/settings-chrome/SettingsGeneralSection/theme-layer/AppFrame 896 行），「壳无业务」只成立一半。
- **说明**：这与「B3 壳/契约分离」是两回事（B3 已实证关闭——feature 对壳全是 `import type {}`，与官方一致，无需拆契约包）。本项是**壳内聚度**问题。
- **✅ 插件中心已拆出（本专项）**：`PluginManagerPanel`(563) + `plugin-meta.ts`(185)
  迁到新插件 **`@corum/corum-ide-plugin-manager-ui`**（经 cordis.ide.patch.yml 挂载）。
  壳侧改动：`LayoutController` 加 `openPluginManager()`（广播
  `corum:open-plugin-manager` 事件）+ 网格读面（`hiddenSlotsSnapshot`/`onGridChange`/
  `isInGrid`，挂 `GridActions`）；AppFrame 删面板内联渲染与 pluginManager RPC
  caller，触发器（标题栏/侧栏轨按钮）改经 inject 面调 `layout.openPluginManager()`。
  新插件自建 modal 浮层（独立 bundle 复用不了壳 FloatingLayer），面板三区数据走
  pluginManager RPC + `ctx.layout` 网格面（C3b 能力接口收窄 `GridCapableLayout`——
  壳 bundle 不可静态值 import，B1-pre 教训）。
- **验证**：双包 build+typecheck 绿；CDP 实机——新插件进 composition（registry 47，
  自声明 hidden 槽）、点「插件中心」按钮面板打开（三区 tab 齐）、已安装清单 RPC
  返回 11 条、视图管理过滤正确、Escape 关闭无泄漏、开关循环无重复 overlay。
- **待做（可选、非阻塞）**：SettingsShell 系列（SettingsShell/settings-chrome/
  SettingsGeneralSection/theme-layer）同理可拆独立 feature 插件；AppFrame(925) 壳
  内聚度另议。

### agent-service.ts 等超大文件拆分 —— ✅ 已完成（本专项，四个点名文件全部拆完）

- 见 C5 的「包内文件拆分」替代项。700+ 行文件可按职责拆分降可读性，零风险（不拆包、不动 RPC 命名空间）。
- **✅ agent-service.ts（1577→1174 行）**：拆出 `builtin-profiles.ts`（smoke/pm/task
  内置 profile 幂等工厂）、`event-projection.ts`（会话事件 UI 投影）、`skill-catalog.ts`
  （skills 目录扫描）、`home.ts`（corumHome）、`skill-entry.ts`（SkillEntry 共享类型）。
  @Remote 端点全留原类，再导出保 import 面（index/project-service/runtime/contract 零改动）。
- **✅ runtime.ts（1222→1054 行）**：拆出 `runtime-task.ts`（Task 领域模型 + laneLabel/
  makeTaskSource/normalizeTask/taskRef/renderTaskMessage 纯函数）、`runtime-state.ts`
  （LaneState/ProfileRuntime 状态接口 + STALL 常量）。调度方法与端点留原类，再导出保
  index.ts import 面。
- **✅ project-data-service.ts（899→840 行）**：拆出 `project-data-guards.ts`（TASK_FLOW/
  BUG_FLOW 状态机边 + inferProfession/requireMember/transition/parseEntity 纯函数）。
  该文件 RPC 端点密度高、可拆纯函数相对少，收益较小但模式一致。
- **✅ AgentTestPanel.tsx（1404→1042 行）**：拆出 `panel-types.ts`（本地镜像类型 +
  draft 构造）、`panel-dialogs.tsx`（NewProjectDialog/GroupManageDialog/ChatMessageView）。
- **✅ McpManagerPanel.tsx（1110→359 行）**：拆出 `mcp-model.ts`（RPC 镜像类型 + 纯函数）、
  `mcp-widgets.tsx`（KvEditor/Dialog 共享小部件）、`mcp-dialogs.tsx`（三个业务弹窗，
  原代码逐字节迁移）。
- **验证（五项统一）**：build + 全部消费包 typecheck 绿；CDP 实机（host/renderer 按需
  重启）RPC 冒烟全 `ok:true`、UI 健康无白屏。
- **未拆（700+ 行剩余，多为 fork 包或壳内聚）**：`AppFrame.tsx`(925)、`facade.ts`(923)、
  `SessionsPane.tsx`(864)、`assembler.ts`(847) 等——session 域 fork 包（动则偏离官方、
  rebase 更痛，fork-delta 纪律）与 ide 壳组件（§3 壳内聚度另议），不在本专项。

---

## 4. 已确认「不做」（关闭项，防后续重复踩坑）

以下项**经实证为伪需求/反向优化，明确不做**，记录以防下一个会话再次提出：

- **A3 会话域共享类型下沉 contract 包**：实证 chat 对 conversation 的类型 import 全部来自 `contract/` 目录（依赖契约而非实现），且官方 ui-chat 对官方 ui-conversation 消费方式逐行相同。**不抽包**（会让布局偏离官方、rebase 更痛）。
- **B3 corum-ide-ui 壳/契约分离抽 contract 包**：实证 9 个 feature 包对 ide-ui 全是 `import type {}`（0 值/实现耦合），官方 feature 插件对官方壳也是同样 `import type {}`（壳集中声明 SlotMap、插件注册是官方正常模式）。**不抽 contract 包**。
- **C1 子项 ide-ui 改 parseBootManifest**：`parseBootManifest` 是 loader 内部、不暴露给插件，client 插件只能裸读 `__DSH_BOOT__`。**不改**。

---

## 5. 给下一个会话的建议推进顺序

1. ~~**优先验证「cordis 服务是否天然跨 bundle 单例」**~~ —— ✅ **已实证成立**（本专项，`.dbg/cordis-singleton-probe.md`）：cordis 服务实例的唯一性由 root context 的 `reflect.store` 保证，不经过各 bundle 模块实例，故跨 bundle 天然单例。**B1-pre 那堵墙对「服务化」路径不成立**。
2. ~~做 **C3a**~~ —— ✅ **已完成**（本专项）：sidebarMode 已服务化进 `ctx.layout`，跨 bundle 联动恢复，`__corumSidebarMode` window 全局已删。
3. ~~做 **C1**~~ —— ✅ **已完成**（本专项）：slotRegistry 已服务化为 `ctx.slotRegistry`，
   EXCLUDE 清单已删、visibility 三态落地、插件自声明示例（corum-agent-ui-dev）已跑通。
   记录 `.dbg/c1-slot-registry-service.md`（含「模块顶层 vs apply 时序」教训——后续
   服务化「模块顶层写」的状态时必须用 resolveBackend + drain 模式）。
4. 若根因专项（官方模块表支持自定义共享模块）明朗：重启 **B1-pre**（ui-base external 化）——注意：**仅当还需「模块级单例跨 bundle」（非 cordis 服务）时才需要**；C1/C3a 已证明服务化路径可绕开它，B1-pre 的彻底解价值已降级为「模块级共享」场景。
5. ~~低风险可随时做：**超大文件包内拆分**~~ —— ✅ **已完成**（本专项，§3 四个点名
   文件全拆完）。剩余 700+ 行多为 fork 包/壳组件（不在本专项）。**ide-ui 业务 chrome
   拆分为独立 feature 插件**（§3，可选）仍可随时做。
6. **C5 拆包**：仅在 agent-dev 继续膨胀或子域需独立演进时再启动，且先冻结 RPC 命名空间。

---

## 参考文档（交接阅读顺序）

1. `docs/audit/ARCHITECTURE-REMEDIATION-TODO.md` —— 本次整改全部已完成项（含每项结论/验证/实证依据）。
2. `docs/audit/CODE-AUDIT-REPORT.md` —— 原始代码审计报告（P0/P1/P2 发现）。
3. `docs/fork-delta.md` —— 会话域 fork 差异台账 + 官方升级 runbook。
4. **`docs/dev-conventions.md` —— corum 开发规范（跨 bundle 状态一律 cordis 服务、禁 window 全局；打包/实机纪律）。新插件/改跨包状态前必读。**
5. `.dbg/b1-boot-graph-findings.md`、`.dbg/b1-ui-base-external-plan.md` —— 模块表机制调研（B1-pre 重启的技术依据）。
6. `.dbg/cordis-singleton-probe.md`、`.dbg/c3a-sidebar-mode-service.md` —— cordis 服务跨 bundle 单例实证 + C3a 落地记录（C1 复用同模式）。
7. `.dbg/audit-*.md` —— 各分片审计详情。
