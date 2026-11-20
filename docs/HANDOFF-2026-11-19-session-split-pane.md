# 交接：Session 分栏基础设施（2026-11-19 场）

> **本文档是 session 分栏开发的唯一事实源。** 分栏用于「经验沉淀」时展示 AI 会话流 + 用户取舍决策。
> 沉淀功能（自动/手动提炼 + 完成通知）已并行开发完成（commit 846d9742），分栏是前置基础设施。

---

## §1 需求

经验沉淀时展示 AI 会话流，用户需要**决策和取舍**：
- **左栏**：会话回放 / 提炼候选列表
- **右栏**：操作区（确认/编辑/删除候选 → 写入记忆库）

分栏是通用基础设施，后续也可用于其他需要双栏对比的场景。

---

## §2 现状

- corum 当前**单栏布局**，无分栏机制
- 设置中心有 `openSettingsSection(id)` 可编程打开（corum-ide-ui/src/client/service.ts:582-586）
- 需要新建分栏基础设施

---

## §3 技术约束

| 约束 | 来源 |
|------|------|
| 跨 bundle 共享状态必须走 cordis 服务 | 红线 1 |
| 三平台覆盖（darwin/linux/win32） | 红线 7 |
| UI 包构建三步：tsc -b && tsdown && node scripts/inline-css.mjs | 红线 6 |
| 分栏比例持久化（localStorage 或 settings） | 产品决策 |

---

## §4 建议方案

### 4.1 包结构

新建 `packages/plugins/ui/corum-ui-split-pane`：
- 分栏容器组件（react-resizable-panels 或自研）
- 与 LayoutController 集成（扩展 `openSplitPane` 或复用现有机制）
- 比例持久化

### 4.2 组件 API

```typescript
interface SplitPaneProps {
  left: ReactNode      // 左栏内容
  right: ReactNode     // 右栏内容
  defaultRatio?: number  // 默认比例（0-1）
  onRatioChange?: (ratio: number) => void
  storageKey?: string   // localStorage 键
}
```

### 4.3 与沉淀功能的接口

沉淀完成后，通知点击 → 打开分栏：
- 左栏：会话回放（session/page 数据）或提炼候选列表
- 右栏：候选确认/编辑/删除操作区
- 用户确认后调 `putFact` 写入记忆库

---

## §5 验收标准

- [ ] 分栏可拖拽调整比例
- [ ] 左右栏独立滚动
- [ ] 比例持久化（刷新后恢复）
- [ ] 三平台无布局错位
- [ ] 与沉淀功能集成：通知点击 → 分栏打开 → 用户取舍 → 写入记忆

---

## §6 依赖

- **无**（独立基础设施，不阻塞沉淀功能开发）
- 沉淀功能已完成（commit 846d9742），等分栏就绪后接入用户取舍界面

---

## §7 一句话

分栏是「经验沉淀」的用户决策界面基础设施，开发完成后沉淀功能从「自动写入」升级为「用户可控写入」。

---

## §8 评审修正与实施记录（2026-11-19 实施场）

### a) 原文档五处修正

1. **「无分栏机制」半对** — §2 原文「corum 当前单栏布局，无分栏机制」。实际：网格槽 + Sash 拖拽基础设施（`corum-ide-ui` 的 grid 系统）已存在，缺的是**页面级双栏容器**（SplitPane 组件 + 壳槽）。已补建。

2. **`openSettingsSection` 不可照抄** — §2 原文引用 `openSettingsSection(id)` 作为打开模式范例。实际该方法是**同 bundle CustomEvent**（corum-ide-ui 内部），跨 bundle 打开分栏**不能照抄**。实际实施照 `openPluginManager` 的 **pending 认领模式**：调用方在 LayoutController 注册 pending 槽 → 目标 bundle 启动时认领 → 且必须**改壳加槽**（在 desktop 壳的 grid 里新增 `corum.splitpane` 槽位）。

3. **「用户确认后 putFact」与原自动写入现状矛盾** — §4.3 原文「用户确认后调 `putFact` 写入记忆库」。实际：原沉淀功能是**自动写入**（`writeFacts` 直接调 `memory.putFact`），与「用户确认后写入」矛盾。已改**候选暂存**模式：auto/manual 沉淀都**不再自动写入**，而是产出候选（pending）落盘到 `<home>/distill-jobs/` → 用户经 `distillCommit`（确认写入）/ `distillDiscard`（丢弃）取舍。原 `writeFacts` 函数改造后已无调用方，已作为死代码删除。

