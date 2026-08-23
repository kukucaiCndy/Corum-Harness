# corum 设置中心（Settings）PRD

- 版本：v2.0（终态全景版）
- 日期：2026-08-23
- 适用仓库：/Users/kukucai/work/kkc-desktop（kkc-desktop / corum）
- 上游基座：官方 dsh 0.1.1-rc.2（参考源码 /Users/kukucai/dsh）
- 变更说明：v2.0 从「现状盘点 + 规范」升级为「终态全景规划」—— 不只定义已有能力，而是定义 corum 设置中心**应该有但还没有的、未来要做的**全部内容，并给出分期路线。

---

## 1. 背景与目标

### 1.1 背景

corum 是基于官方 DeepSeek Harness（dsh）fork 的桌面 Agent IDE（壳层 shell + 插件 plugins 架构）。官方 dsh 已内置一套完整的 Settings 体系（host 侧 `ctx.settings` 服务 + client 侧 `settings.*` slot 体系），corum 当前已启用官方设置基座并在 IDE 模式自建了 SettingsShell 壳。但目前的设置中心只是「官方有什么就用什么」，缺少：

1. **终态信息架构**：corum 作为完整 Agent IDE，设置中心应该覆盖哪些领域（IDE 级、Agent 行为级、数据级、扩展级），业界标杆都有什么，corum 缺什么。
2. **插件设置页贡献规范**：插件如何自助挂载设置 UI，目前无规范。
3. **schema 驱动自动表单**：插件只注册 schema 就自动生成设置页（类 VS Code `contributes.configuration`），官方 dsh 没有，是 corum 的差异化能力。
4. **扩展面板终态**：插件管理 + 插件市场一体的设置内面板。
5. **项目级设置覆盖**：全局 / 项目两级覆盖（类 Claude Code scope）。
6. **配置迁移与 Profile**：导入导出、多 Profile 切换。

### 1.2 用户硬性要求

1. 提供基本的 Agent 设置 + 扩展面板。
2. 支持**自动载入插件的设置页面**（插件自助注册，schema 驱动自动生成）。
3. 定义好「插件设置页面」的贡献点规范。
4. 设置页在所有主题配色（light / dark / system + corum token 覆盖层）下正确展示。

### 1.3 业界对标摘要

| 产品 | 设置范式 | corum 可借鉴点 |
|---|---|---|
| Claude Code | 多 scope 分层（Managed > CLI > Local > Project > User）；分类：模型 / 权限（allow-deny 规则）/ 沙箱 / MCP / hooks / 环境变量 / 主题 / 通知 / 编辑器模式 | 权限与沙箱独立分区；**项目级覆盖**（`.claude/settings.json` 随仓库走）；hooks 自动化配置 |
| Cursor | General（账户 / Rules 通用提示词 / 隐私）、Models（勾选 + API key）、Features（Tab / Chat / Composer / 索引）、快捷键 | 「基本设置 + 能力面板」二分；Rules（全局自定义指令）独立成项 |
| OpenAI Codex app | General / Profile（用量）/ Appearance（主题 / accent / 字体）/ Agent configuration（approval、sandbox、config.toml 高级编辑）/ Integrations & MCP / Personalization（personality、custom instructions）/ Memories / Git / 快捷键 / 通知 / 归档 | Agent 行为配置独立成区；Appearance 单独成项；**config.toml 高级编辑**（设置页兜底「打开配置文件」）；Memories / Personalization |
| VS Code | `contributes.configuration` 声明式 JSON schema 贡献点，扩展设置**自动生成**统一设置 UI；UX 准则：每设置带默认值 + 清晰描述、不自建设置页 | **schema 驱动自动表单**（corum 核心差异化）；设置搜索；`@modified` 过滤器 |
| JetBrains IDE | Settings 对话框：Appearance & Behavior / Keymap / Editor / Plugins（市场 + 已装）/ Tools；支持 scheme 导出导入 | Plugins 页「市场 + 已装 + 每插件设置」一体；Keymap 独立分区 |

**结论**：业界共识 = 统一设置壳 + 分区导航 + 声明式贡献点 + 设置搜索 + 插件市场一体面板。官方 dsh 的 slot 体系满足「统一壳 + 声明式贡献」，corum 需要补齐「自动表单、搜索、市场面板、项目级覆盖、Profile」。

### 1.4 目标（终态）

- **G1**：确立 corum 设置中心的**终态信息架构**（第 4 章）：5 大分区 18 个 section，覆盖 IDE 级 / Agent 行为 / 数据与隐私 / 扩展 / 插件贡献。
- **G2**：发布《插件设置页贡献规范》（第 5 章），使任何 corum 插件通过「host 注册 namespace + schema」即可**自动生成设置页**；复杂页面可选自绘组件注册 slot。
- **G3**：确立主题适配硬性规范（第 6 章），保证 light / dark / system + corum glass token 覆盖层下零适配成本。
- **G4**：扩展面板终态 = 设置中心 Plugins section 升级为「已装管理 + 市场浏览 + 每插件设置聚合」一体面板（第 4.3 节）。
- **G5**：不偏离官方架构：所有机制以官方 `ctx.settings` / `ctx.settingsScope` / `ctx.settingsSchema` / `settings.*` slot 为基座，corum 只叠加差异化（自动表单层、市场面板、项目级覆盖、Profile）。

### 1.5 全局性：发行版级通用设置，跨 combo 共享（关键定位）

**corum 设置中心是桌面发行版级的通用能力，不属于任何一个 combo / 工作台。**

corum 桌面支持多 combo（minimal / ide / dev-agent / 未来任何基于 corum 开发的工作台）。设置中心的定位是**所有 combo 共享的同一套设置**：

1. **一份数据**：所有 combo 读写同一份 `~/.corum-shell/settings.yaml`（同一 `ctx.settings` seam），用户在任何工作台修改的通用设置（主题、语言、模型、权限等）在其他工作台立即生效。
2. **一套壳契约**：无论当前挂载哪个 combo 的工作台壳（官方 SettingsRoot / ide-shell SettingsShell / 未来新壳），`settings.*` slot 契约完全一致，设置中心的信息架构（第 4 章分区 A~E）在所有工作台中原样呈现。
3. **一套规范**：第 5 章贡献规范、第 6 章主题规范对所有 combo 下的插件一视同仁。

**工作台自身设置的嵌入方式**：工作台（combo）特有的设置**不进入全局内置分区**，而是以插件形式按第 5 章规范贡献，落在**插件贡献区（分区 F，order 100+）**或扩展面板「插件设置」tab。例如：

- ide-shell 规划的项目管理相关设置 → 由 ide-shell（或其拆出的独立插件）注册 `ide-projects` 之类 namespace + section，出现在插件贡献区；切换到其他 combo 时该 section 随插件卸载自动摘除。
- dev-agent 工作台的 AgentProfile 调试设置 → 同理，由 dev-agent 插件贡献。

即：**全局设置（分区 A~E）= 发行版内置、所有工作台共享；工作台设置（分区 F）= 插件贡献、随 combo 启停**。这条边界是设置信息架构的第一原则。

---

## 2. 现状盘点

### 2.1 官方 dsh Settings 体系（基座能力）

**Host 侧**

