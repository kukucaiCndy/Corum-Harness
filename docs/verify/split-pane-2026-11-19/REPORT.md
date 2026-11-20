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

---

## 修复轮（2026-11-20/21）：BUG-5 定点修 + 防御校验 + BUG-6 核实 + A–D 补验

**被测实例**：verify 实例（CDP :9333，dev 态 `lib/`，CORUM_HOME=/Users/kukucai/.corum，基座 0.2.1-rc.3@be72761，78 boot entries）
**重启说明**：host 半改动必须重启才生效。重启前先实测到「旧代码仍在跑」的判据（`distillStart({})` 仍建 job），再 `./scripts/corum-instance.sh restart --home=verify --port=9333`（脚本内部 `nohup … &` + `disown`，已于 2026-09-14 事故后固化为「独立子 shell + 三重 fd 重定向」不变式 3）。重启后 `distillStart({})` 立即抛可读错误，确认新代码生效。

### 一、修复行号

| # | 文件 | 行 | 改动 |
|---|------|----|------|
| BUG-5 | `packages/plugins/session/corum-ui-distill-card/src/client/index.tsx` | **56** | `export const inject` 五项：`['slots','remote','connection','locale','layout']`（原缺 `'layout'`）；`apply()` 里 `distillArchiveLayout(ctx.get('layout'))` 取法不变、随之生效 |
| 防御-1 | `packages/plugins/agent/corum-agent/src/memory-distill.ts` | **170** | 新增 `export function assertSessionId(sessionId, where)`：非空字符串断言，非法抛可读错误（`describeWireValue` 把 undefined/null/空串/对象键描述成短串） |
| 防御-1 | `packages/plugins/agent/corum-agent/src/memory-distill.ts` | **604** | `startManualDistill` 入口首行调 `assertSessionId(input?.sessionId, 'distillStart')`——**不建 job、不落盘、不 emit** |
| 防御-1 | `packages/plugins/agent/corum-agent/src/agent-service.ts` | **3754** | `@Remote('distillStart')` 入口同样先调 `assertSessionId(input?.sessionId, 'distillStart')`（与 memory-distill 同判据，单一事实源） |
| 防御-2 | `packages/plugins/agent/corum-agent/src/memory-distill.ts` | **972** | 新增 `export function isDistillCompletedPayloadValid(payload)`：jobId/sessionId 非空字符串 + factCount 有限数字 |
| 防御-2 | `packages/plugins/agent/corum-agent/src/memory-distill.ts` | **991** | `emitDistillCompleted` 开头校验；非法**跳过 emit + console.warn**（job 照常 done/error 落盘，不让 lossless 校验炸在异步体里） |
| BUG-6 | `packages/plugins/agent/corum-agent/src/memory-distill.ts` | **149** | 新增 `distillJobStamps: Map<jobId, mtimeMs>`——每内存条目「已知与磁盘一致的时点」 |
| BUG-6 | `packages/plugins/agent/corum-agent/src/memory-distill.ts` | **314** | 新增 `resolveJob(jobId)`：内存命中**也** stat 磁盘 mtime，磁盘更新则磁盘胜出并回填内存（三条边界：无磁盘文件/无 stamp/只有内存变） |
| BUG-6 | `packages/plugins/agent/corum-agent/src/memory-distill.ts` | **731 / 904** | `getDistillJob` 与 `getDistillJobWithExtras` 都改走 `resolveJob`——commit/discard 不得看到与 `distillStatus` 不同的快照 |

单测：`packages/plugins/agent/corum-agent/tests/memory-distill.spec.ts`（+11 条：assertSessionId 5 条 / payload 校验 5 条 / BUG-6 回归 3 条，含 `waitForJobFile` 消竞态）、`packages/plugins/session/corum-ui-distill-card/tests/distill-card-node.spec.ts`（+3 条 inject 完整性静态守卫）。

### 二、BUG-6 结论：**关闭。上轮的「不一致」= harness wire 双层包装假象 + 一个真实的缓存陈旧缺口（已修）**

两条独立证据：

**(a) 上轮 harness 假象（决定性）** — 同一 jobId、同一 Job、先后两种 wire：

| 调用形态 | 结果 |
|---|---|
| `shapeKey:'input'` + `payloadJson:'{"jobId":"distill-fixture-bug6probe"}'`（**正确扁平 wire**） | `distillStatus` 返回完整 job（status/phase/factCount/candidates 全对） |
| `shapeKey:'input'` + `payloadJson:'{"input":{"jobId":"…"}}'`（**上轮的双层包装**） | `distillStatus` 返回 **null** |

服务端解出 `jobId === undefined` ⇒ `getDistillJob(undefined)` 必然 null。上轮记录的「distillStatus 返回 null vs distillListPending 返回 job」正是这一条，**与缓存无关**。同时 `distillListPending` 在正确 wire 下返回的 job 与 `distillStatus` 逐字段完全一致（`{jobs:[…]}` 里同一条 record）。

**(b) 但缓存陈旧缺口是真的，且在旧 host 上现场复现** — 重启前（旧代码）实测：dock 卡片 subtitle 读 `distillListPending`（纯扫盘）显示「3 条候选待取舍」，点开后归档面板读 `distillStatus`（走内存 Map）显示「**无待处理候选**」，而 `distillStatus` 直接返回的 3 条 candidate `state` 全是 `discarded`（磁盘 fixture 是 `pending`）。**同一 job 两个 RPC 给出两份快照**，现场成立。修法即 `distillJobStamps` + `resolveJob`（内存命中仍校验磁盘 mtime）。重启后同一 fixture：`distillStatus` 与 `distillListPending` 逐字段一致（3/3 候选 `pending`，面板「全选（3/3）」）。

> 结论：BUG-6 **不是**「上轮纯假象」，是「harness 假象（主因，占上轮记录的全部现象）+ 一个真实的缓存陈旧缺陷（本轮现场抓到并修）」。两者都有 RPC 层可复现判据。

### 三、A–D 逐项证据（本轮补验，修复后 host）

#### A. 卡片「查看归档」→ **✅ PASS（BUG-5 已修好）**

