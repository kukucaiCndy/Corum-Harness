# 阶段 1：被删/更名包处置执行手册

> 状态：评审通过，待落地 ｜ 前置：阶段 -1（官方升级指南映射）已完成 ｜ 工程量：大（6 个处置对象 + 1 个 vendor 连带，涉及约 30 个文件改动点）

---

## 1. 目标与范围

本册解决 dsh 基座 0.1.5-rc.3 → 0.2.1-rc.3 升级中**最大的工程障碍**：corum fork 包依赖的官方包在 0.2.1 被删除、更名或 API 迁移，导致 `pnpm install` 闭包解析直接失败。

### 处置对象总览（6 个 + 1 个 vendor 连带）

| # | 被删/更名包 | 0.2.1 去向 | 处置方式 | 官方 commit |
|---|---|---|---|---|
| 1 | `dsh-code-runtime` | 更名 `dsh-ptc-runtime` | 改 import + dep | `7c9bb5914c` |
| 2 | `dsh-code-runtime-worker-thread` | 更名 `dsh-ptc-runtime-node` | 改 UI 元数据 + dep | `f95f7ec8dc` |
| 3 | `dsh-agent-presets` | 删除，改 profile YAML 声明 | 迁移到 preset YAML + 新 preset 包 | `d1e22a7e24`（PR #4569） |
| 4 | `dsh-invariants` | 删除（方案 A 跟随官方） | 删 src + dep + external + 测试 + lib 残留 | `f028f25667`（PR #5517） |
| 5 | `dsh-session-title` | 包未删；伴生包 `-llm` provider API 迁移 | 本体版本跟随 + `-llm` 按 guide 迁移 | 官方指南 `v0.2.1-alpha.1/session-title-provider-strategy` |
| 6 | `dsh-subagent-in-process-driver` | 删除，驱动并入 dsh-subagent activation | 改 lib 产物模块名 + dep + override | `3d852a1cea` → `390fbe8852` |
| 附 | `cordis-plugin-hmr` / `dsh-hmr` 形态核查 + vendor 齐升 | HMR 形态待阶段 -1 裁决；loader/include/timer/schemastery/cosmokit 版本跟随 | 改 override + dep（HMR 待裁决后处置） | 0.2.1 `base/cordis.patch.yml` |

### 范围边界

- **本册只处理「包消失导致的断链」**。override 表全量重算（217 条 → 250-300 条）、`minimumReleaseAgeExclude` 清理（433 条）、fork 包 rebase 属于阶段 2/3，不在本册。
- **`dsh-invariants` 方案 A 已定**（跟随官方删除，详见 §4.4），本册给出完整执行清单。
- **每个处置对象独立 commit**，可逐个 revert（详见 §7 回滚方案）。

---

## 2. 前置条件（准入门禁）

| # | 门禁项 | 验证命令 | 通过标准 |
|---|---|---|---|
| 2.1 | 阶段 -1 已完成：43 篇官方升级指南已映射 | 检查「指南 → corum 影响映射表」产出物存在 | 文件存在且覆盖 `subagent-preset-composition`、`session-title-provider-strategy`、`remove-runtime-invariants` 三篇 |
| 2.2 | 当前工作区已 commit + push | `git status --porcelain` | 空输出 |
| 2.3 | home 完整备份 | `ls $HOME/corum-upgrade-backups/pre-0.2.1-rc3-*/home/` | 目录存在 |
| 2.4 | fork-drift 守卫基线已建立 | `DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 TMPDIR="$PWD/.corum-tmp" ./scripts/verify-fork-drift.sh` | 真实 tag 导出成功（无回落警告）+ 失败项 N 已归档（阶段 0 记录的基线 N 项，不宣称 0/23/24） |
| 2.5 | 官方 checkout 的 `dsh-v0.2.1-rc.3` tag 存在 | `git -C /Users/kukucai/dsh for-each-ref refs/tags/dsh-v0.2.1-rc.3` | 非空（tag 存在即可，**不得要求 checkout**；当前 dsh 工作树停在 rc.2，跨版本对比用 `git show <tag>:<path>` 即可） |

> **门禁失败则不得进入执行**。任一项不满足时，先完成前置再进阶段 1。

---

## 3. 输入与依赖

### 3.1 单一事实源

- `docs/UPGRADE-0.2.1-rc3-feasibility.md`（HEAD，含评审修订）—— §一、§三、§三·0、§三·1、§四、§七。

### 3.2 评审证据报告（含全部精确路径行号）

- `~/.corum/research-reports/885858d9-8c4b-427e-ada0-87fbe675a96a.md`——被删包引用点核查。
- `~/.corum/research-reports/5c35a73b-1c59-49ef-9bfa-d0d73763dbf6.md`——invariants 方案 A 证据链核查。

### 3.3 官方只读 checkout

- `/Users/kukucai/dsh` @ `dsh-v0.2.1-rc.3`，用 `git -C /Users/kukucai/dsh show <tag>:<path>` 取官方文件。

### 3.4 官方升级指南（本册直接引用）

- `docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md`——invariants 删除替代（emitter contain-and-log）。
- `docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.md`——agent-presets 迁移到 profile YAML。
- `docs/upgrade-guide/v0.2.1-alpha.1/session-title-provider-strategy/guide.md`——session-title-llm provider API 迁移。

### 3.5 执行顺序（评审建议）

```
① dsh-invariants 方案 A（范围最清晰、可独立验证）
② dsh-code-runtime / dsh-code-runtime-worker-thread 更名
③ dsh-subagent-in-process-driver 删除
④ dsh-agent-presets 删除（依赖阶段 -1 的指南映射）
⑤ dsh-session-title-llm provider 迁移
⑥ dsh-hmr 形态核查（待阶段 -1 裁决）+ vendor 齐升
```