- `@deepseek-ai/dsh-settings`（`/Users/kukucai/dsh/packages/settings/settings/`）：Cordis seam，提供 `ctx.settings` 服务。
  - `ctx.settings.register(ns, schema, { base, applies: 'live' | 'restart', validate })`：注册 namespace，schema 为 schemastery schema。
  - namespace 命名强制校验：小写 kebab-case，`/^[a-z][a-z0-9-]*$/`（`settingsNamespace()`，`src/index.ts:19-31`）。**注意：不是 camelCase。**
  - 三层解析：schema 默认值 → 组合 base → 用户分节。
  - 写 API：`update` / `replace` / `mutate`（路径级 set/unset + revision 乐观并发，冲突错误码 `settings-conflict`）。
  - secret 脱敏：schema meta `role('secret')`（明文密钥，describe 脱敏）与 `role('credential-ref')`（环境变量名引用，主流做法）。
  - 助手：`installSettingsSection(ctx, ns, schema, entry, { validate?, setSource, onChange })`。
  - 事件：`settings/updated`、`settings/document-updated`。
- `@deepseek-ai/dsh-settings-file`：FileSettingsProvider，存储 `$DSH_HOME/settings.yaml`（corum 桌面 home 为 `~/.corum-shell`），chokidar 热重载、跨进程写锁、注释保留的 YAML leaf diff 写入。
- apiproxy 暴露五个 RPC：`settings.describe` / `openDocument` / `update` / `replace` / `mutate`（describe 强制 `redactSecrets`）。

**Client 侧**

- `@deepseek-ai/dsh-client-ui-settings`：提供两个 Cordis 服务 + 全部 slot 类型声明（`contract/slots.ts`）：
  - `ctx.settingsScope`（SettingsScopeBinder）：`bind({ namespace })` → `getSnapshot / subscribe / set / unset`；快照含 `status / value / base / user / revision / writable`。
  - `ctx.settingsSchema`：rehydrate / validate / 路径编辑（getPath / setPath / deletePath / nodeAtPath）。
- `@deepseek-ai/dsh-client-ui-settings-general`：设置壳 SettingsRoot，占 `sidebar.settings` 槽，声明子槽：`settings.trigger / header / action / close / section / onboarding`。壳零文案，左导航 rail 从 `settings.section` slot ledger 投影 `{id, order, label}` 排序，右侧 `renderSlot('settings.section', {close}, {only: active})`。

**官方已注册的 settings namespace 及 schema 实例**（均为源码原文，供 corum 参照）：

| namespace | schema 关键字段 | 来源 |
|---|---|---|
| `locale` | `preference?: 'zh' \| 'en'`（缺省回落浏览器语言） | `packages/client/locale/src/locale-settings.ts` |
| `ui-theme` | `preference: 'light' \| 'dark' \| 'system'`（default `system`） | `packages/client/ui-theme/src/theme-settings.ts` |
| `ui-conversation` | `busyEnter: 'queue' \| 'steer'`（default `queue`，composer 在 agent busy 时按 Enter 行为） | `packages/client/ui-conversation/src/submission-settings.ts` |
| `ui-onboarding` | `welcomeNoticeVersion?: string` | `packages/client/ui-settings-general/src/index.ts:8-27` |
| `agent-loop` | `maxParallelToolCalls: number`（min 1，step 1） | `packages/core/agent-loop/src/index.ts:236-252` |
| `permission` | `defaultPreset: union(presetChoices)`（动态生成，choice 带 `.description(label)`）；preset 表 = `{ sandbox: 'read-only'\|'workspace-write'\|'danger-full-access', approval: 'ask'\|'never', name, description }` | `packages/interaction/permission-presets/src/index.ts:54-234` |
| `llm-deepseek` | `apiKeyEnv: string.role('credential-ref')`、`baseURL`、`thinking`、`reasoningEffort`、`maxTokens`、`defaultContextWindow`、`models: catalogModel[]`、`retryPolicy` 等 | `packages/llm/llm-deepseek/src/index.ts:147-179` |
| `llm-pi-ai` | `providers: dict(profile)`，profile = `{ apiKeyEnv: role('credential-ref'), displayName, api: 协议union, baseURL, models[], modelOverrides, compat, headers, reasoning, transport, retryPolicy, ... }` | `packages/llm/llm-pi-ai/src/config.ts:222-335` |
| `shell` | `cwd`、`timeoutMs`(120s)、`maxTimeoutMs`(600s)、`maxOutputBytes`(64k)、`maxSpillBytes`、`graceMs` | `packages/shell/bash-local/src/index.ts:105-136` |
| `web-search-deepseek` | `apiKey: string.role('secret')`、`apiKeyEnv: role('credential-ref')`、`baseURL`、`model`、`apiVersion`、`maxTokens`、`maxUses` | `packages/web/web-search-deepseek/src/index.ts:63-85` |
| `agent-default-model` | `provider`、`model`、`reasoningEffort?` | `packages/core/agent-default-model/src/index.ts:34-104` |
| `agent-presets` | `default?: string`（刻意不用 installSettingsSection，直接 register 拿 SettingsScope） | `packages/preset/agent-presets/src/index.ts:40-152` |

**官方设置页及 order**：general(0) / models(10) / plugins(15) / agent-presets(20)；general 页内 `settings.general.item` 行 order：agent-preset(-25) / permission(-20) / language(0) / appearance(10) / composer-enter(20)。

### 2.2 corum 已有能力

| 能力 | 位置 | 状态 |
|---|---|---|
| 设置基座 | `@deepseek-ai/dsh-client-ui-settings` | 启用 |
| 设置壳（minimal 模式） | 官方 `ui-settings-general` | 启用 |
| 设置壳（IDE 模式） | [SettingsShell.tsx](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/ide-shell/src/client/SettingsShell.tsx)，createPortal 到 document.body，占 `sidebar.settings` 并补注册全部 `settings.*` 子槽；入口在 AppFrame.tsx 侧栏底部齿轮 | 启用，官方壳被 `cordis.ide.patch.yml` 禁用 |
| General section（IDE） | [SettingsGeneralSection.tsx](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/ide-shell/src/client/SettingsGeneralSection.tsx)（渲染 `settings.general.item` 槽） | 启用 |
| Models 设置页 | `@corum/ui-settings-models`（fork 官方，差异 = pi-ai 模型「支持图片」开关） | 启用，官方版禁用 |
| 插件管理（设置视角） | 官方 `ui-settings-plugins` + `ui-settings-plugin-inventory` | 启用 |
| 插件中心（桌面视角） | corum `plugin-manager.ts` + PluginManagerPanel.tsx（FloatingLayer 独立面板） | 启用，与设置页无耦合 |
| General 行贡献范例 | `@corum/session-archive` 向 `settings.general.item` 贡献「导入会话日志」行 | 启用 |
| 主题体系 | 官方 `dsh-client-ui-theme`（`ctx.theme`）+ corum `theme-layer.ts` GLASS_TOKENS → `--dsw-alias-*` CSS 变量 + shell-base ThemePresenter（写 body 内联变量，dark 设 `data-ds-dark-theme`） | 启用 |
| 基础能力白名单 | `CORE_PLUGIN_PACKAGES`（当前 `@corum/ui-model-selection`）不可停用 | 启用 |

### 2.3 差距分析（现状 → 终态）