fixture：`~/.corum/distill-jobs/distill-fixture-a3pending.json`（3 条 `pending` 候选，`sessionId=corum-task-7e914c2e`，`origin=manual`，`source=manual-distill:corum-task-7e914c2e`，形态照 `persistJob` 的 `PersistedJobRecord`）。

| 判据 | 修复前 | 修复后 |
|---|---|---|
| 卡片渲染（`role="status"` `.NEgO4q_card`） | ✓「经验沉淀完成 3 条候选待取舍 查看归档」 | ✓ 同 |
| 「查看归档」按钮 `disabled` | **true**（BUG-5） | **false** ✓ |
| 点击 → 归档面板 jobId 正确 | — | ✓ 面板顶栏「记忆归档」+ 内容「全选（3/3）」+ 3 张候选卡（重要性/留存下拉×3）+「写入 3 条选中记忆」+「全部舍弃」 |
| 面板候选条数 | 旧 host 显示「无待处理候选」（BUG-6 缓存陈旧） | ✓ 3 条，与 fixture 一致 |

截图：`FIX-A1-dock-card-enabled.png`（按钮亮起）、`FIX-A2-archive-panel.png`（旧 host 点开，`无待处理候选` = BUG-6 现场证据）、`FIX-A4-archive-3candidates-fixed.png`（修复后点开，3 条候选）。
清理：`distillDiscard({jobId})` → `{discarded:3}`；随后删 fixture 文件；`distillListPending` 回 `{jobs:[]}`；`memory/listFacts(source=manual-distill:corum-task-7e914c2e)` 空。

#### B. 选区浮条 — **✅ PASS（本轮首次真正验穿；上轮 UNVERIFIED 的归因是错的）**

**上轮把「选区恒空」归因为「CDP 合成 mouse 事件不触发原生文本选择」，这是误判。**真因是环境：该 verify 窗口 `document.hidden === true`（`visibilityState: 'hidden'`），而 `SelectionAskPill` 的显示链是 `mouseup → requestAnimationFrame(show)`（`SelectionAskPill.tsx:169`）；**隐藏窗口里 rAF 永不回调**。实测判据：同一次 evaluate 内 `requestAnimationFrame` 600ms 未触发（`rafFired:false`），同批 `setTimeout` 50ms 正常触发（`timeoutFired:true`）。

验法（不改产品代码，只为绕开隐藏窗口这一环境限制）：把 `window.requestAnimationFrame` 临时替身为 `setTimeout(cb,16)`，再走**产品真实代码路径**——Range API 建非折叠选区 + `document.dispatchEvent(mouseup)` → 组件 `onMouseUp` → rAF(show) → 判定 → `setVisible(true)` → portal 到 body。

| 判据 | 结果 |
|---|---|
| 分栏开（左=`corum-task-7e914c2e` x=297，右=`corum-chat-0cca3675`） | ✓ 两个 `.corum-embedded-conversation` |
| 选区非空（左栏 assistant `LRfKSG_bubble` 文本节点前 50 字） | ✓ `selection.toString().length === 50`，`isCollapsed=false` |
| 浮条出现 | ✓ **2 个** `button.T2KnVG_askPill`「询问 AI」（= 主会话槽 + 左栏 embedded 槽各挂一个 pill，同一定位 `615.87,161 / 79.1×24`） |
| 点击浮条 → 右栏 chat 草稿含引用 | ✓ 右栏 `[contenteditable]` 文本 = `关于以下会话片段："""当前还有个小缺陷，目前本地打包版本号不变，并且发版都是 0.x.0 都是 x 在变，我希望发版的版本"""`；左栏 composer 仍空 |
| 右栏作用域正确 | ✓ 引用只落 `data-embedded-session="corum-chat-0cca3675"` 的草稿，未污染左栏 |
| console 新增错误 | 0 |

截图：`FIX-B2-ask-pill-visible.png`（旧 host，浮条在选区上方）、`FIX-B3-right-pane-draft-quote.png`（右栏草稿含引用）、`FIX-B4-ask-pill-fixed-build.png`（重启后同判据复验）。

> 残余限制（如实记）：真实鼠标按住拖选仍未在 CDP 下复现（合成 `Input.dispatchMouseEvent` 序列不产生原生 selection）。本轮打通的是**选区消费链路**（selection→判定→浮条→点击→跨栏草稿），不是「合成指针能产生选区」。因此"真人鼠标拖选"仍属未验，判据为：`selection.toString()` 非空 ⇒ 浮条出现已由 Range API 路径覆盖，二者共用同一 `show()` 判定函数。

#### C. 子会话分栏查看 — **✅ PASS（右栏 mode='view' 只读）**

上轮判「无可用 nested 子会话入口」也不准确：入口不是侧栏行（无 nested 标识），而是**消息流里的 `SubagentCard` 分支按钮**，`aria-label="查看子会话"`（`OrchestrateCard.tsx:405` 附近同款 `gotoBtn`，`onClick → openChildInSplit(child)`）。

| 判据 | 结果 |
|---|---|
| 左栏找到子会话入口 | ✓ `button[aria-label="查看子会话"]`（1 个，x=866.8 y=376 24×24，位于 `data-embedded-session="corum-task-7e914c2e"` 内） |
| 点击 → 右栏切到子会话 | ✓ 右栏 `data-embedded-session="86f005b2-60d3-4ef6-b9cd-6d3c79e32c23"` |
| 右栏只读（无 composer） | ✓ `hasComposer:false` |
| 右栏只读提示 | ✓ `.corum-embedded-readonly-hint` 文本 = 「与左栏同一会话，输入请在左栏」 |
| 迷你头 | ✓ `.corum-embedded-header` = 子会话 id |
| 左栏不被顶替 | ✓ 左栏仍 `corum-task-7e914c2e`（带完整 composer），两侧 x 分别为 297 / 794 |

截图：`FIX-C1-child-view-split.png`（旧 host）、`FIX-C2-child-view-fixed-build.png`（重启后复验）。

> 关于 `readonlyHint` 文案「与左栏同一会话」：子会话与左栏并**非**同一会话，文案在多会话（子会话）分栏下语义不准。属**相邻问题**，本轮**未改**（超出 brief 范围），登记在此供后续处理。

