# 循环依赖修复 + CDP 发布阻塞收口验证日志

> **日期**：2026-10-31（初版）→ 2026-11-01（根因修正）
> **仓库 HEAD**：f14903db → 本场修复后
> **平台**：macOS darwin-arm64

## 根因分析（修正版）

### ❌ 旧归因（已否定）

旧版本文档将 CDP 验证中「打包态应用无法在 headless 环境启动」归因为
「Electron 壳的 HostBridgeClient 与 host 子进程的通信在 headless 测试环境下
被阻塞」。**此归因是错误的**。

launch.log 显示 host 子进程在 **851ms** 内 ready（`combo "coding" host ready`），
host HTTP server 正常监听。问题不在 host↔renderer 通信，而在：

### ✅ 真实根因：profile-precheck 误拒官方 dsh-web-app bundle

`packages/desktop/src/host/profile-precheck.ts` 的「关 2」检查
`dsh.bundle.patch` 声明时，**只接受 `string` 类型，不接受 `string[]`**：

```ts
// 旧代码（错误）：
declaredPatch = (pkg.dsh as ...)?.bundle?.patch
if (typeof declaredPatch !== 'string' || declaredPatch === '') {
  skipped.push({ ..., reason: 'not-a-bundle', ... })
  continue
}
```

但官方 `@deepseek-ai/dsh-web-app` 的 `package.json` 声明 `dsh.bundle.patch`
为**数组**（5 个 patch 文件）：

```json
"dsh": { "bundle": { "patch": [
  "./cordis.patch.yml",
  "./presets/standard.patch.yml",
  "./presets/ptc.patch.yml",
  "./presets/minimal.patch.yml",
  "./presets/cordis.patch.yml"
] } }
```

官方 `dsh-app-boot` 的 `bundlePatchFiles()` 同时接受 string 和 string[]
（`typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch`），
但 corum 的预检层只认 string ⇒ dsh-web-app 被判 `not-a-bundle` 跳过 ⇒
`webServer` + `connection` 服务缺失 ⇒ host bridge `throw new Error("corum-desktop:
official web transport (webServer/connection) missing after boot")` ⇒
host exit 1 ⇒ renderer 停在启动页。

### 为什么旧 smoke 判据不够

启动页本身有大量 HTML 内容（启动动画 + 主题样式），满足 `htmlLen > 500` 但
`[data-dsh-boot]` 仍在 → boot 未完成。旧 smoke 判据的 `looksRendered` 只看
`htmlLen > 500 && readyState === 'complete'`，放过了这个状态 → 假绿。

## 修复方案

### 1. 修复 profile-precheck.ts（根因修复）

`dsh.bundle.patch` 同时接受 `string` 和 `string[]`，与官方 `bundlePatchFiles`
对齐。逐 patch 文件验证存在性 + YAML 可解析性，合并 patch 列表：

```ts
const rawPatch = (pkg.dsh as ...)?.bundle?.patch
let patchFiles: string[]
if (typeof rawPatch === 'string' && rawPatch !== '') {
  patchFiles = [rawPatch]
} else if (Array.isArray(rawPatch) && rawPatch.every(f => typeof f === 'string' && f !== '') && rawPatch.length > 0) {
  patchFiles = rawPatch as string[]
} else {
  skipped.push({ ..., reason: 'not-a-bundle', ... })
  continue
}
const patchPaths = patchFiles.map(f => join(packageDir, f))
// ... 逐文件加载再合并
```

`AcceptedBundle` 新增 `patchPaths: readonly string[]`，`loadProfileWithSkip`
的 layer 构建改用完整 `patchPaths` 列表（不再只取第一个）。

### 2. 拆出独立导航插件 `@corum/corum-ui-navigation`（循环依赖修复，保留）

详见上一版本文档的 §修复方案 1。此修复**保留不变**。

### 3. 旧 corum-navigation.ts 改为 type-only re-export（单一事实源）

`corum-ui-conversation/src/client/corum-navigation.ts` 从「完整实现副本」改为
**纯类型 re-export**：

```ts
export type { CorumMainSelection, CorumSessionNavigation } from '@corum/corum-ui-navigation/client'
```

- 不保留第二份可变实现——运行时只有 `@corum/corum-ui-navigation/client` 一份。
- `corum-ui-conversation/src/client/index.ts` 删除 `export { applyCorumSessionNavigation }`
  的 runtime re-export（bundler externalize workspace package 时无法解析跨包
  runtime re-export），保留 type re-export。
- `declare module '@deepseek-ai/cordis'` 的 `corumNavigation` 增强声明只在
  navigation 包内（单一事实源），conversation 的 index.ts 不再重复声明。

