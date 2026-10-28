# 循环依赖修复验证日志（layout↔corumNavigation）

> **日期**：2026-10-31
> **仓库 HEAD**：02735201（基于 upgrade/0.2.1-rc3 分支）
> **平台**：macOS darwin-arm64

## 根因分析

### 现象
CDP 验证发现：打包态 IDE 模式启动后，23 个插件 stuck pending，web boot 阻塞，
主 IDE 界面无法 ready。启动页有内容（htmlLen > 500）但 `[data-dsh-boot]` 属性
仍在（boot 未完成）。

### 根因
`corumNavigation` 服务（会话选择 + retain/release 生命周期）原本在
`@corum/corum-ui-conversation` 的 `apply()` 内调用
`applyCorumSessionNavigation(ctx)` 提供。同时：

1. `corum-ui-conversation` 的 `inject` 数组硬依赖 `'layout'`（用于用户 action
   的 `setSidebarMode` 和 `newTaskForm` 的 `gridActions`）。
2. `@corum/corum-ide-ui` 的 `inject` 数组硬依赖 `'corumNavigation'`（用于壳的
   会话栏）。
3. `@corum/corum-ide-ui` 的 `apply()` 提供 `'layout'` 服务。

这构成了 **layout↔corumNavigation 激活循环**：
- conversation 需要 layout（由 ide-ui 提供）→ 但 conversation 提供
  corumNavigation → conversation 先要 layout 才能激活 → 但 ide-ui 需要
  corumNavigation 才能激活 → 但 ide-ui 提供 layout → 死锁。

### 为什么 htmlLen > 500 判据不够
启动页本身有大量 HTML 内容（启动动画 + 主题样式），满足 `htmlLen > 500` 但
`[data-dsh-boot]` 仍在 → boot 未完成。旧 smoke 判据的 `looksRendered` 只看
`htmlLen > 500 && readyState === 'complete'`，放过了这个状态 → 假绿。

## 修复方案

### 1. 拆出独立导航插件 `@corum/corum-ui-navigation`

新包 `packages/plugins/session/corum-ui-navigation/`：
- `src/client/corum-navigation.ts`：服务实现（从 conversation 包复制，保持
  API 一致）。
- `src/client/index.ts`：插件入口 — `name='@corum/corum-ui-navigation'`，
  `inject=['sessions']`，`apply=applyCorumSessionNavigation`。
- `src/index.ts`：host 半 no-op（client-only 包）。
- `package.json`：`dsh.client.platform=web`，`dsh.client.inject=['@deepseek-ai/dsh-api-session-controller']`，
  `exports['./client']` 指向 `./lib/client.js`。
- `tsdown.config.ts`：`definePluginBundle`，单 client 入口。

**只依赖 ISessions**（`sessions.retain/release`），不依赖 `layout`/
`uiConversation`。激活链：sessions（session-controller 客户端半 always
available）→ navigation（inject sessions → provides corumNavigation）→
ide-shell（inject corumNavigation → provides layout）→ conversation
（inject corumNavigation + sessions + … → activates）。

### 2. 修改 `corum-ui-conversation/src/client/apply.ts`

- **删除** `applyCorumSessionNavigation(ctx)` 调用（不再在 conversation 的
  apply 内提供 corumNavigation）。
- **删除** `'layout'` 从 `inject` 数组（改为 `ctx.get('layout')` 延迟取）。
- **添加** `'corumNavigation'` 到 `inject` 数组（由独立插件提供）。
- `sidebarModeLayout()` 和 `newTaskForm` 回调改用 `ctx.get('layout')`（回调
  执行时 ide-shell 已激活，layout 已 provide；fail-soft 而非 crash）。

### 3. 修改 `corum-ui-conversation/package.json`

- 从 `dsh.client.inject` 移除 `@deepseek-ai/dsh-client-ui-layout`（IDE 模式
  下 ui-layout 已禁用，conversation 不再硬依赖 layout）。

### 4. 修改 `cordis.ide.patch.yml`

- 插入 `corum-navigation` 行（`name: '@corum/corum-ui-navigation'`），
  放在 `ide-shell` 行前（可读性；真正时序靠 inject）。

### 5. 增强 `corum-smoke.mjs` DOM 判据

