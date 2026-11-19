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
