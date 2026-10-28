# rc3 最终行为验收（2026-10-29，硬隔离场）

> 本文件是 rc3 行为验收的**当前事实源**，并**纠正** `docs/STAGE5-CDP-ROOT-CAUSE-2026-10-28.md`
> §「修复后结果」里那张 `rc3-behavior-check: 9 pass / 0 fail` 的表——那张表的多数判据是
> 「插件 activated 即通过」，属于**假绿**（见 §5）。本场重写了探针，把它改成真 RPC + 真 UI 判据，
> 并在**硬隔离**环境里跑。**结论：代码修复与单测已完成并全绿；端到端 CDP 行为验收在本机被
> 一个与本次改动无关的宿主启动缺陷阻断**（§6，证据完整，未作任何绕过或降低判据）。

## 1. 硬隔离纪律（本场执行口径，可复跑）

绝对禁令（用户 2026-10-29 明确）：不得读写/改写当前实例的 `~/.corum`，不得驱动/重启/kill
主实例（:9222 / `/Applications/Corum.app`），不得启动子 Agent（避免触发自动模型修复/preset 改写）。

隔离装置：`/tmp/rc3-iso-setup.sh <stamp>`，产出 `/tmp/rc3-iso-<stamp>/`：

| 项 | 值 |
|----|----|
| `CORUM_HOME` / `DSH_HOME` | `/tmp/rc3-iso-<stamp>/.corum-verify-home` |
| `CORUM_USER_DATA_DIR` | `/tmp/rc3-iso-<stamp>/user-data` |
| `CDP_PORT` | `9333`（拒绝 9222；启动前检查端口空闲） |
| 复制进隔离 home | 仅 `settings.yaml`（只读复制；内容只有 `apiKeyEnv` **变量名**，无密钥字面值） |
| **不**复制 | `.credentials.yaml`、`.master-key`、`llm-deepseek/`、`sessions/`（V4 另走单会话显式复制）、`profiles/`、`.agent-presets/` |

三条 fail-fast 护栏（脚本里硬编码，任一不满足直接退出、不做猜测）：

1. 解析出的 home 不得等于 `~/.corum`，也不得等于当前进程 env 的 `CORUM_HOME`/`DSH_HOME`；
2. home 必须在 `/tmp/rc3-iso-*` 下；
3. 端口不是 9222 且空闲。

**为什么 home 目录名叫 `.corum-verify-home`**：`scripts/corum-instance.sh` 据此判定 `role=verify`，
而 verify 角色**绝不做任何按仓库路径的宽匹配兜底清理**（只杀自己 PID 记录的那棵树）。这样即使
`cleanup()` 跑起来也碰不到主实例。（本场全程只 stop 自己 spawned 的实例，从未 `pkill Corum`。）

探针侧同样自检 `CORUM_HOME`（`scripts/rc3-behavior-check.mjs` 的 `assertIsolated()`），
环境不对直接 `exit 3`。

### 源 home 只读证据

* 启动前基线：`/tmp/rc3-iso-<stamp>/source-config-before.sha256`
  （`settings.yaml` / `.credentials.yaml` / `.master-key` / `desktop-settings.json` /
  `plugins.disabled.json` / `mcp-servers.json` / `.agent-presets/**` / `profiles/**` 共 **4654** 个文件）
* 收尾复核：`/tmp/rc3-iso-20261029k/evidence/source-config-final.sha256`
* 结论：`diff` **完全相同**（`SOURCE_CONFIG_UNCHANGED`）。主实例 PID 55794 全程存活。

> 唯一已知的源侧变化来自**主实例自己**在写它当前的会话：
> `sessions/--Users-kukucai-work-kukucai-desktop-main--/8d73c864-…/session.v3.jsonl.zstd`
> （迁移预演脚本的「源差异」检查报出，成因是运行中的实例在追加本轮会话；本场脚本对源只读）。

## 2. 代码修复（本场提交的主体）

上一场 worker 的 `LayoutController` rightbar 桥有三个实质缺陷，本场修法：

