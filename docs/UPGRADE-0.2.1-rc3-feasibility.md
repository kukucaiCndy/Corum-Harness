# dsh 基座 0.1.5-rc.3 → 0.2.1-rc.3 升级可行性评估

> 起因：2026-10-26 用户卸载 corum-dev 扩展包时，热应用破坏了运行中的子 agent 会话
> （`cf58d502`，bash 工具命中 `ToolNotFoundError`）。根因是单进程架构下 Loader 重 init
> 会反注册工具。用户倾向方案 C（进程隔离），本评估确认 0.2.1-rc.3 是否已具备该能力。
>
> 评估时间：2026-10-26 22:40。基线 checkout：`/Users/kukucai/dsh/` @ `dsh-v0.2.1-rc.3`。
> corum 当前：基座 `0.1.5-rc.3` + cordis `4.0.2`，desktop app `0.7.0`，50 个 fork 包。
> （评审注：50 为目录树实数，packages/plugins 下 23 agent + 12 session + 15 ui；docs/fork-delta.md 台账仅登记到 17 个，落后 33 个，升级期间应同步补台账。）
>
> 评审记录：2026-10-27 由指挥模式三方独立核查完成（证据报告存于 ~/.corum/research-reports/：
> 原三份 `885858d9-…`、`5c35a73b-…`、`06867ebb-….md` 为后续所有阶段的基础证据；
> 新增三份 `e9de057a-…`（阶段 -1 指南清单/目录/文本量）、`abf2af7e-…`（阶段 -1 corum 触点/指南内容）、`958879cc-….md`（阶段 -1 可执行性/门禁/实录）。
> 评审结论：方向成立，方案 A 证据链全绿；发现 1 处事实错误（§三 session-title 行）、1 处张冠李戴（§2.1 tool-executor 行）、7 处高危遗漏（见 §三·0 与 §六 修订）。

---

## 一、总体结论

**可行，但工程量是历次升级之最**（远超 0.1.3→0.1.5 的 137 条 override）。三个数量级证据：

| 维度 | 0.1.3 → 0.1.5（上次） | 0.1.5 → 0.2.1（本次） |
|---|---|---|
| commit 数 | 约 200 | **6026** |
| 改动文件 | 约 300 | **12855** |
| 新增行 | 约 2 万 | **161 万** |
| override 条目 | 137 | 待重算（当前基线 217 条，官方包 278→362，预计落点 250-300 条） |
| 新增包组 | 少量 | **大量**（acp/subprocess/host/browser-use/computer-use/deliverables/document/...） |
| 删除包组 | 0 | **4 个 corum 在用（删除/重命名）+ 1 个更名 + 1 组 API 迁移** |

**核心障碍**：corum fork 包依赖的 **4 个官方包在 0.2.1 被删除/重命名**（另有 1 个 `dsh-code-runtime-worker-thread` 同步更名为 `dsh-ptc-runtime-node`）；`dsh-session-title` 未删，但伴生包 `-llm`/`-first-prompt-llm` 的 provider API 迁移。必须逐个找替代并改 fork 源码。这是历次升级首次遇到"依赖包消失"。

---

## 二、进程隔离能力确认（方案 C 的前置）

**结论：0.2.1-rc.3 已具备子 agent 进程隔离能力，但不具备顶层会话进程隔离。**

### 2.1 已具备（可直接用）

| 能力 | 包 | 自何时 | 作用 |
|---|---|---|---|
| Agent Client Protocol | `dsh-acp` | 0.1.0-rc.7 | JSON-RPC stdio 驱动持久化 agent |
| Out-of-process 子 agent | `dsh-subagent-acp` | 0.1.0 | 每次委派 spawn 独立子进程，独立 runtime/session/model/tools |
| Subprocess seam | `dsh-subprocess` + `dsh-subprocess-local` | 0.1.4 前 | 进程管理抽象，背景进程生命周期脱离 executor fiber |
| 跨进程会话写租约 | `SessionWriteLease` | 0.1.3-alpha.1 起（0.1.5-rc.3 已自带） | 内核级 flock/信号量，多进程操作同一会话的协调 |

