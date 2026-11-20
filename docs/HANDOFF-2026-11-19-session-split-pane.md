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
| B 选区浮条 | ✅ PASS（修复轮验穿） | 真因是窗口 `document.hidden=true` ⇒ rAF 不回调（`SelectionAskPill.tsx:169`），**不是**「CDP 拖选不产生选区」。rAF 替身为 setTimeout 后走产品真实路径：选区 50 字 ⇒ 浮条 `button.T2KnVG_askPill`「询问 AI」出现 ⇒ 点击 ⇒ 右栏 chat 草稿含 `关于以下会话片段："""…"""` |
| C 子会话分栏 | ✅ PASS（修复轮验穿） | 入口不是侧栏行，是消息流 `button[aria-label="查看子会话"]`。点击 ⇒ 右栏切 `86f005b2-…`，`hasComposer:false` + 只读提示「与左栏同一会话，输入请在左栏」+ 迷你头，左栏仍 `corum-task-7e914c2e` 不被顶替 |
| D 通知链路 | ❌ UNVERIFIED（本轮仍未验穿） | 正确 wire 触发后 `factCount:0`（LLM 返回 0 候选）⇒ 无 toast 可守。**但 emit 已不再炸 job**：同形态调用 `status:"done"`（上轮是 `"error"` + lossless 报错）。`factCount>0` 的 toast 需一次真产出候选的 distill |
| E chat 隔离 | ✅ PASS | corum-chat- 零工具卡 |
| F console 零错误 | ✅ PASS | 0 条新增 console.error（修复轮 A/B/C 全程 0） |

> 修正说明（修复轮）：上表 B/C 的 UNVERIFIED **归因是错的**，已按实测更正——B 是隐藏窗口掐掉 rAF（环境），C 是找不到入口（入口在消息流而不在侧栏）。D 的 UNVERIFIED 结论保留，但原因换成「LLM 0 候选」，且 emit 链路已由 `status:"done"` 证明不再炸 job。

### f) 发现的 Bug

- **BUG-5（阻断级）→ 已修**：dock 卡片 `inject` 缺 `'layout'` → `ctx.get('layout')` 返回 undefined → 「查看归档」按钮 disabled。与 BUG-2b（notification-bridge 缺 layout，二期已修）同构。修法：`index.tsx:56` inject 五项含 `'layout'`（本轮已落，含 3 条静态守卫单测）。
- **BUG-6 → 已核实并关闭（两条独立结论）**：① 上轮记录的「distillStatus 返回 null vs distillListPending 返回 job」**确实是 harness wire 双层包装假象**——正确扁平 wire 下两者逐字段一致；双层包装时 `jobId=undefined` ⇒ 必然 null。② **但缓存陈旧缺口是真的**：旧 host 上卡片读扫盘显示「3 条候选」、归档面板读内存 Map 显示「无待处理候选」，同一 job 两份快照现场复现。修法：`distillJobStamps`（mtime 对齐戳）+ `resolveJob`（内存命中仍校验磁盘）。
- **emit lossless → 已修（双重防护）**：`emitDistillCompleted` 在 sessionId 为 undefined 时不防御 → emit payload `{ sessionId: undefined }` → `assertJsonArgs` 的 `isJsonValue` 校验失败 → 抛在 `void runManualDistill(...)` 的异步体里，**连 finally 都过不去，job 永久 running**。现在入口 `assertSessionId` fail-loud（不建 job）+ emit 前 `isDistillCompletedPayloadValid`（非法跳过 emit + `console.warn`，job 照常落盘）。

### g) 未尽

