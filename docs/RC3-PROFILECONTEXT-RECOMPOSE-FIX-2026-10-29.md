# rc3 profileContext / recompose 丢覆盖层：真实根因与修复（2026-10-29）

> 本文件**纠正** `docs/RC3-BEHAVIOR-ACCEPTANCE-2026-10-29.md` §6 的两条错误结论：
> ①「宿主 ready 后无 LISTEN 的缺陷与本场改动无关」——它与本次修复的是**同一个根因**；
> ②「待决：换机器/避开 3080」——不需要换机器，3080 回落是组合丢层的**症状**，已消除。
> 全部证据在**硬隔离**环境里取得（`/tmp/rc3-iso-20261029rc3fix`，CDP 9333，独立 home/userData，
> 源 `~/.corum` 只读），主实例（PID 55794）全程未驱动、未重启、未 kill。

## 1. 根因（两层，缺一不可）

### 1.1 第一层：`profileContext.overlays = []` ⇒ 任何热重组都还原成基座默认

官方 `readProfilePatches()`（`@deepseek-ai/dsh-app-boot`）只组合

```
bundle 层 → profile 的 cordis.patch.yml → home patch → profileContext.overlays (+ telemetry)
```

而 `dsh-config-editor.edit()`（设置中心写盘）与 `dsh-hmr.reconcileProfile()` 都用它 recompose 整棵
profile 树。rc3 的 `boot.ts` 把 desktop/preset/IDE/combo 覆盖层只交给 `boot()` 的入参，
`profileContext.overlays` 是**空数组** ⇒ 每次重组：

- 官方 `plugin-manager` 行重新激活（desktop 自己已注册 `CorumPluginManager`）→
  `service "pluginManager" has been registered`；`credentials` 同理；
- `webserver` 回落基座默认 `3080`（本机被用户自己的 `dsh web` 占着）→ `EADDRINUSE`；
- IDE 壳行的 `disabled: true` 全部丢失。

**A/B 实测**（同一 temp home，唯一差别是 process 内把 `profileContext.overlays` 清空，
探针开关 `PROBE_OVERLAYS=empty`）：

| 形态 | 一次 `settings.update()` 的结果 |
|------|-------------------------------|
| overlays 为空（rc3 原状） | `dsh: warning: 2 entries did not activate`：`pluginManager has been registered` + `webserver listen EADDRINUSE 127.0.0.1:3080` |
| overlays 完整（本修复） | 写入成功，端口不变、服务不重复（见 §3） |

### 1.2 第二层：行定义（insert）留在 overlay ⇒ corum 设置写必然被官方守卫误拒

只把覆盖层塞回 `profileContext.overlays` 后，`settings.update()` 换成了另一个失败：

```
Configuration for "corum-review" is overridden by a home patch or command-line overlay
```

这是官方 `config-editor` 的守卫（写完 profile patch 后重新组合，要求该行的**生效 config** 等于刚写入的值）。
它必然不成立，原因来自 `composeEntries()`（`@deepseek-ai/cordis-plugin-include`）的两条硬事实（已单测固定）：

1. **`insert` 行是 append 语义、不按 id 去重** ⇒ 同一行定义叠两层会插入两行同 id（loader 报错）；
2. **只带 `id`/`config` 的覆盖行无法创建行**：目标行还不存在时，这一行被**丢弃**。

corum 的全部行（`corum-review` / `corum-web-search` / `corum-conversation` / combo 的
`@corum/corum-agent` …）都由 desktop/IDE/combo 的 `insert` 块创建，位于 profile patch **之后**
⇒ 用户写在 profile patch 里的 config 被丢弃 ⇒ 守卫拒绝、值也不生效。

实测（修复前，overlay 已完整）：4 个 corum 设置 ns 的写全部被拒；只有官方 bundle 声明的
`agent-preset-registry` 能写。这直接决定 P7 不可能通过。

### 1.3 修法：行定义进**运行期 bundle**，覆盖行留在 overlay

bundle 层是唯一同时满足两个条件的层：**在 profile patch 之前**（所以配置能覆盖、守卫通过），
且**官方 `readProfilePatches` 从磁盘同样读得到**（所以热重组与冷启动一致）。

- 新增 `packages/desktop/src/host/runtime-bundle.ts`：每次 boot 按当前进程的层栈
  （桌面层 → presets → IDE 模式层 → combo 规则文件 → combo 插件行）把各 patch 文件里的
  **顶层 `- insert:` 块按原文切出**，写到 `$DSH_HOME/desktop-runtime-bundle/cordis.patch.yml`，
  并把该包登记进 profile manifest 的 `dsh.profile.bundles`（`$DSH_HOME/profiles/node_modules`
  下建同名符号链接供官方 `resolveBundleDir` 解析）。
  按原文切片（不做 load→dump 往返）是为了 `!!js` 表达式（`dshHomePath(...)`、
  `process.platform === 'win32'`）逐字保留；已有单测断言每个块都是源文件的**逐字子串**。