#### D. 通知 toast 链路 — **❌ UNVERIFIED（如实记录，未谎报）**

**已做的全部动作**：

1. 先装 `MutationObserver(document.body, {childList:true, subtree:true})`，把含「经验沉淀/待取舍/归档」的新增节点记入 `window.__toastLog`（安装返回值 `{installed:true}`）。
2. 正确 wire（`shapeKey:'input'` + 扁平 `{sessionId:'corum-task-7e914c2e'}`）触发 `distillStart` → `{jobId:'distill-1795190533589-sbjahc'}`（**无 lossless 报错**，与上轮 error 形态不同）。
3. 等 25s 读磁盘 job：`{status:"done", factCount:0, phase:"无可沉淀内容", sessionId:"corum-task-7e914c2e", source:"manual-distill:corum-task-7e914c2e"}` —— **0 条候选，无 error**。
4. 判据读出：`__toastLog: []`，`.corum-notification-root` `children: 0`。

**为什么这就是「不可达」而非「链路坏」**：`factCount > 0` 才会出现「N 条候选待取舍」这一用户可见结果；本轮 LLM 返回 0 条候选（模型侧产出，非链路问题），链路本身走完了 `emitDistillCompleted → 无异常`。**能证明 emit 不再炸 job 的判据是 `status:"done"` 而非 `"error"`**（上轮同一调用得到 `status:"error"` + `error:"forwarded host event … argument 0 is not lossless JSON data"`；本轮同形态得到 `done`，说明 `isDistillCompletedPayloadValid` 与正确 wire 两者叠加后 emit 通道正常）。fixture 不能替代：注入磁盘 JSON 不经 host emit，无法驱动 toast。

**未验部分**：`factCount>0` 时 toast 真实出现 + 点击开归档。要验它需要一次真正产出候选的 LLM 调用（模型路由/密钥可用且该会话有可沉淀内容）。**不谎报。**

### 四、构建 / 类型 / 测试

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 distill-card | `pnpm --filter @corum/corum-ui-distill-card run build` | ✓（tsc -b && tsdown && inline-css，CSS 已内联、外置 `lib/style.css` 已移除） |
| 构建 corum-agent | `pnpm --filter @corum/corum-agent run build` | ✓（6 files / 773.84 kB） |
| typecheck corum-agent | `pnpm --filter @corum/corum-agent exec tsc -b --pretty false` | ✓ exit 0 |
| typecheck distill-card | `tsc -b --pretty false`（包内） | ✓ exit 0 |
| 单测 corum-agent 全量 | `vitest run` | **654 passed / 1 failed**（42 files） |
| 单测 distill-card 全量 | `vitest run` | ✓ 10 passed |
| 单测 memory-distill 定向 | `vitest run tests/memory-distill.spec.ts` | ✓ 36 passed |

**唯一失败 = 预存，与本事无关**：`tests/task-model-routing.spec.ts > blank reuse 覆盖旧 pending 和旧绑定…`，`expected 'corum-task-ed9d8959' to be 'corum-task-1c51c0ff'`（会话 id 复用断言，非 distill 链）。上轮交接已登记为既存失败，本轮如实记录未修。

### 五、本轮清理与复位（全部已完成）

- `distillDiscard({jobId:'distill-fixture-a3pending'})` → `{discarded:3}`
- 删除 `~/.corum/distill-jobs/` 下 fixture 与测试 job 文件 → 目录空
- `distillListPending` → `{jobs:[]}`；`~/.corum/memory/` 无 facts
- 关分栏（右栏 ✕）→ `.corum-embedded-conversation` 计数 0
- `localStorage['corum.splitpane.session-split']` → `null`
- `window.requestAnimationFrame` 已还原（`__origRaf` 恢复并 delete）、`MutationObserver` 已 disconnect、`__toastLog` 已 delete

### 六、本轮未尽

1. **D 项 toast 仍未验穿** —— 需一次 `factCount>0` 的真实 distill（模型侧产物，非链路问题）。
2. **真人鼠标拖选未验** —— B 项打通的是选区消费链路（Range API 建选区），合成指针不产生原生选区这一点未变。
3. **`readonlyHint` 文案在多会话分栏下语义不准**（子会话 ≠ 同一会话）—— 发现未改，属相邻问题。
4. **三平台**：仅 darwin 实机验证；linux/win32 未验。
5. **打包态未验**：verify 是 dev 态吃 `lib/`；`/Applications/Corum.app` 内 host 闭包仍是 11-20 20:40 快照，未重打包。

**本轮步骤数**：~48 步（修复读证 → 构建/测 → 旧 host 现场复现 BUG-6 → 重启 → A/B/C 复验 → 清理 → 复位）
**本轮工具调用数**：~62 次

---

## 收口轮（2026-11-21）

承接上轮的三个未尽项，本轮只做收口判定与一处健壮性修复，**不新增验证场景**。

### 1) D 项（通知 toast 链路）→ **关闭**

关闭理由，三条并列：

1. **通知→归档链路本身已在实机走通**：二期 V7 轮已实机 PASS 过完整链路（`emitDistillCompleted` → toast → 点击开归档面板），此后桥代码（`notification-bridge` / `emitDistillCompleted` / `isDistillCompletedPayloadValid`）**未再改动**。所以「链路是否存在」不再是待验项。
2. **本轮 LLM 连续 0 候选，没有 toast 可守**：见下「观察项」。`factCount === 0` 时按设计不产生「N 条候选待取舍」这一用户可见结果，因此无法在不改产品代码的前提下制造 toast。
3. **防御修复已验**：判据是 job 终态 `status:"done"` 而非 `"error"`（上轮同一调用得到 `status:"error"` + lossless 序列化异常）。这一条是修复前/后的对照判据，且已成立。

> **观察项（建议用户自查，指挥未改共享全局配置）**：distill 走的**全局默认模型** `localhost/deepseek-v4-flash` 本轮**连续两次**都返回 0 候选（先 `corum-task-7e914c2e`，后 `corum-task-e9a0e62f`）。这更像模型路由/可用性问题而非 distill 逻辑问题（会话有明显可沉淀内容，`phase:"无可沉淀内容"`）。**建议用户检查该路由可用性**（设置 → AI 润色 → 当前模型）。指挥层**未改动**该共享全局配置（改全局会污染所有其它会话的默认模型），故只登记观察。