| # | 缺陷 | 修法 |
|---|------|------|
| 1 | details 开合**只在** `openDetails/closeDetails` 里改本地布尔。AppFrame 的 backdrop 点击、会话切换复位、官方 DetailsPanel 关闭按钮都**直接写 store action**，绕过服务 ⇒ 快照陈旧 | 抽屉的唯一事实源 = root layout store 的 `details` 宽；**唯一写点**改为 `reportDetailsOpen()`——AppFrame（`useStore` 真值持有者）`useLayoutEffect` 回送真值；新增 `detailsSnapshot()` 只读镜像（uSES：引用只在变化时换、订阅者在真实开关时被通知）。`openDetails/closeDetails` 只写 store、不再维护本地布尔（store action 自身幂等） |
| 2 | `openRightbar(track, fullscreen)` 注释写「映射」却**参数全忽略**；`panelInfo.activePanelId` 被塞 `'details'` | 官方 `PanelInfo` 语义（读过 rc3 源码）= **中央主面板选择**（null = Conversation），`ui-sidebar-right` 正用它决定会话级右栏是否显示 ⇒ 本壳恒 `null`（frozen 单例、永不广播），**不塞 details**。右栏呈现另立 `rightbarCapability = { track: true, fullscreen: false }`：只接受 docked 报告；`fullscreen`/无轨道报告**不伪映射**（不打开抽屉、同签名只告警一次） |
| 3 | 测试用 mock PanelActions（记录调用次数），测不出真实 store 行为 | 测试改用**真实** `@deepseek-ai/dsh-client-store` 引擎产物（`createLayoutStore().create()`），覆盖：外部关闭/外部打开同步、初始打开状态、幂等（引用稳定 + 不广播）、退订、未 attach 安全、能力边界 |

文件：`packages/plugins/ui/corum-ide-ui/src/client/{service.ts,AppFrame.tsx,index.tsx}` +
`tests/layout-rightbar-bridge.spec.ts`。

### 已跑通的判据（本机真实执行）

```
@corum/corum-ide-ui  vitest run    →  5 files / 48 tests pass（其中新桥 19 条）
@corum/corum-ide-ui  tsc spec+src  →  0 error
packages/desktop     tsc lib+bundle→  build ok
pack( darwin/arm64 )                →  PACK_EXIT=0（含 dmg/zip）
assert-packaged-boot                →  ✓ 产物宿主启动断言通过（darwin-arm64，用产物自带 Node）
verify-fork-drift.sh               →  fork drift 校验通过（跳过 13 项）
  ⚠️ 必须带 DSH_BASELINE_TAG=dsh-v0.2.1-rc.3：
     脚本 §[13] 的默认回落仍是 0.1.5-rc.3（第 929 行），在 0.2.1-rc.3 仓上会把
     「已逐个钉定 341 个包到 0.2.1-rc.3」误判成 0 个，随后在 `fail "...$TARGET_VER（预期"`
     那行炸出 `TARGET_VER…: unbound variable`（全角括号被 bash 当成变量名的一部分）。
     这是**既存缺陷**（与本场改动无关，本场未改脚本），已在此登记待修。
```

## 3. 探针重写（`scripts/rc3-behavior-check.mjs`）

判据一律走**公开 RPC + 真实 UI 交互**，关键项**不设 skip**（有 skip 也按失败退出）：

| 编号 | 判据 | 真实证据来源 |
|------|------|--------------|
| P0 | UI ready | boot 遮罩消失 + 槽位渲染 + `__DSH_BOOT__.entries > 0` |
| P1 | 启动诊断 | client pending/errors = 0；host `getBootDiagnostics()` 的 skipped/undeclared 不含关键插件 |
| P2 | 五预设真列 | `agentPresets/list`：id 全 5、name 非空、无 broken、默认唯一 |
| P3 | 五预设 UI | 设置中心「Agent 预设」`[data-agent-preset-id]` 卡片全 5 可见（真点开设置） |
| P4 | 默认预设写→读→UI | `corumAgent/setDefaultPreset` → `agentPresets/list` 的 `isDefault` → 卡片 `aria-pressed` |
| P5 | ACP | host row 未被 skipped **且** 真实 `<node> <dsh cli> --profile acp` 的 `initialize` 握手（stdio JSON-RPC，20s 超时） |
| P6 | queue-revert wire | `session/updateQueue`：未知 kind 必须被 `gateway/input-invalid` 拒；`requeue` 必须**过 boundary**且落到 handler（`session/queue-item-not-found`）；非 requeue（edit 非文本）必须走官方校验（`session/attachment-invalid`） |
| P7 | settings roundtrip | 4 键真写真读：`@corum/corum-agent.stallRecoverMinutes` / `corum-review.retentionDays` / `corum-web-search.activeProvider` / `corum-conversation.busyEnter` |
| P8 | V4 历史 | 迁移预演（`rehearse-v4-migration.mjs --publish`）临时副本里的**真实会话**复制进隔离 home → `session/list` 可见 → 点开会话行，DOM 里命中消息文本 needle |
| P9 | 会话导航 | A/B 真 `session/create` → 点击切换（会话带标题变化）→ 清空回空态 → `workspace/archiveSession` 后 RPC 列表与 UI 行同时消失 |
| P10 | 右栏 details | 点聊天工具卡打开 → `[data-details]` 出现；点 backdrop（AppFrame 直接写 store）→ 消失 |
| P11 | console error | `Runtime.consoleAPICalled(type=error)` + `Log.entryAdded(level=error)` + 未捕获异常全量采集 |