> 评审更正（2026-10-27）：原表「工具执行器分离 dsh-tool-executor-native/-ptc 0.2.1（455686626d）」整行已删除——经核实 commit `455686626d` 不在 `dsh-v0.2.1-rc.3` 的祖先链上（`git merge-base --is-ancestor` 验证），只在 master；rc.3 上 `packages/core/` 无 tool-executor 目录。

**关键事实**：corum 当前用的 **0.1.5-rc.3 本身就包含 `dsh-subagent-acp`**（0.1.0 起就有），但 corum desktop **没装配它**——实际装的是 in-process 变体（`dsh-subagent-fork-in-process`/`dsh-subagent-spawn-in-process`）。Corum.app 的 host node_modules 里**没有 dsh-acp / dsh-subagent-acp**。

### 2.2 未具备（corum 需自研）

官方所有 bundle（web-app/desktop-host/headless/sdk-app/sdk-minimal）的**顶层用户会话都跑在主进程内**，没有一个把顶层会话改成走 acp 子进程。`.agents/notes/` 下无"顶层会话进程化"设计文档。

**对方案 C 的影响**：
- 子 agent 进程隔离：升级 0.2.1 后**装配 `dsh-subagent-acp`** 即可，工程量小。
- 顶层会话进程隔离：corum 需**自研 sidecar**，但可复用官方的 subprocess seam + SessionWriteLease + acp 协议。

---

## 三、5 个被删包的影响与替代（最大障碍）

corum fork 包依赖以下 5 个官方包，它们在 0.2.1 **不存在**：

| 被删包 | corum 引用点 | 去向（0.2.1 替代） | 修复方式 |
|---|---|---|---|
| `dsh-code-runtime` | `corum-tools`（peer + tests）+ UI 插件元数据 + `desktop-host/package.json:75`（真实 dep）+ `build/host/package.json:103` + `corum-tools/src/index.ts:1038` 报错文案内嵌包名 | 重命名为 `dsh-ptc-runtime`（`7c9bb5914c refactor(ptc): align runtime packages`）；配套 `dsh-code-runtime-worker-thread` 同步更名 `dsh-ptc-runtime-node`（`f95f7ec8dc` 先改 code-runtime-node） | 改 import + package.json dep |
| `dsh-agent-presets` | `corum-api-remotes`（dep）+ `corum-subagent`（external）+ UI 元数据 + `corum-agent`（`src/agent-service.ts:49`、`src/preset-reload.ts:37` type import + `tsdown.config.ts:24` external）+ `corum-subagent/src/child-agent.ts:28` + `desktop-host/package.json:60` dep | 改成 profile YAML 声明（`d1e22a7e24 feat(preset): declare Agent compositions in profile YAML`，PR #4569），移到 `preset/agent-preset` | 改 dep + 装配方式 |
| `dsh-invariants` | 4 个 fork 包（`corum-goal-round-driver`/`corum-tool-subagent`/`corum-subagent`/`corum-tools`）各有 `src/invariant.ts` + `./invariant` 子路径导出 + dep + external + `desktop-host/package.json:86` + `build/host/package.json:114` dep + `pnpm-workspace.yaml:155` override | **直接删除**（`#5517 turtle/remove-invariants`，commit `f028f25667`） | **方案 A：跟随官方删除**（详见 §三·1） |
| `dsh-session-title` | 包未删（0.2.1 上 `packages/session/session-title` 存在且被官方多包依赖）；真实迁移面是伴生包 `dsh-session-title-llm` 的 provider API 变化（`registerSessionTitleLlmProvider`/`generateSessionTitleWithLlm` 移除，改为 `ctx.sessionTitle.register()` + `executeSessionTitleLlm`，官方指南 `docs/upgrade-guide/v0.2.1-alpha.1/session-title-provider-strategy/guide.md`）；corum 引用点 = `corum-agent`（dep:55 + devDep:99 + `agent-service.ts:67` type import）+ `desktop-host/package.json:105`（-llm dep）+ UI 元数据（`ide-ui:47-48`、`plugin-manager-ui:42-43`） | 本体只需版本号跟随，`-llm` 伴生包按官方指南迁移 | 改 dep + 迁移 provider API |
| `dsh-subagent-in-process-driver` | `corum-subagent`（lib 产物模块名）+ `desktop-host/package.json:114` + `build/host/package.json:142` 真实 dep + `pnpm-workspace.yaml:220` override（pnpm install 直接断链） | 删除（`3d852a1cea`），驱动逻辑并入 `dsh-subagent` 本体的 activation 生命周期（`activation-driver.ts`，后折进 `activation.ts` 于 `390fbe8852`），`spawn-in-process` 仅剩薄壳 | 改 lib 产物模块名 + external 配置 |

