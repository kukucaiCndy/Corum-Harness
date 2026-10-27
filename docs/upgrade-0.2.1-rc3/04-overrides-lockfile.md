# 阶段 2：override 重算与 lock 重生成

> 状态：**评审修订完成，待执行**（2026-10-27 三方评审已并入）｜ 前置：阶段 1（被删/更名包 + API 迁移）+ S0 回补 ｜ 工程量：中高（override 脚本化生成 + 433 条豁免整段删除 + vendor 重算 + lock 重生成 + skip-app 部署闭包审计）
>
> 单一事实源：`docs/UPGRADE-0.2.1-rc3-feasibility.md`（含评审修订 §六 阶段 2）。
> 评审证据（2026-10-27 三方）：
> - `~/.corum/research-reports/e8b08262-…md`（override 与 lock 文件）
> - `~/.corum/research-reports/caa5956c-…md`（闭包与原生依赖）
> - `~/.corum/research-reports/b7c52ef6-…md`（阶段边界与回滚）
> 方法论参照：上次升级 0.1.3→0.1.5 的逐包循环纪律（交接文档 `HANDOFF-2026-09-29-official-0.1.5-upgrade.md` §2 三条方法论：包声明与根 override 必须同时改 / 直接验证可解析性不信扫描脚本 / 官方有系统性打包缺陷——运行时依赖被放进 devDependencies）。

---

## 1. 目标与范围

将 `pnpm-workspace.yaml` 的 `overrides` 段从 0.1.5-rc.3 基线（217 条 = 216 个 `@deepseek-ai/*` + 1 个 `electron`）全量重算至 0.2.1-rc.3 目标版本，同步整段删除陈旧的 `minimumReleaseAgeExclude` 段（433 条死配置），重算 vendor 连带钉版，重生成 lockfile，并完成 `--skip-app` 模式部署闭包审计。

**本阶段产出**：一份可解析、零冲突、lockfile 幂等的 override 表；一个 `--skip-app` 部署闭包通过版本一致性 / 黑名单 / 单例断言。

**不在本阶段范围**：
- fork 包源码 rebase（阶段 3）
- 被删/更名包的 import 改写（阶段 1 + S0 回补，已完成）
- 实机 CDP 冲烟（阶段 4）
- 完整打包（`buildApp` / `smokeBridge`）+ `assert-packaged-boot.mjs`（阶段 4）
- 全仓 typecheck / test / fork-drift 作为退出门禁（阶段 3/4；阶段 2 模块解析失败/版本 skew/缺包/重复实例是 blocker）

---

## 2. 前置条件

1. **阶段 1 已完成**：4 个被删/更名包 + `dsh-session-title-llm` provider API 迁移 + HMR 形态经阶段 -1 裁决后处置均已落地。
2. **S0 回补已完成（阶段 1 漏网尾债，独立 commit）**：三方评审发现阶段 1 漏了 2 个被删包——`dsh-settings-file`（官方在 `601d6761e4` 删除，功能并入 profile-backed forms）和 `dsh-workflow-worker-thread`（官方在 `35af8698c2` 删除，引擎并入 `@deepseek-ai/dsh-workflow`，rc3 的 `packages/workflow/workflow/src/index.ts:159` 仍提供 `workflowEngine` 服务）。
   - **`desktop-host/package.json:106`** `@deepseek-ai/dsh-settings-file: 0.1.5-rc.3` 删除；
   - **`desktop-host/package.json:146`** `@deepseek-ai/dsh-workflow-worker-thread: 0.1.5-rc.3` 删除；
   - **`corum-agent/src/compile.ts:292`** 引擎 provider 行的 `name` 从 `@deepseek-ai/dsh-workflow-worker-thread` 改挂 `@deepseek-ai/dsh-workflow`（**不是删行**——orchestrate script 模式依赖 `runtimeCtx.get('workflowEngine')`，实测删除后指挥模式派发即报错，见 compile.ts:279-284 注释）；
   - **`corum-ide-ui/src/client/settings/plugin-meta.ts:56`** + **`corum-ide-plugin-manager-ui/src/client/plugin-meta.ts:51`** 的 `dsh-settings-file` 展示行删除（仅插件中心 inventory 元数据，无运行时依赖）；
   - **`corum-ide-ui/src/client/settings/plugin-meta.ts:106`** + **`corum-ide-plugin-manager-ui/src/client/plugin-meta.ts:101`** 的 `dsh-workflow-worker-thread` 展示行删除；
   - 相关 shipped preset 若有同包行也须全 grep 处理，保留必要 engine row。
   > 此回补按阶段 1 尾债独立 commit，**执行阶段 2 前必须先做**。03 册已补记（不伪造此前验收已发现）。
3. **官方 dsh 仓 tag `dsh-v0.2.1-rc.3` 存在**：`git -C /Users/kukucai/dsh tag -l 'dsh-v0.2.1-rc.3'` 非空即可；跨版本对比用 `git show dsh-v0.2.1-rc.3:<path>` 取数，**不要求 checkout**（当前 dsh 工作树 HEAD 不必等于 tag）。
4. **阶段 -1（官方升级指南映射表）已完成**：43 篇指南已产出「指南 → corum 影响映射表」。
5. **备份就绪**：`~/.corum` 已备份（阶段 0）。

---

## 3. 输入与依赖

