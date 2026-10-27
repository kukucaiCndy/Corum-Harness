# 阶段 1：被删/更名包处置执行手册

> 状态：评审修订版（2026-10-27 三方评审已并入）｜ 前置：阶段 -1（官方升级指南映射）已完成 ｜ 工程量：大（8 个处置对象 + 官方 preset 死键清理，涉及约 35 个文件改动点）
> **对象 ① 已完成**（2026-10-27，commit `fb4cb9fe`，分支 `upgrade/0.2.1-rc3`）：dsh-invariants 方案 A 已落地，4 包 build/typecheck/test 全绿（1282 测试 0 失败），drift 逐项身份恰为阶段 0 残留 2 项（sandbox-local/orchestrate），无新增。阶段 1 整体仍进行中（②~⑧+附 待执行）。

---

## 1. 目标与范围

本册解决 dsh 基座 0.1.5-rc.3 → 0.2.1-rc.3 升级中**最大的工程障碍**：corum fork 包依赖的官方包在 0.2.1 被删除、更名或 API 迁移，导致 `pnpm install` 闭包解析直接失败。

### 阶段 1 目标 = 依赖断链清零 + 配置硬错误清零

**阶段 1 不是可 boot 版本**。完整 preset 声明、动态 preset 发现（`~/.agent-presets`）、settings `agent-presets` 默认 preset 命名空间、corum 自有 activation/backgroundMode/persona/toolFilter 机制**全部留阶段 3**。阶段 4 前必须完成阶段 3。不做「只迁 standard」的半成品。

### 处置对象总览（8 个 + 官方 preset 死键清理）

| # | 被删/更名包/配置 | 0.2.1 去向 | 处置方式 | 官方 commit |
|---|---|---|---|---|
| ① | `dsh-invariants` | 删除（方案 A 跟随官方） | 删 src + dep + external + **tsdown entries** + 测试 + lib 残留 + 守卫 | `f028f25667`（PR #5517） |
| ② | `dsh-code-runtime` / `dsh-code-runtime-worker-thread` | 更名 `dsh-ptc-runtime` / `dsh-ptc-runtime-node` | 改 import + dep + **JSDoc `py-types.ts:5`** + UI 元数据 | `7c9bb5914c` / `f95f7ec8dc` |
| ③ | `dsh-subagent-in-process-driver` | 删除，驱动并入 dsh-subagent activation | 改 JSDoc 模块名注释 + dep；生成物不手改 | `3d852a1cea` → `390fbe8852` |
| ④ | `dsh-agent-presets` | 删除，registry 取代 | **type import 改 `dsh-agent-preset-registry`**（不是 `dsh-agent-preset`）；preset YAML 声明留阶段 3 | `d1e22a7e24`（PR #4569） |
| ⑤ | `dsh-session-title` | 包未删 | **corum 只版本跟随，无 provider 重写**（corum 零自定义 provider 调用） | — |
| ⑥ | `cordis-plugin-hmr` → `dsh-hmr` | HMR 继任包 | **确定动作**：desktop-host:53 dep + 两个 plugin-meta 改 `dsh-hmr`；override 全部留阶段 2 | 0.2.1 `base/cordis.patch.yml` |
| ⑦ | trustedHosts 死配置 | web-runtime 行删 `trustedHosts` | 删 `cordis.patch.yml:40` 的 `trustedHosts: []`，保留 openBrowser/printUrl/surfaceContext；更新 boot.ts 注释 | `web-listener-trust-config/guide.md` |
| ⑧ | `{{cwd}}` 未解析变量 | 官方删除 loop 内建注册 | 全量清除所有运行源/配置/测试断言中的 `{{cwd}}`；新 user context 机制若需阶段 3 则阶段 1 仅删变量引用并记录 | `working-directory/guide.md` |
| 附 | 官方 preset 行 backgroundMode 死键 | 官方 dsh-tool-subagent 移除 backgroundMode | **只删 disabled preset 行的 backgroundMode 死键，保留整行和 disabled:true**；corum 自有 compile.ts:100 及 schema/工具行为留阶段 3 | `subagent-activations/guide.md` |

### 范围边界

- **本册处理「包消失导致的断链」+「配置硬错误」**。override 表全部新增/删除/版本重算统一归阶段 2；阶段 1 **不改 `pnpm-workspace.yaml`**（包括 invariants 旧 override 也留到阶段 2清理）。`build/host` 和 `dist` 是生成物，不手改进 commit；阶段 2 重新 deploy/pack 消除。
- **`dsh-invariants` 方案 A 已定**（跟随官方删除，详见 §4.1），本册给出完整执行清单。
- **每个处置对象独立 commit**是回滚单元，不是编译验证单元（详见 §3.5 顺序说明）。

---

## 2. 前置条件（准入门禁）

| # | 门禁项 | 验证命令 | 通过标准 |
|---|---|---|---|
| 2.1 | 阶段 -1 已完成：43 篇官方升级指南已映射 | 检查「指南 → corum 影响映射表」产出物存在 | 文件存在且覆盖 `subagent-preset-composition`、`session-title-provider-strategy`、`remove-runtime-invariants` 三篇 |
| 2.2 | 当前工作区已 commit + push | `git status --porcelain` | 空输出 |
| 2.3 | home 完整备份 | `ls -d $HOME/corum-upgrade-backups/pre-0.2.1-rc3-*/` | 目录存在 |
| 2.4 | fork-drift 守卫基线已建立 | `DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 TMPDIR="$PWD/.corum-tmp" ./scripts/verify-fork-drift.sh` | 真实 tag 导出成功（无回落警告）+ 失败项逐项身份已归档（阶段 0 记录的基线 N=3 项，不宣称 0/23/24，逐项身份必须恰为 sandbox-local/orchestrate/ui-verify） |
| 2.5 | 官方 checkout 的 `dsh-v0.2.1-rc.3` tag 存在 | `git -C /Users/kukucai/dsh for-each-ref refs/tags/dsh-v0.2.1-rc.3` | 非空（tag 存在即可，**不得要求 checkout**；当前 dsh 工作树停在 rc.2，跨版本对比用 `git show <tag>:<path>` 即可） |

> **门禁失败则不得进入执行**。任一项不满足时，先完成前置再进阶段 1。

---

## 3. 输入与依赖

### 3.1 单一事实源

- `docs/UPGRADE-0.2.1-rc3-feasibility.md`（HEAD，含评审修订）—— §一、§三、§三·0、§三·1、§四、§七。

### 3.2 三方评审报告（含全部精确路径行号，2026-10-27）

- `~/.corum/research-reports/67850e39-0216-4a2b-90b8-f7589a8b7c58.md`——迁移步骤正确性评审（agent-presets 目标包指错、漏改点、执行顺序硬伤、`{{cwd}}`/webRuntime 未接住）。
- `~/.corum/research-reports/15af2cc0-cb56-4fbf-a906-7bd01ca2feb7.md`——invariants 与守卫评审（tsdown entries 漏删、lib 清理顺序、守卫 `:1174` 注释、根目录无 tsconfig、drift 身份清单）。
- `~/.corum/research-reports/b7c9a83b-3b60-4e7d-ad34-b2af07b15182.md`——组合与回归风险评审（`{{cwd}}`/trustedHosts/preset 机制断点、lockfile 归属、门禁收窄、册间矛盾）。

### 3.3 官方只读 checkout

- `/Users/kukucai/dsh` @ `dsh-v0.2.1-rc.3`，用 `git -C /Users/kukucai/dsh show <tag>:<path>` 取官方文件。

### 3.4 官方升级指南（本册直接引用）

- `docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md`——invariants 删除替代（emitter contain-and-log）。
- `docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.md`——agent-presets 迁移到 profile YAML。
- `docs/upgrade-guide/v0.2.1-alpha.1/session-title-provider-strategy/guide.md`——session-title-llm provider API 迁移。
- `docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.md`——trustedHosts 迁移（webRuntime→webStartup）。
- `docs/upgrade-guide/v0.2.1-alpha.1/working-directory/guide.md`——`{{cwd}}` 删除（unresolved 引用使 prompt 组装失败）。

### 3.5 执行顺序与验证单元

```
① dsh-invariants 方案 A（范围最清晰、可独立验证）
② dsh-code-runtime / dsh-code-runtime-worker-thread 更名
③ dsh-subagent-in-process-driver 删除
④ dsh-agent-presets → registry 类型重定向
⑤ dsh-session-title 版本跟随
⑥ dsh-hmr dep + plugin-meta 替换
⑦ trustedHosts 死配置清除
⑧ {{cwd}} 全量清除
附 官方 preset 行 backgroundMode 死键删除
```

> **验证单元 ≠ 编译单元**。①可在旧 0.1.5 依赖下独立构建/测试/真实 tag drift 验证；其余对象每步只做静态 grep 断链清点，全部 manifest 改完后**一次** `pnpm install`（⑧ 完成后）。阶段 1 install 只验解析，lockfile 验后恢复，**不提交 lock**；阶段 1 不做 deploy/pack。混合依赖树的 typecheck/test 结果如实记录，阶段 1 **不得宣称全仓绿或可 boot**。
>
> 阶段 1 从 main 拉 `upgrade/0.2.1-rc3` 分支，main 保持可用；各对象独立 commit 是回滚单元，不是编译验证单元。

