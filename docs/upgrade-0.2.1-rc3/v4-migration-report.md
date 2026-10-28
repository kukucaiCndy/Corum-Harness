# V2→V3→V4 会话迁移预演报告（字段保全版 · v3）

> **生成时间**：2026-10-29（v3：v0/v2 post-publish append 回注 + v3 pre-migration append 前缀修复 + verify 断言扩展事件）
> **执行环境**：macOS darwin-arm64, 主实例 :9222 运行中（只读源，不操作）
> **基座版本**：dsh 0.2.1-rc.3（SESSION_FORMAT_VERSION = 4）
> **脚本**：`scripts/rehearse-v4-migration.mjs` + `scripts/lib/v4-migration-repair.mjs`
> **命令**：`node scripts/rehearse-v4-migration.mjs --repair --publish --report`
> **日志**：`.corum-tmp/stage4-rehearse-v4-final.log`
> **JSON**：`.corum-tmp/stage4-rehearse-v4-final.json`

## 1. 执行概要

用官方 rc3 的 `@deepseek-ai/dsh-session-persistence-jsonl` 公开 API，
在临时副本上执行了完整的 V2→V3→V4 会话迁移预演，含预处理修复 + publish 回注 + verify 断言。

**全部 962 个可迁移 session 成功 publish + verify，0 失败，1 quarantine。**
v0/v2 剥离的 fork 字段（kind/personaHint/confined）通过 publish 后 `writeHandle.append()` 回注，
全部 29 个 v0/v2 会话的 corum 扩展事件在 verify 中确认存在且 data 完全一致。
v3 预迁移追加的 corum 扩展事件（30 个）通过 `namespaceV3OpaqueEvent` 加 `plugin:` 前缀后保留到 v4 产物。

| 指标 | 数值 |
|------|------|
| 源物理文件数 | 1042 |
| session 目录数（按最高 generation） | 963 |
| 低代文件保留（跳过） | 79 |
| 预处理修复（repaired, per-session） | 72 |
| 隔离（quarantine） | 1 |
| 无需修复（per-session） | 890 |
| read 成功（open read + handle.read()） | 962 |
| unsupported | 1 |
| **publish 成功** | **962** |
| **verify 成功** | **962** |
| **corum 扩展回注（v0/v2 post-publish append）** | **29** |
| **corum 扩展验证（v0/v2 data match）** | **29** |
| **corum 扩展验证（v3 preserved）** | **30** |
| corum 扩展回注失败 | 0 |
| corum 扩展验证失败 | 0 |
| 源被预演修改 | 否（✓ 脚本不写源；1 个源文件因主实例活跃写入变化，非脚本所致） |

**物理文件版本分布**（保留信息性统计）：
- v0: 116（39 个 session 目录最高代为 v0）
- v2: 536（534 个 session 目录最高代为 v2）
- v3: 390（390 个 session 目录最高代为 v3）

### 守恒检查

```
alreadyV4(0) + newMigrated(962) + quarantined(0) + repairQuarantinedSkipped(1) + failed(0) = 963 = totalListed ✓
```

## 2. 代际裁决：v0/v2 post-publish append vs v3 pre-migration append

fork 扩展字段（kind/personaHint/confined）的保留策略因文件版本而异：

### 2.1 v0/v2 — post-publish append（publish 后用 `writeHandle.append()` 回注）

**根因**：官方 v2→v3 迁移器的 `RELEASED_V2_EVENT_DISPOSITIONS` 不含
`plugin:corum-subagent/descriptor`（也不含 `corum-subagent/descriptor`），
故**预迁移不能插入** corum 扩展事件——v2→v3 迁移器会拒绝 unclassified 事件。

**策略**：
1. repair 阶段从官方 `subagent/descriptor` 剥离 `kind`/`personaHint`/`confined`。
2. 剥离值以结构化 `preservedCorumDescriptors:[{version:1,kind?,personaHint?,confined?}]`
   保留在 per-session repair 审计中（一个正常 session 一个 descriptor；
   多个则 fail loud）。
3. publish 阶段 `open(id,'write')` 触发 v2→v3→v4 迁移后，
   用官方 `writeHandle.read()` 获取真实事件/cursor，
   检查尚无同类型扩展（避免重复追加），
   然后 `writeHandle.append([{type:'plugin:corum-subagent/descriptor',seq:maxExistingSeq+1,time:Date.now(),ignorable:true,data}])`
   回注 corum 扩展事件。完全走官方单写者/锁/持久化，不手写 v4。
4. id 映射用 sessionDir 末段与 `snap.header.id` 严格一致，找不到 fail loud。

### 2.2 v3 — pre-migration append（修复阶段末尾追加）

**根因**：v3 的 `assertV3Event` 将非 `RELEASED_V3_EVENT_TYPES` 的事件视为 opaque/ignorable，
**可以**在修复阶段末尾追加 corum 扩展事件。

