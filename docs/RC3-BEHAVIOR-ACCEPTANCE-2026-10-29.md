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

---

# §8 收口场（2026-10-29 夜）：最终验收全绿

> 本节**取代**本文 §3–§7 与本仓 `docs/RC3-PROFILECONTEXT-RECOMPOSE-FIX-2026-10-29.md` §4
> 里「仍未通过/待修」的清单。上面那些结论没有错，但它们停在「缺陷已定位、未修」；
> 本节记录修复落地后的**最终**结果，并把旧表里两条不可达判据（P3/P10 的选择器）纠正。

## 8.1 最终结果（硬隔离实机，最新 dist）

| phase | 结果 | 证据 |
|-------|------|------|
| `--phase=full`（P0–P11） | **12 pass / 0 fail / 0 skip** | `/tmp/corum-rc3-test/behavior-full.json` |
| `--phase=persist`（重启后只读） | **7 pass / 0 fail / 0 skip**（P0/P1/P2/P4/P7/P8/P11） | `/tmp/corum-rc3-test/behavior-persist.json` |

逐项（full）：

```
P0 UI ready（74 条 boot entry，槽位全渲染）
P1 启动诊断（client pending=0 errors=0；host 干净启动 ⇒ 诊断文件已被主动删除，null 为正常形态）
P2 五预设真列（standard/ptc/minimal/cordis/conductor，默认唯一）
P3 五预设 UI（设置 → Agent 预设 → 五张官方基础模式卡 data-official-preset-id 全 5 + 32 张 Agent 卡）
P4 默认预设写（corumAgent/setDefaultPreset standard→conductor，重读 isDefault=conductor）
P5 ACP（pluginManager/list 里 corum-subagent-acp 行 enabled+active；真实 CLI initialize 返回 deepseek-harness-acp）
P6 queue wire（未知 kind=gateway/input-invalid；requeue 过 boundary=session/queue-item-not-found；非 requeue 交官方=same handler 错误码）
P7 settings（4 键写→读回真值：17 / 23 / deepseek / steer）
P8 V4 历史（真实迁移会话打开，6/6 needle 命中，顶栏标题与会话一致）
P9 会话导航（A/B RPC 创建；两条真实历史会话点行切换 aria-current 跟随、标题变化；新建任务回空态；归档后侧栏行消失）
P10 details 抽屉（[data-details-toggle] 开 → [data-details] 出现、aria-pressed=true；点 backdrop 关 → 消失、pressed=false）
P11 console error = 0（boot 后全量采集：无 console.error / 无未捕获异常）
```

persist（stop→start 后只读）：默认预设仍是 conductor；4 个 settings 值仍是 17/23/"deepseek"/"steer"；
V4 历史会话仍在列表；console 仍为 0。

**socket / 进程**：宿主 ready URL `http://127.0.0.1:52829/` 有真实 LISTEN
（`lsof -nP -iTCP:52829 -sTCP:LISTEN` → node PID 98355），`curl` 返回 303（鉴权在、服务在）；
CDP :9333 上 1 个 page target。收尾只停本场自己 spawn 的 PID。

**源 home 只读**：`~/.corum` 的 `settings.yaml` / `.credentials.yaml` / `.master-key` /
`desktop-settings.json` / `plugins.disabled.json` / `mcp-servers.json` / `.agent-presets/**` /
`profiles/**` 共 **4654** 个文件，启动前基线（`/tmp/rc3-iso-final5/source-config-before.sha256`）
与收尾复核 `diff` **0 行**（`SOURCE_CONFIG_UNCHANGED`）。

**隔离装置**：`/tmp/rc3-iso-final5/`，`CORUM_HOME=/tmp/rc3-iso-final5/.corum-verify-home`、
`CORUM_USER_DATA_DIR=/tmp/rc3-iso-final5/user-data`、CDP :9333（拒绝 9222），源 `~/.corum` 只读。
全程未启动子 Agent、未驱动/未重启主实例。

## 8.2 生产修复（本场，逐条对应旧表里的失败项）