`--phase=persist` 重启后只读复检：默认预设、4 个 settings 值、V4 会话仍在。

### 本场探针里踩到并修掉的坑

* **会话文件是多帧 zstd**：`zlib.zstdDecompressSync` / `createZstdDecompress` 都**只解第一帧**，
  275KB 的 `session.v4.jsonl.zstd` 只返回 294 字节的 header（看起来像"迁移出了空会话"）。
  修法：按 frame magic 切分逐帧解（假 magic 解失败即跳过），446 条事件全部拿到；
  `needles` 取 `session/title` + `user/message` 的纯文本连续段。

## 4. 隔离环境实测：能起来 / 起不来

| 尝试 | 结果 |
|------|------|
| `pack` 出新的 `Corum.app`（含本场改动） | ✅ `PACK_EXIT=0` |
| `assert-packaged-boot.mjs`（产物自带 Node 跑闭包宿主） | ✅ ready 信号出现 |
| 隔离 home 上**启动实例**（packaged 与 dev、ide 与 minimal、fresh 与预置 `settings.legacy-ns-migrated` 共 8 个 stamp） | ❌ 见 §6 |

## 5. 对旧结论的纠正

* `STAGE5-CDP-ROOT-CAUSE-2026-10-28.md` §「修复后结果」的 `rc3-behavior-check: 9 pass / 0 fail`
  **不可作为行为证据**：
  - 「五 preset 渲染」实际是 sidebar 文本里 ≥3/5 命中（预设不在 sidebar 里）；
  - 「queue-revert wire」实际只断言 `@corum/corum-ui-chat` activated（从不发请求）；
  - 「ACP provider 注册」实际断言的是 `corum-subagent` 激活，且缺环境变量时 **skip**；
  - 「V4 历史」实际只断言 `corum-session-archive` activated（从不打开任何会话）；
  - 「设置 RPC 桥接面」只数了 bridge keys，没有写→读→重启保留。
  该表现在由本文件 §3 的判据取代，并在原文件对应位置加了纠正引用。
* 旧记录里「验证跑在安装版上」的口径同时要纠正：本场**全部**验证跑在隔离 home + 隔离
  userData + :9333 + **本仓新构建的产物/源码**上；`/Applications/Corum.app`（用户主实例）
  全程只读、未驱动、未重启（其 host 端口 57803、CDP :9222 与本次无关）。
* 「layout rightbar 桥 = no-op stub」的判断已被代码取代：见 §2（`panelInfo` 恒 null 是
  **官方语义下的事实**，而 details 开合并发由 `detailsSnapshot()` 承担）。

## 6. 阻断点（端到端 CDP 行为验收未完成的原因）

> **2026-10-29 后续场纠正（本节的「与本场改动无关」「待决换机器」两条结论已作废）**：
> 阻断点就是宿主组合丢层的同一个根因，已修复并用硬隔离实机证据收口。
> 真实根因、修法与证据见 **[`docs/RC3-PROFILECONTEXT-RECOMPOSE-FIX-2026-10-29.md`](RC3-PROFILECONTEXT-RECOMPOSE-FIX-2026-10-29.md)**。
> 一句话：`profileContext.overlays = []` 让官方 `readProfilePatches()` 在每次 recompose 时把
> desktop/IDE/preset/combo 覆盖层全部丢掉（webserver 回落 3080 → `EADDRINUSE`；官方
> `plugin-manager`/`credentials` 复活 → `service "…" has been registered`）。「ready 但无 LISTEN」
> 是同一件事的另一面：recompose 关掉了当时那个 ephemeral 监听、改去抢 3080。
> 修法 = 覆盖行进 `profileContext.overlays` + **行定义（insert）进运行期 bundle**（bundle 层在
> profile patch 之前，才同时满足「热重组不丢层」与「设置写得进去」）。修好后同一隔离环境实机
> 复跑：webServer `127.0.0.1:57184` 真 LISTEN、`settings.update` 后端口不变、4 个 corum 设置键
> 重启后仍在；P0/P1/P2/P7 通过。**仍未通过的 8 项与新发现的两个真实缺陷见该文件 §4。**

