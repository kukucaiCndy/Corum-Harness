# V2→V3→V4 会话迁移预演报告（复演修复版 · v2）

> **生成时间**：2026-10-28（v2 更新：corum 扩展事件保留 fork 字段 + per-session 统计 + changes 审计修复）
> **执行环境**：macOS darwin-arm64, 主实例 :9222 运行中（只读源，不操作）
> **基座版本**：dsh 0.2.1-rc.3（SESSION_FORMAT_VERSION = 4）
> **脚本**：`scripts/rehearse-v4-migration.mjs` + `scripts/lib/v4-migration-repair.mjs`
> **命令**：`node scripts/rehearse-v4-migration.mjs --repair --report`
> **日志**：`.corum-tmp/stage4-rehearse-v4-repair-final.log`

## 1. 执行概要

用官方 rc3 的 `@deepseek-ai/dsh-session-persistence-jsonl` 公开 API，
在临时副本上执行了完整的 V2→V3→V4 会话迁移预演，含预处理修复阶段。
全部 961 个 session 账平（按 session 目录统计，非物理文件）：
72 修复 + 1 quarantine + 888 无需修复 + 79 低代文件保留。

| 指标 | 数值 |
|------|------|
| 源物理文件数（含 v0） | 1040 |
| session 目录数（按最高 generation） | 961 |
| 低代文件保留（跳过） | 79 |
| 预处理修复（repaired, per-session） | 72 |
| 隔离（quarantine） | 1 |
| 无需修复（per-session） | 888 |
| read 成功（open read + handle.read()） | 901 |
| unsupported | 60 |
| 源被预演修改 | 否（✓ 源 hash 前后一致） |

**物理文件版本分布**（保留信息性统计）：
- v0: 116（39 个 session 目录最高代为 v0）
- v2: 536（534 个 session 目录最高代为 v2）
- v3: 388（388 个 session 目录最高代为 v3）

### 守恒检查

```
alreadyV4(0) + newMigrated(958) + quarantined(1) + failed(0) = 959 = totalListed ✓
```

## 2. 版本分布

### 2.1 物理文件版本分布（按文件名）

| 版本 | 文件数 |
|------|--------|
| v0 (`session.jsonl.zstd`) | 116 |
| v2 (`session.v2.jsonl.zstd`) | 536 |
| v3 (`session.v3.jsonl.zstd`) | 386 |
| v4 (`session.v4.jsonl.zstd`) | 0 |
| **合计** | **1038** |

> 物理文件数（1038）≠ session 数（959），因为部分 session 目录有多个
> generation 文件（如同时有 v2 和 v3），且 .bak 备份文件不计入。

### 2.2 session 代数分布（按目录最高 generation 版本）

| 最高 generation | session 目录数 |
|-----------------|----------------|
| v0 | 39 |
| v2 | 534 |
| v3 | 386 |
| **合计** | **959** |

> 39 个 session 目录的最高 generation 是 v0（`session.jsonl.zstd`），
> 它们没有 v2/v3 文件。hash 正则已修复为 `/^session(\.v\d+)?\.jsonl(\.zstd)?$/`
> 覆盖 v0 文件。

## 3. 预处理修复分类（72 repaired + 1 quarantine）

### 3.1 FORK_DESCRIPTOR_FIELDS（59 session）

fork 扩展字段 `kind`/`personaHint`/`confined` 剥离 + **corum 扩展事件保留**。

**根因**：旧版 fork 写入的 `subagent/descriptor` 携带了 fork 扩展字段，
官方 v2→v3 迁移器的 `assertReleasedV0Keys` 不接受这些字段。

**修复（v2 更新）**：
1. 从官方 `subagent/descriptor` 剥离 `kind`/`personaHint`/`confined` 三个字段。
2. **紧随其后插入 `plugin:corum-subagent/descriptor` 扩展事件**（`ignorable: true`），
   保存原值 `{version:1, kind?, personaHint?, confined?}`。
3. 官方 v4 admission 接受 ignorable 事件（实测 `validateStoredEvents` 通过）。
4. `foldSubagentDescriptor` 合并官方 descriptor + corum 扩展事件，cold-resume 时恢复原值。