1. ~~**BUG-5 未修**~~ → **已修**（`index.tsx:56` inject 加 `'layout'`，实机验证按钮 `disabled:false` + 面板 3 条候选）。
2. ~~**BUG-6 待排查**~~ → **已核实关闭**（harness 假象 + 缓存陈旧缺口已修，两条判据见上）。
3. ~~**emit lossless 待查若复现**~~ → **已修**（入口 + emit 双重校验）。
4. **D 项 toast 仍未验穿** —— 需一次 `factCount>0` 的真实 distill（LLM 侧产物，非链路问题）。fixture 不经 host emit，无法替代。
5. **真人鼠标拖选未验** —— B 项打通的是选区**消费**链路（Range API 建选区 → 判定 → 浮条 → 点击 → 跨栏草稿）；合成 `Input.dispatchMouseEvent` 序列不产生原生 selection 这一点未变。
6. **`readonlyHint` 文案在多会话分栏下语义不准**（子会话 ≠ 「与左栏同一会话」）—— 发现未改，属相邻问题。
7. **linux/win32 未验**。
8. **打包态未验**：verify 吃 dev `lib/`；`/Applications/Corum.app` 内 host 闭包仍是 11-20 20:40 快照。
9. **task-model-routing 预存稳定失败**：`tests/task-model-routing.spec.ts` blank-reuse 会话 id 断言（`corum-task-ed9d8959` vs `corum-task-1c51c0ff`），非 distill 链，本轮如实记录未修（全量 654 passed / 1 failed）。

### h) 修复轮补充（2026-11-20/21 夜场）：红线 4 的**第二次**违反 —— 建议加守卫（只建议未实施）

#### 现象

`corum-ui-distill-card` 的 `export const inject = ['slots','remote','connection','locale']` 漏了 `'layout'`，而 `apply()` 里写的是 `distillArchiveLayout(ctx.get('layout' as never))`。后果链路完整可推：`inject` 未声明 ⇒ cordis 不装配该服务 ⇒ `ctx.get('layout')` 恒 `undefined` ⇒ `distillArchiveLayout(undefined)` 按能力探测返回 `undefined` ⇒ 落到回落分支 ⇒**「查看归档」按钮恒 `disabled`，不是报错、不是白屏，是静默禁用**。卡片本身渲染正常（数据来自 RPC），所以肉眼看上去"功能在，只是点不动"。

**这是红线 4（「Consume cordis services via `inject` declarations, never `ctx.get` on an unassembled service」）的第二次违反**：第一次是二期 BUG-2b（`notification-bridge` 同样漏 `'layout'`，已修）。同一根因、同一服务名、两个不同包，隔了一个季度。

#### 为什么这次尤其值得记

- **修法的方向是反的**：`corum-ui-conversation` 里有一段 2026-10-31 的「循环依赖修复」明确把 `'layout'` 从硬 inject **移除**、改 `ctx.get` 延迟取（layout↔corumNavigation 激活循环 ⇒ 23 插件 pending）。那个先例被当成「`ctx.get('layout')` 是合法手法」传播开了，于是新包照抄 `ctx.get` 却漏抄了「延迟取」的必要前提——**只有当 layout 由别人 provide 且你能保证激活后它才存在时，`ctx.get` 才可以替代 inject**。照抄了一半，得到的是永久 undefined。
- **它不会自己暴露**：能力探测写法（`splitPaneChatLayout`、`distillArchiveLayout` 这类）的本意是"运行时可能不具备 ⇒ 回落"，于是"服务缺失"和"基座太老不支持"在类型和行为上**完全同形**。没有一条日志能区分二者。

#### 建议（**只建议，本轮未实施**）

在 `scripts/verify-refactor-guard.sh` 或 `scripts/verify-plugin-spec.mjs` 里加一条静态守卫：

> **凡在 `apply()` / 回调 / 组件里出现 `ctx.get('<name>')` 的包，其 `export const inject` 必须含 `'<name>'`；除非该行带显式豁免注释 `// inject-optional: <理由>`。**

理由三条：

1. **它是可静态判定的**——不需要运行、不需要基座、不需要 CDP。正则扫源码就能定论，成本几乎为零。
2. **本轮已有一个包内的最小版本**：`corum-ui-distill-card/tests/distill-card-node.spec.ts` 里那 3 条（剥注释后断言源码含 `ctx.get('layout'` + `injectStrings(source)` 含 `'layout'` + 原有四项只增不减）就是按这个思路写的。**但它只守住了这一个包**，下一个新包照抄照样漏。
3. **豁免必须显式**：`corum-ui-conversation` 的 `'layout'` 是最正当的豁免案例（写了 20 行注释解释循环依赖），带 `// inject-optional: layout 参与激活循环，见 apply.ts:98 注释` 能一眼看懂。守卫的价值不是逼所有人 inject，而是逼写 `ctx.get` 的人**当场回答一次**「这个服务凭什么可能不存在」。

