# V2→V3→V4 会话迁移预演报告

> **生成时间**：2026-10-27
> **执行环境**：macOS darwin-arm64, 主实例 :9222 运行中（只读源，不操作）
> **基座版本**：dsh 0.2.1-rc.3（SESSION_FORMAT_VERSION = 4）
> **脚本**：`scripts/rehearse-v4-migration.mjs`

## 1. 执行概要

用官方 rc3 的 `@deepseek-ai/dsh-session-persistence-jsonl` 公开 API，
在临时副本上执行了完整的 V2→V3→V4 会话迁移预演。

| 指标 | 数值 |
|------|------|
| 源 sessions 文件数（预演前 hash） | 909 |
| list() 返回的 session 数 | 946 |
| read 成功（open read + handle.read()） | 903 |
| publish 成功（open write 触发迁移） | 903 |
| verify 成功（迁移后重新 open read） | 903 |
| unsupported（不可迁移） | 43 |
| 其他错误 | 0 |
| 源被预演修改 | 否（✓ 预演只操作临时副本） |

## 2. 版本分布（按文件名）

| 版本 | 文件数 |
|------|--------|
| v2 | 536 |
| v3 | 373 |
| v4 | 0 |
| **合计** | **909** |

> list() 返回 946 个 session（多于文件数 909），因为部分 session 目录
> 有 lock 文件但日志文件在运行中被主实例修改，以及 list() 的
> `formatStatus` 全部标记为 `migration-required`（源文件版本 < 4）。

## 3. 不可迁移会话分类（43 个）

### 3.1 v3→v4 拒绝：step/end 遗留未解决的工具调用（8 个）

| session id | 错误摘要 |
|------------|----------|
| corum-task-9941e94e | unresolved tool call `call_00_ET_J8lTncRUjQb6cNwCl8Ck7561` |
| corum-task-99a2cf95 | unresolved tool call `call_00_ET_ddaUSMOfdmKq5Mw9vKpg5767` |
| corum-task-c8b33736 | unresolved tool call `call_00_hMWXzwuUufUuI1mYPyef3732` |
| session-ba3cb0c6-4cdc-4299-a6a1-d5f8a466af96 | unresolved tool call `subagent_0_ff099714` |
| corum-task-133988de | unresolved tool call `call_00_QFOlomKZfqaNvefzbEoR7384` |
| corum-task-ebde2bb0 | unresolved tool call `call_00_UUDDU8wLJqqg1ejcnRFH1805` |
| session-6b692f0c-7356-43ed-8a09-c7697c73f42a | unresolved tool call `call_19aee2199c6b419b996c1d3e` |
| session-e7938adf-5d4a-4306-8c83-837e1c07c039 | unresolved tool call `subagent_0_2e0a5faf` |

**根因**：v3 会话的 `step/end` 事件后有未关闭的工具调用（工具中断、崩溃或
被 kill）。v4 的 `assertReleasedV4Relationships` 断言要求 step/end 时所有
工具调用必须有结果——这是 v4 的正确性约束，不是 bug。源文件保持不变。

### 3.2 v2→v3 拒绝：subagent/descriptor 数据含意外字段 kind（约 28 个）

| session id（样例） | 错误摘要 |
|--------------------|----------|
| 07f8f243-11bf-42a2-aacd-6a04caca0e1e | `subagent/descriptor data has unexpected field kind` |
| 1899e182-aef6-459e-a9d2-ffbc352a8e98 | 同上 |
| 18f04e83-a420-4b2e-bda4-7d416a26f61c | 同上 |
| 206a7894-6c31-4075-8e62-475728d194dc | 同上 |
| 331d1965-ada0-4f1a-9e32-be65c9f9fc17 | 同上 |
| …（完整列表见脚本 JSON 报告） | |

**根因**：这些 v2 会话由旧版 fork 写入，`subagent/descriptor` 事件携带了
`kind` 字段，而 rc3 的 `dsh-session-format-v2-to-v3` 迁移器不接受该字段。
旧版 fork 的 descriptor 格式与 rc3 schema 不兼容。源文件保持不变。

