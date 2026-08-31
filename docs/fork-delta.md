# corum 会话域 fork 差异台账 + 升级 runbook

> 架构整改 **C4** 交付物。本文档把会话域 6 个 fork 包（fork 自官方 `@deepseek-ai/dsh-client-ui-*`）相对官方基线的**全部差异**登记成台账：逐文件分类（逐字节相同 / 仅 import 改名 / 实质修改 / corum 新增 / 官方有但 corum 删除）、每处实质差异的原因（从 `// fork（corum）：` / `CORUM-PATCH:` 注释与 git log 提取）、rebase 风险标注。官方版本升级时按第 5 节 runbook「按单执行」，不再考古。
>
> - 生成方式：`diff -r packages/plugins/session/<pkg>/src /Users/kukucai/dsh/packages/client/<官方包>/src` + 逐文件 diff 分类（脚本统计，非印象）。
> - 官方基线版本：`0.1.2-alpha.2`（`/Users/kukucai/dsh/packages/client/*/package.json` 的 `version`）。⚠️ corum 各 fork 的 `dependencies` 仍锁 `^0.1.2-alpha.1`——**源码对照的是 alpha.2、依赖锁 alpha.1，双向差一代**（审计 B 群 P1，见 §3.4）。
> - 参考：`.dbg/audit-B-session.md`（session 群逐文件审计）、`docs/audit/CODE-AUDIT-REPORT.md`（P0-6/11/12/13/15）。

---

## 1. 总览表

> 统计口径：对每包 `src/` 与官方 `src/` 做 `diff -r` 后逐文件分类。「仅改名」= diff 行全部是把 `@deepseek-ai/dsh-client-ui-*` 改成 `@corum/corum-ui-*` 的 import 路径替换；「实质修改」= 存在任何其它 diff 行（含 CSS、locale、逻辑）。`invariant.ts` 在各包均属「实质修改」（包名+插件名改名），不重复列入下表明细。

| fork 包 | 官方对照包 | 官方基线 | 文件数(corum/官方) | 逐字节相同 | 仅改名 | 实质修改 | corum 新增 | 官方有但 corum 删 | rebase 风险 |
|---|---|---|---|---|---|---|---|---|---|
| corum-ui-conversation | ui-conversation | 0.1.2-alpha.2 | 67 / 65 | 45 | 0 | 20 | 2 | 0 | **高**（apply.ts 空态操作卡、ConversationRoot/EmptyHero/InputBar 重设计） |
| corum-ui-chat | ui-chat | 0.1.2-alpha.2 | 96 / 85 | 39 | 25 | 19 | 13 | 2 | **高**（ChatNodeSeat foldable、corum-reskin.css、TurnTail 重构、Review/Subagent 新增） |
| corum-ui-approval | ui-approval | 0.1.2-alpha.2 | 8 / 8 | 4 | 1 | 3 | 0 | 0 | **中**（ApprovalPanel 重设计 + lucide 依赖） |
| corum-ui-questions | ui-user-questions | 0.1.2-alpha.2 | 7 / 11 | 0 | 0 | 3 | 4 | 8 | **高**（渲染层整体重写，文件名全不同——按「新包替换」对待） |
| corum-ui-model-selection | ui-model-selection | 0.1.2-alpha.2 | 11 / 11 | 4 | 0 | 7 | 0 | 0 | **低**（教科书式最小 fork，仅 model-unavailable 语义 + 触发器文案） |
| corum-ui-settings-models | ui-settings-models | 0.1.2-alpha.2 | 24 / 25 | 11 | 0 | 13 | 0 | 1 | **中**（operations.ts 删除改直持 wire face，官方加回即冲突） |

合计：相同 103、仅改名 26、实质修改 65、新增 19、删除 11（`src/` 内文件；各包根 `index.ts`/`invariant.ts`/`css-modules.d.ts` 计入实质修改）。

**rebase 成本集中点**：实质修改的 65 个文件中，真正需要「三方合并」的高危文件约 20 个（见 §4 逐包详录的 🔴 标注）；其余是 locale 键增删、CSS 换肤变量替换这类机械合并。

---

## 2. 分类口径说明

| 分类 | 定义 | rebase 策略 |
|---|---|---|
| **逐字节相同** | `cmp -s` 一致（103 个） | 官方新版直接覆盖，零成本 |
| **仅 import 改名** | diff 行全部是 `@deepseek-ai/dsh-client-ui-*` → `@corum/corum-ui-*`（26 个） | 官方新版覆盖后机械替换包名（sed 一把梭） |
| **实质修改** | 有逻辑/文案/样式差异（65 个） | 逐处三方合并；🔴 标记的必冲突 |
| **corum 新增** | 官方没有的文件（19 个） | 官方升级不影响；注意其依赖的官方 API 是否变动 |
| **官方有但 corum 删** | corum 侧删除的文件（11 个） | 官方升级若改了这些文件，需确认 corum 是否仍要删（删除理由见详录） |

---

## 3. 跨包共性结论

### 3.1 会话域对 conversation 是 type-only 契约消费，与官方逐行对齐（不做抽包）

**实证（A3 整改项，主 Agent round 2）**：chat/approval/questions 对 `@corum/corum-ui-conversation` 的全部 import 都是 **type-only** 且来自 conversation 的 `contract/` 目录。本次台账复核（grep 全量 import）确认：