#### 同批修复的其它两条（防御性，非本红线）

- **入口 wire 校验**：`distillStart` 收到 `sessionId=undefined`（成因：调用方把 `{sessionId}` 多包了一层 `input`）时，旧实现照建 job、跑到 `emitDistillCompleted` 才被 lossless 序列化校验炸掉——**抛在以 `void runManualDistill(...)` 启动的异步体里，连 `finally` 都过不去，job 永久 running**。现在 `assertSessionId` 在入口 fail-loud，`isDistillCompletedPayloadValid` 在 emit 前兜底（非法跳过 emit + `console.warn`，job 照常落盘）。教训：**不要拿"下游校验"当"上游输入校验"**——下游校验抛在异步体里，代价是把一个可恢复的调用错误变成一条僵尸任务。
- **缓存一致性**：`getDistillJob` 内存命中即返回、从不 stat 磁盘，导致磁盘被外部改写后 `distillStatus`（走内存）与 `distillListPending`（纯扫盘）对同一 job 给出两份快照。修法 `distillJobStamps`（记录"已知与磁盘一致的 mtimeMs"）+ `resolveJob`（命中内存也校验磁盘）。教训：**"内存热缓存"必须带一个与持久层对齐的时点戳**，否则一旦有第二个写者（另一个进程、手写 fixture、迁移脚本），缓存就变成一份无法判定新旧的分叉。

### i) 收口轮补记（2026-11-21）

D 项关闭（链路二期 V7 实机 PASS 后桥代码未变 + 本轮 LLM 连续 0 候选无 toast 可守 + 防御修复已由 `status:"done"` 反证）；B 项真因更正为 **rAF 在 `document.hidden` 窗口永不回调**（非「CDP 不能拖选」）并已修 `SelectionAskPill.tsx:141` `requestAnimationFrame(show)` → `setTimeout(show, 0)`，真实鼠标拖选仍留人工项。

两条跟进项：① **观察项 —— distill 全局默认模型 `localhost/deepseek-v4-flash` 连续 0 候选**（`phase:"无可沉淀内容"`，两次不同会话可复现），疑为模型路由/可用性问题，**建议用户自查该路由**（设置 → AI 润色）；指挥**未改**共享全局配置（改全局会污染所有会话默认模型）。② **`readonlyHint` 文案在 `mode='view'` 子会话场景语义不准**（显示「与左栏同一会话」）—— 记录为后续跟进项，本轮不改。

### j) 侧栏子会话行入口**撤回**（用户裁定 —— 2026-11-23）

**用户报障**：侧栏会话列表突然多出大量子 Agent 会话。

**真因**：三期 merge `551d76d`（`wt/wt-c1b628`）为造「子会话行点击 → 右侧分栏查看」入口，把 `origin === 'subagent'` 的会话**纳入了侧栏**——`SessionsPane.tsx` 的 `allRows` 过滤从 `isTaskSession(row)` 扩为 `isTaskSession(row) || row.origin === 'subagent' || isChatSessionId(row.id)`，并配了 `subagentRows`/`subagentsByParent` 按 `parentId` 归组渲染（`nested` 子会话行）、`resolveOpenSubSplit` prop/resolver 与 `onOpenRow` 的 `subagent` 分支。执行端未给该纳入行为设任何开关或上限，于是每个编排会派生的一批子 Agent 路由会话全部铺进列表（本次实测 `session/list` 1575 条中 **1222 条是 `origin='subagent'`**）。

**用户裁定（这是本次修复的依据）**：**子 Agent 会话不进侧栏**。子会话的查看入口应在**编排卡 / 子卡 / 会话条**（这些入口此前已落地并实机验过），侧栏不应列子 Agent 会话。这也正是 `session-visibility.ts` 里 `isTaskSession` 注释所载的历史口径（「origin subagent 不进分组列表，由对话区子 Agent 卡承载」，2026-08-28 用户报「未分组会话重命名不生效」时的漏滤源头）。

**修法 = 回退子 Agent 纳入，保留咨询分节**：