| # | 差距 | 终态要求 | 影响 |
|---|---|---|---|
| D1 | 无终态信息架构：IDE 级（外观 / 通知 / 快捷键 / 数据管理 / 高级）、Agent 行为级（Rules / 记忆 / Hooks / 终端）、数据级（隐私 / 账户用量）section 全部缺失 | 第 4 章 18 个 section 全景 | 设置中心只是「官方给什么用什么」，不是完整 IDE |
| D2 | 无《插件设置页贡献规范》 | 第 5 章 | 插件各自为政 |
| D3 | 无 schema 驱动自动表单：官方要求插件自绘 React 组件，门槛高 | 第 5.4 节：插件只注册 schema 即自动生成设置页 | 插件接入成本高、视觉不一致 |
| D4 | 扩展面板割裂：官方 ui-settings-plugins（设置视角）与 corum PluginManagerPanel（管理视角）两个入口；无市场 | 第 4.3 节：Plugins section 升级为「已装 + 市场 + 每插件设置」一体面板 | 用户不知道去哪管插件 |
| D5 | 无项目级设置覆盖：官方只有全局 settings.yaml 一层用户配置 | 第 7 章：全局 / 项目两级覆盖 | 团队共享配置、项目特异配置无法表达 |
| D6 | 无配置迁移与 Profile：无法导出导入、无法多配置切换 | 第 8 章 | 换机器 / 多场景配置困难 |
| D7 | 无设置搜索：官方壳无搜索 | 第 4.4 节 | 设置项增多后找不到 |
| D8 | 无统一 order 分配规范 | 第 4.2 节 | 导航顺序失控 |
| D9 | 无主题适配硬性规范与验证矩阵 | 第 6 章 | 主题下显示异常 |
| D10 | minimal / IDE 双模式壳实现不同，需规范保证插件贡献两模式一致生效 | 第 5.6 节 | 插件单模式测试即以为全量可用 |

---

## 3. 产品定位与原则

### 3.1 定位

corum 设置中心是**发行版级、跨 combo 共享的桌面统一配置入口**（全局性定位详见 1.5）：

- **对上**：用户管理 IDE 行为（外观、通知、快捷键、数据）与 Agent 行为（模型、权限、预设、Rules、记忆、终端）的唯一入口，且在**任何工作台（combo）下是同一套**。
- **对下**：所有 corum 插件**声明式**挂载配置 UI 的开放平台 —— 插件注册 schema 即自动生成设置页，复杂场景可自绘组件；**工作台特有设置也以插件身份嵌入扩展区**。
- **对生态**：扩展面板（Plugins）是插件的安装、管理、配置一体化入口。

### 3.2 原则（硬性）

0. **全局性优先**：设置中心属于 corum 发行版，不属于任何 combo。内置分区（A~E）的设置所有工作台共享同一份数据与 UI；combo 特有设置一律以插件形式贡献到扩展区（分区 F），不得污染内置分区，不得为某 combo 定制全局设置行为。
1. **跟随官方 slot 体系**：一切设置数据走 `ctx.settings` / `ctx.settingsScope`，一切设置 UI 走 `settings.*` slot。**禁止**绕开 `ctx.settingsSchema` / `ctx.settingsScope` 自建实现。
2. **发行版只叠加差异化**：corum 的差异化 = 自动表单层、扩展面板市场、项目级覆盖、Profile、IDE 级 section。这些官方没有，是 corum 增量；官方已有的（settings seam、slot 壳、models 页、plugins 页）跟随官方，fork 包以官方最新源码为基线，`diff -rq` 只剩差异化文件。
3. **schema 即契约**：每个设置 namespace 必须有 schemastery schema，带默认值、描述、secret 标注、applies 标注。schema 是校验、脱敏、分层标注、**自动表单生成**的唯一事实来源。
4. **壳零文案、内容可组合**：SettingsShell 不内置任何具体设置项，一切内容来自 slot ledger 投影或 schema 反射。
5. **主题零硬编码**：设置 UI 只消费 `--dsw-alias-*` CSS 变量。
6. **双模式一致**：插件贡献必须同时在 minimal 与 IDE 模式生效，插件不得感知模式差异。

---

## 4. 终态信息架构

**分区 A~E 为发行版内置、跨 combo 共享的全局设置；分区 F 为插件贡献区，工作台（combo）特有设置也落在这里（见 1.5）。**

### 4.1 五分区 18 section 全景

设置中心左侧导航 rail 由 `settings.section` slot ledger 投影 `{id, order, label}` 排序生成。终态分为五个分区（分区是视觉分组，靠 order 区间自然分隔）：

#### 分区 A：通用（General）— order 0 ~ 9

| Section | order | 来源 | 内容 | 状态 |
|---|---|---|---|---|
| General（通用） | 0 | 官方（minimal）/ ide-shell（IDE） | 组合页，聚合 `settings.general.item` 行：language(0)、appearance(10)、composer-enter(20)、及插件贡献行 | 已有 |
| Appearance（外观） | 2 | corum 新建（P1） | 主题 preference（light/dark/system）从 General 行升格为整页：主题选择、accent 色、UI 字体 / 代码字体、字号、界面密度（紧凑/舒适） | **未做** |
| Notifications（通知） | 4 | corum 新建（P1） | Agent 任务完成通知开关、声音、系统通知权限引导、勿扰时段 | **未做** |
| Keyboard Shortcuts（快捷键） | 6 | corum 新建（P2） | 快捷键清单查看、自定义绑定、重置默认；搜索框 | **未做** |

#### 分区 B：Agent — order 10 ~ 49

| Section | order | 来源 | 内容 | 状态 |
|---|---|---|---|---|
| Models（模型） | 10 | `@corum/ui-settings-models`（fork） | LLM provider 目录、API key（credential-ref）、模型启用/禁用、context window / maxTokens、pi-ai「支持图片」开关（corum 差异） | 已有 |
| Agent Presets（Agent 预设） | 20 | 官方 section + corum `dev-agent` 增强 | Agent 预设管理：profile / prompt / model / skills / mcpServers / terminal / memoryPolicy / trust；新建 / 复制 / 删除 / 设为默认 / 打开目录 | 已有（需与 dev-agent 的 AgentProfile 打通，P1） |
| Permissions（权限） | 30 | corum 新建（P1） | 从 General 的 permission 行(-20)升格整页：默认 preset（read-only / workspace-write / danger-full-access × ask / never）、allow/deny 工具规则编辑、沙箱策略、会话内临时授权说明 | **未做** |
| Rules & Instructions（规则与指令） | 32 | corum 新建（P1） | 全局自定义指令（类 Cursor Rules / Codex custom instructions）：全局 system prompt 追加、AGENTS.md 编辑入口、personality 预设（友好 / 务实 / 无） | **未做** |
| Memory（记忆） | 34 | corum 新建（P1） | 记忆开关、记忆存储查看 / 编辑 / 清除、每会话记忆隔离策略、记忆容量上限 | **未做** |
| Terminal（终端） | 36 | corum 新建（P1） | 终端执行器配置（`shell` namespace 的可视化）：cwd、timeoutMs / maxTimeoutMs、maxOutputBytes、默认 shell 选择（bash / pwsh）、终端字体 | **未做**（schema 已在官方 `shell` namespace，只差 UI） |
| Hooks & Automation（钩子与自动化） | 38 | corum 新建（P2） | 事件钩子配置（类 Claude Code hooks）：PreToolUse / PostToolUse / Notification / Stop 等事件绑定 shell 命令或 prompt | **未做** |
| Agent Loop（高级运行参数） | 39 | corum 新建（P2） | `agent-loop` namespace 可视化：maxParallelToolCalls；重试策略摘要 | **未做**（schema 已在官方，只差 UI） |

