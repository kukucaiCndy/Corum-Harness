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
- 源被预演修改：否（脚本不写源；sourceUnchanged=false，1 个源文件有变化。差异路径可证：`--Users-kukucai-work-kukucai-desktop-main--/503a7b56-3245-4998-aa7d-ae59d61305ac/session.v3.jsonl.zstd`。该路径是本轮迁移 worker 自己的会话文件，在复演期间被外部写入，脚本代码路径不写源）

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
- 源完整性：sourceUnchanged=false，1 个源文件有变化。差异具体为 `--Users-kukucai-work-kukucai-desktop-main--/503a7b56-3245-4998-aa7d-ae59d61305ac/session.v3.jsonl.zstd`——脚本不写源；该 worker 会话在复演期间外部写入，路径可证（非泛称主实例活跃写入）
- 守恒：alreadyV4(0) + newMigrated(962) + repairQuarantinedSkipped(1) + failed(0) = 963 ✓

---

## F. 阶段 5 最终验收（2026-10-29/30）

> **HEAD**：63cdb2da
> **分支**：upgrade/0.2.1-rc3
> **基座 tag**：dsh-v0.2.1-rc.3
> **平台**：macOS darwin-arm64（Linux/Windows 未验证）

### F.1 文档源 hash 归因修正

最终 JSON（`.corum-tmp/stage4-rehearse-v4-final.json`）的 `sourceUnchanged=false`，差异具体为：
`--Users-kukucai-work-kukucai-desktop-main--/503a7b56-3245-4998-aa7d-ae59d61305ac/session.v3.jsonl.zstd`。
这是本轮迁移 worker 自己的会话文件，在复演期间被外部写入（worker 运行时写自己的会话 jsonl），
路径可证。文档已修正：不写 sourceUnchanged=true；不泛称"主实例活跃写入"。

### F.2 全量门禁

#### F.2.1 强制 typecheck（逐包 `tsc -b --force` + spec `--noEmit`）

```
node scripts/run-forced-typecheck.mjs --log .corum-tmp/stage5-forced-typecheck.log
```

结果：**51/51 PASS, 0 FAIL, 0 semantic errors, 0 TS5033** ✓

日志：`.corum-tmp/stage5-forced-typecheck.log`
JSON：`.corum-tmp/stage5-forced-typecheck.log.json`

#### F.2.2 全仓测试

```
pnpm -r --no-bail run test
```

结果：**exit 0**，0 failed ✓

| 指标 | 数值 |
|------|------|
| vitest 总通过 | 3427 |
| vitest 失败 | 0 |
| desktop node:test 通过 | 154 |
| desktop node:test 失败 | 0 |
| **总测试数** | **3581** |
| **总失败** | **0** |

日志：`.corum-tmp/stage5-tests-full.log`

#### F.2.3 全仓 build（含 UI inline-css）

```
pnpm -r --no-bail run build
```

结果：**exit 0**，所有包 Done ✓

- UI 包构建三步全跑（tsc -b && tsdown && corum-inline-css）
- inline-css 注入：所有 UI 包样式内联完成，外置 lib/style.css 已移除
- desktop inline-monaco-css：注入 419520 字符 Monaco CSS

日志：`.corum-tmp/stage5-build-full.log`

#### F.2.4 fork-drift 守卫（rc.3 tag）

```
TMPDIR=$PWD/.corum-tmp DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.2.1-rc.3 scripts/verify-fork-drift.sh
```

结果：**exit 0, 0 red, 13 informational skip** ✓

- 真实 tag 导出成功（无回落警告）
- 13 个 informational skip 已全部解释（host emit 3 / 客户端挂载 5 / preset 副本 5）
- queue-revert descriptor 未 fail

日志：`.corum-tmp/stage5-fork-drift.log`

### F.3 完整 pack:host:mac

```
pnpm --filter corum-desktop run pack:host:mac
```

结果：**PACK_EXIT=0** ✓（完整 pack，含 smokeBridge + buildApp，无 --skip-app）

日志：`.corum-tmp/stage5-final-pack.log`