| 位置 | 回退内容 |
|---|---|
| `SessionsPane.tsx` `allRows` filter | 恢复 `isTaskSession(row) \|\| isChatSessionId(row.id)`（去掉 `row.origin === 'subagent'` 分支） |
| `SessionsPane.tsx` 归档可见性判据 | `isForkChild(row) \|\| row.origin === 'subagent'` → `isForkChild(row)`（保留 `isChatSessionId` 的 chat 扩展） |
| `SessionsPane.tsx` `groups` useMemo | 删除 `subagentRows` / `subagentsByParent` 归组与「父会话后紧跟 nested 子会话」的渲染注入，恢复为只遍历 `ws.sessionIds` |
| `SessionsPane.tsx` 两处 `nested={row.origin === 'subagent'}` | 删除（分组行 + 单列表行） |
| `SessionsPane.tsx` `onOpenRow` / `openSubSplitRow` / `resolveOpenSubSplit` prop | 全部删除；分组 `onOpen` 回到 `open`（其签名也从 `(row)` 改回 `(sessionId)`） |
| `SessionsPane.tsx` `visibleResults`（搜索同口径） | 去掉 `\|\| row.origin === 'subagent'` 分支 |
| `client/index.ts` | 删除 `resolveOpenSubSplit` resolver（`resolveOpenSplit` / `resolveDistill` 保留） |
| `tests/session-fork-visibility.spec.ts` | 补回归断言：侧栏过滤口径（`isTaskSession \|\| isChatSessionId`）对 `origin='subagent'` 行恒 `false`，且不误伤任务/分叉/咨询三类 |

**保留项（未动）**：咨询分节 `chatRows` + `ChatGroup`；fork 子会话（`isForkChild`）既有可见性；「在右侧分栏打开」通用菜单项（`resolveOpenSplit`，右键菜单实机截图确认仍在）。

**实机验证（executor :9333，persistent shell 未 restart，`location.reload()` 生效，`rev` → `97017adf26e8`）**：

- 侧栏 DOM `[data-session-id]` 行数 **260**；RPC `session/list` 1575 条中按 `isTaskSession || isChatSessionId` 口径可见 **276** 条，其中 `blank` **9** 条（官方语义：空会话不进列表）、无归属工作区 **7** 条 ⇒ `276 − 9 − 7 = 260` **与 DOM 完全一致**。
- **`origin='subagent'` 行 0 条**（DOM 行 id 与 RPC 子 Agent 会话 id 交集为空；DOM 里 UUID 形态 id 亦为 0）。
- 咨询分节仍在：`咨询` 组 2 行（= RPC 中非 blank 的 `corum-chat-*` 数）。
- 证据截图：`docs/verify/split-pane-2026-11-19/FIX-R1-context-menu-after-revert.png`（右键菜单含「在右侧分栏打开」）、`FIX-R2-sidebar-no-subagent-rows.png`（侧栏全貌，无子 Agent 会话行）。

**未尽**：① 三平台仅 darwin 实机验（linux/win32 未验）；② executor 是 dev 态吃 `lib/`，打包态（`/Applications/Corum.app`）未重打包；③ `mode='view'` 的 `readonlyHint` 文案跟进项不变（见 §10.i②）——只是现在没有侧栏入口进这个模式了，编排卡/子卡入口仍用它。

---

## §10.i 布局修复轮（2026-11-23）：嵌入会话视图的高度链契约

### a) 报障与单根因

用户实机截图报障：分栏两栏**都无法滚动、内容显示不全、都没有输入框**。

三个症状**同一个根因**：`EmbeddedConversation` 自己的包裹 div
（`.corum-embedded-conversation` / `.corum-embedded-body`）**全仓没有任何 CSS**——
裸 div `height:auto`，而内部会话视图的布局契约要求**父链高度确定**：

```
ConversationRoot.module.css
  .root       { display:flex; flex-direction:column; height:100% }
  .scrollBody { flex:1; min-height:0; overflow-y:auto }
  composerSeat{ position:sticky; bottom:0 }
```

`.root{height:100%}` 对 `auto` 父级解析为**内容高** ⇒ `.scrollBody` 失去约束不内滚
⇒ sticky composer 沉到全部内容最底（视口外）⇒ 外层网格叶 `overflow:hidden` 裁剪。