> 评审更正（2026-10-27）：原表 `dsh-session-title` 行记为"移除/合并"，事实错误——包未删，0.2.1 上 `packages/session/session-title` 存在且被官方多包依赖；真实迁移面是伴生包 `dsh-session-title-llm` 的 provider API 变化。另 `dsh-subagent-in-process-driver` 行原记"合并进 `dsh-subagent-spawn-in-process`"不准确——驱动逻辑并入 `dsh-subagent` 本体 activation 生命周期，`spawn-in-process` 仅剩薄壳。

**风险评级：高**。`dsh-invariants` 的处置已定方案 A（详见 §三·1）；其余 4 个被删/更名包 + session-title API 迁移仍需在阶段 1 逐个处理。

---

## 三·0、评审补充：文档遗漏的引用点清单

> 评审记录（2026-10-27）：以下为原评估遗漏的 package.json 级硬依赖引用点，全部断链等级 🔴。

| 包 | 遗漏引用点 |
|---|---|
| `dsh-subagent-in-process-driver` | `desktop-host/package.json:114`、`build/host/package.json:142`、`pnpm-workspace.yaml:220` override |
| `dsh-code-runtime`（裸名） | `desktop-host/package.json:75`、`build/host/package.json:103` |
| `dsh-code-runtime-worker-thread` | UI plugin-meta（`corum-ide-ui:124`、`corum-ide-plugin-manager-ui:119`）、`corum-tools/src/index.ts:1038` 报错文案；0.2.1 终名 `dsh-ptc-runtime-node` |
| `dsh-invariants` | `desktop-host/package.json:86`、`build/host/package.json:114`、`pnpm-workspace.yaml:155` override |
| `dsh-agent-presets` | `corum-agent/src/agent-service.ts:49`、`src/preset-reload.ts:37`、`tsdown.config.ts:24` external、`corum-subagent/src/child-agent.ts:28`、`desktop-host/package.json:60` |

以上全部是 package.json 级硬依赖，0.2.1 升级时 `pnpm install` / `pnpm deploy` 闭包物化直接失败——必须全部进阶段 1 清单。

---

## 三·1、`dsh-invariants` 处置方案 A（已定：跟随官方删除）

> 决策时间：2026-10-26 22:42。决策人：用户。待评审后落地。

> 评审核查（2026-10-27）：事实 1-6 全部证实，包括组合零挂载、官方 base/web-app 不挂、sdk-minimal 恰好 5 行、`f028f25667` 规模 1355 文件精确吻合、升级指南引文逐字吻合。

### 决策

**跟随官方 0.2.0-rc.2 删除 `dsh-invariants`，corum 不自留类型、不补能力。**

4 个 fork 包的 `invariant.ts` companion 文件、`./invariant` 子路径导出、`dsh-invariants` 依赖、external 配置、测试里的 `InvariantRegistry` import —— 全部删除。corum 不新建替代包、不自留 `InvariantFailure`/`InvariantInstaller`/`InvariantRegistry` 类型。

### 决策依据（已逐一核实，证据链完整）

**事实 1：corum 组合从未挂 `dsh-invariants` 服务，也从未挂任何 `./invariant` companion 行。**

- corum 的组合文件（`packages/desktop/cordis.patch.yml` + `profile/corum/cordis.patch.yml`）全文检索：**零挂载行**。patch.yml 里只有一行注释（`packages/desktop/cordis.patch.yml:401`）：
  > `# invariant 不挂（官方组合未挂 subagent-invariant，fork 对齐同纪律）。`
