# 阶段 3：50 个 fork 包 rebase

> 状态：**三审完成，待执行**（2026-10-27 三方评审 + 指挥者裁决已定稿）｜ 前置：阶段 1（被删/更名包）+ 阶段 2（override 重算 + lock 重生成）已完成 ｜ 工程量：高（50 包 × 6026 commit 跨度，历次升级之最）
>
> 单一事实源：`docs/UPGRADE-0.2.1-rc3-feasibility.md`（含评审修订 §六 阶段 3）。
> 阶段 3 三方评审报告（2026-10-27，本册定稿依据）：
> - `~/.corum/research-reports/68549f64-…md`（fork 批次与 API 评审：corum-api-remotes 不能放低风险 UI 批；机器清单生成器格式；fork-drift 身份门禁）
> - `~/.corum/research-reports/1aa8ef95-…md`（preset 与 activation 评审：activation 合并比 05 描述更彻底；preset 从目录发现改声明注册；corum-tool-subagent 必须与 corum-subagent 同批）
> - `~/.corum/research-reports/5d0baec8-…md`（验收回滚与覆盖评审：expected-red 基线；AgentPreset.trust 误判；三处硬破 DoR）
> - 子报告 `~/.corum/research-reports/ba0eba5b-…md`（官方 0.2.1 热区 API diff 调查：三处硬破 + jsonl default export 删除 + credentials precedence）
> 前序评审证据：`~/.corum/research-reports/885858d9-…md`（fork 台账落后：实 50 个、fork-delta.md 只登记到 17）；`06867ebb-…md` E3 节（corum-subagent rebase 是单独大头）。
> fork 台账 + 升级 runbook：`docs/fork-delta.md`（§5 runbook、§10 corum-subagent 详录、§10.3-5 沙箱钳制三接线回归门禁）。
> 方法论参照：交接文档 `HANDOFF-2026-09-29-official-0.1.5-upgrade.md` §2（逐包循环 / 包声明与 override 同时改 / 直接验证可解析性 / 实机验证不可替代）。

---

## 1. 目标与范围

将 `packages/plugins/` 下 **50 个 fork 包**全部对照官方 0.2.1-rc.3 重新合并（rebase），使每个 fork 包的源码与官方 0.2.1 对齐，同时保留 corum 增量（定制逻辑、重设计、新增能力）。

### 1.1 阶段 3 核心 = preset 完整迁移 + activation 专项

阶段 1 仅做了 registry 类型重定向（type import 改 `dsh-agent-preset-registry`）。**preset 完整迁移和 activation 是阶段 3 的两大核心专项**，各有独立的执行步骤、落点和门禁（见 §4.6 preset 专项、§4.4 activation 专项）。阶段 1 的 registry 类型重定向以阶段 3 rebase 结果为准——rebase 时整体对齐官方，无实质双改风险。

### 1.2 fork 包构成

已验证：23 agent + 12 session + 15 ui = 50（`packages/plugins/{agent,session,ui}/*/`）。

### 1.3 本阶段产出

50 个 fork 包全部通过 `tsc -b --force` typecheck + 各包测试 + fork-drift 守卫（逐项身份门禁，非 exit 0）。不可 boot 台账 6 项逐项销账。

### 1.4 不在本阶段范围

- 被删/更名包的 import 改写（阶段 1 已完成）
- override 重算（阶段 2 已完成）
- 实机 CDP 冲烟 / 完整 pack / smokeBridge / assert-packaged-boot（阶段 4）

---

## 2. 前置条件

1. **阶段 1 已完成**：4 个被删/更名包 + `dsh-session-title-llm` provider API 迁移 + HMR 形态经阶段 -1 裁决后处置。
2. **阶段 2 已完成**：override 表重算至 0.2.1-rc.3，lockfile 重生成成功，`pnpm install` 零报错。fork 包 manifest 机械升版已在 04 完成（50 包 `@deepseek-ai/*` dep/dev/peer + desktop-host 全部升 `^0.2.1-rc.3`）。阶段 3 第 0 步只需确认（不再做机械升版）。
3. **官方 dsh 检出已更新至 `dsh-v0.2.1-rc.3`**。
4. **阶段 -1（官方升级指南映射表）已完成**：特别是与 corum 直接相关的指南已映射（见 §3.1）。
5. **fork-drift 守卫已在阶段 1 改过 invariant 部分**：`scripts/verify-fork-drift.sh` 的 `:1129` 循环清单与 `:1180` `SUBAGENT_DELTA_FILES` 已去掉 `invariant.ts`（阶段 1 删 invariant 时同步改过）。阶段 3 第 0 步需按 rc3 官方目录重生成守卫文件清单（见 §4.0 步骤 0c）。

---

## 3. 输入与依赖

### 3.1 官方升级指南映射（阶段 -1 产出）

> **fork manifest 机械升版已在阶段 2（04 册）完成**：50 个 fork 包 manifest 内对官方 dsh 的 dep/dev/peer 版本已统一改为 `^0.2.1-rc.3`，desktop-host 全部 `@deepseek-ai/*` 也已同批升版。阶段 3 不再负责机械升版——本阶段只做源码 rebase（fork 源码与官方 0.2.1 对齐 + corum 增量保留）。阶段 3 执行前的第 0 步只需确认 fork 包 `dependencies` 的 `@deepseek-ai/*` 版本已是 `^0.2.1-rc.3`（04 册 S1.2 已做）。

> **按 01 映射补齐所有归 3 条目**（01 §8 契约要求「阶段 3 手册应从映射表筛选所有归入阶段 = 3 的条目」）。以下条目具体执行仍待阶段 3 逐包对照，不预判不受影响。

与 fork rebase 直接相关的官方升级指南（`docs/upgrade-guide/` 下 7 个版本目录共 43 篇）：