- 新增 `packages/desktop/src/host/desktop-overlays.ts`：`composeDesktopOverlays()` 产出
  「profileContext 固定层」与「boot 完整层」，`pickOverrideRows()` 从解析结果里滤出覆盖行
  （`disabled`/`config`）。**绝不 filter `disabled: true`**（AGENTS.md 红线 5：禁用行同时承担
  「抑制官方包、让 fork 独占 service 名」）。
- `boot.ts`：`mode`/`combo` 解析提前到 profile 装载之前 → 发布运行期 bundle → 内容或 manifest
  有变化时重新 `loadProfileWithSkip`（`changed=false` 时不重载，重启实测无重写）→
  `profileContext.overlays` 取固定层覆盖行。
- **minimal 模式**：官方 `plugin-manager` 的禁用行原在 `cordis.ide.patch.yml`（只有 IDE 模式加载），
  而 desktop 恒 provide `profileContext` ⇒ minimal 模式会与 `CorumPluginManager` 撞服务名。
  该行已上移到 **`cordis.patch.yml`**（两种模式都加载）。
- **不搬**的三类：telemetry patch（官方按 `telemetryDisabledEnv` 现算，不能重复）、
  扩展包 insert 行与插件中心禁用行（各有 `extensionManager` 热应用通道）。已知残余：
  一次 recompose 后这两类行会丢到下一次热应用/重启为止（与修复前同形态，非本修复引入）。

### 1.4 `TypeError: Cannot read properties of undefined (reading 'await')`

在本次全部实机运行（隔离实例、真实写盘、A/B 两臂）中**未能复现**：空 overlay 那一臂爆出的
是 §1.1 的激活失败（重复服务 + 3080 EADDRINUSE），修复后一臂全链成功。故**未做针对它的单独改动**，
也不宣称它「已修复真因」——只确认它不再是可观测失败。若再出现，先抓完整堆栈再动
（候选点：`dsh-hmr/lib/index.js` 的 `ctx.loader.await()`、
`dsh-app-boot` `recompose()` 的 `fiber.await()`；都需要真实堆栈定位，不许凭症状改）。

## 2. 测试（新增，全部可复跑）

| 文件 | 判据 |
|------|------|
| `packages/desktop/tests/desktop-overlays.test.mjs` | 9 条：固定层顺序/内容、`pickOverrideRows` 只剔 insert、`readProfilePatches` 在固定层与 boot 输入**逐行一致**、telemetry 只由官方生成且仅在末尾、真实 patch 文件里 `plugin-manager`/`credentials` 的 disabled 行不被过滤、insert 块是源文件逐字子串 |
| `packages/desktop/tests/profile-context-recompose.test.mjs` + `tests/fixtures/recompose-probe.mjs` | **真宿主**（子进程完整 boot web profile）：冷启动 `127.0.0.1:<ephemeral>` 真 LISTEN（真 TCP connect，不看日志）、`pluginManager=CorumPluginManager`、`credentials=LocalCredentialProvider`、行数唯一；`settings.update()`（= ConfigEditor → readProfilePatches → reconcile → recompose 全链）后**端口不变且仍 LISTEN**、设置读回生效、覆盖层与服务不变；profile patch 与 runtime bundle 登记都落盘；宿主 stderr 无 `has been registered` / `EADDRINUSE` |

```
desktop 包测试：164 pass / 0 fail（含上述 10 条）
desktop tsc host+client：0 error
pack（darwin/arm64 四步）：PACK_EXIT=0（dmg + zip）
assert-packaged-boot：✓（产物自带 Node，ready URL = http://127.0.0.1:55870/?token=…）
```

## 3. 硬隔离实机证据

| 项 | 值 |
|----|-----|
| 隔离根 | `/tmp/rc3-iso-20261029rc3fix` |
| `CORUM_HOME` / `DSH_HOME` | `/tmp/rc3-iso-20261029rc3fix/.corum-verify-home`（role=verify ⇒ 不会按仓库路径宽匹配清理） |
| `CORUM_USER_DATA_DIR` | `/tmp/rc3-iso-20261029rc3fix/user-data` |
| CDP | `9333`（拒绝 9222；启动前查空闲） |
| 产物 | 本仓 `packages/desktop/dist/mac-arm64/Corum.app`（含本修复） |
| 启动 | `./scripts/corum-instance.sh start --mode=packaged --home=/tmp/rc3-iso-…/.corum-verify-home --port=9333` |

**主机就绪与套接字（修复前「ready 但无 LISTEN」的那个缺陷）**

```
[corum-desktop] runtime bundle: 53 insert 行 / 5 块 → …/desktop-runtime-bundle（已更新）
[corum-desktop] combo "coding" host ready (http://127.0.0.1:57184/?token=…)

$ lsof -nP -iTCP:57184 -sTCP:LISTEN
node 12592 kukucai 12u IPv4 … TCP 127.0.0.1:57184 (LISTEN)
$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:57184/     → 401（鉴权在，服务在）
$ lsof -nP -iTCP:3080 -sTCP:LISTEN                                → 用户自己的 `dsh web`（PID 2976），未受影响
```

