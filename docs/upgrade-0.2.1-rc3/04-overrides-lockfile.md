# 阶段 2：override 重算与 lock 重生成

> 状态：待执行 | 前置：阶段 1（被删/更名包 + session-title API 迁移）已完成 | 工程量：中高（217 条逐条重算 + 433 条清理 + lock 重生成 + 闭包审计）
>
> 单一事实源：`docs/UPGRADE-0.2.1-rc3-feasibility.md`（含评审修订 §六 阶段 2）。
> 评审证据：`~/.corum/research-reports/06867ebb-…md` E 节（override/lockfile/平台词表/指南清单详证）。
> 方法论参照：上次升级 0.1.3→0.1.5 的逐包循环纪律（交接文档 `HANDOFF-2026-09-29-official-0.1.5-upgrade.md` §2 三条方法论：包声明与根 override 必须同时改 / 直接验证可解析性不信扫描脚本 / 官方有系统性打包缺陷——运行时依赖被放进 devDependencies）。

---

## 1. 目标与范围

将 `pnpm-workspace.yaml` 的 `overrides` 段从 0.1.5-rc.3 基线（217 条 = 216 个 `@deepseek-ai/*` + 1 个 `electron`）全量重算至 0.2.1-rc.3 目标版本，同步清理陈旧的 `minimumReleaseAgeExclude` 段（433 条 = 249 条 `0.1.3-alpha.1` + 184 条 `0.1.1-rc.2`），重算 vendor 连带钉版，重生成 lockfile，并完成打包闭包审计。

**本阶段产出**：一份可解析、零冲突、lockfile 闭包审计全绿的 override 表。

**不在本阶段范围**：
- fork 包源码 rebase（阶段 3）
- 被删/更名包的 import 改写（阶段 1，已完成）
- 实机 CDP 冲烟（阶段 4）

---

## 2. 前置条件

1. **阶段 1 已完成**：4 个被删/更名包（`dsh-code-runtime` → `dsh-ptc-runtime`、`dsh-agent-presets` → profile YAML、`dsh-invariants` 跟随删除、`dsh-subagent-in-process-driver` 并入 `dsh-subagent` activation）+ `dsh-session-title-llm` provider API 迁移 + HMR 形态经阶段 -1 裁决后处置均已落地。
2. **阶段 1 的 desktop-host 依赖清单已清理**：`desktop-host/package.json` 的 4 处被删包 dep（`:60` dsh-agent-presets、`:75` dsh-code-runtime、`:86` dsh-invariants、`:114` dsh-subagent-in-process-driver）与 `build/host/package.json` 对应行已同步摘除或改名。
3. **官方 dsh 检出已更新至 `dsh-v0.2.1-rc.3`**：`/Users/kukucai/dsh` checkout 指向该 tag。
4. **阶段 -1（官方升级指南映射表）已完成**：7 个版本目录共 43 篇指南已产出「指南 → corum 影响映射表」。
5. **备份就绪**：`~/.corum` 已备份（阶段 0）。

---

## 3. 输入与依赖

| 输入 | 来源 | 用途 |
|---|---|---|
| `pnpm-workspace.yaml`（当前 HEAD） | 本仓 | override 基线 217 条 + minimumReleaseAgeExclude 433 条 |
| `dsh-v0.2.1-rc.3` tag | `/Users/kukucai/dsh` | 官方目标版本号全集 |
| 官方 `packages/**` 目录树 | `git -C /Users/kukucai/dsh ls-tree -r dsh-v0.2.1-rc.3` | 278→362 包全集（+84） |
| `vendor/` 目录 | dsh 仓 `vendor/` | cordis/loader/hmr/include/timer/schemastery/cosmokit 目标版本 |
| `packages/client/web/src/seed.ts` | dsh 仓 | 平台词表 9→11 对账 |
| `packages/tooling/corum-plugin-build/src/index.ts:37` | 本仓 | `CLIENT_EXTERNALS_BASE`（6 词）决策点 |
| `scripts/assert-packaged-boot.mjs` | 本仓 | 打包闭包审计脚本 |
| 评审报告 E1/E2 节 | `06867ebb-…md` | override 数量修正、lockfile 风险、平台词表详证 |

---

## 4. 执行步骤