| # | 缺陷（旧表） | 真实根因 | 修法 |
|---|--------------|----------|------|
| 1 | **P4** `corumAgent/setDefaultPreset` → `cannot get property "settings" without inject` | `apply()` 直接 `new CorumAgentService(ctx)`，服务侧 `static inject` 只管「经 ctx.plugin 挂载」的属性面；RPC 方法拿到的是**模块 apply 作用域**的 ctx，只按**模块 inject** 解析依赖 —— 而模块 inject 漏了 `settings` | `corum-agent/src/index.ts` 的 `inject` 加 `settings`；新增 `tests/inject-contract.spec.ts`（① 模块 inject ⊇ 服务 static inject；② 真实 cordis 装配能解析出 settings；③ 反证：去掉 settings 必抛 `without inject`）+ `tests/default-preset.spec.ts` 追加「setDefaultPresetRemote 真宿主穿越」用例（真实 settings/config-editor/agent-preset-registry：写 → 落 profile patch → dispose → 重建仍在） |
| 2 | **P11** `chain slot "conversation.chat.turnTail" requires options.select` | 官方 rc3 已把该槽从 `chain` 改成 **list**（deliverables/plan/schedule 三个官方包都以 list 条目注册）；fork 的契约 + 注册表还停在 chain | 契约 `kind: 'list'`、`register-node-renderers` children 改 list、`TurnTailNodeView` 改 `renderSlot`；新增 `tests/turn-tail-list.spec.tsx`（注册面 kind=list + 渲染面多条目同时渲染、owner=seq 契约） |
| 3 | **P11 连带（本轮新发现）** 打开真实历史会话：`argumentSummary ... reading 'text'`（66 个工具节点崩） | rc3 官方工具行读 `block.args`（惰性参数视图）；fork 的工具块构建器只给 `argsRaw`，漏了这个读者面 | `corum-ui-conversation` 新增 `tool-args.ts`（sealed 视图：`has/complete/text/stringLength`，读取器全部 total）+ 契约 `ToolArgumentView`；chat 与 trajectory 的四个块构建器补 `phase:'start'` / `name` / `args`；新增 `tests/tool-arguments.spec.ts` |
| 4 | **P11 连带** `useDisclosure is not a function`（official ToolRow/ToolCallTree） | rc3 座位 inject 面提供 `disclosure` hook（每座位独立开合态，复位世代来自 `hookContext`）；fork 只声明了 `turnData` | 新增 `chat/use-disclosure.ts`（`useDisclosure` + `bindDisclosure` 同义移植）；`CHAT_NODE_INJECT.hooks` 加 `disclosure`；`ChatNodeSeat` 的 `hookContext` 改下发 `{ turnData, disclosureReset }`（复位世代 = 座位被 Turn 折叠隐藏时前进） |
| 5 | **P11 连带** `snapshot.nodes.turnDataSource is not a function`（official ui-plan） | rc3 的 `ChatSnapshot.nodes` 多一个「Turn×kind 节点源」读面；fork 缺 | `contract/snapshot.ts` 加 `ChatNodeListSource` + `turnDataSource`，`MutableChatNodeStore` 实现按 (turn, kind) 分桶的稳定源（缓存 + publish 时广播），`EMPTY_CHAT_SNAPSHOT` 补空源 |
| 6 | **P11 连带** `undefined.find`（composer 访问权限胶囊） | rc3 的 `permissions` 会话投影**只带 currentValue**，档位表搬到了进程级 `corumAgent/listPermissionPresets`；旧组件直接 `value.options.find` | `PermissionSelect` 的 `options` 改可选并 `?? []`；新增 `permissionPresets` 注入面（`ComposerBarInjected`），InputBar 拉一次目录拼 `{currentValue, options}`；目录未到位时胶囊只显示当前档（不崩、不留死菜单）；新增 `tests/permission-select.spec.tsx` |
| 7 | **P11 连带** `slash.sessionOf requires a retained Session scope`（清空/切会话后） | 官方 `sessionOf(actx)` 要求该 ctx 仍是**当前保留世代**的会话作用域；`SessionInputShell.onEditorUpdate` 会在编辑器变化时异步回调，此时会话可能已被释放/重新物化 ⇒ 旧 ctx 必抛 | `input/hub.ts` 的 `controller(actx)` 先自行判定官方前置条件（`sessions.binding(id).ctx === actx`），不满足即当作「本代没有 slash 控制器」返回 undefined（调用方已有降级分支）；`inputTriggers(id)` 同款先判绑定 |

**两处「缺失 UI 入口」类修复**（不是为了让探针好写，而是产品面真的缺）：

- **详情抽屉无任何入口**：`ctx.layout.openDetails()` 与壳的 `[data-details]` 抽屉一直存在，但没有任何 UI
  能打开它（用户看不到工具调用详情）。本场在会话顶栏 utilities 槽补 `详情` 按钮
  （`[data-details-toggle]`，开/关都走公开 layout 方法，`aria-pressed` 读 `detailsSnapshot()` 真值；
  与轨迹按钮同档，仅开发者模式可见 ⇒ 默认外观与 design.pen 一致）。
- **会话行/预设卡缺稳定身份**：侧栏会话行补 `data-session-id` + `aria-current`（`session-row-identity.ts`
  单一事实源），设置页预设卡补 `data-agent-preset-id` / `data-official-preset-id`。两者都是数据的
  机械投影、不改交互；前者让无障碍能读出「当前会话」，两者让验收/自动化不必靠可重命名、可重复的文案猜元素。

## 8.3 探针修正（P3/P5/P6/P8/P9/P10，全部对齐真实 DOM/RPC 契约）