- corum 用的 profile bundle 是 `dsh-base + dsh-web-app`（`/Users/kukucai/.corum/profiles/web/package.json`）。
- 官方 0.1.5-rc.3 的 `dsh-base` 和 `dsh-web-app` bundle **都没挂 invariants**（`git show dsh-v0.1.5-rc.3:packages/bundle/{base,web-app}/cordis.patch.yml` 全文 grep "invariant" 为空）。
- 只有官方 `sdk-minimal` bundle 挂了 5 个 invariant 行（`invariants` + `session-invariant` + `agent-invariant` + `scope-invariant` + `agent-loop-invariant`），corum 不用 sdk-minimal。

**事实 2：4 个 fork 包的 `invariant.ts` 是独立 companion 插件，不被各自主入口 `index.ts` import。**

- 每个 `invariant.ts` 导出 `name = '<pkg>-invariant'` + `inject = ['invariants']` + `apply = (ctx) => ctx.invariants.register(...)`，是 cordis companion 插件形态。
- 4 个 fork 包的 `lib/index.js` 经精确 grep（`require(.*invariant|import.*invariant|from.*invariant)`）验证：**零 import**。index.js 里 grep 到的"invariant"全是注释文字（如"配对由官方 invariant 保证"）。
- `invariant.ts` 通过 `package.json` 的 `"./invariant"` 子路径独立导出，只在组合层显式挂载时才被 Loader 加载。corum 不挂 ⇒ 运行时不加载 ⇒ **是死代码**。

**事实 3：4 个 fork 包的 invariant 检查逻辑在 corum 运行时从未执行。**

| fork 包 | invariant.ts 检查什么 | 运行时是否执行 |
|---|---|---|
| `corum-goal-round-driver` | goal round continuation message 与上一轮 goal 状态一致 | ❌ 未挂载，从不执行 |
| `corum-tool-subagent` | 子 agent 模型选择定义完整可重建（durable policy + route fields + list_subagent_models） | ❌ 未挂载，从不执行 |
| `corum-subagent` | 子 agent 注册表与生命周期不变量 | ❌ 未挂载，从不执行 |
| `corum-tools` | 工具管道流水线顺序、最终快照 Object.freeze、PTC dispatch 闭包 | ❌ 未挂载，从不执行 |

**事实 4：官方删除有明确替代机制。**

官方升级指南（`docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md`）原文：
> "The `credentials/reference-updated`, `credentials/record-updated`, `authorization/settled`, and `llm/adapters-updated` emitters contain and log every listener failure, including errors with `code: 'INVARIANT'`, instead of rethrowing them."

即：原本由 invariant rethrow 的失败，改由四个事件 emitter "contain and log"，不再 rethrow。corum 跟随官方方向。

**事实 5：官方删除规模确证。**

`f028f25667 refactor: remove runtime invariant plugins`（2026-09-30）—— 1355 文件、1487 增 / 15409 删。删了：`dsh-invariants` 包本身 + 每个包的 `./invariant` companion 与测试 + invariant 门禁与 Vitest setup + scoped-event resolver 生成器 + `INVARIANT`-coded listener rethrow 路径。

### 执行清单（阶段 1 的 invariants 子项）

对以下 4 个 fork 包各执行 5 步：

```
packages/plugins/agent/corum-goal-round-driver/
packages/plugins/agent/corum-tool-subagent/
packages/plugins/agent/corum-subagent/
packages/plugins/agent/corum-tools/
```

每个包：

1. **删 `src/invariant.ts` 文件**
2. **`package.json`**：
   - `dependencies` / `peerDependencies` 删 `@deepseek-ai/dsh-invariants`
   - `exports` 删 `"./invariant"` 子路径条目
   - **增补（评审 2026-10-27）**：`packages/desktop/desktop-host/package.json:86` 删 `dsh-invariants` dep；`pnpm-workspace.yaml:155` override 删（`:397`/`:587` 历史 ignore 片段随阶段 2 处理）
3. **`tsdown.config.ts`**：`external` 数组删 `'@deepseek-ai/dsh-invariants'`
4. **测试文件**：删对 `InvariantRegistry` / `@deepseek-ai/dsh-invariants` 的 import（具体文件）：
   - `corum-subagent/tests/continuation.spec.ts:17`（`import InvariantRegistry from '@deepseek-ai/dsh-invariants'`）
   - `corum-subagent/tests/invariant.spec.ts:12`（同上）
   - `corum-tools/tests/invariant.spec.ts:8`（同上）
   - 若整个 spec 文件就是测 invariant 的，整文件删除；否则只删 import + 相关断言
   - **增补（评审 2026-10-27）**：`corum-tools/tests/invariant.spec.ts:7` 还 import 官方子路径 `'@deepseek-ai/dsh-tools/invariant'`（官方也删了，整文件删可覆盖）；`corum-subagent` 两个 spec 的 `'../src/invariant.ts'` import（`continuation:24` / `invariant.spec:11`）与 `continuation.spec.ts:723-724` 挂载行需删
