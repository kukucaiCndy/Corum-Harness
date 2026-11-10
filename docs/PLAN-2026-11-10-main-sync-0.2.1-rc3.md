# main ↔ upgrade/0.2.1-rc3 同步计划（2026-11-10）

> 目标：把 main 在 0.1.5-rc.3 线上解决的问题逐项在 0.2.1-rc3 升级线上核验
> （问题是否仍存在 / 修复内容是否已携带），把缺失修复移植进升级分支，
> 门禁全绿后将 main 升级到 dsh 0.2.1-rc3。

## 0. 拓扑盘点（事实源 2026-11-10）

| 项 | 值 |
|---|---|
| 本检出 | `/Users/kukucai/work/kukucai-desktop-main`，分支 `upgrade/0.2.1-rc3`（= origin/upgrade/0.2.1-rc3） |
| main 的真身 | `kkc-desktop` 检出的本地 `main` = `3b53ffb6`（**领先 origin/main 2 个未推送提交**） |
| origin/main（GitHub） | `4176f07e` |
| 共同祖先（merge-base） | `bec1e139` |
| 升级线缺 main 提交数 | **32**（27 实体 + 5 merge；30 个已在 origin/main，2 个仅 kkc 本地：`52242ddb`、`3b53ffb6`） |
| main 缺升级线提交数 | **101**（100 个升级提交 + 本检出本地 docs 提交 `bacd04ab`） |
| 工作区未提交 WIP | ~2900 行：fork #18 `@corum/corum-ui-renderer`（rc3 主窗白屏四类防御）+ fork #19 `@corum/corum-session-query-sqlite`（CJK 逐字分词）+ MonacoEditor/approval/preset 一批防御修复（`.dbg-evidence/rc3-defensive-fixes/`） |
| `git cherry` 判定 | 32 个提交**零个**以 patch-id 等价形态在升级线；但 `cdp-targets` 领域模块存在手工移植嫌疑（main `1ec14e69` vs 升级线 `6e8fb1d3` 同名同主题）⇒ 一切以**内容级比对**为准 |

**升级线门禁状态**（41b0bedb 时点，docs/HANDOFF-2026-10-30-rc3-manual-verification.md）：
typecheck 52/52 零错、测试 3643 通过、build 57 包、fork-drift 0 红；**但 WIP 是其后产生，门禁需重跑**。

## 1. main 侧 32 个提交清单与风险分档

### 高风险（与升级重写面文件重叠 ≥2，升级可能已丢/冲突）

| 提交 | 主题（问题） | 重叠文件数 |
|---|---|---|
| `ee6f16c0` | extension-pack 活动栏注册 + 安装/卸载守卫 + 迁移框架 + fflate 内联（#178） | 6 |
| `61832d41` | extension-plugin 符号链接安装，消灭两份副本（#192） | 5 |
| `bfe913ae` | extension-pack 活动栏 + 守卫 + 模型可用性 + pi session 修剪（#180） | 4 |
| `1ec14e69` | plugin-sdk cdp-targets 领域模块（#158） | 4（升级线有同名移植嫌疑） |
| `ae7fcede` | orchestrate research 任务模型路由 + closer 模型显示 + reasoningEffort 默认 high（#173） | 4 |
| `f7e59f5c` | 修「分叉会话」不可用 —— corum 自有泳道 fork（#159） | 3 |
| `b3d4f19a` | cdp-router 内建进本体（#161） | 3 |
| `c7279d1a` | test-suite 全屏 face + 活动栏入口（#168） | 3 |
| `5ed82a1f` | corum-tool-subagent 委派面从根上下文解析（#195） | 3 |
| `ca4b462d` | pack：corum-cdp-router 进 desktop-host 闭包（#162） | 2 |
| `9c5d24f3` | 扩展包预设缺 model 字段 → 预设页整页空白（#170） | 2 |
| `e96cd1b1` | tool-subagent 重跑用用户选定路由（#196） | 2 |
| `4cdd69b3` | 产物文件名带构建时戳，修打包重名覆盖（#198 前置） | 2 |
| `52242ddb` | tool-subagent 输出 schema 补 spawnModel 声明（未推送） | 2 |

### 中风险（重叠 1）

`2a3c021c`（版本号构建时间戳 #174）、`9b855ea5`（迁移每次启动都跑 #193）、`4176f07e`（供应商区域通道 -中国/-国际 #198）

### 低风险（重叠 0，预计可直接 cherry-pick 或纯 docs）