---

## 3.6 已知阶段 1 不可 boot 项台账

> 阶段 1 结束的树是**装得上、起不来**的——以下项必须在阶段 3 处置，阶段 1 不得宣称可用。防止冒称完成。

| # | 不可 boot 项 | 根因 | 处置阶段 |
|---|---|---|---|
| 1 | preset 目录扫描（`~/.agent-presets/<id>/agent.cordis.yml` 运行期发现+挂载） | 0.2.1 registry 不扫描目录、不接受 preset 路径；定义只能来自 bundle patch 的 `dsh-agent-preset` 行 | 阶段 3（preset 完整迁移专项） |
| 2 | settings `agent-presets` 默认 preset 失效 | 0.2.1 registry 不再读 settings 命名空间 `agent-presets`（老包 `SETTINGS_NAMESPACE='agent-presets'`，新包走自身 `Config.default`/`selectedDefault`）；corum-agent `agent-service.ts:1731,1756` 读 `settings.get('agent-presets').default` 会静默拿不到值 | 阶段 3 |
| 3 | corum 自有 activation/backgroundMode/persona/toolFilter 机制 | corum-subagent 以禁官方 subagent 服务行 + insert 完整 fork 服务取代官方 seam；startContinuable 在 corum fork 内自有实现；corum-tool-subagent zod schema 含 backgroundMode/persona/toolFilter | 阶段 3（与 corum-subagent rebase 同批） |
| 4 | `{{cwd}}` 清除后的新 user context 机制 | 官方 0.2.1 删除 loop 内建 `{{cwd}}` 注册，改用 `session/working-directory` 新包的新 user context 机制；若新机制需阶段 3 接入，阶段 1 仅删除变量引用并记录 | 阶段 3（如需） |
| 5 | corum 完整 preset YAML 声明（standard/ptc/cordis/conductor/minimal） | compile.ts → shipped yml 生成链需专项定位；registry `default: standard` 指向缺失定义时 bind 失败 | 阶段 3（preset 迁移专项） |
| 6 | dsh-agent-preset 声明包 | corum 真要「用 YAML 声明 preset」时才需要加此包依赖；阶段 1 只做 registry 类型重定向 | 阶段 3（如需） |

> **纪律**：阶段 1 验收必须显式标注以上各项「阶段 3 处置，阶段 1 不宣称可用」。验收写「完成」而不标注此台账 = 说谎。

---

## 4. 执行步骤（命令级 + 每步验证）

### 4.1 处置对象 ①：dsh-invariants 方案 A（跟随官方删除）

> 决策：跟随官方 0.2.0-rc.2 删除 `dsh-invariants`，corum 不自留类型、不补能力。
> 安全依据：corum 组合零挂载（仅 `packages/desktop/cordis.patch.yml:401` 注释）、官方 base/web-app 不挂、Loader（cordis-plugin-loader@1.0.3）无子路径自动 discover、无动态 require、官方替代 = emitter contain-and-log。

#### 步骤 ①-1：4 个 fork 包各删 `src/invariant.ts`

对以下 4 个包执行：

```
packages/plugins/agent/corum-goal-round-driver/src/invariant.ts
packages/plugins/agent/corum-tool-subagent/src/invariant.ts
packages/plugins/agent/corum-subagent/src/invariant.ts
packages/plugins/agent/corum-tools/src/invariant.ts
```

命令：
```bash
rm packages/plugins/agent/corum-goal-round-driver/src/invariant.ts
rm packages/plugins/agent/corum-tool-subagent/src/invariant.ts
rm packages/plugins/agent/corum-subagent/src/invariant.ts
rm packages/plugins/agent/corum-tools/src/invariant.ts
```

验证：`find packages/plugins/agent -name "invariant.ts" -path "*/src/*"` 零命中。

#### 步骤 ①-2：4 个 fork 包的 `package.json` 删 dep + `"./invariant"` 子路径导出

每个包的 `package.json` 执行：

| 包 | dep 行 | 子路径导出行 |
|---|---|---|
| `corum-goal-round-driver` | `:28` `"@deepseek-ai/dsh-invariants": "^0.1.5-rc.3"` | `:10` `"./invariant": { ... }` |
| `corum-tool-subagent` | `:34` `"@deepseek-ai/dsh-invariants": "^0.1.5-rc.3"` | `:12` `"./invariant": { ... }` |
| `corum-subagent` | `:47` `"@deepseek-ai/dsh-invariants": "^0.1.5-rc.3"` | `:23` `"./invariant": { ... }` |
| `corum-tools` | `:36` dep + `:52` devDep `"@deepseek-ai/dsh-invariants": "^0.1.5-rc.3"` | `:12` `"./invariant": { ... }` |

操作：删除 `dependencies`（及 `devDependencies`）中的 `@deepseek-ai/dsh-invariants` 行；删除 `exports` 中的 `"./invariant"` 子路径条目。

验证：`grep -r "dsh-invariants" packages/plugins/agent/corum-{goal-round-driver,tool-subagent,subagent,tools}/package.json` 零命中。

#### 步骤 ①-3：4 个 fork 包的 `tsdown.config.ts` 删 external + **删 entries 里的 invariant 入口** + 注释同步

> **必须删 entries**（评审修-1）：只删 external 不够——`clean:false` 下旧 `lib/types/invariant.js` 还在，tsdown 仍会按 entries 把陈旧产物打成 `lib/invariant.js` 宿主入口，死代码复活进打包闭包。

| 包 | external 行 | entries 行（invariant 入口） | 注释行 |
|---|---|---|---|
| `corum-goal-round-driver` | `:15` external 数组含 `'@deepseek-ai/dsh-invariants'` | `:14` entries 数组含 `'lib/types/invariant.js'` | — |
| `corum-tool-subagent` | `:16` external 数组含 `'@deepseek-ai/dsh-invariants'` | `:15` entries 数组含 `'lib/types/invariant.js'` | `:3` 头注释 `lib/types/invariant.js（invariants 伴侣）` |
| `corum-subagent` | `:14` external 数组含 `'@deepseek-ai/dsh-invariants'` | `:13` entries 数组含 `'lib/types/invariant.js'` | `:5` 头注释 `lib/types/invariant.js（invariants 伴侣）` |
| `corum-tools` | `:12` external 数组含 `'@deepseek-ai/dsh-invariants'` | `:8` entries 对象含 `invariant: 'lib/types/invariant.js'`（**对象形态**） | — |

操作：
1. 从 external 数组中删除 `'@deepseek-ai/dsh-invariants'` 字符串。
2. **从 entries 中删除 invariant 入口**（数组形态删 `'lib/types/invariant.js'` 字符串项；对象形态删 `invariant: 'lib/types/invariant.js'` 键值对）。
3. 两处 tsdown 头注释（`corum-tool-subagent:3`、`corum-subagent:5`）中 `lib/types/invariant.js（invariants 伴侣）` 字样同步删除/改。

验证：`grep -r "invariant" packages/plugins/agent/corum-{goal-round-driver,tool-subagent,subagent,tools}/tsdown.config.ts` 零命中。

#### 步骤 ①-4：测试文件处理

| 文件 | 操作 | 行号 |
|---|---|---|
| `corum-subagent/tests/invariant.spec.ts` | **整文件删除** | `:11` `import * as SubagentInvariant from '../src/invariant.ts'`、`:12` `import InvariantRegistry from '@deepseek-ai/dsh-invariants'`、`:21-22` 挂载行 |
| `corum-tools/tests/invariant.spec.ts` | **整文件删除** | `:7` `import * as ToolsInvariant from '@deepseek-ai/dsh-tools/invariant'`（官方子路径同样被删）、`:8` `import InvariantRegistry from '@deepseek-ai/dsh-invariants'`、`:237` 唯一抛错断言 |
| `corum-subagent/tests/continuation.spec.ts` | **删 import + 挂载行** | `:17` `import InvariantRegistry from '@deepseek-ai/dsh-invariants'`、`:24` `import * as SubagentInvariant from '../src/invariant.ts'`、`:723-724` 挂载行 `await ctx.plugin(InvariantRegistry)` + `await ctx.plugin(SubagentInvariant)` |

> 注意 `corum-tools/tests/invariant.spec.ts:7` 还 import 官方子路径 `'@deepseek-ai/dsh-tools/invariant'`——官方 0.2.1 也删了它，整文件删除可覆盖。`corum-subagent/tests/continuation.spec.ts` 的 `:723-724` 挂载行只挂载不断言（InvariantRegistry/SubagentInvariant 无抛错断言依赖），删挂载行不影响该 spec 其余用例。

命令：
```bash
rm packages/plugins/agent/corum-subagent/tests/invariant.spec.ts
rm packages/plugins/agent/corum-tools/tests/invariant.spec.ts
```

对 `continuation.spec.ts`：用编辑器删除 `:17`、`:24`、`:723-724` 四行。

验证：
```bash
grep -rn "dsh-invariants\|InvariantRegistry\|SubagentInvariant\|ToolsInvariant\|dsh-tools/invariant" packages/plugins/agent/corum-subagent/tests/ packages/plugins/agent/corum-tools/tests/ packages/plugins/agent/corum-goal-round-driver/tests/ packages/plugins/agent/corum-tool-subagent/tests/
```
零命中（间接命中如 `pending-delegation.spec.ts:78` 注释、`ptc.spec.ts:739` 注释 "the invariant under test" 不属 invariants 包，不需处理）。