5. **重编译**：`pnpm --filter <pkg> run build`，确认 `lib/invariant.js` 不再生成
   - **改写（评审 2026-10-27）**：构建后必须手动 `rm lib/invariant.js lib/types/invariant.d.ts`（4 包），并同步清 `build/host/node_modules` 闭包内残留——因 `@corum/plugin-build` 硬编码 `clean: false`（`lib/index.js:54`/`:69`），tsdown 不自动清；`lib/invariant.js` + `lib/types/invariant.d.ts` 已存在且已进入打包闭包（`build/host/node_modules/@corum/corum-subagent/lib/invariant.js`）

**新增步骤（评审 2026-10-27）**：修改 `scripts/verify-fork-drift.sh`（`:1129` 循环清单与 `:1180` `SUBAGENT_DELTA_FILES` 去掉 `invariant.ts`），否则守卫自身变红。

全仓收尾：
6. **`packages/desktop/cordis.patch.yml:401`**：删那行注释（`# invariant 不挂...`），避免遗留误导
7. **全仓 typecheck**：`tsc -b --force` 确认无 `Cannot find module '@deepseek-ai/dsh-invariants'` 错误
8. **全仓测试**：确认无 invariant 相关测试失败
9. **fork-drift 守卫**：确认删 invariant.ts 后与官方 0.2.1 的 drift 方向一致（官方也删了）

### 影响评估

| 维度 | 影响 |
|---|---|
| 用户行为 | **零影响**——这些检查从未在 corum 运行时执行 |
| 运行时安全 | **不降低**——corum 本来就没有运行时不变量检查；官方的 emitter contain-and-log 机制在 0.2.1 会接管 listener 失败处理 |
| 编译 | 删除后 4 个 fork 包少一个 external + dep，编译更干净 |
| 测试 | 删 2-3 个 spec 文件（或其中的 invariant 用例），总测试数略降 |
| fork-drift | 与官方 0.2.1 方向一致（官方也删了 invariant），drift 应收敛而非扩大 |

### 未排除的风险（评审结论）

1. **是否有非组合路径加载 invariant.ts** → ✅ **已排除**：无动态 `require`/`import('./invariant')`，Loader（cordis-plugin-loader@1.0.3）无 exports 子路径自动 discover；挂载只能来自组合 patch，全仓组合文件零挂载。
2. **测试是否隐性依赖 invariant 行为** → ✅ **已排除**：恰好 3 个直接 import spec（文档行号全对）；无间接依赖抛错分支的用例（`continuation.spec.ts` 只挂载不断言；唯一断言抛错的是整删文件 `corum-tools/tests/invariant.spec.ts:237`）。
3. **corum 是否有自有的门禁脚本/CI 依赖 invariant 产物** → ✅ **无 CI 依赖**；但 ⚠️ 发现 `scripts/verify-fork-drift.sh` 自身两处引用需改（`:1129` 逐字节对比循环含 `invariant.ts`、`:1180` `SUBAGENT_DELTA_FILES` 含 `invariant.ts`），不改则守卫误报。
4. **lib 产物清理** → ⚠️ **证实为真风险**：`@corum/plugin-build` 硬编码 `clean: false`（`lib/index.js:54`/`:69`），tsdown 不自动清；4 包 `lib/invariant.js` + `lib/types/invariant.d.ts` 已存在且已进入打包闭包（`build/host/node_modules/@corum/corum-subagent/lib/invariant.js`）。

### 被放弃的方案 B（自留类型）—— 不采用

方案 B 设想：在 corum 仓建 `corum-invariants` 包，复制官方 0.1.5 的 `InvariantRegistry`/`InvariantFailure`/`InvariantInstaller`/`InvariantError` 类型，4 个 fork 包改 import 指向本地。