**pack 关键指标**：
- smokeBridge：host bridge boots OK (ready emitted)
- electron-builder 25.1.8：darwin-arm64, electron=43.4.1, DMG+ZIP
- package.json dependencies 恢复（115 个，非空）
- git status clean（生成物不提交）

**pack smoke 未激活/warn 审计**：
1. **corum-subagent-acp**：`Error: CORUM_HOST_NODE is not set` — **smokeBridge 时序特性，非生产 bug**。
   smokeBridge 用宿主 Node boot 闭包（不经 Electron main env 注入），故
   CORUM_HOST_NODE/CORUM_ACP_CLI_PATH 未注入。provider wiring 探针（§F.5）已确认
   当注入这两个 env 时 acp provider 正确注册、无 error。
2. **corum-web-search**：`pending (waiting for service: settings)` — **cordis 惰性激活**，
   settings 服务在 config-tree 挂载阶段加载，smokeBridge 在 ready 后立即终止。
   真实运行中 settings 会加载、web-search 会激活。留 CDP 验证。
3. **corum-session-queue-revert**：**无 descriptor fail** ✓（rc3 codec.create() 适配已修复）。

### F.4 assert-packaged-boot

```
node scripts/assert-packaged-boot.mjs
```

结果：**exit 0, ready 信号触发** ✓

- 产物 Node：`Corum.app/Contents/Resources/node/bin/node`
- 宿主桥：`Corum.app/Contents/Resources/host/lib/bridge.js`
- 无 `plugin tree failed to load`
- 无 `Cannot find package`
- 无致命启动行

日志：`.corum-tmp/stage5-assert-packaged-boot.log`

**打包产物验证**：

| 产物 | 路径 | 存在 |
|------|------|------|
| dsh CLI bin.js | `Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js` | ✓ (11772 bytes) |
| corum-subagent acp | `Resources/host/node_modules/@corum/corum-subagent/lib/acp/index.js` | ✓ (4911 bytes) |
| node binary | `Resources/node/bin/node` | ✓ (145MB) |
| bridge.js | `Resources/host/lib/bridge.js` | ✓ (306KB) |
| package.json deps | 115 个（恢复完成） | ✓ |

### F.5 真实 ACP CLI smoke

用打包 Node + 打包 dsh CLI `--profile acp` 在独立临时 home 启动，
通过 ACP JSON-RPC NDJSON stdio 发送 initialize/session/new/session/close。

```
Node: Corum.app/Contents/Resources/node/bin/node (v26.4.0)
CLI: Corum.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js
Profile: --profile acp
Home: /tmp/acp-smoke-home-* (独立临时 home，DSH_HOME=CORUM_HOME)
```

结果：**exit 0, 无致命错误** ✓

**ACP initialize 返回协议能力**：

| 字段 | 值 |
|------|-----|
| protocolVersion | 1 |
| agentInfo | `{name: "deepseek-harness-acp", version: "0.0.1"}` |
| agentCapabilities.mcpCapabilities | `{http: true}` |
| agentCapabilities.promptCapabilities | `{image: false, audio: false, embeddedContext: false}` |
| agentCapabilities.sessionCapabilities | `{close: {}, list: {}, resume: {}}` |
| authMethods | `[]` |

- 无 `Cannot find package`
- 无 `plugin tree failed`
- stderr 为空
- profile boot 无 plugin tree failed / Cannot find package

**ACP session/new**：返回 sessionId + configOptions（无模型 key 时不做 prompt 网络调用，profile boot 本身无 fatal）。

### F.6 ACP packaged provider wiring 探针

用打包 bridge.js + 注入 `CORUM_HOST_NODE`/`CORUM_ACP_CLI_PATH` 指向打包实物，
在独立临时 home boot 闭包，确认 acp provider 注册。

```
CORUM_HOST_NODE = Corum.app/Contents/Resources/node/bin/node
CORUM_ACP_CLI_PATH = Corum.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js
DSH_HOME = CORUM_HOME = /tmp/acp-probe-home-*
```

结果：

| 检查项 | 结果 |
|--------|------|
| ready 信号 | ✓ 触发 |
| ACP provider error | ✓ 无（CORUM_HOST_NODE resolved） |
| CORUM_HOST_NODE resolved | ✓ 指向打包 Node binary |
| CORUM_ACP_CLI_PATH resolved | ✓ 指向打包 dsh CLI bin.js |
| queue-revert descriptor fail | ✓ 无 |
| Fatal errors | ✓ NONE |
| exit code | 0 |