### 4.1 基线确认与注释口径修正

**基线核实值**（已验证）：

| 项 | 核实值 | 来源 |
|---|---|---|
| overrides 段行范围 | `pnpm-workspace.yaml:43-306` | `sed -n` 实测 |
| overrides 总条目 | **217 条**（216 个 `@deepseek-ai/*` + 1 个 `electron`） | `awk '/^overrides:/{f=1;next}/^[a-zA-Z]/{f=0}f&&/^  [^ #]/{c++}END{print c+0}'` 实测 |
| 注释自称 | 「列表 = 工作区实际安装的 206 个 dsh 包」 | `pnpm-workspace.yaml:47` |
| 漂移 | 注释「206」与实际 216 条 `@deepseek-ai/*` override 已漂移 **10 条** | 评审 E1 节指出 |
| minimumReleaseAgeExclude 段 | 从 `:307` 起，共 **433 条**（249 条 `0.1.3-alpha.1` + 184 条 `0.1.1-rc.2`） | `sed -n '308,$p' \| grep -cE "^\s+'@"` 实测 |

**步骤 1**：修正注释口径。将 `pnpm-workspace.yaml:47` 注释中的「206 个 dsh 包」改为重算后的实际条目数，消除漂移。

**每步验证**：注释数字与 override 实际条目数一致（`grep -c` 对比）。

### 4.2 override 全量重算（逐包循环）

**目标**：官方包 278→362（+84），预计 override 落点 **250-300 条**（非 800+，评审 E1 节已修正）。

**逐包循环纪律**（0.1.5 方法论，交接文档 `HANDOFF-2026-09-29` §2）：

1. **包声明与根 override 必须同时改**：每改一条 fork 包的 `package.json` deps 版本号，必须同步改 `pnpm-workspace.yaml` 对应 override 行。两者分两步改 = 中间态 install 会断链。
2. **每个官方包直接验证 npm 可解析**：`pnpm view <pkg>@<ver>` 确认该版本在 registry 存在；或 `pnpm install` 后 `ls node_modules/@deepseek-ai/<pkg>/package.json` 确认物化成功。**不信扫描脚本**——上次官方有系统性打包缺陷：运行时依赖被放进 `devDependencies`（0.1.5 升级遇 2 处），扫描脚本按 `dependencies` 找包会漏报。
3. **逐包 commit**：每批改完立即 `git commit`，不积攒。

**步骤 2a**：生成官方 0.2.1-rc.3 全量包版本清单。

```bash
# 官方 0.2.1-rc.3 全量 package.json 的 name+version
git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 \
  | grep 'package.json$' \
  | while read f; do
      git -C /Users/kukucai/dsh show "dsh-v0.2.1-rc.3:$f" 2>/dev/null \
        | grep '"name"\|"version"' | head -2
    done > /tmp/dsh-021-rc3-pkgs.txt
```

**步骤 2b**：逐包对照，生成新 override 表草案。对当前 217 条每一条：
- 包在 0.2.1 仍存在 → 版本号改为 0.2.1-rc.3
- 包在 0.2.1 被删/更名 → 删除该 override 行（阶段 1 已处理源码侧）
- 0.2.1 新增包且 corum 需要装配 → 新增 override 行

**步骤 2c**：将草案写入 `pnpm-workspace.yaml` `overrides:` 段，替换 43-306 行。

**每步验证**：
- `pnpm install` 零报错（override 不可解析会直接报 `ERR_PNPM_NO_MATCHING_VERSION`）
- 逐条 `pnpm view <pkg>@0.2.1-rc.3` 确认 registry 存在（至少对新增/改名/版本跳跃的包）

### 4.3 第三张表清理（minimumReleaseAgeExclude）

**基线**：`pnpm-workspace.yaml:307` 起，共 **433 条**（249 条钉 `@0.1.3-alpha.1` + 184 条钉 `@0.1.1-rc.2`）——这是历史遗留的陈旧发布年龄豁免尾。

**清理策略**（评审 E1 节）：
- **随新版重钉**：corum 仍需要的包，豁免版本从 `0.1.3-alpha.1` 更新为 `0.2.1-rc.3`
- **删除**：corum 不再装配的包（阶段 1 被删包对应的豁免行直接删）
- **整段评估**：433 条中 249 条钉 `0.1.3-alpha.1` + 184 条钉 `0.1.1-rc.2`；0.2.1-rc.3 是新发布，`minimumReleaseAge` 机制对新包天然不触发，多数行可删

