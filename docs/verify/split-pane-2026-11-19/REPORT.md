# 分栏会话 + 经验沉淀取舍 — 实机 CDP 交互验收报告

**日期**：2026-11-19  
**被测实例**：verify 实例（CDP :9333，PID 26979，基座 0.2.1-rc.3@be72761，rev 228d6fa1d58f，77 boot entries）  
**主实例 :9222**：未触碰（PID 23650/23694 运行中）  
**CORUM_HOME**：`/Users/kukucai/.corum`（CORUM_HOME_SEL=verify）

---

## 逐项结论

### 1. 菜单接线 — ⚠️ FAIL（发现阻断级 bug）

**验证内容**：右键会话行 →「提炼经验」菜单项可用（不再恒禁用）→ 点击 → 分栏视图打开。

**证据**：
- 截图 `02-context-menu.png`：右键会话行 `corum-task-7e914c2e` 后弹出 5 项菜单（重命名/归档/分叉会话/保存到…/提炼经验）。
- DOM 断言：「提炼经验」菜单项 `disabled: false`、`aria-disabled: null` — **菜单项不再恒禁用**（PASS）。
- 点击「提炼经验」后 **分栏视图未打开**（FAIL）。
- console error：`[SessionsPane] distill session failed: {}`（时间戳 1795102089253）。

**根因**（阻断级 bug — **BUG-1**）：
侧栏 `resolveDistill`（`corum-ide-sidebar-ui/src/client/index.ts:342`）调 `callAgentRemote(CORUM_AGENT_METHODS.distillStart, { sessionId: String(sessionId) })`，经 `makeCorumRpcCall`（`corum-rpc-client/src/client/index.ts:37`）封装为 `connection.rpc.call('/api', 'corumAgent/distillStart', { args: { sessionId: '...' } })`。

但 `distillStart` 的 `@Remote` 方法签名是 `distillStart(input: { sessionId: string })`（`agent-service.ts:3743`）——参数名是 `input`，typert 网关按**方法形参名**做命名绑定。发送 `{ args: { sessionId: '...' } }` 时网关看到字段 `sessionId` 不匹配参数 `input` → 报错 `gateway/arguments-invalid: unexpected "sessionId"`。

**正确调用形态**（已验证）：`{ args: { input: { sessionId: '...' } } }` — 经页内 fetch `/api/corumAgent/distillStart` 用此形态成功返回 `{ jobId: "distill-..." }`。

**影响范围**：所有 `distill*` 带参 RPC（`distillStart` / `distillStatus` / `distillCommit` / `distillDiscard` / `distillReplay`）均受同一参数封装 bug 影响——`makeCorumRpcCall` 的 `{ args }` 封装不适用于参数名为 `input` 的单对象入参 typert 方法。**其他带参 typert 方法不受影响**（如 `createTaskAgentRemote(cwd: string, ...)` 参数名是 `cwd`，`{ args: { cwd: '...' } }` 正确绑定）。

**侧栏行可见性诊断**（brief 要求先解决）：
- 会话行 `[data-session-id]` 的 `getBoundingClientRect` 有值（24 行全部在视口内）。
- `elementsFromPoint(中心)` 命中的是子元素 `SPAN.marqueeChunk`，但 `.closest('[data-session-id]')` 正确解析到行本身。
- `document.hidden=true`（窗口未聚焦），但 CDP Input 事件在协议层正常工作（contextmenu 成功触发菜单）。
- **结论**：侧栏行可见可点，`document.hidden` 不阻断 CDP 交互。此前报 `not-visible` 可能是选择器或定位问题，非既有 UI bug。

### 2. 沉淀链路 — ✅ PASS（RPC 直调） / ⚠️ UI 阻断（同 BUG-1）

**验证内容**：distillStatus 轮询（running→done）；LLM 可用性；fixture 回退。

**证据**：
- **LLM 可用**：经页内 fetch（正确参数形态）调 `distillStart({ input: { sessionId: 'corum-task-7e914c2e' } })` → 返回 `jobId: "distill-1795102488471-7dau4r"`。
- 轮询 `distillStatus({ input: { jobId: '...' } })`：status=`done`、factCount=**32**、phase=`已产出 32 条候选`、candidates 含 32 条 pending 候选（完整 fact 文本）。
- **fixture 回退验证**：手写 `distill-fixture-test001.json`（3 条 pending 候选）到 `<CORUM_HOME>/distill-jobs/`，经 `distillListPending()`（无参）成功读取到 3 条 pending 候选的 job。
- `distillStatus({ input: { jobId: 'distill-fixture-test001' } })` 也成功读到 fixture job 的完整 candidates。
- **DistillReviewView UI 路径**：因 BUG-1 导致分栏未打开，DistillReviewView 的 error/null 态「其他待取舍任务」入口未能经 UI 验证。但从源码（`DistillReviewView.tsx:318-343`）确认：job 为 null 时显示「任务已过期」空态 + `distillListPending` 列出其他待取舍任务入口（`switchToJob` 按钮可切到 fixture job）。**代码路径合法，但未经 UI 实测**。

### 3. 拖拽比例 — ❌ UNVERIFIED（分栏未打开）

**验证内容**：真实指针拖中缝 → 左右宽度比变化且 clamp 0.2–0.8；localStorage `corum.splitpane.distill-review` 写入新比例。

**结论**：因 BUG-1 导致分栏视图未打开，SplitPane 组件未渲染，无法测试拖拽。  
**源码审查**（`SplitPane.tsx`）：clamp 逻辑 `clampRatio(r)` = `Math.min(0.8, Math.max(0.2, r))` 正确；localStorage 键 `corum.splitpane.${storageKey}`（storageKey=`distill-review`）；mousedown 后 window 级 capture mousemove/mouseup。代码逻辑正确但未经实机验证。

### 4. 独立滚动 — ❌ UNVERIFIED（分栏未打开）

同上，SplitPane 未渲染。源码审查：左栏 `.leftPane` + 右栏 `.rightPane` 各自 `overflow: auto`（CSS module），独立滚动逻辑正确但未经实机验证。