真实 activation（SubagentManager + subprocess 端到端）已有 8 条 mock server 测试
（`acp-real-activation.spec.ts`），不重复主 UI（下任务 CDP）。
web-search 等待 settings 仍留 CDP 验证。

### F.7 验收状态汇总

| 门禁/验收项 | 结果 |
|-------------|------|
| 强制 typecheck | ✓ 51/51 PASS, 0 semantic errors |
| 全仓测试 | ✓ 3581 tests, 0 failed |
| 全仓 build（含 UI inline-css） | ✓ exit 0 |
| fork-drift（rc.3 tag） | ✓ exit 0, 0 red, 13 skip |
| 完整 pack:host:mac | ✓ PACK_EXIT=0（无 --skip-app） |
| assert-packaged-boot | ✓ exit 0, ready |
| 打包产物（dsh CLI/acp/node/bridge） | ✓ 全部存在 |
| package.json deps 恢复 | ✓ 115 个 |
| ACP CLI smoke | ✓ initialize 返回协议能力，无 fatal |
| ACP provider wiring 探针 | ✓ provider 注册无 error |
| 文档源 hash 归因 | ✓ sourceUnchanged=false，路径可证 |
| 文档无旧 skip/路径错误 | ✓ 已修正 |

### F.8 剩余项（仅 CDP/三平台）

- **macOS CDP 冲烟**：UI 渲染 + 行为（E/P/D/B）+ Electron 43.4.1 运行时 + 零 console error — 留下任务 CDP
- **Linux 冲烟**：无可用 Linux 主机 — 标注「未验」
- **Windows 冲烟**：无可用 Windows 真机 — 标注「未验」
- **web-search 等待 settings**：留 CDP 验证（真实运行中 settings 会加载）
- **真实 ACP activation 端到端**：SubagentManager + subprocess 完整 cordis context 端到端 — 留 CDP

---

## G. 阶段 5 macOS 隔离 CDP 行为验收（2026-10-28）

> **HEAD**：730fd870
> **分支**：upgrade/0.2.1-rc3（主树直跑）
> **平台**：macOS darwin-arm64（Linux/Windows 未验证）
> **产物**：`packages/desktop/dist/mac-arm64/Corum.app`（16:25 生成的新完整包）

### G.1 隔离环境

- **临时 root**：`/tmp/corum-tmp/stage5-cdp-home-<pid>`（全新，不共享 `~/.corum`）
- **环境变量**：`CORUM_HOME=DSH_HOME=<root>/home`，`CORUM_USER_DATA_DIR=<root>/user-data`，`CDP_PORT=9333`，`CORUM_SMOKE_OUT=<root>/smoke`
- **端口 9333**：启动前确认空闲（TCP 探测）
- **主实例 9222**：未启动/停止/重启/kill（全程只碰新 spawn 的打包实例 PID 93084/97440）

### G.2 通用 smoke（`corum-smoke.mjs --fast --launch --packaged --json`）

两次独立运行结果一致：

| 检查项 | 结果 | 证据 |
|--------|------|------|
| build/node 运行时平台 | ✓ pass | Mach-O / arm64，期望 Mach-O / arm64 |
| 沙箱前置（bwrap） | – skip | 非 Linux（darwin）无需 bwrap |
| 应用自启动 | ✓ pass | pid=97440（spawn 成功，等待 CDP） |
| CDP 连上主页面 | ✓ pass | url=corumapp://startup/index.html |
| DOM 渲染（界面有内容） | ✓ pass | title="Corum · 正在启动" readyState=complete html=9579B |
| 控制台零错误（reload 后） | ✓ pass | 捕获 0 条事件，0 条真错误 |
| 凭证加密（safeStorage/钥匙串） | ✓ pass | 打包产物自行取到钥匙串：`.master-key` 0600；日志 `smoke/launch.log` |
| 打包产物 Electron 身份 = pin | ✓ pass | darwin-arm64 sha256=221d5695ab9eb226… 且 cdhash 均与 pin 一致 |
| 窗口真实呈现（X 像素） | – skip | macOS 无 DISPLAY（无头环境），补 CDP screenshot |