**不采用理由**：
1. corum 组合不挂 invariants 服务 ⇒ 自留的类型在运行时仍是死代码
2. 多一个维护负担（要与官方 0.1.5 的 API 保持兼容，但官方已停止维护）
3. 纯粹为"源码能编译"而保留，运行时价值为零
4. 将来若 corum 真要运行时不变量检查，应重新设计成 corum 自己的 cordis 服务，不必绑定官方已死的 API

---

## 四、新增包组（升级收益）

0.2.1 新增大量包组，其中对 corum 有价值的：

| 新包组 | 价值 |
|---|---|
| `acp` + `subagent-acp` | 进程隔离（方案 C 前置） |
| `subprocess` | 进程管理 seam（背景进程脱离 executor） |
| `host` | 桌面 host 能力（directory-picker 等） |
| `browser-use` | 浏览器自动化 |
| `computer-use` | 桌面操作 |
| `deliverables` | 交付物 |
| `document` | 文档处理 |
| `credentials/deepseek-account` | 账号凭证 |
| `client/ui-plugin-manager` + `ui-plugin-market` | 插件市场 UI |
| `client/ui-settings-*`（多个） | 设置中心扩展 |
| `client/ui-shortcuts` | 快捷键 |
| `compaction/compaction-image-offload` | 压缩图像分流 |

> 评审补充：漏列的重要新增组（2026-10-27）

- 🔴 **boot/ 四新包**：`plugin-manager`、`plugin-market`、`config-editor`、`dsh-hmr`——直接压着 corum 插件框架与热更新链路；corum override 把 `cordis-plugin-hmr` 钉在 1.0.17（官方已 1.0.20）。**HMR 形态待阶段 -1 实证后裁决**（评审核实：dsh-hmr 在官方 apps/cli README 是 profile-manifest/patch watcher；corum 三份 cordis.patch.yml 没有 hmr 行，实际引用 = desktop-host dep + override + UI meta），当前已知 corum 触点 = desktop-host dep + override + UI meta。
- 🔴 **session/session-format-v3-to-v4**：存量会话 V4 迁移（0.1.5 只有 v0→v3 链），阶段计划原本没提。
- **preset/agent-preset + agent-preset-registry**：`dsh-agent-presets` 的落点（§三 被删包的目标包）。
- **简列**：`ssh/` 五包、`telemetry/otel`、`session/working-directory`、`api/` 四个新 controller、`workflow-ptc`、`skill-office`、`mcp-resources`、`llm-deepseek-account` 等。
- **vendor 连带**：cordis 之外 loader 1.0.3→1.0.6、hmr 1.0.17→1.0.20、include 1.0.4→1.0.10、timer 1.1.2→1.1.7、cosmokit/schemastery 齐升；corum override 钉的 `cordis-plugin-group` 1.0.2 / `hmr` 1.0.17 / `timer` 1.1.4 / `schemastery` 3.18.2 与官方期望冲突。
- **总包数 278→362（+84）**；另 `vendor/cordis-rc11-upgrade-plan.md`（proposed）预示 0.3.x 有 cordis rc.11 大升级。

---

## 五、cordis 版本变化（4.0.2 → 4.0.5）

cordis 是 corum fork 的核心依赖（每个 fork 包都用）。0.2.1 的 cordis 只升了 patch（4.0.2→4.0.5，11 个 commit），**相对稳定**，不会有 0.1.x→0.2.x 那种大改。但 11 个 commit 仍需逐一过 fork-drift 守卫。

---

## 六、升级路径建议

### 阶段 -1：官方升级指南映射（先于一切）

0.2.1-rc.3 的 `docs/upgrade-guide/` 有 7 个版本目录共 43 篇（`v0.1.7-rc.2`×2、`v0.2.0-rc.2`×6、`v0.2.1-alpha.1`×22、`alpha.2`×10、`alpha.3`×1、`alpha.4`×1、`rc.2`×1）。与 corum 直接相关的至少：`subagent-activations`、`subagent-preset-composition`（直击 corum-subagent rebase）、`jsonl-persistence-plugin`、`working-directory`、`session-title-provider-strategy`、`plugin-engines-dsh`（兼容性检查优先读 engines.dsh，与 HMR 无关）、`from-default-profile-replaces-target`（corum 不受影响 + 备忘）、`new-session-blank-reuse`（阶段 4 行为观察）、`web-listener-trust-config`（webRuntime→webStartup + trustedHosts 迁移）、`plugin-install-over-installed`（HMR 下 installBundle 对已安装包报 already-installed）。产出 =「指南 → corum 影响映射表」，再进阶段 1。