#### 分区 C：数据与隐私 — order 50 ~ 69

| Section | order | 来源 | 内容 | 状态 |
|---|---|---|---|---|
| Account & Usage（账户与用量） | 50 | corum 新建（P2） | 账户信息（如有登录态）、token 用量统计、配额；无账户体系时展示本地用量统计 | **未做** |
| Privacy（隐私） | 52 | corum 新建（P1） | 遥测 / 崩溃上报开关、会话日志本地保留策略、敏感文件排除规则（agent 不可读的路径 glob） | **未做** |
| Data Management（数据管理） | 54 | corum 新建（P1） | 存储占用查看（sessions / skills / 缓存）、会话归档与清理（承接 session-archive）、缓存清除、全部数据重置 | **未做** |

#### 分区 D：扩展 — order 70 ~ 99

| Section | order | 来源 | 内容 | 状态 |
|---|---|---|---|---|
| Plugins（扩展面板） | 15 → **70** | corum 升级（P1） | **终态 = 已装管理 + 市场 + 每插件设置一体面板**，见 4.3 | 部分已有（官方页），需升级 |
| MCP & Integrations | 40 → **72** | corum 新建（P1） | MCP server 清单、启停、环境变量、连接状态、添加自定义 server（stdio / sse / websocket）；承接 dev-mcp-manager | **未做** |
| Skills（技能） | 74 | corum 新建（P1） | 全局 skill 清单（`~/.dsh/skills/`）、导入 / 删除 / 版本、与 Agent 的绑定关系查看；承接 dev-skill-manager | **未做** |

#### 分区 E：高级 — order 90 ~ 99

| Section | order | 来源 | 内容 | 状态 |
|---|---|---|---|---|
| Advanced（高级） | 90 | corum 新建（P2） | 「打开 settings.yaml」入口（官方已有 `settings.action`）、config 高级编辑说明、诊断信息（版本 / 路径 / 已装插件清单复制）、日志目录打开、开发者模式开关 | **未做** |
| Profiles（配置档案） | 92 | corum 新建（P2） | 多 Profile 切换与导入导出，见第 8 章 | **未做** |

#### 分区 F：插件贡献区 — order 100+

第三方 / 可选插件、以及**工作台（combo）特有设置**（如 ide-shell 的项目管理设置）自助注册的整页 section（schema 自动生成或自绘），从 order 100 起分配（见 4.2）。工作台切换导致插件启停时，对应 section 随之出现 / 消失，不影响分区 A~E 的全局设置。

**说明**：

- onboarding 引导步骤走 `settings.onboarding` 槽，不占导航 rail。
- 上表 order 是**终态目标值**，M1 落地时官方已有 section（general 0 / models 10 / agent-presets 20）保持不动；官方 plugins 15 在 corum 升级扩展面板时迁移到 70（见 4.3）。
- 「未做」section 的 schema 归属：优先复用官方已注册的 namespace（如 Terminal 用 `shell`、Agent Loop 用 `agent-loop`、Permissions 用 `permission`），corum 只做 UI；官方没有对应 namespace 的（Notifications / Privacy / Data Management 等）由 corum 新建插件注册。

### 4.2 order 分配规范（硬性）

| 区间 | 归属 | 说明 |
|---|---|---|
| 0 ~ 9 | 通用分区 | 0 为官方 general；corum 的 Appearance/Notifications/Shortcuts 用 2/4/6 |
| 10 ~ 49 | Agent 分区 | 10/20 为官方 models/agent-presets；corum 内置用 30/32/34/36/38/39 |
| 50 ~ 69 | 数据与隐私分区 | corum 内置 50/52/54 |
| 70 ~ 99 | 扩展 + 高级分区 | corum 内置 70/72/74/90/92 |
| 100 ~ 999 | corum 官方插件贡献的整页 section | 每个插件一个整十数段；同插件多 section 用 +1 步进 |
| 1000+ | 第三方插件 | 不做全局协调，冲突时按 slot ledger 稳定排序兜底 |
| `settings.general.item` 行内 order | — | 官方占用 -25/-20/0/10/20；插件贡献行使用 100 起 |

规则：

1. 新增内置 section 时必须检查 `/Users/kukucai/dsh` 官方包的最新 order 占用，保持 `diff` 可预期。
2. order 在 slot 注册的 meta 中声明（`ctx.slots.register({ name: 'settings.section', order, label, ... }, Component)`）。
3. 导航 rail 的视觉分隔线按上表分区边界渲染（壳负责，按 order 区间自动分组）。

### 4.3 扩展面板终态（Plugins section 升级）

**定位**：设置中心内的「插件管理 + 市场 + 每插件设置」一体面板，替代当前割裂的「官方 ui-settings-plugins（设置视角）+ corum PluginManagerPanel（管理视角，独立浮层）」两个入口。

**终态结构**（一个 section，三个 tab）：

| Tab | order | 内容 | 数据来源 |
|---|---|---|---|
| 已装插件 | 0 | 插件卡片列表：名称 / 版本 / 启用开关 / 卸载 / 更新按钮 / 「设置」入口（跳转该插件的设置 section 或展开内联配置）；CORE_PLUGIN 白名单标注「基础能力」不可停用 | corum `plugin-manager.ts`（list / setEnabled / uninstall / update） |
| 插件市场 | 10 | 可安装插件浏览：分类、搜索、安装按钮、版本与说明；源 = corum 插件 registry（M1 先用本地内置列表 + npm workspace 包，M4 接远程 registry） | plugin-manager `search` / `install` |
| 插件设置 | 20 | 聚合所有已装插件的配置入口：每个声明了 settings namespace 的插件一张卡片（schema 自动生成表单或自绘组件），等价于官方 configurable tab 的增强版 | `settings.describe` 枚举 namespace ∩ 插件清单 |

**与现有能力的关系**：

- 官方 `ui-settings-plugins`（configurable tab + inventory tab）被 corum fork 替代：`cordis.patch.yml` 禁用官方行，插入 `@corum/ui-settings-plugins`（fork），fork 差异 = 增加「已装管理 + 市场」两个 tab。
- 桌面级 PluginManagerPanel（FloatingLayer 独立面板）保留为**快捷入口**（侧栏图标直达），但其「管理」职能与扩展面板共享同一 `pluginManager` RPC；设置中心扩展面板是完整入口，PluginManagerPanel 是轻量入口，两者互补。
- 扩展面板内「插件设置」tab 的卡片表单由第 5.4 节的自动表单引擎生成。

### 4.4 设置搜索（P2）

- 位置：设置面板顶部搜索框（壳负责，IDE 壳先行，minimal 官方壳若不支持则 corum fork 时叠加）。
- 数据源：`settings.describe` 返回的全部 namespace + schema（字段 description）+ slot ledger 的 section label。
- 行为：输入关键字 → 过滤 section 列表；命中字段级时跳转 section 并高亮该字段行；支持 `@modified` 过滤器（只显示用户已覆盖的设置，值来源 = `snap.user` 存在性）。
- 无结果时空态提示。