| 输入 | 来源 | 用途 |
|---|---|---|
| `pnpm-workspace.yaml`（当前 HEAD） | 本仓 | override 基线 217 条 + minimumReleaseAgeExclude 433 条 |
| `dsh-v0.2.1-rc.3` tag | `/Users/kukucai/dsh` | 官方目标版本号全集（正向清单生成基础） |
| 官方 `packages/+apps/` 公开包树 | `git -C /Users/kukucai/dsh ls-tree -r dsh-v0.2.1-rc.3` | 官方全量包 name+version（排除 private/非发布包） |
| `vendor/` 目录 | dsh 仓 `vendor/` | cordis/loader/include/group/timer/schemastery/cosmokit/hmr 目标版本 |
| `packages/client/web/src/seed.ts` | dsh 仓 | 平台词表 9→11 对账 |
| `packages/tooling/corum-plugin-build/src/index.ts:37` | 本仓 | `CLIENT_EXTERNALS_BASE`（6 词）决策点 |
| `packages/desktop/scripts/pack-macos.mjs` | 本仓 | 部署管线（`--skip-app` 模式目标） |
| 三方评审报告 | `~/.corum/research-reports/{e8b08262,caa5956c,b7c52ef6}-…md` | override 策略 / 闭包断言 / 阶段边界 / 回滚 |

---

## 4. 执行步骤

> **执行顺序按 S0→S1→S2→S3→S4→S5，每逻辑单元 commit，lock 一次。**

### S0 回补阶段 1 漏网（独立 commit，最先做）

见 §2 前置条件 #2。此步执行 `dsh-settings-file` 与 `dsh-workflow-worker-thread` 的 dep 删除 + compile.ts 引擎行改挂 + plugin-meta 展示行删除。

**验证**：
- `grep -rn 'dsh-settings-file' packages/ --include='*.ts' --include='*.json' | grep -v node_modules | grep -v '/lib/' | grep -v '/dist/' | grep -v '/build/'` 零命中（pnpm-workspace.yaml override 行留 S1 处理）；
- `grep -rn 'dsh-workflow-worker-thread' packages/ --include='*.ts' --include='*.json' | grep -v node_modules | grep -v '/lib/' | grep -v '/dist/' | grep -v '/build/'` 仅命中 compile.ts 注释行（历史叙述），无实际引用；
- compile.ts:292 `name` 已改为 `@deepseek-ai/dsh-workflow`，provider 行保留。

### S1 override 全量重算（manifest + override 同批生成）

#### S1.1 正向清单生成

**策略**：以官方 rc3 `packages/+apps/` 所有公开 `@deepseek-ai/*` 包 name/version 为正向清单，钉精确 `0.2.1-rc.3`，排除 private/非发布包。**不从旧 217 条手工猜测，也不只按当前直接装配集合缩减。**

**理由**：保留完整官方集合可防止传递 peer 漂到 rc4（npm 上 `dsh-hmr@0.2.1-rc.3` 的 `dist-tags.next` 已是 `0.2.1-rc.4`，`^0.2.1-rc.3` 会漂到 rc.4）。未装配的 override 不会导致安装，保留它不增加安装面但防止传递解析漂移。

```bash
# 脚本化生成：以官方 rc3 全量公开包为基础
# 排除 private（package.json 无 name 或 name 不以 @deepseek-ai/ 开头）
# 排除非发布包（fixture/website/local/benchmarks 等）
git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 \
  | grep 'package.json$' \
  | while read f; do
      name=$(git -C /Users/kukucai/dsh show "dsh-v0.2.1-rc.3:$f" 2>/dev/null \
        | grep -m1 '"name"' | sed 's/.*"name".*"//' | sed 's/".*//')
      version=$(git -C /Users/kukucai/dsh show "dsh-v0.2.1-rc.3:$f" 2>/dev/null \
        | grep -m1 '"version"' | sed 's/.*"version".*"//' | sed 's/".*//')
      private=$(git -C /Users/kukucai/dsh show "dsh-v0.2.1-rc.3:$f" 2>/dev/null \
        | grep -m1 '"private"' | sed 's/.*"private".*//' | sed 's/[," ].*//')
      if [ -n "$name" ] && echo "$name" | grep -q '@deepseek-ai/' && [ "$private" != "true" ]; then
        echo "  '$name': '$version'"
      fi
    done | sort -u > /tmp/override-draft.txt
```

> 生成脚本若需保留可放 `scripts/` 并提交。最终条目数以实际生成为准，不预写 250-300。

#### S1.2 fork manifest 机械升版（与 override 成对）

**50 fork 包内对官方 dsh 的 dep/dev/peer 版本统一改为 `^0.2.1-rc.3`**（workspace 协议下由 override 收敛），只有官方已删除/更名包按 S0 + 阶段 1 专项处理。

> 阶段 3 不再负责机械升版——fork manifest 的版本号改写在阶段 2 完成与 override 同批，阶段 3 只做源码 rebase。

#### S1.3 desktop-host 版本统一

**desktop-host/package.json 全部 `@deepseek-ai/*` 依赖统一升为精确 `0.2.1-rc.3`**。阶段 1 只改了 4 处（dsh-hmr/dsh-agent-preset-registry/dsh-ptc-runtime/dsh-session-title-llm），其余约 90 个仍钉 `0.1.5-rc.3`（含 `dsh-session:0.1.5-rc.3` :97）。