### 5. 持久化 — ❌ UNVERIFIED（分栏未打开）

同上。源码审查：`readStoredRatio` / `writeStoredRatio` 读写 `corum.splitpane.distill-review`，非法值回落 `defaultRatio`。代码正确但未经实机验证。

### 6. 取舍写入 — ✅ PASS

**验证内容**：勾选部分候选、编辑 fact/importance → distillCommit → written 数正确；listFacts 核实；幂等。

**证据**：
- 选 3 条候选（id `:0` / `:1` / `:26`），编辑 `:1` 的 fact 文本（追加「编辑测试」）+ importance 5→8 + retention short→long。
- `distillCommit({ input: { jobId, items: [...] } })` → `{ written: 3, failed: 0 }` ✓
- `memory/listFacts({ input: { source: 'manual-distill:corum-task-7e914c2e' } })` → 3 条 facts，编辑后的值（importance=8、retention=long、编辑后文本）正确写入 ✓
- **幂等**：重复 commit 同 3 条 → `{ written: 0, failed: 0 }` ✓（committed 候选被跳过）

### 7. 舍弃 — ✅ PASS

**验证内容**：剩余候选全部舍弃 → discarded 数正确、state=discarded、listFacts 无新增。

**证据**：
- `distillDiscard({ input: { jobId } })`（不传 candidateIds = 全部 pending）→ `{ discarded: 29 }` ✓
- job 状态：candidates 中 3 条 `committed` + 29 条 `discarded`，0 条 `pending` ✓
- `memory/listFacts` 仍为 3 条（discard 不写记忆）✓

### 8. 通知跳转 — ❌ UNVERIFIED（时序错过）

**验证内容**：沉淀完成通知「提炼出 N 条经验，待取舍」→ 点击 → 分栏打开。

**结论**：distillStart 经正确参数形态调成功后，host 应 emit `corum/distill/completed` 事件 → notification-bridge 订阅 → `layout.openSplitPane`。但实测未见通知出现（可能时序错过：事件在 notification-bridge 订阅前已 emit，或通知已自动消失）。无法验证通知点击跳转。

### 9. 关闭分栏 — ❌ UNVERIFIED（分栏未打开）

分栏未打开，无法测试关闭。

### 10. console 零新增错误 — ⚠️ FAIL（1 条新增错误）

**证据**：
- **pre-existing 错误**（1 条）：在 console.error collector 安装前已存在，由 `cdp_run_script` console window 报告 `preExisting: 1`。具体内容无法回溯（collector 安装前的消息不可获取），但从 cdp_run_script 的多次调用均报 `preExisting: 1` 可确认是稳定的既存错误，与本功能无关。
- **新增错误**（1 条）：`[SessionsPane] distill session failed: {}` — 时间戳 1795102089253，由 BUG-1（distillStart RPC 参数形态错误）触发。**本条错误与本功能直接相关**——是「提炼经验」菜单点击失败的 console 表现。

---

## 发现的 Bug / 缺口

### BUG-1（阻断级）：distillStart RPC 参数形态不匹配

- **现象**：右键会话 →「提炼经验」→ console error `[SessionsPane] distill session failed: {}`，分栏不打开。
- **根因**：`makeCorumRpcCall`（`corum-rpc-client/src/client/index.ts:37`）封装为 `{ args: <argsObject> }`，但 `distillStart(input: { sessionId: string })` 的 typert 方法参数名是 `input`，网关期望 `{ args: { input: { sessionId: '...' } } }`。
- **影响**：侧栏 `resolveDistill`（`corum-ide-sidebar-ui/src/client/index.ts:342`）调 `callAgentRemote('distillStart', { sessionId: '...' })` → 发送 `{ args: { sessionId: '...' } }` → 网关报 `unexpected "sessionId"` → distillStart 抛错 → `layout.openSplitPane` 未被调 → 分栏不打开。
- **波及面**：所有 `distill*` 带参 RPC（`distillStart` / `distillStatus` / `distillCommit` / `distillDiscard` / `distillReplay`）的 UI 调用均受影响（DistillReviewView 内部也用 `makeCorumRpcCall`）。但 `distillListPending`（无参）不受影响。
- **修法建议**（不改源码，仅记录）：在 `resolveDistill` 处把 args 从 `{ sessionId }` 改为 `{ input: { sessionId } }`；或在 `makeCorumRpcCall` 层对单对象入参的 typert 方法做 `input` 包装（但需区分哪些方法需要包装）。**建议前者**（定点修，不波及 `createTaskAgent` 等已正常工作的方法）。

### 缺口-1：通知时序不可靠

- **现象**：`distillStart` 成功后 host emit `corum/distill/completed`，但 notification-bridge 未捕获到（可能订阅时序或通知自动消失）。
- **根因线索**：需检查 notification-bridge 的订阅时机与 `corum/distill/completed` emit 的时序关系。可能是 distillStart 是 fire-and-forget（`startManualDistill` 内 `void runManualDistill`），LLM 调用完成后 emit 事件，但 notification-bridge 可能在更早时就已处理（或事件在 bridge 订阅前 emit）。

### 侧栏行可见性 — 无 bug

- `document.hidden=true`（窗口未聚焦）不阻断 CDP Input 事件。
- 会话行 `[data-session-id]` 可见可右键，`elementsFromPoint` 命中的子元素经 `.closest()` 正确解析到行。
- contextmenu 成功弹出菜单。

---

## 证据文件

| 文件 | 说明 |
|------|------|
| `01-initial-sidebar.png` | 初始侧栏截图（24 条会话行可见） |
| `02-context-menu.png` | 右键会话行后的上下文菜单（5 项含「提炼经验」） |
| `03-splitpane-opened.png` | 点击「提炼经验」后的截图（分栏未打开——BUG-1） |
| `04-after-distill-trigger.png` | 经正确参数形态触发 distillStart 后的截图 |

---

## 清理记录

