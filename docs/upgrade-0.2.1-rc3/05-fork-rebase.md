# 阶段 3：50 个 fork 包 rebase

> 状态：待执行 | 前置：阶段 1（被删/更名包）+ 阶段 2（override 重算 + lock 重生成）已完成 | 工程量：高（50 包 × 6026 commit 跨度，历次升级之最）
>
> 单一事实源：`docs/UPGRADE-0.2.1-rc3-feasibility.md`（含评审修订 §六 阶段 3）。
> 评审证据：`~/.corum/research-reports/885858d9-…md`（fork 台账落后：实 50 个、fork-delta.md 只登记到 17）；`06867ebb-…md` E3 节（corum-subagent rebase 是单独大头）。
> fork 台账 + 升级 runbook：`docs/fork-delta.md`（§5 runbook、§10 corum-subagent 详录、§10.3-5 沙箱钳制三接线回归门禁）。
> 方法论参照：交接文档 `HANDOFF-2026-09-29-official-0.1.5-upgrade.md` §2（逐包循环 / 包声明与 override 同时改 / 直接验证可解析性 / 实机验证不可替代）。

---

## 1. 目标与范围

将 `packages/plugins/` 下 **50 个 fork 包**全部对照官方 0.2.1-rc.3 重新合并（rebase），使每个 fork 包的源码与官方 0.2.1 对齐，同时保留 corum 增量（定制逻辑、重设计、新增能力）。

**fork 包构成**（已验证：23 agent + 12 session + 15 ui = 50）：

| 组 | 数量 | 目录 |
|---|---|---|
| agent | 23 | `packages/plugins/agent/*/` |
| session | 12 | `packages/plugins/session/*/` |
| ui | 15 | `packages/plugins/ui/*/` |

**本阶段产出**：50 个 fork 包全部通过 `tsc -b --force` typecheck + 各包测试 + fork-drift 守卫。

**不在本阶段范围**：
- 被删/更名包的 import 改写（阶段 1）
- override 重算（阶段 2）
- 实机 CDP 冲烟（阶段 4）

---

## 2. 前置条件

1. **阶段 1 已完成**：4 个被删/更名包 + session-title API 迁移 + HMR 形态经阶段 -1 裁决后处置（fork 包的 `package.json` deps 已更新指向 0.2.1-rc.3）。
2. **阶段 2 已完成**：override 表重算至 0.2.1-rc.3，lockfile 重生成成功，`pnpm install` 零报错。
3. **官方 dsh 检出已更新至 `dsh-v0.2.1-rc.3`**。
4. **阶段 -1（官方升级指南映射表）已完成**：特别是与 corum 直接相关的指南已映射（见 §3.1）。
5. **fork-drift 守卫已在阶段 1 改过 invariant 部分**：`scripts/verify-fork-drift.sh` 的 `:1129` 循环清单与 `:1180` `SUBAGENT_DELTA_FILES` 已去掉 `invariant.ts`（阶段 1 删 invariant 时同步改过）。

---

## 3. 输入与依赖

### 3.1 官方升级指南映射（阶段 -1 产出）

与 fork rebase 直接相关的官方升级指南（`docs/upgrade-guide/` 下 7 个版本目录共 43 篇）：

| 指南 | 版本目录 | 对应 fork 包 | 影响面 |
|---|---|---|---|
| `subagent-activations` | v0.2.1-alpha.1 | corum-subagent | activation 生命周期合并（`3d852a1cea` / `390fbe8852`） |
| `subagent-preset-composition` | v0.2.1-alpha.1 | corum-subagent | preset 从包声明改为 profile YAML（`d1e22a7e24`） |
| `jsonl-persistence-plugin` | v0.2.1-alpha.1 | corum-subagent（persistence） | SessionWriteLease/persistence 形态变化 |
| `working-directory` | v0.2.1-alpha.1 | session 域 fork 包 | 会话工作目录语义 |
| `session-title-provider-strategy` | v0.2.1-alpha.1 | corum-agent | session-title-llm provider API 迁移 |
| `remove-runtime-invariants` | v0.2.0-rc.2 | corum-goal-round-driver / corum-tool-subagent / corum-subagent / corum-tools | invariant 删除（阶段 1 已处理源码侧） |
| `plugin-engines-dsh` | v0.2.1-alpha.3 | corum-ide-plugin-manager-ui | 兼容性检查优先读 engines.dsh；拒绝记录 peers 改名 requirements（与 HMR 无关） |
| `from-default-profile-replaces-target` | v0.2.1-alpha.2 | — | corum 不受影响 + 备忘（CLI 重建会删目标目录；corum 不走该 CLI，profile patch 手维护） |
| `new-session-blank-reuse` | v0.2.1-rc.2 | session 域 fork 包 | 阶段 4 行为观察（corum 新任务走自有 RPC，不直接走 uiWorkspace.startSession） |