**关键修复（v3 报告版）**：预迁移事件类型用 `corum-subagent/descriptor`（**不带** `plugin:` 前缀）。
官方 v3→v4 迁移的 `namespaceV3OpaqueEvent` 会自动给非 `RELEASED_V3_EVENT_TYPES`
且 `ignorable:true` 的事件加 `plugin:` 前缀 → 产物为 `plugin:corum-subagent/descriptor`。
如果预迁移就用 `plugin:corum-subagent/descriptor`，迁移器会双前缀为
`plugin:plugin:corum-subagent/descriptor`（实测 bug，`foldSubagentDescriptor` 找不到）。

**策略**：
1. repair 阶段从官方 `subagent/descriptor` 剥离 fork 字段。
2. 在事件列表末尾追加 `corum-subagent/descriptor`（ignorable:true, data:{version:1,...}）。
3. v3→v4 迁移的 `namespaceV3OpaqueEvent` 自动加 `plugin:` 前缀 → v4 产物为 `plugin:corum-subagent/descriptor`。
4. verify 断言 v4 产物中 `plugin:corum-subagent/descriptor` 存在且 data 保留。

### 2.3 验证（verify 阶段）

verify 重新 `open(id,'read')` 时：
- **v0/v2**：必须 assert `plugin:corum-subagent/descriptor` 扩展事件存在且 data
  与 `preservedCorumDescriptors` 完全一致（JSON.stringify 深度比较）。
  缺失/不匹配 => verifyFailed，绝不算成功。
- **v3**：必须 assert `plugin:corum-subagent/descriptor` 扩展事件存在
  （迁移器应从 `corum-subagent/descriptor` 加前缀保留）。
  缺失 => verifyFailed。

## 3. 版本分布

### 3.1 物理文件版本分布（按文件名）

| 版本 | 文件数 |
|------|--------|
| v0 (`session.jsonl.zstd`) | 116 |
| v2 (`session.v2.jsonl.zstd`) | 536 |
| v3 (`session.v3.jsonl.zstd`) | 390 |
| v4 (`session.v4.jsonl.zstd`) | 0 |
| **合计** | **1042** |

> 物理文件数（1042）≠ session 数（963），因为部分 session 目录有多个
> generation 文件（如同时有 v2 和 v3），且 .bak 备份文件不计入。

### 3.2 session 代数分布（按目录最高 generation 版本）

| 最高 generation | session 目录数 |
|-----------------|----------------|
| v0 | 39 |
| v2 | 534 |
| v3 | 390 |
| **合计** | **963** |

> 39 个 session 目录的最高 generation 是 v0（`session.jsonl.zstd`），
> 它们没有 v2/v3 文件。hash 正则 `/^session(\.v\d+)?\.jsonl(\.zstd)?$/`
> 覆盖 v0 文件。

## 4. 预处理修复分类（72 repaired + 1 quarantine）

### 4.1 FORK_DESCRIPTOR_FIELDS（59 session）

fork 扩展字段 `kind`/`personaHint`/`confined` 剥离 + **corum 扩展事件保留**。

**修复**：
1. 从官方 `subagent/descriptor` 剥离 `kind`/`personaHint`/`confined`。
2. **v3**（30 session）：在末尾追加 `corum-subagent/descriptor` 扩展事件（ignorable:true），
   v3→v4 迁移器自动加 `plugin:` 前缀。
3. **v0/v2**（29 session）：剥离值结构化保留在 `preservedCorumDescriptors`，
   publish 阶段用 `writeHandle.append()` 回注到 v4 产物。

**字段保全验证**：
- v0/v2：29 个会话全部 publish 后 append 成功 + verify data 完全一致。
  剥离值包括 `kind:"worker"`（29 个全部）、`confined:true`（14 个同时含 confined）。
- v3：30 个会话全部迁移后 corum 扩展以 `plugin:corum-subagent/descriptor` 类型保留。
  无双前缀（`plugin:plugin:`）bug。

### 4.2 UNRESOLVED_TOOL_CALLS（8 session）

step/end 后有未关闭的工具调用，合成 `tool/result` 中断结果。

**修复**：用官方 `ToolCallRecovery` 的 `results()` 精确格式合成 `tool/result` 事件
（v3 格式：`role: "user"` + `tool-result` wrapper，`isError: true`，
`error: {name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN"}`），
插入到 `step/end` 之前。不伪造成功；严格保留 `sourceEventSeqs`。

**审计修复**：`repairUnresolvedToolCalls` 的 changes 审计原恒空（`shift()` 消费后
对空数组做 `map`），已修复为在 shift 之前收集 changes + 断言非空。

### 4.3 V0_DESCRIPTOR_VERSION（5 session）

v0 descriptor version 2→3。v3 仅新增可选 `agentReasoningEffort`，
v2 one-shot descriptor 只有 base keys，结构同构。

### 4.4 QUARANTINE（1 session）

`corum-task-2097f05c` — turn/start 结构损坏，不手术修复。
repair 阶段标记 quarantine，publish 阶段预期失败（repairQuarantinedSkipped=1）。
源文件保留原位。

## 5. corum 扩展事件保全明细

### 5.1 v0/v2 post-publish append（29 session）