4. **验收漏了阻断前置** — §5 原文验收标准缺两条关键前置：
   - `resolveDistill` 未接线：sidebar 需在通知点击时调 `resolveDistill` 取候选数据再打开分栏，原方案漏了这步。已补接线（sidebar `resolveDistill` + notification-bridge `openSplitPane`）。
   - job 纯内存易失：原方案 job 存内存 Map，进程重启即丢。已补落盘（`<home>/distill-jobs/<jobId>.json`，`persistJob` + `loadJobFromDisk`）。

5. **「无依赖」不成立** — §6 原文「无依赖（独立基础设施）」。实际分栏功能依赖：host 候选态（`memory-distill.ts` 的候选暂存 + 落盘）+ 通知桥（`notification-bridge` 跳分栏 `openSplitPane`）+ `distillReplay` 新端点（回放会话原文供用户判断）。非独立基础设施。

### b) 实施形态

| 组件 | 位置 | 说明 |
|------|------|------|
| 新包 `@corum/corum-ui-split-pane` | `packages/plugins/ui/corum-ui-split-pane` | 通用 SplitPane 组件（clamp 0.2–0.8 防极端比例 + localStorage `corum.splitpane.<key>` 持久化 + `splitPaneContent` 内容注册服务）+ DistillReviewView（沉淀取舍视图） |
| 壳槽 `corum.splitpane` | `corum-ide-ui` grid | 新网格槽，LayoutController 五 API（`openSplitPane` / `closeSplitPane` / `setSplitPaneContent` / `getSplitPaneState` / `onSplitPaneChange`） |
| 4 新 RPC | `corum-agent` `memory-distill.ts` | `distillCommit`（确认写入）/ `distillDiscard`（丢弃）/ `distillReplay`（回放原文）/ `distillListPending`（从磁盘恢复待确认任务） |
| 通知/侧栏接线 | `corum-ide-sidebar-ui` + notification-bridge | sidebar `resolveDistill` 取候选 + notification-bridge `openSplitPane` 跳分栏 |

### c) 验证结果

| 守卫/测试 | 命令 | 结果 |
|-----------|------|------|
| pnpm install | `pnpm install` | ✅ exit 0，workspace 链接正常（63 projects，already up to date） |
| 构建 corum-ui-base | `pnpm --filter @corum/corum-ui-base run build` | ✅ exit 0（tsc -b + tsdown + inline-css + copy-client-css） |
| 构建 corum-ide-ui | `pnpm --filter @corum/corum-ide-ui run build` | ✅ exit 0 |
| 构建 corum-ui-split-pane | `pnpm --filter @corum/corum-ui-split-pane run build` | ✅ exit 0（**修复**：tsdown.config.ts 缺 `entry: 'src/client/index.tsx'`，默认按 `.ts` 找入口报 UNRESOLVED_ENTRY） |
| 构建 corum-ide-sidebar-ui | `pnpm --filter @corum/corum-ide-sidebar-ui run build` | ✅ exit 0 |
| 构建 corum-agent | `pnpm --filter @corum/corum-agent run build` | ✅ exit 0 |
| 构建 corum-desktop | `pnpm --filter corum-desktop run build` | ✅ exit 0（build:lib + bundle，client bundle 重打） |
| 插件规范守卫 | `node scripts/verify-plugin-spec.mjs` | ✅ exit 0，error 0 / warn 0（**修复**：`@corum/corum-memory` 的 `./memory-tool` 子路径漏进 SUBPATH_DICTIONARY——既存漏登，补登记） |
| 强制全量 typecheck | `node scripts/run-forced-typecheck.mjs` | ✅ exit 0，56/56 PASS，0 semantic errors，0 TS5033 |
| corum-agent 测试 | `pnpm --filter @corum/corum-agent run test` | ✅ exit 0，42 files / 638 tests passed（含新增 `tests/memory-distill.spec.ts` 20 tests）。stderr 有 1 条非阻断 warn（`persistJob` 在 test teardown 后异步落盘到 `~/.corum/distill-jobs/` 时目录不存在——`mkdir({recursive:true})` 本应创建，属 test 时序边界，不影响测试通过） |
| 重构守卫 | `./scripts/verify-refactor-guard.sh` | ✅ exit 0，41/41 全部通过（**修复 2 项既存漏登**：① `interruptChildSessions` 漏进 RPC_NAMES_FROZEN + RPC_NAMES_ADDED；② `this.conductor` 预算 6 < 实测 7——均在基线 34aa2738 已存在，补登记） |
| fork-drift 守卫 | `DSH_CHECKOUT=~/dsh DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 ./scripts/verify-fork-drift.sh` | ⚠️ exit 1，30 项失败——**全部既存**（基线 34aa2738 同样 30 项，逐一相同），与本次分栏工作无关。新包 `@corum/corum-ui-split-pane` 无新增 drift。 |
| writeFacts 死代码清理 | grep 全仓 + 删除 | ✅ `writeFacts`（原 memory-distill.ts:406）候选态改造后无调用方，已删除函数 + 更新 2 处引用注释 |
| verify 实例重启 | `./scripts/corum-instance.sh restart --home=verify` | ✅ PID 26950，CDP :9333，`curl /json/version` 返回 Chrome/150.0.7871.224。主实例 :9222（PID 69286）未触碰 |