| 指南 | 版本目录 | 对应 fork 包 | 影响面 |
|---|---|---|---|
| `subagent-activations` | v0.2.1-alpha.1 | corum-tool-subagent, corum-subagent | activation 生命周期合并（`3d852a1cea` / `390fbe8852`）；corum 自有 startContinuable→startActivation rebase（见 §4.4 activation 专项） |
| `subagent-preset-composition` | v0.2.1-alpha.1 | corum-tool-subagent, corum-subagent | preset 从包声明改为 profile YAML（`d1e22a7e24`）；删 persona/toolFilter 配置字段及 zod schema；spawn 改走 agentPreset；fork 继承父 preset |
| `jsonl-persistence-plugin` | v0.2.1-alpha.1 | corum-subagent（persistence） | **5 个测试文件 default import 改 `apply(ctx, {root})` 形态**（0.2.1 删除了 default export，类不再导出，唯一活路是 `apply`；**不是** namespace import——namespace import 仍拿不到类）。涉及 5 文件：`corum-subagent/tests/isolation-confinement.spec.ts:32`、`continuation.spec.ts:11`、`ownership.spec.ts:45`、`list-children.spec.ts:14`、`continuation-inheritance.spec.ts:21`（01/05 旧说法漏列后两个）。`ctx.plugin()` 调用方式不变 |
| `working-directory` | v0.2.1-alpha.1 | corum-subagent, corum-tools | 官方 `session/working-directory` 新包（`dsh-working-directory`）组合提供 cwd；corum 不再复制 cwd 变量（阶段 1 已删 `{{cwd}}`）；子 agent 使用官方 `ResolvedSubagentStartRequest.cwd`，corum `assertChildCwd` 只保留隔离补充判定；presentationMeta 嵌套 PTC 归阶段 4 验证 |
| `session-title-provider-strategy` | v0.2.1-alpha.1 | corum-agent | **阶段 1 已完成**（corum 零自定义 provider，只版本跟随）；阶段 3 仅确认 rebase 后无 provider 面残留 |
| `remove-runtime-invariants` | v0.2.0-rc.2 | corum-goal-round-driver / corum-tool-subagent / corum-subagent / corum-tools | invariant 删除（阶段 1 已处理源码侧） |
| `plugin-engines-dsh` | v0.2.1-alpha.3 | corum-ide-plugin-manager-ui | 01 判「corum 不受影响（已检索 engines.dsh/IncompatiblePlugin/PluginCompatibility）」；阶段 3 随批确认不受影响，**不列为待办** |
| `experimental-package-composition` | v0.2.1-alpha.1 | cordis.patch.yml 四组 disabled+insert | 新组合语义「只 enable 被删行的 patch 不插入插件」需重验四组 disabled+insert 模式（关联红线 5：不得 filter disabled 行） |
| `plugin-install-over-installed` | v0.2.1-alpha.2 | corum-extension-pack, corum-ide-plugin-manager-ui, corum-rpc-client | HMR 下 installBundle 对已安装包报 already-installed，需先 removeBundle |
| `transcript-view-legacy-normal` | v0.1.7-rc.2 | corum-ui-chat | legacy 'normal' 值改显示 'detailed'；corum 默认 'compact' 不受影响；corum-ui-chat fork 需 rebase 官方改动 |
| `native-subagent-bundle-tools` | v0.2.1-alpha.1 | corum-tool-subagent, corum-subagent | claude-code/codex bundle 注册 Host global tool；corum preset 行已 disabled（backgroundMode 死键阶段 1 已删）；BundleInfo.official/availability 新字段需核实 corum-ide-plugin-manager-ui 是否读取 |
| `python-ptc-sandbox` | v0.2.1-alpha.1 | corum-sandbox-local | Python PTC 需 sandbox/sandboxPolicy（corum 走 Node runtime 不受直接影响）；corum-sandbox-local fork 需 rebase（sandbox 服务面无变化） |
| `tool-presentation-mode` | v0.2.1-alpha.1 | corum-tools | **删 'both' 值**：`corum-tools/src/index.ts:810` zod union 移除 'both'；`:670` `ToolPresentationMode` 类型同步；官方测试已断言 'both' throw，corum 桌面端 ptcRuntime 无人提供，'both' 是死路径，跟随官方删 |
| `pi-ai-azure-provider` | v0.2.1-alpha.2 | corum-ui-settings-models（session 组） | azure provider route 从 `azure-openai-responses` 改名 `azure`；`ConfigureWizard.tsx:467`（实际在 **session 组** `packages/plugins/session/corum-ui-settings-models/`）的 id 需改 `azure`，label 改「Azure」；全仓 `azure-openai-responses` 仅此一处 |
| `stored-credentials-precedence` | v0.2.1-alpha.2 | corum-credentials-local | stored credentials 优先于环境变量（precedence 反转）；`describe()` 一律 `writable: true`；删 `assertUnshadowed`；seam 删 INVARIANT 重抛；corum-credentials-local fork 需移植 precedence 反转（移植须同摘 fork `:924` INVARIANT catch 并重核 `queueRefresh` 抛错传播） |
| `web-listener-trust-config` | v0.2.1-alpha.1 | — | **阶段 1 已处理**（删 trustedHosts 死配置 + 更新 boot.ts 注释）；阶段 3 仅确认 corum fork 源码零消费 `ctx.webRuntime`/`ctx.webStartup.trustedHosts`（已实测零命中），记无动作 |
| `from-default-profile-replaces-target` | v0.2.1-alpha.2 | — | corum 不受影响 + 备忘（CLI 重建会删目标目录；corum 不走该 CLI，profile patch 手维护） |
| `new-session-blank-reuse` | v0.2.1-rc.2 | session 域 fork 包 | 阶段 4 行为观察（corum 新任务走自有 RPC，不直接走 uiWorkspace.startSession） |
| `job-id-identity` | v0.2.1-alpha.1 | corum-tool-subagent | JobId 改 UUID 格式；corum 不构造 JobId；**工具描述需清理 job_output/job_kill 引用**（随 subagent-activations #1 一起做，见 §4.4 activation 专项） |

### 3.2 fork 台账

| 输入 | 状态 | 处置 |
|---|---|---|
| `docs/fork-delta.md` | 文首（第 3 行）自称「当前 fork 总数 16」，正文只登记到 §19「第 17 个 fork 包：corum-goal-round-driver」——**台账落后实际树 33 个包** | **步骤 0 先补台账到 50**（见 §4.1）；阶段 3 新增 `scripts/fork-rebase-inventory.mjs` 机器生成 50 包清单（见 §4.0 步骤 0d） |
| `docs/fork-delta.md` §5 runbook | 有效，逐包对照官方合并的执行流程 | 本阶段执行流程以此为基础 |
| `docs/fork-delta.md` §10 corum-subagent 详录 | 有效，含 §10.2 实质 diff 逐处登记、§10.3-5 沙箱钳制三接线 | corum-subagent 独立小节（见 §4.4），rebase 改走新 manager 结构重接线 |

### 3.3 官方对照源

| 输入 | 来源 |
|---|---|
| 官方 0.2.1-rc.3 源码 | `/Users/kukucai/dsh` checkout @ `dsh-v0.2.1-rc.3` |
| 官方包目录树 | `git -C /Users/kukucai/dsh ls-tree -r dsh-v0.2.1-rc.3` |
| 官方 diff 统计 | `git -C /Users/kukucai/dsh diff dsh-v0.1.5-rc.3 dsh-v0.2.1-rc.3`（6026 commit / 12855 文件 / 161 万新增行） |

---

## 4. 执行步骤

### 4.0 步骤 0：开工基线与 inventory（必须最先做）

#### 步骤 0a：记录 start hash

```bash
git rev-parse HEAD  # 记入阶段 3 实录 start hash
```

#### 步骤 0b：收集 expected-red 基线

当前树（阶段 2 完成态）已有**至少 12 包** typecheck 红、30+ 处语义错误（三方评审实测）。开工必须先把全量红记为工作清单，否则每批门禁从第一天起就是红的、失去判别力。

```bash
# (1) 全仓 --no-bail typecheck（先跑一遍拿全量失败清单）
pnpm -r --no-bail run typecheck 2>&1 | tee .corum-tmp/stage3-expected-red.log

# (2) 逐包 force（不能 pnpm -r run typecheck -- --force，见下文）
for pkg_dir in packages/plugins/agent/* packages/plugins/session/* packages/plugins/ui/* packages/desktop; do
  if [ -f "$pkg_dir/tsconfig.json" ]; then
    (cd "$pkg_dir" && npx tsc -b --force) || echo "FAIL: $pkg_dir"
    if [ -f "$pkg_dir/tsconfig.spec.json" ]; then
      (cd "$pkg_dir" && npx tsc -p tsconfig.spec.json --force --noEmit) || echo "FAIL(spec): $pkg_dir"
    fi
  fi
done 2>&1 | tee -a .corum-tmp/stage3-expected-red.log
```

> **不能写 `pnpm -r run typecheck -- --force`**：9 个包的脚本是 `tsc -b --pretty false && tsc -p tsconfig.spec.json --noEmit`，`--` 追加的 `--force` 落在 `&&` 链**最后一条命令**上，主编译未被 force（06 册 §4.1 已实测校准）。

保存 `.corum-tmp/stage3-expected-red.log` 与**包/错误身份清单**（每包哪些错误码、哪些文件行号）。当前至少 12 包，实际数字执行时生成。此清单是每批门禁的基线——**只许减少，新增红 = blocker**。

#### 步骤 0c：fork-drift 守卫文件清单按 rc3 重生成

官方 rc3 新增 6 文件（activation/manager/structured/catalog/archive-admission/control）、删除 continuation 三件套的官方对应物。`scripts/verify-fork-drift.sh:1180` 的 `SUBAGENT_DELTA_FILES` 还是 0.1.5 时代的清单。阶段 3 第 0 步加「drift 守卫文件清单按 rc3 官方目录重生成」，并决定 corum 端哪些 hybrid 文件（continuation-activation/inbox/run-settlement）在并入官方 manager 后**退役**、哪些保留进 `SUBAGENT_NEW_FILES`。

**守卫 §17 的官方 preset 路径在 rc3 已消失**：`:1281` `OFFICIAL_PRESETS="$DSH_CHECKOUT/packages/preset/agent-presets/presets"`——rc3 官方已删 `packages/preset/agent-presets/`（preset 内容迁到 `packages/bundle/web-app/presets/*.patch.yml` + registry）。`DSH_BASELINE_TAG=dsh-v0.2.1-rc.3` 跑守卫时 §17 会因目录不存在而误报/漏报。**§17 preset 路径改官方 `packages/bundle/web-app/presets/`**。其余锚点路径（`packages/api/remotes`、`sandbox/sandbox-local`、`fs/fs-local`、`core/tools`、`subagent/subagent`）rc3 全部健在。