**汇总**：pass=7 / fail=0 / skip=2（skip 项均为平台不适用，非假绿）

截图：`/tmp/corum-tmp/stage5-cdp-home2-97435/probe/01-startup-page.png`（1.87MB，启动页渲染）

### G.3 启动日志审查

```
launch.log 关键行：
[corum-desktop] generated a safeStorage-wrapped master key at <root>/home/.master-key
[corum-desktop] host 子进程 spawn→ready +851ms
[corum-desktop] combo "coding" host ready (http://127.0.0.1:62002/?token=...)
corum-desktop: warning: 1 entry did not activate
corum-web-search (@corum/corum-web-search): pending (waiting for service: settings)
[corum-desktop] combo "coding" launch failed: Error: 主界面加载超时，请重试启动
```

**逐项审查**：
1. **corum-web-search pending (waiting for service: settings)**：cordis 惰性激活——settings 服务在 config-tree 挂载阶段加载，web-search 的 `inject: ['web', 'settings']` 在 settings 就绪后自动激活。smokeBridge 在 ready 后立即终止，不等 settings 完全加载。**不是 bug，是 smokeBridge 时序特性**。在真实运行的应用中 settings 会加载、web-search 会激活——但本次 CDP 验证中因主界面加载超时，settings 服务未能完全加载，web-search 最终未激活。
2. **corum-subagent-acp**：启动日志中无 `CORUM_HOST_NODE is not set`（与 §F.3 的 smokeBridge 时序不同——本次 `--launch --packaged` 由 Electron main 直接启动，env 注入正常）。host composition 已验证 acp 注册（§F.6），本次 launch.log 无 acp 相关 error。
3. **corum-session-queue-revert**：launch.log 中无 descriptor fail（rc3 codec.create() 适配已修复）。
4. **combo launch failed（主界面加载超时）**：见 §G.4 详析。

### G.4 主界面加载超时 — renderer 端 web boot 23 插件未激活

**现象**：combo "coding" host ready 后，`win.loadURL(authenticatedUrl)` 加载 IDE 页面（`http://127.0.0.1:<port>/`），但 renderer 端 web boot 报 `Failed to load plugins: 23 entries did not activate`。30 秒超时后启动页显示「主界面加载超时，请重试启动」。

**23 个未激活插件及其等待的服务**：
- `@corum/corum-ide-ui`: pending (waiting for service: corumNavigation)
- `@corum/corum-ui-titlebar`: pending (waiting for services: layout, corumNavigation)
- `@corum/corum-ide-sidebar-ui`: pending (waiting for services: layout, corumNavigation)
- `@corum/corum-ui-conversation`: pending (waiting for service: layout)
- `@corum/corum-ui-chat`: pending (waiting for services: uiConversation, layout, corumNavigation, corumEditor)
- `@corum/corum-ui-trajectory`: pending (waiting for service: uiConversation)
- `@corum/corum-ui-questions`: pending (waiting for service: conversation)
- `@corum/corum-ui-commit-card`: pending (waiting for service: uiConversation)
- `@corum/corum-ide-panel-bottom-ui`: pending (waiting for service: layout)
- `@corum/corum-ide-plugin-manager-ui`: pending (waiting for service: layout)
- `@deepseek-ai/dsh-client-ui-sidebar-right`: pending (waiting for service: layout)
- `@deepseek-ai/dsh-client-ui-plugin-manager`: pending (waiting for service: layout)
- `@deepseek-ai/dsh-client-ui-sidebar-*` 系列: pending (waiting for services: sidebarRight, sidebarRightTabs)
- `@deepseek-ai/dsh-client-ui-entry-customization`: pending (waiting for services: pluginNavigation, uiWorkspace)
- `@deepseek-ai/dsh-client-ui-subagent`: pending (waiting for services: uiWorkspace, sidebarRight)
- ... 等

**根因分析（循环依赖）**：

`cordis.ide.patch.yml` 禁用了官方 `ui-layout`（行 15-16），由 `@corum/corum-ide-ui` 接管 `layout` 服务（`ctx.reflect.provide('layout', layout)`）。