### d) 三平台说明

- SplitPane 组件纯**鼠标数学**（pointer 事件 + `clamp(ratio, 0.2, 0.8)`）+ CSS flexbox，**无平台分叉代码**。
- `memory-distill.ts` 的落盘用 `node:path` join + `node:fs/promises` 读写，三平台无隐式路径假设。
- **darwin**：实机验证（verify 实例 :9333 启动 + CDP 探活通过）。
- **linux / win32**：未实机验证。风险点：SplitPane 的 pointer 事件在 Electron/Chromium 下三平台一致（Chromium 统一输入栈），CSS flexbox 同理。`distillJobsDir()` 用 `corumHome()` + `join()` 解析，无硬编码分隔符。

### e) BUG-1 修复：distill* RPC 形参绑定（2026-11-19 复验轮）

**现象**：右键会话→「提炼经验」→ console error `[SessionsPane] distill session failed: {}`，分栏不打开。

**根因**：typert 网关按 `@Remote` 方法的**形参名**做命名绑定。corum-agent 的 distill* 方法形参都是 `input`（如 `distillStart(input: { sessionId: string })`），所以 wire 必须是 `{ args: { input: { sessionId } } }`。但两处 UI 调用发的是扁平 `{ args: { sessionId } }` ⇒ 网关报 `gateway/arguments-invalid: unexpected "sessionId"`。

**修法**：只改调用侧（host 不动），两处 UI 包加 `{ input: {...} }`：
- `corum-ide-sidebar-ui/src/client/index.ts:342`：`resolveDistill` 里 `distillStart` 调用改为 `{ input: { sessionId: String(sessionId) } satisfies DistillStartArgs }`。
- `corum-ui-split-pane/src/client/DistillReviewView.tsx`：`distillStatus`/`distillReplay`/`distillCommit`/`distillDiscard` 四个带参 RPC 一律包 `{ input: {...} }`；`distillListPending` 无形参保持 `{}`。

**教训（形参名绑定）**：typert 网关不是按字段名「猜」匹配的——它严格按 TS 方法签名里的**形参名**做 wire 绑定。`@Remote` 方法 `foo(input: { x: string })` 的 wire 必须是 `{ args: { input: { x } } }`，发 `{ args: { x } }` 会被拒。**正确先例**：`corum-memory` MemoryLibrary.tsx:144 `call('memory','listFacts',{ input: filter })`、MemoryAgentList.tsx:70 `{ input: {} }`——都是按形参名包。distill* 的 bug 是新增代码没照先例包。`makeCorumRpcCall` 的 `{ args }` 封装本身**正确**——它只是把调用方传入的 args 对象原样放进 `{ args }`，问题在调用方传的 args 对象形状不对（漏了 `input` 层）。**不要在 `makeCorumRpcCall` 层做自动包装**——因为不同方法的形参名不同（`createTaskAgent` 的形参是 `cwd` 等，`{ args: { cwd } }` 正确），无法自动判断哪些方法需要 `input` 包装。定点改调用侧是正确做法。

**复验**：详见 `docs/verify/split-pane-2026-11-19/REPORT.md`「复验轮」——上轮 FAIL/UNVERIFIED 的 7 项全部 ✅ PASS。

### f) BUG-2 修复：通知链路双重断裂（2026-11-20 终验轮）

**现象**：verify 实例（:9333）上经验沉淀完成后通知 toast 从不出现——`.corum-notification-root` 恒空，无 toast、无分栏打开。