> 理由：invariants 的处置范围最清晰且可独立验证（死代码零运行时影响）；code-runtime/worker-thread 是机械改名；in-process-driver 涉及 lib 产物注释和 dep；agent-presets 依赖阶段 -1 的 preset-composition 指南映射结果；session-title-llm 是 API 迁移（工程量集中在伴生包）；hmr + vendor 齐升压着热更新链路放最后。

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

验证：`find packages/plugins/agent -name "invariant.ts -path "*/src/*"` 零命中。

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

#### 步骤 ①-3：4 个 fork 包的 `tsdown.config.ts` 删 external

| 包 | external 行 |
|---|---|
| `corum-goal-round-driver` | `:15` external 数组含 `'@deepseek-ai/dsh-invariants'` |
| `corum-tool-subagent` | `:16` external 数组含 `'@deepseek-ai/dsh-invariants'` |
| `corum-subagent` | `:14` external 数组含 `'@deepseek-ai/dsh-invariants'` |
| `corum-tools` | `:12` external 数组含 `'@deepseek-ai/dsh-invariants'` |

操作：从 external 数组中删除 `'@deepseek-ai/dsh-invariants'` 字符串。

验证：`grep -r "dsh-invariants" packages/plugins/agent/corum-{goal-round-driver,tool-subagent,subagent,tools}/tsdown.config.ts` 零命中。

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

#### 步骤 ①-5：desktop-host / build/host / pnpm-workspace 删 dep + override

| 文件 | 行号 | 内容 |
|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:86` | `"@deepseek-ai/dsh-invariants": "0.1.5-rc.3"` dependency |
| `packages/desktop/build/host/package.json` | `:114` | `"@deepseek-ai/dsh-invariants": "0.1.5-rc.3"` dependency |
| `pnpm-workspace.yaml` | `:155` | `'@deepseek-ai/dsh-invariants': '0.1.5-rc.3'` override |

操作：删除以上三处。`pnpm-workspace.yaml` 的 `:397`（`dsh-invariants@0.1.1-rc.2`）和 `:587`（`dsh-invariants@0.1.3-alpha.1`）历史 ignore 段**留到阶段 2 处理**，不在本册。

验证：`grep -n "dsh-invariants" packages/desktop/desktop-host/package.json` 零命中；`grep -n "dsh-invariants" packages/desktop/build/host/package.json` 零命中；`grep -n "'@deepseek-ai/dsh-invariants'" pnpm-workspace.yaml` 仅在 `:397`/`:587` 历史 ignore 段命中。

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

> 不改则守卫误报：升级后双方文件都没了，`cmp -s` 对缺失文件 fail ⇒ 守卫报「与官方有差异」。

验证：`grep -n "invariant.ts" scripts/verify-fork-drift.sh` 零命中。

#### 步骤 ①-8：重编译 4 包 + 手动清理 lib 残留

> **关键**：`@corum/plugin-build` 硬编码 `clean: false`（`lib/index.js:54` hostConfig、`:69` clientConfig），tsdown 不自动清理 outDir。4 包的 `lib/invariant.js` + `lib/types/invariant.d.ts` 已存在且已进入打包闭包（`build/host/node_modules/@corum/corum-subagent/lib/invariant.js`），删 src 后必须手动 rm。

命令（4 包各执行）：
```bash
for pkg in corum-goal-round-driver corum-tool-subagent corum-subagent corum-tools; do
  pnpm --filter "@corum/$pkg" run build
  rm -f "packages/plugins/agent/$pkg/lib/invariant.js"
  rm -f "packages/plugins/agent/$pkg/lib/types/invariant.d.ts"