#### 步骤 ①-5：desktop-host 删 dep（仅跟踪源；build/host 生成物与 pnpm-workspace override 留阶段 2）

| 文件 | 行号 | 内容 | 操作 |
|---|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:86` | `"@deepseek-ai/dsh-invariants": "0.1.5-rc.3"` dependency | **删除**（唯一跟踪源） |
| `packages/desktop/build/host/package.json` | `:114` | `"@deepseek-ai/dsh-invariants": "0.1.5-rc.3"` dependency | **不改**（生成物，`.gitignore:3 build/` 忽略，不在 git 跟踪内；阶段 2 重新 deploy 消除） |
| `pnpm-workspace.yaml` | `:155` | `'@deepseek-ai/dsh-invariants': '0.1.5-rc.3'` override | **不改**（§1 范围边界：阶段 1 不改 pnpm-workspace.yaml；override 及 `minimumReleaseAgeExclude` 历史 ignore 行全部留阶段 2） |

操作：只删 `packages/desktop/desktop-host/package.json` 的 `@deepseek-ai/dsh-invariants` dependency 行。`build/host/package.json` 是 `pnpm deploy --legacy` 的生成物，不手改进 commit（阶段 2 重 deploy 自动消除）。`pnpm-workspace.yaml` 的 override 行 `:155` 及 `:397`（`dsh-invariants@0.1.1-rc.2`）/`:587`（`dsh-invariants@0.1.3-alpha.1`）历史 ignore 段全部留阶段 2。

验证：`grep -n "dsh-invariants" packages/desktop/desktop-host/package.json` 零命中即可。`build/host/package.json` 与 `pnpm-workspace.yaml` 不在本对象验证范围内（阶段 2 处理）。

#### 步骤 ①-6：删 `packages/desktop/cordis.patch.yml:401` 注释

```
# invariant 不挂（官方组合未挂 subagent-invariant，fork 对齐同纪律）。
```

操作：删除该行注释（避免遗留误导）。

验证：`grep -in "invariant" packages/desktop/cordis.patch.yml` 零命中。

#### 步骤 ①-7：改 `scripts/verify-fork-drift.sh`

| 行号 | 当前内容 | 操作 |
|---|---|---|
| `:1129` | 逐字节对比循环清单含 `invariant.ts` | 从循环清单中删除 `invariant.ts` |
| `:1180` | `SUBAGENT_DELTA_FILES` 变量含 `invariant.ts` | 从变量值中删除 `invariant.ts` |
| `:1174` | 注释 `# 允许有差异的文件（围绕 cwd 透传；invariant 是模板改名）…` | 同步修改/删除注释中 `invariant 是模板改名` 字样 |

> 不改则守卫误报：升级后双方文件都没了，`cmp -s` 对缺失文件 fail ⇒ 守卫报「与官方有差异」。`:1174` 注释虽不含 `invariant.ts` 字面（grep `"invariant.ts"` 不命中），但按注释清理纪律应一并改掉，避免误导后续 rebase。

验证：`grep -n "invariant" scripts/verify-fork-drift.sh` 零命中（含 `:1174` 注释）。

> **commit 纪律**：①-7（改守卫）与 ①-1~①-8（删文件）必须进同一个 commit（①-9）。不要在删除中途跑守卫（中间态无判据意义）。commit 后立即跑 0.1.5 基线守卫做阶段内验证。

#### 步骤 ①-8：先清 lib 残留，再 build（顺序重要）

> **关键**：`@corum/plugin-build` 硬编码 `clean: false`（`lib/index.js:54` hostConfig、`:69` clientConfig），tsdown 不自动清理 outDir。4 包的 `lib/invariant.js` + `lib/types/invariant.{js,d.ts,js.map}` 已存在且已进入打包闭包（`build/host/node_modules/@corum/corum-subagent/lib/invariant.js`）。
> **顺序必须先 rm 再 build**（评审修-3）：若先 build 再 rm，构建期会把陈旧 `lib/types/invariant.js` 重新打成 `lib/invariant.js` 宿主入口——即使随后 rm，也属于「生成物来自已删源」的不一致窗口。

命令（4 包各执行，**先 rm 再 build**）：
```bash
for pkg in corum-goal-round-driver corum-tool-subagent corum-subagent corum-tools; do
  rm -f "packages/plugins/agent/$pkg/lib/invariant.js"
  rm -f "packages/plugins/agent/$pkg/lib/types/invariant.js"
  rm -f "packages/plugins/agent/$pkg/lib/types/invariant.d.ts"
  rm -f "packages/plugins/agent/$pkg/lib/types/invariant.js.map"
  pnpm --filter "@corum/$pkg" run build
done
```

> `build/host` 闭包侧的 invariant 残留（含 `lib/types/invariant.js` + map）仅清残留/后续重 deploy，**不改生成 package.json**（`build/host/package.json:114` 不在 git 跟踪内，`.gitignore:3 build/`；`dist/win-unpacked/resources/host/package.json:113` 同为 `dist/` 忽略——下次 `pnpm pack` 重建自动消除）。rm 闭包残留是清现场，根治手段是阶段 2 重 deploy。

同步清理闭包残留（含 types 下）：
```bash
find packages/desktop/build/host/node_modules/@corum -name 'invariant*' -delete 2>/dev/null
```

验证：
```bash
find packages/plugins/agent -name "invariant.js" -o -name "invariant.d.ts" -o -name "invariant.js.map" 2>/dev/null
find packages/desktop/build/host/node_modules/@corum -name "invariant*" 2>/dev/null
```
均零命中。

#### 步骤 ①-9：提交（独立 commit）

```bash
git add -f packages/plugins/agent/corum-goal-round-driver/
git add -f packages/plugins/agent/corum-tool-subagent/
git add -f packages/plugins/agent/corum-subagent/
git add -f packages/plugins/agent/corum-tools/
git add packages/desktop/desktop-host/package.json packages/desktop/cordis.patch.yml scripts/verify-fork-drift.sh
git commit -m "upgrade(0.2.1-rc3): 删除 dsh-invariants（方案 A 跟随官方）"
```

> **不含** `build/host/package.json`（`.gitignore:3 build/` 忽略，不在 git 跟踪内，`git add` 无意义）。
> **不含** `pnpm-workspace.yaml`（override 留阶段 2，阶段 1 不改）。

#### 步骤 ①-10：①验证（旧 0.1.5 基线独立可验证）

> ①可在旧 0.1.5 依赖下独立构建/测试/真实 tag drift 验证（0.1.5-rc.3 官方包仍提供 `dsh-invariants` 与 `dsh-tools/invariant`，删除是「向前瞻」动作不破坏现有解析）。

```bash
# 1. 4 包 build
for pkg in corum-goal-round-driver corum-tool-subagent corum-subagent corum-tools; do
  pnpm --filter "@corum/$pkg" run build
done

# 2. 强制 typecheck（逐包 --force，清掉 tsbuildinfo 增量缓存）
for pkg in corum-goal-round-driver corum-tool-subagent corum-subagent corum-tools; do
  (cd "packages/plugins/agent/$pkg" && npx tsc -b --force)
  # spec 项目按各包实际有则跑：
  [ -f "packages/plugins/agent/$pkg/tsconfig.spec.json" ] && \
    (cd "packages/plugins/agent/$pkg" && npx tsc -p tsconfig.spec.json --force --noEmit)
done

# 3. 相关包测试
pnpm --filter @corum/corum-subagent run test
pnpm --filter @corum/corum-tools run test

# 4. 真实 tag drift 验证（0.1.5 基线）
TMPDIR="$PWD/.corum-tmp" \
DSH_CHECKOUT=/Users/kukucai/dsh \
DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 \
./scripts/verify-fork-drift.sh
```

**drift 逐项身份判据**（不只看 N）：
1. 失败**恰为**阶段 0 三项（文本逐一对照 `.corum-tmp/stage0-fork-drift-baseline.log` 的 `✗` 行）：sandbox-local/orchestrate/ui-verify。
2. `[16b]`、`[16]` 两个分节**零新增 ✗**（特别确认无「fork #9 缺官方文件 src/invariant.ts」、无 corum-tools invariant 相关项）。
3. 日志头部 `[baseline] 官方基线 = dsh-v0.1.5-rc.3` 存在、无「回落到检出工作区」。

> 测试数下降 27（14+13）属预期（两个 invariant.spec 整删）。只看 N=3 有一致性风险（理论上一项消失+一项新增时 N 不变），必须比对身份。

---

### 4.2 处置对象 ②：dsh-code-runtime → dsh-ptc-runtime + dsh-code-runtime-worker-thread → dsh-ptc-runtime-node

> 官方 commit `7c9bb5914c refactor(ptc): align runtime packages and services with PTC naming`；配套 `f95f7ec8dc refactor(code-runtime): name the Node runtime provider` 先改 code-runtime-node。
> 0.2.1 终名：`@deepseek-ai/dsh-ptc-runtime`（`packages/ptc-runtime/ptc-runtime/package.json`）+ `@deepseek-ai/dsh-ptc-runtime-node`（`packages/ptc-runtime/ptc-runtime-node/package.json`）。