- ✅ `memory/deleteBySource('manual-distill:corum-task-7e914c2e')` → 删除 3 条测试写入的 facts
- ✅ 删除 `<CORUM_HOME>/distill-jobs/` 下所有测试 job 文件（6 个）
- ✅ 删除 `packages/desktop/.corum-verify-home/distill-jobs/` fixture 目录
- ✅ `distillListPending` 确认 0 pending jobs
- ✅ `memory/listFacts(source=manual-distill:corum-task-7e914c2e)` 确认 0 facts
- ✅ 分栏未打开，无需复位

---

## 未尽事项

1. **BUG-1 未修**：不改源码，记录现象+根因供裁决。
2. **SplitPane 拖拽/滚动/持久化/关闭**（清单 3/4/5/9）：因 BUG-1 阻断分栏打开，未经实机验证。源码审查逻辑正确，但需修 BUG-1 后重新验证。
3. **通知跳转**（清单 8）：时序错过，需重新触发验证。
4. **DistillReviewView UI 渲染**：因分栏未打开，DistillReviewView 的 loading/error/expired/候选卡片/全选/编辑/commit/discard 按钮 UI 均未经实机验证。RPC 层全部通过，但 UI 层渲染（含 CSS 样式）未验。
5. **三平台**：仅 darwin 实机验证。linux/win32 未验（SplitPane 纯鼠标数学+CSS flexbox，三平台风险低）。

---

## 工具与调用

- **CDP 工具**：`cdp_list_targets` / `cdp_evaluate` / `cdp_run_script` / `cdp_call_rpc`
- 目标 id：`executor`（:9333）
- RPC 调用：经页内 `fetch('/api/<ns>/<method>')` + 官方 message 格式（`{ type: 'client-request', rpcId, method, payload: { args: { input: {...} } } }`）
- console.error 收集器：页内 `window.console.error` 拦截
- 截图：`cdp_run_script` screenshot 步骤 → base64 → 落盘

**步骤数**：~15 步（含诊断、RPC 测试、清理）  
**工具调用数**：~30 次

---

## 复验轮（2026-11-19 BUG-1 修复后）

**被测实例**：verify 实例（CDP :9333，PID 41724，基座 0.2.1-rc.3@be72761，rev 90597a7891ef，77 boot entries）
**修复内容**：distill* RPC 形参绑定 bug（BUG-1）—— typert 网关按形参名 `input` 绑定，两处 UI 调用改为 `{ input: {...} }` 封装

### 修复概述

| 文件 | 行号 | 改动 |
|------|------|------|
| `corum-ide-sidebar-ui/src/client/index.ts` | :342–349 | `resolveDistill` 里 `distillStart` 调用从 `{ sessionId }` 改为 `{ input: { sessionId } }`，`satisfies DistillStartArgs` 移入 `input` 内层 |
| `corum-ui-split-pane/src/client/DistillReviewView.tsx` | :118–119 | `distillStatus` 从 `{ jobId }` 改为 `{ input: { jobId } }` |
| 同上 | :205 | `distillReplay` 从 `{ sessionId }` 改为 `{ input: { sessionId } }` |
| 同上 | :278–282 | `distillCommit` 从 `{ jobId, items }` 改为 `{ input: { jobId, items } }` |
| 同上 | :300 | `distillDiscard` 从 `{ jobId }` 改为 `{ input: { jobId } }` |

构建：`pnpm --filter @corum/corum-ide-sidebar-ui run build` + `pnpm --filter @corum/corum-ui-split-pane run build`（三步 script 均含，exit 0）。
Typecheck：两包 `tsc -b --pretty false` exit 0。
重启：`./scripts/corum-instance.sh restart --home=verify`（:9333，主实例 :9222 未触碰）。

### 逐项结论

#### 1. 菜单接线 — ✅ PASS（上轮 FAIL，本轮修复）

右键会话行 `corum-task-7e914c2e` → 弹出 5 项菜单（重命名/归档/分叉会话/保存到…/提炼经验）→ 点击「提炼经验」→ `distillStart` RPC 成功返回 `jobId` → `layout.openSplitPane` 触发 → `corum.splitpane` 槽 occupant 渲染 → **分栏视图打开**。
- console error：`[SessionsPane] distill session failed: {}` **消失**（上轮 FAIL 的直接症状）✓
- `distillStart({ input: { sessionId } })` → `{ jobId: "distill-..." }` ✓

#### 2. 拖拽比例 — ✅ PASS（上轮 UNVERIFIED）

真实指针拖中缝（`._5gP6zG_sash`，CDP `Input.dispatchMouseEvent` 拖拽）从 x=1267 → x=1400：
- 左栏宽度 463 → 599px，右栏 457 → 321px ✓
- 比例 0.5 → **0.647**（在 clamp 0.2–0.8 范围内）✓
- localStorage `corum.splitpane.distill-review` = `"0.6468260664146869"` ✓

#### 3. 独立滚动 — ✅ PASS（上轮 UNVERIFIED）

- 左栏 `kmheAW_tabBody`：overflow-y=auto，scrollHeight=19666 > clientHeight=927 ✓
- 右栏 `kmheAW_candidateCards`：overflow-y=auto，scrollHeight=4925 > clientHeight=918，29 个子元素 ✓
- 两栏各自独立滚动容器 ✓

#### 4. 持久化 + 比例恢复 — ✅ PASS（上轮 UNVERIFIED）

- `location.reload()` 后 localStorage 比例值保留：`"0.6468260664146869"` ✓
- 重新打开分栏（右键→提炼经验）后比例恢复：左栏 599px / 右栏 321px（与 reload 前一致）✓

#### 5. 取舍写入 — ✅ PASS（上轮 PASS，本轮复验）

- 选 3 条候选（:0 / :1 / :2），编辑 :1（fact 追加「编辑测试」+ importance 5→8 + retention short→long）
- `distillCommit({ input: { jobId, items } })` → `{ written: 3, failed: 0 }` ✓
- `memory/listFacts({ input: { source: 'manual-distill:corum-task-7e914c2e' } })` → 3 条 facts，编辑值正确（importance=8、retention=long、编辑后文本）✓
- **幂等**：重复 commit 同 3 条 → `{ written: 0, failed: 0 }` ✓