### 3.2 fork 台账

| 输入 | 状态 | 处置 |
|---|---|---|
| `docs/fork-delta.md` | 文首（第 3 行）自称「当前 fork 总数 16」，正文只登记到 §19「第 17 个 fork 包：corum-goal-round-driver」——**台账落后实际树 33 个包** | **步骤 0 先补台账到 50**（见 §4.1） |
| `docs/fork-delta.md` §5 runbook | 有效，逐包对照官方合并的执行流程 | 本阶段执行流程以此为基础 |
| `docs/fork-delta.md` §10 corum-subagent 详录 | 有效，含 §10.2 实质 diff 逐处登记、§10.3-5 沙箱钳制三接线 | corum-subagent 独立小节（见 §4.4） |

### 3.3 官方对照源

| 输入 | 来源 |
|---|---|
| 官方 0.2.1-rc.3 源码 | `/Users/kukucai/dsh` checkout @ `dsh-v0.2.1-rc.3` |
| 官方包目录树 | `git -C /Users/kukucai/dsh ls-tree -r dsh-v0.2.1-rc.3` |
| 官方 diff 统计 | `git -C /Users/kukucai/dsh diff dsh-v0.1.5-rc.3 dsh-v0.2.1-rc.3`（6026 commit / 12855 文件 / 161 万新增行） |

---

## 4. 执行步骤

### 4.1 步骤 0：补 fork 台账到 50（必须最先做）

**现状**：`docs/fork-delta.md` 台账只登记到 17 个（文首自称 16，正文到 §19 第 17 个），实际 50 个（23 agent + 12 session + 15 ui），**落后 33 个包**。

**步骤 0a**：枚举 50 个 fork 包全集。

```bash
ls -d packages/plugins/{agent,session,ui}/*/
```

**步骤 0b**：对未登记的 33 个包，逐个补入 `docs/fork-delta.md`：每个包新增一个 §N 节，包含：
- fork 包名 + 目录路径
- 官方对照包名 + 官方基线版本（0.1.3-alpha.1 或 0.1.5-rc.3，视各包 fork 时间而定）
- 文件数（corum src / 官方 src）
- 逐文件分类（逐字节相同 / 仅改名 / 实质修改 / corum 新增 / 官方有但 corum 删）
- rebase 风险标注

**步骤 0c**：修正文首「当前 fork 总数 16」为 50。

**每步验证**：`docs/fork-delta.md` 中 §N 节数量 = 50；文首数字 = 50。

### 4.2 逐包 rebase 方法（fork-delta §5 runbook）

**方法**：官方为底 + 贴回 corum 增量（交接文档 `HANDOFF-2026-09-29` §3 方法论）。

每包执行 fork-delta §5 runbook 的 4 步：

1. **第 0 步·前置对齐**：确认 fork 包 `dependencies` 的 `@deepseek-ai/*` 版本已更新为 0.2.1-rc.3（阶段 1/2 已做）；把官方 0.2.1 源码 checkout 到对照路径，重跑 `diff -r` 刷新台账统计。
2. **第 1 步·机械合并**：
   - 逐字节相同文件：官方新版直接覆盖 corum 对应文件。
   - 仅 import 改名文件：官方覆盖后执行机械替换（`@deepseek-ai/dsh-*` → `@corum/corum-*`）。
   - 根 `index.ts`：向官方写法对齐。
   - **⚠️ 整文件覆盖禁令**（2026-09-09 事故教训）：只对「逐字节相同」与「仅 import 改名」两类文件成立；凡在台账「实质修改」表里出现过的文件，禁止整文件拷贝官方版——必须逐处三方合并。反例：0.1.3 合并 `f09aa05b` 把 `corum-ui-chat/chat/TurnNavigator.module.css` 整文件拷成官方版，左 gutter 圆点刻度静默消失（编译全绿、console 干净，只能靠人眼看 UI 发现）。
3. **第 2 步·优先核对的语义地雷**：
   - 错误码命名空间（若官方继续演进错误码，corum 必须同步，否则错误处理静默失效）。
   - 官方新增 locale 键（对比官方各包 `locales.ts`，把 corum 缺失键补回——不要整文件覆盖 corum locales.ts，会丢掉 corum 键）。
   - 官方删除/改名 corum 正在 type-only 消费的 contract 类型。