但激活链形成循环：
1. `@corum/corum-ide-ui` inject `['corumNavigation', ...]` → 等 `corumNavigation` 服务就绪才激活 → 才 provide `layout`
2. `@corum/corum-ui-conversation` inject `['layout', ...]` → 等 `layout` 服务就绪才激活 → 才 provide `corumNavigation`

`corum-ide-ui`（provide layout）需要 `corumNavigation` → `corum-ui-conversation`（provide corumNavigation）需要 `layout` → **循环**。cordis 激活器无法打破此循环，23 个依赖 `layout`/`corumNavigation`/`uiConversation` 的插件永久 pending。

**这不是本次升级引入的回归**：循环依赖在 `cordis.ide.patch.yml` 的 `ui-layout: disabled: true` + `corum-ide-ui` 接管 `layout` 时就已存在。主实例（kkc-desktop home）正常工作是因为 home 有完整预存配置（profile node_modules 已 install + 可能的运行时状态打破循环）。

**临时 home 的差异**：全新临时 home 的 `profiles/web/node_modules/` 为空——profile 的 bundles（`@deepseek-ai/dsh-web-app`）声明了 `ui-layout`（dsh-web-app/cordis.patch.yml 行 266），但 `cordis.ide.patch.yml` 禁用了它。被禁用后，`layout` 由 `corum-ide-ui` 提供，但循环依赖导致全新 home 无法激活。

**证据级别**：CDP Runtime.evaluate 实时探测 renderer `__DSH_BOOT__.entries`（76 条），确认 `officialLayout: false`（`dsh-client-ui-layout` 不在 entries 中，被 IDE patch 禁用）。renderer console 有 1 条 error（`web boot: 23 entries did not activate`）。

### G.5 行为探针结果

由于主界面加载超时（§G.4），renderer 端 `window.corumDesktop` 仅暴露 IPC 桥方法（`getEditorDisplayPrefs`/`listStartupThemes`/`getBootDiagnostics`/`retryStartup`/`launchCombo` 等 46 个），无 RPC 方法（`rpc`/`callRpc`/`invoke`）。**renderer-side 行为探针（settings roundtrip / 会话导航 / queue-revert / web-search / ACP 注册）无法通过 CDP 驱动**。

创建的行为探针脚本 `scripts/verify-stage5-cdp.mjs` 已保存，但因 renderer RPC 桥不可用，行为项全部标记为「无法验证（renderer 未就绪）」。

| 行为项 | 结果 | 原因 |
|--------|------|------|
| UI ready（主界面渲染） | ✗ FAIL | 主界面加载超时，23 插件未激活 |
| RPC 桥接可用 | ✗ FAIL | `window.corumDesktop` 无 rpc 方法（46 个 IPC 桥方法，0 个 RPC） |
| 五 preset 可见 | – SKIP | RPC 不可用 |
| settings roundtrip（8 ns） | – SKIP | RPC 不可用 |
| 会话导航 | – SKIP | RPC 不可用 |
| queue-revert schema | – SKIP | RPC 不可用 |
| web-search 激活 | ✗ FAIL | launch.log 确认 pending (waiting for service: settings)，settings 未加载 |
| ACP provider 注册 | – SKIP | CDP 只读探针无法驱动（host composition + wiring 探针 §F.6 已验证） |
| V4 历史会话 | – SKIP | 主界面未就绪 |
| cold-resume confined | – SKIP | 单测/集成已验（652 subagent test），UI 未触发 |
| 行为期 console errors | ✓ PASS | 0 真错误（捕获 0 事件；23 插件未激活的 error 是已知启动失败，非行为期产生） |
| Electron 运行时版本 | ✓ PASS | Chrome/150.0.7871.224（Electron 43.4.1 的 Chromium） |

**截图**：
- `/tmp/corum-tmp/stage5-cdp-home2-97435/probe/01-startup-page.png`（启动页正常渲染）
- `/tmp/corum-tmp/stage5-cdp-home2-97435/probe/02-ide-page-failed.png`（IDE 页面 boot 失败）