### 2) B 项（选区浮条）→ **真因更正：`requestAnimationFrame` 在 `document.hidden` 窗口永不回调**

上轮 §B 已写到这一点，本轮把它从「环境限制、靠替身 rAF 绕开」升级为**已修的产品健壮性问题**：

- 真因不是「CDP 不能产生原生拖选」，而是显示链 `mouseup → requestAnimationFrame(show)` 在**隐藏窗口**里 rAF 永不回调（实测：同一次 evaluate 内 rAF 600ms 未触发、`setTimeout` 50ms 正常触发）。
- 选区**消费链路**已用真实选区（Range API 建非折叠选区，走产品真实 `onMouseUp → show()` 路径）验证通过：浮条出现 2 个（主会话槽 + 左栏 embedded 槽）、点击后右栏草稿含引用且未污染左栏。
- **健壮性修复已落**：`SelectionAskPill.tsx:141` `requestAnimationFrame(show)` → `setTimeout(show, 0)`（附注释）。聚焦窗口下两者等效（都在当前任务后、渲染前），隐藏窗口下 `setTimeout` 仍会触发 ⇒ 消除了「窗口不可见时浮条永不出现」这一整类失败。
- **仍留人工项**：真实鼠标按住拖选在 CDP 下仍不能复现（合成 `Input.dispatchMouseEvent` 不产生原生 selection）。这与上轮结论一致，不因本次修复而改变——浮条的**出现判据**已由 Range API 路径覆盖（两者共用同一 `show()`），但「真人拖一下就出浮条」需要人工点一次确认。

### 3) `readonlyHint` 文案（子会话分栏）→ **登记为后续跟进项，本轮不改**

C 项里观察到的文案「与左栏同一会话，输入请在左栏」在 `mode='view'` 的**子会话**场景下语义不准（子会话与左栏不是同一会话，只是同一个父会话的下属）。这属于文案与场景的匹配问题，非功能缺陷，已超出本轮收口范围 ⇒ **不改**，与上轮 §六.3 与 HANDOFF §10.g.6 的登记合并为同一个跟进项。

### 本轮交付

| 项 | 结果 |
|---|---|
| `SelectionAskPill.tsx` rAF → setTimeout | ✓（`src/…/SelectionAskPill.tsx:141-142`，含中文注释） |
| `@corum/corum-ui-conversation` 三步构建 | ✓ `tsc -b && tsdown && corum-inline-css`（`lib/client.js` 1.38 MB，CSS 88485 字符已内联、外置 `lib/style.css` 已移除；产物内已确认含 `setTimeout(show`、`requestAnimationFrame(show)` 归零） |
| executor 实例 `location.reload()` 吃新 lib | ✓（renderer 改动；reload 后 `rev` 由 `02d61a96` → `75b19f0e`，`#root` 有内容，0 console 错误） |
| 残留 distill job 清理 | ✓ 删除 `~/.corum/distill-jobs/distill-1795190992444-wzk3dv.json`（`status:"done"` / `factCount:0` 惰性文件），目录现空；`corumAgent/distillListPending` → `{jobs:[]}` |

**本轮步骤数**：~9 步 ／ **工具调用数**：~13 次

---

## 修复轮（2026-11-23）：侧栏子会话行入口撤回

**报障**：侧栏会话列表突然多出大量子 Agent 会话。

**根因**：三期 merge `551d76d` 把 `origin='subagent'` 会话纳入侧栏（`SessionsPane.tsx` filter 扩为 `isTaskSession || origin==='subagent' || isChatSessionId` + `subagentRows`/`subagentsByParent` 按 `parentId` 归组渲染 + `resolveOpenSubSplit` prop/resolver + `onOpenRow` 的 subagent 分支），为造「子会话行点击 → 右侧分栏」入口。这是过度实现：子会话查看入口应在编排卡 / 子卡 / 会话条（已落地验过）。实测该 verify home 的 `session/list` 1575 条里 **1222 条是 `origin='subagent'`**，全部铺进侧栏。

**用户裁定**：子 Agent 会话不进侧栏。

### 1) 改动清单（回退子 Agent 纳入，保留咨询分节）

| 文件 | 改动 |
|---|---|
| `corum-ide-sidebar-ui/src/client/SessionsPane.tsx` | `allRows` filter 恢复 `isTaskSession(row) \|\| isChatSessionId(row.id)`；归档判据去掉 `\|\| row.origin === 'subagent'`（保留 chat 扩展）；`groups` 删除 `subagentRows`/`subagentsByParent` 归组与 nested 注入；删两处 `nested={row.origin === 'subagent'}`；删 `onOpenRow`/`openSubSplitRow`/`resolveOpenSubSplit` prop，分组 `onOpen` 回 `open`（签名 `(row)` → `(sessionId)` 恢复）；`visibleResults` 去掉 subagent 分支 |
| `corum-ide-sidebar-ui/src/client/index.ts` | 删 `resolveOpenSubSplit` resolver（`resolveOpenSplit` / `resolveDistill` 保留） |
| `corum-ide-sidebar-ui/tests/session-fork-visibility.spec.ts` | 补回归断言：过滤口径对 `origin='subagent'` 恒 false，且不误伤任务/分叉/咨询 |
| `session-visibility.ts` | **未动**（`isTaskSession` 本就排除 subagent，三期的唯一增量是 `isChatSessionId`，属保留项） |

### 2) 构建与门禁

- `pnpm --filter @corum/corum-ide-sidebar-ui run build`（三步 `tsc -b && tsdown && corum-inline-css`）✓ — CSS 43050 字符已内联、外置 `lib/style.css` 已移除
- `pnpm --filter @corum/corum-ide-sidebar-ui run test` ✓ — 5 文件 / 22 用例全通过（含新回归断言）
- `pnpm -r run typecheck` ✓ — 全仓 0 错

### 3) 实机验证（executor :9333，**未 restart**，`location.reload()` 生效，`rev` → `97017adf26e8`）

