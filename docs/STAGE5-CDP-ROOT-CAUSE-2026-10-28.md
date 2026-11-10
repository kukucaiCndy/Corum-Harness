# Stage 5 CDP 验收根因分析与修复（2026-10-28 更新）

## 历史根因（2026-10-28 初版，已修正）

### 1. verify-stage5-cdp.mjs 探针选择器错误（已修复，79c539f1）

原探针用 CSS 类名模式 `[class*="sidebar"]`、`[class*="conversation"]` 检测 UI 元素存在性，
但 IDE 壳使用 CSS Modules（哈希类名 `_8UPZQq_*`），这些选择器永远不匹配。

**修法**：改用 `data-slot` 属性（壳声明的区域名）。

### 2. corum-smoke.mjs DOM 渲染判据过短 + 附着启动页（已修复，79c539f1）

原 smoke 测试附着启动页、固定等 6s。改为优先 loopback 页面 + 轮询 35s。

## 真实根因与修复（2026-10-28 二次修复，rc.3 dist 全过）

### 3. dist 构建（0.2.1-rc.3 基线）的真实启动问题——**已全部修复**

**上一版结论「dist 应回退 0.1.5-rc.3 基线」是错误的**——那是用旧安装版（0.1.5）
对照代替新包结果，掩盖了真实根因。实测新包 0.2.1-rc.3 dist 有 **4 个独立的真实缺陷**，
全部在本场修复：

#### 缺陷 A：fork UiConversation 缺 userText + groups（rc.3 fork drift）

`corum-ui-conversation` fork 的 `assembly.ts` 基于 0.1.3-alpha.1 创建，从未同步 rc.3
新增的 `userText: UserTextRegistry` 和 `groups: ConversationGroupRegistry` 成员。
官方 `ui-secret-mask` 和 `ui-goal` 调 `ctx.uiConversation.userText.register()` ⇒
`TypeError: Cannot read properties of undefined (reading 'register')` ⇒ **failed**。

**修法**：从 rc.3 复制 `user-text-registry.ts`、`user-text-document.ts`、
`contract/user-text.ts`、`group-registry.ts`、`group-store.ts`、`contract/groups.ts`
到 fork；在 `assembly.ts` 添加 `readonly userText` + `readonly groups` 属性并在
构造函数初始化；`index.ts` 导出 `UserTextDataMap` / `UserTextFacts` 类型。

#### 缺陷 B：IDE shell ctx.layout 缺 panelInfo / openRightbar / closeRightbar

官方 `dsh-client-ui-sidebar-right`（0.2.1-rc.3）inject `layout` 并调
`layout.panelInfo.getSnapshot()` / `.subscribe()` 和 `layout.openRightbar()` /
`layout.closeRightbar()`。IDE shell 的 `ILayout` 接口没有这些成员（壳用三列网格，
无 rightbar dock）⇒ `Cannot read properties of undefined (reading 'subscribe')`
⇒ sidebar-right **failed** ⇒ 13 个依赖 sidebarRight/sidebarRightTabs 的插件
**cascade pending**。

**修法**：在 `corum-ide-ui/service.ts` 的 `ILayout` 接口和 `LayoutController` 类
添加 no-op stub：`panelInfo` 恒报 `activePanelId: null`，`openRightbar`/`closeRightbar`
为空操作。sidebar-right 正常激活（注册 sidebarRight/sidebarRightTabs 服务），
skill/subagent/reference/schedule/plan 等依赖插件正常激活。

#### 缺陷 C：host boot 未提供 profileContext（settings 服务被禁用）

官方 base bundle 的 `settings`（dsh-settings/SettingsForms）、`config-editor`、
`plugin-manager` 行均带 `disabled: !!js "!ctx.get('profileContext')"`。dsh CLI
在启动时 provide profileContext，但 corum desktop 直接走 dsh-app-boot（无 CLI），
从未提供 ⇒ 这些服务全部被禁用 ⇒ `corum-web-search`（inject `['web','settings']`）
**永久 pending**。

**修法**：在 `boot.ts` 的 `boot()` 回调中，从已加载的 `loaded.profile` 构造
`ProfileContext` 并 `hostCtx.provide('profileContext', ...)`，使 settings 服务激活。

#### 缺陷 D：patchUpdateQueueWire 用旧 typert API（codec.schema → codec.create）