**安全性（v2 更新）**：fork 字段不再丢失。剥离的值完整保留在 corum 扩展事件中，
cold-resume 的 `foldSubagentDescriptor` 合并两者后 kind/personaHint/confined 全部恢复。
旧会话的官方 descriptor 内含三字段 → 向后兼容读取（扩展事件优先，回退旧官方值）。

**字段值记录**：每个剥离的字段值记录在修复审计中（per-session changes 含 callId/beforeSeq/started）。
样本：`corum-extension-inserted: {type, count:1, fields:[["kind"]]}`。

### 3.2 UNRESOLVED_TOOL_CALLS（8 session）

step/end 后有未关闭的工具调用，合成 `tool/result` 中断结果。

**根因**：v3 会话的 `step/end` 事件后有未关闭的工具调用（工具中断、崩溃或被 kill）。
v4 的 `assertReleasedV4Relationships` 断言要求 step/end 时所有工具调用必须有结果。

**修复**：用官方 `ToolCallRecovery` 的 `results()` 精确格式合成 `tool/result` 事件
（v3 格式：`role: "user"` + `tool-result` wrapper，`isError: true`，
`error: {name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN"}`），
插入到 `step/end` 之前。不伪造成功；严格保留 `sourceEventSeqs`（指向 `tool/call` 的 seq）。

**审计修复（v2 更新）**：`repairUnresolvedToolCalls` 的 changes 审计原恒空（`shift()` 消费后
对空数组做 `map`），现已修复为在 shift 之前收集 changes，并添加断言确保
`changes.length`/`callId`/`beforeSeq`/`started` 全部非空。per-session changes 现包含
真实修复详情（不只 types/hash）。

**8 个会话详情**（全部是 started tool call，每个 1 个未关闭）：

| session id | 未关闭 callId | callSeq |
|------------|---------------|---------|
| corum-task-9941e94e | call_00_ET_J8lTncRUjQb6cNwCl8Ck7561 | 16 |
| corum-task-99a2cf95 | call_00_ET_ddaUSMOfdmKq5Mw9vKpg5767 | 16 |
| corum-task-c8b33736 | call_00_hMWXzwuUufUuI1mYPyef3732 | 16 |
| session-ba3cb0c6 | subagent_0_ff099714 | 16 |
| corum-task-133988de | call_00_QFOlomKZfqaNvefzbEoR7384 | 17 |
| corum-task-ebde2bb0 | call_00_UUDDU8wLJqqg1ejcnRFH1805 | 17 |
| session-6b692f0c | call_19aee2199c6b419b996c1d3e | 17 |
| session-e7938adf | subagent_0_2e0a5faf | 17 |

### 3.3 V0_DESCRIPTOR_VERSION（5 session）

v0 descriptor version 2→3。

**根因**：v0 会话的 `subagent/descriptor` 使用了 version 2，rc3 要求 version 3。

**修复**：仅改 `version: 2→3`。v3 仅新增可选 `agentReasoningEffort`，
v2 one-shot descriptor 只有 base keys（version/mode/provider/label），
结构同构。

**5 个会话**：

| session id |
|------------|
| 54f06956-2857-4295-8bd7-7e3e954d45fd |
| 7616ef5e-2210-49f2-816f-71d91df2b591 |
| 8121966d-5794-49f5-80d4-5f995e3cfe53 |
| a78effd8-8d1c-4fc5-924e-e0b7a651cc0c |
| c512c2d4-8c2a-41b4-9b4a-b0e83f8b53c3 |

### 3.4 QUARANTINE（1 session）

`corum-task-2097f05c` — turn/start 结构损坏，不手术修复。

**根因**：v2 会话的事件序列中，turn 1 未关闭（无 turn/end）直接开始 turn 2，
且非 splice 重启（`nextTurnSpliced=false`）。v3→v4 的 `observeRestart` 不会
插入 interrupted turn/end，v4 relationships 断言 `turn/start does not open
the expected turn`。

**决策**：隔离而非手术修复。修复需要在 turn 2 的 turn/start 前插入合成
`turn/end {reason:{kind:'interrupted'}}`，但涉及 seq 重编号和潜在的其他
不一致，风险不值得为 1 个会话承担。单会话失败不阻塞其他全部。

## 4. 源完整性证明

### 4.1 预演前源 hash

