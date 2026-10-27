# 阶段4 验证日志

> **日期**：2026-10-27/28
> **仓库 HEAD**：e55d9bcd
> **平台**：macOS darwin-arm64（Linux/Windows 未验证）

## A. 完整 pack + assert

### A.1 环境状态

- HEAD: `e55d9bcd0d56e66e22d556a6b1eb547517ef2a48`
- git status: clean
- :9222 主实例运行中（PID 1087，来自 `/Users/kukucai/work/kkc-desktop/`）—— **未启动/停止/重启**
- :9333 未监听

### A.2 第一次 pack（发现 corum-session-queue-revert 激活失败）

```
pnpm --filter corum-desktop run pack:host:mac
```

结果：exit 0，但 smokeBridge 暴露 2 个未激活插件：

1. **corum-session-queue-revert**：`typert descriptor for session/updateQueue is not reachable — the official typert-registry internals changed; re-fork required`
   - **根因**：rc3 把 `codec.schema`（zod 类型直挂）改为 `codec.create`（`() => z.object(…)` 延迟函数）。fork 代码访问 `parameter.codec.schema` 得到 `undefined`。
   - **修复**：`packages/plugins/session/corum-session-queue-revert/src/index.ts` 的 `widenUpdateQueueWireSchema`：优先 `codec.create?.()`（rc3），退回 `codec.schema`（旧版）。
   - **这是生产 bug**（fork-drift），不是验证装置问题。

2. **corum-web-search**：`pending (waiting for service: settings)`
   - **根因**：cordis 惰性激活——`settings` 服务在 config-tree 挂载阶段加载，`web-search` 的 `inject: ['web', 'settings']` 在 settings 就绪后自动激活。smokeBridge 在 ready 后立即终止，不等 settings 完全加载。
   - **结论**：不是 bug，是 smokeBridge 时序特性。在真实运行的应用中 settings 会加载、web-search 会激活。

### A.3 第二次 pack（修复后重跑）

```
pnpm --filter corum-desktop run pack:host:mac  # 修复后
```

结果：exit 0，**1 个未激活**（仅 corum-web-search pending，正常）。

**pack 关键指标**：
- UI 插件样式内联断言：通过
- closure top-up：+15 official packages
- closure dedupe：-53 nested duplicates
- 闭包减重：21809 文件（192MB）
- platform closure assertion：7 平台专属包全部 darwin-arm64
- dsh closure uniform：258 packages @ 0.2.1-rc.3
- vendor uniqueness：cordis@4.0.5, schemastery@3.18.5, cosmokit@1.8.6
- closure blacklist：8 个被删/旧包均未出现
- resolution probes：311 resolve 成功，7 跳过
- smokeBridge：**host bridge boots OK (ready emitted)**
- electron-builder 25.1.8：darwin-arm64, electron=43.4.1, DMG+ZIP

### A.4 assert-packaged-boot

```
node scripts/assert-packaged-boot.mjs
```

结果：**exit 0**
```
✓ 产物宿主启动断言通过（darwin-arm64）
    产物 Node：Resources/node/bin/node
    宿主桥：   Resources/host/lib/bridge.js
    ready 信号：http://127.0.0.1:50543/...
```

- 无 `plugin tree failed to load`
- 无 `Cannot find package`
- ready 信号触发

### A.5 package.json 恢复

- dependencies: 112 个（恢复完成）
- git status: clean（生成物不提交）

## B. V2→V3→V4 迁移预演

详见 `docs/upgrade-0.2.1-rc3/v4-migration-report.md`。

**精确统计**：
- 源文件数：909（v2=536, v3=373, v4=0）
- list() 返回：946 sessions
- read 成功：903
- publish 成功：903
- verify 成功：903
- 不可迁移：43（v2 旧 descriptor 28 + v3 未关闭工具调用 8 + v0 旧 descriptor 5 + v2 turn/start 1 + 其他 1）
- 源未被预演修改：✓

## C. Electron 43.4.1 flock

### C.1 静态确认

```
system.node: packages/desktop/build/host/node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node
大小: 52232 bytes
prebuilds.json: platform=darwin-arm64, napi=8, kind=node-api, tool=flock
```

→ **Node-API v8 + darwin-arm64 bin/system.node 闭包实物确认**。

### C.2 Electron binary 版本

```
ELECTRON_RUN_AS_NODE=1 Corum.app/Contents/MacOS/Corum
electron=43.4.1, node=24.18.1, modules=148, napi=10
```

→ napi 10 支持 napi 8 addon（向后兼容）。

### C.3 真实 addon load + flock 测试

通过 `scripts/verify-electron-flock.mjs` 在 Electron-as-Node 下执行：

| 测试项 | 结果 |
|--------|------|
| addon require 加载 | ✓ `binding.tryLock` 是函数 |
| 第一次 flock 加锁 | ✓ ok |
| 第二次 flock 加锁（竞争） | ✓ rejected (EAGAIN) |
| 释放后重新加锁 | ✓ ok |
| lock 文件存在 | ✓ true |

→ **Electron 43.4.1 flock 测试全部通过**。

### C.4 三平台状态

| 平台 | 验证状态 |
|------|----------|
| macOS darwin-arm64 | ✓ 已验证（本文档） |
| Linux x64 | ❌ 未验证（需在 Linux 本机执行） |
| Windows x64 | ❌ 未验证（需在 Windows 本机执行） |

> Linux/Windows 未验证，**不标记阶段4全完成**。

## D. 代码修改

### 修复：corum-session-queue-revert codec.schema → create()

**文件**：`packages/plugins/session/corum-session-queue-revert/src/index.ts`

**变更**：`widenUpdateQueueWireSchema` 函数中，访问 typert descriptor 的
codec schema 方式从 `parameter.codec.schema`（旧版 0.1.5）改为
`parameter.codec.create?.() ?? parameter.codec.schema`（rc3 优先，旧版退回）。

**根因**：rc3（0.2.1-rc.3）将 typert descriptor 的 `codec.schema` 字段
（zod 类型直挂）改为 `codec.create`（`() => z.object(…)` 延迟函数）。
fork 代码未跟进，访问 `codec.schema` 得到 `undefined` → fail-loud。

**回记阶段3**：这是 fork-drift（fork 与官方 0.2.1-rc.3 升级的兼容性遗漏），
应归入阶段3 fork 适配清单。阶段3 的 typecheck/test 未发现此问题，
因为 `widenUpdateQueueWireSchema` 的错误是**运行时**的 typert 访问失败，
不是编译期类型错误。smokeBridge 实测是唯一发现途径。