4. **第 3 步·实质修改文件三方合并**：按台账 🔴 优先级逐处人工合并。
5. **第 4 步·验证**：`pnpm --filter <pkg> run build`（UI 包三步：`tsc -b && tsdown && node scripts/inline-css.mjs`）+ `pnpm --filter <pkg> run typecheck`。

**每包产出**：「漂移 / 增量 / 冲突」三栏记录，追加到 `docs/fork-delta.md` 对应 §N 节。

### 4.3 批次策略（按风险分档分批）

**批次排序**（建议，每批独立 commit + 独立门禁）：

| 批次 | 范围 | 包数 | 风险 | 理由 |
|---|---|---|---|---|
| 批 1 | 低风险 UI 元数据批 | ~8-10 | 低 | UI 包仅改 plugin-meta / 元数据 / 机械合并的，先过一遍建立流程 |
| 批 2 | session 域批 | 12 | 中 | persistence / working-directory 等有官方指南映射 |
| 批 3 | agent 域常规批（不含 corum-agent / corum-subagent） | ~21 | 中 | agent 包多为 host 侧，fork-delta 已有 runbook |
| 批 4 | corum-agent 单独成批 | 1 | **高** | 最大 fork 包（agent-service.ts 2500+ 行），依赖 dsh-agent-presets 删除、session-title API 迁移 |
| 批 5 | corum-subagent 单独成批 | 1 | **高** | fork 基线 0.1.3-alpha.1，官方热区含 activation 合并、continuation/child-agent 大改、沙箱钳制三接线（见 §4.4 独立小节） |

**每批门禁**：
- `pnpm --filter <batch-pkgs> run build` 全过
- `pnpm --filter <batch-pkgs> run typecheck` 全过
- 该批各包测试全过
- `git commit` 独立提交

**批次间不依赖**：批 1-3 可并行（不同包互不依赖），批 4-5 串行（依赖前序批次的类型/契约稳定）。

### 4.4 单列大头：corum-subagent（独立小节 + 独立排期建议）

**为何单独成批**（评审 E3 节 + 06867ebb 报告）：

1. **fork 基线最旧**：corum-subagent fork 自官方 **0.1.3-alpha.1**（其余 fork 多为 0.1.5-rc.3），距官方 0.2.1 跨度最大。
2. **官方热区直击 fork 增量**：
   - `subagent-in-process-driver` 删除（`3d852a1cea`），驱动逻辑并入 `dsh-subagent` 本体 activation 生命周期（`activation-driver.ts`，后折进 `activation.ts` 于 `390fbe8852`），`spawn-in-process` 仅剩薄壳。
   - continuation / child-agent 大改：fork-delta §10.2 中标「中」风险的 `child-agent.ts`、`continuation.ts` 全在官方改动热区。
   - `dsh-agent-presets` 被删（`d1e22a7e24`）→ preset 从包声明改为 profile YAML：corum-subagent 的 `child-agent.ts:28` 有 type import 需迁移。
3. **沙箱钳制三接线回归门禁**（fork-delta §10.3-5，**rebase 后必须绿**）：
   - **接线 1（工具层）**：`child-agent.ts` 的 `captureDelegatedPolicyOverrides` 增 `confineToWorktree`——隔离期子会话沙箱**钳到 `workspace-write`**（只收窄不放宽：`narrowerMode(父档位 ?? 'workspace-write', 'workspace-write')`；父 `read-only` 时维持只读）。
   - **接线 2（isolated provider）**：`isolated/index.ts` 的 `prepareIsolatedChild` 在 `cwd: child.path` 旁置 `confinedSandbox: true`。
   - **接线 3（continuable + 冷恢复）**：`continuation.ts` 三条路径同步 `confineToWorktree` / `confined`（`startContinuable` 策略捕获 / 新建 composition / `coldResume` 从 descriptor 重建）——**⚠️ 漏任一条 = 默认后台委派或冷恢复丢隔离边界**。
   - 回归门禁：`packages/plugins/agent/corum-subagent/tests/continuation-inheritance.spec.ts`（三档矩阵）+ `isolation-confinement.spec.ts`。
   - **设计要点 §10.3 #5（勿回退）**：隔离的沙箱档位是正交轴——`danger-full-access` 在官方 `fs-sandbox` / `bash-sandbox` / `terminal-bash` 三处都是直通不 confine，父档位一放宽，隔离的物理基础整档消失（实测：worker 删掉 19 个 worktree 并对主树 `git -C <主树> merge`）。rebase 时若这三条接线任一被官方改动或合并丢失，隔离会**静默退化**。