- chat 26 处 import，全部 `import type` 或 `import type {}`：`ConversationNodeDefinition`/`ConversationMatch`/`ConversationNodeContext`/`ConversationPromptSnapshot`/`KnownContextForm`/`MessageImageSource`/`ComposerChainProps` 等，全部来自 `corum-ui-conversation/client` 的 contract 导出。
- approval 1 处：`import type { ComposerChainProps }`（client/index.ts:5）。
- questions 1 处：`import type {} from '@corum/corum-ui-conversation/client'`（client/index.tsx:25，纯为拉入 SlotMap 模块合并声明让 `conversation.composer.dock` 槽过类型检查）。
- 官方对照**逐行相同**：官方 `ui-chat/conversation-nodes/tool.ts:3-4` 同样 `import type { ConversationMatch, ConversationNodeContext, ConversationNodeDefinition }` 自官方 ui-conversation。

**结论**：这是官方设计的「契约中心辐射」——feature 插件 type-only 消费 conversation 的 contract 类型，零实现层依赖。**不是需要解耦的问题，不做 contract 抽包**（抽包会让 corum 文件布局偏离官方，rebase 更痛，详见 §6）。

> ⚠️ 残留瑕疵（非契约问题，单列）：chat 的 `contract/slots.ts:128-131` 在 contract 层用 `import('../chat/review-source.ts').ReviewSource` inline import 了本包渲染层——契约反向依赖渲染层（审计 B 群 P1）。这是包内分层问题，与跨包契约无关。

### 3.2 核心数据通路与官方零漂移

chat 的 `conversation-nodes/` 15 个大文件（assistant/command/common/compaction/event-projection/fallback/inbox/message/request-prompt/retry/tool/turn-error/turn-max-tokens/turn-process/turn-tail + chat-snapshot-builder）全部**仅 import 改名**，逐行逻辑与官方一致；conversation 核心的 assembler/facade/location-index/machine **逐字节相同**；审批/提问 waterfall 生命周期逐行一致。fork 策略成立：定制集中在渲染层与空态。

### 3.3 新增 UI 系统性硬编码中文，绕过 locales 设施（审计 P1，已发现）

新增/重设计组件把产品文案硬编码为中文，不走 `t()`：`conversation/skeleton/EmptyStateHero.tsx`、`ConversationRoot.tsx`、`chat/MessageItem.tsx:182`（'You' + `toLocaleTimeString('zh-CN')` 时区硬编码）、`chat/AssistantMarkdown.tsx`（AgentHeader 'Corum Agent' + zh-CN）、`questions/QuestionCard.tsx`（注册了 `corum-question` 词典含全部键但 `t()` 一次未用，词典形同虚设）、`approval/ApprovalPanel.tsx:38,63,78-80`（'Corum Agent'/'始终允许'）。**rebase 注意**：官方 locale 键演进时 corum 的 `locales.ts` 差异里有相当一部分是「官方新增键 corum 未同步」（如 chat 的 `message.turnTime.*` 4 键、conversation 的 `access.preset.*` 3 键）——合并 locale 时要把官方新增键补回 corum 词典，而不是整文件覆盖。

### 3.4 依赖版本与源码基线错位（审计 B 群 P1）

全部 6 包 `dependencies` 把官方包从官方仓库的 `workspace:^` 改为 npm `^0.1.2-alpha.1`，且全部从 devDependencies 挪进 dependencies（官方规范：浏览器/类型关系只进 devDependencies）。而 fork 源码对照的是官方 `0.1.2-alpha.2`。**升级官方前必须先对齐这个错位**：要么依赖升 alpha.2，要么明确冻结在 alpha.1 基线重 diff。

### 3.5 官方错误码命名空间化是 alpha.1→alpha.2 的主要漂移

conversation 的 `service.ts:318`、`input/hub.ts:204`、`InputBar.tsx:95-97`、`image-labels.ts` 的 diff 全部是官方把裸错误码改为 `session/steer-unavailable`、`session/queue-item-not-found`、`session/attachment-invalid`、`subagent/attachment-unsupported`——corum 这 4 处仍停在 alpha.1 的裸码。**这是本次台账新确认的、审计未单独列出的 rebase 欠债**：corum 侧按裸码匹配，Host 端若已升 alpha.2 发带命名空间的码，这些匹配全部静默失效（附件错误不再显示友好文案、steer 冲突不再静默收敛）。升级 runbook 第 2 步必须优先核对此 4 处。

### 3.6 `invariant.ts` / 根 `index.ts` 为模板性修改

6 包 `invariant.ts` 均为包名（`@corum/*`）+ 插件名（`corum-ui-*-invariant`）改名的模板复制，rebase 时随包名机械处理。conversation/chat 根 `index.ts` 把官方 `import type {} from '@deepseek-ai/dsh-settings'` 改为值导入 `settingsNamespace` 并注册 `settingsNamespace(CONVERSATION_SETTINGS_NAMESPACE)`——官方 alpha.2 改为直接传命名空间字符串（settingsNamespace 调用已内联进官方），rebase 时向官方对齐（回退到官方写法）即可。

---

## 4. 逐包差异详录