done
```

同步清理闭包残留：
```bash
rm -f packages/desktop/build/host/node_modules/@corum/corum-subagent/lib/invariant.js
rm -f packages/desktop/build/host/node_modules/@corum/corum-tools/lib/invariant.js
rm -f packages/desktop/build/host/node_modules/@corum/corum-goal-round-driver/lib/invariant.js
rm -f packages/desktop/build/host/node_modules/@corum/corum-tool-subagent/lib/invariant.js
```

验证：
```bash
find packages/plugins/agent -name "invariant.js" -o -name "invariant.d.ts" 2>/dev/null
find packages/desktop/build/host/node_modules/@corum -name "invariant.js" -o -name "invariant.d.ts" 2>/dev/null
```
均零命中。

#### 步骤 ①-9：提交（独立 commit）

```bash
git add -f packages/plugins/agent/corum-goal-round-driver/
git add -f packages/plugins/agent/corum-tool-subagent/
git add -f packages/plugins/agent/corum-subagent/
git add -f packages/plugins/agent/corum-tools/
git add packages/desktop/desktop-host/package.json packages/desktop/build/host/package.json
git add pnpm-workspace.yaml packages/desktop/cordis.patch.yml scripts/verify-fork-drift.sh
git commit -m "upgrade(0.2.1-rc3): 删除 dsh-invariants（方案 A 跟随官方）"
```

---

### 4.2 处置对象 ②：dsh-code-runtime → dsh-ptc-runtime + dsh-code-runtime-worker-thread → dsh-ptc-runtime-node

> 官方 commit `7c9bb5914c refactor(ptc): align runtime packages and services with PTC naming`；配套 `f95f7ec8dc refactor(code-runtime): name the Node runtime provider` 先改 code-runtime-node。
> 0.2.1 终名：`@deepseek-ai/dsh-ptc-runtime`（`packages/ptc-runtime/ptc-runtime/package.json`）+ `@deepseek-ai/dsh-ptc-runtime-node`（`packages/ptc-runtime/ptc-runtime-node/package.json`）。

#### 步骤 ②-1：corum-tools 改 import + dep + external + 报错文案

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/agent/corum-tools/src/index.ts` | `:17` | `import type { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'` | `import type { CodeRuntime } from '@deepseek-ai/dsh-ptc-runtime'` |
| `packages/plugins/agent/corum-tools/src/index.ts` | `:41` | 注释中 `dsh-code-runtime` | `dsh-ptc-runtime`（注释文字） |
| `packages/plugins/agent/corum-tools/src/index.ts` | `:1038` | 报错文案 `@deepseek-ai/dsh-code-runtime-worker-thread` | `@deepseek-ai/dsh-ptc-runtime-node` |
| `packages/plugins/agent/corum-tools/src/ptc.ts` | `:12` | `import type { CodeBindingFunction, CodeRunResult, CodeRuntime } from '@deepseek-ai/dsh-code-runtime'` | `from '@deepseek-ai/dsh-ptc-runtime'` |
| `packages/plugins/agent/corum-tools/tests/ptc.spec.ts` | `:7` | `import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'` | `from '@deepseek-ai/dsh-ptc-runtime'` |
| `packages/plugins/agent/corum-tools/tests/ptc.spec.ts` | `:8` | `import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'` | `from '@deepseek-ai/dsh-ptc-runtime'` |
| `packages/plugins/agent/corum-tools/package.json` | `:35` | peerDep `"@deepseek-ai/dsh-code-runtime": "^0.1.5-rc.3"` | `"@deepseek-ai/dsh-ptc-runtime": "^0.2.1-rc.3"` |
| `packages/plugins/agent/corum-tools/package.json` | `:51` | devDep `"@deepseek-ai/dsh-code-runtime": "^0.1.5-rc.3"` | `"@deepseek-ai/dsh-ptc-runtime": "^0.2.1-rc.3"` |
| `packages/plugins/agent/corum-tools/tsdown.config.ts` | `:12` | external 含 `'@deepseek-ai/dsh-code-runtime'` | 改为 `'@deepseek-ai/dsh-ptc-runtime'` |

验证：
```bash
grep -rn "dsh-code-runtime" packages/plugins/agent/corum-tools/src/ packages/plugins/agent/corum-tools/tests/ packages/plugins/agent/corum-tools/package.json packages/plugins/agent/corum-tools/tsdown.config.ts
```
零命中（全部已改为 `dsh-ptc-runtime` / `dsh-ptc-runtime-node`）。

#### 步骤 ②-2：desktop-host + build/host 改 dep

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:75` | `"@deepseek-ai/dsh-code-runtime": "0.1.5-rc.3"` | `"@deepseek-ai/dsh-ptc-runtime": "0.2.1-rc.3"` |
| `packages/desktop/build/host/package.json` | `:103` | `"@deepseek-ai/dsh-code-runtime": "0.1.5-rc.3"` | `"@deepseek-ai/dsh-ptc-runtime": "0.2.1-rc.3"` |

#### 步骤 ②-3：UI 元数据改 worker-thread → ptc-runtime-node

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/ui/corum-ide-ui/src/client/settings/plugin-meta.ts` | `:124` | `'@deepseek-ai/dsh-code-runtime-worker-thread': { zhName: '代码运行时', ... }` | 键名改为 `'@deepseek-ai/dsh-ptc-runtime-node'`（zhName/zhDesc 不变） |
| `packages/plugins/ui/corum-ide-plugin-manager-ui/src/client/plugin-meta.ts` | `:119` | 同上 | 同上 |

> 注意：UI 元数据含 lib 产物拷贝，改名后需重编译两个 UI 包（三步：`tsc -b && tsdown && node scripts/inline-css.mjs`），使 lib 产物中的键名同步更新。

#### 步骤 ②-4：pnpm-workspace override 改名

| 行号 | 当前 | 改为 |
|---|---|---|
| `:117` | `'@deepseek-ai/dsh-code-runtime': '0.1.5-rc.3'` | `'@deepseek-ai/dsh-ptc-runtime': '0.2.1-rc.3'` |
| `:118` | `'@deepseek-ai/dsh-code-runtime-worker-thread': '0.1.5-rc.3'` | `'@deepseek-ai/dsh-ptc-runtime-node': '0.2.1-rc.3'` |

> `:367`/`:368`（`dsh-code-runtime-worker-thread@0.1.1-rc.2` / `dsh-code-runtime@0.1.1-rc.2`）和 `:557`/`:558`（`0.1.3-alpha.1`）历史 ignore 段留到阶段 2。

#### 步骤 ②-5：重编译 + 验证

```bash
pnpm --filter @corum/corum-tools run build
pnpm --filter @corum/corum-ide-ui run build
pnpm --filter @corum/corum-ide-plugin-manager-ui run build
```

验证：
```bash
grep -rn "dsh-code-runtime" packages/ --include="*.ts" --include="*.json" | grep -v "node_modules" | grep -v "minimumReleaseAgeExclude"
```
零命中（仅允许 `pnpm-workspace.yaml` 历史 ignore 段残留）。

#### 步骤 ②-6：提交

```bash
git add -f packages/plugins/agent/corum-tools/ packages/plugins/ui/corum-ide-ui/ packages/plugins/ui/corum-ide-plugin-manager-ui/
git add packages/desktop/desktop-host/package.json packages/desktop/build/host/package.json pnpm-workspace.yaml
git commit -m "upgrade(0.2.1-rc3): dsh-code-runtime → dsh-ptc-runtime 更名"
```

---

### 4.3 处置对象 ③：dsh-subagent-in-process-driver 删除