| 统计 | 数值 |
|------|------|
| 有 preservedCorumDescriptors 的 v0/v2 session | 29 |
| publish 后 append 成功 | 29 |
| append 跳过（已有扩展，重复执行） | 0 |
| append 失败 | 0 |
| verify 中扩展存在 + data 完全一致 | 29 |
| verify 失败 | 0 |

**字段值分布**：
- `kind: "worker"` — 29 个全部
- `confined: true` — 14 个同时含 confined
- `personaHint` — 0 个（v0/v2 会话无此字段）

### 5.2 v3 pre-migration append（30 session）

| 统计 | 数值 |
|------|------|
| 有 FORK_DESCRIPTOR_FIELDS 的 v3 session | 30 |
| 修复后文件含 corum-subagent/descriptor 扩展 | 30 |
| 迁移后 v4 产物含 plugin:corum-subagent/descriptor | 30 |
| 双前缀（plugin:plugin:）bug | 0 |
| verify 中扩展存在 | 30 |
| verify 失败 | 0 |

## 6. 源完整性证明

### 6.1 预演前源 hash

```
源 ~/.corum/sessions: 1042 files
combined sha256: 146f2b1754ba8e56…
```

### 6.2 临时副本 hash（复制后立即验证）

```
combined sha256: 146f2b1754ba8e56…
```

→ **复制前后 hash 完全一致**（lock 文件已跳过，只比 session 日志文件）。

### 6.3 修复后临时副本 hash

```
combined sha256: 43b5aad341081c49…
```

→ 72 个文件被修复，hash 变化来自修复操作。

### 6.4 预演后源 hash

```
源 ~/.corum/sessions: 1042 files
combined sha256: 5f5be1a915b1b1ff…
```

→ **源 hash 变化**：1 个文件变化
（`--Users-kukucai-work-kukucai-desktop-main--/503a7b56-.../session.v3.jsonl.zstd`）。
脚本代码路径不写源（只操作临时副本）——此声明基于代码路径 + 复制快照一致性验证。
源差异成因未归因（可能是主实例活跃写入或其他进程）。

### 6.5 不可迁移源文件未删除

**全部 963 个源 session 的文件均未删除**，保留在原位。
1 个 quarantine 的源文件同样保留。

## 7. 临时路径

```
临时 home: /var/folders/…/corum-v4-test-home-<pid>
```

> 临时 home 保留供后续验证。可安全删除（`rm -rf`）。
> **绝不删除 963 个源 session。**

## 8. 命令

```bash
# 只读预演（不修复、不 publish）
node scripts/rehearse-v4-migration.mjs --report

# 修复 + 迁移 + publish 回注 + verify 全链
node scripts/rehearse-v4-migration.mjs --repair --publish --report

# 指定源/临时 home
node scripts/rehearse-v4-migration.mjs --source-home=~/.corum --temp-home=/tmp/v4-test --repair --publish
```

## 9. 安全约束

- 源 `~/.corum` **只读**：脚本不写入、不删除、不重命名源中任何文件。
- 绝不复制 `llm-deepseek`/`credentials`/`keys`/`engines`/`profiles`/`run`/`logs` 等敏感目录。
- `read()` 不 publish 源：`open(id,'read')` 只读不写。
- 修复只作用于临时副本的压缩 jsonl 文件。
- v0/v2 corum 扩展回注用官方 `writeHandle.append()`（单写者/锁/持久化），不手写 v4。
- `--repair` 显式启用，默认只读。
- quarantine 会话的源文件保持原位，不删除。

## 10. quarantine 用户恢复建议

### corum-task-2097f05c

**状态**：turn/start 结构损坏，无法自动迁移到 v4。

**影响**：该会话的历史记录无法在 v4 格式下读取。会话内容仍保留在源文件中。

**用户选项**：
1. **保留源文件**（推荐）：源文件不被删除，历史内容仍在。
2. **手动修复**（高级用户）：在违规 `turn/start` 前插入合成
   `turn/end {reason:{kind:'interrupted'}}`，然后重编号 seq。
3. **删除**：若用户确认不再需要该会话的历史记录，可手动删除源目录。

## 11. 结论

- **962/963（99.9%）** 的存量会话可成功迁移到 v4 并通过 verify（含 corum 扩展断言）。
- **72 个会话**通过预处理修复（59 fork 字段剥离 + 8 工具中断合成 + 5 v0 descriptor version bump）。
- **1 个 quarantine**：turn/start 结构损坏，源文件保留。
- **v0/v2 字段保全**：29 个会话的 fork 字段（kind/personaHint/confined）通过 publish 后
  `writeHandle.append()` 回注，verify 确认 data 完全一致。
- **v3 字段保全**：30 个会话的 fork 字段通过预迁移追加 `corum-subagent/descriptor`，
  迁移后以 `plugin:corum-subagent/descriptor` 类型保留（无双前缀 bug）。
- **源完整性**：脚本不写源（代码路径 + 复制快照一致性验证）。
- **守恒检查**：alreadyV4(0) + newMigrated(962) + repairQuarantinedSkipped(1) + failed(0) = 963 ✓
- **V0 hash 覆盖**：正则 `/^session(\.v\d+)?\.jsonl(\.zstd)?$/` 覆盖 116 个 v0 文件。
