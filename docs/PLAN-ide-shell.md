# PLAN：桌面 IDE 化外壳（IDE Shell）

> 状态：方案定稿，待评审。本文只做设计决策与分层规划，不包含逐行实现。
> 配套：`HANDOFF.md`（现状交接）、`PLAN-code-editor.md`（Monaco 集成）、`TODO.md`（技术债）。

## 1. 目标与愿景

把 corum Agent OS 桌面端从「聊天 App + 一个临时编辑器 tab」重构成**编码 IDE 的壳**：

- 会话 = 编辑器 tab：打开过的会话进顶部 tab 栏，切换 tab = 切换 active 会话。
- 项目 = 资源管理器：文件树、workspace 管理、会话分组在左侧，按 IDE 习惯切换。
- 会话管理动词（重命名 / 分支 / 归档 / 保存日志 / 删除）**收拢到列表条目**，不再散落右上角。
- Monaco 编辑器**常驻右侧编辑区**，而非挂在会话的 tab 环里。
- 底部面板（终端 / 待办 / 队列）、状态栏（连接状态、当前模型、当前项目）作为 IDE 标志性区域。

一句话：**把「会话」和「项目」统一进一个 IDE 心智模型，用单一 active 会话 + tab 栏，不碰官方内核。**

## 2. 铁律（不可违反）

1. **不改内核**：`/Users/kukucai/dsh` 只读，任何改动都必须落在 corum 仓库的用户空间（插件 + overlay + preset + Electron 壳）。
2. **不碰 `dsh-client-runtime`**：会话打开模型维持官方单例 `sessions.current`。多 tab 是「打开过的会话集合 + 单一 active」，**不是**真多会话并行渲染。
3. **slot 接管，不 monkey-patch**：替换任何官方 UI，一律走「`cordis.patch.yml` 禁用官方行 + insert 我们的行」，并在我们的包里**重新声明同名 child slot**，让下游插件零改动自动挂载。
4. **消费框架 hooks**：所有数据经 `useSessions` / `useWorkspaces` / `useSession` / `ctx.slots`，**不直连 host RPC**。

## 3. 现状架构盘点（已核实）

### 3.1 官方布局层（可整块接管）

```
root (built-in, single)
 └─ AppFrame  ← ui-layout 注册，纯几何：三列 grid + 拖拽把手 + 让位求解(columns.ts)
     ├─ sidebar      (single, root)          ← ui-sidebar 的 SidebarRoot
     ├─ conversation (single, session-maybe) ← ui-conversation 的 ConversationRoot
     ├─ details      (single, session)        ← ui-conversation 的 DetailsPanel
     └─ shell.overlay (list, root)            ← 浮层（badge/toast）
```

关键事实：

- `AppFrame` **只做几何**，无业务。它注册进 `root`（`single`），所以**整体替换 AppFrame = 换整个外壳**。
- 我们若在 `root` 用不同 priority 重新注册、并**重新声明同名的 child slot**（`sidebar`/`conversation`/`details`/`shell.overlay`），下游 `ui-sidebar`、`ui-conversation` **一行不改**。
- `ctx.layout`（`ILayout`）是跨插件面板动作面：`toggleSidebar / openDetails / closeDetails`。我们新外壳若要兼容下游（如 `ui-conversation` 的 `openDetails`、`ui-sidebar` 的 `toggleSidebar`），**必须提供同形 `ctx.layout` 服务**。

### 3.2 会话模型（单一 active，多 tab 靠 UI 态）

官方 `SessionRuntime` 是**单例**：

- `SessionListState.current: SessionId | undefined` 是唯一 active 会话。
- 源码注释明示：`today the stage is current; the staged state can widen to a multi-pane list later` —— 多窗格是**官方预留未实现**。
- scope 生命周期：`current` 切换时，旧 scope frozen、新 scope open；`sessions.open(id)` 即切换。

结论（已拍板）：**tab 栏 = 打开过的会话集合（UI 态，可持久化）；active tab = `sessions.current`；切换 = `sessions.open(id)`。** 零内核改动。

### 3.3 会话 header 的 tab 环（现状）

`ui-conversation` 的 `ConversationSessionHeader` 在**会话 header 内部**渲染 `conversation.view` 的 tab 环（chat / trajectory 等），这些 tab 是「会话内的视图」，**不是**「会话 tab」。这正说明「会话作为编辑器 tab」需要一个**外壳级**的 tab 栏，而非复用它。