> 官方 commit `3d852a1cea refactor(subagent): unify local and external activation lifecycles`——驱动逻辑并入 `dsh-subagent` 本体的 activation 生命周期（`activation-driver.ts`，后折进 `activation.ts` 于 `390fbe8852`）；`spawn-in-process` 仅剩薄壳（0.2.1 上 `subagent-spawn-in-process/src/` 只剩 `index.ts`，deps 仅 schemastery）。
> corum 引用面 = lib 产物模块名注释 + desktop-host/build/host dep + pnpm-workspace override。

#### 步骤 ③-1：corum-subagent lib 产物模块名注释

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/agent/corum-subagent/src/driver/index.ts` | `:11` | `@module @deepseek-ai/dsh-subagent-in-process-driver` | `@module @deepseek-ai/dsh-subagent`（或删除该 JSDoc module 标注） |
| `packages/plugins/agent/corum-subagent/src/driver/structured.ts` | `:10` | `@module @deepseek-ai/dsh-subagent-in-process-driver/structured` | `@module @deepseek-ai/dsh-subagent/structured`（或删除） |

> 这些是 JSDoc `@module` 注释，不影响运行时但影响 lib 产物 `.d.ts` 的模块声明。驱动逻辑已在 corum-subagent 本体，注释应指向本体包名。

#### 步骤 ③-2：desktop-host + build/host 删 dep

| 文件 | 行号 | 当前 |
|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:114` | `"@deepseek-ai/dsh-subagent-in-process-driver": "0.1.5-rc.3"` |
| `packages/desktop/build/host/package.json` | `:142` | `"@deepseek-ai/dsh-subagent-in-process-driver": "0.1.5-rc.3"` |

操作：删除两处 dependency。

#### 步骤 ③-3：pnpm-workspace 删 override

| 行号 | 当前 |
|---|---|
| `:220` | `'@deepseek-ai/dsh-subagent-in-process-driver': '0.1.5-rc.3'` |

操作：删除该 override 行。`:450`（`@0.1.1-rc.2`）和 `:642`（`@0.1.3-alpha.1`）历史 ignore 段留到阶段 2。

#### 步骤 ③-4：重编译 + 验证

```bash
pnpm --filter @corum/corum-subagent run build
```

验证：
```bash
grep -rn "dsh-subagent-in-process-driver" packages/ --include="*.ts" --include="*.json" | grep -v "node_modules" | grep -v "minimumReleaseAgeExclude"
```
零命中（仅 `pnpm-workspace.yaml` 历史 ignore 段允许残留）。

#### 步骤 ③-5：提交

```bash
git add -f packages/plugins/agent/corum-subagent/
git add packages/desktop/desktop-host/package.json packages/desktop/build/host/package.json pnpm-workspace.yaml
git commit -m "upgrade(0.2.1-rc3): 删除 dsh-subagent-in-process-driver 依赖"
```

---

### 4.4 处置对象 ④：dsh-agent-presets 删除（改 profile YAML 声明）

> 官方 commit `d1e22a7e24 feat(preset): declare Agent compositions in profile YAML (#4569)`——整目录 `packages/preset/agent-presets/` 为 D，移到新包 `preset/agent-preset`（`@deepseek-ai/dsh-agent-preset`）+ `preset/agent-preset-registry`（`@deepseek-ai/dsh-agent-preset-registry`）。
> 迁移指南：`docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.md`——subagent 的 `persona` 和 `toolFilter` 配置被 Agent Preset composition 取代；spawn 通过 `agentPreset` 选择 preset；fork 继承父 preset。
> **前置依赖**：阶段 -1 的 `subagent-preset-composition` 指南映射结果（决定 corum-agent 的 preset 面要照 `d1e22a7e24` 重写多少）。

#### 步骤 ④-1：corum-agent 改 type import + dep + external

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/plugins/agent/corum-agent/src/agent-service.ts` | `:49` | `import type {} from '@deepseek-ai/dsh-agent-presets'` | 删除该 import（或改为指向新包 `@deepseek-ai/dsh-agent-preset` 的等价类型，视阶段 -1 映射结果） |
| `packages/plugins/agent/corum-agent/src/agent-service.ts` | `:378` | 注释 `官方 dsh-agent-presets 注册的会话级 preset 键` | 改为 `dsh-agent-preset` |
| `packages/plugins/agent/corum-agent/src/preset-reload.ts` | `:37` | `import type {} from '@deepseek-ai/dsh-agent-presets'` | 删除或改指向新包 |
| `packages/plugins/agent/corum-agent/tsdown.config.ts` | `:24` | external 含 `'@deepseek-ai/dsh-agent-presets'` | 改为 `'@deepseek-ai/dsh-agent-preset'`（若新包需要 external）或删除 |
| `packages/plugins/agent/corum-agent/package.json` | `:44` | peerDep `"@deepseek-ai/dsh-agent-presets": "^0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-agent-preset": "^0.2.1-rc.3"` 或删除 |
| `packages/plugins/agent/corum-agent/package.json` | `:88` | devDep `"@deepseek-ai/dsh-agent-presets": "^0.1.5-rc.3"` | 同上 |

> 注意：corum-agent 是最大的 fork 包，preset 面的改写量取决于阶段 -1 映射结论。`import type {}` 是空类型导入（仅用于触发模块侧效果或类型对齐），但 `:378` 注释表明 agentPreset 投影逻辑消费了 preset 机制——需确认新包 `dsh-agent-preset` 是否提供等价接口。

#### 步骤 ④-2：corum-subagent 改 type import + external

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/plugins/agent/corum-subagent/src/child-agent.ts` | `:28` | `import type {} from '@deepseek-ai/dsh-agent-presets'` | 删除或改指向新包 |
| `packages/plugins/agent/corum-subagent/tsdown.config.ts` | `:14` | external 含 `'@deepseek-ai/dsh-agent-presets'` | 改为 `'@deepseek-ai/dsh-agent-preset'` 或删除 |
| `packages/plugins/agent/corum-subagent/package.json` | `:44` | dep `"@deepseek-ai/dsh-agent-presets": "^0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-agent-preset": "^0.2.1-rc.3"` 或删除 |