---

## 5. 插件设置页贡献规范（核心章节）

插件贡献设置 UI = **数据层（host 半注册 namespace + schema）+ UI 层（二选一：schema 自动生成 / 自绘组件注册 slot）**。

### 5.1 数据层规范（host 半）

**1. 注册方式**

在插件 host 入口 `src/index.ts` 的 `apply(ctx)` 中：

```ts
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Schema } from 'schemastery'

const MY_PLUGIN_NAMESPACE = settingsNamespace('my-plugin')

const schema = Schema.object({
  endpoint: Schema.string().default('https://api.example.com').description('服务地址'),
  apiKey: Schema.string().role('secret').description('API 密钥'),        // 明文密钥
  apiKeyEnv: Schema.string().role('credential-ref').default('MY_PLUGIN_API_KEY').description('API 密钥环境变量名'),
  retries: Schema.natural().default(3).description('失败重试次数'),
})

export const name = 'my-plugin'
export const inject = ['settings']

export function apply(ctx: Context): void {
  let source: () => MyPluginSettings = () => entry
  installSettingsSection(ctx, MY_PLUGIN_NAMESPACE, schema, entry, {
    validate: (value) => { /* 跨字段校验，throw 即拒绝写入 */ },
    setSource: (current) => { source = current },
    onChange: () => {},
  })
}
```

**2. namespace 命名规则（硬性）**

- **小写 kebab-case**，正则 `/^[a-z][a-z0-9-]*$/`（官方 `settingsNamespace()` 强制校验，大写会抛 `TypeError`）。
- 与插件 `package.json` 的 `name` 语义对应：`@corum/dev-skill-manager` → `dev-skill-manager`。
- 禁止与官方 namespace 重名（官方清单见 2.1 表）；注册前对照 `/Users/kukucai/dsh` 最新源码。
- 一个插件一个根 namespace，不得注册多个平铺 namespace。

**3. schema 编写要求（硬性，同时是自动表单的数据源）**

| 要求 | 说明 | 自动表单影响 |
|---|---|---|
| 默认值 | 每个 leaf 字段必须有 `.default(...)` | 表单初始值与「重置」按钮目标值 |
| 描述 | 每个字段必须有 `.description(...)`，中文为主、一句话说明「改了会怎样」 | 表单字段的 label 下辅助文案 + 搜索索引 |
| secret 标注 | 密钥字段必须 `.role('secret')`（明文）或 `.role('credential-ref')`（环境变量名，推荐） | 自动生成密码输入框（掩码 + 显隐切换） |
| applies 标注 | 注册时显式给出 `applies: 'live' \| 'restart'` | restart 项表单旁自动标注「重启后生效」 |
| 类型选择 | boolean → 开关；union of const → 下拉 / 单选；number（min/max/step）→ 数字输入；string → 文本框；array/dict → 列表编辑器 | 自动表单控件映射见 5.4 |
| 嵌套 | 嵌套 object 用于分组展示；**不超过两层** | 每层 object 渲染为一个分组卡片 |
| 动态 union | choice 需显示名时用 `.description(label)` 标注（官方 permission-presets 模式） | 下拉选项文案 |

**4. 持久化**：由 `@deepseek-ai/dsh-settings-file` 统一写入 `~/.corum-shell/settings.yaml`，插件不得自行读写该文件。

**5. 宿主侧消费模式**（供功能代码读最新值）：

- 模式一（推荐，官方主流）：`installSettingsSection` + `setSource` 持有 `() => T` thunk，每次决策时读 `source()`（agent-loop / shell / web-search 均为此模式）。
- 模式二（轻量 UI namespace）：`ctx.settings.register(ns, schema)` 拿 `SettingsScope<T>`，`get()` 读快照，`update / replace / mutate` 写（locale / ui-theme / agent-presets 为此模式）。

### 5.2 UI 层形态 A：schema 自动生成设置页（默认，推荐）

**这是 corum 的核心差异化能力**，官方 dsh 没有。插件完成 5.1 的数据层注册后，**无需写任何 React 组件**，设置中心自动为其生成设置页。

**触发条件（满足其一即自动生成）**：

1. 插件在 `package.json` 声明 `corum.settings.section` 贡献点（见 5.5），或
2. 插件在 client 半一行注册：把一个「schema 反射占位组件」注册到 `settings.section` 槽，并声明 `settingsNs` meta：

```tsx
// src/client/index.tsx（完整代码，无需自绘页面）
import { AutoSettingsSection } from '@corum/shell-base/client'

export const inject = ['slots', 'settingsScope', 'settingsSchema']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const dispose = ctx.slots.register({
      name: 'settings.section',
      children: {},
      inject: () => ({}),
      order: 100,
      label: 'settings.myPlugin.navLabel',   // locale key
      settingsNs: 'my-plugin',               // 关键 meta：自动表单引擎反射此 namespace
    }, AutoSettingsSection)                  // 通用自动表单组件
    return () => { dispose() }
  }, 'my-plugin: settings section')
}
```

`AutoSettingsSection`（corum 新建，`@corum/shell-base/client` 导出）的工作机制：

1. 从 slot meta 读 `settingsNs`。
2. `ctx.settingsScope.bind({ namespace: settingsNs })` 拿快照；`ctx.settingsScope.describe()` 拿该 namespace 的序列化 schema，`ctx.settingsSchema.rehydrate()` 还原为活 schema。
3. 按 5.4 的控件映射表把 schema 反射为表单：字段分组（嵌套 object）→ 卡片，leaf 字段 → 控件行（label = 字段名本地化 / description = `.description()`）。
4. 写统一走 `scope.set(path, value)` / `scope.unset(path)`，冲突处理、只读态、secret 掩码、「已修改」徽标、「重启后生效」标注全部由引擎内置。
5. 主题：引擎所有控件只消费 `--dsw-alias-*` 变量（第 6 章），插件零适配。

**插件何时选自绘（形态 B）**：schema 无法表达的复杂交互（模型目录编辑、预设列表管理、拖拽排序、级联选择）才自绘组件。原则：**能 schema 表达的一律自动生成**。

### 5.3 UI 层形态 B：自绘组件注册 slot（复杂场景）

三种 slot 贡献形态：

**B1：整页 section（`settings.section` 槽）** — 设置项超过 5 个或需独立导航，且交互复杂。

```tsx
ctx.effect(() => {
  const dispose = ctx.slots.register({
    name: 'settings.section',
    children: {},
    inject: () => ({}),
    order: 100,
    label: 'settings.myPlugin.navLabel',
  }, MySettingsPage)   // 自绘组件
  return () => { dispose() }
}, 'my-plugin: settings section')
```

**B2：General 页一行（`settings.general.item` 槽）** — 单一开关 / 单项配置（参考 `@corum/session-archive` 的「导入会话日志」行）。

```tsx
ctx.effect(() => {
  const dispose = ctx.slots.register({
    name: 'settings.general.item',
    children: {},
    inject: () => ({}),
    order: 100,
  }, MySettingRow)
  return () => { dispose() }
}, 'my-plugin: general item')
```