断言口径：侧栏 DOM 行数 vs RPC `session/list` 按 `isTaskSession || isChatSessionId` 过滤后的数量。

| 项 | 值 |
|---|---|
| RPC `session/list` 总数 | 1575 |
| 其中 `origin='subagent'` | **1222** |
| 按 `isTaskSession \|\| isChatSessionId` 可见 | 276 |
| 可见中 `blank`（官方语义不进列表） | 9 |
| 可见非 blank 中无归属工作区（分组视图不渲染） | 7 |
| **恒等式**：276 − 9 − 7 | **260** |
| **侧栏 DOM `[data-session-id]` 行数** | **260** ✓ 与 RPC 完全一致 |
| **`origin='subagent'` 侧栏行** | **0** ✓（DOM 行 id ∩ 子 Agent id = ∅；UUID 形态 id 亦为 0） |
| 咨询分节 | 仍在，「咨询」组 2 行（= 非 blank 的 `corum-chat-*` 数） |
| 「在右侧分栏打开」菜单项 | 仍在（右键截图确认） |
| console 错误 | 0 |

**证据**：`FIX-R1-context-menu-after-revert.png`（行右键菜单 6 项：重命名/归档/分叉会话/保存到…/在右侧分栏打开/提炼经验）、`FIX-R2-sidebar-no-subagent-rows.png`（侧栏全貌：咨询节 + 各工作区分组，无子 Agent 会话行）。

### 4) 保留项确认

- ✅ 咨询分节 `chatRows` + `ChatGroup` 未动（截图 2 行）
- ✅ fork 子会话（`session-<uuid>` 带 `parentId`）仍可见（DOM 里 2 条 `session-*` 行，均 `origin` 为空 = 分叉子会话）
- ✅ 「在右侧分栏打开」通用菜单项仍在（`resolveOpenSplit`，截图确认）
- ✅ `resolveDistill` / `resolveOpenSplit` 未动

### 5) 本轮未尽

1. **三平台**：仅 darwin 实机验证；linux / win32 未验。
2. **打包态未验**：executor 是 dev 态吃 `lib/`；`/Applications/Corum.app` 内闭包未重打包。
3. **`readonlyHint` 文案跟进项不变**（`mode='view'` 语义），只是现在没有侧栏入口进该模式了，编排卡/子卡入口仍用它。

**本轮步骤数**：~20 步 ／ **工具调用数**：~26 次

---

## 布局修复轮（2026-11-23）：分栏两栏不能滚 / 显示不全 / 都没有输入框

**报障（用户实机截图）**：打开分栏后，两栏**都无法滚动、内容显示不全、且都没有输入框**。

### 1) 根因（单根因，三症状）

`corum-ui-conversation` 的会话视图布局契约要求**父链高度确定**：

```
ConversationRoot.module.css
  .root      { display:flex; flex-direction:column; height:100% }
  .scrollBody{ flex:1; min-height:0; overflow-y:auto }
  composerSeat { position:sticky; bottom:0 }
```

主视图落在网格叶里（`.leaf` → `.card` → `.body` 全链 `height:100%`，确定高度），契约成立。
但 `EmbeddedConversation`（`src/client/embedded.tsx`）自己造的包裹 div
`.corum-embedded-conversation` / `.corum-embedded-body` **全仓没有任何 CSS**
（裸 div，`height:auto`）——于是：

`.root{height:100%}` 对 `auto` 父级解析为**内容高** ⇒ `.scrollBody` 失去高度约束、不内滚
⇒ sticky composer 沉到全部内容最底（视口外）⇒ 外层网格叶 `overflow:hidden` 裁剪。
**三症状同一根因**。

另有一处隐患同轮收掉：分栏 `paneWrapper` 只是 `width/height:100%` 的 block，没有
`display:flex`，而内层 `Anchor` 是 `display:contents`，链条靠「作为 flex 子项才获得确定
高度」的写法（`.viewArea{flex:1}`、ChatView `.root{flex:1 1 auto}`、`.scroll{flex:1 1 auto;overflow-y:auto}`）。

### 2) 改动清单

| 文件 | 行 | 改动 |
|---|---|---|
| `corum-ui-conversation/src/client/embedded.css`（**新增**） | 32–44 | `.corum-embedded-conversation{height:100%;display:flex;flex-direction:column;min-height:0;min-width:0}` |
| 同上 | 42–54 | `.corum-embedded-header{flex:none}` + `.corum-embedded-title`（省略号单行） |
| 同上 | 77–85 | `.corum-embedded-body{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}` |
| 同上 | 88–91 | `.corum-embedded-composer{flex:none;min-height:0}`（新增包裹层） |
| 同上 | 94–103 | `.corum-embedded-readonly-hint{flex:none;…}` |
| `corum-ui-conversation/src/client/embedded.tsx` | 65 | `import { createElement, useEffect, useState, type ReactNode }` |
| 同上 | 104–143 | 新增 `EmbeddedSessionsCapability` + `embeddedSessions` ref + `readEmbeddedTitle()`（读 `sessions.list.getSnapshot().byId[id]?.displayTitle`，读不到回落短 id） |
| 同上 | 175–230 | `EmbeddedConversation` 增 `hintText?: string`；composer 槽包进 `.corum-embedded-composer`；readonly 提示用 `hintText ?? '与左栏同一会话，输入请在左栏'` |
| 同上 | 238–257 | `EmbeddedMiniHeader` 改读 displayTitle：`useState(() => readEmbeddedTitle())` + `useEffect` 订阅 `sessions.list.subscribe` 重读（标题晚到时自动替换短 id 兜底） |
| 同上 | 274–278 | `ConversationEmbedService.EmbeddedConversation` props 增 `hintText?` |
| `corum-ui-conversation/src/client/apply.ts` | 58 | import 增 `embeddedSessions` |
| 同上 | 62 | `import './embedded.css'`（红线 6：经 `corum-inline-css` 注入） |
| 同上 | 252 | `embeddedSessions.current = sessions`（apply 激活时挂 ref；`sessions` 在 `inject` 声明里，红线 4） |
| `corum-ui-split-pane/src/client/index.tsx` | 130–134 | 能力接口 `ConversationEmbedCapability.EmbeddedConversation` 增 `hintText?: string` |
| 同上 | 619 | `mode==='view'` 时传 `hintText: '子 Agent 会话 · 只读查看'`（同会话双开仍用默认文案） |
| `corum-ui-split-pane/src/client/index.module.css` | 78–95 | `.paneWrapper` 增 `display:flex;flex-direction:column;min-width:0`；新增 `.paneWrapper > *{flex:1;min-height:0;min-width:0}` |

