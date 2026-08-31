# 下一阶段处理清单（暂缓 / 关闭项交接）

> **交接说明**：本清单面向**下一个会话**的 Agent/开发者，汇总本次架构整改（goal `goal-dc9edf6f`，提交 `ce77b13d`）中**被暂缓或关闭**的项，以及每项的**暂缓原因、重启条件、建议切入点**。
> 本次整改已完成项见 `docs/audit/ARCHITECTURE-REMEDIATION-TODO.md`（全部 [x]）。本文档只列**未完成、需在下一阶段决策/处理**的项。
>
> **关键背景**：多项暂缓都指向**同一根因**——dsh 当前模块表机制对「发行版自定义共享模块」没有可靠支持（官方只有 8 个硬编码基线模块，自定义的实机会白屏）。详见下文「根因专项」。

---

## 0. 根因专项（多项暂缓的共同前置，最高优先）

### B1-pre：ui-base external 化（自定义共享单例模块）——已放弃，待官方机制明朗

- **要解决的问题**：`corum-ui-base` 被各消费包内联（每 bundle 一份），导致 `__corumSidebarMode` 挂 window 全局 + `slotRegistry` 按 bundle 拆分（插件 A 注册的槽在壳/插件 B 的 bundle 不可见）。
- **已做的尝试**：把 ui-base 改造成 `dsh.client` 插件（路径乙：dsh.client 声明 + 指向产物 bundle + 6 消费包 external）——编译/build/内联清除三层验证过，但 **round 36 实机白屏**（boot 图含 ui-base、`#root` 空、无 JS 报错、UI 静默不挂载）；**回退后立即恢复**，确凿证明 external 化本身是白屏根因。
- **暂缓原因**：dsh 共享单例只有 8 个硬编码基线模块（`dsh-client-web/src/seed.ts` 的 `getStaticModules()`：react/cordis/store/ui-slots/ui-primitives 等），desktop 壳**无 seed 注入点**（路径甲不可行），自定义共享模块经 dsh.client 插件路径（路径乙）实机白屏。**当前机制下技术不可行/风险过高**。
- **重启条件**：官方模块表对「发行版自定义共享模块」提供可靠支持（如开放的 seed 注入点 / 模块表注册 API / 文档化的共享模块机制）。
- **参考资料**：调研笔记 `.dbg/B1-boot-graph-findings.md`（boot 图发现机制 + 「无 apply 纯库需 no-op apply 才能被 cordis 激活」结论 + 完整改造步骤 + 风险点）、`.dbg/B1-ui-base-external-plan.md`（模块表机制勘察）。
- **建议切入点**：重启时先验证「官方是否有 seed 注入 API」；若无，评估「slotRegistry 改为 cordis 服务」（见 C3a 同思路）或「每个 bundle 自带注册表 + 启动时合并」的替代方案（绕开单例化）。

---

## 1. 高价值但前置不成立（依赖根因专项）

### C1：插件自声明 UI 能力替代壳层 EXCLUDE 清单硬编码

- **要做的**：让插件在自己的 apply 里 `registerSlot` 自声明槽位（带 `visibility: 'fixed'|'addable'|'hidden'`），替代 `corum-ide-ui/index.tsx:370-396` 的 24 条硬编码 EXCLUDE 清单；README「扫描即插即用」愿景。
- **暂缓原因**：核心「插件注册的槽在壳的 bundle 可见」依赖 `slotRegistry` 跨 bundle 单例化 = B1-pre 那堵墙（见上）。前置不成立。
- **已确认的子项也关闭**：`ide-ui` 裸读 `__DSH_BOOT__` 改 `parseBootManifest` 校验**不可行**——`parseBootManifest` 是 `dsh-client-modules` loader 内部解析器（不在模块表基线、client bundle require 不到），普通 client 插件**只能裸读** `__DSH_BOOT__`（client 侧唯一方式）。架构报告「绕过校验」是误判。
- **重启条件**：根因专项解决（slotRegistry 可跨 bundle 单例化）**或**改用替代方案（如启动时壳扫描各插件的注册意图、或 cordis 服务注册槽位）。
- **建议切入点**：若重启根因专项，C1 是其最大受益项；若不重启，可先做「EXCLUDE 清单注释完善 + visibility 字段预留」的低风险铺垫。

### C3a：sidebarMode 演进为 IDE 壳 cordis 服务

- **要做的**：把 `__corumSidebarMode`（侧栏 task/project 模式，window 全局挂点）改成 IDE 壳的 cordis 服务（`ctx.layout` 同族），消除会话域对壳域状态的越权写（conversation/apply.ts:271-285 setSidebarMode）。
- **暂缓原因**：`__corumSidebarMode` 挂 window 的根因就是 ui-base 未 external 化（sidebar-mode.ts 每 bundle 一份，模块级单例互不通）。要做成 cordis 服务单例，同样需跨 bundle 模块单例化 = B1-pre 那堵墙。
- **重启条件**：根因专项解决；或评估「sidebarMode 作为 ide-shell 的 cordis 服务、conversation 经 inject 消费」（cordis 服务天然跨 bundle 单例，可能绕开 ui-base 单例化——**这是最值得先验证的替代路径**）。
- **建议切入点**：优先验证「cordis 服务是否天然跨 bundle 单例」——若是，C3a 可不依赖 external 化直接做（sidebarMode 做成 ide-shell 的 cordis 服务），这可能是绕开根因墙的钥匙，也能顺带为 C1 探路。