**步骤 3**：逐条审查 433 条，按上述策略分类处理，产出新的 `minimumReleaseAgeExclude` 段。

**每步验证**：`pnpm install` 不报 `minimumReleaseAge` 相关警告。

### 4.4 vendor 连带钉版重算

**核实值**（dsh 仓 `vendor/` 目录 `git show` 实测）：

| vendor 包 | 0.1.5-rc.3 版本 | 0.2.1-rc.3 版本 | corum 当前 override | 处置 |
|---|---|---|---|---|
| `@deepseek-ai/cordis` | 4.0.2 | **4.0.5** | `:288` 钉 4.0.2 | 改为 4.0.5 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.3 | **1.0.6** | `:290` 钉 1.0.3 | 改为 1.0.6 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.17 | **1.0.20** | `:292` 钉 1.0.17 | ⚠️ HMR 形态待阶段 -1 裁决（dsh-hmr 在官方 apps/cli README 是 profile-manifest/patch watcher；corum 实际引用 = desktop-host dep + override + UI meta）。此处 override 版本钉待裁决后处置 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.7 | **1.0.10** | `:289` 钉 1.0.7 | 改为 1.0.10 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.4 | **1.1.7** | `:294` 钉 1.1.4 | 改为 1.1.7 |
| `@deepseek-ai/schemastery` | 3.18.2 | **3.18.5** | `:293` 钉 3.18.2 | 改为 3.18.5 |
| `@deepseek-ai/cosmokit` | 1.8.3 | **1.8.6** | （未在 override 中单独钉，跟随 vendor） | 确认是否需补 override |
| `@deepseek-ai/cordis-plugin-group` | — | — | `:291` 钉 1.0.2 | 确认 0.2.1 是否升版 |

**步骤 4**：将上述版本号写入 override 表对应行。

**每步验证**：`pnpm install` 后 `ls node_modules/@deepseek-ai/cordis/package.json | grep version` 确认物化版本与 override 一致。

### 4.5 平台词表 9→11 对账

**核实值**（dsh 仓 `git show <tag>:packages/client/web/src/seed.ts` 实测）：

| 版本 | seed.ts 模块数 | 列表 |
|---|---|---|
| 0.1.5-rc.3 | **9** | react、react/jsx-runtime、react-dom、react-dom/client、`@deepseek-ai/cordis`、dsh-client-store、ui-slots、ui-primitives、ui-dockkit |
| 0.2.1-rc.3 | **11** | 上述 9 个 + **`zod`** + **`@tanstack/react-virtual`** |