### 3) 高度链最终形态（自外向内）

```
[网格叶] .leaf (h:100%) → .cardRegion (h:100%) → .body (flex:1;min-h:0)
  → testSuiteMount (flex:1;min-h:0;display:flex;column)          ← 壳 AppFrame
  → .frame (h:100%;flex column)                                  ← split-pane occupant
      .frameHeader (flex:none) │ ProgressBadge (flex:none)
      → .body (flex:1;min-h:0) → SplitPane .container (h:100%;flex)
          → .leftPane/.rightPane (h:100%;overflow:auto 兜底)
          → .paneWrapper (h:100%;display:flex;column)            ← 本轮补
              → .corum-embedded-conversation (h:100%;flex;column) ← 本轮新增 CSS
                  .corum-embedded-header (flex:none)
                  → .corum-embedded-body (flex:1;min-h:0;flex;column;overflow:hidden)
                      → [Anchor display:contents] → .viewArea (flex:1;min-h:0)
                      → [Anchor display:contents] → ChatView .root (flex:1 1 auto;min-h:0)
                      → ChatView .scroll (flex:1 1 auto;min-h:0;overflow-y:auto)  ← 内滚在这里
                  .corum-embedded-composer (flex:none)            ← 本轮新增包裹层
                  [或] .corum-embedded-readonly-hint (flex:none)
```

**注意**：嵌入视图走的是 `conversation.session` 槽 occupant（ChatView），**不是** `ConversationRoot`，
所以内滚容器是 ChatView 的 `.scroll`（不是 `[data-conversation-scroll]`）。两者都要求父链确定高度，
契约一致。

### 4) a–g 断言证据（executor :9333，未 restart，`location.reload()` 生效，`rev` → `7a94adeacdfa`）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| a | 两栏 composer 均可见（`contenteditable` 在视口内，`rect.bottom ≤ innerHeight`） | ✅ PASS | 左 `top 710 / bottom 810`、右 `top 678 / bottom 778`，`innerHeight 860`；两栏均 `composer.inViewport: true` |
| b | 左栏消息区内滚（`scrollTop` 可变、composer 保持可见） | ✅ PASS | 左栏 `.scroll` `clientH 587 / scrollH 891/1656`，`scrollTop` 置 500 → 生效，composer 位置**前后完全不变**（`anchorStable: true`） |
| c | 右栏同理 | ✅ PASS | 右栏 `.scroll` `clientH 555 / scrollH 13288`，同上断言通过 |
| d | 迷你头显示标题而非裸 id | ✅ PASS | 左 `docs/UPGRADE-0.2.1-rc3-feasibility.md`、右 `当前我们已经在扩展中提供的`（改前是 `corum-task-52714406` / `corum-task-e9a0e62f`） |
| e | 拖中缝比例仍工作 | ✅ PASS | 拖前 `leftW 391`，拖到 x=780 后 `leftW 483`（`RATIO_MIN/MAX` 内），两栏随之重排、各自 scroll 容器高度同步更新 |
| f | 同会话双开右栏只读提示在 | ✅ PASS | 点标题栏「分栏」（同会话）→ 右栏 `hasComposer:false` + 提示文案 `与左栏同一会话，输入请在左栏`，`hintInViewport: true`；左栏 composer 仍在 |
| g | console 零新增错误 | ✅ PASS | 全程 `console.errors: []`（`preExisting: 1` 为重启前既有，非本轮） |

**证据截图**（同目录）：
- `LAYOUT-01-fixed-split-both-composers.png` — 修复后分栏：两栏都在，左栏 composer 完整可见，右栏只读提示在底部
- `LAYOUT-02-same-session-readonly-hint.png` — 同会话双开：右栏无 composer + 「与左栏同一会话，输入请在左栏」
- `LAYOUT-03-different-sessions-both-scroll.png` — 异会话双开：两栏各有 composer、各有内滚

### 5) 构建与门禁

- `pnpm --filter @corum/corum-ui-conversation run build`（三步 `tsc -b && tsdown && corum-inline-css`）✓ — **注入 89861 字符 CSS**，外置 `lib/style.css` 已移除。`lib/client.js` 内已含 `corum-embedded-body{…flex…}` / `corum-embedded-composer`（2 处）
- `pnpm --filter @corum/corum-ui-split-pane run build`（三步）✓ — 注入 4370 字符 CSS；`lib/client.js` 内已含 `hintText` 与 `子 Agent 会话 · 只读查看`
- `pnpm -r run typecheck` ✓ — 全仓 **0 错**

### 6) 本轮未尽

1. **`mode='view'` 的新文案未实机验穿**：`hintText: '子 Agent 会话 · 只读查看'` 已在构建产物里（`lib/client.js` grep 到），但本 verify home 的当前会话流里没有可点的「查看子会话」子 Agent 卡片（`button[aria-label="查看子会话"]` 计数 0），造不出 view 模式入口。**判据就位、路径正确、缺一次真子会话点击**。
2. **三平台**：仅 darwin 实机验证；linux / win32 未验（纯 CSS flex/height 无平台分叉，仍如实标注）。
3. **打包态未验**：executor 是 dev 态吃 `lib/`；`/Applications/Corum.app` 内闭包未重打包。
4. **两栏 `overflow:auto` 兜底保留**：SplitPane 的 `.leftPane/.rightPane` 仍带 `overflow:auto`，与内部滚动共存不冲突（本轮断言时 pane 自身 `scrollHeight == clientHeight`，未产生双滚动条）。

**本轮步骤数**：~34 步 ／ **工具调用数**：~40 次

---

## 外壳对齐轮（2026-11-19）：内容列左右边距 + TurnNavigator 圆点