> 每文件给「分类 + 差异点 + 原因 + rebase 风险」。🔴 = rebase 官方时必冲突或已确认的死代码/全局污染，需逐处人工三方合并；🟡 = 机械合并（locale 键、CSS 变量）；🟢 = 低危。

### 4.1 corum-ui-conversation（对照 ui-conversation）

相同 45 / 改名 0 / 实质 20 / 新增 2 / 删除 0。**rebase 风险：高**（骨架层是重设计主战场）。

**逐字节相同（45 个，直接覆盖）**：核心数据通路全在此列——`client/assembler/*`、`client/facade/*`、`client/location-index.ts`、`client/machine/*`、`client/contract/conversation.ts`、`request-inspection.ts`、`context-provenance.ts` 等 contract 三大件、`queue/*` 逻辑、`input/*` 大部分、`skeleton/` 其余组件。

**实质修改（20 个）**：

| 文件 | 差异点 | 原因（注释/git log） | 风险 |
|---|---|---|---|
| `client/apply.ts` | inject 去掉 `uiWorkspace` 加 `workspaces`；`workspaceNavigation` 改 `ctx.get` 可选获取+降级抛错（:105-107, :202-203）；新增 `emptyActions` 整块（:222-340，~119 行）含 pickDir/currentCwd/startTaskLane/listProjects/listAgents/listModels/listPermissions 等；新增 `makeCorumRpcCall`/`ConnectionHandle`/`setSidebarMode` import | `// fork（corum）：移除 'uiWorkspace'——kkc IDE 禁用官方 ui-workspace`（apply.ts:48-51）；空态操作卡是 2026-08-30 圆桌收敛产品需求 | 🔴 必冲突。官方 apply.ts 任何改动都要与此块三方合并。另 `ctx.get('connection')` 硬取未声明 inject（审计 P1，:222 注释自承「本插件的 inject 没有 connection」） |
| `client/contract/slots.ts` | 新增 `emptyActions` 槽类型 + `AgentOption`/`ModelProviderOption`/`PermissionOption`/`PermissionSelect`/`WorkspaceOption`/`NewTaskOptions` 六个导出接口（:221-308，~88 行） | 空态操作卡的契约面（2026-08-30 圆桌收敛） | 🔴 官方 contract/slots.ts 改动需与此增量合并；契约扩展方式正确（新增可选字段不改官方字段） |
| `client/skeleton/ConversationRoot.tsx` (+module.css 179 diff 行) | 重设计：HeroGlow 渲染位置、EmptyStateHero 接入、布局结构调整（260 diff 行） | corum 液态玻璃设计稿（git `e76f5a77`）；:12 有未使用 import HeroShell（审计 P1 死 import） | 🔴 重设计文件，官方改动逐处人工看 |
| `client/skeleton/EmptyHero.tsx` | 删官方 SMIL 游动鱼动画（HERO_SWIM_UP/DOWN_PATH 两大段 path），新增 `HeroGlow` 组件（figma 313:14109 蓝色光斑）；FishLogo 图标替换成 corum 版 | 设计稿替换（glow 由 owner ConversationRoot 渲染，注释 :64-97） | 🔴 |
| `client/skeleton/EmptyStateHero.tsx` + `.module.css` | **corum 新增**（465 行）：空态操作卡（最近项目/新建任务/新建项目表单） | 2026-08-30 圆桌收敛，产品需求 | 🟢 官方无此文件；注意其消费的 apply.ts emptyActions 与官方 contract 演进 |
| `client/skeleton/ConversationSession.tsx` | 删官方 titleRow 整块（ crumbs 面包屑 + lineage 槽 + headerActions，~58 行），保留 tabs+header | 注释 :86「标题行已移除（2026-08-29）：Agent 标题栏已显示会话标题，避免重复」 | 🔴 官方 header 演进（crumbs/lineage 槽）corum 全删，rebase 需确认是否仍全删 |
| `client/skeleton/InputBar.tsx` (+module.css 284 diff 行) | 新增 sparkle 提示词优化按钮（:430-450，aria-label 硬编码中文 + `console.log('优化提示词')` TODO 遗留）；toolbar 重排（tbtn-plus 26×26、PermissionSelect 常显）；附件错误码匹配停在 alpha.1 裸码 | 设计稿 qVHA8/htxWi；错误码见 §3.5 | 🔴（样式）+ 🟡（错误码 3 行） |
| `client/skeleton/PermissionSelect.tsx` (+css 3 行) | `permissionGlyphs` 对象改 Map；删官方 `BUILT_IN_PERMISSION_NAMES` locale 回退机制，改 `displayName(option.name)` + Full access 特判 | corum 把档位显示名交给官方配置名，不再内置英文艺名（locales.ts 同步删 `access.preset.*` 3 键） | 🟡 与 locales.ts 联动合并 |
| `client/locales.ts` | placeholder 文案改、删官方 `access.preset.readOnly/workspaceWrite/fullAccess` 3 键、`access.confirm.*` 文案改（'完全权限'→'Full access'） | 产品文案定调 | 🟡 |
| `client/input/hub.ts` | `steer-unavailable`→`session/steer-unavailable` 等错误码匹配（4 行注释+2 行代码） | 官方 alpha.2 命名空间化，corum 停在 alpha.1 | 🟡 见 §3.5，升 alpha.2 时向官方对齐 |
| `client/service.ts` | 同错误码 2 行（:318） | 同上 | 🟡 |
| `client/image-labels.ts` | 注释里错误码名 3 行 | 同上 | 🟡 |
| `client/skeleton/ContextMeter.module.css` / `TodoPanel.module.css` / `QueueDock.module.css` / `HeroShell.module.css` / `PermissionSelect.module.css` / `ConversationRoot.module.css` / `InputBar.module.css` | `background: var(--dsw-*)` → `var(--corum-glass-1/2)` + `backdrop-filter: blur(20px)` + `border: var(--corum-glass-border)` | `/* fork（corum 液态玻璃）*/`（git `e76f5a77` 全局换肤 14 张 module.css） | 🟡 机械换肤；官方改这些文件的布局/结构时需合并，纯变量替换可保留 corum 值 |
| `index.ts` | `import type {}` → 值导入 `settingsNamespace` + 注册调用 | 官方 alpha.2 已内联命名空间字符串 | 🟡 向官方对齐（回退官方写法） |
| `invariant.ts` | 包名/插件名改名 | 模板 | 🟢 |