### 阶段 0：前置准备（必须先做）
1. **完整备份当前 home**：`cp -a ~/.corum ~/.corum-backup-pre-0.2.1`
2. **完整备份当前工作区**：commit + push 当前所有 fork 包
3. **跑一次 fork-drift 守卫**确认 0.1.5 基线零漂移：`DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 ./scripts/verify-fork-drift.sh`

### 阶段 1：解决 4 个被删/更名包 + session-title API 迁移（最大工程）
按 §三 表格逐个处理：
- 改 fork 包的 `package.json` deps
- 改 fork 包源码 import
- 改 `tsdown.config.ts` external
- 对 `dsh-invariants`：**方案 A 已定**（跟随官方删除，详见 §三·1），4 个 fork 包删 `invariant.ts` + dep + external + 子路径导出 + 相关测试
- **增补（评审 2026-10-27）**：`dsh-hmr` 形态待阶段 -1 实证后裁决（当前已知 corum 触点 = desktop-host dep `:53` + override `:292` + UI meta；禁止未核实就替换 dep/override）；`desktop-host/package.json` 的 4 处被删包 dep（`:60`/`:75`/`:86`/`:114`）与 `build/host` 对应行；`session-title-llm` provider 迁移按官方指南

### 阶段 2：override 表重算
- override 基线 217 条（`pnpm-workspace.yaml:43-306`），预计落点 250-300（非 800+）
- 同步清理 433 条陈旧 `minimumReleaseAgeExclude`（`:307` 起，249 条钉 `0.1.3-alpha.1` + 184 条钉 `0.1.1-rc.2`）
- 重算 `cordis-plugin-*`/cosmokit/schemastery 钉版
- 逐包验证可解析性（参考 0.1.5 升级的"逐包循环"）
- **增补（评审 2026-10-27）**：显式加「pnpm-lock 重生成 + `pnpm deploy --legacy` 闭包审计重跑（`scripts/assert-packaged-boot.mjs`）+ patchedDependencies（`node-pty@1.2.0-beta.15`、`@yao-pkg/pkg`）re-apply 验证」；平台词表 9→11 对账（0.2.1 `seed.ts` 新增 `zod` 与 `@tanstack/react-virtual`；决定 `packages/tooling/corum-plugin-build/src/index.ts:37` `CLIENT_EXTERNALS_BASE` 是否跟进）

### 阶段 3：fork 包 rebase
- 按 `docs/fork-delta.md` §5 runbook，逐个 fork 包对照官方 0.2.1 重新合并
- 50 个 fork 包，工程量大
- **增补提示（评审 2026-10-27）**：`corum-subagent` rebase 是单独大头（fork 基线 0.1.3-alpha.1，官方 subagent 热区含 activation 合并、continuation/child-agent 大改，fork-delta §10.2 中风险项全在热区；另有 §10.3-5 沙箱钳制三接线回归门禁）

### 阶段 4：三层验证
- 全仓 `tsc -b --force` typecheck 0 错
- 全仓测试通过
- fork-drift 守卫通过
- 实机 CDP 冲烟（UI 渲染 + 行为 + 零 console 错误）
- **增补（评审 2026-10-27）**：存量会话 V3→V4 迁移预演（官方新增 `session-format-v3-to-v4`；前车之鉴 = 0.1.5 升级时 14 个 v2 会话无法迁移被清除）

### 阶段 4.5：Electron 版本验证
corum 钉 electron 43.4.1，官方 0.2.1 用 `^44.7.0`，且 `SessionWriteLease` 0.2.1 版依赖预编译 Node-API flock addon（`d927cbff99`），`node-addon-native-custom-loader@0.1.9` 按 Electron 44.7.0 指纹识别；需验证该 addon 在 Electron 43.4.1 旧指纹下可加载，否则考虑同步升 Electron。