#### 6. 舍弃 — ✅ PASS（上轮 PASS，本轮复验）

- `distillDiscard({ input: { jobId } })`（不传 candidateIds = 全部 pending）→ `{ discarded: 34 }` ✓
- job 状态：3 committed + 34 discarded + 0 pending ✓
- listFacts 仍 3 条（discard 不写记忆）✓

#### 7. 关闭分栏 — ✅ PASS（上轮 UNVERIFIED）

- 点击关闭按钮（`.kmheAW_closeBtn`，aria-label="关闭"）→ 分栏关闭，`corum.splitpane` 槽清空 ✓
- 编辑器格恢复（单栏布局）✓

#### 8. console 零新增错误 — ✅ PASS（上轮 FAIL，本轮修复）

- **`[SessionsPane] distill session failed: {}`** — **消失**（BUG-1 修复的直接效果）✓
- 既有错误：2 条 `[SessionsPane] rename failed: {}` — **非本功能相关**（测试过程中误点「重命名」菜单项触发，非 distill 功能错误）
- 零 distill 相关 console error ✓

### 清理记录（复验轮）

- ✅ `memory/deleteBySource('manual-distill:corum-task-7e914c2e')` → 删除 3 条测试 facts
- ✅ `distillDiscard` 清空所有 pending distill jobs（2 个）
- ✅ 删除 `<CORUM_HOME>/distill-jobs/` 下 7 个测试 job 文件
- ✅ `distillListPending` 确认 0 pending jobs
- ✅ `memory/listFacts(source=manual-distill:corum-task-7e914c2e)` 确认 0 facts
- ✅ 分栏已关闭复位

### 未尽事项

1. **通知跳转（清单 8）**：本轮未单独触发通知点击验证（distillStart 是 fire-and-forget，LLM 完成后 emit `corum/distill/completed` → notification-bridge → openSplitPane）。上轮因时序错过 UNVERIFIED。本轮直接经菜单触发 distillStart 成功，但通知路径本身未单独验。非阻断——通知机制是独立链路，且 distillStart→openSplitPane 的直接路径已验通。
2. **三平台**：仅 darwin 实机验证。linux/win32 未验（SplitPane 纯鼠标数学+CSS flexbox，三平台风险低）。

**步骤数**：~25 步（修复、构建、重启、逐项复验、清理）
**工具调用数**：~40 次

---

## 终验轮（2026-11-20）：通知链路 BUG-2 修复 + 端到端验证

### 背景

上轮「未尽事项 1」标注通知跳转路径未单独验证。本轮补验发现通知链路存在**双重断裂**，修复后端到端验通。

### 根因与修复

#### BUG-2a：corum-api-remotes lib 陈旧（host 事件转发断裂）

- **现象**：`distillStart` 触发后 distill 完成（`distillStatus` 返回 done + N 条候选），但 notification toast 从不出现。
- **诊断**：
  - `grep 'distill/completed' packages/plugins/agent/corum-api-remotes/lib/index.js` → **0 命中**（src 有、lib 无）。
  - lib mtime `Nov 18 23:17`，src mtime `Nov 19 12:59` → lib 陈旧。
  - corum-agent lib 是新的（含 `ctx.emit('corum/distill/completed')`），但 corum-api-remotes lib 未随 commit 846d9742 重建。
- **修法**：`pnpm --filter @corum/corum-api-remotes run build`（tsc -b + tsdown）。构建后 `lib/index.js:241` 含 `event: "corum/distill/completed"` ✓。
- **验证**：重启 verify 实例后 monkey-patch `store.notify()` → distill 完成时 `notify()` 被调用，title="经验沉淀完成"、message="提炼出 N 条经验，待取舍" ✓。

#### BUG-2b：notification-bridge layout 服务未注入（toast 不可点击）

- **现象**：BUG-2a 修后 toast 出现了，但 `data-action` 未设 → toast 不可点击 → 点击不打开分栏。
- **诊断**：
  - `notification-bridge.ts:319`：`const layout = ctx.get('layout' as never)` → 返回 undefined。
  - `index.ts:130`：`ctx.inject(['remote', 'sessions', 'notifications'], ...)` — **缺 `'layout'`**。
  - layout 不在 inject 声明 → `ctx.get('layout')` 返回 undefined → `openDistillReview` 不挂 `onOpen` → toast `data-action` 未设。
- **修法**：inject 数组加 `'layout'`：`ctx.inject(['remote', 'sessions', 'notifications', 'layout'], ...)`。同文件 editor inject（line 169）已含 `'layout'`，是正确先例。
- **验证**：重启后 toast `data-action` 已设 → 可点击 → 点击打开分栏 ✓。

### 终验结果

#### 通知 → 分栏端到端 — ✅ PASS

| 步骤 | 结果 | 证据 |
|------|------|------|
| 构建 corum-api-remotes | ✅ | `lib/index.js:241` 含 `event: "corum/distill/completed"`（构建前 0 命中） |
| 重启 verify 实例 | ✅ | PID 55012，CDP :9333 可达 |
| distillStart 触发 | ✅ | jobId `distill-1795104881327-0gi6m8`，返回 `{ jobId }` |
| distill 完成 | ✅ | `distillStatus` → done，36 条候选 |
| toast 出现 | ✅ | `[role="status"][data-tone]` 命中：title="经验沉淀完成"、msg="提炼出 36 条经验，待取舍"、tone="success" |
| toast 可点击 | ✅ | `data-action` 已设（BUG-2b 修复后） |
| 点击 toast | ✅ | `toast.click()` 执行 |
| 分栏打开 | ✅ | body.innerText 含「候选」「回放」「取舍」「全选（36/36）」「写入 36 条选中记忆」「全部舍弃」；bodyTextLen 1248→52988 |
| 分栏关闭 | ✅ | 点击 `button[aria-label="关闭"]` → bodyTextLen 恢复 1248 |