#### 步骤 0d：新增 `scripts/fork-rebase-inventory.mjs`（机器生成 50 包清单）

50 包 × 6026 commit 靠「逐包中发现并记录」会把发现成本摊进每一次人工合并。这一步完全可机器生成。

生成器对每个 fork 包产出 `docs/fork-delta/inventory/<pkg>.json`：

```jsonc
// docs/fork-delta/inventory/<pkg>.json —— 生成器输出
{
  "pkg": "@corum/corum-tools",
  "officialBaseline": "dsh-v0.2.1-rc.3",
  "files": [{
    "path": "src/index.ts",
    "class": "substantive",          // identical | import-rename | substantive | corum-new | official-deleted
    "officialDiffVsPrev": "+381/-296",  // 0.1.5→rc3 官方侧变化量（热区信号）
    "corumIncrements": [{"lines": [17], "desc": "<自动留空，人工合并时补>"}]
  }],
  "exportFaceDiff": {               // 对 *.d.ts 做导出符号集 diff，机器可判
    "removed": ["settleRun"],        // ← 本轮三处硬破点全部能被这张表直接抓出来
    "renamed": ["CodeRuntime->PtcRuntime"], "added": ["STRUCTURED_OUTPUT_TOOL"]
  },
  "gates": { "typecheck": "pending", "build": "pending", "test": "pending", "drift": "pending" }
}
```

生成规则：`class` 由 `cmp`/`diff` 判（逐字节相同→identical；仅 `@deepseek-ai/dsh-*`→`@corum/corum-*` 行不同→import-rename；其余→substantive；官方有 corum 无→official-deleted）。**无官方对应物的 corum-only 包显式标记，不强行 diff**。

**50 包覆盖门禁**：每包要么有阶段 3 commit，要么 inventory 写「官方无变化/corum-only/无需改动」及证据；不能靠口头说完成。验收 = inventory JSON 覆盖 50/50 包、每个 substantive 文件的 hunk 数与台账一致、gates 全 green。

#### 步骤 0e：补 fork 台账到 50

**现状**：`docs/fork-delta.md` 台账只登记到 17 个（文首自称 16，正文到 §19 第 17 个），实际 50 个，**落后 33 个包**。

```bash
ls -d packages/plugins/{agent,session,ui}/*/
```

对未登记的 33 个包，逐个补入 `docs/fork-delta.md`：每个包新增一个 §N 节，包含：
- fork 包名 + 目录路径
- 官方对照包名 + 官方基线版本（0.1.3-alpha.1 或 0.1.5-rc.3，视各包 fork 时间而定）
- 文件数（corum src / 官方 src）
- 逐文件分类（逐字节相同 / 仅改名 / 实质修改 / corum 新增 / 官方有但 corum 删）
- rebase 风险标注

修正文首「当前 fork 总数 16」为 50。**每步验证**：`docs/fork-delta.md` 中 §N 节数量 = 50；文首数字 = 50。

### 4.1 逐包 rebase 方法（fork-delta §5 runbook）

**方法**：官方为底 + 贴回 corum 增量（交接文档 `HANDOFF-2026-09-29` §3 方法论）。

每包执行 fork-delta §5 runbook 的 4 步：

1. **第 0 步·前置对齐**：确认 fork 包 `dependencies` 的 `@deepseek-ai/*` 版本已更新为 0.2.1-rc.3（阶段 1/2 已做）；把官方 0.2.1 源码 checkout 到对照路径，重跑 `diff -r` 刷新台账统计。
2. **第 1 步·机械合并**：
   - 逐字节相同文件：官方新版直接覆盖 corum 对应文件。
   - 仅 import 改名文件：官方覆盖后执行机械替换（`@deepseek-ai/dsh-*` → `@corum/corum-*`）。
   - 根 `index.ts`：向官方写法对齐。
   - **⚠️ 整文件覆盖禁令**（2026-09-09 事故教训）：只对「逐字节相同」与「仅 import 改名」两类文件成立；凡在台账「实质修改」表里出现过的文件，禁止整文件拷贝官方版——必须逐处三方合并。反例：0.1.3 合并把 `corum-ui-chat/chat/TurnNavigator.module.css` 整文件拷成官方版，左 gutter 圆点刻度静默消失。
3. **第 2 步·优先核对的语义地雷**：
   - 错误码命名空间（若官方继续演进错误码，corum 必须同步，否则错误处理静默失效）。
   - 官方新增 locale 键（对比官方各包 `locales.ts`，把 corum 缺失键补回——不要整文件覆盖 corum locales.ts，会丢掉 corum 键）。
   - 官方删除/改名 corum 正在 type-only 消费的 contract 类型。
   - **三平台差异检查**（第四栏）：path 拼接/spawn-helper/locale/硬编码 shell，一条 grep 成本，正是 rebase 时最容易丢隐式假设修复的时机。
4. **第 3 步·实质修改文件三方合并**：按台账 🔴 优先级逐处人工合并。**合并后逐文件跑 `diff <fork文件> <官方同路径>`，diff 输出必须能逐 hunk 对上台账登记的 corum 增量行号区间；对不上号即失败**（防 0.1.3 TurnNavigator 事故复发）。
5. **第 4 步·验证**：`pnpm --filter <pkg> run build`（UI 包三步：`tsc -b && tsdown && node scripts/inline-css.mjs`）+ `pnpm --filter <pkg> run typecheck`。**删除/改名的包先清 lib 再 build**（`clean:false` 下 tsdown 不清 outDir，陈旧产物进闭包）。

**每包产出**：「漂移 / 增量 / 冲突」三栏记录 + 第四栏「三平台差异检查」，追加到 `docs/fork-delta.md` 对应 §N 节。每个 §N 节必须有「本包 rebase 判定」（改了什么；或「官方无变化 + corum 无增量 = 覆盖即完成」的显式记录）——没有这条，验收无法区分「漏包」和「无操作」。

### 4.2 依赖批次（重排）

> **批次重排依据**（三方评审 68549f64）：原 05 的「批 1 低风险 UI 元数据批」把 `corum-api-remotes` 混进去——而它当前 typecheck 就是红的，且被 14 个包依赖。它是基础层，不是低风险 UI 包。

**批次排序**（每批独立 commit + 独立门禁；commit 串行，工作包可并行）：

| 批次 | 范围 | 包数 | 风险 | 理由 |
|---|---|---|---|---|
| **A 基础** | corum-rpc-client → corum-ui-base → corum-platform；corum-api-remotes（独立，无 corum 内部依赖，被 14 包依赖）；corum-extension-registry → {corum-mcp-manager, corum-skill-manager, corum-extension-pack}；corum-preset-modules ← mcp+skill；corum-git-core ← platform + api-remotes；corum-orchestration ← git-core + platform | ~10 | 中 | 基础层先行；api-remotes 不能放低风险 UI 批（它的 client remote 16→24 是本次最重装配变更） |
| **C 常规 agent**（A 后） | corum-fs-local、corum-sandbox-local（←platform）、corum-credentials-local、corum-tools、corum-goal-round-driver、corum-todo-guard、corum-update-checker、corum-web-search（←ui-base!）、corum-memory/ollama/artgen（←api-remotes）、corum-session-queue-revert | ~13 | 中 | agent 包多为 host 侧；**corum-tool-subagent 移出此批，归 E 专项** |
| **E activation 专项** | corum-subagent + corum-tool-subagent + corum-orchestration 消费面，**同一执行者/串行**；之后 goal-round-driver 事件复核 | 3 | **高** | 两包通过 `ContinuableStartSpec`/`SubagentRuntime` 强耦合，物理上不可分批（见 §4.4） |
| **P preset 专项** | desktop presets.patch.yml（standard/ptc/cordis/minimal 覆盖 + conductor insert）+ dsh-agent-preset 声明包 dep + boot.ts roots 退役 + settings defaultId + 动态 register | 1（文件集） | **高** | 在 corum-agent 最终收口前完成；desktop shared files 单写者；可在 A 后准备，但 P 与 E 的组合语义需对齐 |
| **D corum-agent** | corum-agent（agent-service.ts 2500+ 行） | 1 | **高** | A/P/E 相关类型稳定后收口；依赖 dsh-agent-presets 删除、session-title API 迁移、preset 声明先行 |
| **B session/UI**（D 后） | 先 corum-ui-conversation ← corum-agent + rpc-client + ui-base → {ui-approval, ui-chat, ui-commit-card, ui-model-ask, ui-questions, ui-trajectory}；corum-ide-ui ← ui-conversation + rpc-client + ui-base → {ide-explorer/integrations/panel-bottom/plugin-manager/sidebar/statusbar/test-*, ui-titlebar, session-archive, ui-trajectory} | ~25 | 中 | `corum-ui-conversation` 依赖 `corum-agent`（批 D），D rebase 后类型面若变，已 rebased 的 session 批会被二次打破 |