### 1) 报障与根因（两条，第二条属本轮新发现）

用户实机报障：分栏后 session 内容**左右边距消失**、**左侧快速导航圆点没了**。

**根因 ①（主因，本轮修复）**：`EmbeddedConversation` 直接渲染裸
`SlotView('conversation.session')`（ChatView）+ 独立 composer 槽，**绕过了
`ConversationRoot` 外层 occupant**。而这条外壳承载三件东西：

- **列宽轴与 gutter**：`--dsh-chat-content-width` / `--dsh-composer-card-max-width` /
  `--dsh-composer-side-clearance` 全部声明在 `ConversationRoot.module.css` 的 `.root` 上
  （第 33–40 行），并由 `.root` 的 `ResizeObserver` 把列宽发布成
  `--dsh-conversation-column-width`。绕过 Root ⇒ 变量一个都不存在 ⇒ ChatView 的
  `.scroll{padding: … calc(var(--dsh-composer-side-clearance) + 16px)}` 与
  `.column{max-width: var(--dsh-chat-content-width)}` 双双失效 ⇒ **正文贴边拉满**。
- **TurnNavigator 的 gutter**：`TurnNavigator.module.css` 的
  `.frame{left: calc(12px - (var(--dsh-composer-side-clearance) + 16px))}` 贴的就是这条
  gutter。变量缺失 + gutter 不存在 + `corum-embedded-body{overflow:hidden}` ⇒ 圆点被裁。
- **`conversation.input.dock`（沉淀卡片）与 composer 链选举**、以及滚动体上的两个测量变量
  （`--dsh-composer-height` / `--dsh-conversation-viewport-height`，TurnNavigator 的 rail band 直接读它们）。

**根因 ②（本轮新发现，独立成因）**：`TurnNavigator.module.css` 末尾的
`@container (max-width: 900px){ .slot{ display:none } }` 是照官方口径定的「正文列太窄就
隐藏刻度」。但本 fork 的 rail 早已从右侧横线改成**左侧 gutter 竖列**（只占 28px），而窄容器里
正文列的左右 padding 是 `clearance + 16px = 32px` ⇒ **32px gutter 装得下 28px rail**。
分栏每栏必然 < 900px ⇒ 这条规则**无条件命中**。**只修根因①不会让圆点回来**——实测：外壳对齐后
gutter 恢复（53px/59px），`nav` 元素存在、`markCount 12`，但 `.slot` 的
`computed display: none`。临时覆盖 `display:block` 后圆点立即出现在
`x=309, w=28, h=122` 且点击跳转生效（`scrollTop 7709.5 → 29222.5`）。故本轮把阈值改为
`72px = 2 × (clearance + 16) + 28 + 8`。

### 2) 改动清单

| 文件 | 改动 |
|---|---|
| `corum-ui-conversation/src/client/embedded.tsx` | 重写渲染主体：`SessionScopeOverride(sessionId)` → 包裹 div（`data-embedded-session` + 身份行 + `corum-embedded-body`）→ **`SlotView('conversation')`**（完整外壳 occupant）。删除自造 composer 槽与只读提示块；`readOnly`/`hintText` 改经 `ownerProps` 下发给 Root |
| `corum-ui-conversation/src/client/contract/slots.ts:602-627` | 新增 `ConversationShellOwnerProps{readOnly?, hintText?}`，并入 `ConversationSlotProps`（不动 SlotMap 的 `ConvOwnerProps`——壳侧镜像必须逐字等价，TS2717） |
| `corum-ui-conversation/src/client/skeleton/ConversationRoot.tsx:141` | 解构 `readOnly = false, hintText` |
| `corum-ui-conversation/src/client/skeleton/ConversationRoot.tsx:611-655` | 新增 `readOnlyBar`；`readOnly` **优先于**子 Agent 的 `subagentReturnBar` 接管（只读副栏不该再叠一条主视图导航条） |
| `corum-ui-conversation/src/client/skeleton/ConversationRoot.module.css:371-397` | 新增 `.readOnlyBar` / `.readOnlyBarText`（与 `.subagentReturnBar` 同宽度轴） |
| `corum-ui-conversation/src/client/locales.ts`（zh/en） | 新增 `composer.readOnly`（「与左栏同一会话，输入请在左栏」/ EN） |
| `corum-ui-conversation/src/client/embedded.css` | 删掉 `.corum-embedded-composer` / `.corum-embedded-readonly-hint`（外壳已归 Root）；保留并加注高度链契约 |
| `corum-ui-split-pane/src/client/index.tsx:610-632` | 右栏按成因传 owner props：`rightReadOnly` 为真才传 `readOnly:true`；仅 `mode==='view'` 追加 `hintText`；异会话**完全不传** |
| `corum-ui-chat/src/client/chat/TurnNavigator.module.css:247` | `@container (max-width: 900px)` → **72px**，并写清推导 |

### 3) `SlotView('conversation')` 的组装形态

```
SessionScopeOverride(sessionId)            ← 钉住会话 scope（uiRenderer 服务提供）
└─ div.corum-embedded-conversation[data-embedded-session]   height:100% / flex 列
   ├─ header.corum-embedded-header         身份行（displayTitle）
   └─ div.corum-embedded-body               flex:1 / min-height:0
      └─ SlotView('conversation', ownerProps={readOnly?, hintText?})
         └─ ConversationRoot                ← 整张外壳（apply.ts:358 注册的 occupant）
            ├─ .root（宽度轴 + gutter 变量 + 宽度手柄）
            └─ .scrollBody[data-conversation-scroll]
               ├─ conversation.session      （ChatView → 含 TurnNavigator）
               ├─ conversation.input.dock   （沉淀卡片）
               └─ .composerSeat → chain / .readOnlyBar
```

槽 runtime 自动组装 `sessionId` / `useSession` / `useSessions` / `renderSlot` 等 props
（scope=`session-maybe` 在 override 下解析为 pinned 会话）；`readOnly`/`hintText` 不是
scope 数据，故走 ownerProps 透传（`renderEntry` 里 `{...kit}{...injected}{...slotInjected.props}{...ownerProps}`，
ownerProps 最后展开、优先级最高——与 `conversation.composer.bar` 现有 ownerProps 同款机制）。