**决策点**：`packages/tooling/corum-plugin-build/src/index.ts:37` 的 `CLIENT_EXTERNALS_BASE`（当前 6 词：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`）是否跟进补 `zod` / `@tanstack/react-virtual`。

**决策依据**：
- 若 corum fork UI 包开始 import `zod` / `react-virtual`（官方 UI 包 0.2.1 已大量使用），要么进 `CLIENT_EXTERNALS_BASE`（external），要么内联进 bundle。
- 进 external 的风险：经 `dsh.client` 塞自定义共享模块 → 白屏（AGENTS 红线 2 + `.dbg/b1-boot-graph-findings.md` 证据）。
- **红线复述**：`dsh.client` 的 module table 是硬编码种子（0.1.5 时 9 个，0.2.1 增至 11 个）；自定义共享模块经此路径白屏——**不许松绑**。corum 若需共享状态走 cordis 服务（AGENTS 红线 1），不塞 module table。

**步骤 5**：拍板 `CLIENT_EXTERNALS_BASE` 口径。若 corum fork UI 包确实需要 `zod`/`react-virtual`，在 `CLIENT_EXTERNALS_BASE` 数组补对应词条；否则不动。

**每步验证**：
- `CLIENT_EXTERNALS_BASE` 与 `seed.ts` 的 `PLATFORM_MODULES` 同步性检查
- fork UI 包 build 后无 `Module not found` 报错
- 实机渲染无白屏

### 4.6 lock 重生成

**雷区清单**（评审 E2.a 节）：

1. **`pnpm deploy --legacy` 忽略 lockfile 重新解析** → 闭包版本漂移。历史事故（`pnpm-workspace.yaml:44-47` 注释）：2026-09-09 实测正式包闭包里 131 个 dsh 包是 alpha.2、而 session 核心是 alpha.1 → 冷读历史日志报「failed to observe session ... events is not iterable」。override 钉版是唯一防线。
2. **`patchedDependencies` re-apply 验证**：`node-pty@1.2.0-beta.15`（`packages/desktop/package.json:280`）与 `@yao-pkg/pkg` 的 patch 在 lock 重生成后需确认仍生效。lockfile v9 重生成后检查 `pnpm-lock.yaml` 内 patchedDependencies 段是否保留。
3. **`scripts/assert-packaged-boot.mjs` 闭包审计重跑**：新闭包补齐/去重断言。

**步骤 6a**：删除现有 `pnpm-lock.yaml`，执行 `pnpm install` 重生成 lock。

```bash
rm pnpm-lock.yaml
pnpm install
```

**步骤 6b**：确认 `pnpm install` 零报错。

**步骤 6c**：验证 patchedDependencies 仍生效。

```bash
# 检查 lockfile 内 patchedDependencies 段
grep -A5 "patchedDependencies" pnpm-lock.yaml
# 或检查 node-pty 的 patch 是否物化
ls node_modules/.pnpm/node-pty@1.2.0-beta.15/ 2>/dev/null
```

**步骤 6d**：执行 `pnpm deploy --legacy` 打包闭包审计。

```bash
pnpm --filter @corum/corum-desktop deploy --legacy --prod --auto-install-peers=false
```

**步骤 6e**：重跑闭包审计脚本。

```bash
node scripts/assert-packaged-boot.mjs
```

**每步验证**：
- `pnpm install` 退出码 0，零 `ERR_PNPM` 报错
- lockfile 内 `patchedDependencies` 段存在且包含 `node-pty@1.2.0-beta.15`
- `assert-packaged-boot.mjs` 退出码 0，零断言失败
- 打包闭包内无版本漂移（`ls build/host/node_modules/@deepseek-ai/dsh-*/package.json | grep version` 抽查）

---

## 5. 验收标准

| # | 验收项 | 判据 | 验证方式 |
|---|---|---|---|
| 1 | override 表每条可解析 | 217→250-300 条逐条 `pnpm view` 确认 registry 存在 | 逐包循环中即时验证 |
| 2 | `pnpm install` 零报错 | 退出码 0，无 `ERR_PNPM_NO_MATCHING_VERSION` / `ERR_PNPM_INVALID_SELECTOR` | `pnpm install 2>&1 \| grep ERR_PNPM` 为空 |
| 3 | vendor 钉版物化正确 | cordis 4.0.5、loader 1.0.6、include 1.0.10、timer 1.1.7、schemastery 3.18.5 | `ls node_modules/@deepseek-ai/cordis/package.json` + `grep version` |
| 4 | minimumReleaseAgeExclude 清理完成 | 433 条陈旧豁免已按策略处理，无残留 `0.1.3-alpha.1`/`0.1.1-rc.2` 钉版（除非有意保留） | `grep -E "0\.1\.3-alpha\.1|0\.1\.1-rc\.2" pnpm-workspace.yaml` 结果可解释 |
| 5 | 注释口径修正 | overrides 注释中的包数（当前自称「206」）与实际条目数（216 个 `@deepseek-ai/*`）一致 | `awk` 段统计对比 |
| 6 | 平台词表对账完成 | `CLIENT_EXTERNALS_BASE` 口径已拍板，与 `seed.ts` 11 词同步性已确认 | 代码检查 + build 无 `Module not found` |
| 7 | lockfile 重生成成功 | `pnpm-lock.yaml` 重生成，`patchedDependencies` 段保留 | `grep patchedDependencies pnpm-lock.yaml` |
| 8 | 闭包审计脚本通过 | `assert-packaged-boot.mjs` 退出码 0 | `node scripts/assert-packaged-boot.mjs && echo PASS` |
| 9 | 闭包无版本漂移 | 打包闭包内 dsh 包版本与 override 一致 | 抽查 `build/host/node_modules/@deepseek-ai/dsh-*/package.json` |

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| `pnpm deploy --legacy` 忽略 lockfile 重新解析导致闭包漂移 | **高** | override 钉死是唯一防线（2026-09-09 事故教训）；闭包审计脚本重跑是兜底 |
| 官方包系统性打包缺陷（运行时依赖放进 devDependencies） | **高** | 逐包直接验证可解析性，不信扫描脚本；`pnpm install` 后 `ls node_modules` 物化确认 |
| override 250-300 条手写量大，易漏/易错 | 中 | 脚本生成草案 + 逐包循环人工核对 |
| 433 条 minimumReleaseAgeExclude 清理误删仍需要的豁免 | 中 | 逐条审查，保留 corum 仍装配的包 |
| `CLIENT_EXTERNALS_BASE` 补 zod/react-virtual 触发白屏 | **高** | 红线 2：经 `dsh.client` 塞自定义共享模块 → 白屏，不许松绑；共享状态走 cordis 服务 |
| `patchedDependencies` 在 lock 重生成后丢失 | 中 | 重生成后 `grep patchedDependencies pnpm-lock.yaml` 确认；丢失则手动 re-apply |
| `dsh-hmr` / `cordis-plugin-hmr` 形态未核实就替换 override | **高** | HMR 形态待阶段 -1 裁决，禁止未核实就替换 override 钉版 |
| cordis 4.0.2→4.0.5 的 11 个 commit 引入 API 变化 | 低 | cordis 是 vendored 源码级依赖，patch 升级相对稳定；fork-drift 守卫会拦住（阶段 3） |

---

## 7. 回滚方案

1. **override 表回滚**：`git checkout HEAD~1 -- pnpm-workspace.yaml` 恢复 217 条基线。
2. **lockfile 回滚**：`git checkout HEAD~1 -- pnpm-lock.yaml` 恢复原 lockfile。
3. **闭包回滚**：`rm -rf build/host/node_modules`，重新 `pnpm deploy --legacy`。
4. **vendor 钉版回滚**：override 表回滚即同步恢复。
5. **分段回滚**：override 重算（步骤 2）、minimumReleaseAgeExclude 清理（步骤 3）、vendor 重算（步骤 4）、平台词表（步骤 5）、lock 重生成（步骤 6）各为独立 commit，可分段 revert。

---

## 8. 产出物与下游接口

| 产出物 | 消费者 | 接口 |
|---|---|---|
| 新 `pnpm-workspace.yaml`（override 250-300 条 + minimumReleaseAgeExclude 清理后 + vendor 钉版更新） | 阶段 3 fork rebase / 阶段 4 验证 / 日常 install | `pnpm install` 即可 |
| 新 `pnpm-lock.yaml`（重生成 + patchedDependencies 保留） | 打包 / CI | `pnpm deploy --legacy` |
| `CLIENT_EXTERNALS_BASE` 口径决策记录 | 阶段 3 fork UI 包 rebase | 本文件 §4.5 |
| 闭包审计通过证据 | 阶段 4 验收 | `assert-packaged-boot.mjs` 退出码 0 |

---

## 9. 实录要求

1. **逐包循环记录**：每改一条 override，记录「包名 / 旧版本 → 新版本 / 可解析验证结果（pnpm view 或 ls node_modules）」。
2. **minimumReleaseAgeExclude 清理记录**：433 条的分类处置（重钉 / 删除 / 保留），逐条或分批记录。
3. **vendor 钉版记录**：7 个 vendor 包的版本变化实测值（见 §4.4 表）。
4. **平台词表对账记录**：9→11 的实测（seed.ts 对比）、`CLIENT_EXTERNALS_BASE` 决策结论及理由。
5. **lock 重生成记录**：`pnpm install` 输出、patchedDependencies 验证结果、闭包审计脚本输出。
6. **闭包漂移抽查记录**：`build/host/node_modules/@deepseek-ai/dsh-*/package.json` 版本抽查结果。
7. **异常记录**：任何 `ERR_PNVM` 报错、闭包审计失败、版本漂移均逐条记录根因与修法。
8. **与可行性文档的偏差记录**：实际落点条目数 vs 预计 250-300 的偏差及原因。