### 4.2 corum-ui-chat（对照 ui-chat）

相同 39 / 改名 25 / 实质 19 / 新增 13 / 删除 2。**rebase 风险：高**（含全仓两个 P0：foldable=false + corum-reskin 全局污染）。

**仅 import 改名（25 个，官方覆盖后 sed 包名）**：`conversation-nodes/` 全部 16 个（assistant/chat-snapshot-builder/command/common/compaction/event-projection/fallback/inbox/message/request-prompt/retry/tool/turn-error/turn-max-tokens/turn-process/turn-tail）、`contract/chat-nodes.ts`、`contract/snapshot.ts`、`model/conversation-context.ts`、`chat/ContextBody.tsx` 等。注意 `contract/snapshot.ts:70` 的 `declare module '@corum/corum-ui-conversation/client'` 也是改名产物——sed 时连 declare module 字符串一起换。

**实质修改（19 个）**：

| 文件 | 差异点 | 原因 | 风险 |
|---|---|---|---|
| `chat/ChatNodeSeat.tsx` | :152-153 官方 `foldable = processWindowReady && (processMember \|\| ...)` 逻辑删，改 `const foldable = false` | 注释「工具调用不再折叠（2026-08-29）：foldable 恒为 false，工具调用始终展开显示」（git `0607a76b`）；但折叠 UI 全套代码（:155-224）保留成死路径（审计 P0-12） | 🔴 **必冲突**。官方动 ChatNodeSeat 折叠逻辑时 corum 是「删逻辑留死代码」，三方合并前应先按 P0-12 整改（连 TurnProcessNodeView 折叠分支一起删，或做成 ChatSettings 开关） |
| `client/corum-reskin.css` | **corum 新增**（58 行）：`[data-slot=...] button[class*="primary"]` 等全局选择器换肤 | 液态玻璃全局换肤（git `e76f5a77`）；审计 P0-13：全局 CSS 污染，命中其它插件 DOM、官方类名 hash 变即失效、注入无卸载 | 🔴 **rebase 前必须按 P0-13 整改**（可挂类名的收回各 .module.css）；否则官方任何 DOM/类名变动都可能静默失效或误伤 |
| `client/apply.ts` | import corum-reskin.css；新增 `reviewSources` WeakMap + `reviewSource()`（:85-100）；binding 取出改两行；slots 注入加 `review` + `getAgentName`（:134, :167-195，~29 行 RPC 手搓） | fork 重设计注释（:25-26）；getAgentName 2026-08-31 用户定调显示 nickname；`ctx.get('connection') as` 两处硬取未声明 inject（审计 P0/P1，:93,174） | 🔴 getAgentName 整块是 corum 独有 RPC 逻辑（listTaskAgents/listProfiles），官方 apply.ts 改动需绕开此块合并 |
| `client/contract/slots.ts` | 新增 `review: ReviewSource` + `getAgentName` 两槽字段（:128-131）；**用 `import('../chat/review-source.ts')` inline import 渲染层** | fork 注释 :128 | 🟡 字段增量合并；⚠️ contract 反向依赖渲染层（§3.1 残留瑕疵） |
| `chat/ChatView.tsx` (+css 39 行) | 新增 agentName state+effect（:210-217）、reviewChanges uSES + revertAll（:235-245）、`<AgentNameContext.Provider>` 包裹（:594,703）、ReviewCard 挂载块（:677-691）；`useSyncExternalStore` import；`t as unknown as` 双断言（:688） | Review 卡 + Agent 昵称（fork 注释 :235, :677） | 🔴 ReviewCard/AgentNameContext 挂载点与官方 ChatView 布局演进需人工合并 |
| `chat/AssistantMarkdown.tsx` (+css 27 行) | 新增 `AgentHeader` 组件（:13-26，硬编码 'Corum Agent' + `new Date().toLocaleTimeString('zh-CN')`）+ `showAgentHeader` prop（:130-131） | 设计稿 x1mv8q head；⚠️ 渲染期 `new Date()` 流式重渲时间每秒变（审计 P1） | 🟡 增量合并；时区硬编码入 §3.3 i18n 整改 |
| `chat/AssistantNodeView.tsx` | 新增 `showAgentHeader = data.step <= 1` 计算并下传（:29-32,42） | 注释「Agent 头只在 turn 的第一个 step 显示」 | 🟡 |
| `chat/MessageItem.tsx` (+css 40 行) | 删官方 `reveal: 'always'/'hover'` 可达性设计（:151,164-166, :281-293 官方 isLatestUserRow 逻辑全删）；新增 userHeader（'You' + zh-CN time，:181-185）+ `time` prop | 设计稿 riOKX h；⚠️ 删了官方「无 hover 设备最新行常显」可达性（审计 P1） | 🔴 官方 MessageItem 的 actions-reveal 机制被整块删除，官方在此文件的任何改进都与之冲突 |
| `chat/MessageIconActions.tsx` (+css 46 行) | 删官方 `usageAction` 槽（:137 官方）改回 props 直传 `runMs/ttftMs/tokensPerSecond` 并在时钟后拼接 `· Ran for / · TTFT / · tok/s`（:78-107）；format* 三个函数 import 自 message-chrome | TurnUsage 展示重构（配合 TurnTailNodeView 重构） | 🔴 与官方「usageAction 槽」方向相反，官方此文件必冲突 |
| `chat/TurnTailNodeView.tsx` (+css 7 行) | 用 corum `TurnUsageDisclosure` 替官方 `TurnUsagePanel/TurnTimePanel`；删官方 `isLatestTurn` reveal 逻辑；footer 结构重排 | 重设计（TurnUsageDisclosure 取代官方，审计 B「有意重设计」） | 🔴 |
| `chat/register-node-renderers.ts` | 新增 SubagentCard 槽注册（:10, :47-49） | fork 注释「子 Agent 进度卡」 | 🟡 |
| `conversation-nodes/register.ts` | 新增 `registerSubagentConversationNode(ctx)`（:11, :35-36） | 同上 | 🟡 |
| `client/index.ts` | 删官方两组 `export type ... from ui-conversation/client` re-export（:44-49） | 注释 :44「chat 对 conversation 仅 type-only 引用，不再把对方类型 re-export 为本包公共 API（全仓无人从本包 import 这些类型）」——A3 整改成果 | 🟡 官方若新增 re-export 键，corum 有意不收 |
| `client/locale.ts` | 新增 review.* 5 键 + subagent.* 4 键（zh+en）；turnUsage 键集改（summaryWithCache 替 consumed+cacheHit，删 total，加 ttft）；**未同步官方新增 `message.turnTime.*` 4 键** | review/subagent 新 UI 文案；turnUsage 重设计 | 🟡 合并时补官方 turnTime.* 键（§3.3） |
| `index.ts` / `invariant.ts` | settingsNamespace 注册 / 包名改名 | 同 conversation | 🟢/🟡 |