### 3.4 会话行菜单（无 slot 扩展点）

`ui-workspace` 的 `rows/Rows.tsx` 中 `sessionMenuItems` 硬编码 `rename / fork / archive`，**没有「追加菜单项」的 slot**。→ 只能 fork 该组件。

## 4. 目标架构

```
corum-app-frame（我们 fork ui-layout 重写）
 ├─ activity-bar   ← 活动栏：Explorer(文件树/会话) / 编辑器 / 终端 / 待办 / 队列 切换
 ├─ primary-sidebar← Explorer：文件树 + 会话列表（复用官方 ui-workspace 或 fork 版）
 ├─ editor-group   ← 顶部「会话/文件 tab 栏」+ 主编辑区
 │     ├─ tab-strip     ← 会话 tab + 文件 tab（同一 tab 组或分两组）
 │     ├─ conversation  ← 复用官方 ui-conversation（slot 同名接管）
 │     └─ code-editor   ← 常驻 Monaco（从 conversation.view tab 迁出）
 ├─ secondary-panel← 右侧：详情/轨迹（复用官方 details slot）
 ├─ bottom-panel   ← 终端 / 待办 / 队列（底部面板）
 └─ status-bar     ← 连接状态 / 当前模型 / 当前项目 / 会话运行态
```

子 slot 契约重新声明（同名）：`sidebar` / `conversation` / `details` / `shell.overlay`（保留这四个，保证官方下游零改动挂载），**新增**：`corum.activity` / `corum.tabStrip` / `corum.editor` / `corum.panel` / `corum.statusBar`（我们自己的扩展点）。

## 5. 分层实施方案

> 每层独立可交付、独立可回滚。依赖自下而上。

### P0 · 会话列表 fork（`@corum/corum-workspace`）

**目标**：会话管理动词收拢进列表行菜单，删除后列表实时刷新。

- 复制官方 `ui-workspace` 的 client 源码到 `packages/plugins/session/corum-workspace/`。
- 改 `rows/Rows.tsx` 的 `sessionMenuItems`，追加：
  - `save`（保存日志）→ 调 `window.corumDesktop.saveSessionLog`
  - `delete`（删除会话）→ 调 `window.corumDesktop.deleteSession`
- `delete` 成功后 `ctx.sessions.refresh()` + `ctx.workspaces.refresh()`（因为 `deleteSession` 改了 workspace 成员 + projection cache + 物理文件）。若删的是当前会话，`ctx.sessions.clear()`。
- session-archive 插件移除 `conversation.session.header.utilities` 的「保存」「删除」两个按钮，**只保留** `settings.general.item` 的「导入」行。
- `cordis.patch.yml`：`- id: ui-workspace / disabled: true` + `insert @corum/corum-workspace`。

**依赖**：host 删除/导出/导入能力已全部现成（`CorumSessionArchive` + `window.corumDesktop` 桥 + 原生对话框）。

### P1 · 外壳 fork（`@corum/corum-layout`）

**目标**：把三列 AppFrame 重写为 IDE 五/六区。

- 复制官方 `ui-layout`，重写 `AppFrame` → `CorumAppFrame`（IDE 布局）。
- 重新声明 child slot（同名四个 + 新增 corum.* 扩展点）。
- 提供同形 `ctx.layout` 服务（`toggleSidebar/openDetails/closeDetails` + 新增 `togglePanel/toggleActivity` 等），保证官方 `ui-sidebar`/`ui-conversation` 的下游调用不破。
- 几何求解：参考官方 `columns.ts` 的让位链（sidebar 不让、details 先缩、center 兜底），扩展为「活动栏固定宽 + 主侧栏 + 编辑器 + 次侧栏 + 底部面板」的多区让位。
- **这一步决定全局观感，是最大的一刀，也是最该仔细设计的。**

### P2 · 项目面（文件树 + 多文件 tab）

**目标**：左侧 Explorer 出现真实文件树。

- 复用官方 `host.listDirectory` / `host.createDirectory` / `host.openPath`（`ctx.workspaces` 已暴露），无需新 host 能力。
- 文件 tab 与 Monaco 多文件模型（`MonacoEditor.tsx` 已具备单文件渲染，扩展为多文件 + dirty 态）。
- 文件打开→编辑器 tab、保存→host 写盘（需补一个 shell host 的文件读写桥，走现有 `window.corumDesktop` 模式）。