**共享文件**（串行单写者）：`docs/fork-delta.md`、`docs/fork-delta/inventory/`、`packages/desktop/cordis.patch.yml`、`packages/desktop/presets.patch.yml`、`pnpm-workspace.yaml`、`scripts/verify-fork-drift.sh`、lockfile。所有批次对这组文件串行，由集成者统一处理。

**并行规则**：只允许包集合/文件不重叠且共享文件由集成者统一处理时并行；每批 commit 串行。

### 4.3 每批门禁

| 门禁 | 判据 |
|---|---|
| 本批 build/typecheck/test | `pnpm --filter <batch-pkgs> run build/typecheck/test` 全过 |
| 全仓 expected-red 身份比对 | `pnpm -r --no-bail run typecheck` 与步骤 0b 基线比对：**只许减少，新增红 = blocker**；不要前期要求全仓零错 |
| lib 清理 | 删除/改名的包先清 lib 再 build；UI 必须完整 build 三步 |
| lock frozen | 默认 `--frozen-lockfile`；只有 preset 新增 dep（`dsh-agent-preset`）解锁更新 lock 并独立 commit |
| start hash + diff 范围 + 测试数 + drift 身份 | 每批记录 |
| 三平台差异检查 | 每包第四栏 |
| shared 文件单写者 | 生成物不提交 |

### 4.4 activation 专项（批 E：corum-subagent + corum-tool-subagent + orchestration 消费面）

> **指挥者裁决**：activation 采用官方 rc3 单一生命周期所有者——`activation.ts`/`manager.ts`/`structured.ts` 为底；corum 旧 `SubagentContinuationManager`/`startContinuable` **不留并行 shim**。corum 增量按新 manager 重接线（隔离 confine/descriptor/child-roles/escalation/orchestrate/isolated/停止级联等）。spawn/fork provider 优先复用官方，corum isolated 保留；只有功能差异证据才保留 fork driver，**禁止双结算/双容量池**。

#### 为何 corum-tool-subagent 必须与 corum-subagent 同批

`corum-tool-subagent/src/index.ts:2757` 调 `runtimeCtx.subagents.startContinuable(...)`，`:2489/:2784/:2838` 调 `ctx.subagents.start(...)`——两个入口都是 corum-subagent fork 的自有面。若 tool-subagent 在批 C、subagent 在批 E，批 C typecheck 直接红（旧 API 已删）或批 E 落地后 tool-subagent 仍调已删除的 API。两包通过 `ContinuableStartSpec`/`SubagentRuntime` 强耦合，**物理上不可分批**。

#### 官方 rc3 的真实结构（评审基准，全部实读验证）

1. **activation 合并已完成且比旧 05 描述的更彻底**。官方 `packages/subagent/subagent/src/` 现在 22 个文件，其中 6 个是 corum fork 完全没有的新文件：`activation.ts`、`manager.ts`（1493 行，**官方把 corum 自建的那套 continuation 生命周期整体收编了**）、`structured.ts`、`catalog.ts`、`archive-admission.ts`、`control.ts`。
2. **官方 `SubagentRuntime` 公开面已无 `start(name, request)` 和 `startContinuable`**（index.ts 仅有 `startActivation` :255/:269、`sendMessage` :310、`getProvider` :573、`list` :581；`start` 只作为 `startExternal` 内部回调存活，manager.ts:214-217）。`git grep startContinuable dsh-v0.2.1-rc.3 -- packages` = **零命中**。
3. **完成通知在官方 manager.ts `notifySettlement`**（:1186-1207）：`if (!activation.announced || activation.delivery === 'caller') return` → `createSettlementMessage` → idle 时 queue、运行中 steer。**caller 投递不发通知**。
4. **`SubagentStartRequest` 现在有 `cwd`**（types.ts:137）和 `agentPreset`（types.ts:144）、`outputSchema`、`maxDepth`。fork #9 的立身之本「官方 seam 无 cwd 字段」在 0.2.1 已不存在。
5. **run id 全局唯一是硬性契约**：types.ts:288「Provider-minted id, unique across all parents, providers, and local Sessions in this runtime」。corum `out-of-process.ts:223` 还写着「parent-scoped run id」——**直接违反 rc3 契约**。
6. **tool-subagent**：config 里 `persona`/`toolFilter` 显式拒绝（index.ts:147-149），`backgroundMode`/`enableRunInBackground` 整个消失；工具结果只剩 `{ kind: 'activation', subagentId }`（index.ts:269/:337）；spawn 走 `agentPreset` + `allowedAgentPresets`（:96-97）。

#### 必须贴回的 corum 增量（贴到新结构的新位置）

**原样采用官方（corum-subagent rebase 的底）**：`activation.ts`、`manager.ts`、`structured.ts`、`catalog.ts`、`archive-admission.ts`、`control.ts`、`lifecycle.ts`、`depth.ts`、`projection*.ts`、`list-children.ts`、`internal.ts`、`client.ts`、`out-of-process.ts`、`assistant-output.ts`、`continuation-messages.ts`、`types.ts`、`index.ts`（底），`error.ts` 已逐字节一致。

**必须贴回的 corum 增量（贴到新结构的新位置）**：
1. **沙箱钳制三接线**（fork-delta §10.3-5）——注意贴回点全变：`captureDelegatedPolicyOverrides` 从旧 continuation.ts 挪到**官方 manager 的 activation 建立路径**（`establishLocalInputs` 一带，manager.ts:879-934）、`confinedSandbox` 进 `SubagentActivationSpec` 的 corum 扩展字段、cold resume 进官方 `deliverToChild`/resume 路径。**按新 manager 结构重接线，不是「最后处理 continuation/child-agent 三方合并」**。
2. **descriptor 增量字段**（kind/personaHint/confined，continuation.ts:193-199）→ 贴回官方 descriptor.ts 快照函数。
3. **`child-roles.ts`、`routing-guard.ts`、`escalation-*.ts`**（官方无对应物，整文件保留）。
4. **用户停止级联**（index.ts:243-263 的 session/event 监听 + `stopConversation`）→ 挂到官方 manager 的 ownership/release 面上。
5. **`isolated/` provider + `script-model-resolution`**（官方无）。
6. **orchestrate 的结构化输出** → 官方 `structured.ts` + `outputSchema`（request 字段）原生支持，corum 自有 `driver/structured.ts` 判定退役或转薄壳。

**不能共存（择一）**：
- corum `SubagentContinuationManager`/`startContinuable` ↔ 官方 `SubagentManager.startActivation`：**两个生命周期所有者，必须只留官方**。保留 corum 版 = 双份结算通知/双份容量池/双份 cold-resume。
- 官方 `dsh-subagent` 行 ↔ corum-subagent（同名服务 `subagents`）：维持「禁官方行 + insert fork」红线纪律，disabled 行绝不删。
- 官方 spawn-in-process/fork-in-process provider ↔ corum `driver/`（共享 one-shot 驱动）：官方 provider 已按 `prepareContinuable` 重写，corum 的 driver/index.ts 共享壳判定退役，spawn/fork provider 直接用官方包 + corum isolated 叠加。
- `fork` 实例注册 `orchestrate` 的全局唯一工具名护栏（tool-subagent:1574-1576）与官方 tool-subagent：互斥，fork 继续禁官方 tool-subagent 行。

#### delivery / caller notice / job_output / job_kill / 旧 API