`cdcc35dd`（pnpm PATH 回退 #160）、`068baa65`（docs）、`3c36093b`（cdp-router 白屏真因 #164）、`6450efc5`（cdp input/screenshot/runScript 原语）、`834f3b13`（最大输出词元快捷选择 #169）、`5409d0e6`（target.ip 远程 CDP #175）、`968ebc93`（cdp-verify resize 作用域）、`22a40358`（AGENTS.md 去绝对路径）、`1c40d29f`（CDP 目标页重写 #191）、`3b53ffb6`（test，未推送）+ 5 个 merge 提交（合入时吸收）

> ⚠️ 「重叠 0」只说明**文件集合**不相交，仍需内容级检查：rc3 升级可能改了这些提交所依赖的 API（如官方 0.2.1-rc.3 自带 session-query-sqlite、presets 机制重构）。

## 2. 执行阶段

### P1 逐项验证（本计划核心，读为主）
对 27 个实体提交逐个产出四元组判定：
`[问题在 rc3 上是否仍存在 | 修复内容是否已携带（内容级）| 移植方式 | 置信度]`
- **静态**：读 `git show <c>` diff，在 rc3 工作树（含 WIP）里定位对应代码，判断：已随升级携带 / 官方 rc3 底已解决 / 缺失 / 依赖 API 已变需重写。
- **行为**：高风险 bug fix（#159 分叉会话、#160 PATH、#164 白屏、#170 预设空白、#173 编排路由、#192/#193 扩展包、#195/#196 subagent）在**新起的隔离实例**上跑 CDP 探针复现/证伪。纪律：不碰用户 `:9333` 核验实例、绝不动主实例 `:9222`、隔离 home。
- 产出：判定矩阵（本文件 §3，随做随填）。

### P2 收口 WIP（写）
- 跑门禁：`tsc --force` 全包 typecheck、全仓测试、`verify-fork-drift.sh`、`verify-plugin-spec.mjs`、build。
- 全绿后把 fork #18/#19 + 防御修复提交到 `upgrade/0.2.1-rc3`（按簇分提交）。
- 若有红：先修红或回退对应 WIP 片段，如实记录。

### P3 移植 main 修复（写，按簇）
- 顺序（从独立到耦合）：docs 簇 → 低风险直接 cherry-pick → cdp-router 簇 → cdp-verify/版本时间戳 → settings 簇（#169/#198）→ extension-pack 簇（#178/#180/#192/#193）→ subagent 簇（#195/#196 + 未推送 2 个）→ #159 分叉会话 → #173 编排路由。
- 每簇：cherry-pick 冲突则**以 rc3 底为准手工重放语义**（不机械吃官方冲突侧），补/移植对应测试，跑该簇包的 typecheck+test。
- 判定为「官方 rc3 已解决」或「升级线已携带」的：不重复移植，记录证据锚点。
- 已在 rc3 上不复现且无移植必要的：记录判定依据，标记关闭。

### P4 门禁 + 终局同步（写）
- 全量门禁重跑（同 P2 清单 + 实机冲烟 `scripts/corum-smoke.mjs`，macOS 侧）。
- `git merge kkc/main` 进 `upgrade/0.2.1-rc3`（吸收全部 32 提交含 2 个未推送），或如走全 cherry-pick 路线则直接 FF。
- `main` 指向升级分支头（在 kkc 检出操作或推 origin）。
- **推送 origin/main 前必须征得用户确认**（含 kkc 本地那 2 个未推送提交的处置）。
- 台账：`docs/VERSIONING.md` 追加发版行（应用版 ↔ 基座版 0.2.1-rc.3）。

## 3. 判定矩阵（P1 已完成，2026-11-10，四簇并行只读调研）

> 完整子报告：orchestrate 汇总 `~/.corum/orchestrate-reports/call_657eb04f431f4535a45e6cd3.md`。
> 总判定：**无任何一笔 OFFICIAL-FIXED**（官方 0.2.1-rc.3 不带回来任何 fork 自有修复）；
> ≈17/19 功能提交缺失，1 笔源码级携带（1ec14e69），1 笔半携带（9c5d24f3 UI 半 + bfe913ae instance.sh 半）。