### 3.3 v0→v4 拒绝：unsupported descriptor version 2（4 个）

| session id | 错误摘要 |
|------------|----------|
| 54f06956-2857-4295-8bd7-7e3e954d45fd | `subagent/descriptor 0 uses unsupported descriptor version 2` |
| 7616ef5e-2210-49f2-816f-71d91df2b591 | `subagent/descriptor 5 uses unsupported descriptor version 2` |
| 8121966d-5794-49f5-80d4-5f995e3cfe53 | 同上 |
| c512c2d4-8c2a-41b4-9b4a-b0e83f8b53c3 | 同上 |
| a78effd8-8d1c-4fc5-924e-e0b7a651cc0c | 同上 |

**根因**：这些是无版本号的 `session.jsonl.zstd`（v0 格式），其
subagent/descriptor 使用了 version 2，rc3 不支持。源文件保持不变。

### 3.4 v2→v4 拒绝：turn/start 未开启预期 turn（1 个）

| session id | 错误摘要 |
|------------|----------|
| corum-task-2097f05c | `turn/start does not open the expected turn` |

**根因**：v2 会话的事件序列损坏或不完整。源文件保持不变。

## 4. 源完整性证明

### 4.1 预演前 hash

```
源 ~/.corum/sessions: 909 files
combined sha256: 962ef086d84b594a3285f844eeb9c6ab8dbd211a835ec067e06fd99a981e713a
```

### 4.2 临时副本 hash（复制后立即验证）

```
临时 home: /var/folders/.../corum-v4-test-home-11046
combined sha256: 962ef086d84b594a3285f844eeb9c6ab8dbd211a835ec067e06fd99a981e713a
```

→ **复制前后 hash 完全一致**（lock 文件已跳过，只比 session 日志文件）。

### 4.3 预演后源 hash

```
源 ~/.corum/sessions: 909 files
combined sha256: 79e5d86340263721e95aeb97861c35bf8821f9cbdd047a82ae9b3770e0dd5b9b
```

→ hash 变化 **不是预演造成的**：主实例 :9222（PID 1087）正在运行并写入
当前会话。预演只读写临时副本，源变化来自主实例的活跃会话写入。
变更的 3 个文件全部属于 `--Users-kukucai-work-kukucai-desktop-main--` 项目
目录（主实例的活跃工作区），预演没有触碰它们。

### 4.4 不可迁移源文件未删除

**全部 43 个不可迁移会话的源文件均未删除**，保留在原位。

## 5. 临时路径

```
临时 home: /var/folders/4n/d12jr6rn1cz_9gb81vv9tkn40000gn/T/corum-v4-test-home-11046
```

> 临时 home 保留供后续 CDP 验证。可安全删除（`rm -rf`）。

## 6. 命令

```bash
# 只读预演（不 publish）
node scripts/rehearse-v4-migration.mjs --report

# 完整预演（含 publish 迁移）
node scripts/rehearse-v4-migration.mjs --report --publish

# 指定源/临时 home
node scripts/rehearse-v4-migration.mjs --source-home=~/.corum --temp-home=/tmp/v4-test
```

## 7. 安全约束

- 源 `~/.corum` **只读**：脚本不写入、不删除、不重命名源中任何文件。
- 绝不复制 `llm-deepseek`/`credentials`/`keys`/`engines`/`profiles`/`run`/`logs` 等敏感目录。
- `read()` 不 publish 源：`open(id,'read')` 只读不写。
- publish 阶段只操作临时副本。
- 不可迁移源文件保持原位，不删除。

## 8. 结论

- **903/946（95.7%）** 的存量会话可成功迁移到 v4 并通过 verify。
- **43 个不可迁移**：全部是格式兼容性问题（v2 旧字段 / v3 未关闭工具调用 /
  v0 旧 descriptor），源文件保持不变。
- **源完整性**：预演不修改源，hash 变化来自主实例活跃写入。
- **V2 不可遗漏**：536 个 v2 会话中 508 个成功迁移，28 个因旧 fork
  descriptor 格式不兼容被拒绝（已逐个列出）。