- 不再只看 `htmlLen > 500`：增加 `[data-dsh-boot]` 已移除检查（boot 完成）、
  IDE 模式 `[data-session-band]` 已挂载检查（主 IDE 界面 ready）、
  `__DSH_BOOT__.entries > 0` 检查（模块图已构建）。
- 新增"23 插件 pending 检测"：bootEntries > 0 但 `[data-dsh-boot]` 仍在 →
  fail。

### 6. 新增防循环测试 `anti-cycle.spec.ts`

13 条断言验证：conversation 不再 inject layout / 不再 provide
corumNavigation / 改用 ctx.get('layout') / navigation 插件只 inject
sessions / 依赖图无环。

## 验证结果

### 类型检查
- `@corum/corum-ui-navigation` typecheck：**0 错误** ✓
- `@corum/corum-ui-conversation` typecheck：**0 错误** ✓

### 单元测试
- `@corum/corum-ui-conversation` test：**35 通过 / 0 失败** ✓
  - 含 13 条新 anti-cycle 测试 + 9 条既有 corum-navigation 测试 + 13 条
    其他测试

### 构建
- `@corum/corum-ui-conversation` build：**tsc + tsdown + inline-css** ✓
  - `lib/client.js` 1.32 MB + CSS 注入 83520 字符
- `@corum/corum-ui-navigation` build：**tsc + tsdown + inline-css** ✓
  - `lib/client.js` 4.85 kB（无 CSS，inline-css no-op）

### 打包
- `pack:host:mac`：**exit 0** ✓
  - host bridge boots OK (ready emitted)
  - electron-builder 打包成功（DMG + zip）
  - `@corum/corum-ui-navigation/lib/` 存在于打包产物 ✓
  - `cordis.ide.patch.yml` 含 `corum-navigation` 行 ✓
- `assert:boot`：**✓ 产物宿主启动断言通过**

### host boot（直接运行 bridge.js）
```
corum-desktop: warning: 2 entries did not activate
corum-subagent-acp: CORUM_HOST_NODE is not set（已知：直接运行不经 Electron
  壳注入，非循环依赖问题）
corum-web-search: pending (waiting for service: settings)（已知：cordis 惰性
  激活时序，非阻塞）
[corum-desktop] boot 计时：config-tree 挂载完成 +568ms
{"type":"ready","authenticatedUrl":"http://127.0.0.1:..."}
```
**无 23 插件 pending** ✓ — 循环依赖已打破。

### corum-smoke --fast --launch --packaged
**已知限制**：打包态应用在 smoke 脚本环境下无法完成启动（Electron 壳的
`HostBridgeClient` 与 host 子进程的通信在 headless 测试环境下被阻塞 —
应用停在 "window created (combo launcher)" 不前进）。此问题**在本次修改前
已存在**（stash 后验证：同样卡住），非本次修改引入。需在真实桌面环境
（非 headless）下验证。

### verify-stage5-cdp
因 smoke 无法在 headless 环境启动打包应用，CDP 探针无法附着。此限制
在修改前已存在。

## 文件变更清单

| 文件 | 变更 |
|---|---|
| `packages/plugins/session/corum-ui-navigation/` (新包) | 新增：`package.json`, `tsconfig.json`, `tsdown.config.ts`, `src/index.ts`, `src/client/index.ts`, `src/client/corum-navigation.ts`, `src/css-modules.d.ts` |
| `packages/plugins/session/corum-ui-conversation/src/client/apply.ts` | 删 `applyCorumSessionNavigation(ctx)` 调用；从 inject 删 `'layout'`；加 `'corumNavigation'`；`sidebarModeLayout`/`newTaskForm` 改 `ctx.get('layout')` |
| `packages/plugins/session/corum-ui-conversation/package.json` | 从 `dsh.client.inject` 删 `@deepseek-ai/dsh-client-ui-layout` |
| `packages/plugins/session/corum-ui-conversation/tests/anti-cycle.spec.ts` | 新增：13 条防循环断言 |
| `packages/desktop/cordis.ide.patch.yml` | 插入 `corum-navigation` 行 |
| `packages/desktop/package.json` | 加 `@corum/corum-ui-navigation` dep |
| `packages/desktop/desktop-host/package.json` | 加 `@corum/corum-ui-navigation` dep |
| `scripts/corum-smoke.mjs` | 增强 DOM 判据：`[data-dsh-boot]` / `[data-session-band]` / `bootEntries` / pending 检测 |