| 提交 | 问题 | 判定 | 处置 |
|---|---|---|---|
| 1ec14e69 | cdp-targets SDK 模块 | **CARRIED**（6e8fb1d3 逐字节等价，仅缺 18 行测试加固） | 可选补测试 |
| b3d4f19a/ca4b462d/3c36093b/6450efc5/5409d0e6 | cdp-router 包本体+打包+白屏修复+原语+target.ip | **MISSING（整簇）** | 从 kkc/main tip 终态整树移植 + rc3 overlay 结构重放注册 |
| 1c40d29f | CDP 目标页重写 | MISSING（⚠️ 空树提交，内容经 61832d41 落树，勿作 pick 源） | 随 cdp-router 簇 |
| 968ebc93 | ui-verify resize 作用域+视口校验 | MISSING（脚本半可直 pick） | `git show 968ebc93` 脚本半直接 cherry-pick |
| c7279d1a | test-suite 全屏 face | REWRITE-NEEDED（AppFrame/index.tsx 已被 rc3 漂移 +280/-40） | 手工重放 |
| ee6f16c0 | extension-pack 迁移框架+守卫+活动栏+fflate | MISSING（fflate 内联可近乎直 pick） | 分件重放 |
| bfe913ae | 活动栏+守卫+模型可用性+pi 修剪 | 拆分：instance.sh=CARRIED（e3c6487e 更优）；effectiveProfileModel MISSING 可直放 | 直放 + 重放 |
| 61832d41 + 9b855ea5 | #192 符号链接安装 + #193 每次启动迁移 | **MISSING（机制整套不存在）** | 按最终态移植：plugin-link-install.ts + migrateToLinks 模块 + boot 每次直调 |
| 9c5d24f3 | #170 扩展包预设缺 model → 预设页空白 | UI 半=CARRIED（WIP agent-model.ts）；host 半仍缺（agent-service.ts:1202） | 与 effectiveProfileModel 一起补 host 半 |
| ae7fcede | #173 research 模型路由+closer 显示+reasoningEffort | **MISSING（四块全缺）** | 成组重放（与 52242ddb 成对） |
| 5ed82a1f | #195 编排 closer 撞失活 ctx | **MISSING（触发器+脆弱调用面+派发路径逐字同形仍在）** | **第一优先级**手工重放（ctx.root.get 语义不变，调用面改 startActivation） |
| e96cd1b1 | #196 重跑改用用户选定路由 | MISSING（三处 delete agentOptions + 撒谎注释仍在） | 近乎原样重放（依赖的 agentOptionsOwnedByMechanism 已在） |
| 52242ddb + 3b53ffb6 | spawnModel schema + 校验测试（未推送） | MISSING（暂不可触发，但与 ae7fcede 强耦合） | 成组带回 |
| 834f3b13 | #169 最大输出词元快捷选择 | MISSING（4 文件路径未动） | 直接 cherry-pick |
| 2a3c021c | #174 版本号构建时间戳 | MISSING（7 文件同名） | 直接 cherry-pick |
| 4cdd69b3 | 产物名构建时戳（DMG 重名） | MISSING，**严格依赖 2a3c021c 先行**，pack-macos.mjs 是 WIP 重灾区 | WIP 收口后手工重放 |
| 4176f07e | #198 供应商区域通道 -中国/-国际 | MISSING（主体可搬；靛蓝主题 6 文件捆绑项需裁决） | 主体重放 |
| f7e59f5c | #159 分叉会话不可用 | **REWRITE-NEEDED（唯一必须重写）**：假入口仍在 ide-sidebar-ui:214-221、官方 fork 仍 mint 无前缀 id | 按新布局自建 forkTaskAgent 重写 |
| cdcc35dd | #160 pnpm PATH 回退 | MISSING（spawnPnpm 逐字节等于修前形态） | 直接 cherry-pick（与 #192 合批） |
| 22a40358 | AGENTS.md 去绝对路径 | MISSING（3 行） | 直接 cherry-pick |

### 移植批次总序（closer 建议，已采纳）

> **执行完毕（2026-11-10）**。落盘提交对照：

| 批次 | 内容 | 提交 |
|---|---|---|
| WIP 收口 | fork #18/#19 + 防御修复（门禁全绿后落盘） | `bdbbb521`、`fb64dba0`（计划文档） |
| ⑥ 低风险直 pick | #169 / #160 / AGENTS 去路径 | `5aa5e22c`、`5b54fee8`、`944d23aa` |
| ① #195 编排 closer 撞失活 ctx | ctx.root.get 语义重放（startActivation 形态） | `035cc097` |
| ② #196 重跑用户选定路由 | corumApplyRetryRoute 逐字带回 | `3f07f00f` |
| ③ #173+spawnModel schema+校验测试 | 成组（oneOf 两支形态适配） | `e1fcacc1` |
| ④ cdp-router 整簇 | 包 19 文件+注册+打包+ui-verify+test-suite face+docs+sdk 加固 | `f9fd3351`、`395be9eb`、`a232d3f1` |
| ⑤ extension-pack 簇 | #192/#193 终态+守卫/活动栏/fflate+#170 host 半 | `adf66374`、`d859497f`、`bdae2762` |
| ⑦ 打包链 | 版本时戳→产物时戳→供应商区域（含靛蓝主题） | `db2438b0`、`6554ab8a`、`1816e559` |
| ⑧ #159 分叉会话重写 | forkTaskAgent 端点 + 撤假入口 + 可见性 | `03124987`、`11147415` |
| 守卫记账 | refactor-guard 吸收 9 个净增 RPC + 去重缺陷修复 | `9d83a1d1` |