**为什么必须同批**：`pack-macos.mjs:1160-1188` 的 `assertUniformDshVersions()` 取 desktop-host `dsh-session` 钉版为期望值，闭包内任何非该版本的 dsh 包都 fail loud。override 全量升到 rc.3 后，闭包 dsh 包全是 rc.3，而 manifest 仍钉 0.1.5-rc.3 ⇒ 断言必红。

#### S1.4 两条 fork override 保留不动

```
'@deepseek-ai/dsh-fs-local': 'link:packages/plugins/agent/corum-fs-local'
'@deepseek-ai/dsh-tools': 'workspace:@corum/corum-tools@*'
```

- `dsh-fs-local` 用 `link:`：合法，因不被任何包声明为 peer（fork-delta §18.1 实证）；
- `dsh-tools` 用 `workspace:` 而非 `link:`：**必须**——被 30+ 官方包声明为 peer，`link:` 不参与 peer 求解会分裂出两份 `Symbol()` 实例（issue #75 事故）；
- **这两条 override 不可改**，不参与版本改写。

#### S1.5 electron 行保留不动

```
'electron': '43.4.1'
```

Electron 保持 43.4.1（钥匙串 ACL/cdhash 事故的唯一防线，`verify-electron-pin.mjs` 四重校验）。阶段 4.5 再独立评估是否升 44.7。**不参与 `0.2.1-rc.3` 版本改写**。

**每步验证**：
- `grep -c "'0.2.1-rc.3'" pnpm-workspace.yaml` = 草案条目数；
- `grep "0.1.5-rc.3" pnpm-workspace.yaml`（overrides 段内）= 0（fork 两行 + electron 除外）；
- `grep -E "dsh-settings-file|dsh-workflow-worker-thread" pnpm-workspace.yaml`（overrides 段内）= 0。

### S2 豁免清理 + vendor 重算

#### S2.1 minimumReleaseAgeExclude 433 条整段删除

**基线**：`pnpm-workspace.yaml:307` 起，共 433 条（249 条 `@0.1.3-alpha.1` + 184 条 `@0.1.1-rc.2`）。

**策略**：**整段删除，不逐条改**。理由：
- `pnpm-workspace.yaml:42` `minimumReleaseAge: 0`（当前为 0），整个 exclude 段在 0 分钟冷却下是**死配置**——pnpm 文档证实 exclude 只在设置了非零 `minimumReleaseAge` 时生效；
- 逐条审查 433 条是 433 次无意义人工判断；
- 未来启用冷却（如 `10080` = 7 天）是升级后的独立决策，届时按官方 rc3 的 22 条口径重建即可。

**`minimumReleaseAge: 0` 本阶段不改**，未来启用冷却另行决策。

**是否移植官方 rc3 的 22 条非 dsh 豁免**：需对照现有 workspace 和官方段——与 corum 实际依赖无关的不盲加；所需 native 配套豁免（如 `node-addon-native-custom-loader@0.1.9`、`node-addon-require-builtin-*@0.1.9`）若 corum 装配则保留/补齐并说明。官方 22 条：
- libreoffice-kit 6 条（corum 不装配 → 不加）；
- pi-ai 2 条（corum 无 pi-ai route fork → 不加）；
- node-addon-* 11 条（若 corum 装配 `node-addon-native-custom-loader` 则保留并说明）；
- claude-agent-sdk 6 条（若 corum 装配则保留）；
- electron@44.7.0 1 条（corum 钉 43.4.1 → 不加）。

> 删除后在 `minimumReleaseAgeExclude:` 位置补一行注释：「启用非零 `minimumReleaseAge` 时，先按官方 rc3 的 22 条口径 + corum 实际装配集合重建本段」。

**每步验证**：`grep -E "0\.1\.3-alpha\.1|0\.1\.1-rc\.2" pnpm-workspace.yaml` = 0（整段已删）。

#### S2.2 vendor 连带钉版重算

> **HMR 裁决已落地（阶段 1 已执行）**：`dsh-hmr` 是 `cordis-plugin-hmr` 的官方继任包。阶段 1 已将 `desktop-host/package.json:53` dep + 两个 plugin-meta 改为 `dsh-hmr`。本阶段负责 override 侧：删 `cordis-plugin-hmr` 旧钉 + 新增 `dsh-hmr` override。

**核实值**（dsh 仓 `vendor/` 目录 `git show dsh-v0.2.1-rc.3` 实测，已逐项复核）：

| vendor 包 | 0.1.5-rc.3 版本 | 0.2.1-rc.3 版本 | corum 当前 override | 处置 |
|---|---|---|---|---|
| `@deepseek-ai/cordis` | 4.0.2 | **4.0.5** | `:288` 钉 4.0.2 | 改为 4.0.5 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.3 | **1.0.6** | `:290` 钉 1.0.3 | 改为 1.0.6 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.17 | 1.0.20（vendored 旧包仍存在但官方 profile 不用） | `:292` 钉 1.0.17 | **删除该 override 行**（阶段 1 已将 dep 改为 `dsh-hmr`，旧 `cordis-plugin-hmr` override 不再需要） |
| `@deepseek-ai/dsh-hmr` | —（新包） | **0.2.1-rc.3** | 无（阶段 1 新增 dep） | **新增** `'@deepseek-ai/dsh-hmr': '0.2.1-rc.3'` override |
| `@deepseek-ai/cordis-plugin-include` | 1.0.7 | **1.0.10** | `:289` 钉 1.0.7 | 改为 1.0.10 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.2 | **1.0.5** | `:291` 钉 1.0.2 | 改为 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.4 | **1.1.7** | `:294` 钉 1.1.4 | 改为 1.1.7 |
| `@deepseek-ai/schemastery` | 3.18.2 | **3.18.5** | `:293` 钉 3.18.2 | 改为 3.18.5 |
| `@deepseek-ai/cosmokit` | 1.8.5（已浮） | **1.8.6** | 未单独钉（lockfile importer 浮到 1.8.5，已在漂） | **钉 1.8.6**（与 vendor 对齐，消除漂移） |

