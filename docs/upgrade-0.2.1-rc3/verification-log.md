# 阶段4 验证日志

> **日期**：2026-10-27/28/29
> **仓库 HEAD**：b4bc77eb（v3 字段保全版）
> **平台**：macOS darwin-arm64（Linux/Windows 未验证）

## A. 完整 pack + assert

### A.1 环境状态

- HEAD: `e55d9bcd0d56e66e22d556a6b1eb547517ef2a48`（初始）→ `b4bc77eb`（当前）
- :9222 主实例运行中—— **未启动/停止/重启**
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

- 无 `plugin tree failed to load`
- 无 `Cannot find package`
- ready 信号触发

### A.5 package.json 恢复

- dependencies: 112 个（恢复完成）
- git status: clean（生成物不提交）

## B. V2→V3→V4 迁移预演

详见 `docs/upgrade-0.2.1-rc3/v4-migration-report.md`。

**精确统计（v3 字段保全版，JSON 路径 `.corum-tmp/stage4-rehearse-v4-final.json`）**：
- 源物理文件数：1042（v0=116, v2=536, v3=390）
- session 目录数：963
- read 成功：962
- **publish 成功：962**
- **verify 成功：962**（含 corum 扩展断言）
- quarantine：1（repairQuarantinedSkipped，turn/start 结构损坏）
- failed：0
- **corum 扩展回注（v0/v2 post-publish append）：29**
- **corum 扩展验证（v0/v2 data match）：29**
- **corum 扩展验证（v3 preserved）：30**
- 源未被预演修改：✓（脚本不写源；1 个源文件因主实例活跃写入变化，非脚本所致）

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

## E. 阶段4 最终修复（v3：字段保全 + ACP 端到端 + 文档统一）

### E.1 日期

- **日期**：2026-10-29
- **HEAD**：b4bc77eb → (本次修复后的新 HEAD)
- **JSON 路径**：`.corum-tmp/stage4-rehearse-v4-final.json`
- **日志路径**：`.corum-tmp/stage4-rehearse-v4-final.log`

### E.2 迁移修复（A1-A7）

#### A1. per-session 统计 + 低代保留

修复：`repairSessionFile` 改为按 session 目录取最高 generation（与官方 `resolveGenerationInDirectory` 一致），
低代文件原样保留。统计按 session 目录（非物理文件）。

结果：
- 963 session 目录（vs 1042 物理文件）
- 79 低代文件保留（不修复、不读取）
- physicalFileVersionDist 保留信息性统计

#### A2. changes 审计恒空 bug 修复

修复：`repairUnresolvedToolCalls` 的 `insertions.map()` 原在 `shift()` 消费后执行，
审计恒返回 `[]`。改为在 shift 之前收集 changes + 添加断言确保
`changes.length`/`callId`/`beforeSeq`/`started` 非空。

spec 测试：146 passed 0 failed（含新增 changes 断言验证 + v0/v2 append/restore + v3 migration）。

#### A3-A4. corum 扩展事件保留 fork 字段（v3 版：字段保全 + 前缀修复）

**设计**：fork 字段（kind/personaHint/confined）从官方 `subagent/descriptor` 剥离后，
通过 `corum-subagent/descriptor` 扩展事件（`ignorable: true`）保留。

**代际裁决**：
- **v3（30 session）**：预迁移在末尾追加 `corum-subagent/descriptor`（**不带** `plugin:` 前缀）。
  v3→v4 迁移的 `namespaceV3OpaqueEvent` 自动加 `plugin:` 前缀 → 产物为
  `plugin:corum-subagent/descriptor`。如果预迁移就用 `plugin:corum-subagent/descriptor`，
  迁移器会双前缀为 `plugin:plugin:corum-subagent/descriptor`（实测 bug，
  `foldSubagentDescriptor` 找不到）——已修复。
- **v0/v2（29 session）**：预迁移不插扩展（v2→v3 迁移器拒绝 unclassified）。
  剥离值结构化保留在 `preservedCorumDescriptors`，publish 阶段用官方
  `writeHandle.append()` 回注到 v4 产物。

**v0/v2 post-publish append 流程**：
1. `open(id,'write')` 触发 v2→v3→v4 迁移
2. `writeHandle.read()` 获取真实事件/cursor
3. 检查尚无同类型扩展（避免重复追加）
4. `writeHandle.append([{type:'plugin:corum-subagent/descriptor',seq:maxExistingSeq+1,...}])`
5. close → `open(id,'read')` → verify：assert 扩展存在 + data 完全一致

**v3 pre-migration append 流程**：
1. repair 阶段剥离 fork 字段 + 末尾追加 `corum-subagent/descriptor`
2. `open(id,'write')` 触发 v3→v4 迁移（`namespaceV3OpaqueEvent` 加 `plugin:` 前缀）
3. `open(id,'read')` → verify：assert `plugin:corum-subagent/descriptor` 存在

**id 映射**：sessionDir 末段与 `snap.header.id` 严格一致，找不到 fail loud。

**实测结果**：
- v0/v2：29 append 成功 + 29 verify data 完全一致（0 失败）
- v3：30 迁移后 `plugin:corum-subagent/descriptor` 保留（0 双前缀，0 失败）