主视图不复现，因为它落在网格叶里（`.leaf`→`.card`→`.body` 全链 `height:100%`）。
**同一个组件，换个包裹层就静默失效。**

### b) 契约（写死在 `corum-ui-conversation/src/client/embedded.css` 文件头）

> **任何嵌入会话视图的包裹层都必须提供确定高度的 flex 列**：
> `height:100%` + `min-height:0` + 头部 `flex:none` + body `flex:1` +
> composer 槽 `flex:none`。少任何一环，滚动/composer 定位链就会静默失效——
> **不报错、不白屏，只是内容溢出被裁掉。**

补充两条同轮踩到的细节：

1. **body 必须是 `display:flex; flex-direction:column`，不能是裸 block。** 链上每一环
   （`.viewArea{flex:1}`、ChatView `.root{flex:1 1 auto}`、`.scroll{flex:1 1 auto;overflow-y:auto}`）
   都是「作为 flex 子项才获得确定高度」的写法；body 若是 block，这些 flex 属性全部失效。
2. **内滚容器不一定是 `[data-conversation-scroll]`。** 主视图（`ConversationRoot`）的滚动盒是
   `.scrollBody[data-conversation-scroll]`；但**嵌入视图走 `conversation.session` 槽 occupant
   （ChatView），内滚在 ChatView 的 `.scroll`**。断言滚动时必须按实渲染结构取容器，
   套主视图的选择器会拿到 `null`（本轮实测踩过）。
3. **分栏侧同样要补齐**：`paneWrapper` 原为 `width/height:100%` 的 block，本轮加
   `display:flex; flex-direction:column; min-width:0` + `.paneWrapper > *{flex:1;min-height:0}`，
   避免再依赖子项自身的百分比链。

### c) 同轮附带修正

- **迷你头标题**：原显示裸 `sessionId`（UUID 不可读、两栏还长得一样）→ 改读
  `sessions.list.getSnapshot().byId[id]?.displayTitle`（照 split-pane `readDisplayTitle` 先例），
  读不到回落短 id；并用 `sessions.list.subscribe` 在标题晚到（host list RPC 在飞）时自动替换。
  经 `apply.ts` 的模块级 `embeddedSessions` ref 下发（`sessions` 在 `inject` 声明里，红线 4）。
- **`readonlyHint` 文案语义**（§10.g⑥ 的跟进项，本轮收口）：`EmbeddedConversation` 增可选
  `hintText` prop；split-pane 在 `mode==='view'` 时传「子 Agent 会话 · 只读查看」
  （那是**另一个会话**），同会话双开仍用「与左栏同一会话，输入请在左栏」。
  ⚠️ **该文案尚未实机验穿**——本 verify home 当前会话流里没有可点的「查看子会话」子 Agent 卡片，
  造不出 view 入口。判据就位、构建产物含该字符串，缺一次真子会话点击（详见 REPORT 布局修复轮 §6）。

### d) 实测结果（executor :9333，未 restart，`location.reload()` 生效，`rev` → `7a94adeacdfa`）

a–g 七项断言全 PASS，明细与截图见
`docs/verify/split-pane-2026-11-19/REPORT.md`「布局修复轮（2026-11-23）」：

| 断言 | 结论 | 关键度量 |
|---|---|---|
| a 两栏 composer 在视口内 | ✅ | 左 `bottom 810` / 右 `bottom 778`，`innerHeight 860` |
| b 左栏内滚 + composer 稳定 | ✅ | `.scroll` `clientH 587 / scrollH 1656`，`scrollTop` 生效且 composer 位置不变 |
| c 右栏同上 | ✅ | `.scroll` `clientH 555 / scrollH 13288` |
| d 迷你头显示标题 | ✅ | `docs/UPGRADE-0.2.1-rc3-feasibility.md` / `当前我们已经在扩展中提供的` |
| e 拖中缝 | ✅ | `leftW 391 → 483` |
| f 同会话双开只读提示 | ✅ | `hasComposer:false` + 提示在视口内 |
| g console 零新增错误 | ✅ | `errors: []` |