**B3：插件卡片（扩展面板「插件设置」tab）** — 配置属于「插件管理」语境；插件提供配置面板组件，由扩展面板的卡片承载。

**自绘组件的标准读写模式（硬性）**：

```tsx
function MySettingsPage() {
  const ctx = useClientContext()
  const scope = useMemo(() => ctx.settingsScope.bind({ namespace: 'my-plugin' }), [ctx])
  const [snap, setSnap] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(setSnap), [scope])

  const write = async (path: string, value: unknown) => {
    try {
      await scope.set(path, value)
    } catch (err) {
      // revision 乐观并发冲突：settings-conflict
      setSnap(scope.getSnapshot())
      toast('设置已在别处修改，请重试')
    }
  }
  // snap.writable === false 时所有控件必须禁用
  // snap.user 存在性 = 「已修改」徽标
}
```

| 项 | 规则 |
|---|---|
| 写入路径 | 只走 `ctx.settingsScope.bind(...)` 的 `set` / `unset`；禁止直接 fetch `/api/settings/*` |
| 冲突处理 | 捕获 `settings-conflict`，刷新快照并提示用户，禁止静默覆盖 |
| 只读态 | `snapshot.writable === false` 时禁用全部输入控件 |
| 分层展示 | 值来源（schema 默认 / base / user）经 `snap.base` / `snap.user` 区分，行内标注「已修改」 |
| 控件 | 优先复用 `@corum/shell-base` 的控件库（M4 沉淀）；secret 字段默认掩码 + 显隐切换 |
| label / locale | 导航 label 与全部文案走 `ctx.locale` locale key；插件 `locales.ts` 同时提供 zh / en；禁止硬编码可见文案 |

### 5.4 自动表单控件映射规范（schema → UI）

自动表单引擎（`AutoSettingsSection`）的 schema 节点 → 控件映射表：

| schema 节点形态 | 控件 | 备注 |
|---|---|---|
| `Schema.boolean()` | Switch 开关 | — |
| `Schema.union([...const])` | Segmented（≤3 项）/ Select 下拉（>3 项） | choice 的 `.description()` 作为选项文案 |
| `Schema.string()` | 文本输入框 | — |
| `Schema.string().role('secret')` | 密码输入框（掩码 + 显隐切换 + 「已设置」态） | 脱敏值不回填，仅在用户输入新值时 set |
| `Schema.string().role('credential-ref')` | 文本输入框 + 环境变量说明 | — |
| `Schema.number()` / `.natural()` | 数字输入框（带 min/max/step 约束） | 越界输入即时校验提示 |
| `Schema.array(X)` | 列表编辑器（行内编辑 + 增删 + 拖拽排序） | 元素为 object 时展开子表单 |
| `Schema.dict(X)` | 键值对编辑器（增删 key） | — |
| `Schema.object({...})` | 分组卡片（标题 = 字段名本地化） | 最多两层 |
| `Schema.union([...object])`（可辨识联合） | 类型选择器 + 对应子表单（参考官方 models 页 ProviderEditor 的协议选择） | 需要 discriminator 字段 |

**引擎内置行为**（插件无需实现）：

- 「已修改」徽标：`snap.user` 层存在该字段路径时显示，点击可 `unset` 重置回 base / 默认值。
- 「重启后生效」标注：namespace 注册 `applies: 'restart'` 时整页顶部提示。
- 冲突处理：`settings-conflict` → toast 提示 + 刷新快照。
- 只读态：`snap.writable === false` 全部禁用。
- 校验失败：schema `validate` 拒绝 → 行内红字显示错误。
- 主题：全部控件只消费 `--dsw-alias-*` 变量。

### 5.5 `package.json` 贡献点声明（corum 扩展）

为了让设置中心**在插件 client 半加载前**就能在导航中呈现入口（以及支持「插件设置」tab 聚合），corum 定义 `package.json` 声明式贡献点（类似 VS Code `contributes`）：

```jsonc
{
  "name": "@corum/dev-skill-manager",
  // ...
  "corum": {
    "settings": {
      "namespace": "dev-skill-manager",        // 数据层 namespace（kebab-case）
      "section": {
        "order": 100,
        "label": "settings.devSkillManager.navLabel"  // locale key
      }
    }
  }
}
```

**机制**：

- shell 在 boot 期扫描已启用插件的 `package.json`，收集 `corum.settings` 声明。
- 声明了 `section` 的插件，设置中心自动在导航渲染入口；激活时若 client 半尚未注册对应 slot，则用 `AutoSettingsSection` 兜底渲染自动表单（namespace 反射）。
- client 半若自绘了同 namespace 的 section（形态 B1），则覆盖自动表单。
- 该声明同时驱动扩展面板「插件设置」tab 的卡片聚合。

**优先级**：自绘 slot 注册 > `corum.settings.section` 声明 > 无入口（插件有 namespace 但没声明 section 时，仅在扩展面板「插件设置」tab 出现卡片，不占主导航）。

### 5.6 注册生命周期与双模式一致

- 插件 client 半 `package.json` 声明 `dsh.client`（platform web、inject 含 `@deepseek-ai/dsh-client-locale`、`immediately: false`）。
- slot 注册必须包在 `ctx.effect(...)` 中并返回 dispose，插件停用时设置页随 fiber 图自动摘除。
- host 半 `inject` 声明 `['settings']`，保证 `ctx.settings` 就绪后再 register。
- **双模式一致**：minimal（官方 SettingsRoot）与 IDE（ide-shell SettingsShell）slot 契约相同，插件贡献两模式自动生效；`corum.settings` 声明的兜底自动表单也两模式一致（壳无关，由 slot 层承载）。

---

## 6. 主题适配规范（硬性）

### 6.1 规则

1. **只允许消费 `--dsw-alias-*` CSS 变量**（corum `theme-layer.ts` GLASS_TOKENS 映射 + shell-base ThemePresenter 写入 body 内联变量，dark 自动设 `data-ds-dark-theme`）。
2. **禁止硬编码颜色值**：不得出现 `#hex`、`rgb()`、`hsl()` 字面量及 `light-dark()` 自封值。例外：作为 `var()` 的 fallback 值（如 `var(--dsw-alias-bg-base, #1a1a2e)`）允许但不推荐。
3. **禁止 `prefers-color-scheme` 媒体查询自封主题**：主题状态唯一来源是 `ctx.theme`。
4. **Portal 注意事项**：`backdrop-filter` 容器会建立 `position: fixed` 新包含块导致浮层裁切。飞出容器的浮层必须 `createPortal(..., document.body)`，出口优先复用 [FloatingLayer.tsx](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/shell-base/src/client/FloatingLayer.tsx)。portal 到 body 不影响 `--dsw-alias-*` 变量继承。
5. **自动表单引擎**内置全部遵循上述规则，插件用形态 A 即天然合规；自绘组件（形态 B）需自查。

### 6.2 可用 CSS 变量清单（GLASS_TOKENS 映射，当前 16 个）