**根因（双重断裂）**：

1. **host 插件 lib 陈旧**（根因一）：commit 846d9742 在 `corum-api-remotes/src/remote-events.ts:100` 加入了 `{ event: 'corum/distill/completed', mode: 'emit' }` 到 host 事件转发 allowlist，但**没有重建 `corum-api-remotes` 的 lib 产物**。dev host 从 workspace `lib/index.js` 加载插件 ⇒ 事件转发 allowlist 不含 `corum/distill/completed` ⇒ host 收到 `corum-agent` 的 emit 但不转发给 renderer ⇒ notification-bridge 的 `remote.$on('corum/distill/completed')` 永不触发 ⇒ 无 toast。

   修法：`pnpm --filter @corum/corum-api-remotes run build`（tsc -b + tsdown）。构建后 `lib/index.js:241` 含 `event: "corum/distill/completed"`。重启 verify 实例生效。

2. **通知桥 layout 服务未注入**（根因二）：即使事件转发修好、toast 出现了，**toast 不可点击**（`data-action` 未设、`onOpen` 为 undefined）。根因在 `packages/desktop/src/client/index.ts:130`：`ctx.inject(['remote', 'sessions', 'notifications'], ...)` 没有包含 `'layout'`，而 `notification-bridge.ts:319` 内部用 `ctx.get('layout')` 取 layout 服务（用于 `openSplitPane` 跳转经验取舍分栏）。`layout` 不在 inject 声明里 ⇒ `ctx.get('layout')` 返回 undefined ⇒ `onOpen` 回传 undefined ⇒ toast 无 `data-action`、点击无反应。

   修法：inject 数组加 `'layout'`——`ctx.inject(['remote', 'sessions', 'notifications', 'layout'], ...)`。同文件 editor 的 inject（line 169）已含 `'layout'`，是正确先例。修后 toast 带 `data-action`、点击触发 `layout.openSplitPane({ key: 'distill-review', title: '经验取舍', ... })` 打开分栏。

**教训**：
- **allowlist / 事件登记类改动必须重建对应 host 插件 lib，「src 改了」≠「运行时生效」**。dsh dev host 从 workspace `lib/` 加载插件（非 `src/`），`tsc -b && tsdown` 产物是运行时唯一事实源。commit 改了 src 但没跑 build = 改了个寂寞。**验证方法**：改完 src 后 `grep <新登记的事件名> lib/index.js`，命中才算生效。
- **验收通知链路要端到端守 toast 而非只看代码**。本轮先用 monkey-patch `store.notify()` 确认 bridge 收到事件（排除「事件没转发」），再用 `document.querySelector('[role="status"][data-tone]')` 轮询 toast DOM（toast 经 `createPortal(..., document.body)` 渲染、**不在** `.corum-notification-root` 内），最后 click toast 断言分栏打开——三层逐进定位了双重断裂。
- **`ctx.get('layout')` 在 inject 未声明 `'layout'` 时返回 undefined**（红线 4 的变体）：inject 声明是 cordis 服务解析的前置条件，`ctx.get` 不会自动装配未声明的服务。跨 bundle 能力面（layout 的 `openSplitPane`）必须在 inject 数组里声明才能在运行时解析。

---

## §9 重设计记录（用户纠正 — 2026-11-20 二期）

### a) 用户裁定

分栏 = **两个与当前 session 一模一样的完整会话视图**（双入口：头部按钮同会话只读 + 侧栏右键异会话），记忆归档 = **右列独立槽 `corum.distill`** 由会话流「经验沉淀完成」**durable 卡片**唤起。

用户纠正了原 §1–§4 的设计方向：
- 原 §1–§4 把分栏设计为「经验沉淀取舍的专用双栏容器」（左=会话回放/候选列表，右=操作区）。用户裁定分栏是**通用双会话视图**——两个完整会话并排，各自有 composer、各自可交互，而非沉淀专用。
- 记忆归档从原设计的「右栏操作区」改为**独立的右列网格槽 `corum.distill`**，不占用分栏的右栏，而是与分栏并列的第三列。归档由会话流中的 durable 卡片（`corum/distill-completed` session event → `corum-ui-distill-card` 渲染）唤起。

### b) 实施形态