| 项 | 旧探针为什么不可能通过 | 现在怎么做 |
|----|------------------------|-----------|
| P3 | 按「含『设置』文案的 button」找入口，而 IDE 壳的设置入口是 `[data-slot="sidebar.settings"] button`（齿轮图标，无文字）；卡片属性 `data-agent-preset-id` 当时**不存在** | 点 `[data-slot="sidebar.settings"] button` → 设置面板 `nav` 里点「Agent 预设」→ 等 `[data-official-preset-id]` ≥ 5（五张官方基础模式卡）并核对 id 全 5 + 文本非空 + 32 张 Agent 卡 |
| P5 | 判据依赖 host 诊断文件的 `profileName`；而干净启动会**主动删除**该文件 ⇒ 恒红 | 改读 Loader 真值 `pluginManager/list`：ACP provider 行存在、enabled、`fiberPhase=active`；再叠加真实 CLI `initialize` 握手 |
| P6 | 第三臂用 `content:[{type:'image'}]` —— **过不了官方 wire schema**（edit 只收 `{type:'text',text}`），报的是 boundary 校验错，根本没到 handler | 第三臂改成 schema 合规的 `edit` + 不存在的会话 ⇒ 官方 handler 自己的错误码（`session/queue-item-not-found`），真正证明「非 requeue 交官方」 |
| P8 | needle 取自**首轮**消息，而历史会话打开时停在末尾（上面是「加载更早」）⇒ 会话真的渲染了也命中 0；行选择器按官方三栏壳的 `[data-session-id]`，fork 侧栏没有该属性 | needle 改取**尾段** 400 条事件里的 user/assistant 纯文本段（6 条，命中 ≥2 判过）；行定位用 fork 侧栏真实行属性（本场补的 `data-session-id`）；并断言 `aria-current` 与顶栏标题 |
| P9 | 断言「RPC 列表里 A/B 都要有 UI 行」——新建会话 `blank=true`，官方侧栏**过滤 blank**（除非当前选中），行不可能出现；「切换」只看顶栏文本，两条无名会话文本相同 | ①创建走 RPC 真建（`session/list` 两行都在，blank 语义显式记录）；②切换用**两条真实历史会话**（prepare-v4 复制两条 `corum-task-*`）点行，断言 `aria-current` 跟随 + 标题变化；③清空点真实「新建任务」→ `[data-session-band]=empty`；④归档断言**侧栏行消失**（归档是隐藏面语义，`session/list` 保留日志，已显式记录） |
| P10 | 点 `[data-tool-call]` 等**不存在**的选择器（工具卡点击语义是展开/轨迹，从来不打开 details），`clicked:false` | 点会话顶栏 `[data-details-toggle]`（公开 layout 入口）→ `[data-details]` 出现 + `aria-pressed=true`；点 backdrop 关闭 → 消失 + `pressed=false` |

另外：`prepare-v4` 现在复制**两条** `corum-task-*` 真实会话（带标题与尾段 needle），
且必须在**应用首次启动之前**完成 —— 工作区账本的历史 bootstrap（`workspaceRegistry.bootstrap`）
只在未初始化时跑一次，之后复制进来的会话不会进工作区分组。

## 8.4 门禁

```
packages/desktop pack darwin/arm64          → PACK_EXIT=0（含 dmg + zip）
assert-packaged-boot                        → ✓（产物自带 Node，ready URL 真实 LISTEN）
verify-fork-drift.sh（DSH_BASELINE_TAG=dsh-v0.2.1-rc.3）→ fork drift 校验通过（跳过 13 项）
corum-agent / corum-ui-conversation / corum-ui-chat / corum-ui-trajectory /
corum-ide-sidebar-ui 单元测试              → 全绿（新增 5 个 spec 文件，见 §8.2）
```

## 8.5 环境侧注意（未进产品行为）

- **npmmirror 同步滞后会中断打包**：`pnpm deploy` 的 host 闭包**不允许读 lockfile**
  （现解析），而本机 `~/.npmrc` 指向 npmmirror。2026-10-29 夜上游发布
  `@aws-sdk/middleware-websocket@3.972.60`（依赖尚未同步的 `@aws-sdk/core@^3.978.7`）⇒
  `ERR_PNPM_NO_MATCHING_VERSION`。本场给 `pack-macos.mjs` 的 deploy 步加了**可选**
  registry 覆盖（`CORUM_PACK_REGISTRY=https://registry.npmjs.org`），只在显式设置时生效，
  默认行为不变。
- `react-dom` 现在是 `@corum/corum-ui-chat` 的 devDependency（组件级渲染测试需要）；
  `@corum/corum-ui-conversation` 从其 devDependency 提升为 **dependency**（chat 现在有运行时值引用
  `toolArguments`，且 `tsdown` 必须把它列进 `extraExternals` 的**完整 specifier**
  `@corum/corum-ui-conversation/client` —— plugin-build 的 noExternal 是精确匹配）。