> **基线值更正**（评审发现）：旧 04 写 include 1.0.4 / timer 1.1.2 是错误的。实测 `pnpm-workspace.yaml:289` 钉 1.0.7、`:294` 钉 1.1.4（与官方 rc.3 `vendor/include` = 1.0.7、`vendor/timer` = 1.1.4 一致）。
>
> **新增**：cordis-plugin-logger-console 1.0.5（`vendor/logger-console`，官方 rc3 新增）。corum 不装配则不用加 override，登记即可。
>
> **方向说明**：官方 rc3 自己用 `link:vendor/cosmokit` + `link:vendor/schemastery`；corum 不 vendor 源码，走 npm 精确钉 4.0.5/3.18.5——两套机制不冲突，corum 的 cordis 版本以 npm 上发布的 4.0.5 为准。
>
> `dsh-client-hmr`（`:73` override + 历史 ignore）在 0.2.1 **仍存在**（`packages/client/hmr/`），保留不动。

**步骤 4**：将上述版本号写入 override 表对应行。删 `cordis-plugin-hmr` 旧钉行，新增 `dsh-hmr` override 行。

**每步验证**（用 `node -p` 或 grep package.json 内容，不用 `ls | grep version`）：

```bash
# 正确的版本检查方式
node -p "require('./node_modules/@deepseek-ai/cordis/package.json').version"
node -p "require('./node_modules/@deepseek-ai/cordis-plugin-include/package.json').version"
# 或 grep package.json 内容
grep '"version"' node_modules/@deepseek-ai/cordis/package.json
```

### S2.3 平台词表 9→11 对账（静态一致性决策）

**核实值**（dsh 仓 `git show dsh-v0.2.1-rc.3:packages/client/web/src/seed.ts` 实测）：

| 版本 | seed.ts 模块数 | 列表 |
|---|---|---|
| 0.1.5-rc.3 | **9** | react、react/jsx-runtime、react-dom、react-dom/client、`@deepseek-ai/cordis`、dsh-client-store、ui-slots、ui-primitives、ui-dockkit |
| 0.2.1-rc.3 | **11** | 上述 9 个 + **`zod`** + **`@tanstack/react-virtual`** |

**决策点**：`packages/tooling/corum-plugin-build/src/index.ts:37` 的 `CLIENT_EXTERNALS_BASE`（当前 6 词：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`）是否跟进补 `zod` / `@tanstack/react-virtual`。

**事实核实**：corum **已经**在 import 这两个模块（非「尚未使用」）：
- `zod`：`corum-tool-subagent/src/model-selection-state.ts:3`、`corum-orchestration/src/orchestration.ts:36`、`corum-memory/src/memory-entities.ts:42`、`corum-subagent/src/projection.ts:8`、`corum-subagent/src/control.ts:13`、`corum-session-queue-revert/src/index.ts:45`（6 处，目前内联进 bundle）；
- `@tanstack/react-virtual`：`corum-ui-trajectory/src/client/TrajectoryTable.tsx:5`（目前内联进 bundle、未进 external）。

**决策依据**：
- **是否加 external 必须基于模块表/共享单例证据，非盲加**。进 external 的风险：经 `dsh.client` 的 module table 塞自定义共享模块 → 白屏（AGENTS 红线 2 + `.dbg/b1-boot-graph-findings.md` 证据）。但 `zod` 和 `@tanstack/react-virtual` 是官方 seed.ts 11 词中的合法条目——官方已把它们加入 platform module table，加进 `CLIENT_EXTERNALS_BASE` 等于跟随官方共享面，不构成「自定义共享模块」。
- **红线复述**：`dsh.client` 的 module table 是硬编码种子（0.1.5 时 9 个，0.2.1 增至 11 个）；自定义共享模块经此路径白屏——**不许松绑**。corum 若需共享状态走 cordis 服务（AGENTS 红线 1），不塞 module table。
- 当前 corum fork UI 包 import 的 `zod`/`react-virtual` 走内联（bundled），**不报 Module not found**——内联是可行的。是否改为 external 取决于「是否需要跨 bundle 共享同一实例」（如 zod schema 共享）。

**步骤 5**：基于模块表/共享单例证据拍板 `CLIENT_EXTERNALS_BASE` 口径。若 fork UI 包确实需要跨 bundle 共享 `zod`/`react-virtual` 单例，补对应词条；否则保持内联不动。

**本阶段只做静态一致性决策 + 决策记录**。fork UI 包 build 无 Module not found / 实机渲染无白屏属**阶段 4** CDP 冲烟判据，不作为阶段 2 门禁。

#### terminal-command-labels 点名

`dsh-client-ui-primitives` override 行升 rc3 对应 `terminal-command-labels` 指南（01 附录 A #27，归 `2+4`）：官方 `TerminalBlockLabels` 新增 `commandLine` 字段。corum 有 dep 但不直接使用该字段。override 升 rc3 即覆盖此指南项。

### S3 lock 重生成 + 幂等验证

#### S3.1 前提

- override 表已重算 + commit（S1-S2）；
- node_modules 允许保留（pnpm 11 的 content-addressable store + 增量物化会自行处理版本切换，不必删 node_modules）；
- **当前 lockfile 落后于 manifest**（阶段 1 已知中间态：lockfile 不含 `dsh-hmr`/`dsh-ptc-runtime`/`dsh-agent-preset-registry`，但 node_modules 已装）。重生成前**禁止 `--frozen-lockfile`**。

#### S3.2 pnpm 版本

**保持 `pnpm@11.7.0`**（packageManager 字段），不因评审建议就升级工具链。lockfileVersion 9.0 兼容。官方 rc3 用 `pnpm@11.28.5`，只记录为可选后续。node26 满足 `engines: ^22.19.0 || >=24.0.0`。

> 若执行时 `corepack` 未激活：`corepack enable && corepack prepare pnpm@11.7.0 --activate`。

#### S3.3 重生成命令

```bash
# 用现有可用 pnpm，显式 --no-frozen-lockfile
rm pnpm-lock.yaml
pnpm install --no-frozen-lockfile
```

#### S3.4 幂等校验

```bash
# 第二遍：零 diff 才算稳定
pnpm install
git diff --stat pnpm-lock.yaml   # 应为空
```

#### S3.5 registry 镜像抽查

当前 `~/.npmrc` = `registry=https://registry.npmmirror.com`。镜像的 `time` 字段同步可能滞后。**不强制切换用户全局 registry**，但需抽查 rc3 新包可解析：