| 项 | 裁决 |
|---|---|
| **前台委派** | = delivery caller，等 activation 结果，**不发额外父级 settlement notice**（官方 caller 不发通知；corum 现行前台子 Agent 发 settlement notice 的行为改为跟官方——前台结果只在工具结果里） |
| **后台/continuable** | = delivery parent，完成通知由官方 manager 负责 |
| **模型工具参数** | 可做薄语法映射（`run_in_background` 参数收下、映射到 activation），但 **seam 无 start/startContinuable 兼容层** |
| **最终工具结果** | 遵循 activation 形态（`{ kind: 'activation', subagentId }`） |
| **job_output/job_kill** | `corumSchedulingDescription`（:1241-1251）one-shot 分支「collect with `job_output` and stop with `job_kill`」文案**删除**（官方指南明文「子 agent 不再通过 job_output 或 job_kill 收集」）；corum 的 jobs.start 后台路径（:2778-2800）判定退役，后台统一走 parent-delivery activation；`interrupt_agent`/`send_message` 语义照官方（仅本地子级可 send_message） |
| **旧 start/startContinuable 删除** | **硬迁，不留兼容 shim**。测试判据：① `grep -r "startContinuable" packages/` = 0；② 工具结果 schema 只含 `kind: 'activation'`；③ config zod 对 backgroundMode/persona/toolFilter 三键 throw；④ completion notice 只在 delivery='parent' 出现 |

#### run id 全局唯一

corum 所有外部/子进程 provider 的 `SubagentRun.id` 改 `randomUUID()`（brand 成 `SubagentRunId`），删父级计数器；`out-of-process.ts:223` 注释同步。加测试：两个 parent 各起一个外部 run，断言 id 互异且与本地 Session id 无碰撞空间。

#### working-directory 接线（台账 #4）

官方 `packages/session/working-directory/`（rc3 存在，`dsh-working-directory`）组合提供 cwd——**corum 不再复制 cwd 变量**（阶段 1 已删 `{{cwd}}`）。子 agent 使用官方 `ResolvedSubagentStartRequest.cwd`（启动前已解析为绝对路径，types.ts:167-169）。corum-subagent 自己的 `assertChildCwd`（continuation.ts:188 等）与官方原生 cwd 职责重叠——**rebase 时只保留隔离补充判定**（confine 路径），不把旧理由的代码当增量无脑贴回。

#### 沙箱钳制三接线 + 第四接线

**三接线**（fork-delta §10.3-5，rebase 后必须绿）：
- **接线 1（工具层）**：`captureDelegatedPolicyOverrides` 增 `confineToWorktree`——隔离期子会话沙箱钳到 `workspace-write`。
- **接线 2（isolated provider）**：`prepareIsolatedChild` 在 `cwd: child.path` 旁置 `confinedSandbox: true`。
- **接线 3（continuable + 冷恢复）**：三条路径同步 `confineToWorktree`/`confined`（策略捕获 / 新建 composition / coldResume 从 descriptor 重建）——漏任一条 = 默认后台委派或冷恢复丢隔离边界。

**第四接线**（三方评审发现）：`LocalSandboxProvider.confine` 对齐 rc3 `SandboxProvider` 新签名——官方 `confine` 从同步改 async：

```diff
-abstract confine(argv, policy): ConfinedArgv
+abstract confine(argv, policy, signal?): Promise<ConfinedArgv>
```

corum `corum-sandbox-local/src/index.ts:317` 仍是同步签名 → typecheck 必炸。以官方 0.2.1 index.ts（542 行）为底重贴 `tryFixWorkspaceAcl` 增量。**沙箱隔离除三接线外，加 provider 接口第四接线**，同样进 isolation 门禁。

#### jsonl 测试改 `apply` 形态

**5 个测试文件**（不是 3 个）改走 `apply(ctx, {root})`，**不是 namespace import**：

| 文件 | import 行 |
|---|---|
| `corum-subagent/tests/isolation-confinement.spec.ts` | `:32` default import |
| `continuation.spec.ts` | `:11` |
| `ownership.spec.ts` | `:45` |
| `list-children.spec.ts` | `:14`（旧说法漏列） |
| `continuation-inheritance.spec.ts` | `:21`（旧说法漏列——沙箱三接线回归门禁之一！） |

0.2.1 删除了 default export，类构造器加第三参 `tracker` 且类不再导出——`new JsonlSessionPersistence` 与 `ctx.plugin(JsonlSessionPersistence, …)` 两条路都断，**唯一活路是 `apply(ctx, { root })`**（官方测试同款用法：`agent-loop/config-session-id.spec.ts:16`）。namespace import 仍拿不到类。

#### 执行顺序

1. corum-subagent 先行（官方为底整包重合 + 增量贴回 + run id 修复）；
2. 同批 corum-tool-subagent（API 换 startActivation、schema 删三键、描述文案重写）；
3. corum-orchestration 消费面（settle 事件面核对）；
4. corum-goal-round-driver（`subagent/end` 事件面核对）。

#### 每步验证

- `pnpm --filter @corum/corum-subagent run build` 过
- `pnpm --filter @corum/corum-subagent run typecheck` 过
- `continuation-inheritance.spec.ts` + `isolation-confinement.spec.ts` 全绿（现 spec 建立在旧 continuation API 上，rebase 后它们自己要先搬家——与 jsonl import 修复同一批做）
- 沙箱钳制三接线 + 第四接线代码均保留（grep `confineToWorktree`/`confinedSandbox`/`confined` + `confine(argv, policy, signal?)` 确认存在）
- `grep -r "startContinuable" packages/` = 0

#### cold-resume 执行链 guard 验证（2026-10-28 修复）

`isolation-confinement.spec.ts` 最后一项此前被降为纯函数测试（`scopeOf + confinementGuard()`
只证 guard 函数判得对，不证真实 ToolRuntime 执行链拦截）。2026-10-28 恢复为真实执行链测试。

**探测根因**：旧版纯函数测试之所以「通过」是因为 cold-resume 场景下 `delivery: 'parent'`
在 child 第一轮 settle 时唤醒 parent 跑一轮——flat 脚本条目被 parent 消费 ⇒ tool-call 在
**parent scope**（无 guard）上执行，`writeExecute` 被调用，产生假阴性。guard 本身在 child
scope 上注册正确、`guardReason({agent: child})` 返回正确拒绝。

**修法**：用函数条目 `(opts) => opts.sessionId === childId ? toolCallResponse(...) : textResponse(...)`
按 sessionId 路由，确保 tool-call 只回到 child scope。**生产代码无需修改**——guard 在 resume
setup 里通过 `applyChildComposition` → `applyChildOverrides` → `childCtx.tools.guard()` 正确
注册到 child scope，`workingDirectory.get` 从持久化 `working-directory/change` 事件重建 projection
后返回正确 worktree cwd。

**恢复后的测试覆盖**：
- ⑥ cold resume 后第二轮 mock 返回越界 write ⇒ execute 仍不被调用（真实 ToolRuntime 执行链）
- ⑦ cold resume 后界内 write 仍放行（execute 被调用），证明 guard 非全拒

**inventory 状态**：E（activation 专项）测试补齐已完成（2026-10-28）——
14 个官方 spec 移植（12 adopted + 2 not-applicable），corum-subagent 测试 466→614 全绿，
生产修复 permissionPreset 捕获回归，guard16 0 红。**E rebase 本身仍进行中**
（官方 manager 结构重接线未补齐），但 E 完成判据中的「测试补齐」部分已全过。
- 工具结果 schema 只含 `kind: 'activation'`

### 4.5 preset 专项（批 P）

> **指挥者裁决**：preset 完整迁移——五份（standard/ptc/cordis/minimal/conductor）各有落点，conductor 是 insert、四官方是 override，**不做只迁 standard 的半成品**。

#### (a) 静态五份 preset 的落点