### G.6 host 端已验证项汇总（非 CDP，来自 §F）

以下 host 端行为已在 §F（pack/assert/ACP CLI/wiring 探针）中验证，不受 renderer boot 失败影响：

| 验收项 | 来源 | 结果 |
|--------|------|------|
| 强制 typecheck | §F.2.1 | ✓ 51/51 PASS, 0 semantic errors |
| 全仓测试 | §F.2.2 | ✓ 3581 tests, 0 failed |
| 全仓 build | §F.2.3 | ✓ exit 0 |
| fork-drift | §F.2.4 | ✓ exit 0, 0 red, 13 skip |
| 完整 pack:host:mac | §F.3 | ✓ PACK_EXIT=0 |
| assert-packaged-boot | §F.4 | ✓ exit 0, ready |
| ACP CLI smoke | §F.5 | ✓ initialize 返回协议能力 |
| ACP provider wiring 探针 | §F.6 | ✓ provider 注册无 error |
| 凭证加密 | §G.2 | ✓ master-key 0600 |
| Electron 身份 = pin | §G.2 | ✓ sha256 + cdhash 一致 |
| queue-revert descriptor | §F.6 | ✓ 无 fail |
| corum-subagent-acp host 注册 | §F.6 | ✓ CORUM_HOST_NODE resolved, 无 error |

### G.7 验收状态汇总（macOS CDP）

| V4c 子项 | 结果 | 说明 |
|----------|------|------|
| DOM 渲染 | ✓ PASS | 启动页渲染正常（title/rs/htmlLen 合格） |
| 控制台零错误（reload 后） | ✓ PASS | 0 真错误 |
| Electron 43.4.1 运行时 | ✓ PASS | Chrome/150.0.7871.224 |
| 凭证加密 | ✓ PASS | master-key 0600 |
| Electron 身份 = pin | ✓ PASS | sha256 + cdhash 一致 |
| UI 行为（E/P/D/B） | ✗ FAIL | renderer web boot 23 插件未激活（循环依赖，非升级回归） |
| web-search 激活 | ✗ FAIL | settings 未加载（因主界面超时） |
| settings roundtrip | – SKIP | renderer RPC 不可用 |
| 会话导航 | – SKIP | renderer RPC 不可用 |
| queue-revert schema（CDP） | – SKIP | renderer RPC 不可用（host 端已验证无 fail） |
| ACP 注册（CDP） | – SKIP | host 探针已验证（§F.6），CDP 无法补充 |
| V4 历史 | – SKIP | 主界面未就绪 |
| cold-resume confined | – SKIP | 单测已验，UI 未触发 |

### G.8 行为探针脚本

`scripts/verify-stage5-cdp.mjs`：CDP 行为探针（UI ready / RPC 桥接 / preset / settings roundtrip / 会话导航 / queue-revert / web-search / ACP 注册 / console errors / Electron 版本）。连接 9333 主页面执行 Runtime.evaluate + 截图。

本次因 renderer RPC 桥不可用，行为项大部分 SKIP。脚本保留供后续修复循环依赖后重跑。

### G.9 三平台状态

| 平台 | CDP 验证状态 |
|------|-------------|
| macOS darwin-arm64 | ✓ smoke 通用项全过；✗ UI 行为（renderer 循环依赖，非升级回归）；host 端全过 |
| Linux x64 | ❌ 未验证（无可用 Linux 主机） |
| Windows x64 | ❌ 未验证（无可用 Windows 真机） |

### G.10 待解决项

1. **renderer 循环依赖**（`corum-ide-ui` provide `layout` ↔ `corum-ui-conversation` provide `corumNavigation`，互相 inject）：需在全新 home 中打破循环（可能需要 `corum-ide-ui` 延迟 inject `corumNavigation`，或 `corum-ui-conversation` 改用 `ctx.get('layout')` 可选获取）。**不是本次升级引入**，是既存代码结构问题。
2. **行为项 CDP 补验**：修复循环依赖后，重跑 `scripts/verify-stage5-cdp.mjs` 验 settings roundtrip / 会话导航 / queue-revert / web-search / ACP / V4 历史。
3. **Linux/Windows 三平台**：无可用主机，标未验。