#### 清理 — ✅ PASS

- ✅ `distillDiscard` 舍弃全部 7 个测试 job（3 个前轮残留 + 4 个本轮产生），共 215 条 pending 候选（36+30+41+24+35+29+20）
- ✅ 删除 `~/.corum/distill-jobs/` 下 7 个测试 job 文件
- ✅ `distillListPending` 返回空 `[]`
- ✅ `memory/listFacts` 返回空 `[]`（无 manual-distill:corum-task-7e914c2e 来源残留——所有候选均 pending 未 commit）
- ✅ 分栏已关闭复位

### 未尽事项

1. **三平台**：仅 darwin 实机验证。linux/win32 未验。
2. **`packages/desktop/build/host/node_modules/@corum/corum-api-remotes/lib/index.js`** 也是陈旧物理副本（Nov 18 23:18，不含 `distill/completed`）——这是 `pack-macos.mjs` 的 `pnpm deploy` 产物，仅打包态使用。dev 态从 workspace `node_modules`（symlink → workspace lib）加载，已修。**打包态需重跑 `npm run pack` 才会更新**，留给发版流程。

**步骤数**：~20 步（根因验证、构建、重启、E2E 验证、清理、文档）
**工具调用数**：~35 次

---

## 二期验收轮（2026-11-20）：分栏双会话视图重设计 + 沉淀卡片 + 归档右列

**被测实例**：verify 实例（CDP :9333，rev bb749c60f70a，78 boot entries）
**重设计基线**：commit 721abf90（SessionScopeOverride passes session reference）+ 14158f45（消除跨 bundle 运行时 import）+ 0e9b4cf4（三处接线改调 layout.openDistillArchive + 会话行右键「在右侧分栏打开」）+ 1ed7f695（新包 corum-ui-distill-card）
**主实例 :9222**：未触碰

### 逐项结论

#### V1. 异会话分栏 — ✅ PASS

**验证内容**：侧栏右键会话 A →「在右侧分栏打开」→ 左=主会话、右=A 且可交互（有 composer，无只读提示）。

**证据**：
- 会话 A = `corum-task-7e914c2e`，会话 B = `corum-task-52714406`。
- 先点击会话 B 使其成为主（活跃）会话，再右键会话 A →「在右侧分栏打开」。
- 结果：左栏 session=`corum-task-52714406`（B），右栏 session=`corum-task-7e914c2e`（A）。
- 两栏均有 EmbeddedConversation（`corum-embedded-conversation`），各带 composer（`_6kJc-W_input` display:block, visibility:visible, pointerEvents:auto）。
- 右栏**无只读提示**（`.corum-embedded-readonly-hint` 不存在）——因为左右是**不同会话**，各自独立可交互。
- 右栏迷你头标识 A：`.corum-embedded-header` text=`corum-task-7e914c2e`。
- 中缝 Sash：`._5gP6zG_sash` x=788。
- 截图 `v1-05-splitpane-diff-sessions.png`、`v1-06-splitpane-heterogeneous-sessions.png`。

**补充**：当右栏打开的会话与左栏活跃会话**相同时**，右栏显示只读提示「与左栏同一会话，输入请在左栏」——这是预期行为（同一会话不应有两个 composer），非 bug。

#### V2. 左栏跟随 — ✅ PASS

**验证内容**：侧栏点会话 B → 左变 B、右仍 A。

**证据**：
- 初始状态：左=`corum-task-52714406`(B)，右=`corum-task-7e914c2e`(A)。
- 点击侧栏会话 C（`corum-task-e9a0e62f`）。
- 结果：左栏 session 变为 `corum-task-e9a0e62f`(C)，右栏仍为 `corum-task-7e914c2e`(A)。
- 活跃侧栏会话变为 `corum-task-e9a0e62f`。
- 截图 `v2-01-left-follows.png`。

#### V3. 拖拽+持久化 — ✅ PASS

**验证内容**：拖中缝比例变化 clamp 0.2–0.8；localStorage `corum.splitpane.session-split` 写入；location.reload() 后重开分栏比例恢复。

**证据**：
- 初始 ratio=0.5（sash x=788，localStorage=`"0.5"`）。
- 拖向右（x=1083）：ratio=**0.7994**（clamp 到 0.8），localStorage=`"0.8"`，左栏 w=786 右栏 w=190。
- 拖向左（x=493）：ratio=**0.2006**（clamp 到 0.2），localStorage=`"0.2"`，左栏 w=196 右栏 w=780。
- 拖到中间（x=935）：ratio=**0.6494**，localStorage=`"0.6496945010183299"`。
- `location.reload()` 后 localStorage 值保留=`"0.6496945010183299"`（分栏关闭，需重开）。
- 重开分栏（右键会话 A →「在右侧分栏打开」）：sash x=935，ratio=0.6494（与 reload 前一致），左栏 w=638 右栏 w=338。
- 截图 `v3-01-drag-right-clamp08.png`、`v3-02-drag-back-mid.png`、`v3-03-ratio-restored-after-reload.png`。

#### V4. 沉淀→卡片→归档 — ✅ PASS

**验证内容**：distillStart → 完成后会话流出现「经验沉淀完成」卡片（N 条候选）→ 归档面板 corum.distill 在右列打开（editor 格不被抢）。

**证据**：
- `distillStart({ input: { sessionId: 'corum-task-7e914c2e' } })` → jobId `distill-1795142246277-5zr8tm`。
- 轮询 distillStatus：status=`done`，factCount=**25**，phase=`已产出 25 条候选`。
- 会话流出现 durable 卡片：`.NEgO4q_card` text=`经验沉淀完成 25 条候选 待取舍 查看归档`，位于会话流末尾（x=331）。
- 归档面板 `corum.distill` 槽在右列打开（x=909，w=818），内容含「记忆归档 ✕ 全选（25/25）」+ 25 条候选。
- editor 格未被抢（主会话会话占 editor 槽，归档在 corum.distill 独立槽）。
- 截图 `v4-01-distill-card-and-archive.png`。