**执行建议**：
- 独立排期，不与批 1-3 并行。
- 先通读 fork-delta §10 全文（§10.1 总览 → §10.2 实质 diff → §10.3 设计要点 → §10.4 验证记录 → §10.5 fork #9 转正）。
- 先处理 `dsh-subagent-in-process-driver` 删除（阶段 1 已改 lib 产物模块名 + external 配置），再处理 activation 合并（`activation-driver.ts` → `activation.ts` 的结构变化），最后处理 continuation / child-agent 的三方合并。
- 沙箱钳制三接线合并后，立即跑 `continuation-inheritance.spec.ts` + `isolation-confinement.spec.ts`，全绿才算过。
- `dsh-agent-presets` 的 type import（`child-agent.ts:28`）按阶段 1 已迁移路径处理。

**每步验证**：
- `pnpm --filter @corum/corum-subagent run build` 过
- `pnpm --filter @corum/corum-subagent run typecheck` 过
- `packages/plugins/agent/corum-subagent/tests/continuation-inheritance.spec.ts` 全绿
- `packages/plugins/agent/corum-subagent/tests/isolation-confinement.spec.ts` 全绿
- 沙箱钳制三接线代码均保留（grep `confineToWorktree` / `confinedSandbox` / `confined` 确认存在）

### 4.5 6026 commit 跨度的破坏性 API 变更发现与记录

**背景**：0.1.5-rc.3 → 0.2.1-rc.3 共 6026 commit / 12855 文件 / 161 万新增行（已验证，06867ebb 报告 A 节）。这是历次升级最大跨度（上次 0.1.3→0.1.5 约 200 commit）。

**处置**：破坏性 API 变更**在逐包 rebase 中发现并记录**（可行性文档 §七 风险清单第 4 项）。不预先全量扫描 6026 commit——成本太高且 fork-delta 台账 + 官方升级指南已覆盖大部分热区。

**记录方式**：每发现一处破坏性 API 变更，在 `docs/fork-delta.md` 对应 §N 节追加「破坏性 API 变更」条目：
- 变更描述（什么 API 怎么变了）
- 影响的 fork 包 + 文件 + 行号
- corum 侧修法
- 官方 commit / PR / 升级指南引用（若有）

**接进实录**：所有发现的破坏性 API 变更汇总到本阶段实录（§9 实录要求）。

---

## 5. 验收标准

| # | 验收项 | 判据 | 验证方式 |
|---|---|---|---|
| 1 | 50 包全部通过 typecheck | `tsc -b --force` 0 错（**必须 `--force`**，增量编译会藏住破坏点——0.1.5 升级教训：不 force 时 31 处报错看不见） | `pnpm -r run typecheck -- --force` 或 `pnpm -r exec tsc -b --force` |
| 2 | 50 包全部通过测试 | 各包测试全过 | `pnpm -r test` |
| 3 | fork-drift 守卫通过 | `verify-fork-drift.sh` 退出码 0 | `DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.2.1-rc.3 ./scripts/verify-fork-drift.sh` |
| 4 | fork 台账补齐到 50 | `docs/fork-delta.md` §N 节数 = 50，文首数字 = 50 | grep 计数 |
| 5 | corum-subagent 沙箱钳制门禁全绿 | `continuation-inheritance.spec.ts` + `isolation-confinement.spec.ts` 全过 | `pnpm --filter @corum/corum-subagent test` |
| 6 | 50 包 build 全过 | UI 包三步（`tsc -b && tsdown && node scripts/inline-css.mjs`）全过 | `pnpm -r run build` |
| 7 | 每包有「漂移/增量/冲突」三栏记录 | fork-delta.md 每个 §N 节含三栏 | 人工检查 |
| 8 | 破坏性 API 变更已记录 | 逐包 rebase 中发现的全登记 | 实录检查 |