#### 步骤 ④-3：corum-api-remotes 改 type import + dep

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/plugins/agent/corum-api-remotes/src/index.ts` | `:26` | `import type {} from '@deepseek-ai/dsh-agent-presets/types'` | 删除或改指向新包 |
| `packages/plugins/agent/corum-api-remotes/package.json` | `:44` | dep `"@deepseek-ai/dsh-agent-presets": "^0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-agent-preset": "^0.2.1-rc.3"` 或删除 |

> 注意：`corum-api-remotes/lib/client.js:5657-5673` 产物内字符串含 `dsh-agent-presets`，重编译后自动更新。

#### 步骤 ④-4：desktop-host + build/host 删/改 dep

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:60` | `"@deepseek-ai/dsh-agent-presets": "0.1.5-rc.3"` | 改为 `"@deepseek-ai/dsh-agent-preset": "0.2.1-rc.3"` 或删除 |
| `packages/desktop/build/host/package.json` | 对应行 | 同上 | 同上 |

#### 步骤 ④-5：UI 元数据改包名

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| `packages/plugins/ui/corum-ide-ui/src/client/settings/plugin-meta.ts` | `:67` | `'@deepseek-ai/dsh-agent-presets': { zhName: '智能体预设', ... }` | 键名改为 `'@deepseek-ai/dsh-agent-preset'` |
| `packages/plugins/ui/corum-ide-plugin-manager-ui/src/client/plugin-meta.ts` | `:62` | 同上 | 同上 |

#### 步骤 ④-6：pnpm-workspace override 改名

| 行号 | 当前 | 改为 |
|---|---|---|
| `:54` | `'@deepseek-ai/dsh-agent-presets': '0.1.5-rc.3'` | `'@deepseek-ai/dsh-agent-preset': '0.2.1-rc.3'` |

> `:311`（`@0.1.1-rc.2`）和 `:495`（`@0.1.3-alpha.1`）历史 ignore 段留到阶段 2。

#### 步骤 ④-7：按官方指南迁移 preset 声明到 profile YAML

按 `subagent-preset-composition/guide.md`：
1. 从 `dsh-tool-subagent` 的 profile patch 行中移除 `persona` 和 `toolFilter` 配置。
2. 为 spawn 定义 Agent Preset（含 `dsh-persona` + 所需工具插件），设 `agentPreset` 为其 id；用 `allowedAgentPresets` 提供多个预设。
3. fork 继承父 preset，不做独立 override。

> 具体改哪些 profile patch 行取决于 corum 当前 preset 配置——需在阶段 -1 映射时定位 corum 的 preset 声明点。

#### 步骤 ④-8：重编译 + 验证

```bash
pnpm --filter @corum/corum-agent run build
pnpm --filter @corum/corum-subagent run build
pnpm --filter @corum/corum-api-remotes run build
pnpm --filter @corum/corum-ide-ui run build
pnpm --filter @corum/corum-ide-plugin-manager-ui run build
```

验证：
```bash
grep -rn "dsh-agent-presets" packages/ --include="*.ts" --include="*.json" | grep -v "node_modules" | grep -v "minimumReleaseAgeExclude"
```
零命中。

#### 步骤 ④-9：提交

```bash
git add -f packages/plugins/agent/corum-agent/ packages/plugins/agent/corum-subagent/ packages/plugins/agent/corum-api-remotes/
git add -f packages/plugins/ui/corum-ide-ui/ packages/plugins/ui/corum-ide-plugin-manager-ui/
git add packages/desktop/desktop-host/package.json packages/desktop/build/host/package.json pnpm-workspace.yaml
git commit -m "upgrade(0.2.1-rc3): dsh-agent-presets → profile YAML + dsh-agent-preset"
```

---

### 4.5 处置对象 ⑤：dsh-session-title-llm provider API 迁移

> **包未删**：`@deepseek-ai/dsh-session-title` 在 0.2.1 仍存在（`packages/session/session-title/`），被官方多包依赖。真实迁移面 = 伴生包 `dsh-session-title-llm` 的 provider API 变化。
> 官方指南：`docs/upgrade-guide/v0.2.1-alpha.1/session-title-provider-strategy/guide.md` + session-title-adapters。
> API 变化：`registerSessionTitleLlmProvider` / `generateSessionTitleLlm` / `SessionTitleLlmMessageSelector` 移除；provider 改为直接 `ctx.sessionTitle.register()` + `executeSessionTitleLlm`；`SessionTitleLlmConfig` 仅保留执行控制（`maxInputBytes`/`maxOutputTokens`/`timeoutMs` + optional `provider`/`model`），`targetWords`/`targetCjkCharacters` 移入各 provider 自己的 `Config`。

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

> 若 corum 有自定义 session-title provider 实现（调用 `registerSessionTitleLlmProvider`），需按指南迁移到 `ctx.sessionTitle.register()` + `executeSessionTitleLlm`。需在阶段 -1 映射时确认 corum 是否有此类实现。

#### 步骤 ⑤-3：UI 元数据版本跟随