官方 rc3 下 desktop 闭包已自动获得 registry 行 + 四份官方声明（desktop 依赖 `dsh-web-app@^0.2.1-rc.3`，其 `dsh.bundle.patch` 含 cordis.patch.yml + presets/*.patch.yml；boot.ts:417 `bundlePatches = profile.layers.flatMap(layer => layer.patches)` 会整列进来）。因此：

- **不需要**自己 insert registry 行——官方 web-app bundle 已带（web-app/cordis.patch.yml:591-596，`config.default: standard`）。
- 新增 `packages/desktop/presets.patch.yml`（挂进 desktop 的 patch 栈），内含三行按官方 row id 覆盖 `config.plugins`（不加 name → 纯覆盖）：
  - `- id: preset-standard`（plugins 列表 = 现有 agent.cordis.yml 内容减去已退役行）
  - `- id: preset-ptc`
  - `- id: preset-cordis`
  - **corum minimal 无增量**：`preset-minimal` **不覆盖**——corum 从未 fork 过 minimal，官方 rc3 的 `minimal.patch.yml` insert 即迁移落点（保留官方 rc3 minimal 的 `tool-fs` read:false/readImage:true 行等）。注释在 `presets.patch.yml:348-355` 已注明。
- **conductor 是 corum 独有** → 用 `- insert: - id: preset-conductor, name: '@deepseek-ai/dsh-agent-preset', config: { id: conductor, plugins: [...] }`。
- 五份都迁（minimal 靠官方 insert 迁移，不丢数据），不做只 standard。

#### (b) desktop-host/desktop 增加 `@deepseek-ai/dsh-agent-preset` 声明包依赖

- `desktop-host/package.json` 增 `@deepseek-ai/dsh-agent-preset` = 0.2.1-rc.3；
- `desktop/package.json` 增 `@deepseek-ai/dsh-agent-preset` ^0.2.1-rc.3（desktop 可 `^` 由 override 收敛）；
- **不加则所有声明行挂载即报 unknown plugin，boot 直接死**——这正是台账 #5「bind 失败」的机制；
- lock 单独解锁更新 commit（preset 新增 dep 是阶段 3 唯一允许解锁 lock 的场景）。

#### (c) 动态 `~/.agent-presets` 走官方 `register()` API

保留 `profile-store.ts`/`profile-compiler.ts` 生产链（`profile-store.ts` 扫描 `<home>/.agent-presets/<id>/agent.json`、`profile-compiler.ts:47` 写 agent.cordis.yml）。改的是消费端：boot 时（corum-agent 的 service init 或独立小插件）读出每份已编译的 agent.cordis.yml，解析为 entry list，**前置 `entryListProblem` 校验**（definition.ts:20），调 `ctx.agentPresets.register({ id, plugins })`。保留名称/描述/order 等元数据注册所需字段，按官方 `PresetDefinition` 实际类型。

**严禁**再给 registry config 塞 `roots`——rc3 的 zod `{default, selectedDefault}` 之外的字段属于未声明配置。**不恢复 registry 目录扫描**。

#### (d) boot.ts 旧 roots/includeShippedRoot 注入退役

`packages/desktop/src/host/boot.ts:493-506`（`rows.has('agent-presets')` → 注入 `roots` + `includeShippedRoot: false`）操作的配置键在 rc3 registry 上**不存在**，整段删；`resolveAgentPresetRoots`（:178-191）与四个路径常量（:148-151）一并退役。shipped preset 物化链按新消费方式调整——`agent.cordis.yml` 不再被运行时读取（内容已转覆盖行），`preset.yml` 元数据改由 register 调用携带 name/description/order。**不留下双来源**。

#### (e) settings `agent-preset-registry` 默认值（台账 #2）

> **M2 纠偏（2026-10-28，已修正）**：原 05 方案假设 settings ns `agent-presets` 可通过 settings mutate 写 `default` 字段。
> 研究证实：官方 `SettingsForms.write()` 会把 volatile 字段值**持久化进 profile patch**（`mergeLayers(strip(raw, form), next)`，
> settings/src/index.ts:414-416），且 `configEditor.edit` 触发 loader `_commitVolatile` + `loader/volatile-update` 事件——
> 实现**运行期即时生效 + 重启后恢复**。官方测试 `configuration.spec.ts:65-79` 证明 volatile 值穿越 `fiber.dispose()` 重启存活。
>
> 故「settings ns 作为单一持久层在 rc3 完全可行」，且官方 UI（`ui-agent-preset`）正是这么做的。
> `.default-preset` 文件 + `Symbol.for("cosmokit.volatile.write")` 直写方案**已撤回**——它建立在与官方代码相反的事实判断上
> （误判 selectedDefault 不持久化），属于内部协议滥用（绕过 schemastery 校验、绕过 `write()` 落盘、绕过 loader 事件）。
>
> **实际持久化机制**（P 专项 + M2 纠偏修正）：
> 1. **持久化 + 热生效**：`setDefaultPresetRemote` RPC 调 `ctx.settings.update('agent-preset-registry', { selectedDefault: effectiveId })`，
>    volatile 值持久化进 profile patch 且热生效（`write()` → `mergeLayers` → loader `_commitVolatile` + `loader/volatile-update`）。
> 2. **重启持久**：schemastery 从 patch raw 解析 volatile `selectedDefault`，`defaultId` getter
>    （`selectedDefault.get() ?? config.default`）直接返回持久值，无需 boot 读文件或注入 overlay。
> 3. **undefined 清除**：`effectiveId === undefined` 时 `settings.update({ selectedDefault: undefined })` 清除，
>    `defaultId` 回落 `config.default`（registry 自带 `default: standard`）。
> 4. **无效 preset id 回退 `standard` + warn**：`setDefaultPresetRemote` 校验 presetId 在 registry list 中且未 broken。
> 5. **写失败必须抛错**：不 catch 后伪 `{ ok: true }`（settings.update 失败直接 reject）。
> 6. **boot 无需读文件**：删除 `resolvePersistedDefaultPreset()` 与 `.default-preset` overlay 注入。
>    官方 profile patch 启动即恢复 volatile 值。
> 7. **不迁移/删除用户 `.default-preset` 文件**：该实验方案未发布，普通用户无此文件（两台 home 实测均无）。
>
> 旧 ns 的持久意图由官方 registry 行 `selectedDefault` volatile + `SettingsForms.write()` 承接，
> 单一 settings/profile patch 持久层（不再有 `.default-preset` 文件第二持久层）。
>
> 三处同步改：
> 1. `corum-agent/src/agent-service.ts` 的 `resolveDefaultTaskProfileId` / `readConfiguredDefaultPreset` → 读 `ctx.agentPresets.defaultId`（registry 公开 getter，`selectedDefault ?? default`）。
> 2. 用户默认值的持久化通道：官方 `ctx.settings.update('agent-preset-registry', { selectedDefault })`（volatile 持久化 + 热生效 + 重启恢复）。
> 3. settings UI 的 `SettingsAgentSettingsSection.tsx` RPC 调用 `setDefaultPreset` → `ctx.settings.update`。`PRESETS_NS='agent-presets'` 死代码已删除（rc3 无此命名空间，UI 不再读 settings mutate）。

#### (f) compile.ts 对账源注释更新

`compile.ts:75` 注释「来源：`@deepseek-ai/dsh-agent-preset-registry/presets/standard/agent.cordis.yml`」——该路径 rc3 不存在（官方 preset 源已迁 `packages/bundle/web-app/presets/standard.patch.yml`），对账源注释改指新路径。

#### 每步验证

- `grep -rn "includeShippedRoot\|roots:" packages/desktop/src/host/boot.ts` = 0
- 冷启动探针 `ctx.agentPresets.list()` 含 5 个 id（standard/ptc/cordis/minimal/conductor）
- `grep -n "get('agent-presets')" packages/plugins/agent/corum-agent/src/agent-service.ts` = 0
- desktop-host dep 含 `dsh-agent-preset`；boot 后 `registry.list()` 五 id 且 default bind 不抛

### 4.6 高危 API 具体清单

> **以下全部已核实到行**（三方评审 68549f64 + 1aa8ef95 + ba0eba5b）。按「官方为底 + 贴回 corum 增量」处置。

| 批 | 包 | 最危险变化 | 官方证据 | fork 断点 / 处置 |
|---|---|---|---|---|
| A | **corum-api-remotes** | `SessionJob` 删除（迁入新包 `packages/api/job-controller/src/types.ts:9-12` 改名 `JobView`，来自 `dsh-jobs/view`）；client 挂载面 16→24 个 remote | `git diff` 两 tag 的 `packages/api/remotes/src/client/index.ts` | 本仓 `src/client/index.ts:41` `export type { SessionJob as JobView }`（TS2305）+ `src/index.ts`；按官方为底贴 corum 增量 |
| A/B | **corum-ide-ui** | `ISessions` 契约重写：rc3 `sessions.ts:49` 起换成 retain/using/retainInfo 引用生命周期；`open/refreshSubagents/setSubagentCatalogOpen` 不存在 | rc3 `:49-115` | 本仓 `src/client/index.tsx:625,646,648`（openSession 子代理面板三条 RPC 回调——**corum 增量，rebase 时必须按新契约重写而不是删**）；`:272` `SessionListState.current`；`settingsScope`/`settings.onboarding` TS2717 需先判断是官方 slot 搬家还是 fork 双重声明，rebase 时以官方契约为准重贴 |
| C | **corum-tools** | `code-runtime`→`ptc-runtime` 整体更名（服务名 `codeRuntime`→`ptcRuntime`）；`MessageSourceMap` 内建 `plugin` kind 删除；`'both'` 删 | 官方 `packages/core/tools/src/index.ts` :644→:672 | `src/index.ts:17`（TS2614）、`src/ptc.ts:12,564`（5 个 tsc 错）；测试 `tests/ptc.spec.ts:160-326` 11 处 'both'；按官方为底贴 errorMessage 等增量；跟随官方删 'both' |
| C | **corum-sandbox-local** | `confine` 同步→async：`confine(argv, policy, signal?): Promise<ConfinedArgv>` | `packages/sandbox/sandbox/src/index.ts` 两 tag diff | `src/index.ts:317` 仍是同步签名，typecheck 必炸；以官方 0.2.1 index.ts（542 行）为底重贴 `tryFixWorkspaceAcl` 增量；**第四接线** |
| C | **corum-credentials-local** | precedence 反转（stored 优先于 env）+ `describe()` 一律 `writable: true` + 删 `assertUnshadowed` + seam 删 INVARIANT 重抛 | `packages/credentials/credentials-local/src/index.ts` resolve() diff | fork `:648-655,:663,:789/795/825,:924` 全部还是旧语义；**不破编译但静默语义落后**；移植须同摘 fork `:924` INVARIANT catch 并重核 `queueRefresh` 抛错传播 |
| C | corum-fs-local | 官方增量：`dsh-fs` 基类加 `watch()`、fs-local 加 chokidar override + `localDisplayPath()` | `packages/fs/fs-local/` diff | 不破；fork 不支持 `fs.watch()`（推断无 0.2.1 消费方，未穷尽验证）；`watch`/`localDisplayPath` 评估，未引入项记录理由 |
| C | **corum-tool-subagent** | `settleRun` 从官方 `dsh-subagent` 导出中删除；backgroundMode/persona/toolFilter 整个消失 | rc3 `packages/subagent/subagent/src/index.ts` diff | `src/index.ts:33-38,291`；改 import 来源为 fork 自己的 `corum-subagent/src/run-settlement.ts:61` 副本——但该文件在批 E 会被三方合并重写，**E 先做该文件** |
| E | **corum-subagent** | activation 两笔合并（+3268/-3805、删 activation-driver.ts/continuation.ts、continuation-activation→manager.ts 1076 行重写）；jsonl persistence 删 default export；V4：`SESSION_FORMAT_VERSION` 3→4 | rc3 `packages/session/session-format-v3-to-v4/`（新目录）、`packages/core/session/src/types.ts:88-90` | 见 §4.4 全文；5+2 个测试文件改 `apply` |
| B | 12 session 包 | `azure-openai-responses`→`azure`（`ConfigureWizard.tsx:467`，session 组）；`transcript-view` legacy 'normal'；`uiWorkspace.startSession` blank-reuse 语义 | 01 映射表已列 | corum 走自有 RPC，影响面小 |
| B | corum-ide-ui | `ISessions` 新契约、`settingsScope`/`settings.onboarding`/queue/icon 等 | — | **AgentPreset.trust 真实存在消费**：`corum-agent/src/agent-service.ts:1207` 读 `.trust`（TS2339 实错），rc3 的 `AgentPreset` 无此字段——迁移到 corum 自有 profile trust 或明确删除官方 row 依赖 |
| — | azure id | `azure-openai-responses`→`azure` | — | `packages/plugins/session/corum-ui-settings-models/src/client/ConfigureWizard.tsx:467`，label 改「Azure」；全仓仅此一处 |
| — | transcript-view | legacy 'normal'→'detailed' | — | corum 默认 'compact' 不受影响；corum-ui-chat fork rebase |
| — | plugin composition | disabled+insert 四组重验 | — | 关联红线 5：不得 filter disabled 行 |
| — | plugin-install-over-installed | installBundle 报 already-installed | — | corum extension-pack/install-local 需核实是否走 installBundle RPC |
| — | native-subagent-bundle-tools | BundleInfo.official/availability 新字段 | — | 核实 corum-ide-plugin-manager-ui 是否读取 |
| — | python-ptc-sandbox | Python PTC 需 sandbox | — | corum 走 Node runtime 不受直接影响 |
| — | stored-credentials-precedence | 见 corum-credentials-local 行 | — | 见上 |
| — | web-listener-trust-config | webRuntime→webStartup | — | 阶段 1 已处理；corum 零消费，记无动作 |
| — | plugin-engines-dsh | engines.dsh/peers→requirements | — | 01 判不受影响，随批确认 |
| — | CLIENT_EXTERNALS_BASE | zod/react-virtual 是否进 external | 04 §S2.3 | 按 04 决定**保持内联**，除非新证据专项评审 |

### 4.7 6026 commit 跨度的破坏性 API 变更发现与记录

**背景**：0.1.5-rc.3 → 0.2.1-rc.3 共 6026 commit / 12855 文件 / 161 万新增行。

**处置**：破坏性 API 变更**在逐包 rebase 中发现并记录**，但**步骤 0d 的 inventory 生成器已机器定位三处硬破 + JobView + ISessions**（见 §4.6），不靠「逐包中发现」。每发现一处新破坏性 API 变更，在 `docs/fork-delta.md` 对应 §N 节追加「破坏性 API 变更」条目：变更描述 / 影响的 fork 包+文件+行号 / corum 侧修法 / 官方 commit/PR/指南引用。

---

## 5. 验收标准

> **fork-drift 判据**：**不以 exit 0 为门禁**。rc3 基线下 `[16b]`/`[16]` 大面积红是预期（官方 0.2.1 对 corum-tools/corum-subagent 做了实质重写，fork 与 rc.3 逐文件全 DIFF）。判据 = **逐项身份清单对照**，未解释项 = 0。

| # | 验收项 | 判据 | 验证方式 |
|---|---|---|---|
| 1 | 50 包全部通过 typecheck | 全仓 `pnpm -r --no-bail run typecheck` + 每包 `tsc -b --force`（有 spec 再 `--force --noEmit`）0 错 | 见 §4.3 命令 |
| 2 | 50 包全部通过测试 | 全仓 `pnpm -r --no-bail run test` 全绿，测试数增减归因 | `pnpm -r --no-bail run test` |
| 3 | fork-drift 守卫 | **逐项身份清单对照**（不以 N/exit 0 判）；rc3 基线失败项 = 阶段 3 收口实录记录的清单；未解释项 = 0 | `DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.2.1-rc.3 ./scripts/verify-fork-drift.sh` |
| 4 | fork 台账补齐到 50 | `docs/fork-delta.md` §N 节数 = 50，文首数字 = 50 | grep 计数 |
| 5 | corum-subagent 沙箱钳制门禁全绿 | `continuation-inheritance.spec.ts` + `isolation-confinement.spec.ts` 全过（新 manager 结构上） | `pnpm --filter @corum/corum-subagent test` |
| 6 | 50 包 build 全过 | UI 包三步全过 | `pnpm -r run build`（UI inline-css） |
| 7 | 每包有「漂移/增量/冲突」三栏 + 三平台差异检查 | fork-delta.md 每个 §N 节含四栏 + 「本包 rebase 判定」 | 人工检查 + inventory JSON 覆盖 50/50 |
| 8 | 破坏性 API 变更已记录 | 逐包 rebase 中发现的全登记 | 实录检查 |
| 9 | **三处硬破 + JobView + ISessions 清零**（DoR） | corum-tools 5 错 / corum-sandbox-local confine 签名 / corum-tool-subagent settleRun / api-remotes JobView / ide-ui ISessions 全部清零 | typecheck |
| 10 | **50 包 inventory 覆盖** | `docs/fork-delta/inventory/<pkg>.json` 50/50；每包要么有阶段 3 commit，要么 inventory 写「官方无变化/corum-only/无需改动」及证据 | inventory JSON + git log |
| 11 | 全仓 build 成功 | UI inline-css | `pnpm -r run build` |
| 12 | 允许 `--skip-app` 刷新闭包 + A 断言/解析探针 | 重跑 `--skip-app` 刷新闭包+A 断言/解析探针全过；完整 pack/smokeBridge/assert-packaged-boot/CDP 仍阶段 4 | `pnpm --filter corum-desktop run pack:host:mac -- --skip-app` |

### 5.1 不可 boot 台账逐项销账表（03 §3.6 六项）

> **阶段 3 结束时必须逐项销账**，缺任何一行不许宣布完成。

| 台账 # | 不可 boot 项 | 销账方式 | 门禁 |
|---|---|---|---|
| #1 | preset 目录扫描 | boot.ts roots 注入退役；动态走 `agentPresets.register()` | `grep -rn "includeShippedRoot\|roots:" packages/desktop/src/host/boot.ts` = 0；冷启动 `ctx.agentPresets.list()` 含 5 id |
| #2 | settings `agent-preset-registry` 默认 preset | 改读 `ctx.agentPresets.defaultId`；`ctx.settings.update('agent-preset-registry', { selectedDefault })` 持久化+热生效 | `grep -n "get('agent-presets')" packages/plugins/agent/corum-agent/src/agent-service.ts` = 0；`grep -n "settings.update.*agent-preset-registry" packages/plugins/agent/corum-agent/src/agent-service.ts` ≥ 1；任务泳道默认 profile 解析成功；持久化穿越测试（dispose→重建→defaultId 保留）通过 |
| #3 | corum 自有 activation/backgroundMode/persona/toolFilter | activation 专项（§4.4）：tool-subagent config zod 对三键 throw；`grep -r "startContinuable" packages/` = 0；工具结果 kind 断言 | tool-subagent-activation.spec.ts |
| #4 | `{{cwd}}` 清除后新 user context | 官方 `dsh-working-directory` 行在组合中（grep patch）；`cwd.spec.ts` 绿；子会话继承父 cwd 单测 | working-directory 组合验证 |
| #5 | corum 完整 preset YAML 声明 | desktop-host dep 含 `dsh-agent-preset`；boot 后 `registry.list()` 五 id 且 default bind 不抛 | preset-registration.spec.ts |
| #6 | dsh-agent-preset 声明包 | 同 #5 dep grep | 同 #5 |

### 5.2 新测试（至少）

| 测试 | 验证 |
|---|---|
| `preset-registration.spec.ts` | 从临时目录读 agent.cordis.yml → entryListProblem → register → list/mount 全链 |
| `tool-subagent-activation.spec.ts` | activation 结果变体 + parent-delivery 通知到达 + caller-delivery 无通知 |
| `run-id-uniqueness.spec.ts` | 跨 parent/跨 provider id 唯一 |
| 新 manager 沙箱隔离 spec | 沙箱三接线 + 第四接线两 spec 在**新 manager 结构**上全绿 |

> 实际文件名执行时定。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| corum-subagent + corum-tool-subagent 强耦合，分批必炸 | **高** | 批 E 同一执行者串行（§4.4） |
| activation 增量贴回点全变（旧 continuation.ts → 新 manager.ts） | **高** | 按新 manager 结构重接线，不是「最后处理 continuation/child-agent 三方合并」 |
| 沙箱钳制三接线 + 第四接线被官方改动或合并丢失导致隔离静默退化 | **高** | `continuation-inheritance.spec.ts` + `isolation-confinement.spec.ts` 在新 manager 结构上全绿；grep 确认 |
| preset 声明包不加导致 boot 直接死 | **高** | desktop-host/desktop 增 `dsh-agent-preset` dep（§4.5b） |
| 6026 commit 跨度的破坏性 API 变更 | 中 | 步骤 0d inventory 机器定位 + 逐包发现记录 |
| fork 台账落后 33 个包 | **高** | 步骤 0e 先补台账到 50 + inventory 50/50 覆盖门禁 |
| 整文件覆盖禁令被违反 | 中 | 实质修改文件禁止整文件拷贝；合并后逐文件 diff 逐 hunk 对台账 |
| `tsc -b` 增量编译藏住破坏点 | 中 | 必须 `--force` + `--no-bail` |
| 守卫 §17 preset 路径 rc3 已消失 | 中 | 步骤 0c 改 `packages/bundle/web-app/presets/` |
| AgentPreset.trust 真实消费未迁移 | **高** | agent-service.ts:1207 迁移到 corum 自有 profile trust 或明确删除官方 row 依赖 |
| credentials precedence 语义落后 | 中 | 移植 precedence 反转（须同摘 INVARIANT catch） |
| 批次间类型/契约不稳定导致返工 | 中 | A→C→E→P→D→B 串行链 |
| vitest 在受限沙箱下 EPERM | 中 | 门禁在无沙箱限制的终端跑 |

---

## 7. 回滚方案

1. **分批 commit 可整批 revert**：每批独立 commit，`git revert <batch-commit>` 即可回滚该批。
2. **单包回滚**：`git checkout <pre-rebase-commit> -- packages/plugins/<group>/<pkg>/`。
3. **corum-subagent 回滚**：独立 commit，`git revert` 回滚整个 rebase（但阶段 1 的 invariant 删除 + in-process-driver 改名不回滚，除非同时 revert 阶段 1）。
4. **fork-drift 守卫回滚**：`git checkout HEAD~1 -- scripts/verify-fork-drift.sh`。
5. **全量回滚**：revert 阶段 3 所有 commit，恢复到阶段 2 完成状态。revert 后须 `pnpm install --frozen-lockfile` 复位物化。
6. **lock 回滚**：preset 专项的 lock 解锁 commit 独立，可单独 revert。

---

## 8. 产出物与下游接口

| 产出物 | 消费者 | 接口 |
|---|---|---|
| 50 个 fork 包源码（与官方 0.2.1-rc.3 对齐 + corum 增量保留） | 阶段 4 验证 / 日常 build | `pnpm -r run build` / `pnpm -r run typecheck` |
| 更新后的 `docs/fork-delta.md`（50 个 §N 节 + 每包四栏 + 破坏性 API 变更登记） | 后续 0.2.x→0.3.x 升级 | fork-delta §5 runbook |
| `docs/fork-delta/inventory/`（50 包 JSON 清单） | 验收 / 后续升级 | inventory 50/50 覆盖 |
| `scripts/fork-rebase-inventory.mjs` | 后续升级 | 机器生成器 |
| fork-drift 守卫逐项身份通过证据 | 阶段 4 验收 | 逐项身份清单 |
| corum-subagent 沙箱钳制门禁通过证据 | 阶段 4 验收 | spec 全绿 |
| 不可 boot 台账 6 项销账表 | 阶段 4 验收 | §5.1 |
| 破坏性 API 变更清单 | 阶段 4 实机验证 / 后续维护 | 本文件 §9 实录 |

---

## 9. 实录要求

1. **步骤 0 基线与 inventory 记录**：start hash、`.corum-tmp/stage3-expected-red.log`、包/错误身份清单、50 包 inventory JSON。
2. **逐包 rebase 记录**：每包的「漂移 / 增量 / 冲突」三栏 + 第四栏「三平台差异检查」+「本包 rebase 判定」。
3. **批次记录**：每批的 start hash、commit hash、diff 范围、包含的包、门禁结果、测试数、drift 身份、三平台差异检查。
4. **activation 专项独立记录**：按新 manager 结构重接线的逐处记录；沙箱钳制三接线 + 第四接线保留确认（grep 证据 + spec 结果）；run id 修复；jsonl 5 文件改 `apply`；delivery caller/parent 通知行为变化。
5. **preset 专项独立记录**：五份 preset 落点；`dsh-agent-preset` dep 新增 + lock 解锁 commit；boot.ts roots 退役；settings defaultId 三处改法；动态 register。
6. **破坏性 API 变更清单**：逐包发现的全登记，每条含变更描述 / 影响的包+文件+行号 / corum 修法 / 官方 commit 或指南引用。
7. **门禁结果**：`pnpm -r --no-bail run typecheck` + 每包 `tsc -b --force` / `pnpm -r --no-bail run test` / `verify-fork-drift.sh` 逐项身份的完整输出或摘要。
8. **异常记录**：任何 typecheck 报错、测试失败、守卫误报均逐条记录根因与修法。
9. **与可行性文档的偏差记录**：实际工程量 vs 预估的偏差及原因。
10. **不可 boot 台账 6 项销账表**：每项处置方式 + 证据（grep/测试/配置）+ 销账人。