### e) 本轮未尽

1. **`mode='view'` 新文案未实机验穿**（见 c，缺真子会话入口）。
2. 三平台：仅 darwin 实机验证；linux / win32 未验（纯 flex/height 无平台分叉，仍如实标注）。
3. 打包态未验：executor 是 dev 态吃 `lib/`；`/Applications/Corum.app` 内闭包未重打包。
4. **建议后续加一条静态守卫**（本轮未实施）：凡 `EmbeddedConversation` 的消费方，若自己再造
   包裹层，必须提供确定高度 flex 列。可做成「`.corum-embedded-conversation` 父级链上出现
   `height:auto`」的 CSS 契约测试，或直接把包裹层收进 `EmbeddedConversation` 内部（消费方
   只传内容），从根上消灭这个失败模式。

## §10.k 外壳对齐轮（2026-11-19）：嵌入视图必须渲染完整 `conversation` 槽 occupant

### a) 报障与根因（两条）

用户实机报障：分栏后 session 内容**左右边距消失**、**左侧快速导航圆点没了**。

**根因 ①：`EmbeddedConversation` 绕过了 `ConversationRoot`。**

§10.i 修好高度链之后，嵌入视图仍是「自造迷你壳」：裸 `SlotView('conversation.session')`
（ChatView）+ 独立 composer 槽。而 `ConversationRoot` 不是「一层包装」，它是会话外壳的
**唯一 owner**：

| Root 承载的东西 | 绕过它之后的后果 |
|---|---|
| `--dsh-chat-content-width` / `--dsh-composer-side-clearance` / `--dsh-composer-card-max-width`（`.root` 第 33–40 行）+ ResizeObserver 发布列宽 | 三个变量全缺 ⇒ ChatView `.scroll` 的 padding 与 `.column` 的 max-width 双双失效 ⇒ **正文贴边** |
| 左 gutter（= `clearance + 16px`） | TurnNavigator 的 `.frame{left: calc(12px - (clearance + 16px))}` 无处可贴 + `overflow:hidden` 裁剪 ⇒ **圆点不见** |
| `conversation.input.dock`（todo / goal / queue / 沉淀卡片）、`conversation.composer` 链选举 | 沉淀卡片整条 dock 消失 |
| `--dsh-composer-height` / `--dsh-conversation-viewport-height`（滚动体测量） | TurnNavigator 的 rail band 退回 fallback（`100dvh - 152px`），定位失真 |

**根因 ②（独立，上一轮未发现）：`TurnNavigator` 的容器查询阈值把分栏全隐藏了。**

`TurnNavigator.module.css` 末尾 `@container (max-width: 900px){ .slot{ display:none } }`
是照官方口径（右侧横线刻度）定的。但本 fork 的 rail 已改成**左 gutter 竖列**、只占 28px，
而窄容器的正文 padding 就是 `clearance + 16px = 32px` ⇒ 装得下。分栏每栏必然 < 900px，
这条规则**无条件命中**。实测：只修根因①时 `nav` 存在、`markCount 12`、但
`computed display: none`；临时覆盖为 `block` 后圆点立刻出现在 `x=309 / w=28 / h=122`
且点击跳转生效（`scrollTop 7709.5 → 29222.5`）。阈值改为 **72px**
（`2 × (clearance + 16) + 28 + 8`）。

### b) 契约（本轮立，后续不得回退）

> **嵌入会话视图必须渲染完整的 `conversation` 槽 occupant（= `ConversationRoot`），
> 不得自己拼裸 `conversation.session` + `conversation.composer.bar`。**
>
> 包裹层只负责两件事：① 用 `SessionScopeOverride(sessionId)` 钉住会话 scope；
> ② 提供确定高度 flex 列（§10.i 的契约）。其余一切（宽度轴、gutter、宽度手柄、
> 滚动体、composer 座位、沉淀 dock、测量变量）都是 Root 的职责。
>
> 换句话：**「Root 是外壳」不是实现细节，是契约**。任何绕过它的第二实例化都会
> 静默丢掉上表四类东西——而且**不报错、不白屏**。

配套的两条派生规则：