| 文件 | 行号 | 当前 | 操作 |
|---|---|---|---|
| `packages/plugins/ui/corum-ide-ui/src/client/settings/plugin-meta.ts` | `:47` | `'@deepseek-ai/dsh-session-title': { ... }` | **保留**（包未删） |
| `packages/plugins/ui/corum-ide-ui/src/client/settings/plugin-meta.ts` | `:48` | `'@deepseek-ai/dsh-session-title-first-prompt-llm': { ... }` | 检查 0.2.1 是否仍有此包；若有则保留，若无则删 |
| `packages/plugins/ui/corum-ide-plugin-manager-ui/src/client/plugin-meta.ts` | `:42` | 同 `:47` | 保留 |
| `packages/plugins/ui/corum-ide-plugin-manager-ui/src/client/plugin-meta.ts` | `:43` | 同 `:48` | 同上 |

#### 步骤 ⑤-4：pnpm-workspace override 版本跟随

| 行号 | 当前 | 改为 |
|---|---|---|
| `:197` | `'@deepseek-ai/dsh-session-title': '0.1.5-rc.3'` | `'0.2.1-rc.3'` |
| `:198` | `'@deepseek-ai/dsh-session-title-first-prompt-llm': '0.1.5-rc.3'` | `'0.2.1-rc.3'`（若包仍存在）或删除 |
| `:199` | `'@deepseek-ai/dsh-session-title-llm': '0.1.5-rc.3'` | `'0.2.1-rc.3'` |

> `:432`/`:433`/`:434`（`@0.1.1-rc.2`）和 `:624`/`:625`/`:626`（`@0.1.3-alpha.1`）历史 ignore 段留到阶段 2。

#### 步骤 ⑤-5：重编译 + 验证

```bash
pnpm --filter @corum/corum-agent run build
pnpm --filter @corum/corum-ide-ui run build
pnpm --filter @corum/corum-ide-plugin-manager-ui run build
```

验证：
```bash
grep -rn "registerSessionTitleLlmProvider\|generateSessionTitleWithLlm" packages/ --include="*.ts" | grep -v "node_modules"
```
零命中（若 corum 无自定义 provider 实现）。

#### 步骤 ⑤-6：提交

```bash
git add -f packages/plugins/agent/corum-agent/ packages/plugins/ui/corum-ide-ui/ packages/plugins/ui/corum-ide-plugin-manager-ui/
git add packages/desktop/desktop-host/package.json pnpm-workspace.yaml
git commit -m "upgrade(0.2.1-rc3): dsh-session-title 版本跟随 + -llm provider API 迁移"
```

---

### 4.6 处置对象 ⑥：HMR 形态核查与迁移（以阶段 -1 裁决为准）

> **前置**：HMR 形态待阶段 -1 实证后裁决。评审核实：dsh-hmr 在官方 apps/cli README 是 profile-manifest/patch watcher；corum 三份 cordis.patch.yml 没有 hmr 行，实际引用 = `desktop-host/package.json:53` dep `cordis-plugin-hmr ^1.0.16` + `pnpm-workspace.yaml:292` override `1.0.17` + UI plugin-meta。
> **禁止未核实就替换 dep/override**——阶段 -1 核查 `git -C /Users/kukucai/dsh show dsh-v0.2.1-rc.3:packages/bundle/base/cordis.patch.yml`、`packages/boot/hmr/package.json`、`apps/cli/README.md` 后，再决定本步骤动作。
> vendor 连带：loader 1.0.3→1.0.6、include 1.0.7→1.0.10、timer 1.1.4→1.1.7、hmr 1.0.17→1.0.20、schemastery 3.18.2→3.18.5、cosmokit 1.8.3→1.8.6（vendor 齐升不依赖 HMR 裁决，可独立执行）。
> corum override 钉 `cordis-plugin-hmr` 1.0.17（`:292`）、`cordis-plugin-include` 1.0.7（`:289`）、`cordis-plugin-timer` 1.1.4（`:294`）、`schemastery` 3.18.2（`:293`）、`cordis-plugin-group` 1.0.2（`:291`）；`desktop-host/package.json:53` dep `cordis-plugin-hmr ^1.0.16`。

#### 步骤 ⑥-1：desktop-host hmr dep（待阶段 -1 裁决）

> **前置**：阶段 -1 HMR 形态核查完成后，根据裁决结果决定此步骤动作。在裁决前**不修改** `desktop-host/package.json:53` 的 `cordis-plugin-hmr` dep。

| 文件 | 行号 | 当前 | 裁决后可能改为 |
|---|---|---|---|
| `packages/desktop/desktop-host/package.json` | `:53` | `"@deepseek-ai/cordis-plugin-hmr": "^1.0.16"` | 视阶段 -1 裁决（可能改为 `"@deepseek-ai/dsh-hmr": "0.2.1-rc.3"` 或保留并升级版本） |

#### 步骤 ⑥-2：pnpm-workspace override 改名 + 版本齐升

> **HMR override 行（`:292`）待阶段 -1 裁决后处置**；vendor 齐升（include/group/schemastery/timer/cosmokit）不依赖 HMR 裁决，可独立执行。

| 行号 | 当前 | 改为 |
|---|---|---|
| `:289` | `'@deepseek-ai/cordis-plugin-include': '1.0.7'` | `'1.0.10'` |
| `:291` | `'@deepseek-ai/cordis-plugin-group': '1.0.2'` | 检查 0.2.1 官方版本后决定（0.2.1 `vendor/group/` 存在） |
| `:292` | `'@deepseek-ai/cordis-plugin-hmr': '1.0.17'` | **待阶段 -1 裁决**（可能删除改为 `dsh-hmr` override，或保留并升级版本） |
| `:293` | `'@deepseek-ai/schemastery': '3.18.2'` | `'3.18.5'`（或 `link:vendor/schemastery` 跟官方） |
| `:294` | `'@deepseek-ai/cordis-plugin-timer': '1.1.4'` | `'1.1.7'` |