```bash
# 抽查 2-3 个新增包（如 dsh-hmr、dsh-ptc-runtime、dsh-agent-preset-registry）
pnpm view @deepseek-ai/dsh-hmr@0.2.1-rc.3 version
```

若镜像未同步，临时加 `--registry=https://registry.npmjs.org/` 重生成。

#### S3.6 lock 提交

成功后 lock 提交（单一 commit）。此后默认 frozen——一切后续阶段用 `--frozen-lockfile`。

**每步验证**：
- `pnpm install` 退出码 0，零 `ERR_PNPM` 报错；
- `grep -c "0.2.1-rc.3" pnpm-lock.yaml` > 0；
- `grep -c "0.1.5-rc.3" pnpm-lock.yaml` = 0（fork workspace 物化除外）；
- 幂等第二遍 `git diff pnpm-lock.yaml` 为空。

### S4 skip-app 部署 + 闭包审计

#### S4.1 `--skip-app` 模式实现

**禁止手写 deploy 命令**（旧 04 §4.6 步骤 6d 写的 `pnpm --filter @corum/corum-desktop deploy --legacy --prod --auto-install-peers=false` 三处错误：filter 包名错、缺 `--config.node-linker=hoisted`、会在真工作区跑污染 node_modules）。

采用最小侵入给 `packages/desktop/scripts/pack-macos.mjs` 增加 `--skip-app` 模式：
- 仍走 `deployHost()` / `topUpOfficialPackagesFromWorkspace()` / `dedupeClosureNodeModules()` / `assertUniformDshVersions()` / `copyDesktopArtifacts()` / `materializeSymlinks()` 等；
- 跳过 `smokeBridge()` 和 `buildApp()`；
- 由阶段 2 执行时实现。

**验收标准**（`--skip-app` 模式）：
- `deployHost()` 开头 `rm -rf build/host` 全量重建 → `build/host/package.json` 由 `writeHostManifest()` 现场合成；
- `assertUniformDshVersions()` 全绿（前置 = desktop-host 全部 `@deepseek-ai/*` 已升 0.2.1-rc.3）；
- `dedupeClosureNodeModules()` 零残留；
- `copyDesktopArtifacts()` 从 `node_modules/@deepseek-ai/dsh-web-frontend/dist` 重建 `build/dist`；
- `materializeSymlinks()` 平铺化完成；
- 前置：`lib/bridge.js` 必须先在（`pnpm -r run build`）。

> **不要把 pack:host 预期红当门禁**。`--skip-app` 模式的目的是跳过 smokeBridge/buildApp，不预期它们红。

#### S4.2 闭包版本审计

deploy 后审计闭包内 `@deepseek-ai/*` 版本分布：

```bash
# 闭包内不允许出现 0.1.5-rc.3 及任何非目标 rc3 版本（fork workspace 物化除外）
find build/host/node_modules/@deepseek-ai -name package.json \
  | xargs grep -h '"version"' | sort | uniq -c
```

**判据**：
- 闭包 @deepseek-ai 官方包**不允许** `0.1.5-rc.3` 或其他版本，全等于 `0.2.1-rc.3`；
- fork 顶替例外按机制（`dsh-fs-local` link: / `dsh-tools` workspace:）而非盲排；
- fork 名单 `dsh-fs-local` / `dsh-tools` 物化为 workspace 版本，不算版本混装。