| 组件 | 位置 | 说明 |
|------|------|------|
| `EmbeddedConversation` | `corum-ui-chat`（经 `conversationEmbed` 服务） | 完整会话视图嵌入分栏左/右栏，使用 `useMainSessionId` 跟踪主会话 |
| scope 组件 | 经 `uiRenderer` 服务（红线 1：cordis 服务携带组件闭包） | 分栏内容经 cordis 服务渲染，不走 window 全局 |
| host 补 `session.append('corum/distill-completed')` | `corum-agent` | distill 完成时向会话流追加 durable event |
| 新包 `corum-ui-distill-card` | `packages/plugins/ui/corum-ui-distill-card` | 「经验沉淀完成」durable 卡片，渲染 `corum/distill-completed` event |
| splitpane 改挂 conversation 中心叶 | `corum-ide-ui` grid | `corum.splitpane` 槽从原 DistillReviewView 改为 EmbeddedConversation 双会话 |
| `layout.openDistillArchive` | `corum-ide-ui` LayoutController | 归档面板打开 API（替代原 `openSplitPane`），在 `corum.distill` 独立槽渲染 |
| 会话行右键「在右侧分栏打开」 | `corum-ide-sidebar-ui` | 侧栏右键菜单新增项，调 `layout.openSplitPane` 打开异会话分栏 |
| `SessionScopeOverride` | `corum-ui-chat` | 取 `sessions.retain` 的 reference 走官方 bindingSource（非手工 binding） |

### c) 本场三个阻断 bug 教训

**BUG-3（运行时跨 bundle import 致 duplicate factory）**：
- **现象**：分栏打开后 React 报 duplicate factory registration 白屏。
- **根因**：分栏组件运行时跨 bundle `import` 了 `@corum/*` 包，dsh inline 机制导致同一组件被两个 bundle 各实例化一份 → duplicate React factory。
- **正解**：cordis 服务携带组件闭包（`conversationEmbed` / `uiRenderer` 服务 provide 组件，consumer inject 后渲染），不跨 bundle import 组件源码。`shimMissingExports` 全局 hack 已回滚（commit 14158f45）。
- **教训**：红线 1（跨 bundle 共享状态必须 cordis service）的扩展——不只是**状态**，**组件闭包**也必须经 cordis 服务传递，否则 dsh inline 机制会制造 duplicate factory。

**BUG-4（SessionScopeOverride 手工 binding 缺 `.session`）**：
- **现象**：分栏右栏会话 scope 解析失败，内容不渲染。
- **根因**：`SessionScopeOverride` 用手工 binding 传 session id 字符串，但官方 bindingSource 期望 session **reference** 对象（含 `.session` 属性）。
- **正解**：`sessions.retain(sessionId)` 返回 reference，走官方 bindingSource（commit 721abf90）。
- **教训**：不要手工拼 binding——用 `sessions.retain()` 取 reference 走官方 bindingSource，否则 scope 解析会因缺字段静默失败。

**（一期 BUG-1 形参名绑定 / BUG-2 陈旧 lib+layout 未 inject 见 §8）**：BUG-1（typert 网关按形参名 `input` 绑定，UI 调用需 `{ input: {...} }` 封装）和 BUG-2a/b（corum-api-remotes lib 陈旧不含 `distill/completed` 事件 + notification-bridge inject 缺 `layout`）详见 §8 e/f，此处不重复。

### d) 验证结果（如实记，含未验项）

详见 `docs/verify/split-pane-2026-11-19/REPORT.md`「二期验收轮」——V1–V8 全部 ✅ PASS，零新增 console error，清理完成。

| 项 | 结论 | 关键证据 |
|----|------|----------|
| V1 异会话分栏 | ✅ PASS | 左=B(52714406) 右=A(7e914c2e)，双 composer 可交互，无只读提示 |
| V2 左栏跟随 | ✅ PASS | 点会话C → 左变C 右仍A |
| V3 拖拽+持久化 | ✅ PASS | clamp 0.2–0.8 验证（0.7994/0.2006），localStorage 写入，reload 后比例恢复 |
| V4 沉淀→卡片→归档 | ✅ PASS | distillStart→25候选→卡片(NEgO4q_card)→归档右列(corum.distill x=909) |
| V5 卡片持久 | ✅ PASS | reload 后卡片仍在，点击「查看归档」重开归档面板 |
| V6 归档取舍链 | ✅ PASS | commit 3条(written=3)→listFacts核实编辑值→幂等(written=0)→discard 22条→关面板 |
| V7 通知点击 | ✅ PASS | MutationObserver 守 toast→14s出现「提炼出18条经验」→click→归档打开(x=909 w=818) |
| V8 console零错误 | ✅ PASS | 0 条新增 console.error |