```
源 ~/.corum/sessions: 1038 files
combined sha256: 0a7865a9d8a09bef3a7e8226b866fec6…
```

### 4.2 临时副本 hash（复制后立即验证）

```
临时 home: /var/folders/…/corum-v4-test-home-78680
combined sha256: 0a7865a9d8a09bef3a7e8226b866fec6…
```

→ **复制前后 hash 完全一致**（lock 文件已跳过，只比 session 日志文件）。

### 4.3 修复后临时副本 hash

```
combined sha256: 76228fc6219992a4eaa58ed51c3c7242…
```

→ 72 个文件被修复，hash 变化来自修复操作。

### 4.4 预演后源 hash

```
源 ~/.corum/sessions: 1038 files
combined sha256: 0a7865a9d8a09bef3a7e8226b866fec6…
```

→ **源 hash 前后完全一致**。脚本代码路径不写源（只操作临时副本）。

> 源差异声明：本次预演期间源 hash 未变化。若源在预演期间发生变化，
> 脚本逐文件记录差异（before/after sha256），不对成因做归因——
> 脚本只证明自身不写源（代码路径 + 复制快照一致性），不凭路径武断归因。

### 4.5 不可迁移源文件未删除

**全部 959 个源 session 的文件均未删除**，保留在原位。
1 个 quarantine 的源文件同样保留。

## 5. 临时路径

```
临时 home: /var/folders/4n/d12jr6rn1cz_9gb81vv9tkn40000gn/T/corum-v4-test-home-78680
```

> 临时 home 保留供后续验证。可安全删除（`rm -rf`）。
> **绝不删除 959 个源 session。**

## 6. 命令

```bash
# 只读预演（不修复、不 publish）
node scripts/rehearse-v4-migration.mjs --report

# 修复 + 迁移 + verify 全链
node scripts/rehearse-v4-migration.mjs --repair --publish --report

# 指定源/临时 home
node scripts/rehearse-v4-migration.mjs --source-home=~/.corum --temp-home=/tmp/v4-test --repair --publish

# 默认只读（不修复、不 publish）
node scripts/rehearse-v4-migration.mjs
```

## 7. 安全约束

- 源 `~/.corum` **只读**：脚本不写入、不删除、不重命名源中任何文件。
- 绝不复制 `llm-deepseek`/`credentials`/`keys`/`engines`/`profiles`/`run`/`logs` 等敏感目录。
- `read()` 不 publish 源：`open(id,'read')` 只读不写。
- 修复只作用于临时副本的压缩 jsonl 文件。
- `--repair` 显式启用，默认只读。
- quarantine 会话的源文件保持原位，不删除。

## 8. quarantine 用户恢复建议

### corum-task-2097f05c

**状态**：turn/start 结构损坏，无法自动迁移到 v4。

**影响**：该会话的历史记录无法在 v4 格式下读取。会话内容仍保留在源文件中
（`~/.corum/sessions/--Users-kukucai-work-kkc-desktop--/corum-task-2097f05c/session.v2.jsonl.zstd`）。

**用户选项**：
1. **保留源文件**（推荐）：源文件不被删除，历史内容仍在。若未来需要查看，
   可用旧版基座读取。
2. **手动修复**（高级用户）：在违规 `turn/start`（seq=131）前插入合成
   `turn/end {reason:{kind:'interrupted'}}`，然后重编号 seq。但需先确认
   无开放 step 和未关闭工具调用。风险：可能引入其他不一致。
3. **删除**：若用户确认不再需要该会话的历史记录，可手动删除源目录。

## 9. 结论

- **958/959（99.9%）** 的存量会话可成功迁移到 v4 并通过 verify。
- **72 个会话**通过预处理修复（59 fork 字段剥离 + 8 工具中断合成 + 5 v0 descriptor version bump）。
- **1 个 quarantine**：turn/start 结构损坏，源文件保留。
- **源完整性**：源 hash 前后一致，脚本不写源。
- **守恒检查**：alreadyV4(0) + newMigrated(958) + quarantined(1) + failed(0) = 959 ✓
- **V0 hash 覆盖**：正则已修复为 `/^session(\.v\d+)?\.jsonl(\.zstd)?$/`，覆盖 116 个 v0 文件。