#### S4.3 补强部署断言（执行时改 pack-macos）

阶段 2 补强以下断言（执行时改 `pack-macos.mjs`）：

1. **被删/旧包黑名单零命中**：闭包顶层不得出现 `dsh-agent-presets` / `dsh-code-runtime`(-worker-thread) / `dsh-invariants` / `dsh-subagent-in-process-driver` / `cordis-plugin-hmr` / `dsh-settings-file` / `dsh-workflow-worker-thread`；
2. **cordis/schemastery/cosmokit 各自唯一版本且符合 override**（扩 `assertUniformDshVersions` 扫描面到这三个 vendor 包——当前只扫 `dsh-*` 前缀，实测 cosmokit 已浮到 1.8.5 是漏洞现例）；
3. **现有 dsh 统一版本/fork 内容/平台闭包断言保持**。

#### S4.4 解析探针（不 boot）

对闭包顶层每个 `@deepseek-ai/*`、`@corum/*` 包跑 `import.meta.resolve(main)`（或 `createRequire(host/package.json).resolve`）——抓「声明了但没物化/缺 entry」。这是 0.1.5「官方把运行时依赖放 devDependencies」教训的机械化，不 boot 就能跑。

### S5 实录

逐条记录：
1. S0 回补的 commit hash + 改动文件清单；
2. S1 override 生成脚本输出 + 条目数 + desktop-host/fork manifest 升版数；
3. S2 豁免删除 + vendor 重算 + CLIENT_EXTERNALS 决策；
4. S3 lock 重生成 + 幂等 + registry 抽查；
5. S4 skip-app 部署 + 闭包审计 + 断言结果；
6. **活案例**：阶段 1 `dsh-session-title-llm` manifest 已 0.2.1 但 override 仍 0.1.5-rc.3，物化为 0.1.5-rc.3（`node_modules/.pnpm/@deepseek-ai+dsh-session-title-llm@0.1.5-rc.3_*` 实测）。阶段 2 必须验证物化只 0.2.1-rc.3——这正是「override 必须与 manifest 同步改」的活证据。

---

## 5. 验收标准

### A. 依赖闭包可验收（阶段 2 退出门禁，全绿才放行）

| # | 验收项 | 判据 | 验证方式 |
|---|---|---|---|
| A1 | override 自洽 | `grep -c "'0.2.1-rc.3'" pnpm-workspace.yaml` = 草案条数；0 条 `0.1.5-rc.3`（fork 两行 + electron 除外）；0 条 `dsh-settings-file`/`dsh-workflow-worker-thread`/其余已删名 | grep |
| A2 | `pnpm install` 可解析 | 退出码 0，`ERR_PNPM` 零命中 | `pnpm install 2>&1 \| grep ERR_PNPM` 为空 |
| A3 | lock 落位 | `grep -c "0.2.1-rc.3" pnpm-lock.yaml` > 0；`grep -c "0.1.5-rc.3" pnpm-lock.yaml` = 0（fork workspace 物化除外）；幂等第二遍 diff 空 | grep + `git diff` |
| A4 | frozen 一致性 | deploy 副本 `pnpm install --frozen-lockfile`（pack-macos.mjs:557 原样跑）成功 | 部署管线内置 |
| A5 | vendor 物化 | cordis 4.0.5、loader 1.0.6、include 1.0.10、timer 1.1.7、schemastery 3.18.5、cosmokit 1.8.6、dsh-hmr 0.2.1-rc.3 | `node -p require(...).version` 或 grep package.json |
| A6 | 解析面实况 | `ls node_modules/.pnpm \| grep dsh-session-title-llm` 只含 0.2.1-rc.3；`ls node_modules/.pnpm \| grep -c "0.1.5-rc.3"` = 0（fork workspace 物化除外） | ls .pnpm |
| A7 | 部署管线断言全绿 | `assertUniformDshVersions` + `dedupeClosureNodeModules` + `assertPlatformClosure` + topUp 零 missing + 被删包黑名单零命中 + cordis/schemastery/cosmokit 唯一版本 | `--skip-app` 模式运行 |
| A8 | 解析探针 | 闭包顶层每个 `@deepseek-ai/*`、`@corum/*` 包 `import.meta.resolve(main)` 成功 | 脚本 |
| A9 | electron 锁 | `node scripts/verify-electron-pin.mjs` exit 0（electron 43.4.1 不动） | 脚本 |
| A10 | minimumReleaseAgeExclude 清理 | 433 条整段删除，无残留 `0.1.3-alpha.1`/`0.1.1-rc.2` | grep |

### B. fork 语义待阶段 3/4（阶段 2 只记录，不作门禁）

| # | 验收项 | 归属 | 判据 |
|---|---|---|---|
| B1 | `smokeBridge` ready | 阶段 4 | 不在阶段 2 门禁 |
| B2 | 全仓 typecheck `--force` | 阶段 3 | 阶段 2 不要求 |
| B3 | 全仓 test | 阶段 3 | 阶段 2 不要求 |
| B4 | fork-drift | 阶段 3 | 阶段 2 不要求 |
| B5 | `assert-packaged-boot.mjs` | **阶段 4**（需完整 app/resources/node，阶段 2 无 pack 产物，取不到会 exit 2） | 阶段 2 不要求 |
| B6 | CDP 冲烟 | 阶段 4 | 不在阶段 2 门禁 |