### 阶段 5：装配进程隔离（方案 C 第一步）
- ~~装配 `dsh-subagent-acp` 即可，工程量小~~
- **改写（评审 2026-10-27）**：acp 可作为第三 provider 挂载（`inject ['subagents','subprocess']`，两服务 corum 都有，组合面只加一行 patch row + dep + override），但能力面与 corum 隔离体系互斥：`AcpProvider` capabilities 全 false（`agentOptions`/`agentPreset`/`outputSchema`/`depthLimit` 全拒）、`inheritsParentContext=false`；corum 委派轴心（cwd 透传✅，但 worktree 隔离沙箱钳制、角色契约、agentPreset、结构化输出、深度上限）在 acp provider 上全部不可用 ⇒ acp 只能与 corum-spawn/corum-fork/corum-isolated 并存为第三选项，全量切换需 fork `subagent-acp` 本身；另需产品决策：子进程命令形态（官方预期 `dsh acp-app` + 显式 `DSH_HOME`）、模型配置、权限策略（默认 reject）。修复"卸载破坏活会话"的子 agent 路径成立 ✅，但顶层会话一侧仍需阶段 6。

### 阶段 6：顶层会话 sidecar（方案 C 第二步，可独立排期）
- 自研顶层会话进程隔离，复用 subprocess seam + SessionWriteLease

---

## 七、风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 4 个被删/更名包依赖断链 | **高** | 阶段 1 优先处理 |
| `dsh-invariants` 完全删除无替代 | ~~高~~ → **中**（方案 A 已定，详见 §三·1） | 跟随官方删除，死代码零影响；评审后落地 |
| `dsh-code-runtime`/`agent-presets`/`session-title`/`subagent-in-process-driver` 四个被删包 | **高** | 阶段 1 逐个改 import + dep |
| 6026 commit 跨度大，可能有破坏性 API 变更 | 中 | 阶段 3 fork rebase 时逐一发现 |
| override 250-300 条 + 433 条陈旧豁免清理 | 中 | 脚本化重算 + 逐包验证可解析性 |
| cordis 4.0.2→4.0.5 的 11 个 commit | 低 | fork-drift 守卫会拦住 |
| 三平台覆盖（macOS/Linux/Windows） | 中 | 阶段 4 实机验证 |
| desktop-host 硬断链（4 处被删包 dep + override） | 高 | 阶段 1 必含（评审发现原清单遗漏） |
| `dsh-hmr` / `cordis-plugin-*` 钉版冲突 | 高 | HMR 形态待阶段 -1 实证后裁决，再决定阶段 1/2 处置 |
| Electron 43.4.1 vs 官方 44.7 的 flock addon 指纹差 | 中 | 阶段 4 前验证 |

---

## 八、与历次升级对比

| 项 | 0.1.2→0.1.3 | 0.1.3→0.1.5 | **0.1.5→0.2.1（本次）** |
|---|---|---|---|
| 跨度 | patch | minor | **2 个 minor** |
| 被删包 | 0 | 0 | **0/0/4+1 更名** |
| 新增包组 | 少量 | 少量 | **大量** |
| cordis 变化 | 无 | 无 | patch（4.0.2→4.0.5） |
| 实测可参考 | §9 fork-delta | 历史交接口径（`HANDOFF-2026-09-29-official-0.1.5-upgrade.md`，当前不在库，仅作背景） | **无前例** |

**建议**：本次升级的实录要新开 `docs/UPGRADE-0.2.1-rc3.md`，逐步记录，作为后续 0.2.x→0.3.x 的参照。

---

## 九、下一步行动建议

1. **先装回 corum-dev 扩展包**（已完成 ✅，重启 app 生效）
2. **`dsh-invariants` 处置已定方案 A**（§三·1，待评审后落地）
3. ✅ **已完成**（2026-10-27，结论：方向成立，方案 A 证据链全绿；勘误与遗漏已回写本文）
4. **评审已通过 ⇒ 下一步先做阶段 -1（43 篇官方指南映射），再启动阶段 1**
5. 后续阶段按 §六 顺序推进

> 本评估基于 2026-10-26 22:40 的 dsh `dsh-v0.2.1-rc.3` + corum `0.7.0` 状态。后续 0.2.1-rc.x 或 0.2.2 发布时需复核。