> 另需检查 `cosmokit` 是否有 corum override（官方 `link:vendor/cosmokit`），若有则版本跟随 1.8.3→1.8.6。
> `dsh-client-hmr`（`:73` override + `:327`/`:514` 历史 ignore）是 0.1.5 的客户端 hmr 包，需确认 0.2.1 是否仍存在或也被 `dsh-hmr` 取代。

#### 步骤 ⑥-3：组合行处理（待阶段 -1 裁决）

corum 的组合文件（`packages/desktop/cordis.patch.yml` + `profile/corum/cordis.patch.yml`）当前**无 hmr 行**（grep 零命中）——hmr 行来自官方 `base/cordis.patch.yml`，corum 不覆写。

阶段 -1 裁决后确认：
- corum 是否有依赖 `cordis-plugin-hmr` API 的自定义代码（grep `cordis-plugin-hmr` 源码）。
- `dsh-hmr` 的职责与适用面（阶段 -1 已核查 `apps/cli/README.md` + `packages/boot/hmr/package.json`）。
- 是否需要在 corum 自身组合文件中改 hmr 行。

#### 步骤 ⑥-4：loader 升级验证

loader 1.0.3→1.0.6 是 cordis-plugin-loader 的 patch 升级，影响 plugin 加载行为。升级后需跑 fork-drift 守卫确认 loader 行为无回归。

#### 步骤 ⑥-5：重编译 + pnpm install 可解析验证

```bash
pnpm install  # 全量解析（此时所有 6 个处置对象已改完）
```

验证：
```bash
grep -rn "cordis-plugin-hmr" packages/ --include="*.ts" --include="*.json" | grep -v "node_modules" | grep -v "minimumReleaseAgeExclude"
```
零命中。

#### 步骤 ⑥-6：提交

```bash
git add packages/desktop/desktop-host/package.json pnpm-workspace.yaml
git commit -m "upgrade(0.2.1-rc3): HMR 形态核查（阶段 -1 裁决后）+ vendor 齐升"
```

---

## 5. 验收标准（退出门禁）

| # | 门禁项 | 验证命令 | 通过标准 |
|---|---|---|---|
| 5.1 | pnpm install 全量可解析 | `pnpm install` | 0 error，无 0.1.5 包名残留 |
| 5.2 | 4+1+1 处置对象全清 | 见下方 grep 矩阵 | 全部零命中 |
| 5.3 | 全仓 grep 旧包名零命中 | 见下方 grep 矩阵 | 仅允许 `docs/` 与 `minimumReleaseAgeExclude` 历史段 |
| 5.4 | tsc -b --force 0 错 | `pnpm -r run typecheck` 或 `tsc -b --force` | 0 error |
| 5.5 | 相关包测试绿 | `pnpm --filter @corum/corum-subagent test` 等 | 全通过 |
| 5.6 | fork-drift 守卫不误报 | `DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.2.1-rc.3 ./scripts/verify-fork-drift.sh` | invariant.ts 相关断言不红 |

### grep 矩阵（退出门禁 5.2/5.3）

```bash
# ① dsh-invariants（全仓零命中，仅允许 minimumReleaseAgeExclude 历史段）
grep -rn "dsh-invariants" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude
# 预期：0 命中

# ② dsh-code-runtime / dsh-code-runtime-worker-thread（全仓零命中）
grep -rn "dsh-code-runtime" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude
# 预期：0 命中

# ③ dsh-subagent-in-process-driver（全仓零命中）
grep -rn "dsh-subagent-in-process-driver" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude
# 预期：0 命中

# ④ dsh-agent-presets（全仓零命中）
grep -rn "dsh-agent-presets" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude
# 预期：0 命中

# ⑤ dsh-session-title 旧 API（全仓零命中）
grep -rn "registerSessionTitleLlmProvider\|generateSessionTitleWithLlm" packages/ --include="*.ts" | grep -v node_modules
# 预期：0 命中

# ⑥ cordis-plugin-hmr（全仓零命中，仅允许 minimumReleaseAgeExclude 历史段）
grep -rn "cordis-plugin-hmr" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v minimumReleaseAgeExclude
# 预期：0 命中

# 附：invariant.ts 文件不存在
find packages/plugins -name "invariant.ts" -path "*/src/*" 2>/dev/null
# 预期：0 命中

# 附：lib/invariant.js 残留
find packages/plugins/agent -name "invariant.js" -o -name "invariant.d.ts" 2>/dev/null
find packages/desktop/build/host/node_modules/@corum -name "invariant.js" -o -name "invariant.d.ts" 2>/dev/null
# 预期：0 命中
```

---