**防降级门禁掩盖依赖错误的判据 = 按失败文本分流**：
- 失败含 `ERR_PNPM` / `Cannot find package` / `Module not found` / 版本 skew / 同版本重复实例 / `is not a function` 出现在**模块解析路径** ⇒ **阶段 2 blocker**，不许以「阶段 3 会修」豁免；
- 失败属 API 语义（service 撞名、缺方法、preset bind 失败等 03 §3.6 六项台账内）⇒ 阶段 3 项，逐条对照六项台账记为 expected-red 基线，台账外的新红一律先归因再放行。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| `pnpm deploy --legacy` 忽略 lockfile 重新解析导致闭包漂移 | **高** | override 精确钉版是唯一防线（2026-09-09 事故教训）；闭包审计是兜底 |
| 官方包系统性打包缺陷（运行时依赖放进 devDependencies） | **高** | 逐包直接验证可解析性，不信扫描脚本；解析探针（S4.4）机械化 |
| desktop-host 版本未统一导致 `assertUniformDshVersions` 必红 | **高** | S1.3 desktop-host 全部 `@deepseek-ai/*` 与 override 同批升 |
| override `^0.2.1-rc.3` 漂到 rc.4 | **高** | 精确钉 `0.2.1-rc.3`（不用 `^`），保留完整官方集合防传递 peer 漂移 |
| cosmokit 已浮到 1.8.5（跨版本双实例风险） | 中 | S2.2 钉 1.8.6；S4.3 补 cordis/schemastery/cosmokit 唯一版本断言 |
| `CLIENT_EXTERNALS_BASE` 补 zod/react-virtual 触发白屏 | **高** | 基于模块表/共享单例证据决策，非盲加；UI build 与白屏归阶段 4 |
| `--skip-app` 实现遗漏断言 | 中 | S4.1 验收标准写清；只跳 smokeBridge + buildApp，其余全走 |
| build/host 残留旧包（invariants/in-process-driver/cordis-plugin-hmr 等） | 低 | deployHost `rm -rf` 全量重建，重 deploy 自然消除；S4.3 黑名单断言兜底 |
| registry 镜像未同步 rc3 新包 | 中 | S3.5 抽查；未同步则临时 `--registry=https://registry.npmjs.org/` |

---

## 7. 回滚方案

1. **回滚用阶段 2 起点 hash**（开工前 `git rev-parse HEAD` 记入实录，当前 `178e3966`），**不是 `HEAD~1`**（`HEAD~1` 依赖前一个 commit 恰好改过该文件，若某步 commit 没碰 lock 就取不到）：
   ```bash
   git checkout <stage2-start-hash> -- pnpm-workspace.yaml pnpm-lock.yaml
   ```
2. **回滚后 node_modules 全量重装**（lock/override 回滚后 node_modules 处于部分迁移态，03 §5.4 已警告「install 0 error 但树已中毒」）：
   ```bash
   rm -rf node_modules
   pnpm install --frozen-lockfile
   ```
3. **build/host 重 deploy**：`rm -rf build/host/node_modules`，重新跑 `--skip-app` 部署。
4. **分段回滚**：S0 回补 / S1 override / S2 豁免+vendor / S3 lock 各为独立 commit，可分段 revert。
5. **无需新 home 备份**：远程分支 + 阶段 0 home 备份已覆盖回滚需求。

---

## 8. 产出物与下游接口

| 产出物 | 消费者 | 接口 |
|---|---|---|
| 新 `pnpm-workspace.yaml`（override 全量 rc3 + minimumReleaseAgeExclude 删除 + vendor 钉版更新） | 阶段 3 fork rebase / 阶段 4 验证 / 日常 install | `pnpm install` 即可 |
| 新 `pnpm-lock.yaml`（重生成，幂等） | 打包 / CI | `pnpm deploy --legacy`（`--skip-app` 阶段 2 / 完整 pack 阶段 4） |
| desktop-host + 50 fork manifest（全部 `@deepseek-ai/*` 升 rc3） | 阶段 3 rebase / 阶段 4 验证 | 已与 override 同批改 |
| `CLIENT_EXTERNALS_BASE` 口径决策记录 | 阶段 3 fork UI 包 rebase | 本文件 §S2.3 |
| `--skip-app` 部署闭包审计通过证据 | 阶段 4 验收 | 闭包版本分布 + 断言全绿 |
| override 生成脚本（若保留） | 后续 0.2.x→0.3.x 升级 | `scripts/` |

---

## 9. 实录要求

1. **S0 回补记录**：commit hash + 改动文件清单 + compile.ts 引擎行改挂验证。
2. **override 生成记录**：脚本输出 + 条目数 + 与旧 217 条的 diff（新增 X / 删除 Y / 版本跳跃 Z）。
3. **fork manifest 升版记录**：50 包 `@deepseek-ai/*` dep/dev/peer 升版数 + desktop-host 升版数。
4. **minimumReleaseAgeExclude 删除记录**：433 条整段删除确认 + 22 条官方豁免对照决策。
5. **vendor 钉版记录**：9 个 vendor 包版本变化实测值（见 §S2.2 表）。
6. **平台词表对账记录**：9→11 实测 + `CLIENT_EXTERNALS_BASE` 决策结论及理由。
7. **lock 重生成记录**：`pnpm install` 输出 + 幂等校验 + registry 抽查结果。
8. **skip-app 部署记录**：闭包版本分布 + 断言结果 + 解析探针结果。
9. **活案例记录**：`dsh-session-title-llm` 物化验证（manifest 0.2.1 ↔ override 0.2.1 ↔ .pnpm 物化 0.2.1-rc.3）。
10. **异常记录**：任何 `ERR_PNPM` / 闭包审计失败 / 版本漂移均逐条记录根因与修法。
11. **与可行性文档的偏差记录**：实际落点条目数 vs 预估的偏差及原因。

