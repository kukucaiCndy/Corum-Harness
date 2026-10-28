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

## E. 阶段4 最终修复（v2：迁移安全 + ACP 纠偏）

### E.1 日期

- **日期**：2026-10-28
- **HEAD**：990d1598 → (本次修复后的新 HEAD)

### E.2 迁移修复（A1-A7）

#### A1. per-session 统计 + 低代保留

修复：`repairSessionFile` 改为按 session 目录取最高 generation（与官方 `resolveGenerationInDirectory` 一致），
低代文件原样保留。统计按 session 目录（非物理文件）。

结果：
- 961 session 目录（vs 1040 物理文件）
- 79 低代文件保留（不修复、不读取）
- physicalFileVersionDist 保留信息性统计

#### A2. changes 审计恒空 bug 修复

修复：`repairUnresolvedToolCalls` 的 `insertions.map()` 原在 `shift()` 消费后执行，
审计恒返回 `[]`。改为在 shift 之前收集 changes + 添加断言确保
`changes.length`/`callId`/`beforeSeq`/`started` 非空。

spec 测试：79 passed 0 failed（含新增 changes 断言验证）。

#### A3-A4. corum 扩展事件保留 fork 字段

设计：fork 字段（kind/personaHint/confined）从官方 `subagent/descriptor` 剥离后，
通过紧随其后插入的 `plugin:corum-subagent/descriptor` 扩展事件（`ignorable: true`）保留。

实测：官方 v4 `validateStoredEvents` 接受 `ignorable: true` 的未知类型事件。
`plugin:corum-subagent/descriptor` 符合官方 plugin record 语法
（`/^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u`）。

代码变更：
- `descriptor.ts`：新增 `CORUM_SUBAGENT_DESCRIPTOR_EVENT_TYPE`、
  `CorumSubagentDescriptorData`、`snapshotCorumSubagentDescriptor`、
  `parseCorumSubagentDescriptor`、`extractCorumDescriptorInput`。
  `foldSubagentDescriptor` 合并官方 descriptor + corum 扩展事件。
  `snapshotSubagentDescriptor` 不再写 fork 字段到官方 descriptor。
  `CONTINUABLE_DESCRIPTOR_KEYS` 保留 fork 字段（向后兼容旧 descriptor 读取）。
- `manager.ts`：continuable 写路径 `appendPluginRecord(session, type, data)` 写扩展事件。
  `MaterializeInputs` 的 `create` 类型新增 `corumDescriptor?`。
- `v4-migration-repair.mjs`：迁移修复在剥离 fork 字段后插入 corum 扩展事件。

#### A5. coldResume 保留测试

已有 `isolation-confinement.spec.ts` 的 cold-resume 执行链测试验证：
- confined child cold-resume 后 guard 仍拒绝越界 write
- 界内 write 仍放行
新增 `continuation-inheritance.spec.ts` 的 corum 扩展事件验证：
- 官方 descriptor 不含 confined
- `plugin:corum-subagent/descriptor` 含 `version:1, confined:true, ignorable:true`

#### A6. v4 admission 实测

fixture 实测：`corum-subagent/descriptor`（未加 `plugin:` 前缀）+ `ignorable:true`
通过 `validateStoredEvents`。但 `Session.append()` 不暴露 `ignorable` 选项，
只有 `appendPluginRecord(session, type, data)` 自动设置 `ignorable: true` 且要求 `plugin:` 前缀。
故使用 `plugin:corum-subagent/descriptor` 作为事件类型。

#### A7. quarantine/repair 分类区分

修复：publish 阶段区分 repair quarantine（repair 已标记）vs publish quarantine（官方新发现）。
守恒检查：`alreadyV4 + newMigrated + quarantined + repairQuarantinedSkipped + failed = total`。

### E.3 ACP 纠偏（B8-B9）

#### B8. acpCliPath 打包路径修复

修复：`acpCliPath()` 原不支持 packaged 路径（总是 `dirname(main.js)/../node_modules`）。
新增 `resolveAcpCliPath(packaged, resourcesPath, mainFileUrl)` helper（`src/electron/acp-paths.ts`）。
- packaged: `join(resourcesPath, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')`
- dev: `join(dirname(main.js), '..', 'node_modules', ...)

desktop 测试 `acp-paths.test.mjs`：8 passed 0 failed（三平台 dev/packaged 全覆盖）。

#### B8. resolveAcpEnv 绝对路径 + DSH_HOME 必填

修复：`resolveAcpEnv()` 原只检查非空，现要求：
- `DSH_HOME` 必填且 `isAbsolute()`（`node:path`）
- `CORUM_HOME` 可选但必须绝对路径且与 `DSH_HOME` 一致
- 不传 secret

corum-subagent vitest：646 passed 1 skipped（含新增 isAbsolute/mismatch/required 测试）。

#### B9. 真实 ACP activation + mock server

新增 `mock-acp-server.mjs`（最小 ACP JSON-RPC over NDJSON stdio）+ `acp-real-activation.spec.ts`。
mock server 实现 initialize/session/new/prompt/session/close。
测试验证 mock server 真实响应 + env report。
端到端真实 activation（SubagentManager + subprocess）需完整 cordis context，
标记 `.skip` 并在报告中注明为未来 packaged runtime 验证步骤。

### E.4 全量测试

| 包 | 测试 | 结果 |
|----|------|------|
| corum-subagent vitest | 646 passed + 1 skipped (36 files) | ✓ |
| v4-migration-repair spec | 79 passed 0 failed | ✓ |
| desktop acp-paths test | 8 passed 0 failed | ✓ |
| desktop rehearse-v4-migration test | 19 passed 0 failed | ✓ |
| corum-subagent typecheck | 0 errors | ✓ |
| desktop typecheck | 0 errors | ✓ |
| corum-subagent build | exit 0 | ✓ |

### E.5 复演日志

日志路径：`.corum-tmp/stage4-rehearse-v4-repair-final.log`
JSON 报告：`.corum-tmp/stage4-rehearse-v4-repair-final.json`

关键数字：
- 961 session 目录
- 72 repaired（59 FORK_DESCRIPTOR_FIELDS + 8 UNRESOLVED_TOOL_CALLS + 5 V0_DESCRIPTOR_VERSION）
- 1 quarantine
- 888 noRepairNeeded
- 79 skippedLowerGen
- 源不变：✓
- corum 扩展事件插入证据：59 个 FORK_DESCRIPTOR_FIELDS 会话全部插入 corum 扩展事件