### P3 · 会话 tab 栏

**目标**：会话作为编辑器 tab，与文件 tab 统一心智。

- tab 栏 = 「打开过的会话集合」（UI 态，localStorage 持久化），active = `sessions.current`，切换 = `sessions.open(id)`。
- 关闭 tab = 移出集合（**不删除会话**，只是从 tab 栏关掉）；删掉会话时联动移出 tab 集合。
- 空白会话 / 子代理面包屑关系在 tab 上呈现（复用 `deriveAncestry` 的 lineage 思路）。

### P4 · 底部面板 + 状态栏 + 主题

**目标**：补齐 IDE 标志性区域。

- 底部面板：终端（复用 `dsh-terminal`）、待办、队列（`conversation.input.dock` 已有队列/待办条目）。
- 状态栏：连接状态（`connection-controller` 已有）、当前模型、当前项目、会话运行态。
- 主题：兑现 `@corum/ui-theme` 占位插件（当前是 `// TODO: implement`）。

## 6. 关键决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 会话 tab 模型 | 单一 active + tab 栏（UI 态） | 不碰 runtime；官方 `current` 已是单例，切换已实现 |
| 列表 fork 方式 | 复制官方组件增量改 | 官方行菜单无 slot 扩展点，只能 fork |
| 外壳 fork 方式 | fork `ui-layout`，重新声明同名 child slot | 下游官方插件零改动挂载 |
| 数据面 | 消费 `useSessions/useWorkspaces` | 直连 RPC 会丢 scope/selection/stream 增量 |
| 会话删除 | 沿用 shell host 的 `CorumSessionArchive` | 官方无 `session.delete` RPC，属桌面增量能力 |
| 文件读写 | 新增 shell host 文件桥（走 `window.corumDesktop`） | 桌面 IPC 不走 HTTP，沿用已验证的桥模式 |

## 7. 维护成本（诚实评估）

Fork 面会随层数扩大，需要长期 diff 同步的官方包：

- P0：`ui-workspace`（`WorkspaceBrowser.tsx` 1222 行 + `Rows.tsx` 475 行 + tree/stores/locales）
- P1：`ui-layout`（`AppFrame.tsx` 201 行 + columns/stores/service）
- P2/P3：编辑器/文件树/tab 栏是**纯新增**，无 fork 负担
- 不 fork：`ui-conversation`（会话 body 整体复用，靠 slot 接管）

**降低 diff 成本的纪律**：

1. fork 的文件只做「最小必要改动」，其余保持与官方逐行一致，diff 才干净。
2. 官方升级时用 `diff -ru` 对比官方目录与 fork 目录，只合并「官方新增/修复」，丢弃我们标记的定制块（定制块用 `// CORUM-PATCH: ...` 注释围住）。
3. 能走 slot 注入的（`conversation.view`、`conversation.session.header.utilities`、`shell.overlay`）绝不 fork。

## 8. 落地顺序与验收标准

| 层 | 验收标准 |
|---|---|
| P0 | 列表行菜单出现「保存日志/删除」；删除后列表实时消失；右上角不再有保存/删除按钮；导入行仍在设置 |
| P1 | IDE 五区渲染；官方会话/项目/详情在对应区正常；`toggleSidebar/openDetails` 不报错；拖拽让位正常 |
| P2 | 文件树可浏览/展开；双击文件在编辑器区打开；多文件 tab 切换；保存写盘 |
| P3 | 会话 tab 切换 = 切换 active；关闭 tab 不删会话；删除会话联动关 tab |
| P4 | 底部面板/状态栏可用；主题插件生效 |

## 9. 建议第一步

**先做 P0**（会话列表 fork + 行菜单收拢），它是独立、低风险、且能立刻验证「fork + overlay 接线」整条链路的一块。P1 外壳重写是全局观感关键，建议在 P0 验证了 fork 与构建链路后，单独开一轮详细设计（几何求解、活动栏、子 slot 契约）再动工。

## 10. Agent 设计哲学：Agent 与 MCP 绑定

> 核心原则：**一个 Agent 绑定一组专属 MCP，不同 Agent 用不同 MCP，专人干专事。**