**未验项**：
- 「二次确认」discard：经 RPC 直调 `distillDiscard` 验证取舍链正确性，UI 层的二次确认对话框未单独测（RPC 层不做二次确认，是前端交互保护）。
- 归档面板 reload 后 width=0：CSS transition 时序问题，内容已完整渲染，不影响功能。

### e) 三平台

- **darwin**：实机验证（verify 实例 :9333，V1–V8 全部 PASS）。
- **linux**：未验。SplitPane 纯鼠标数学（pointer 事件 + clamp）+ CSS flexbox，Chromium 统一输入栈，三平台风险低。
- **win32**：未验。同上。

---

## §10 三期：分栏基础设施的两个用途（2026-11-20 最终验收轮）

### a) 用户裁定

三期是分栏基础设施从「经验沉淀专用」扩展到「两个通用用途」的收口场。用户裁定三条：

1. **chat 持久 + 咨询分节**：corum-chat- 会话是持久化轻对话（无工具卡、无编排、无沉淀），与 task 会话隔离。用户可在分栏左栏做 task、右栏开 chat 咨询，两栏各自独立 composer 可交互。
2. **子会话点击直接分栏只读**：编排卡 worker 分支或侧栏 nested 子会话行点击 → 右栏 mode='view' 只读（无 composer、迷你头子会话标题、左栏主会话不被顶替、进度区存在）。子会话是「查看」不是「操作」。
3. **咨询 persona 英文 + 只读双保险 zero-tool + permission**：咨询用 persona 走英文提示词，子会话只读是双保险（zero-tool 卡片 + permission 护栏），确保咨询/查看不产生副作用。

### b) 实施形态

| 用途 | 实施形态 | 验证状态 |
|------|----------|----------|
| chat 持久 + 咨询分节 | `baseMode: 'chat'` profile 创建 corum-chat- 会话；chat 泳道过滤（task/chat 不混）；distill scope='none' 跳过自动沉淀（chat 不产沉淀） | ✅ chat 零工具卡（E PASS） |
| 选区浮条咨询 | `SelectionAskPill` 仅排除右栏（左栏 prose 拖选 → 「询问 AI」浮条 → 点击 → 右栏 chat 草稿含「关于以下会话片段：」+ 引用文本，复用已有 chat 不新建） | ❌ UNVERIFIED（CDP 拖选选不中文本） |
| 子会话分栏只读 | mode='view'（无 composer、只读提示）；迷你头子会话标题；左栏主会话不被顶替；进度区本地重写；四处子会话入口（编排卡 worker 分支 / 侧栏 nested 子行 / 分栏头部 / 归档面板） | ❌ UNVERIFIED（无 nested 子会话可用） |

### c) 卡片架构适配裁决

**问题**：二期「durable 自定义事件卡片锚点」架构（`corum/distill-completed` session event → `corum-ui-distill-card` 渲染会话流内卡片）实机不渲染。

**根因**：官方 dsh 架构拒绝外部事件名注册——
- `known-event-types.ts` 注释明确拒绝外部事件名注册（只有官方白名单内的事件进 surface 流）
- `surface.ts:306` ignorable 事件不进 surface（自定义事件名被标记为 ignorable → 不进会话流渲染管线）
- ⇒ durable 自定义锚点（在会话流内注册一个自定义事件类型让卡片渲染）**架构上不可行**

**裁决**：卡片改 **host 状态投影 + 会话 dock 区**：
- 卡片不再锚定 durable 会话事件，改为 `conversation.input.dock` 槽位（输入框正上方，与 model-ask/questions/todo 同槽位）
- 数据来源：挂载时 RPC `corumAgent/distillListPending`（wire `{}`）按当前会话 sessionId 过滤 pending 候选 → 有候选时渲染卡片
- 实时：`remote.$on('corum/distill/completed')` 按 sessionId 过滤重查 + 10s 轮询
- 点击「查看归档」→ `layout.openDistillArchive({jobId, sessionId})`（能力探测）
- **移除**：`session.append('corum/distill-completed')` 的 durable 事件追加 + 旧 `ConversationNodeDefinition` 注册 + assembler 相关代码 + `ChatNodeDataMap` 声明（commit 74004c3c）