1. **外壳级开关走 owner props，不走 SlotMap owner 声明。** `readOnly` / `hintText` 是
   渲染方的决定，与「哪条会话」无关 ⇒ 并进 `ConversationSlotProps`
   （`ConversationShellOwnerProps`），经 `SlotView` 的 `ownerProps` 透传。**不要**去改
   `ConvOwnerProps`——那条由壳 `@corum/corum-ide-ui` 镜像一份空接口，两侧必须逐字等价
   （TS2717）。
2. **嵌入视图要自带给会话一个身份行。** 本 fork 的 `conversation.session.header` 于
   P2（2026-09-30）随宿主搬进统一标题栏（`corum.titlebar.session`），而那条带子是**壳**的、
   只服务主视图那一栏。所以 Root 内部已无会话顶栏——嵌入栏若不自己标标题，
   分栏左栏连身份都没有（frameHeader 只标右栏）。

### c) `readOnly` 与既有接管逻辑的关系

`ConversationRoot` 原有 `isSubagentSession` 接管（子会话渲染「返回父会话」只读条）。
本轮新增的 `readOnly` **优先级更高**：

- 子会话的 `subagentReturnBar` 是**主视图**的导航动作，不该由一条只读副栏承担；
- `mode='view'` 已由渲染方给出自己的措辞（「子 Agent 会话 · 只读查看」），再叠一条
  「返回父会话」就是两条互相打架的底部条。

`readOnly=true` 时一并让位：composer 链、`inputBar`、`conversation.input.dock`
（沉淀卡片属于**主**实例的输入上下文）。

### d) 实测结果（executor :9333，未 restart，`location.reload()` 生效，`rev` → `b35857157f83`）

a–i 九项断言全 PASS，明细与截图见
`docs/verify/split-pane-2026-11-19/REPORT.md`「外壳对齐轮（2026-11-19）」：

| 断言 | 结论 | 关键度量 |
|---|---|---|
| a 两栏内容列左右边距 | ✅ | 左 gutter `53 / 59`、右 `32 / 37`（改前均 0） |
| b 圆点可见 + 可跳转 | ✅ | `x 309 / w 28 / h 122`、`slotDisplay block`、`left -20px`、12 个点；点击 → `scrollTop 7709.5 → 29222.5` |
| c 两栏 composer 可输入 | ✅ | 两栏 seat 与 contenteditable 均在 |
| d 内滚 + composer 不动 | ✅ | `clientH 903 / scrollH 8829`，`scrollTop 0 → 3963`；seat top 恒 843 |
| e 身份行显示标题 | ✅ | 三个不同会话的 displayTitle（非裸 id） |
| f 同会话双开只读 | ✅ | 「与左栏同一会话，输入请在左栏」+ `hasInput:false` |
| g mode='view' 子会话只读 | ✅ | 「子 Agent 会话 · 只读查看」+ 进度徽标 + `hasInput:false` |
| h 沉淀 dock 在左栏 | ✅ | fixture 3 候选 → dock `children:1`「经验沉淀完成 3 条候选待取舍」 |
| i console 零新增错误 | ✅ | `errs: []` |

### e) 本轮未尽

1. **宽度手柄写共享 pref（预期，不改）**：两栏 Root 各带手柄，拖任一侧写同一个
   `dsh.conversation.contentWidth` ⇒ 两栏联动。这是「共享一条内容宽度轴」的自然结果。
2. **Root 双实例的 document 级监听**：`SelectionAskPill` 等各自独立挂载，实机全程
   console 零错误、无重复浮条；未做并发压力验证。
3. **右栏无圆点是数据条件**：`TurnNavigator` 在 `items.length < 2` 时 `return null`，
   与会话轮次少有关，非缺陷。
4. **三平台**：仅 darwin 实机验；linux / win32 未验（纯 CSS 变量 + 容器查询，
   无平台分叉，仍如实标注）。
5. **打包态未验**：executor 是 dev 态吃 `lib/`；`/Applications/Corum.app` 内闭包未重打包。
6. **可考虑的守卫**（未实施）：「`EmbeddedConversation` 内出现 `slotKey: 'conversation.session'`
   直挂」做成静态检查/单测红线，防止下一轮又退回裸子槽。