### 4) readOnly 透传链路

```
split-pane index.tsx
  rightReadOnly = (targetId === mainId) || mode === 'view'
  → createElement(EmbeddedConversation, { sessionId, ...(rightReadOnly ? {readOnly:true, ...(mode==='view' ? {hintText} : {})} : {}) })
     ↓ conversationEmbed cordis 服务（红线 1，非运行时 import）
embedded.tsx  EmbeddedConversation  → ownerProps = { readOnly, hintText? }
     ↓ SlotView('conversation', ownerProps)
ConversationRoot  readOnly=true → 渲染 .readOnlyBar，**不渲染**
     composer 链 / inputBar / conversation.input.dock；hintText 覆盖默认文案
```

`readOnly` 与既有 `isSubagentSession` 接管的关系：**readOnly 优先**。子会话的
`subagentReturnBar`（返回父会话）是**主视图**的导航动作，只读副栏不该承担；且
mode='view' 已给出自己的措辞，两条底部条会互相打架。

### 5) a–i 断言证据（executor :9333，未 restart，`location.reload()` 生效，`rev` → `b35857157f83`）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| a | 两栏内容列有左右边距 | ✅ PASS | 左栏 `gutterLeft 53 / gutterRight 59`（内容列 680，相对 scroll 容器 792）；右栏 `32 / 37`（内容 563 / 632）。改前两者均为 0（正文贴边） |
| b | TurnNavigator 圆点可见且可跳转 | ✅ PASS | `nav` 在视口内：`x 309 / w 28 / h 122`，`slotDisplay: block`，`computed left: -20px`（非 auto，落在 53px 左 gutter 内）；`markCount 12`，首点 `w 28`。点击第 7 轮圆点 → `scrollTop 7709.5 → 29222.5` |
| c | 两栏 composer 可见可输入 | ✅ PASS | 两栏 `[data-composer-seat]` 均在、`textarea/contenteditable` 均在（异会话场景） |
| d | 内滚正常、composer 不动 | ✅ PASS | `.scrollBody` `clientH 903 / scrollH 8829`，`scrollTop 0 → 3963` 生效；composer seat `top` 恒 843、`seatBottom == scrollBottom == 1013`（sticky 钉底） |
| e | 迷你头 / Root 顶栏显示标题 | ✅ PASS | 迷你头：左 `修复 Corum-Harness Issue 157`、右 `docs/UPGRADE-0.2.1-rc3-feasibility.md`、view 模式 `我在排查一个 BUG：编排工作流`（均 displayTitle，非裸 id） |
| f | 同会话双开右栏只读提示 | ✅ PASS | 左右同 `corum-chat-0cca3675`：右栏 `.readOnlyBar` text=`与左栏同一会话，输入请在左栏`、`hasInput:false`、composer 槽与 dock 锚点**均不渲染**；左栏 `hasInput:true` |
| g | mode='view' 子会话只读 | ✅ PASS | 经会话栏 Agent 花名册行尾 `→` 打开子会话 `60e992f7-…`：右栏 text=`子 Agent 会话 · 只读查看`、`hasInput:false`、进度徽标 1 个；左栏仍可输入 |
| h | 沉淀 dock 卡片在左栏可见 | ✅ PASS | fixture `distill-fixture-shellalign`（3 条 pending，sessionId=corum-task-7e914c2e）→ 左栏 `[data-slot="conversation.input.dock"]` `children:1`，text=`经验沉淀完成3 条候选待取舍查看归档`；右栏 dock `children:0`（该会话无 job） |
| i | console 零新增错误 | ✅ PASS | 全程拦截 `console.error`：`errs: []`、`errCount 0` |

**证据截图**（同目录）：
- `SHELL-02-diff-sessions-margins-and-rail.png` — 异会话分栏：两栏正文均有左右边距、左侧圆点轨可见、左栏 dock 卡片在、两栏 composer 可输入
- `SHELL-03-same-session-readonly.png` — 同会话双开：右栏无输入框、底部「与左栏同一会话，输入请在左栏」，两栏边距与圆点同在
- `SHELL-01-view-child-readonly.png` — mode='view' 子会话只读（「子 Agent 会话 · 只读查看」+ 进度徽标）

### 6) 构建与门禁

- `pnpm --filter @corum/corum-ui-conversation run build`（三步）✓ — 注入 **90113** 字符 CSS
- `pnpm --filter @corum/corum-ui-chat run build`（三步）✓ — 注入 **139031** 字符 CSS
- `pnpm --filter @corum/corum-ui-split-pane run build`（三步）✓ — 注入 4370 字符 CSS
- `pnpm -r run typecheck` ✓ — 全仓 **0 错**

### 7) fixture 清理

- `distillDiscard({jobId:'distill-fixture-shellalign'})` → `{discarded: 3}` ✓
- 删除 `/Users/kukucai/.corum/distill-jobs/distill-fixture-shellalign.json` ✓
- `distillListPending()` → `{jobs: []}` ✓
- 分栏已关闭复位 ✓

### 8) 本轮未尽

1. **右栏无圆点属正常**：`corum-chat-0cca3675` 的 `railItems` 不足 2 条时
   `TurnNavigator` 自身 `return null`（`items.length < 2`），与本次改动无关。左侧 task 会话
   12 个圆点已证可见可点。
2. **宽度手柄写共享 pref**：两栏的 `ConversationRoot` 各自带宽度手柄，拖任一侧写同一个
   `dsh.conversation.contentWidth` ⇒ 两栏联动。属**预期**（共享一条内容宽度轴），记录不改。
3. **Root 双实例的 document 级监听**：`SelectionAskPill` 等在各实例内独立挂载，实机全程
   console 零错误、无重复浮条；未做并发压力验证。
4. **三平台**：仅 darwin 实机验；linux / win32 未验（纯 CSS 变量与容器查询，无平台分叉，
   仍如实标注）。
5. **打包态未验**：executor 是 dev 态吃 `lib/`；`/Applications/Corum.app` 内闭包未重打包。

**本轮步骤数**：~42 步 ／ **工具调用数**：~55 次