**迁移保留修旧日志**：二期 durable 事件卡片的代码迁移到 dock 卡片时，**保留了修旧日志**（`corum/distill-completed` event 声明仍在 corum-api-remotes 的 remote-events allowlist 里，不删——通知桥仍 $on 这个事件做 toast；只是不再 append 到会话流）。

### d) ignorable 回归与帧结构修复教训

**ignorable 回归**：迁移重写日志时，`corum/distill/completed` 事件从「durable session event + surface 渲染」改为「host emit + notification-bridge $on + dock 卡片 RPC 查询」。迁移过程中确保：
- `corum-api-remotes` 的 remote-events allowlist 仍含 `corum/distill/completed`（emit 转发允许）
- `notification-bridge` 仍 `$on('corum/distill/completed')`（toast 渲染）
- dock 卡片用 `distillListPending` RPC 查询（不依赖 event payload）

**帧结构修复教训**：迁移重写日志（从 durable event 到 dock 卡片）**必须保留帧边界 + trailing newline 语义**：
- dock 卡片的 `DistillDock` 组件在 `useEffect` 里装 `remote.$on` + `setInterval`，卸载时清订阅/定时器——帧边界（mount/unmount）语义不能丢
- `persistJob` 落盘的 JSON 用 `JSON.stringify(record, null, 2)` —— trailing newline 语义（文件末尾无 newline）在 `loadJobFromDisk` 的 `JSON.parse(raw)` 里不影响解析，但 `listAllJobsFromDisk` 的 `file.slice(0, -5)` 去 `.json` 后缀时**假设文件名以 .json 结尾**——如果迁移时改了文件名格式（如加 `.json.gz`），slice 逻辑会错。**先备份再迁移**。

### e) 验证结果（如实记，含未验项）

详见 `docs/verify/split-pane-2026-11-19/REPORT.md`「三期最终验收轮」。

| 项 | 结论 | 关键证据 |
|----|------|----------|
| A dock 卡片 | ⚠️ PARTIAL | 卡片出现✓ / 查看归档禁用(BUG-5 layout 未 inject) / reload 持久✓ / discard→消失✓ |
| B 选区浮条 | ❌ UNVERIFIED | CDP drag selection.toString()=空（合成 mouse 不触发原生选择） |
| C 子会话分栏 | ❌ UNVERIFIED | 无 nested 子会话入口可用 |
| D 通知链路 | ❌ UNVERIFIED | emit lossless 错误复现（sessionId=undefined → payload 含 undefined → isJsonValue 失败） |
| E chat 隔离 | ✅ PASS | corum-chat- 零工具卡 |
| F console 零错误 | ✅ PASS | 0 条新增 console.error |

### f) 发现的 Bug

- **BUG-5（阻断级）**：dock 卡片 `inject` 缺 `'layout'` → `ctx.get('layout')` 返回 undefined → 「查看归档」按钮 disabled。与 BUG-2b（notification-bridge 缺 layout，二期已修）同构。修法：inject 加 `'layout'`。
- **BUG-6**：`distillStatus` 对磁盘 job 返回 null vs `distillListPending` 返回同一 job（不一致，部分是 payload 形态错误，内存/磁盘缓存同步需排查）。
- **emit lossless**：`emitDistillCompleted` 在 sessionId 为 undefined 时不防御 → emit payload `{ sessionId: undefined }` → `assertJsonArgs` 的 `isJsonValue` 校验失败 → distill 标 error。根因线索：`corum-api-remotes/src/index.ts:186` `assertJsonArgs` + `@deepseek-ai/dsh-util-values` 的 `isJsonValue`。建议：emit 前校验 sessionId 非空（fail-fast）。

### g) 未尽

1. **BUG-5 未修**：dock 卡片 inject 缺 `'layout'`（定点修法已给出）。
2. **BUG-6 待排查**：distillStatus/distillListPending 不一致性。
3. **emit lossless 待查若复现**：sessionId=undefined 时 emit 防御。
4. **B/C UNVERIFIED**：选区浮条需真实用户操作验证；子会话分栏需有 nested 子会话的会话验证。
5. **linux/win32 未验**。
6. **打包态未验**。
7. **task-model-routing 预存稳定失败**：corum-task-7e914c2e 会话的 task model routing 预存状态不稳定（worker 上轮见过 `forwarded host event ... not lossless JSON data`，本轮在 distill 链路复现同一错误模式）。