**corum 新增（13 个，官方升级不影响其存在，但其依赖的官方 API 变动要核对）**：
`chat/ReviewCard.tsx`(111) + `.module.css`、`chat/SubagentCard.tsx`(59) + `.module.css`、`chat/TurnUsageDisclosure.tsx`(86) + `.module.css`、`chat/agent-name-context.ts`(9)、`chat/review-changes.ts`(199)、`chat/review-revert.ts`(105)、`chat/review-source.ts`(82)、`conversation-nodes/subagent.ts`(201)、`contract/subagent.ts`(114)、`corum-reskin.css`(58)。已知问题（审计 B）：SubagentCard `running` 写死 true + correlateChild 只按时间猜子会话；review-source 订阅永不退订；review-changes/review-revert 统计口径误导（write 整文件计 added、skipped 判定致「全部撤销」永报失败）。

**官方有但 corum 删除（2 个）**：`chat/TurnUsagePanel.tsx`(235 行官方) + `.module.css`——被 TurnUsageDisclosure 有意取代。**rebase 核对**：官方若更新 TurnUsagePanel（alpha.2 已含 TurnTimePanel TTFT/TPS），corum 的 TurnUsageDisclosure 要人工决定跟不跟（目前 corum 版键集已落后，见 locale.ts 行）。

### 4.3 corum-ui-approval（对照 ui-approval）

相同 4 / 改名 1 / 实质 3 / 新增 0 / 删除 0。**rebase 风险：中**。

- `client/ApprovalPanel.tsx`（45 diff 行）🔴：重设计为 corum 审批卡——轮头（avatar+'Corum Agent' 硬编码+waiting tag，:35-40）、拆分按钮「允许一次 + ▾ 浮层 menu」（:53-82，menu 无 click-outside/Escape）、「始终允许」菜单项永久 disabled 死 UI（注释自承「会话级始终允许暂未接入」）；`import { ChevronDown } from 'lucide-react'` 替官方 ui-primitives Button（:3，审计 P2 图标体系并存）。原因：对齐 corum 审批卡设计（注释 :35）。
- `client/ApprovalPanel.module.css`（180 diff 行）🔴：审批卡整套样式重写。
- `client/index.ts` 🟢：仅 `ComposerChainProps` import 改名（1 行）。
- `invariant.ts` 🟢：模板改名。

数据通路（pendingInteractions/waterfall）与官方逐行一致——定制全在渲染层。