> **注意**：fork-drift 守卫已在阶段 1 改过 invariant 部分（`scripts/verify-fork-drift.sh` `:1129` 循环清单与 `:1180` `SUBAGENT_DELTA_FILES` 去掉了 `invariant.ts`）。阶段 3 跑守卫时确认这一改动已生效，否则守卫自身会误报 invariant.ts 漂移。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| corum-subagent rebase 是单独大头，热区直击 fork 增量 | **高** | 独立小节 + 独立排期（§4.4），先处理 activation 合并再处理 continuation/child-agent，沙箱钳制三接线合并后立即跑门禁 |
| 沙箱钳制三接线被官方改动或合并丢失导致隔离静默退化 | **高** | `continuation-inheritance.spec.ts` + `isolation-confinement.spec.ts` 是回归门禁，rebase 后必须绿；grep `confineToWorktree` / `confinedSandbox` / `confined` 确认存在 |
| 6026 commit 跨度的破坏性 API 变更 | 中 | 逐包 rebase 中发现并记录（不预扫描）；fork-delta 台账 + 官方升级指南覆盖大部分热区 |
| fork 台账落后 33 个包，rebase 无对照基准 | **高** | 步骤 0 先补台账到 50（必须最先做） |
| 整文件覆盖禁令被违反（0.1.3 事故重演） | 中 | 实质修改文件禁止整文件拷贝官方版；合并后跑 `verify-fork-drift.sh` §5「定制面不得与官方逐字节一致 + 定制标记必须存在」断言 |
| `tsc -b` 增量编译藏住破坏点 | 中 | **必须 `--force`**（0.1.5 升级教训：不 force 时 31 处报错看不见） |
| 官方升级指南漏列或过时 | 低 | 阶段 -1 已通读 43 篇并产出映射表；rebase 中若发现指南未覆盖的变更，追加到映射表 |
| 批次间类型/契约不稳定导致返工 | 中 | 批 1-3 可并行，批 4-5 串行（依赖前序批次稳定） |

---

## 7. 回滚方案

1. **分批 commit 可整批 revert**：每批独立 commit，`git revert <batch-commit>` 即可回滚该批全部改动。
2. **单包回滚**：`git checkout <pre-rebase-commit> -- packages/plugins/<group>/<pkg>/` 恢复单个 fork 包。
3. **corum-subagent 回滚**：独立 commit，`git revert <subagent-commit>` 回滚整个 rebase，恢复 fork 基线 0.1.3-alpha.1（但阶段 1 的 invariant 删除 + in-process-driver 改名不回滚，除非同时 revert 阶段 1）。
4. **fork-drift 守卫回滚**：若守卫自身改动需回滚，`git checkout HEAD~1 -- scripts/verify-fork-drift.sh`。
5. **全量回滚**：revert 阶段 3 所有 commit（批 1-5），恢复到阶段 2 完成状态。

---

## 8. 产出物与下游接口

| 产出物 | 消费者 | 接口 |
|---|---|---|
| 50 个 fork 包源码（与官方 0.2.1-rc.3 对齐 + corum 增量保留） | 阶段 4 验证 / 日常 build | `pnpm -r run build` / `pnpm -r run typecheck` |
| 更新后的 `docs/fork-delta.md`（50 个 §N 节 + 每包三栏记录 + 破坏性 API 变更登记） | 后续 0.2.x→0.3.x 升级 | fork-delta §5 runbook |
| fork-drift 守卫通过证据 | 阶段 4 验收 | `verify-fork-drift.sh` 退出码 0 |
| corum-subagent 沙箱钳制门禁通过证据 | 阶段 4 验收 | spec 全绿 |
| 破坏性 API 变更清单 | 阶段 4 实机验证 / 后续维护 | 本文件 §9 实录 |

---

## 9. 实录要求

1. **步骤 0 台账补齐记录**：33 个未登记包的补入过程，每个包的 §N 节内容。
2. **逐包 rebase 记录**：每包的「漂移 / 增量 / 冲突」三栏：
   - 漂移：fork 包相对官方 0.2.1 的新增/修改/删除文件清单
   - 增量：corum 保留的定制逻辑（功能、重设计、新增能力）
   - 冲突：三方合并中遇到的冲突及解决方式
3. **批次记录**：每批的 commit hash、包含的包、门禁结果。
4. **corum-subagent 独立记录**：
   - activation 合并（`3d852a1cea` / `390fbe8852`）的处置过程
   - continuation / child-agent 三方合并的逐处记录
   - 沙箱钳制三接线的保留确认（grep 证据 + spec 结果）
   - `dsh-agent-presets` type import 迁移记录
5. **破坏性 API 变更清单**：逐包 rebase 中发现的所有破坏性 API 变更汇总，每条含：变更描述 / 影响的包+文件+行号 / corum 修法 / 官方 commit 或指南引用。
6. **门禁结果**：`tsc -b --force` / 测试 / `verify-fork-drift.sh` 的完整输出或摘要。
7. **异常记录**：任何 typecheck 报错、测试失败、守卫误报均逐条记录根因与修法。
8. **与可行性文档的偏差记录**：实际工程量 vs 预估的偏差及原因（如批次拆分调整、corum-subagent 工时超预期等）。