**官方 rc.3 fork 语义核对结论**（批⑧前置）：rc.3 仍未修——
`packages/api/session-controller/src/commands.ts:272` 仍 mint 无前缀 id、:273 仍只查官方
preset 注册表 ⇒ main 修法（自建 forkTaskAgent）重放成立。

**刻意不移植项（裁决记录）**：
- main 的 `migrate-remove-stale-runtime-bundle`：前提是运行期 bundle 机制已移除，rc3 线的
  runtime-bundle 是在用核心机制，移植会破坏 boot（AGENTS 红线 8 记录）。
- `1c40d29f` 的内容经 `61832d41` 落树，已随 cdp-router 整树终态带入，不单独 pick。
- `install-local.ts` 的旧字节复制语义被 #192 终态替换。
- 消息级分叉 `forkAt`（corum-ui-chat apply.ts:437）仍走官方 `ctx.sessions.fork`——与 main
  同形态，未顺手改（main 同处未改）。
- 两处与 main 同款的措辞不一致（release.mjs 头注释「含 feat→minor」、pack.mjs「五步」实为
  4 步）按「完全同步」原样保留。

### 遗留裁决项状态

- ~~官方 rc.3 复核~~ 已核（见上，仍未修）。
- ~~靛蓝主题 6 文件随行~~ 已带（1816e559）；trim-pi-session.py 已带（d859497f）；18 行测试加固已带（a232d3f1）。
- 技能侧同步（corum-plugin-dev SKILL.md Activity bar 节）住在 corum-dev-preset 扩展包仓，未做——需在 `corum-dev-preset` 仓同步（本仓 GUIDE.md §3.5 已更新）。
- `verify-symlink-migration-e2e.mjs` 待打包场补跑。
- 最终 push origin/main 及 kkc 本地 2 个未推送提交的处置：**待用户确认**。

## 4. 终局门禁与合并（2026-11-10 完成）

| 门禁 | 结果 |
|---|---|
| 全仓强制 typecheck | **55/55** PASS，0 语义错（新增 cdp-router 包 54→55） |
| 全仓测试 | **0 失败**（exit 0） |
| verify-plugin-spec --strict | 54 包 **0 错 0 警** |
| verify-fork-drift | **通过**（跳过 13 项，无红） |
| verify-refactor-guard | **41/41**（修掉 2 项既存红：冻结基线吸收 9 个净增 RPC + sort 去重，`9d83a1d1`） |
| 全仓 build | **58/58** 包 |
| 完整打包链 | host 闭包/平台断言/fork 断言全过；**DMG 阶段 hdiutil 失败为机器级环境问题**（1 文件空目录实测复现，与改动无关；.app 正常产出） |
| 打包态冲烟（隔离 :9335 + 隔离 home） | **8 通过 / 0 失败**：主 IDE ready（bootEntries=75）、控制台零错误、master-key 0600、Electron pin 一致；版本串 `v0.7.0-local+202611101233` 实锤构建时戳 |
| verify-symlink-migration-e2e | **全部通过**（老用户实体副本 → 升级 boot → symlink + link: 记账） |

**打包链顺带修掉 2 个 WIP 遗留断言缺陷**（fork-delta §22.5「打包闭包未验」的实锤）：
`3a5f71e5`（fork #19 断言读错文件：cordis.patch.yml → cordis.ide.patch.yml）、
`ff6f01b9`（B3 哨兵标记判据：构建产物里是原始控制字符 \x1f 而非转义文本）。

**终局合并**：`3cb26135` = `git merge -s ours kkc/main` —— main 的 32 个提交
（含 2 个未推送）语义吸收完毕，kkc/main 成为 HEAD 祖先（`HEAD..kkc/main` = 0），
树完全取升级线终态。main 可快进到升级线 HEAD。

**下一步（待用户确认）**：推送 `origin/upgrade/0.2.1-rc3` 与把 main 快进到本线 HEAD
（kkc 检出操作或直接推 origin/main）；corum-dev-preset 技能侧 Activity bar 节同步。