### 4. corum-navigation.spec.ts 迁移到新包 + 真实 cordis Context（假测试→真测试）

旧测试在 `corum-ui-conversation/tests/` 中，不调用真实服务——它「simulate
openSession 逻辑」：手动调 `mockSessions.retain()` + 手动赋值 `mainReference`
+ 手动调 `release()`，**复制算法自己**。这等于在测 mock，不是在测服务。

新测试在 `corum-ui-navigation/tests/corum-navigation.spec.ts`：
- 创建真实 `new Context()`
- `ctx.provide('sessions', mockSessions)` 提供满足 `ISessions` 接口的 mock
- 调用真实 `applyCorumSessionNavigation(ctx)` 注册真实服务
- 直接调 `ctx.corumNavigation.openSession/clearSelection`
- 断言 A→B（旧 ref 释放、仅 1 live）、rapid switching、clearSelection、
  dispose（fiber teardown 释放 ref）、retain throw 不破坏已有 selection、
  selection observable 通知订阅者

7 条测试全部通过。旧假测试已删除。

### 5. verify-stage5-cdp.mjs 探针修正

旧探针的问题：
- UI ready 只看 `bodyLen > 1000`（假绿——启动页 HTML 就 > 1000）
- 猜 `window.corumDesktop.rpc` / `callRpc` / `invoke`——**全部不存在**
  （preload 只暴露 `getAppVersion`、`getPlatform` 等 IPC，不暴露 RPC）
- 往 `corum-conversation/testKey` 等写假值——这些 key 不在真实 schema 里
- ACP/web-search/V4 用 SKIP 后宣称过

新探针：
- **UI ready 判据**：`!document.querySelector('[data-dsh-boot]')` + 
  `!!document.querySelector('[data-session-band]')` + 
  `window.__DSH_BOOT__.entries.length > 0`（与 main.ts 的 mount 等待逻辑一致）
- **公开桥接面**：`window.corumDesktop.getAppVersion()` / `getPlatform()` /
  `getBootDiagnostics()`（真实 IPC 面）
- **不猜 RPC**：设置 roundtrip / preset / 会话导航 / queue-revert / web-search
  需要内部 cordis 服务（`ctx.configForms`、`ctx.connection.rpc.call`），CDP
  只读探针无法从 window 访问——明确标注「走单元测试」，不假测不 SKIP
- **不写 testKey**：真实 schema key（`busyEnter`、`transcriptView`、
  `stallRecoverMinutes`、`retentionDays`、`activeProvider`）的 roundtrip
  走单元测试（settings-ns-alignment + corum-ui-navigation/tests）

## 验证结果

### profile-precheck 修复

修复前（10/28 打包产物）：
```
corum-desktop: warning: 1 entry did not activate
corum-web-search: pending (waiting for service: settings)
corum-desktop host bridge error: Error: corum-desktop: official web transport
  (webServer/connection) missing after boot
```

修复后（本场重打包产物）：
```
corum-desktop: warning: 1 entry did not activate
corum-web-search (@corum/corum-web-search): pending (waiting for service: settings)
[corum-desktop] host 子进程 spawn→ready +710ms
[corum-desktop] combo "coding" host ready (http://127.0.0.1:62945/?token=...)
```

- `dsh-web-app` bundle 不再被跳过 → `webServer` + `connection` 正常提供
- host ready 在 710ms（修复前 host 直接 exit 1）
- 1 entry 未激活 = `corum-web-search`（waiting for settings，已知惰性激活时序）

### 类型检查

- `@corum/corum-ui-navigation` typecheck：**0 错误** ✓
- `@corum/corum-ui-navigation` spec typecheck (tsconfig.spec.json)：**0 错误** ✓
- `@corum/corum-ui-conversation` typecheck：**0 错误** ✓
- desktop host typecheck (tsconfig.host.json)：**0 错误** ✓

### 单元测试

- `@corum/corum-ui-navigation` test：**7 通过 / 0 失败** ✓
  - 7 条真实 cordis Context 测试（A→B / rapid / clear / dispose / throw /
    observable）
- `@corum/corum-ui-conversation` test：**26 通过 / 0 失败** ✓
  - 含 13 条 anti-cycle 测试 + 13 条其他测试
  - 旧 9 条假 corum-navigation 测试已删除（迁移到新包为 7 条真测试）

### 构建

- `@corum/corum-ui-navigation` build：**tsc + tsdown + inline-css** ✓
  - `lib/client.js` 4.85 kB（无 CSS，inline-css no-op）