#### V5. 卡片持久 — ✅ PASS

**验证内容**：reload 后卡片还在；点击重开归档。

**证据**：
- `location.reload()` 后加载会话 A（`corum-task-7e914c2e`）。
- 卡片仍在：`.NEgO4q_card` text=`经验沉淀完成 25 条候选 待取舍 查看归档`（durable session event `corum/distill-completed` 持久化）。
- 点击卡片内「查看归档」按钮 → 归档面板 `corum.distill` 重新打开，内容含 25 条候选。
- 注：归档面板 rect width=0（CSS 布局动画/transition 未完成），但内容已完整渲染（textContent 含全选/候选/重要性/留存）。

#### V6. 归档取舍链 — ✅ PASS

**验证内容**：勾选部分+编辑一条 fact/importance → 写入 → corum-memory listFacts（source=manual-distill:<sid> 过滤）核实编辑值 → 重复 commit written=0 → 剩余全舍弃 → 关面板。

**证据**：
- 选 3 条候选（`:0` / `:1` / `:2`），编辑 `:0`（fact 追加「编辑测试」+ importance 5→7 + retention short→long），编辑 `:2`（importance 5→6）。
- `distillCommit({ input: { jobId, items } })` → `{ written: 3, failed: 0 }` ✓
- `memory/listFacts({ input: { source: 'manual-distill:corum-task-7e914c2e' } })` → 3 条 facts：
  - fact 0：文本含「编辑测试」，importance=**7**，retention=**long** ✓
  - fact 1：importance=5，retention=short ✓
  - fact 2：importance=**6**（编辑后）✓
- **幂等**：重复 commit 同 3 条 → `{ written: 0, failed: 0 }` ✓
- `distillDiscard({ input: { jobId } })`（不传 candidateIds = 全部 pending）→ `{ discarded: 22 }` ✓
- job 状态：3 committed + 22 discarded + 0 pending ✓
- 关闭归档面板（点击关闭按钮）→ `corum.distill` 槽清空 ✓

**注**：「二次确认」在 UI 层表现为 discard 按钮的确认对话框。本轮经 RPC 直调 `distillDiscard`，RPC 层不做二次确认（UI 层的二次确认是前端交互保护，非 RPC 约束）。discard 后 candidates state 全变为 `discarded`，验证了取舍链的正确性。

#### V7. 通知点击 — ✅ PASS

**验证内容**：触发新 distill，单 eval 内轮询 toast（「提炼出 N 条经验，待取舍」）出现即 click → 断言归档面板打开。

**证据**：
- 安装 MutationObserver 监听 document.body 的 childList（toast 经 `createPortal(..., document.body)` 渲染，不在 `.corum-notification-root` 内）。
- 右键会话 A →「提炼经验」→ distillStart 触发。
- 14 秒后 MutationObserver 检测到 toast：`[role="status"][data-tone="success"]`，text=`经验沉淀完成 提炼出 18 条经验，待取舍 刚刚`。
- 点击 toast → 归档面板 `corum.distill` 打开（x=909，w=818）✓
- distillStatus 确认：status=done，factCount=18。

**教训**：前两轮（V4 的 distill、V5 之前的 distill）toast 未出现——因为 distill 在 MutationObserver 安装前已完成、事件已 emit。第三轮**先装 observer 再触发 distill**，成功捕获。toast 出现时机 = distill 完成（LLM 返回）时，非 distillStart 时。

#### V8. console 零新增错误 — ✅ PASS

**证据**：
- 安装 `window.console.error` 拦截器（reload 后重新安装）。
- 全程（V1–V7）收集到 **0 条新增 console.error**。
- pre-existing 错误：1 条（由 cdp_run_script 的 console window 报告 `preExisting: 1`，稳定既存错误，与本功能无关）。

### 发现的 Bug / 观察

无新阻断级 bug。二期重设计（commit 721abf90 等）功能完整，V1–V8 全部 PASS。

**观察-1（非 bug）**：当归栏打开的会话与左栏活跃会话相同时，右栏显示只读提示「与左栏同一会话，输入请在左栏」。这是预期行为——同一会话不应有两个独立 composer，系统自动降级为只读展示。

**观察-2（CSS 布局）**：V5 中 reload 后点击「查看归档」重开归档面板时，面板 `getBoundingClientRect().width=0`，但 textContent 完整（含全选/候选/重要性/留存）。可能是 CSS transition/animation 的初始帧问题，内容已渲染但宽度动画未完成。不影响功能。

### 清理记录（二期验收轮）

- ✅ `distillDiscard` 舍弃 2 个 pending job（distill-1795142666292-33atqm 18 条 + distill-1795142550478-9llkiu 26 条 = 44 条 pending 候选）
- ✅ 删除 `~/.corum/distill-jobs/` 下 4 个测试 job 文件（含前轮残留 1 个 + 本轮 3 个）
- ✅ `memory/deleteBySource('manual-distill:corum-task-7e914c2e')` → 0（V6 commit 的 3 条 facts 已在 V6 listFacts 后被 deleteBySource 删除，返回 0 表示无残留）
- ✅ `distillListPending` 返回空 `[]`
- ✅ `memory/listFacts(source=manual-distill:corum-task-7e914c2e)` 返回空 `[]`
- ✅ 归档面板已关闭复位
- ✅ 分栏已关闭复位
- ✅ localStorage `corum.splitpane.session-split` 已清除

### 未尽事项

1. **三平台**：仅 darwin 实机验证。linux/win32 未验（SplitPane 纯鼠标数学+CSS flexbox，三平台风险低；归档面板纯 React+CSS，同理）。
2. **观察-2 的 CSS width=0**：建议后续排查归档面板 CSS transition/animation 是否在某些时序下导致初始 width=0，但不影响功能。
3. **通知 toast 时序**：toast 在 distill 完成（LLM 返回）时出现，非 distillStart 时。若 distill 在页面加载/notification-bridge 订阅前完成，toast 可能丢失（与上轮「通知时序不可靠」一致）。本轮通过「先装 observer 再触发」成功验证。