## 6. 风险与缓解

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 6.1 | `@corum/plugin-build` 硬编码 `clean: false`，删 src 后 `lib/invariant.js` 残留进闭包 | **高** | 步骤 ①-8 显式 `rm lib/invariant.js lib/types/invariant.d.ts`（4 包）+ 清 `build/host/node_modules` 闭包残留 |
| 6.2 | `scripts/verify-fork-drift.sh` 自身引用 `invariant.ts`，不改则守卫误报 | **高** | 步骤 ①-7 改 `:1129` 循环清单 + `:1180` `SUBAGENT_DELTA_FILES` |
| 6.3 | `corum-tools/tests/invariant.spec.ts:7` import 官方子路径 `@deepseek-ai/dsh-tools/invariant`（官方也删了），若只删 InvariantRegistry import 会漏 | **中** | 步骤 ①-4 整文件删除 `corum-tools/tests/invariant.spec.ts` |
| 6.4 | `corum-subagent/tests/continuation.spec.ts:723-724` 挂载行只挂载不断言，但删 import 后可能编译失败 | **中** | 步骤 ①-4 同步删 `:17`/`:24`/`:723-724` 四行，编译后验证 |
| 6.5 | `corum-agent` 的 preset 面改写量取决于阶段 -1 映射结果，`import type {}` 空类型导入可能掩盖真实消费 | **中** | 步骤 ④-1 确认 `:378` 注释的 agentPreset 投影逻辑是否需要新包 `dsh-agent-preset` 的等价接口 |
| 6.6 | `dsh-hmr` / `cordis-plugin-hmr` 形态未核实就替换 dep/override | **高** | 步骤 ⑥-1/⑥-2/⑥-3 待阶段 -1 裁决后再执行；禁止未核实就替换 |
| 6.7 | vendor 齐升（loader 1.0.3→1.0.6 等）可能影响 plugin 加载行为 | **中** | 步骤 ⑥-4 升级后跑 fork-drift 守卫 |
| 6.8 | UI 包构建三步缺一不可（`tsc -b && tsdown && node scripts/inline-css.mjs`） | **中** | 步骤 ②-3/④-5/⑤-5 的 UI 包重编译必须三步全跑 |
| 6.9 | `desktop-host/package.json` 4 处被删包 dep（`:60`/`:75`/`:86`/`:114`）必须同步改 | **高** | 各处置对象步骤均含 desktop-host 改动 |

---

## 7. 回滚方案

### 原则

- 每个处置对象独立 commit，可逐个 `git revert <hash>`。
- `dsh-invariants` 删除单独一个 commit（步骤 ①-9），可独立 revert。
- 回滚后需同步恢复 `build/host/node_modules` 闭包（重新 `pnpm install` + `pnpm deploy --legacy`）。

### 回滚矩阵

| 处置对象 | commit message | revert 影响 |
|---|---|---|
| ① dsh-invariants | `upgrade(0.2.1-rc3): 删除 dsh-invariants（方案 A 跟随官方）` | 恢复 4 包 invariant.ts + dep + external + 测试 + lib 产物；需手动 `pnpm --filter <pkg> run build` 重生成 lib |
| ② code-runtime 更名 | `upgrade(0.2.1-rc3): dsh-code-runtime → dsh-ptc-runtime 更名` | 恢复旧包名 import + dep |
| ③ in-process-driver | `upgrade(0.2.1-rc3): 删除 dsh-subagent-in-process-driver 依赖` | 恢复 dep + override |
| ④ agent-presets | `upgrade(0.2.1-rc3): dsh-agent-presets → profile YAML + dsh-agent-preset` | 恢复旧包名 import + dep；profile YAML 迁移需手动回退 |
| ⑤ session-title-llm | `upgrade(0.2.1-rc3): dsh-session-title 版本跟随 + -llm provider API 迁移` | 恢复旧版本号；provider API 迁移需手动回退 |
| ⑥ hmr + vendor | `upgrade(0.2.1-rc3): HMR 形态核查（阶段 -1 裁决后）+ vendor 齐升` | 恢复旧 vendor override + dep |

### 回滚后验证

```bash
pnpm install  # 确认可解析
pnpm --filter @corum/corum-subagent run build  # 确认编译
```

---

## 8. 产出物与下游接口

### 本册产出

| 产出物 | 说明 |
|---|---|
| 6 个独立 commit | 每个处置对象一个，消息格式 `upgrade(0.2.1-rc3): ...` |
| 修改的文件清单 | 见各步骤，总计约 30 个文件改动点 |

### 下游接口（本册完成后，阶段 2/3/4 的前置条件）

| 下游阶段 | 依赖本册的什么 | 接口判据 |
|---|---|---|
| 阶段 2（override 重算） | 本册已删除/改名的 6 个包的 override 行已清理 | `pnpm-workspace.yaml` 无 0.1.5 旧包名 override（历史 ignore 段除外） |
| 阶段 2（override 重算） | `minimumReleaseAgeExclude` 历史段（`:307` 起）中 6 个包的条目需在阶段 2 清理 | 本册不动历史 ignore 段 |
| 阶段 3（fork rebase） | 4 个 fork 包已删 invariant.ts，corum-subagent 已改 driver 模块名 | fork-drift 守卫 `:1129`/`:1180` 已同步改 |
| 阶段 4（三层验证） | `pnpm install` 全量可解析 + `tsc -b --force` 0 错 | 本册退出门禁 5.1/5.4 |

---

## 9. 实录要求

### 执行实录格式

每个处置对象执行完毕后，在 `docs/UPGRADE-0.2.1-rc3.md`（升级总实录，新开文件）中追记：

```
## 阶段 1 · 处置对象 ①：dsh-invariants 方案 A
- 执行时间：YYYY-MM-DD HH:MM
- 执行者：<agent session id>
- commit hash：<hash>
- 实际改动文件数：<N>
- 验证结果：
  - pnpm install：✅/❌
  - tsc -b --force：✅/❌
  - 相关包测试：✅/❌
  - fork-drift 守卫：✅/❌
- 偏差记录：<与本册步骤的差异，若有>
- 遗留问题：<若有>
```

### 必须实录的偏差

如果执行中发现以下情况，必须立即停止并实录：
- 某个路径行号与实际不符（文件已被其他改动移动）。
- 某个处置对象的改动范围超出本册描述（发现了未列出的引用点）。
- `pnpm install` 报出本册未覆盖的 0.1.5 旧包名断链。
- 阶段 -1 的指南映射结果改变了某个处置对象的执行方式。

### 实录纪律

- 凡在对话里说过「要做/该修」的事必须落进实录（参考 `docs/PENDING-conductor-readonly-bash-and-progressive-research.md` 的教训）。
- 不许写与现场不符的承诺——实测状态与步骤描述不一致时，以实测为准并记录偏差。