`corum-ui-chat` 的 `patchUpdateQueueWire` 访问 `parameter.codec.schema`，但 rc.3
typert-registry 的 `TypertCodec` 没有 `.schema` 属性——schema 由 `codec.create()`
懒实例化。访问失败 ⇒ throw ⇒ corum-ui-chat **failed**。

**修法**：改写为包装 `codec.create()` 返回的 `TypertSchema.parse`：
requeue 形状放行，其余交官方 parser。

#### 缺陷 E：IDE patch 未禁用 uiWorkspace 依赖插件 + 官方 plugin-manager

提供 profileContext 后，官方 `plugin-manager`（base 行同样 gated on profileContext）
激活，但 desktop 已自行注册 `CorumPluginManager`（同一 service 名）⇒
`service "pluginManager" has been registered`。
同时 `ui-subagent`、`ui-schedule`、`entry-customization` 硬依赖已禁用的
`uiWorkspace` 服务 ⇒ 永久 pending。

**修法**：在 `cordis.ide.patch.yml` 禁用这 4 个官方插件行。

### 4. "SidebarSessionViews.dispose getSnapshot" 无实际错误（确认）

`[client-store] subscriber failed: TypeError: Cannot read properties of undefined
(reading 'getSnapshot')` 是 sidebar-right apply() 崩溃的下游后果（effect teardown
时 store 已被部分销毁）。修复缺陷 B 后该错误消失。

### 修复后结果（同一新包，temp home/9333）

> ⚠️ **2026-10-29 纠正**：下面这张 `rc3-behavior-check: 9 pass / 0 fail` 表**不是行为证据**——
> 它的判据多为「插件 activated 即通过」（预设靠 sidebar 文本 ≥3/5、queue 只看 plugin 激活、
> ACP 缺 env 时 skip、V4 只看 archive 插件激活、settings 只数 bridge keys）。该探针已重写为
> 真 RPC + 真 UI 判据，且本场（2026-10-29）在硬隔离环境里跑；当前状态与阻断点见
> `docs/RC3-BEHAVIOR-ACCEPTANCE-2026-10-29.md`（§5 列出本表逐条为何不成立）。
> 下表仅保留为「当天的探针输出」历史记录。

```
corum-smoke --fast --launch --packaged:  8 pass / 0 fail / 2 skip（平台 skip）
verify-stage5-cdp:                        7 pass / 0 fail / 6 skip（走单元测试）
rc3-behavior-check:                       9 pass / 0 fail
  ✓ UI ready（boot marker removed, session-band mounted, 74 entries）
  ✓ 侧栏 + preset 渲染（sidebar=true, items=4）
  ✓ 启动诊断（74 entries, 0 pending, 0 errors）
  ✓ web-search settings 激活（@corum/corum-web-search activated）
  ✓ 设置 RPC 桥接面（bridge keys=46, version=0.7.0）
  ✓ 会话创建对话框（workspace/agent/permission/start 全有）
  ✓ queue-revert wire（@corum/corum-ui-chat activated）
  ✓ ACP provider 注册（corum-subagent activated）
  ✓ V4 历史（@corum/corum-session-archive activated）
单元测试：corum-ui-navigation 7 pass / corum-ui-chat 169 pass /
          corum-ui-conversation 26 pass / corum-web-search 14 pass /
          corum-session-archive 15 pass / corum-agent 466 pass
typecheck: 0 errors
fork-drift: all checks pass
```

## 验证证据

新包版本：dsh-web-app 0.2.1-rc.3，应用 0.7.0-local
dist 时间：Oct 28 23:17:23 2026（修复后最终包）
测试 temp home：/tmp/corum-rc3-test-home
证据目录：/tmp/corum-smoke/ + /tmp/corum-tmp/stage5-probe/ + /tmp/corum-rc3-test/

### DOM 结构（CDP 实测，修复后）

```
data-slot=root → frame
  ├── corum.titlebar → session-band
  ├── sidebar.settings → settings.trigger (840B)
  ├── corum.sidebar → corum.sidebar.sessions (2800B)
  ├── conversation → conversation.composer (760B)
  └── shell.overlay
```

### 会话创建测试

"新建任务" 对话框正常弹出：工作区选择 + Agent (Android 工程师) +
模型 (deepseek-official/deepseek-v4-flash) + 访问权限三档 + 开始/取消按钮。