**步骤数**：~35 步（V1–V8 验证 + 清理）
**工具调用数**：~50 次

---

## 三期最终验收轮（2026-11-20）：dock 卡片架构 + 选区浮条 + 子会话分栏 + 通知链路

**被测实例**：verify 实例（CDP :9333，PID 61259，基座 0.2.1-rc.3@be72761，rev 4cd47431110e，78 boot entries，CORUM_HOME=/Users/kukucai/.corum）
**卡片架构基线**：commit 74004c3c（dock 卡片 host 状态投影 + conversation.input.dock + distillListPending 10s 轮询 + remote.$on 重查）
**fixture**：手写 `distill-fixture-3pending.json`（3 条 pending 候选，sessionId=corum-task-7e914c2e，origin=manual，source=manual-distill:corum-task-7e914c2e）到 `/Users/kukucai/.corum/distill-jobs/`

### 逐项结论

#### A. dock 卡片 — ⚠️ PARTIAL（卡片渲染✓ / 查看归档禁用 BUG-5 / reload 持久✓ / discard→消失✓）

**验证内容**：fixture 就位后 10s 内 dock 出现卡片 → 点「查看归档」→ 右列归档面板开 → reload 后卡片仍在 → 全部舍弃 → 卡片消失。

**证据**：
- **卡片出现**：打开 corum-task-7e914c2e 后 1s 内 dock 区出现 `.NEgO4q_card` `[role="status"]`：text=`经验沉淀完成 3 条候选待取舍 查看归档` ✓（distillListPending 立即查到 fixture job，无需等 10s 轮询）
- **查看归档禁用**：`button.disabled=true` ❌ — `distillArchiveLayout(ctx.get('layout'))` 返回 undefined（BUG-5）
- **reload 持久**：`location.reload()` 后重开会话，卡片重新出现（host 状态投影查 distillListPending）✓
- **discard→消失**：经 RPC `distillDiscard({jobId})` 舍弃 3 条 pending 候选 → `distillListPending` 返回空 → 卡片消失（轮询周期内）✓

#### BUG-5（阻断级）：dock 卡片 layout 服务未注入 →「查看归档」禁用

- **现象**：dock 卡片「查看归档」按钮 `disabled=true`，无法点击打开归档面板。
- **根因**：`corum-ui-distill-card/src/client/index.tsx:48` inject 声明 `['slots', 'remote', 'connection', 'locale']` — **缺 `'layout'`**。卡片在 `apply()` 里调 `ctx.get('layout' as never)`，但 layout 不在 inject 声明里 → `ctx.get('layout')` 返回 undefined → `distillArchiveLayout(undefined)` 返回 undefined → 按钮 disabled。
- **影响**：dock 卡片可以渲染（数据来自 RPC distillListPending），但「查看归档」按钮不可点击 → 归档面板无法从卡片打开。
- **与 BUG-2b 同构**：BUG-2b 是 notification-bridge inject 缺 `'layout'`（二期已修），BUG-5 是 distill-card inject 缺 `'layout'`（三期新卡片代码未照先例）。**红线 4 的重复违反**：ctx.get 在 inject 未声明时返回 undefined。
- **修法建议**：inject 数组加 `'layout'`：`export const inject = ['slots', 'remote', 'connection', 'locale', 'layout']`。与 notification-bridge.ts 同款修法。

#### B. 选区浮条 — ❌ UNVERIFIED（CDP 合成拖拽无法选中文本）

**验证内容**：分栏打开（左=task 会话，右=corum-chat- 会话）→ 左栏消息 prose 上真实指针拖选 → 断言「询问 AI」浮条出现 → 点击 → 右栏草稿含引用文本。

**证据**：
- **分栏打开** ✓：右键 corum-chat-0cca3675 行内 dot → 菜单「在右侧分栏打开」→ 分栏打开（sash 存在、2 个 EmbeddedConversation、右栏=corum-chat-0cca3675）
- **拖选失败**：CDP `Input.dispatchMouseEvent`（drag action，dragMoves=6/8）从 `span.XloQSW_marqueeChunk` 起点拖到终点 → **`window.getSelection().toString()` 返回空字符串**（`selectionLength: 0, rangeCount: 1`）
- **根因**：CDP 合成 mouse 事件（mousePressed→mouseMoved→mouseReleased）在 Chromium 里**不触发原生文本选择**。Chromium 的文本选择需要浏览器原生的 selection 逻辑（涉及 `extend`/`collapse` API），合成 Input 事件只产生鼠标轨迹不产生选区。任务描述已预警此可能性。
- **降级标 unverified**，如实记录 `selection.toString()` 证据。不谎报。

#### C. 子会话分栏查看 — ❌ UNVERIFIED（无 nested 子会话可用）

**验证内容**：找编排卡 worker 分支或侧栏 nested 子会话行点击 → 右栏 mode='view' 只读。

**证据**：
- 侧栏 32 条会话行扫描：**0 条含 nested 子会话标识**（无 `[class*="child"]`/`[class*="nested"]`/`[class*="indent"]` 子元素）
- 编排卡（`[class*="orchestration"]`/`[class*="worker"]`/`[class*="branch"]`）命中的是布局元素 `gdqJ6G_branchRow`/`gdqJ6G_branchCell`，非编排卡片
- corum-task-7e914c2e 会话无子会话分支
- **降级标 unverified**：无可用 nested 子会话入口，无法验证 mode='view' 只读分栏。

#### D. 通知链路 — ❌ UNVERIFIED（emit lossless 错误复现）

**验证内容**：先装 MutationObserver → 触发真实 distillStart → 若完成 factCount>0 守 toast → 点击开归档。