---

## 2. 大工程高风险（独立、与根因无关，但收益是整洁性）

### C5：agent 域归并/拆包

- **要做的**：`corum-agent-dev`（5.9k 行，包揽 profile/compile/runtime/project/team/event-log 六子域）拆成 agent-profile / agent-runtime / project-data 三包。
- **暂缓原因**：① RPC 命名空间稳定性风险——`corumAgent`/`corumProject`/`corumRuntime` 等 @Remote 端点被 conversation/ide-sidebar/agent-ui-dev 跨域调用，且 C3b 刚建立契约，拆包改服务名/归属会破坏；② 核心风险（双 AgentRuntime 调度分叉 H3）已在 A2 删 `corum-project-core` 时解决；③ 收益是整洁性（六子域解耦）非正确性必需。
- **重启条件**：有明确的解耦需求（如 agent-dev 继续膨胀、或某子域需独立演进/复用）；且需先冻结 RPC 命名空间（C3b 契约已提供稳定面）。
- **低风险投资替代（可先做的）**：**包内文件拆分**——`agent-service.ts`（1577 行）等超大文件按职责拆成同包多文件（不拆包、不动 RPC），零风险降可读性。建议下一阶段优先做这个而非拆包。

---

## 3. 可选优化（低优先、非阻塞）

### ide-ui 业务 chrome 过多（上帝壳的另一半）

- **问题**：`corum-ide-ui` 除壳/编排外，还承担大量业务 chrome（PluginManagerPanel/SettingsShell/settings-chrome/SettingsGeneralSection/theme-layer/AppFrame 896 行），「壳无业务」只成立一半。
- **说明**：这与「B3 壳/契约分离」是两回事（B3 已实证关闭——feature 对壳全是 `import type {}`，与官方一致，无需拆契约包）。本项是**壳内聚度**问题。
- **建议**：低优先。可考虑把「插件中心（PluginManagerPanel）」「设置壳（SettingsShell 系列）」拆成独立 feature 插件（经槽位注册进壳），让壳只留网格系统 + 编排。收益中等、成本中高，非阻塞。

### agent-service.ts 等超大文件拆分

- 见 C5 的「包内文件拆分」替代项。`agent-service.ts`(1577)、`AgentTestPanel.tsx`(1444)、`runtime.ts`(1222)、`McpManagerPanel.tsx`(1110) 等 700+ 行文件可按职责拆分降可读性，零风险。

---

## 4. 已确认「不做」（关闭项，防后续重复踩坑）

以下项**经实证为伪需求/反向优化，明确不做**，记录以防下一个会话再次提出：

- **A3 会话域共享类型下沉 contract 包**：实证 chat 对 conversation 的类型 import 全部来自 `contract/` 目录（依赖契约而非实现），且官方 ui-chat 对官方 ui-conversation 消费方式逐行相同。**不抽包**（会让布局偏离官方、rebase 更痛）。
- **B3 corum-ide-ui 壳/契约分离抽 contract 包**：实证 9 个 feature 包对 ide-ui 全是 `import type {}`（0 值/实现耦合），官方 feature 插件对官方壳也是同样 `import type {}`（壳集中声明 SlotMap、插件注册是官方正常模式）。**不抽 contract 包**。
- **C1 子项 ide-ui 改 parseBootManifest**：`parseBootManifest` 是 loader 内部、不暴露给插件，client 插件只能裸读 `__DSH_BOOT__`。**不改**。

---

## 5. 给下一个会话的建议推进顺序

1. **优先验证「cordis 服务是否天然跨 bundle 单例」**——若是，则 C3a（sidebarMode 服务化）可不依赖 external 化直接做，且为 C1 探路。这是绕开根因墙的最低成本突破口。
2. 若上一步成立：做 **C3a** → 再评估 **C1**（插件自声明槽）。
3. 若根因专项（官方模块表支持自定义共享模块）明朗：重启 **B1-pre**（ui-base external 化），它是 C1/C3a 的彻底解。
4. 低风险可随时做：**超大文件包内拆分**（agent-service.ts 等）、**ide-ui 业务 chrome 拆分为独立 feature 插件**（可选）。
5. **C5 拆包**：仅在 agent-dev 继续膨胀或子域需独立演进时再启动，且先冻结 RPC 命名空间。

---

## 参考文档（交接阅读顺序）

1. `docs/audit/ARCHITECTURE-REMEDIATION-TODO.md` —— 本次整改全部已完成项（含每项结论/验证/实证依据）。
2. `docs/audit/CODE-AUDIT-REPORT.md` —— 原始代码审计报告（P0/P1/P2 发现）。
3. `docs/fork-delta.md` —— 会话域 fork 差异台账 + 官方升级 runbook。
4. `.dbg/B1-boot-graph-findings.md`、`.dbg/B1-ui-base-external-plan.md` —— 模块表机制调研（B1-pre 重启的技术依据）。
5. `.dbg/audit-*.md` —— 各分片审计详情。