#### 步骤 ②-1：corum-tools 改 import + dep + external + 报错文案 + **JSDoc**

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/agent/corum-tools/src/index.ts` | `:17` | `import type { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'` | `import type { CodeRuntime } from '@deepseek-ai/dsh-ptc-runtime'` |
| `packages/plugins/agent/corum-tools/src/index.ts` | `:41` | 注释中 `dsh-code-runtime` | `dsh-ptc-runtime`（注释文字） |
| `packages/plugins/agent/corum-tools/src/index.ts` | `:1038` | 报错文案 `@deepseek-ai/dsh-code-runtime-worker-thread` | `@deepseek-ai/dsh-ptc-runtime-node` |
| `packages/plugins/agent/corum-tools/src/py-types.ts` | `:5` | JSDoc `{@link @deepseek-ai/dsh-code-runtime#CodeRuntime.language}` | `{@link @deepseek-ai/dsh-ptc-runtime#PtcRuntime.language}` |
| `packages/plugins/agent/corum-tools/src/ptc.ts` | `:12` | `import type { CodeBindingFunction, CodeRunResult, CodeRuntime } from '@deepseek-ai/dsh-code-runtime'` | `from '@deepseek-ai/dsh-ptc-runtime'` |
| `packages/plugins/agent/corum-tools/tests/ptc.spec.ts` | `:7` | `import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'` | `from '@deepseek-ai/dsh-ptc-runtime'` |
| `packages/plugins/agent/corum-tools/tests/ptc.spec.ts` | `:8` | `import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'` | `from '@deepseek-ai/dsh-ptc-runtime'` |
| `packages/plugins/agent/corum-tools/package.json` | `:35` | peerDep `"@deepseek-ai/dsh-code-runtime": "^0.1.5-rc.3"` | `"@deepseek-ai/dsh-ptc-runtime": "^0.2.1-rc.3"` |
| `packages/plugins/agent/corum-tools/package.json` | `:51` | devDep `"@deepseek-ai/dsh-code-runtime": "^0.1.5-rc.3"` | `"@deepseek-ai/dsh-ptc-runtime": "^0.2.1-rc.3"` |
| `packages/plugins/agent/corum-tools/tsdown.config.ts` | `:12` | external 含 `'@deepseek-ai/dsh-code-runtime'` | 改为 `'@deepseek-ai/dsh-ptc-runtime'` |

> **`py-types.ts:5` 必须改**（评审 M3）：JSDoc `@link` 含旧包名 `dsh-code-runtime#CodeRuntime.language`，官方 0.2.1 同文件已改 `dsh-ptc-runtime#PtcRuntime.language`；不改会击穿本册退出门禁的 `grep "dsh-code-runtime"` 全仓 `.ts` 检查。

验证：
```bash
grep -rn "dsh-code-runtime" packages/plugins/agent/corum-tools/src/ packages/plugins/agent/corum-tools/tests/ packages/plugins/agent/corum-tools/package.json packages/plugins/agent/corum-tools/tsdown.config.ts
```
零命中（全部已改为 `dsh-ptc-runtime` / `dsh-ptc-runtime-node`）。

#### 步骤 ②-2：desktop-host 改 dep

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:75` | `"@deepseek-ai/dsh-code-runtime": "0.1.5-rc.3"` | `"@deepseek-ai/dsh-ptc-runtime": "0.2.1-rc.3"` |

> `build/host/package.json:103` 为生成物（`.gitignore:3 build/`），不手改进 commit；阶段 2 重新 deploy/pack 消除。

#### 步骤 ②-3：UI 元数据改 worker-thread → ptc-runtime-node

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/ui/corum-ide-ui/src/client/settings/plugin-meta.ts` | `:124` | `'@deepseek-ai/dsh-code-runtime-worker-thread': { zhName: '代码运行时', ... }` | 键名改为 `'@deepseek-ai/dsh-ptc-runtime-node'`（zhName/zhDesc 不变） |
| `packages/plugins/ui/corum-ide-plugin-manager-ui/src/client/plugin-meta.ts` | `:119` | 同上 | 同上 |

> 注意：UI 元数据含 lib 产物拷贝，改名后需重编译两个 UI 包（三步：`tsc -b && tsdown && node scripts/inline-css.mjs`），使 lib 产物中的键名同步更新。

#### 步骤 ②-4：override 改名（**留阶段 2**）

> `pnpm-workspace.yaml` 的 override 改名（`:117`/`:118`）统一归阶段 2；阶段 1 **不改 `pnpm-workspace.yaml`**。历史 ignore 段（`:367`/`:368`/`:557`/`:558`）同样留阶段 2。

#### 步骤 ②-5：重编译 + 验证

```bash
pnpm --filter @corum/corum-tools run build
pnpm --filter @corum/corum-ide-ui run build
pnpm --filter @corum/corum-ide-plugin-manager-ui run build
```

验证（排除 docs/lib/dist/node_modules）：
```bash
grep -rn "dsh-code-runtime" packages/ --include="*.ts" --include="*.json" | grep -v "node_modules" | grep -v "minimumReleaseAgeExclude" | grep -v "docs/"
```
零命中（仅允许 `pnpm-workspace.yaml` 历史 ignore 段残留）。

#### 步骤 ②-6：提交

```bash
git add -f packages/plugins/agent/corum-tools/ packages/plugins/ui/corum-ide-ui/ packages/plugins/ui/corum-ide-plugin-manager-ui/
git add packages/desktop/desktop-host/package.json
git commit -m "upgrade(0.2.1-rc3): dsh-code-runtime → dsh-ptc-runtime 更名"
```

> **不含** `build/host/package.json`（`.gitignore` 忽略）、`pnpm-workspace.yaml`（override 留阶段 2）。

---

### 4.3 处置对象 ③：dsh-subagent-in-process-driver 删除

> 官方 commit `3d852a1cea refactor(subagent): unify local and external activation lifecycles`——驱动逻辑并入 `dsh-subagent` 本体的 activation 生命周期（`activation-driver.ts`，后折进 `activation.ts` 于 `390fbe8852`）；`spawn-in-process` 仅剩薄壳（0.2.1 上 `subagent-spawn-in-process/src/` 只剩 `index.ts`，deps 仅 schemastery）。
> corum 引用面 = JSDoc 模块名注释 + desktop-host dep；生成物不手改；override 留阶段 2。

#### 步骤 ③-1：corum-subagent JSDoc 模块名注释更新

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/agent/corum-subagent/src/driver/index.ts` | `:11` | `@module @deepseek-ai/dsh-subagent-in-process-driver` | `@module @deepseek-ai/dsh-subagent`（或删除该 JSDoc module 标注） |
| `packages/plugins/agent/corum-subagent/src/driver/structured.ts` | `:10` | `@module @deepseek-ai/dsh-subagent-in-process-driver/structured` | `@module @deepseek-ai/dsh-subagent/structured`（或删除） |

> 这些是 JSDoc `@module` 注释，不影响运行时但影响 lib 产物 `.d.ts` 的模块声明。驱动逻辑已在 corum-subagent 本体，注释应指向本体包名。

#### 步骤 ③-2：desktop-host 删 dep

| 文件 | 行号 | 当前 |
|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:114` | `"@deepseek-ai/dsh-subagent-in-process-driver": "0.1.5-rc.3"` |

操作：删除该 dependency。

> `build/host/package.json:142` 为生成物（`.gitignore` 忽略），不手改进 commit；阶段 2 重新 deploy 消除。

#### 步骤 ③-3：override 删除（**留阶段 2**）

> `pnpm-workspace.yaml:220` 的 override 删除统一归阶段 2；历史 ignore 段（`:450`/`:642`）同样留阶段 2。

#### 步骤 ③-4：验证（静态 grep）

```bash
grep -rn "dsh-subagent-in-process-driver" packages/ --include="*.ts" --include="*.json" | grep -v "node_modules" | grep -v "minimumReleaseAgeExclude" | grep -v "docs/"
```
零命中（仅 `pnpm-workspace.yaml` 历史 ignore 段允许残留）。

#### 步骤 ③-5：提交

```bash
git add -f packages/plugins/agent/corum-subagent/
git add packages/desktop/desktop-host/package.json
git commit -m "upgrade(0.2.1-rc3): 删除 dsh-subagent-in-process-driver 依赖"
```

> **不含** `build/host/package.json`（`.gitignore` 忽略）、`pnpm-workspace.yaml`（override 留阶段 2）。

---

### 4.4 处置对象 ④：dsh-agent-presets → registry 类型重定向

> 官方 commit `d1e22a7e24 feat(preset): declare Agent compositions in profile YAML (#4569)`——整目录 `packages/preset/agent-presets/` 为 D，移到新包 `preset/agent-preset`（`@deepseek-ai/dsh-agent-preset`）+ `preset/agent-preset-registry`（`@deepseek-ai/dsh-agent-preset-registry`）。
>
> **关键修正（评审 M1）**：`dsh-agent-preset` 与 `dsh-agent-preset-registry` 是**两个分工不同的包**：
> - `dsh-agent-preset` 只是「在普通 cordis 组合里声明一条 preset 行」的插件，**没有** roster/registry/remote 类型。
> - `dsh-agent-preset-registry` 才提供 `ctx.agentPresets` 服务合并（`declare module`），exports 含 `./types`、`./remote`、`./display`。
>
> corum 消费的是**服务**（`agent-service.ts:1004,1897,1942` 的 mount/select + preset-reload 的 recompose），故 type import / dep / external **全部改 `@deepseek-ai/dsh-agent-preset-registry`**，不是 `dsh-agent-preset`。`dsh-agent-preset` 声明包只有阶段 3 真要「用 YAML 声明 preset」时才需要加。
>
> **类型兼容性**：老 `AgentPresetRow` 带 `trust`/`authorable`，新版都删了——corum 未消费这些官方字段（corum-ui 的 trust 读取的是 corum 自己的 profile 类型），类型兼容。registry 仍支持 `mount(ctx, id?)` / `select(agent, id)` / `recompose(ctx, id)`，corum 消费面**无 API 断裂**。

#### 步骤 ④-1：corum-agent 改 type import + dep + external

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/agent/corum-agent/src/agent-service.ts` | `:49` | `import type {} from '@deepseek-ai/dsh-agent-presets'` | `import type {} from '@deepseek-ai/dsh-agent-preset-registry'` |
| `packages/plugins/agent/corum-agent/src/agent-service.ts` | `:378` | 注释 `官方 dsh-agent-presets 注册的会话级 preset 键` | 改为 `dsh-agent-preset-registry` |
| `packages/plugins/agent/corum-agent/src/preset-reload.ts` | `:37` | `import type {} from '@deepseek-ai/dsh-agent-presets'` | `import type {} from '@deepseek-ai/dsh-agent-preset-registry'` |
| `packages/plugins/agent/corum-agent/tsdown.config.ts` | `:24` | external 含 `'@deepseek-ai/dsh-agent-presets'` | 改为 `'@deepseek-ai/dsh-agent-preset-registry'`（**必须保留 external**，不得 inline——registry 是运行时宿主服务的类型来源，inline 进 fork 产物会重演模块表事故，红线 2） |
| `packages/plugins/agent/corum-agent/package.json` | `:44` | peerDep `"@deepseek-ai/dsh-agent-presets": "^0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-agent-preset-registry": "^0.2.1-rc.3"` |
| `packages/plugins/agent/corum-agent/package.json` | `:88` | devDep `"@deepseek-ai/dsh-agent-presets": "^0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-agent-preset-registry": "^0.2.1-rc.3"` |

> `import type {}` 空类型导入的唯一作用是让 `ctx.agentPresets` 服务合并生效（agent-service.ts:47 注释），必须指向提供合并的 registry 包。

#### 步骤 ④-2：corum-subagent 改 type import + external

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/agent/corum-subagent/src/child-agent.ts` | `:28` | `import type {} from '@deepseek-ai/dsh-agent-presets'` | `import type {} from '@deepseek-ai/dsh-agent-preset-registry'` |
| `packages/plugins/agent/corum-subagent/tsdown.config.ts` | `:14` | external 含 `'@deepseek-ai/dsh-agent-presets'` | 改为 `'@deepseek-ai/dsh-agent-preset-registry'`（**必须保留**，不得删/inline） |
| `packages/plugins/agent/corum-subagent/package.json` | `:44` | dep `"@deepseek-ai/dsh-agent-presets": "^0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-agent-preset-registry": "^0.2.1-rc.3"` |

#### 步骤 ④-3：corum-api-remotes 改 type import + **值导入** + dep

> **必须补三行**（评审 M2）：`src/index.ts:26` 是 type import，但 `src/client/index.ts:4` 是**值导入**（组进 remote 表），`:23`/`:52` 是 type export——真正的运行时断链。

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/agent/corum-api-remotes/src/index.ts` | `:26` | `import type {} from '@deepseek-ai/dsh-agent-presets/types'` | `import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'` |
| `packages/plugins/agent/corum-api-remotes/src/client/index.ts` | `:4` | `import agentPresetsRemote from '@deepseek-ai/dsh-agent-presets/remote'`（**值导入**） | `import agentPresetsRemote from '@deepseek-ai/dsh-agent-preset-registry/remote'` |
| `packages/plugins/agent/corum-api-remotes/src/client/index.ts` | `:23` | `export type {} from '@deepseek-ai/dsh-agent-presets/remote'` | `export type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'` |
| `packages/plugins/agent/corum-api-remotes/src/client/index.ts` | `:52` | `export type {} from '@deepseek-ai/dsh-agent-presets/types'` | `export type {} from '@deepseek-ai/dsh-agent-preset-registry/types'` |
| `packages/plugins/agent/corum-api-remotes/package.json` | `:44` | dep `"@deepseek-ai/dsh-agent-presets": "^0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-agent-preset-registry": "^0.2.1-rc.3"` |

> `corum-api-remotes/lib/client.js:5657-5673` 产物内字符串含 `dsh-agent-presets`，重编译后自动更新。

#### 步骤 ④-4：desktop-host 改 dep

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:60` | `"@deepseek-ai/dsh-agent-presets": "0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-agent-preset-registry": "0.2.1-rc.3"` |

> `build/host/package.json:88` 为生成物（`.gitignore` 忽略），不手改进 commit；阶段 2 重新 deploy 消除。

#### 步骤 ④-5：compile.ts 旧包名注释清理

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/agent/corum-agent/src/compile.ts` | `:75` | 注释 `dsh-agent-presets/presets/standard/agent.cordis.yml` | 清理/更新注释 |
| `packages/plugins/agent/corum-agent/src/compile.ts` | `:81` | 注释 `bump dsh-agent-presets 后…` | 清理/更新注释 |

> **必须改**（评审 M3）：注释含旧包名 `dsh-agent-presets`，会击穿退出门禁 grep `dsh-agent-presets` 检查。

#### 步骤 ④-6：override 改名（**留阶段 2**）

> `pnpm-workspace.yaml:54` 的 override 改名统一归阶段 2；历史 ignore 段（`:311`/`:495`）同样留阶段 2。

#### 步骤 ④-7：preset 声明迁移（**全部留阶段 3**）

> **删除原 ④-7 空操作指令**（评审 M5）：原步骤说「从 dsh-tool-subagent 的 profile patch 行移除 persona/toolFilter」——实测 corum 两份 patch 的 tool-subagent 行**没有** persona/toolFilter 配置（grep 零命中），此步对 corum 是空操作。
>
> **明确**：「preset YAML 声明、`~/.agent-presets` 动态发现、settings `agent-presets` 默认 preset」全部是阶段 3 专项，阶段 1 **不宣称可用**。registry 类型重定向后 preset 面的完整迁移（standard/ptc/cordis/conductor/minimal 的生成链）留阶段 3。`dsh-agent-preset` 声明包只有阶段 3 需要时再加。

#### 步骤 ④-8：验证（静态 grep）

```bash
# dsh-agent-presets 作为 corum 服务类型目标（应为 0）
grep -rn "dsh-agent-presets" packages/ --include="*.ts" --include="*.json" | grep -v "node_modules" | grep -v "minimumReleaseAgeExclude" | grep -v "docs/"
```
零命中（仅允许 `pnpm-workspace.yaml` 历史 ignore 段 + 阶段 3 preset 声明包说明文档残留）。

#### 步骤 ④-9：提交

```bash
git add -f packages/plugins/agent/corum-agent/ packages/plugins/agent/corum-subagent/ packages/plugins/agent/corum-api-remotes/
git add packages/desktop/desktop-host/package.json
git commit -m "upgrade(0.2.1-rc3): dsh-agent-presets → registry 类型重定向"
```

> **不含** `build/host/package.json`（`.gitignore` 忽略）、`pnpm-workspace.yaml`（override 留阶段 2）。

---

### 4.5 处置对象 ⑤：dsh-session-title 版本跟随（无 provider 重写）

> **包未删**：`@deepseek-ai/dsh-session-title` 在 0.2.1 仍存在（`packages/session/session-title/`），被官方多包依赖。
> **corum 无自定义 provider**（grep `registerSessionTitleLlmProvider`/`generateSessionTitleWithLlm` 全仓零命中），故**只版本跟随，无 provider 重写**——官方指南的 provider 重写对 corum 无消费面。
> `dsh-session-title-first-prompt-llm` 在 0.2.1 **仍存在**（`packages/session/session-title-first-prompt-llm/`，base bundle 行仍挂）⇒ 保留跟随，不删。

#### 步骤 ⑤-1：corum-agent 本体版本跟随（type import 不需改）

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/plugins/agent/corum-agent/src/agent-service.ts` | `:67` | `import type {} from '@deepseek-ai/dsh-session-title/types'` | **保留**（包未删，类型路径不变） |
| `packages/plugins/agent/corum-agent/package.json` | `:55` | dep `"@deepseek-ai/dsh-session-title": "^0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-session-title": "^0.2.1-rc.3"`（版本跟随） |
| `packages/plugins/agent/corum-agent/package.json` | `:99` | devDep `"@deepseek-ai/dsh-session-title": "^0.1.5-rc.3"` | 改为 `"^0.2.1-rc.3"` |

> corum-agent 本体只需版本号跟随，`import type {}` 是空类型导入，API 变化不影响。

#### 步骤 ⑤-2：desktop-host 改 -llm dep 版本

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:105` | `"@deepseek-ai/dsh-session-title-llm": "0.1.5-rc.3"` | 改为 `"0.2.1-rc.3"` |

> corum 无自定义 session-title provider 实现（映射已确认 grep 零命中），本对象仅版本跟随，无 provider 重写。
> `build/host/package.json:133` 为生成物（`.gitignore` 忽略），不手改进 commit；阶段 2 重新 deploy 消除。

#### 步骤 ⑤-3：UI 元数据版本跟随

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/plugins/ui/corum-ide-ui/src/client/settings/plugin-meta.ts` | `:47` | `'@deepseek-ai/dsh-session-title': { ... }` | **保留**（包未删） |
| `packages/plugins/ui/corum-ide-ui/src/client/settings/plugin-meta.ts` | `:48` | `'@deepseek-ai/dsh-session-title-first-prompt-llm': { ... }` | **保留**（0.2.1 仍存在） |
| `packages/plugins/ui/corum-ide-plugin-manager-ui/src/client/plugin-meta.ts` | `:42` | 同 `:47` | 保留 |
| `packages/plugins/ui/corum-ide-plugin-manager-ui/src/client/plugin-meta.ts` | `:43` | 同 `:48` | 保留 |

#### 步骤 ⑤-4：override 版本跟随（**留阶段 2**）

> `pnpm-workspace.yaml:197`/`:198`/`:199` 的 override 版本跟随统一归阶段 2；历史 ignore 段（`:432`/`:433`/`:434`/`:624`/`:625`/`:626`）同样留阶段 2。

#### 步骤 ⑤-5：验证（静态 grep）

```bash
# 旧 API（应为 0，corum 无自定义 provider）
grep -rn "registerSessionTitleLlmProvider\|generateSessionTitleWithLlm" packages/ --include="*.ts" | grep -v "node_modules" | grep -v "docs/"
```
零命中（corum 无自定义 provider 实现）。

#### 步骤 ⑤-6：提交

```bash
git add -f packages/plugins/agent/corum-agent/
git add packages/desktop/desktop-host/package.json
git commit -m "upgrade(0.2.1-rc3): dsh-session-title 版本跟随（无 provider 重写）"
```

> **不含** `build/host/package.json`（`.gitignore` 忽略）、`pnpm-workspace.yaml`（override 留阶段 2）。

---

### 4.6 处置对象 ⑥：HMR dep + plugin-meta 替换（确定动作）

> **阶段 -1 已实证裁决**（01 册 §开放问题）：`dsh-hmr` 是 `cordis-plugin-hmr` 的官方继任包，`hmr` 服务键/`baseDir`/`config`/`getLinked()`/`getOuterStack()`/`hmr/change`/`hmr/reload` 全部保留。corum 不通过 inject/ctx.get 引用 `hmr` 服务（grep 零命中 fork src），配置 schema 无影响。唯一影响 = 包名替换导致的 dep/override 解析问题。
> **override 全部留阶段 2**（包括 `dsh-hmr` 新钉、cordis/loader/group/include/timer/schemastery/cosmokit）。阶段 1 **不处理 vendor override**。

#### 步骤 ⑥-1：desktop-host hmr dep 替换

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:53` | `"@deepseek-ai/cordis-plugin-hmr": "^1.0.16"` | `"@deepseek-ai/dsh-hmr": "0.2.1-rc.3"` |

> 跟随官方 base bundle 行 name。不替换则 `dsh-hmr` 无法解析（override 没有覆盖它）。

#### 步骤 ⑥-2：plugin-meta 改包名

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/ui/corum-ide-ui/src/client/settings/plugin-meta.ts` | `:39` | `'@deepseek-ai/cordis-plugin-hmr': { zhName: '热更新', zhDesc: 'cordis 插件的模块热替换。' }` | 键名改为 `'@deepseek-ai/dsh-hmr'`（zhName/zhDesc 保留） |
| `packages/plugins/ui/corum-ide-plugin-manager-ui/src/client/plugin-meta.ts` | `:34` | 同上 | 同上 |

#### 步骤 ⑥-3：组合行处理

corum 的组合文件（`packages/desktop/cordis.patch.yml` + `profile/corum/cordis.patch.yml`）当前**无 hmr 行**（grep 零命中）——hmr 行来自官方 `base/cordis.patch.yml`，corum 不覆写。升级后官方 base bundle 的 hmr 行 name 改为 `dsh-hmr`，corum 的 patch 无需改。

`dsh-client-hmr`（`:73` override + `:327`/`:514` 历史 ignore）在 0.2.1 **仍存在**（`packages/client/hmr/`，web-app bundle 仍挂）⇒ corum override `:73` 与 plugin-meta **保留不动**。

#### 步骤 ⑥-4：override（**全部留阶段 2**）

> `pnpm-workspace.yaml:292` 的 `cordis-plugin-hmr` override 删除 + 新增 `dsh-hmr` override；vendor 齐升（cordis 4.0.2→4.0.5、loader 1.0.3→1.0.6、group 1.0.2→1.0.5、include 1.0.7→1.0.10、timer 1.1.4→1.1.7、schemastery 3.18.2→3.18.5、cosmokit→1.8.6）全部统一归阶段 2（详见 04 册 §4.4）。阶段 1 **不处理 vendor override**。

#### 步骤 ⑥-5：验证（静态 grep）

```bash
grep -rn "cordis-plugin-hmr" packages/ --include="*.ts" --include="*.json" | grep -v "node_modules" | grep -v "minimumReleaseAgeExclude" | grep -v "docs/"
```
零命中（仅允许 `pnpm-workspace.yaml` 历史 ignore 段残留——阶段 2 清理）。

#### 步骤 ⑥-6：提交

```bash
git add -f packages/plugins/ui/corum-ide-ui/ packages/plugins/ui/corum-ide-plugin-manager-ui/
git add packages/desktop/desktop-host/package.json
git commit -m "upgrade(0.2.1-rc3): HMR dep + plugin-meta 替换为 dsh-hmr"
```

> **不含** `pnpm-workspace.yaml`（override 全部留阶段 2）。

---

### 4.7 处置对象 ⑦：trustedHosts 死配置清除

> 官方 0.2.1 web-runtime 行 config 只剩 `openBrowser/printUrl/publicUrl/surfaceContext`，trustedHosts 移到 connection 行读 `ctx.webStartup.trustedHosts`（web-app/cordis.patch.yml 实测）。patch 整体替换 config，多余键属死配置或 schema 风险。
> corum 已 pin `127.0.0.1`（`cordis.patch.yml:25`），不触发通配 host 拒载；corum fork 源码**零处**消费 `ctx.webRuntime`（grep 实测零命中），inject 侧无需改。
> **不得改/删 disabled 行**——disabled 行有双重职责（红线 5）。

#### 步骤 ⑦-1：cordis.patch.yml 删 `trustedHosts: []`

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/desktop/cordis.patch.yml` | `:40` | `trustedHosts: []` | **删除该行**，完整保留 `openBrowser: false`/`printUrl: false`/`surfaceContext: true` |

> 官方指南原文：「A patch replaces the matched row's whole `config`, so restate that config completely」——删 `trustedHosts: []` 后保留三键即满足。无需补 `publicUrl`（corum 桌面态由 host 读 authenticatedUrl，printUrl:false 已覆盖 URL 行为）。

#### 步骤 ⑦-2：更新 boot.ts 注释

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/desktop/src/host/boot.ts` | `:524-530` | 注释链「web-startup → webserver → web-runtime → connection」+ 提及 `trustedHosts` | 更新注释：trustedHosts 已从 web-runtime 行移除（0.2.1 改读 `ctx.webStartup.trustedHosts`）；corum 提供空 cmdlineArgs 让 web-startup 解析其默认值（含 host/trustedHosts） |

#### 步骤 ⑦-3：验证

```bash
# web-runtime 行无 trustedHosts
grep -A5 'id: web-runtime' packages/desktop/cordis.patch.yml | grep 'trustedHosts'
# 预期：0 命中

# openBrowser/printUrl/surfaceContext 仍在
grep -A5 'id: web-runtime' packages/desktop/cordis.patch.yml | grep -E 'openBrowser|printUrl|surfaceContext'
# 预期：3 行命中
```

#### 步骤 ⑦-4：提交

```bash
git add packages/desktop/cordis.patch.yml packages/desktop/src/host/boot.ts
git commit -m "upgrade(0.2.1-rc3): 删除 web-runtime 行 trustedHosts 死配置"
```

---

### 4.8 处置对象 ⑧：`{{cwd}}` 全量清除

> 官方 0.2.1 删除了 agent-loop 内建的 `{{cwd}}` 变量注册（0.1.5 `agent-loop/src/index.ts:423` 有，0.2.1 同文件 grep 零命中）。官方指南明说 **unresolved `{{cwd}}` 在模型请求前直接 fail**（`working-directory/guide.md` Change 段）。这些不进其他 grep 门禁、也不挡 install——但阶段 1 结束的树是**装得上、起不来**。
> 替换语义按官方 working-directory：**不要简单换成硬编码路径**，应删除过时句子或改用新 user context 机制（若新机制需阶段 3，则阶段 1 仅删除变量引用并记录）。**以全仓 grep 为准**，不只这些点。

#### 步骤 ⑧-1：全量 grep 定位 `{{cwd}}`

```bash
# 全仓 grep（排除 docs/lib/dist/node_modules）
grep -rn '{{cwd}}' packages/ --include="*.yml" --include="*.ts" --include="*.json" --include="*.spec.ts" \
  | grep -v node_modules | grep -v '/lib/' | grep -v '/dist/' | grep -v 'docs/'
```

已知命中点（以 grep 为准，不只这些）：
- `packages/desktop/cordis.patch.yml:234`（system-prompt persona `Your working directory is {{cwd}}.`）
- `packages/plugins/agent/corum-agent/src/compile.ts:333,334,336,338,490`（5 处）
- `packages/plugins/agent/corum-subagent/src/child-roles.ts:116`
- `packages/desktop/shipped-presets/` 多份 yml（official/standard/ptc/cordis/conductor 的 `agent.cordis.yml`）
- `packages/plugins/agent/corum-subagent/tests/child-role-facts.spec.ts`（断言）

#### 步骤 ⑧-2：逐处清除

对 grep 输出的每处 `{{cwd}}`：
1. **删除过时句子**（如 cordis.patch.yml:234 的 `Your working directory is {{cwd}}.` 整句删除——新 user context 机制在阶段 3 接入后由官方 `session/working-directory` 新包提供）。
2. **或改用新 user context 机制**（若新机制不需阶段 3 rebase 即可用——但 registry 类型重定向后的 preset 面完整迁移留阶段 3，故阶段 1 仅删除变量引用并记录到台账 §3.6 #4）。
3. **同步更新测试断言**（如 `child-role-facts.spec.ts` 中引用 `{{cwd}}` 的断言行）。

> **纪律**：阶段 1 仅删除 `{{cwd}}` 变量引用 + 记录到「已知不可 boot 项」台账（§3.6 #4）。新 user context 机制的接入留阶段 3。

#### 步骤 ⑧-3：验证（退出门禁新增项）

```bash
# 全仓 {{cwd}} 零命中（排除 docs/lib/dist/node_modules）
grep -rn '{{cwd}}' packages/ --include="*.yml" --include="*.ts" --include="*.json" --include="*.spec.ts" \
  | grep -v node_modules | grep -v '/lib/' | grep -v '/dist/' | grep -v 'docs/'
# 预期：0 命中
```

#### 步骤 ⑧-4：提交

```bash
git add -f packages/desktop/cordis.patch.yml packages/desktop/src/host/boot.ts
git add -f packages/plugins/agent/corum-agent/ packages/plugins/agent/corum-subagent/
git add -f packages/desktop/shipped-presets/
git commit -m "upgrade(0.2.1-rc3): 清除 {{cwd}} 未解析变量引用"
```

---

### 4.9 处置对象（附）：官方 preset 行 backgroundMode 死键删除

> 官方指南：dsh-tool-subagent 移除 `backgroundMode`/`enableRunInBackground`。
> **关键纪律（红线 5）**：**只删 disabled preset 行的 backgroundMode 死键，保留整行和 `disabled: true`**。绝不删 disabled 行——disabled 行有双重职责（压制官方包 + 索引标记）。
> `compile.ts:100` 的 corum 自有 `corumSubagentConfig` backgroundMode 及 corum-tool-subagent schema/工具行为**全部留阶段 3**。

#### 步骤 附-1：compile.ts 官方 preset 行删 backgroundMode 死键

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/plugins/agent/corum-agent/src/compile.ts` | `:259` | tool-subagent-codex preset 行含 `backgroundMode: 'one-shot'` + `disabled: true` | **只删 `backgroundMode` 键，保留整行和 `disabled: true`** |
| `packages/plugins/agent/corum-agent/src/compile.ts` | `:265` | tool-subagent-claude-code preset 行含 `backgroundMode: 'one-shot'` + `disabled: true` | 同上 |
| `packages/plugins/agent/corum-agent/src/compile.ts` | `:271` | tool-subagent-fork preset 行含 `backgroundMode: 'continuable'` + `disabled: true` | 同上 |

> `compile.ts:100` 的 corum 自有 `corumSubagentConfig` backgroundMode **留阶段 3**（与 corum-tool-subagent schema/工具行为同批迁移）。

#### 步骤 附-2：shipped yml 对应行删 backgroundMode 死键

对 `packages/desktop/shipped-presets/official/{standard,ptc,cordis,conductor}/agent.cordis.yml` 中官方 `dsh-tool-subagent` 的 disabled preset 行：
- **只删 `backgroundMode` 死键，保留整行和 `disabled: true`**。

#### 步骤 附-3：验证

```bash
# compile.ts 官方行无 backgroundMode（corum 自有 :100 保留——阶段 3）
grep -n 'backgroundMode' packages/plugins/agent/corum-agent/src/compile.ts
# 预期：仅 :100 corum 自有键命中（:259/:265/:271 不再含 backgroundMode）
```

#### 步骤 附-4：提交

```bash
git add -f packages/plugins/agent/corum-agent/
git add -f packages/desktop/shipped-presets/
git commit -m "upgrade(0.2.1-rc3): 删官方 preset 行 backgroundMode 死键（留行留 disabled）"
```

---

## 5. 验收标准（退出门禁）

> **验证单元 ≠ 编译单元**。①单独可绿（旧 0.1.5 基线）；其余完成静态断链矩阵 + 一次 install 解析成功。install 警告和混合树类型错误记录，**不伪称全绿**。lockfile 恢复，commit 不含 lock。阶段 1 不做 deploy/pack。

| # | 门禁项 | 验证命令 | 通过标准 |
|---|---|---|---|
| 5.1 | ① 单独可绿（旧 0.1.5 基线） | 见步骤 ①-10 | 4 包 build/test + drift 逐项身份恰为阶段 0 三项（sandbox-local/orchestrate/ui-verify） |
| 5.2 | 静态断链矩阵全清 | 见下方 grep 矩阵 | 全部零命中 |
| 5.3 | 全仓 grep 旧包名零命中 | 见下方 grep 矩阵 | 仅允许 `pnpm-workspace.yaml` 历史 ignore 段（阶段 2 清理） |
| 5.4 | 一次 install 解析成功 | `pnpm install`（⑧完成后） | 0 `ERR_PNPM` error；peer 警告记录但不阻塞 |
| 5.5 | lockfile 恢复 | `git checkout -- pnpm-lock.yaml` | commit 不含 lock |
| 5.6 | 已知不可 boot 项台账显式标注 | 见 §3.6 | 验收记录中显式标注 6 项「阶段 3 处置」 |

> **5.4 注意**：阶段 1 结束时 override 表仍是 0.1.5 钉版，而新引入的 `dsh-ptc-runtime@0.2.1` / `dsh-agent-preset-registry@0.2.1` / `dsh-hmr` 会按各自 package.json 拉 0.2.1 的 peer——被旧 override 钉住的 peer 会赢过新包版本要求，产出官方从未测试过的混合闭包。`pnpm install` 可能 0 error（5.4 通过）但树已中毒。install 警告和混合树类型错误**如实记录**，不伪称全绿。阶段 1 **不得宣称全仓绿或可 boot**。

### grep 矩阵（退出门禁 5.2/5.3）

```bash
# ① dsh-invariants（全仓零命中，仅允许 minimumReleaseAgeExclude 历史段 + pnpm-workspace.yaml 阶段2残留）
grep -rn "dsh-invariants" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude | grep -v 'docs/'
# 预期：0 命中

# ② dsh-code-runtime / dsh-code-runtime-worker-thread（全仓零命中）
grep -rn "dsh-code-runtime" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude | grep -v 'docs/'
# 预期：0 命中

# ③ dsh-subagent-in-process-driver（全仓零命中）
grep -rn "dsh-subagent-in-process-driver" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude | grep -v 'docs/'
# 预期：0 命中

# ④ dsh-agent-presets（作为 corum 服务类型目标 = 0 命中；可保留阶段 3 声明包说明文档）
grep -rn "dsh-agent-presets" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude | grep -v 'docs/'
# 预期：0 命中

# ⑤ dsh-session-title 旧 API（全仓零命中）
grep -rn "registerSessionTitleLlmProvider\|generateSessionTitleWithLlm" packages/ --include="*.ts" | grep -v node_modules | grep -v 'docs/'
# 预期：0 命中

# ⑥ cordis-plugin-hmr（作为 dep/plugin-meta = 0 命中；pnpm-workspace.yaml override 留阶段 2）
grep -rn "cordis-plugin-hmr" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude | grep -v 'docs/'
# 预期：0 命中（desktop-host/package.json + 两个 plugin-meta 已改 dsh-hmr）

# ⑦ trustedHosts（web-runtime 行 = 0 命中）
grep -A5 'id: web-runtime' packages/desktop/cordis.patch.yml | grep 'trustedHosts'
# 预期：0 命中

# ⑧ {{cwd}}（全仓零命中，排除 docs/lib/dist/node_modules）
grep -rn '{{cwd}}' packages/ --include="*.yml" --include="*.ts" --include="*.json" --include="*.spec.ts" | grep -v node_modules | grep -v '/lib/' | grep -v '/dist/' | grep -v 'docs/'
# 预期：0 命中

# 附：invariant.ts 文件不存在
find packages/plugins -name "invariant.ts" -path "*/src/*" 2>/dev/null
# 预期：0 命中

# 附：lib/invariant* 残留
find packages/plugins/agent -name "invariant*" 2>/dev/null
find packages/desktop/build/host/node_modules/@corum -name "invariant*" 2>/dev/null
# 预期：0 命中
```

> 阶段 1 结束记录 rc.3 drift 信息性结果可选（**不以 N≤3 判**，改为逐项身份清单——06 册已修订）。

---

## 6. 风险与缓解

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 6.1 | `@corum/plugin-build` 硬编码 `clean: false`，删 src 后 `lib/invariant.js` + `lib/types/invariant.{js,d.ts,js.map}` 残留进闭包 | **高** | 步骤 ①-8 先 rm（含 .js.map）再 build + 清 `build/host/node_modules` 闭包残留 |
| 6.2 | `scripts/verify-fork-drift.sh` 自身引用 `invariant.ts`/`invariant` 注释，不改则守卫误报 | **高** | 步骤 ①-7 改 `:1129` 循环清单 + `:1180` `SUBAGENT_DELTA_FILES` + `:1174` 注释 |
| 6.3 | `corum-tools/tests/invariant.spec.ts:7` import 官方子路径 `@deepseek-ai/dsh-tools/invariant`（官方也删了），若只删 InvariantRegistry import 会漏 | **中** | 步骤 ①-4 整文件删除 `corum-tools/tests/invariant.spec.ts` |
| 6.4 | `corum-subagent/tests/continuation.spec.ts:723-724` 挂载行只挂载不断言，但删 import 后可能编译失败 | **中** | 步骤 ①-4 同步删 `:17`/`:24`/`:723-724` 四行，编译后验证 |
| 6.5 | ④ agent-presets 目标包指错（`dsh-agent-preset` vs `dsh-agent-preset-registry`） | **高** | 步骤 ④-1~④-4 全部改 `dsh-agent-preset-registry`（评审 M1 已修正） |
| 6.6 | 中间 commit 不可 install/编译，「每步重编译验证」在旧 0.1.5 基线上不成立 | **高** | 验证单元 = grep 断链清点（每步）+ 一次 install（全阶段）；①单独可绿（步骤 ①-10） |
| 6.7 | 混合依赖树（部分 0.1.5 部分 0.2.1）产出官方未测试闭包 | **高** | install 警告如实记录；阶段 1 不做 deploy/pack；override 全量重算归阶段 2 |
| 6.8 | `{{cwd}}` 清除后 prompt 组装失败（unresolved 变量 fail-fast） | **高** | 步骤 ⑧ 全量清除；新 user context 机制留阶段 3 并记台账 |
| 6.9 | disabled preset 行被误删（重演 #54 事故） | **高** | 步骤 附-1/附-2 只删 backgroundMode 死键，**保留整行和 disabled:true** |
| 6.10 | UI 包构建三步缺一不可（`tsc -b && tsdown && node scripts/inline-css.mjs`） | **中** | 步骤 ②-3 的 UI 包重编译必须三步全跑（`pnpm --filter … run build` 即满足） |
| 6.11 | desktop-host/package.json 多对象连改行号漂移 | 中 | 命令级行号以 grep 键名定位为主 |

---

## 7. 回滚方案

### 原则

- 每个处置对象独立 commit（**不含 pnpm-lock.yaml**），可逐个 `git revert <hash>`。
- ① dsh-invariants 删除单独一个 commit（步骤 ①-9），可独立 revert。
- 回滚后需同步恢复 `build/host/node_modules` 闭包（阶段 2 重新 `pnpm deploy --legacy`）。
- **lockfile 归属**：阶段 1 各对象 commit **不含** pnpm-lock.yaml；install 只作为解析性验证，验后 `git checkout -- pnpm-lock.yaml` 复位；lock 重生成整体归阶段 2。

### 回滚矩阵

| 处置对象 | commit message | revert 影响 |
|---|---|---|
| ① dsh-invariants | `upgrade(0.2.1-rc3): 删除 dsh-invariants（方案 A 跟随官方）` | 恢复 4 包 invariant.ts + dep + external + entries + 测试 + lib 产物 + 守卫 |
| ② code-runtime 更名 | `upgrade(0.2.1-rc3): dsh-code-runtime → dsh-ptc-runtime 更名` | 恢复旧包名 import + dep + JSDoc |
| ③ in-process-driver | `upgrade(0.2.1-rc3): 删除 dsh-subagent-in-process-driver 依赖` | 恢复 dep + JSDoc 注释 |
| ④ agent-presets | `upgrade(0.2.1-rc3): dsh-agent-presets → registry 类型重定向` | 恢复旧包名 import + dep |
| ⑤ session-title | `upgrade(0.2.1-rc3): dsh-session-title 版本跟随（无 provider 重写）` | 恢复旧版本号 |
| ⑥ hmr | `upgrade(0.2.1-rc3): HMR dep + plugin-meta 替换为 dsh-hmr` | 恢复旧 dep + plugin-meta |
| ⑦ trustedHosts | `upgrade(0.2.1-rc3): 删除 web-runtime 行 trustedHosts 死配置` | 恢复 `trustedHosts: []` 行 |
| ⑧ {{cwd}} | `upgrade(0.2.1-rc3): 清除 {{cwd}} 未解析变量引用` | 恢复 `{{cwd}}` 引用 |
| 附 backgroundMode | `upgrade(0.2.1-rc3): 删官方 preset 行 backgroundMode 死键（留行留 disabled）` | 恢复 backgroundMode 死键 |

### 回滚后验证

```bash
pnpm install  # 确认可解析（lockfile 已复位）
pnpm --filter @corum/corum-subagent run build  # 确认编译
```

---

## 8. 产出物与下游接口

### 本册产出

| 产出物 | 说明 |
|---|---|
| 8+1 个独立 commit（不含 lock） | 每个处置对象一个，消息格式 `upgrade(0.2.1-rc3): ...` |
| 修改的文件清单 | 见各步骤，总计约 35 个文件改动点 |
| 已知不可 boot 项台账 | §3.6，6 项显式标注「阶段 3 处置」 |

### 下游接口（本册完成后，阶段 2/3/4 的前置条件）

| 下游阶段 | 依赖本册的什么 | 接口判据 |
|---|---|---|
| 阶段 2（override 重算） | 本册已删除/改名的包的 dep/external/import 已清理；override 行留阶段 2 | `pnpm-workspace.yaml` override 全量重算（含 6 个被删包 + dsh-hmr 新钉 + vendor 齐升） |
| 阶段 2（override 重算） | `minimumReleaseAgeExclude` 历史段中 6 个包的条目需在阶段 2 清理 | 本册不动历史 ignore 段 |
| 阶段 3（fork rebase） | 4 个 fork 包已删 invariant.ts + tsdown entries；corum-subagent 已改 JSDoc；agent-presets 已改 registry 类型 | fork-drift 守卫 `:1129`/`:1180`/`:1174` 已同步改 |
| 阶段 3（preset 迁移专项） | preset YAML 声明、`~/.agent-presets` 动态发现、settings `agent-presets` 默认 preset | §3.6 台账 6 项 |
| 阶段 3（activation/backgroundMode/persona/toolFilter） | corum 自有 compile.ts:100 + corum-tool-subagent schema/工具行为 | §3.6 台账 #3 |
| 阶段 4（三层验证） | install 解析成功（混合树警告记录） | 本册退出门禁 5.4 |

---

## 9. 实录要求

### 执行实录格式

每个处置对象执行完毕后，在 `docs/UPGRADE-0.2.1-rc3.md`（升级总实录）中追记：

```
## 阶段 1 · 处置对象 ①：dsh-invariants 方案 A
- 执行时间：YYYY-MM-DD HH:MM
- 执行者：<agent session id>
- commit hash：<hash>
- 实际改动文件数：<N>
- 验证结果：
  - ① build/test（旧 0.1.5 基线）：✅/❌
  - drift 逐项身份：✅（恰为 sandbox-local/orchestrate/ui-verify）/❌
  - 静态 grep 断链：✅/❌
- 偏差记录：<与本册步骤的差异，若有>
- 遗留问题：<若有>
```

### 必须实录的偏差

如果执行中发现以下情况，必须立即停止并实录：
- 某个路径行号与实际不符（文件已被其他改动移动）。
- 某个处置对象的改动范围超出本册描述（发现了未列出的引用点）。
- `pnpm install` 报出本册未覆盖的 0.1.5 旧包名断链。
- `{{cwd}}` grep 发现超出已知命中点的新位置。

### 实录纪律

- 凡在对话里说过「要做/该修」的事必须落进实录（参考 `docs/PENDING-conductor-readonly-bash-and-progressive-research.md` 的教训）。
- 不许写与现场不符的承诺——实测状态与步骤描述不一致时，以实测为准并记录偏差。
- **混合依赖树的 typecheck/test 结果如实记录**，阶段 1 不得宣称全仓绿或可 boot。