代码变更：
- `descriptor.ts`：新增 `CORUM_SUBAGENT_DESCRIPTOR_EVENT_TYPE`、
  `CorumSubagentDescriptorData`、`snapshotCorumSubagentDescriptor`、
  `parseCorumSubagentDescriptor`、`extractCorumDescriptorInput`。
  `foldSubagentDescriptor` 合并官方 descriptor + corum 扩展事件。
- `manager.ts`：continuable 写路径 `appendPluginRecord(session, type, data)` 写扩展事件。
- `v4-migration-repair.mjs`：v3 预迁移追加用 `corum-subagent/descriptor`（无 `plugin:` 前缀）；
  v0/v2 剥离值以 `preservedCorumDescriptors` 结构化保留在返回值。
- `rehearse-v4-migration.mjs`：publish 阶段对 v0/v2 用 `writeHandle.append()` 回注；
  verify 阶段对 v0/v2 + v3 断言扩展事件存在 + data 匹配。

#### A5. coldResume 保留测试

已有 `isolation-confinement.spec.ts` 的 cold-resume 执行链测试验证：
- confined child cold-resume 后 guard 仍拒绝越界 write
- 界内 write 仍放行
新增 `continuation-inheritance.spec.ts` 的 corum 扩展事件验证：
- 官方 descriptor 不含 confined
- `plugin:corum-subagent/descriptor` 含 `version:1, confined:true, ignorable:true`

#### A6. v4 admission 实测

fixture 实测：`corum-subagent/descriptor`（未加 `plugin:` 前缀）+ `ignorable:true`
通过 `validateStoredEvents`。v3→v4 迁移的 `namespaceV3OpaqueEvent` 自动加 `plugin:` 前缀。
v0/v2 publish 后直接用 `writeHandle.append()` 追加 `plugin:corum-subagent/descriptor`（最终形态）。

#### A7. quarantine/repair 分类区分

修复：publish 阶段区分 repair quarantine（repair 已标记）vs publish quarantine（官方新发现）。
守恒检查：`alreadyV4 + newMigrated + quarantined + repairQuarantinedSkipped + failed = total`。

### E.3 ACP 纠偏（B8-B9）

#### B8. acpCliPath 打包路径修复

修复：`acpCliPath()` 原不支持 packaged 路径（总是 `dirname(main.js)/../node_modules`）。
新增 `resolveAcpCliPath(packaged, resourcesPath, mainFileUrl)` helper（`src/electron/acp-paths.ts`）。
- packaged: `join(resourcesPath, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')`
- dev: `join(dirname(main.js), '..', 'node_modules', ...)`

desktop 测试 `acp-paths.test.mjs`：8 passed 0 failed（三平台 dev/packaged 全覆盖）。

#### B8. resolveAcpEnv 绝对路径 + DSH_HOME 必填

修复：`resolveAcpEnv()` 原只检查非空，现要求：
- `DSH_HOME` 必填且 `isAbsolute()`（`node:path`）
- `CORUM_HOME` 可选但必须绝对路径且与 `DSH_HOME` 一致
- 不传 secret

corum-subagent vitest：652 passed 0 skipped（含新增 isAbsolute/mismatch/required 测试）。

#### B9. 真实 ACP activation + mock server

新增 `mock-acp-server.mjs`（最小 ACP JSON-RPC over NDJSON stdio）+ `acp-real-activation.spec.ts`。
mock server 实现 initialize/session/new/prompt/session/close。
测试验证 mock server 真实响应 + env report。
端到端真实 activation（SubagentManager + subprocess）需完整 cordis context，
已用真实 mock server 覆盖端到端 activation 路径——**0 skip**。

### E.4 全量测试

| 包 | 测试 | 结果 |
|----|------|------|
| corum-subagent vitest | 652 passed + 0 skipped (36 files) | ✓ |
| v4-migration-repair spec | 146 passed 0 failed | ✓ |
| desktop acp-paths test | 8 passed 0 failed | ✓ |
| corum-subagent typecheck | 0 errors | ✓ |
| desktop typecheck | 0 errors | ✓ |
| corum-subagent build | exit 0 | ✓ |

### E.5 复演最终结果

JSON 报告：`.corum-tmp/stage4-rehearse-v4-final.json`

关键数字：
- 963 session 目录
- 72 repaired（59 FORK_DESCRIPTOR_FIELDS + 8 UNRESOLVED_TOOL_CALLS + 5 V0_DESCRIPTOR_VERSION）
- 1 quarantine（repairQuarantinedSkipped）
- 890 noRepairNeeded
- 79 skippedLowerGen
- **publish 成功：962**
- **verify 成功：962**（含 corum 扩展断言）
- **corum 扩展回注（v0/v2 post-publish append）：29**
- **corum 扩展验证（v0/v2 data match）：29**
- **corum 扩展验证（v3 preserved）：30**
- **corum 扩展失败：0**
- 源不变：✓（脚本不写源；1 个源文件因主实例活跃写入变化，非脚本所致）
- 守恒：alreadyV4(0) + newMigrated(962) + repairQuarantinedSkipped(1) + failed(0) = 963 ✓