---

## 10. node-pty / patchedDependencies 决策

> **corum 无 `patchedDependencies`，无 `patches/` 目录，lockfile 无 patchedDependencies 段**（grep 全仓确认）。旧 04 §4.6 雷区 2「patchedDependencies re-apply 验证」是对不存在机制的经验证，已删除。

### 10.1 better-sqlite3

**不存在**。全仓 grep（manifest/yaml/mjs/ts/lockfile）零命中。官方 rc3 的 sqlite 后端用 Node 内建 `node:sqlite`（`dsh-storage-sqlite/lib/index.js:3` `import { DatabaseSync } from "node:sqlite"`）。**无需任何三平台种子策略**；阶段 4 唯一相关事项是宿主 Node 运行时版本 ≥ node:sqlite 可用线（fetch-node 取的 v26.4.0 已满足）。

### 10.2 node-pty 验证

`packages/desktop/package.json:280` 钉 `node-pty: 1.2.0-beta.15`（**精确版本钉，不是 patch**）。靠 `onlyBuiltDependencies`（pnpm-workspace.yaml:25）放行其 postinstall 落 prebuilds。

**验证两件事**（替换旧「patchedDependencies 仍生效」）：
1. `ls node_modules/.pnpm/node-pty@1.2.0-beta.15/node_modules/node-pty/prebuilds/` 六平台目录齐全（实测 darwin-arm64/darwin-x64/linux-arm64/linux-x64/win32-arm64/win32-x64 全在 ✓）；
2. `packages/desktop/package.json:280` 精确钉版 `1.2.0-beta.15` 未被重算波及。

### 10.3 官方 node-pty patch 移植决策

**执行前必须读官方 rc3 `patches/node-pty@1.2.0-beta.15.patch` 具体内容并判断 corum 是否需移植。**

**已读内容**（`git show dsh-v0.2.1-rc.3:patches/node-pty@1.2.0-beta.15.patch`）：
- **`lib/unixTerminal.js`**：修改 `spawn-helper` 路径解析——新增 `DSH_NODE_PTY_SPAWN_HELPER` 环境变量支持 + `process.execPath + '-spawn-helper'` 探测。原逻辑只从 `native.dir + '/spawn-helper'` 取。patch 使嵌入式运行时消费者（即把 node-pty 跑在 `Resources/node` 而非宿主 Node 的场景）能通过环境变量指定非 sibling 的 spawn-helper。
- **`lib/windowsPtyAgent.js`**：kill 后立即 `_conoutSocketWorker.dispose()` 开始 draining（修复 exited 进程无更多输出时的挂起）。

**corum 是否需要移植的判断**：
- corum 的 `node-pty` 在**宿主 Electron 进程**中运行（`packages/desktop/src/host/corum-terminal.ts:25` `import * as pty from 'node-pty'`），宿主 Node 自带 spawn-helper 解析能力；
- corum 不把 node-pty 跑在嵌入式 `Resources/node` 运行时中（嵌入式运行时是 host 桥的 runtime，不含 pty 终端逻辑）；
- `DSH_NODE_PTY_SPAWN_HELPER` 环境变量无人设置（grep 全仓零命中）。

**结论**：corum 当前架构下 node-pty patch **不是必需**——spawn-helper 路径解析走 prebuilds 原生逻辑即可。Windows kill drain 修复属行为改善，不影响 corum 现有功能。

**决策记录**：**不移植**。若未来 corum 将终端逻辑移入嵌入式运行时（acp 子进程隔离，阶段 5/6），需重新评估是否移植。阶段 4 实机验证时确认 macOS 终端 spawn 正常即可。

### 10.4 @yao-pkg/pkg

官方 rc3 有 `@yao-pkg/pkg@6.21.0` patch。corum 仅在**实际依赖**时处理——grep 全仓 `@yao-pkg/pkg`：

```bash
grep -rn '@yao-pkg/pkg' packages/ --include='*.json' --include='*.ts' | grep -v node_modules
```

若零命中，不处理（corum 不用 `@yao-pkg/pkg` 打包，走 electron-builder）。

---

## 11. 跨平台范围声明

- 本阶段（阶段 2）**仅在 macOS 执行**：override 重算、lock 重生成、skip-app 部署均在 macOS。
- **lock 在 macOS 生成保留全平台 optional 变体**：pnpm lockfile v9 把 `@img/sharp-*` 等全平台子包都记进锁，install 只按 `os`/`cpu` 物化匹配项——macOS install 不会把其它平台写坏进 lock。
- **Linux/Windows 的 install / native 重装 / pack / CDP 归阶段 4**，不宣称已覆盖。
- `assert-packaged-boot.mjs` 需完整 app/resources/node，移阶段 4，阶段 2 不要求。