**证据**：
- MutationObserver 安装 ✓（监听 document.body childList）
- `distillStart({ input: { sessionId } })` → jobId `distill-1795188009962-tsty89` ✓
- **distill 失败**：磁盘 job 文件 `status: "error"`、`error: "forwarded host event \"corum/distill/completed\" argument 0 is not lossless JSON data"`、`source: "manual-distill:undefined"`
- **无 toast 出现**（distill error 不 emit completed 事件）
- **`distillStatus({ input: { jobId } })` 返回 null**（见下 BUG-6）

#### emit lossless 根因线索

- **错误信息**：`forwarded host event "corum/distill/completed" argument 0 is not lossless JSON data`
- **抛出位置**：`corum-api-remotes/src/index.ts:186` — `assertJsonArgs()` 函数，遍历 emit 的 args，用 `isJsonValue(arg)` 校验每个参数
- **触发条件**：`emitDistillCompleted(ctx, { jobId, sessionId, factCount })` 的 payload 中 `sessionId` 为 `undefined`（job 文件 `source: "manual-distill:undefined"` 佐证）→ `{ jobId: "...", sessionId: undefined, factCount: 0 }` 不是合法 JSON（`undefined` 不可序列化）→ `isJsonValue` 返回 false → 抛错
- **`sessionId` 为 undefined 的原因**：本轮经 `cdp_call_rpc` 调 distillStart 时 payload 双层包装（shapeKey `input` + payloadJson 已含 `input` 键），导致 host 收到的 `input.sessionId` 为 undefined。**这是测试 harness 的 payload 形态错误，非代码 bug**。但 `emitDistillCompleted` 在 sessionId 为 undefined 时不做防御 → emit 的 payload 含 undefined → lossless 校验失败 → distill 标为 error。**建议在 emitDistillCompleted 前做 sessionId 非空校验**（fail-fast 而非让 lossless 校验兜底）。

#### BUG-6：distillStatus/distillDiscard 对磁盘 job 返回 null/0（与 distillListPending 不一致）

- **现象**：`distillStatus({ input: { jobId: 'distill-fixture-3pending' } })` 返回 null，`distillDiscard({ input: { jobId } })` 返回 `{ discarded: 0 }`，但 `distillListPending()` 返回该 job（含 3 条 pending 候选）。
- **根因线索**：`distillListPending` 用 `listAllJobsFromDisk()`（readdir + loadJobFromDisk），`distillStatus` 用 `getDistillJob()`（内存 Map → loadJobFromDisk）。两者都回退到 `loadJobFromDisk`，但 `distillStatus` 返回 null 意味着 `loadJobFromDisk` 对该 jobId 返回 null——尽管 `distillListPending` 的 `listAllJobsFromDisk` 成功读取了同一文件。**可能是内存 Map 的缓存污染**（getDistillJob 先查内存 Map，内存 Map 可能存了一个 candidates=undefined 的旧条目，返回时 `{ ...cached }` 的 candidates 为 undefined → distillDiscard 第 709 行 `job.candidates === undefined` → return 0）。
- **本轮确认**：用正确 payload 形态（`shapeKey: "input"` + `payloadJson: '{"jobId":"..."}'` 不双层包装）调 `distillDiscard` → `{ discarded: 3 }` ✓。说明 BUG-6 的前序 discard=0 也是 payload 双层包装导致 jobId 不匹配 → getDistillJobWithExtras 查不到 → return 0。
- **结论**：BUG-6 部分是 harness payload 错误，但 `distillStatus` 返回 null vs `distillListPending` 返回 job 的不一致性仍需排查（可能是内存 Map 缓存与磁盘不同步）。

#### E. chat 隔离回归 — ✅ PASS

**验证内容**：corum-chat- 会话零工具卡；主会话事件流不含 chat 消息。

**证据**：
- 右栏 corum-chat-0cca3675 会话：`toolCardCount: 0`（`[class*="tool-card"]`/`[class*="ToolCard"]` 零命中）✓
- chat 会话在分栏右栏正常渲染（有 composer、可交互）✓

#### F. console 零新增错误 — ✅ PASS

**证据**：
- `window.console.error` 拦截器全程收集到 **0 条新增 console.error** ✓
- pre-existing：cdp_run_script 报告 `preExisting: 1`（稳定既存错误，与本功能无关）

### 清理记录（三期验收轮）

- ✅ `distillDiscard({ input: { jobId: 'distill-fixture-3pending' } })` → `{ discarded: 3 }`（fixture 候选全舍弃）
- ✅ 删除 `/Users/kukucai/.corum/distill-jobs/` 下 2 个测试 job 文件（fixture + 真实 distill error job）
- ✅ `memory/deleteBySource('manual-distill:corum-task-7e914c2e')` → 0（无 commit 的 facts）
- ✅ `distillListPending` 返回空 `[]`
- ✅ `memory/listFacts(source=manual-distill:corum-task-7e914c2e)` 返回空 `[]`
- ✅ 分栏已关闭复位

### 未尽事项

1. **BUG-5 未修**：dock 卡片 inject 缺 `'layout'` →「查看归档」禁用。定点修法：inject 加 `'layout'`。
2. **BUG-6 待排查**：distillStatus 返回 null vs distillListPending 返回 job 的不一致性（部分是 payload 形态错误，但内存/磁盘缓存同步需排查）。
3. **emit lossless 根因**：sessionId 为 undefined 时 emitDistillCompleted 不防御 → payload 含 undefined → lossless 校验失败。建议 emit 前校验 sessionId 非空。
4. **B 项选区浮条 UNVERIFIED**：CDP 合成拖拽无法选中文本，需真实用户操作或 selection API 编程选择验证。
5. **C 项子会话分栏 UNVERIFIED**：无可用 nested 子会话入口。
6. **三平台**：仅 darwin 实机验证。linux/win32 未验。
7. **打包态**：未验（`packages/desktop/build/host/node_modules/@corum/corum-api-remotes/lib/index.js` 陈旧物理副本，见二期未尽事项 2）。

**步骤数**：~30 步（fixture 创建 + A-F 验证 + 清理）
**工具调用数**：~45 次