| 变量 | 用途 |
|---|---|
| `--dsw-alias-bg-base` / `--dsw-alias-bg-overlay` / `--dsw-alias-bg-layer-1` / `--dsw-alias-bg-layer-2` | 背景（基底 / 浮层 / 分层卡片） |
| `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-dimmed` | 文字（主 / 次 / 弱 / 禁用） |
| `--dsw-alias-brand-primary` / `--dsw-alias-brand-text` | 品牌色（主按钮 / 品牌文字） |
| `--dsw-alias-state-error-primary` / `-success-primary` / `-warn-primary` | 状态色（错误 / 成功 / 警告） |
| `--dsw-alias-interactive-bg-hover` / `-active` | 交互态背景 |
| `--dsw-alias-border-subtle` | 边框 |
| `--dsw-alias-markdown-code-block` / `-inline-code` | 代码块 |

如设置页需要新语义色（如「已修改徽标」色），**必须先扩 GLASS_TOKENS**（`theme-layer.ts`，每值含 `{ light, dark }` 对），不得自封变量。

### 6.3 验证矩阵

每个设置页提交前必须在以下组合目检一次：

| 维度 | 取值 |
|---|---|
| 主题 | light / dark / system（system 需分别验证系统亮 / 暗两态） |
| 模式 | minimal / IDE |
| token 层 | 官方默认 / corum glass 覆盖层 |

---

## 7. 项目级设置覆盖（P2）

**目标**：支持全局（`~/.corum-shell/settings.yaml`）与项目（`<workspace>/.corum/settings.yaml`）两级设置，项目级覆盖全局（类 Claude Code 的 User / Project scope）。

**设计**：

1. **解析层**：三层解析扩展为四层 —— schema 默认值 → 组合 base → 全局用户分节 → 项目分节（越右优先级越高）。
2. **存储**：项目级文件 `.corum/settings.yaml` 在工作区根目录，建议随仓库提交（团队共享）；另支持 `.corum/settings.local.yaml`（gitignore，个人项目内覆盖）。
3. **UI**：
   - 设置面板顶部加 scope 切换器：「全局 | 本项目」（仅在有打开工作区时显示「本项目」）。
   - 每个设置行标注生效层徽标：「项目覆盖」/「全局修改」。
   - 写入时按当前选中的 scope 落到对应文件。
4. **namespace 级控制**：schema 注册时可声明 `scopes: ['user', 'project']`（默认都允许）；secret / credential 类字段建议 `scopes: ['user']`（密钥不随仓库走）。
5. **实现路径**：官方 `dsh-settings` 目前只有单一 provider  seam；corum 叠加层方案 = 新增 `ProjectSettingsProvider`（同样实现 provider 契约，文档源指向项目文件），解析时按 scope 链 merge。**需对照官方最新基座确认 seam 是否支持多 provider 链**；若不支持，corum 以 patch 层在 `resolve()` 处叠加项目层，保持对官方 seam 契约的兼容。

---

## 8. 配置迁移与 Profile（P2）

### 8.1 设置导入导出

- 导出：把当前 settings.yaml（或选中 namespace 片段）导出为 YAML 文件；secret 字段导出时脱敏为占位符（`__SECRET__:apiKey`），导入时提示重新填写。
- 导入：选择 YAML 文件 → 按 namespace 逐段 schema 校验 → 预览变更 diff → 确认写入（走 `settings.update`，继承 revision 并发与 validate 钩子）。
- 入口：Advanced section + Profiles section。

### 8.2 多 Profile 配置档案

- 概念：一套完整设置（全部 namespace 的用户层）为一个 Profile；用户可建多 Profile（如「工作」「个人」「演示」）并一键切换。
- 存储：`~/.corum-shell/profiles/<name>/settings.yaml`；当前活跃 Profile 记录在 `~/.corum-shell/active-profile`。
- 切换：切换 = 把目标 Profile 的文档热提交给 settings provider（复用 chokidar publish 通道），`applies: 'restart'` 的 namespace 提示重启。
- UI：Profiles section（order 92）：Profile 列表、新建（从当前复制 / 空白）、重命名、删除、切换、导出 / 导入。

---

## 9. 功能需求列表

| ID | 需求 | 优先级 | 状态 | 说明 |
|---|---|---|---|---|
| F1 | 设置中心终态信息架构落地（第 4 章导航分区 + order 规范） | P0 | 部分已有 | General/Models/Agent Presets 已有；其余 section 分期新建 |
| F2 | 《插件设置页贡献规范》（第 5 章）归档 | P0 | 本文档 | — |
| F3 | 存量设置 UI 主题审计（SettingsShell / GeneralSection / ui-settings-models / session-archive 行） | P0 | 未做 | 清除硬编码颜色，过 6.3 验证矩阵 |
| F4 | 自动表单引擎 `AutoSettingsSection`（schema → 表单，控件映射 5.4）落地到 `@corum/shell-base` | P1 | 未做 | corum 核心差异化；含 conflict/只读/secret/徽标内置行为 |
| F5 | `package.json` `corum.settings` 贡献点声明机制（boot 扫描 + 兜底自动表单 + 扩展面板聚合） | P1 | 未做 | 依赖 F4 |
| F6 | 扩展面板升级：`@corum/ui-settings-plugins` fork 为「已装 + 市场 + 插件设置」三 tab 一体面板（4.3） | P1 | 部分已有 | 官方 configurable/inventory tab 为基线，叠加管理 + 市场 tab |
| F7 | Permissions section（order 30）：approval / sandbox / allow-deny 规则 | P1 | 未做 | schema 用官方 `permission` namespace |
| F8 | Rules & Instructions section（order 32）：全局自定义指令 / personality | P1 | 未做 | 新建 corum namespace `corum-rules` |
| F9 | Memory section（order 34）：记忆开关 / 查看 / 清除 | P1 | 未做 | 依赖 Agent memoryPolicy 运行能力 |
| F10 | Terminal section（order 36）：`shell` namespace 可视化 | P1 | 未做 | schema 已有，纯 UI；可用自动表单引擎直接生成 |
| F11 | MCP & Integrations section（order 72）：承接 dev-mcp-manager | P1 | 未做 | — |
| F12 | Skills section（order 74）：承接 dev-skill-manager | P1 | 未做 | — |
| F13 | Privacy section（order 52）：遥测开关 / 敏感文件排除 | P1 | 未做 | 新建 corum namespace `corum-privacy` |
| F14 | Data Management section（order 54）：存储查看 / 清理 / 重置 | P1 | 未做 | 承接 session-archive 归档能力 |
| F15 | Appearance section（order 2）：主题 / accent / 字体 / 密度 | P1 | 未做 | 主题部分用官方 `ui-theme` namespace |
| F16 | Notifications section（order 4） | P2 | 未做 | 新建 corum namespace `corum-notifications` |
| F17 | Hooks & Automation section（order 38） | P2 | 未做 | 依赖 hooks 运行能力 |
| F18 | Agent Loop section（order 39）：`agent-loop` namespace 可视化 | P2 | 未做 | schema 已有，自动表单可生成 |
| F19 | Account & Usage section（order 50） | P2 | 未做 | 依赖账户 / 用量统计能力 |
| F20 | Keyboard Shortcuts section（order 6） | P2 | 未做 | 依赖快捷键体系 |
| F21 | 设置搜索（4.4）：壳顶部搜索框 + `@modified` 过滤 | P2 | 未做 | IDE 壳先行 |
| F22 | 项目级设置覆盖（第 7 章） | P2 | 未做 | 依赖官方 seam 多 provider 能力确认 |
| F23 | 设置导入导出（8.1） | P2 | 未做 | — |
| F24 | 多 Profile 配置档案（8.2，order 92） | P2 | 未做 | 依赖 F23 |
| F25 | 通用自绘控件库（`@corum/shell-base`：ValueField / SecretField / EnumSelect / NumberField / ListEditor） | P2 | 未做 | 从 F4 自动表单引擎沉淀 |
| F26 | Advanced section（order 90）：打开 settings.yaml / 诊断 / 日志 / 开发者模式 | P2 | 未做 | 「打开 settings.yaml」官方 `settings.action` 已有，此处聚合 |