视觉/交互设计不是「在当前会话里顺带做」，而是由一个**专职设计 Agent** 完成。为此 corum 建了一个 `designer` preset，它绑定 Pencil MCP，用成熟的设计软件（Pencil 桌面端）产出 `.pen` 设计稿，经用户逐阶段确认后再动工实现。

### 10.1 哲学在 DSH 的落点

DSH 的两平面模型与这条哲学精确对应：

| 哲学概念 | DSH 机制 |
|---|---|
| 一个 Agent = 一个人 | 一个 **preset**（`agent.cordis.yml`）= 一份 persona + 工具集 + skill |
| 一个 Agent 绑定一组专属 MCP | preset 里的一行 `mcp-client`（`serverName` + transport） |
| 专人干专事，互不串扰 | preset 挂载是 **per-session** 的，MCP 工具只对绑定该 preset 的会话可见 |
| 换人 = 换工具 | 换 preset = 换整组 persona + 工具 + MCP + skill |

`designer` 绑定 `pencil` MCP；将来要一个 `research` Agent 就再建一个 preset 绑 `exa`/`perplexity` MCP，要一个 `browser` Agent 就绑 `chrome-devtools` MCP——每个都是独立的 `agent.cordis.yml`，互不污染。

### 10.2 MCP 归属判定规则（放 preset 还是 host）

| 场景 | 归属 | 理由 |
|---|---|---|
| MCP 只被某类专职 Agent 使用 | **preset** | 隔离、随会话销毁、只对该 Agent 可见 |
| MCP 是所有 Agent 通用的底层能力 | **host** | 跨会话单例，避免每个会话各 spawn 一个子进程 |

判定口诀：**「某类 Agent 的专长」→ preset；「所有 Agent 的地基」→ host。** Pencil MCP 是前者，故放 preset。这条规则与 host 组合里 `subagents` registry（跨会话单例）为何留在 host 是同一个道理。

### 10.3 designer preset 现状（已实现并验证）

- **位置**：`.agent-presets/designer/`
  - `preset.yml` — 显示名「设计模式」
  - `agent.cordis.yml` — copy `standard` 裁剪（保留 bash/fs/skill/ask-user/todo/web，去掉 plan/goals/subagents/workflows/ralph），新增 `mcp-pencil` 行
  - `skills/pencil-mcp/` — 从 `~/skills/ai-skills/front/pencil-mcp` 完整拷贝（5 个子技能 + `template.pen` + 去背景脚本）
- **MCP 行**：
  ```yaml
  - id: mcp-pencil
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      transport: stdio
      serverName: pencil
      command: /Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64
      args: [--app, desktop]
      env: {}
      cwd: ''
      failOnStartupError: false
  ```
- **依赖**：`@deepseek-ai/dsh-mcp-client` 已加入 `packages/shell/package.json`（link），打包态 backfill 在 `scripts/pack-macos.mjs`（连同 `@modelcontextprotocol/sdk` 及其传递依赖）。
- **验证结果**（2026-08 已跑通）：`agentPreset.list` 发现 `designer`；`session.create` 指定 `agentPreset: designer` 挂载成功；日志 `[MCP] Starting server in stdio mode` 证明 Pencil MCP 子进程实际启动。

### 10.4 使用 designer preset

1. 重启桌面壳（让 `.agent-presets/designer` 被 picker 重新发现）。
2. 新建会话时选「设计模式」。
3. 让设计 Agent 执行 pencil-design 8 步 SOP：样图探索 → 风格确认 → 设计执行方案 → 素材页 → 页面 → 去背景 → 交付，每步等用户确认。

### 10.5 注意事项

- **MCP 服务器路径写死**：`command` 指向 `/Applications/Pen.app/.../mcp-server-darwin-arm64`，换机器/换安装位置需改 `agent.cordis.yml` 的 `mcp-pencil` 行。
- **`failOnStartupError: false`**：Pen.app 未运行时 preset 仍能挂载，MCP 工具只是连接报错，不会 boot 失败。
- **打包态 backfill 未完整验证**：`pack-macos.mjs` 的 MCP backfill 已做语法检查，完整 `pnpm pack`（需 `hdiutil` + `danger-full-access`）未跑；dev 态已全链路验证。
- **每个 Agent 一套 MCP**：新建专职 Agent 时，先按 10.2 判定 MCP 归属，再决定 `mcp-client` 行放 preset 还是 host。