### 4.4 corum-ui-questions（对照 ui-user-questions）

相同 0 / 改名 0 / 实质 3 / 新增 4 / 删除 8。**rebase 风险：高——渲染层整体重写，文件名全不同，按「新包替换官方渲染层」对待，无法逐文件合并**。

- **corum 新增（4 个）**：`client/QuestionCard.tsx`(207) + `.module.css`、`client/contract.ts`(126，自实现 PendingQuestion 运行时类——官方 `./client` 只 `export type` 不导出运行时类，corum 无法 new，故同形复制 80 行结算生命周期，注释 :1-6；⚠️ 双事实源，官方修复不联动）、`client/index.tsx`(替官方 index.ts，dock 挂载 + PendingQuestion 注册 + composer block 拦截)。
- **官方有但 corum 删除（8 个）**：`QuestionComposer.tsx`(441) + css、`PlanReviewPanel.tsx`(87) + css、`draft-store.ts`(57)、`contract/slots.ts`(224)、`index.ts`(107)、`invariant.ts`。删除理由（index.tsx 头注 :1-12）：官方接管整个 composer 遮盖对话，corum 改挂 `conversation.composer.dock` 卡片不遮盖输入；**代价：官方 PlanReviewPanel（计划待审卡）功能在 corum 缺失**——官方 ui-user-questions 的 plan-review 种类 corum 未实现（PendingQuestion.kind 声明了 'plan-review' 但无渲染器）。rebase 时官方若增强 plan-review，corum 无法自动获得。
- **实质修改（3 个）**：`client/locales.ts`（69 diff 行：NS 从 'question' 改 'corum-question'，键集全换——⚠️ 但组件硬编码中文 t() 未用，词典形同虚设，审计 P1）；`index.ts`（host 半注释精简）；`css-modules.d.ts`（去掉 Readonly + 加 `declare module '*.css'`）。
- 数据通路复用官方 `user-questions/request` waterfall，answer/cancel/delegate 语义一致。⚠️ P0-11：QuestionCard「跳过本题」wired 到 `cancel()` 取消整组，与官方 skip 语义不符——修此 bug 时注意别被 rebase 覆盖回滚。

### 4.5 corum-ui-model-selection（对照 ui-model-selection）

相同 4 / 改名 0 / 实质 7 / 新增 0 / 删除 0。**rebase 风险：低**（审计 B「教科书式最小 fork」，package.json description 如实）。

- `client/directory.ts`（19 diff 行）🟡：新增 `errorKind: string | null` 字段（:36-42 注释说清用途）+ 三处置位/清空。零其它漂移。
- `client/ModelSelect.tsx`（22 diff 行）🟡：`state.errorKind === 'model-unavailable'` 时 Toast 从错误改 info 提示（:162-170，CORUM-PATCH 注释：图片会话切纯文本模型是「约束不是缺陷」）；toast state 加 `kind` 字段；触发器显示 `· {effortLabel}`（设计稿 htxWi，:209,246）；info 图标 `IconQuestionOutline14`。
- `client/catalog.ts`（12 diff 行）🟡：构造参数从 `ctx` 改为 `session: Pick<ClientRemote['session'],'modelCatalog'>`（窄化依赖，:25-26 注释）；service.ts 同步 2 行。
- `client/locales.ts`（2 diff 行）🟡：新增 `error.modelUnavailable` 键（zh+en）。
- `ModelSelect.module.css`（34 diff 行）🟡：触发器样式（triggerEffort 等）。
- `invariant.ts` 🟢 模板改名。

### 4.6 corum-ui-settings-models（对照 ui-settings-models）

相同 11 / 改名 0 / 实质 13 / 新增 0 / 删除 1。**rebase 风险：中**。

- **官方有但 corum 删除（1 个）**🔴：`client/operations.ts`（官方 109 行封装层 `createModelsOperations`/`ModelsOperations`）。corum 删掉它，14 处改为组件直持 Remote wire face（`ModelsWire{settings,credentials,llm}`）。package.json description 自称「其余与官方逐行一致」**不实**（审计 P1，应如实更新）。改造质量良好（补了官方没有的传输失败 try/catch——store.ts `messageOf` + 各处 catch，修官方「transport reject 成未处理 rejection」的真实缺口），但**官方若更新 operations.ts 或其调用方，corum 全部 14 处调用点要逐处对齐**。
- **实质修改（13 个）**：
  - `client/store.ts`（105 diff 行）🔴：`ModelsWire`/`ModelsCredentials`/`ModelsLlm` 类型定义内置（:24-87）、构造函数 `ctx` 改 `api: Pick<ModelsWire,...>`、加载链路加 try/catch + `messageOf`（:210-266）。
  - `client/ModelListEditor.tsx`（63 diff 行）🟡：`acceptsImage()` + **模型级「支持图片输入」开关**（:442-469，CORUM-PATCH 注释说清语义：勾选写 `input:['text','image']`、不勾删 `input` 键回退 route defaultInput/catalog——这是本包 fork 的**首要动机**，写进了 description）；`api.llm.discoverModels` 直调 + messageOf catch。⚠️ 裸 checkbox 无样式（审计 P1）。
  - `client/CustomProviderCard.tsx` / `ProviderEditor.tsx` / `ModelsSection.tsx` / `DeepSeekOnboardingDialog.tsx`（28/62/57/11 diff 行）🟡：`operations.*` → `api.{settings,credentials,llm}.*` 直调 + wire 结果（`response.ok/error.message`）替换官方 outcome 判别（`written.kind`）+ 传输失败 catch；JsonValue import 从 `dsh-util-values` 改 `dsh-api-remotes/client`。
  - `client/index.ts`（20 diff 行）🟡：删 `createModelsOperations` 调用，组装 `wire` 对象直传；不再 re-export operations 类型。
  - `client/locales.ts`（4 diff 行）🟡：新增 `modelImageInput`/`modelImageInputHint` 两键（zh+en）——图片开关文案，i18n 合规。
  - `client/welcome-store.ts`（4 diff 行）🟢：import 顺序/风格。
  - `onboarding-copy.ts`（14 diff 行）🟡：新增 `WELCOME_NOTICE_COPY`（⚠️ 死代码双事实源，审计 P1——若确认无引用应删）。
  - `index.ts`（4 diff 行）🟢：host 半注释（ui-onboarding 注册由 ide-shell 接管的说明）。
  - `invariant.ts` 🟢：模板改名（⚠️ exports 已删 `./invariant` 子路径但 invariant.ts 仍被打包成死代码，审计 P2）。

---

## 5. 升级 runbook（官方版本 bump 操作顺序）

> 场景：官方 dsh 从当前基线（0.1.2-alpha.2）升到新版本，需把 6 个 fork 逐文件合并。预估：零成本文件 103+26 个，人工合并约 20 个 🔴 文件。

### 第 0 步 · 前置对齐（不做这步后面全是错的）

1. 确认新官方版本号，更新 6 个 fork 包 `dependencies` 里的 `@deepseek-ai/*` 版本（当前锁 `^0.1.2-alpha.1`，源码对照 alpha.2——先消除 §3.4 错位）。
2. 把新官方源码 checkout 到对照路径（本文默认 `/Users/kukucai/dsh/packages/client/`，升级时换成新版路径），重跑 `diff -r` 刷新本台账统计。

### 第 1 步 · 机械合并（零人工判断）

3. **逐字节相同文件**（按 §1 各包「相同」列）：官方新版直接覆盖 corum 对应文件。
4. **仅 import 改名文件**（chat 25 个 + approval 1 个）：官方覆盖后执行机械替换：
   ```
   sed -i '' 's/@deepseek-ai\/dsh-client-ui-conversation/@corum\/corum-ui-conversation/g' <文件>
   ```
   注意连 `declare module '@deepseek-ai/dsh-client-ui-conversation/client'` 字符串一起换（chat/contract/snapshot.ts）。
5. **invariant.ts / 根 index.ts**：按 §3.6 模板处理；根 index.ts 向官方写法对齐（settingsNamespace 已内联）。

### 第 2 步 · 优先核对的「语义地雷」（合并实质文件前先查）

6. **错误码命名空间**（§3.5）：conversation `service.ts:318`、`input/hub.ts:204`、`InputBar.tsx:95-97`、`image-labels.ts`——若官方新版本继续演进错误码，corum 必须同步，否则附件/steer 错误处理静默失效。
7. **官方新增 locale 键**：对比官方各包 `locales.ts`，把 corum 缺失键补回 corum 词典（已知欠账：chat `message.turnTime.*` 4 键、conversation `access.preset.*` 3 键——后者是 corum 有意删的，补不补看 PermissionSelect 合并结论）。**不要整文件覆盖 corum locales.ts**（会丢掉 review.*/subagent.*/modelImageInput 等 corum 键）。
8. **官方删除/改名 corum 正在 type-only 消费的 contract 类型**：chat/approval/questions 的 26+2 处 import 依赖 conversation contract 的 6 个类型——官方 contract/conversation.ts 等若改这些类型签名，消费侧全部要动（这是契约辐射的正当成本）。

### 第 3 步 · 实质修改文件三方合并（按 🔴 优先级）

9. 高危清单（必冲突，逐处人工）：
   - **chat/ChatNodeSeat.tsx:153**（foldable=false）——**先完成 P0-12 整改再 rebase**，否则把死代码合并进新版。
   - **chat/corum-reskin.css**——**先完成 P0-13 整改**（收回各 module.css），否则全局选择器对新 DOM 误伤/失效。
   - **chat/MessageItem.tsx / MessageIconActions.tsx / TurnTailNodeView.tsx**——corum 删了官方 reveal/usageAction 机制，官方在这三文件的任何演进都要决定「跟官方机制」还是「维持 corum 重设计」。
   - **chat/apply.ts**（reviewSource + getAgentName 块）、**chat/ChatView.tsx**（ReviewCard/AgentNameContext 挂载点）。
   - **conversation/apply.ts**（emptyActions 119 行块 + uiWorkspace 降级）、**conversation/contract/slots.ts**（emptyActions 契约增量）。
   - **conversation/ConversationSession.tsx**（crumbs/lineage 整块删除）——官方 header 槽演进需确认 corum 是否仍全删。
   - **conversation/EmptyHero.tsx / ConversationRoot.tsx / InputBar.tsx / EmptyStateHero.tsx**——重设计文件，官方改动逐处看。
   - **approval/ApprovalPanel.tsx(+css)**——审批卡重设计 + lucide 依赖。
   - **settings-models/store.ts**（ModelsWire 直持改造）——**官方 operations.ts 若更新，14 个调用点全部重新对齐**。
10. 中低危（🟡 机械合并）：CSS 换肤文件保留 corum 变量值、locale 按第 2 步键级合并、model-selection 全包（errorKind 增量）、settings-models 的 api→operations 调用点。
11. **questions 整包**：不按文件合并。核对官方 `user-questions/request` waterfall 契约（Remote Event 形状、PendingQuestion 生命周期、ASK_CANCELLED/ASK_ABORTED 码）是否变动——变了改 `contract.ts` 同形复制与 `index.tsx` 应答逻辑；`QuestionCard.tsx` 渲染层独立演进。**特别核对官方 PlanReviewPanel 相关演进**（corum 缺失 plan-review 渲染）。
12. **corum 新增文件**（19 个）：不合并，但 grep 其 import 的官方 API 是否在官方新版变动（review-source 的 eventSource/connection RPC、subagent 的 contract 类型、EmptyStateHero 的 emptyActions）。
13. **官方有但 corum 删除文件**（11 个）：逐个确认删除理由仍成立（TurnUsagePanel→TurnUsageDisclosure 有意取代；QuestionComposer/PlanReviewPanel/draft-store→dock 重设计；operations.ts→直持 wire）。理由不成立就恢复官方文件。

### 第 4 步 · 验证

14. `pnpm -r typecheck`（6 个 fork 包 + 全仓）——重点看 contract 类型漂移与 locale 键缺失（`satisfies Record` 会编译器报 zh/en 不同构）。
15. `pnpm -r build`（含 tsdown + inline-css）。
16. 实机验证（corum-cdp-verify 技能）：会话骨架（空态操作卡新建任务/项目）、聊天渲染（工具调用展开、Review 卡撤销/保留、子 Agent 卡、Turn 用量）、审批卡（允许一次/拒绝）、提问卡（答题/跳过/放弃）、模型切换（含图片会话切纯文本模型的 info 提示）、模型设置页（图片输入开关读写 `input` 模态）。
17. 合并后刷新本台账：重跑 `diff -r` 更新 §1 统计与各包文件清单，把新引入的差异登记进 §4。

---

## 6. 「不做抽包」的实证记录（防反向优化）

**结论（A3 整改项，主 Agent round 2 实证，本次台账复核确认）：会话域 chat/approval/questions 对 conversation 的依赖是 type-only 契约消费，与官方逐行对齐，契约边界已成立，不抽独立 contract 包。**

- **事实**：§3.1 已列全量证据——26+2 处 import 全部 type-only、全部来自 conversation `contract/` 目录、与官方 ui-chat 对官方 ui-conversation 的消费逐行相同。
- **为何不该抽包**（A3 原文）：把官方就有的 contract 类型抽到独立包，会让 corum 文件布局偏离官方，rebase 官方时更痛（官方升级 contract/conversation.ts 需在两包间手动同步）。A1 已把依赖降为 type-only（dependencies→devDependencies），这正是官方做法，已足够。
- **历史背景**：审计 B 群曾把「chat→conversation 30+ 处非 type-only import + tsdown external + index.ts re-export」判为 P0-6 架构红线；A1/A3 整改后该红线已消除（tsdown external 移除、re-export 删除、import 全 type-only）。**任何后续 Agent 不要再提「抽 contract 包」或「解耦 chat→conversation」——那是反向优化。** 唯一残留的包内分层瑕疵是 chat/contract/slots.ts:129 inline import 本包渲染层（§3.1 末尾），如需处理那是包内整理，不是抽包。

---

## 附：本台账新发现的差异/风险（此前审计未覆盖）

1. **§3.5 错误码命名空间欠债**（conversation 4 处停在 alpha.1 裸码）——审计 B 群未单列；影响：Host 升 alpha.2 后附件错误友好文案与 steer 静默收敛失效。
2. **chat 未同步官方 `message.turnTime.*` 4 个 locale 键**——TurnUsage 重设计时键集换代未收官方新增，en/zh 均缺。
3. **questions 缺 plan-review 渲染器**——官方 PlanReviewPanel 整体删除后，corum PendingQuestion.kind 仍声明 'plan-review' 但无渲染路径；官方该能力演进 corum 无法获得（审计只记了「删文件」，未点出能力缺口）。
4. **chat/contract/slots.ts:129 contract 层 inline import 渲染层 review-source**——包内反向依赖，rebase 合并 slots.ts 时会被官方纯净 contract 文件掩盖，需单独记。
5. **settings-models invariant.ts 死文件仍打包 + exports 已删 ./invariant**（审计 P2 已记，台账复核确认仍存）；**onboarding-copy.ts WELCOME_NOTICE_COPY 死代码**（审计已记）。
6. 官方 ui-chat 的 `MessageItem` reveal/usageAction 机制与 `TurnUsagePanel/TurnTimePanel` 是 alpha.2 的演进方向，与 corum 的 TurnUsageDisclosure 重设计**方向相反**——这是 chat 包未来 rebase 最大的结构性冲突源（不只是行级冲突）。