---

## 10. 非功能需求

| 类别 | 需求 |
|---|---|
| 主题 | 全部设置 UI 在 light / dark / system + corum token 覆盖层下无硬编码颜色、无对比度不可读项；portal 浮层继承变量；过 6.3 验证矩阵 |
| 性能 | 设置页按需加载（`immediately: false`）；section 切换只渲染 active 项；自动表单引擎对 schema 反射结果做 memo；快照订阅组件级，不级联重渲染 |
| 冲突处理 | 所有写入经 revision 乐观并发；`settings-conflict` 可捕获、可恢复（刷新快照 + 用户提示），禁止丢用户输入 |
| secret 安全 | secret 字段全链路脱敏：describe 强制 redactSecrets；UI 掩码显示；日志禁止打印明文；导出时脱敏为占位符 |
| 持久化可靠 | settings.yaml 写入走官方跨进程写锁与 leaf diff；chokidar 热重载外部修改后 UI 快照自动刷新 |
| 双模式一致 | minimal / IDE 两种壳下同一插件贡献渲染结果一致；手测清单覆盖双模式 |
| 可回溯 | 规范与实现改动按项目 git 规范逐次提交；fork 包对齐官方用 `diff -rq` 验证只剩差异化文件 |
| 可访问性 | 表单控件 label 关联、键盘可达、焦点态可见；对比度满足 WCAG AA |

---

## 11. 验收标准

**AC1（信息架构）**：minimal 与 IDE 模式打开设置中心，导航 rail 按第 4 章分区与 order 展示；随分期推进，已落地 section 顺序与 4.1 表一致。

**AC2（schema 自动生成）**：新建测试插件仅完成 5.1 数据层注册（host namespace + schema，含 boolean / union / string / secret / number / array 各至少一个字段）+ `package.json` `corum.settings.section` 声明，**不写任何 React 页面组件**，设置中心自动出现该导航项并渲染出可用表单；读写、重置、secret 掩码、「已修改」徽标、「重启后生效」标注均正常。

**AC3（自绘覆盖）**：测试插件自绘 section 组件（形态 B1）后，覆盖同 namespace 的自动表单，导航入口不变。

**AC4（General 行贡献）**：测试插件向 `settings.general.item` 注册一行，General 页按 order 正确插入。

**AC5（扩展面板）**：扩展面板三个 tab 可用：已装插件可启停 / 卸载（CORE_PLUGIN 除外）/ 跳转设置；市场 tab 可浏览安装；「插件设置」tab 聚合所有声明 namespace 的插件卡片（自动表单或自绘）。

**AC6（主题）**：任一设置页在 6.3 验证矩阵下截图对比，无硬编码颜色导致的反差异常；飞出浮层（portal）在 composer 卡片内触发时不被裁切。

**AC7（写入与冲突）**：UI 修改设置 → settings.yaml 对应 leaf 更新；两个客户端同时改同一字段 → 后到请求收到 `settings-conflict`，UI 提示并刷新，无静默覆盖。

**AC8（secret）**：secret 字段在 describe RPC 返回与 UI 展示中均为脱敏值；settings.yaml 中明文存储但不出现在任何日志；导出文件中被替换为占位符。

**AC9（双模式 + 生命周期）**：同一插件贡献在 minimal / IDE 模式渲染一致；停用插件后导航项与卡片消失，启用后恢复。

**AC10（规范文档）**：`docs/prd/settings-prd.md` 归档评审通过；F4 / F5 落地后，dev-skill-manager 或 dev-mcp-manager 之一按规范完成端到端接入，作为可复制模板。

---

## 12. 里程碑 / 分期建议

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **M1 规范与基线（P0）** | 本 PRD 评审归档（F2）；order 规范核对官方占用；存量设置 UI 主题审计（F3）；双模式回归 | AC1（已有部分）/ AC6（存量）通过 |
| **M2 自动表单引擎（P1 核心）** | `AutoSettingsSection` 引擎落地（F4）；`corum.settings` 贡献点机制（F5）；以一个真实插件（dev-skill-manager）端到端验证 | AC2 / AC3 / AC4 / AC7 / AC8 / AC9 通过 |
| **M3 扩展面板 + Agent 行为区（P1）** | 扩展面板三 tab 升级（F6）；Permissions（F7）/ Rules（F8）/ Memory（F9）/ Terminal（F10，自动表单直出）/ MCP（F11）/ Skills（F12）/ Privacy（F13）/ Data Management（F14）/ Appearance（F15） | AC1 / AC5 通过；权限配置对 Agent 运行实际生效 |
| **M4 体验增强（P2）** | 设置搜索（F21）；控件库沉淀（F25）；Notifications（F16）/ Hooks（F17）/ Agent Loop（F18）/ Account（F19）/ Shortcuts（F20）/ Advanced（F26） | 按需排期，不阻塞 M1–M3 |
| **M5 配置体系（P2）** | 项目级覆盖（F22）；导入导出（F23）；多 Profile（F24） | 全局 / 项目两级写入与覆盖生效；Profile 切换热生效 |

---

## 附 A：官方已占用 namespace 清单（注册前必查）

`locale` / `ui-theme` / `ui-conversation` / `ui-onboarding` / `agent-loop` / `permission` / `llm-deepseek` / `llm-pi-ai` / `shell` / `web-search-deepseek` / `agent-default-model` / `agent-presets`

corum 已规划新增：`corum-rules`（F8）/ `corum-privacy`（F13）/ `corum-notifications`（F16）；插件按 5.1 命名规则自占。

## 附 B：关键文件索引

- corum IDE 设置壳：[SettingsShell.tsx](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/ide-shell/src/client/SettingsShell.tsx)、[SettingsGeneralSection.tsx](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/ide-shell/src/client/SettingsGeneralSection.tsx)、slot 声明 [index.tsx](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/ide-shell/src/client/index.tsx)
- 通用浮层出口：[FloatingLayer.tsx](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/shell-base/src/client/FloatingLayer.tsx)
- 主题层：`packages/plugins/ui/ide-shell/src/client/theme-layer.ts`（GLASS_TOKENS）、`packages/plugins/ui/shell-base` ThemePresenter
- 插件中心：`packages/shell/src/host/plugin-manager.ts`、PluginManagerPanel.tsx
- patch：`packages/shell/cordis.patch.yml`、`cordis.ide.patch.yml`
- 官方参考：`/Users/kukucai/dsh/packages/settings/settings/`（seam）、`/Users/kukucai/dsh/packages/client/`（ui-settings / ui-settings-general / ui-settings-models / ui-settings-plugins 等）、`/Users/kukucai/dsh/docs/subsystems/settings.zh.md`（官方子系统文档）