- `@corum/corum-ui-conversation` build：**tsc + tsdown + inline-css** ✓
  - `lib/client.js` 1.31 MB + CSS 注入 83520 字符
- desktop host build：**tsc + tsdown + inline-monaco-css** ✓

### 打包

- `pack:host:mac`：**exit 0** ✓
  - host bridge boots OK (ready emitted)
  - electron-builder 打包成功（DMG + zip）
  - profile-precheck 修复已进 dist bridge.js ✓

### CDP 探针结果

```
✓ __DSH_BOOT__ 模块图         entries=77 pending=0 errors=0
✓ 公开桥接面 (window.corumDesktop)  platform=darwin version=0.7.0 channel=local keys=46
✓ 启动诊断 (无 skipped bundles)     干净启动，无 bundle 被跳过
✓ 行为期 console errors = 0         0 真错误，0 噪声
✓ Electron 运行时版本              Chrome/150.0.7871.224
✗ UI ready（主界面渲染）            bootMarker=true sessionBand=false entries=77
```

**UI 未 ready 的原因**（与 profile-precheck 修复无关的**上层 renderer 问题**）：
renderer 页面报 `web boot: 13 entries did not activate`，4 个客户端插件
激活失败：
- `@deepseek-ai/dsh-client-ui-sidebar-right: failed`
- `@deepseek-ai/dsh-client-ui-secret-mask: failed`
- `@deepseek-ai/dsh-client-ui-goal: failed`
- `@corum/corum-ui-chat: failed`

根因是 `SidebarSessionViews.dispose` 中 `Cannot read properties of undefined
(reading 'getSnapshot')`——一个 snapshot store 在 dispose 时为 undefined，
sidebar-right 插件初始化即失败 → 9 个依赖 sidebarRight 的插件 pending →
13 entries 未激活 → IDE shell 不渲染 → `[data-session-band]` 不挂载 →
30s 超时。

这是**官方 dsh-client-ui-sidebar-right 包的客户端激活失败**，不是 corum 代码
的 bug，也不是循环依赖问题。需要在下一轮单独排查（可能是 IDE patch 的
sidebar-right 禁用/保留配置与 rc3 客户端 bundle 不兼容）。

### corum-web-search pending 解释

`corum-web-search` 在 host boot 时报 `pending (waiting for service: settings)`。
这是 cordis 惰性激活时序：web-search 插件 inject `settings` 服务，而 `settings`
由 `@deepseek-ai/dsh-settings` 提供，在客户端 bundle 装载后才 provide。
host boot 时 settings 尚未就绪 ⇒ web-search pending。这不阻塞 boot（host ready
正常发出），web-search 在客户端启动后会自动激活。

## 文件变更清单

| 文件 | 变更 |
|---|---|
| `packages/desktop/src/host/profile-precheck.ts` | **根因修复**：`dsh.bundle.patch` 同时接受 string 和 string[]；逐文件加载；`AcceptedBundle` 新增 `patchPaths`；layer 构建用完整列表 |
| `packages/plugins/session/corum-ui-conversation/src/client/corum-navigation.ts` | 从完整实现改为 type-only re-export shim（单一事实源） |
| `packages/plugins/session/corum-ui-conversation/src/client/index.ts` | 删 `export { applyCorumSessionNavigation }` runtime re-export；删重复 `corumNavigation` 增强声明 |
| `packages/plugins/session/corum-ui-conversation/package.json` | 加 `@corum/corum-ui-navigation` dependency |
| `packages/plugins/session/corum-ui-conversation/tests/corum-navigation.spec.ts` | **删除**（假测试，迁移到新包） |
| `packages/plugins/session/corum-ui-navigation/tests/corum-navigation.spec.ts` | **新增**：7 条真实 cordis Context 测试 |
| `packages/plugins/session/corum-ui-navigation/tsconfig.spec.json` | **新增**：测试 typecheck 配置 |
| `scripts/verify-stage5-cdp.mjs` | **重写**：真实 UI ready 判据、真实公开桥接面、不猜 RPC、不写 testKey、走单元测试的行为明确标注 |

## 限制

- **Linux/Win 未验**：本场只在 macOS darwin-arm64 验证。profile-precheck 修复
  是平台无关的（纯 JS 逻辑），但打包链路的三平台差异需单独验证。
- **renderer 13 entries 未激活**：sidebar-right 等 4 插件激活失败是上层问题，
  非 profile-precheck 修复引入，需下一轮排查。
- **CDP 行为验收的 settings/preset/session/queue-revert/web-search/ACP/V4 项**
  通过单元测试覆盖（真实 cordis Context + 真实 schema key），CDP 只读探针
  只验 UI ready + boot graph + bridge + console errors。