**热重组（settings 写）之后**：端口仍是 `57184`、仍 LISTEN、`pluginManager`/`credentials` 仍是 fork 实现、
`webserver` 行仍只有一条、`profileContext.overlays` 仍 40 行（含 `plugin-manager: disabled` 与
`webserver: port 0`）。**重启后**（`restart --mode=packaged`）：运行期 bundle 未重写（幂等）、
4 个 corum 设置值仍在（`stallRecoverMinutes=17` / `retentionDays=23` / `activeProvider=deepseek` /
`busyEnter=steer`），且都写在隔离 home 的 `profiles/web/cordis.patch.yml` 里。

**行为探针**

| phase | 结果 |
|-------|------|
| `--phase=full` | **4 pass / 8 fail / 0 skip**：P0、P1、P2、**P7** 通过 |
| `--phase=persist`（重启后只读） | **4 pass / 3 fail / 0 skip**：P0、P2、**P7（4 键真值全对）**、P8 通过 |

证据文件：`/tmp/corum-rc3-test/behavior-full.json`、`behavior-persist.json`。

**源 home 只读**：`settings.yaml`/`.credentials.yaml`/`.master-key`/`desktop-settings.json`/
`plugins.disabled.json`/`mcp-servers.json`/`.agent-presets/**`/`profiles/**` 共 **4654** 个文件，
启动前基线与收尾复核 `diff` **0 行**（`source-config-before.sha256` /
`evidence/source-config-final.sha256`）。主实例 PID 55794 全程存活；收尾只停自己 spawn 的 PID
（12585 / 13239）。

## 4. 仍未通过的 8 项（按**性质**分，不混为一谈）

产品缺陷（与本次 overlay 修复无关，修复前根本走不到这里）：

| 项 | 实测错误 | 归属 |
|----|---------|------|
| P4 | `corumAgent/setDefaultPreset` → `{"code":"gateway/internal","message":"cannot get property \"settings\" without inject"}` | host：RPC 调用作用域的 ctx 未 inject `settings`（`agent-service.ts` 的 `static inject` 有 `settings`，但 Remote 调用路径拿到的 ctx 不是它）|
| P11 | `Error: chain slot "conversation.chat.turnTail" requires options.select`（client 注册期） | renderer：某个 client 插件注册链槽时缺 `options.select` |

探针判据/选择器与 rc3 契约不符（**不是**产品回归；已修其中 4 处，见下）：

| 项 | 实测 | 说明 |
|----|------|------|
| P5 | ACP CLI `initialize` **成功**（`agentInfo.name=deepseek-harness-acp`），但判据用 host 诊断文件的 `profileName` | 与 P1 同因：干净启动会**删掉**诊断文件，`null` 是正常形态。P1 已按此修好，P5 未改 |
| P6 | `bogus` 被拒 ✓、`requeue` 过 boundary ✓（`queue-item-not-found` 是期望值），第三项 `官方 edit` 报 `wire field "request" failed boundary validation` | 探针少包一层 `request` |
| P3 | 找不到「设置」入口（`clicked:false`） | IDE 壳的设置入口不是含「设置」文案的 button |
| P8/P9 | session 在 `session/list` 里 ✓，但 IDE 侧栏 `[data-session-id]` 行数 0 ⇒ 点不开 | 探针的 DOM 契约按官方三栏壳写，IDE 侧栏是 fork |
| P10 | 无 `[data-details]` 触发器可点（`cards:2`） | IDE details 抽屉的入口选择器不同 |

已修的探针缺陷（本轮）：`session/list` 需要 `{_request:{}}`；`settings/describe` 真实形状是
`{writable,hasDocument,namespaces:[{ns,value,…}]}`；`agentPresets/list` 只返回 `{id,order,isDefault}`
（旧判据「name 非空」在 rc3 不可能成立，改为按契约判定并显式记录 `namesExposed=false`）；
干净启动下 host 诊断文件为 `null` 是正常形态。

## 5. 未做 / 下一步

1. P4（`settings` 未 inject）与 P11（链槽缺 `options.select`）是**两个真实缺陷**，本场未修
   （时间预算用于根因与验收路径）。两者都需先读现场代码再改，不许靠猜。
2. P3/P8/P9/P10 的探针选择器要对齐 **IDE 壳**（`data-slot` / 侧栏 fork 的 DOM），
   与产品实现同步修；P5/P6 的探针判据按 §4 表修。
3. 已知残余（本修复未改变）：一次 recompose 后，扩展包 insert 行与插件中心禁用行会丢到
   下一次热应用/重启；若要让它们也在重组中存活，正确做法是同样走 bundle 层（需产品决策：
   运行时启停语义是否允许写 profile manifest）。