以下为当时的原始记录（保留作对照，结论以上面这段为准）。

**症状**（可复现，8 个隔离 stamp 一致）：实例启动后宿主子进程报告 ready，URL 形如
`http://127.0.0.1:<ephemeral>/?token=…`，但**该端口没有任何 LISTEN socket**（ready 后 300ms 起
连续 6 次 `lsof` 全空；宿主进程仍存活但没有监听套接字），渲染进程随即
`ERR_CONNECTION_REFUSED`，`--combo=coding` 启动失败、窗口关闭退出：

```
[corum-desktop] host 子进程 spawn→ready +1029ms
[corum-desktop] combo "coding" host ready (http://127.0.0.1:50767/?token=…)
(node:65283) electron: Failed to load URL: http://127.0.0.1:50767/ with error: ERR_CONNECTION_REFUSED
[corum-desktop] combo "coding" launch failed: Error: ERR_CONNECTION_REFUSED (-102) loading '…'
```

**第二条相关证据**（同一 home 的第二次启动，或任何触发 `settings.update()` 的路径）：
`dsh-config-editor.edit() → reconcileProfilePatches → recompose` 抛
`TypeError: Cannot read properties of undefined (reading 'await')`，且 recompose **丢失
desktop/IDE 覆盖层**：官方 `plugin-manager` / `credentials` 重新激活（`service "…" has been
registered`）、`webserver` 回落到基座默认 **3080**（`EADDRINUSE`——本机 3080 被用户自己的
`node … apps/cli/src/bin.ts web` 占着）。这就是 `STAGE5` 缺陷 E「在 `cordis.ide.patch.yml`
禁用官方行」的修法**在 recompose 路径上不生效**。

**为什么当时判定与本场改动无关（⚠️ 该判定已被后续场推翻）**：失败发生在宿主启动阶段（宿主子进程
ready → 渲染进程加载被拒），本场改的是渲染层 IDE 壳（`corum-ide-ui` 的
`service.ts`/`AppFrame.tsx`/`index.tsx`），不参与宿主 boot/composition；同一产物
`assert-packaged-boot`（无 GUI，直接跑闭包宿主）是通的，而 GUI 实例的 host 子进程不监听。
后续场查明：`assert-packaged-boot` 只跑一次冷启动 boot，**不触发 recompose**，所以它本来就测不到
这条缺陷；GUI 实例的 host 子进程在 ready 之后的第一次重组就把监听关掉——两者并不矛盾。

**环境侧的另一个坑（本场已修，仅 node_modules，未进版本库）**：本仓 dev 树缺
`@deepseek-ai/dsh-tools` 的 workspace 链接（`workspace:@corum/corum-tools@*` override 未物化），
dev 实例启动即 `ERR_MODULE_NOT_FOUND`。`pnpm install --frozen-lockfile` 1.1s 走完但不补
peer 链接；本场用一次性脚本在 73 个 `.pnpm/*/node_modules/@deepseek-ai/` 下补了
`dsh-tools → packages/plugins/agent/corum-tools` 符号链接，dev 实例的模块解析错误随之消失
（打包闭包不受影响）。

## 7. 待决（给上层 Agent/用户）

> **2026-10-29 后续场已结清 1–3 项**：① 已续做，根因 = `profileContext.overlays` 为空导致
> recompose 丢层（见 `docs/RC3-PROFILECONTEXT-RECOMPOSE-FIX-2026-10-29.md`）；
> ② 3080 冲突**不需要避开环境**——`port: 0` 现在在重组后仍然保留（不再回落 3080）；
> ③ 探针已按 rc3 真实契约修了 4 处（`session/list` 的 `_request`、`settings/describe` 的
> `namespaces` 形状、`agentPresets/list` 无 name 字段、干净启动诊断文件为 null），
> 余下 8 项的归属见该文件 §4。

1. **隔离实例启动缺陷归属**：是否需要本场续做（按 `recompose` 路径排查「recompose 不重放
   desktop/IDE 覆盖层」）？这属于 **rc3 宿主 boot 缺陷**，不是 layout 桥的范围。
2. **3080 冲突**：用户本机 3080 被自有 `dsh web` 占用；recompose 路径一旦回落 3080 必炸。
   建议要么在 recompose 路径也钉 `port: 0`，要么验收时避开该环境。
3. **端到端判据**：P0/P3/P8/P9/P10 依赖可启动的实例；宿主修好后，本场探针可直接复跑
   （命令见 §1 与脚本头注释），不需要再改脚本。
