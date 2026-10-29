# corum 插件开发指南

> 面向**人**和**Agent** 的入口文档，随 `@corum/plugin-sdk` 一起发布（`node_modules/@corum/plugin-sdk/GUIDE.md`）。
> 规则正文（判据、白名单、版本的硬约束）在 `docs/PLUGIN-SPEC.md`；本文只讲**怎么快速做出来**。
> 所有命令与事实都在本仓实测过；每条后面的 `✅` 是验证方式。

---

## 0. 两条命令上手

```bash
npx corum-plugin-init --name @you/my-plugin --dir my-plugin     # 生成骨架（双半插件）
cd my-plugin && pnpm install && pnpm build                       # 构建出 lib/index.js + lib/client.js
```

生成的是**已经符合全部硬约束**的骨架：`exports` 词典、`dsh.client`↔`./client` 配对、三步构建、
依赖分层（SDK 进 `dependencies`、官方基座进 `peerDependencies`）、`files` 带 `cordis.patch.yml`、
`corum.plugin` 兼容声明。你不用记这些，改业务即可。

`--kind k1` 只生成宿主半（无 UI）。✅ 生成后 `pnpm build` 通过、`pnpm test` 通过（骨架自带冒烟测试）。

---

## 1. 三个包分别管什么

| 包 | 装在哪 | 管什么 |
|---|---|---|
| `@corum/plugin-sdk` | `dependencies` | **运行时唯一入口**：`definePlugin` / `Context` / `defineAgentTool` + `registerAgentTool` / `readSessionFacts` / `cdp-targets`（CDP 目标配置校验与路径解析）/ 客户端侧 `@corum/plugin-sdk/client` |
| `@corum/plugin-ui-contract` | `dependencies` | **允许碰的 UI 面**：右侧区域覆盖 + 设置 ›「扩展」里加一页；以及槽键白名单 |
| `@corum/plugin-build` | `devDependencies` | **构建契约**：`definePluginBundle`（banner/footer/externals/CSS 内联）+ `corum-inline-css` bin |

官方基座（`@deepseek-ai/*`）与 `react` 一律 `peerDependencies`（由宿主提供），并镜像进
`devDependencies`（保本包自己的 typecheck 能解析）。

✅ 判据：`cordis` / `dsh-client-ui-*` 只出现在 peer+dev；`@corum/plugin-sdk` 只在 dependencies。

---

## 2. 一个插件由什么组成

```
my-plugin/
  package.json        # exports / dsh.client / dsh.bundle / corum.plugin / files
  tsdown.config.ts    # 三行：definePluginBundle({ id, client })
  cordis.patch.yml    # 挂载层（没有它，插件不会被装载）
  tsconfig.json
  src/index.ts        # 宿主半：name / inject / apply
  src/client/index.ts # 客户端半（K2）：注册区域覆盖与设置页
  tests/
```

**宿主半**必需三个导出：`name`（与包名后缀一致）、`inject`（依赖的服务名数组）、`apply(ctx)`。
**客户端半**同理，但 `inject` 里通常要有 `slots`。

---

## 3. 插件能做四件事（这是全部）

### 3.1 提供宿主服务

```ts
export const inject: string[] = []
export function apply(ctx: Context): void {
  ctx.provide('myPlugin', { hello: () => 'hi' })
}
```
别的宿主插件可 `ctx.get('myPlugin')`；客户端半要读它，得自己开一条 RPC（见 3.4）。

### 3.2 给 Agent 加工具（插件"有意义"的分水岭）

```ts
export const inject = ['tools']            // ⚠️ 必须在 inject 里声明 tools
export function apply(ctx: Context): void {
  ctx.effect(() => registerAgentTool(ctx.tools, defineAgentTool({
    name: 'my_lookup',                     // ≤64 字符、仅 [A-Za-z0-9_-]
    description: 'Look something up. Tell the model WHEN to call it.',
    parameters: { query: { type: 'string', required: true, description: 'What to look up.' } },
    output: { schema: { type: 'string' }, render: (_a, text) => [{ type: 'text', text }] },
    async execute(args) { return `result for ${args.query}` },
  })))
}
```

硬约束（都被实测坑过）：
- `output: { schema, render }` **必填**，缺了 `register()` 直接 `TypeError`；
- `parameters` 是 dsh 自己的 DSL，必填是属性上的 **`required: true`**（不是 JSON Schema 的 `required: []`）；
- `output.schema` 写了 `additionalProperties: false` 时，**新增返回字段必须同步声明**，否则整条结果被 `INVALID_TOOL_OUTPUT` 吞掉；
- 必须**同步**注册（`ctx.effect` 会立即执行）：工具面在每回合开头快照，`await` 之后再注册会出现「第一回合没工具」；
- 注册随 fiber 撤销 ⇒ 插件卸载后工具从 Agent 工具面消失。

✅ 判据：注册后 `ctx.tools.schemas()` 里有它；`ctx.tools.execute({ name, arguments })` 能返回结果。
（本仓 `examples/region-replacement-plugin/tests/tool-injection.spec.ts` 就是照抄可用的范例。）

### 3.3 读当前会话资源（token / 轮次 / 子 Agent）

```ts
import { readSessionFacts } from '@corum/plugin-sdk'          // 客户端半
export const inject = ['connection']
export function apply(ctx) {
  const connection = ctx.get('connection')
  void readSessionFacts(connection, {}).then(f => {
    console.log(`${f.stats?.turns} 轮，上下文 ${Math.round((f.context?.usedRatio ?? 0) * 100)}%`)
  })
}
```

返回 `{ sessionId, title, running, attached, tokens, context, stats, subagents, warnings }`：

| 字段 | 语义要点 |
|---|---|
| `tokens.uncachedInputTokens` | 各次 `inputTokens` 之和（**不是** input − cacheRead） |
| `context.usedRatio` | `pressureTokens / contextWindow`，封顶 1 |
| `stats.turns` | 「有闭合 `step/end` 的 distinct turn」数 |
| `subagents[].progress` | 子 Agent 的 turn/step/currentAction/done/stopReason/todos |
| `attached` | `false` = 会话只在磁盘（用户没打开）⇒ 只有身份/子 Agent，token/轮次读不到 |

宿主半也可直调（`ctx.get('corumSessionFacts')`，签名是扁平的 `snapshot(sessionId?)`）。
**要"活"的数据别轮询这个**：客户端半直接订阅官方投影（`useProjection('tokenUsage')`）。

✅ 判据：`attached: true` 时 `tokens/stats` 与界面一致；`attached: false` 时 `warnings` 会明说原因。

### 3.3b 读写 CDP 目标配置（`cdp-targets`）

写 CDP 类插件（往某个 Corum 实例的 CDP 端口连）时，**不要**自己去解析/校验
`cdp-targets.json` —— 那套规则在 SDK 里只有一份，各写一份必然漂移。

```ts
import {
  resolveCdpTargetsPath,
  validateCdpTargetsConfig,
  disabledReason,
  CDP_TARGETS_VERSION,
} from '@corum/plugin-sdk'

const path = resolveCdpTargetsPath()                       // CORUM_CDP_TARGETS → CORUM_HOME → DSH_HOME → ~/.corum
const config = validateCdpTargetsConfig(JSON.parse(raw), path)   // 不合规直接抛 CdpTargetsConfigError
for (const target of config.targets) {
  const blocked = disabledReason(target)                   // 主实例护栏：9222 无 allowMain ⇒ 返回原因
  if (blocked !== null) continue
  // …连 target.ip:target.port
}
```

| 导出 | 语义要点 |
|---|---|
| `validateCdpTargetsConfig(raw, source?)` | **fail loud**：未知键/类型错/重复 id/重复 endpoint 全抛 `CdpTargetsConfigError`（带 `code` 与 `source`）。不做宽松回退——配置错了"凑合能用"会让用户在错的实例上做验证 |
| `resolveCdpTargetsPath(env?, homedir?)` | 优先级 `CORUM_CDP_TARGETS`（必须绝对路径）→ `CORUM_HOME` → `DSH_HOME` → `~/.corum` |
| `disabledReason(target)` | 唯一护栏：主实例端口 `9222` 未显式 `allowMain: true` ⇒ 返回禁用原因。**不在校验期拒绝**，让 target 出现在列表里标 disabled，用户能看到"为什么连不上" |
| `isMainInstancePort(port)` | 与 IP 无关的 9222 判定 |
| `sampleCdpTargetsConfig()` | 首次写盘的示例：`autoDiscover: true` + **空 targets**（刻意不写死端口——不同机器端口不同） |
| `CDP_TARGETS_VERSION` / `CDP_TARGETS_FILENAME` / `MAIN_INSTANCE_PORT` / `TARGET_ID_PATTERN` | 契约常量，别在插件里重复字面量 |
| 类型 `CdpTarget` / `CdpTargetsConfig` | **直接复用，别在本包重新声明一份**（`readOnly` 是可选，重复声明会漂移成与业务无关的编译错误） |

✅ 判据：`validateCdpTargetsConfig` 抛错时 `error.code === 'cdp-targets/config-invalid'`，
`error.source` 是你传入的来源标识。

### 3.4 覆盖右侧区域 / 加设置页（唯一允许的两处 UI）

```ts
import { registerRegionOverride, registerSettingsSection } from '@corum/plugin-ui-contract'
export const inject = ['slots']            // 注意：**不含 layout**
export function apply(ctx) {
  registerRegionOverride(ctx.slots, { slot: 'corum.editor', Component: Panel })   // 或 corum.trajectory / corum.panel
  registerSettingsSection(ctx.slots, { id: 'my-plugin.settings', label: () => '我的插件', Component: SettingsPage })
}
```

- 区域覆盖靠官方 slot 的 **priority 遮蔽**：宿主占 `0`，契约包用 `-1` 接管；卸载自动还原。
- 设置页注册 id 不在壳已知表里 ⇒ 自动落进 **设置 ›「扩展」** 分组。
- **布局归壳**：不要调 `showRegion` / `setRegionHidden` / `toggleRegion` / `resetLayout` / `closeRegion`；
  插件接管区域后壳会自己点亮它（`scripts/verify-plugin-ui-surface.mjs` 会拦这类调用）。
- 不能**新增**网格区域，也不能注册白名单外的槽（`conversation.*`、`settings.general.item` …）。

✅ 判据：装上后区域里渲染的是你的组件；设置里出现你的页；卸载后宿主原 occupant 回来。

---

## 4. 装进应用

> 公开层 6 个包已于 2026-10-20 全部发布（`0.6.0`；`@corum/plugin-sdk` 现为 `0.6.1`）：`@corum/plugin-sdk`、
> `@corum/plugin-ui-contract`、`@corum/plugin-build`、`@corum/corum-ui-base`、
> `@corum/corum-rpc-client`、`@corum/corum-platform`。
> **正常情况下只看 4.2 就够。** 已实测：干净工程 `pnpm add @corum/plugin-sdk`（自动带出
> ui-base + rpc-client）→ `npx corum-plugin-init`（k1/k2 两种）→ `pnpm install && pnpm build && pnpm test` 全通。

### 4.0 前提：仓库/镜像必须能解析 `@corum`

国内常用 npmmirror 做默认 registry 时，`@corum` 这类新 scope 往往还没同步 ⇒ `404 Not Found`。
在自己的 `.npmrc` 里单独把这一个 scope 指向官方：

```ini
@corum:registry=https://registry.npmjs.org/
```

（本仓 2026-10-20 实测：不配这一行，`pnpm add @corum/plugin-sdk` 会报
`ERR_PNPM_FETCH_404 … @corum%2Fplugin-sdk`。）

### 4.1 历史做法（发布之前才需要，保留供参考）

```bash
# 1) 打包插件 + 它依赖的未发布 @corum 包
pnpm pack --pack-destination /tmp/packs
(cd node_modules/@corum/plugin-sdk && pnpm pack --pack-destination /tmp/packs)   # 同上：ui-contract / ui-base / rpc-client

# 2) 在 profile 里把这些包指向本地 tarball
cd ~/.corum/profiles/web
cat > pnpm-workspace.yaml <<'YAML'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
overrides:
  '@corum/plugin-sdk': 'file:/tmp/packs/corum-plugin-sdk-0.6.0.tgz'
  '@corum/plugin-ui-contract': 'file:/tmp/packs/corum-plugin-ui-contract-0.6.0.tgz'
  '@corum/corum-ui-base': 'file:/tmp/packs/corum-corum-ui-base-0.6.0.tgz'
  '@corum/corum-rpc-client': 'file:/tmp/packs/corum-corum-rpc-client-0.6.0.tgz'
YAML

# 3) 装 + 加进 bundles
pnpm add /tmp/packs/corum-examples-my-plugin-0.1.0.tgz
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync("package.json"));
j.dsh.profile.bundles.push("@you/my-plugin");fs.writeFileSync("package.json",JSON.stringify(j,null,2))'

# 4) 重启应用（host 插件必须重启；renderer 才走 HMR）
```

### 4.2 正常路径（已发布）

```bash
# 你的插件从 npm 装进 profile，然后在应用里重启
cd ~/.corum/profiles/web && pnpm add @you/my-plugin
```

插件自己的依赖同理：`@corum/plugin-sdk` / `@corum/plugin-ui-contract` 进 `dependencies`，
`@corum/plugin-build` 进 `devDependencies`，**不需要任何 overrides**。
（本仓 2026-10-20 用干净工程实测：`pnpm add @corum/plugin-sdk` → `npx corum-plugin-init` →
`pnpm install && pnpm build && pnpm test` 全通。）

---

## 5. 调试与验证（按成本从低到高）

| 层 | 手段 | 能证明什么 |
|---|---|---|
| 1 | `pnpm typecheck && pnpm test && pnpm build` | 形态对、入口契约对、产物出得来（**不证明能装进应用**） |
| 2 | 检查 `lib/client.js` 第一行是 `window.__ModuleLoader__.load({ id: "<你的包名>", factory: …` | 闭包契约对（不是这形态 ⇒ 装进应用白屏） |
| 3 | 装进 profile 后调 `pluginManager/list`（或看应用日志） | 宿主半被装载、`fiberPhase=active` |
| 4 | 客户端半：`__DSH_BOOT__.entries` 里有你的 id，且 `/plugins/??<id>/client.js&rev=…` 返回 200 | 客户端半真的被浏览器加载（⚠️ 必须带 `rev`，不带一律 404） |
| 5 | 工具：`corumSessionFacts/toolNames` 里有你的工具名 | 进了模型可见工具面 |
| 6 | 终判：让 Agent 真跑一轮并调用你的工具，看会话事件 `tool/call` | 能调通（需要模型凭证） |

装坏了的自愈路径：启动预检会**跳过**坏插件、其余照常启动，并把原因写进
`$CORUM_HOME/boot-diagnostics.json`；应用里 **集成中心 › 插件 › 已装** 顶部会红框列出
「包名 + 原因 + 移除按钮」。

---

## 6. 常见错误对照表（按"现象"查）

| 现象 | 真因 | 修法 |
|---|---|---|
| 装上了但应用起不来 / 启动页卡住 | 打包产物缺挂载层（`files` 漏了 `cordis.patch.yml`） | 加进 `files`，重新打包安装 |
| 插件在列表里但界面没变化 | 只构建了宿主半；或客户端半 404 | 检查 `lib/client.js` 存在且是闭包；查 `__DSH_BOOT__.entries` |
| 区域被接管了但看不见 | 区域默认 hidden，而**你不该**自己点亮（布局归壳） | 确认壳版本 ≥ 0.6.0（壳会自动点亮被接管的区域） |
| 样式全丢（裸 UI） | 构建漏了 `corum-inline-css` 这一步 | 用 `definePluginBundle` 的三步 build，别手写 |
| 工具注册了但 Agent 不用 | 名字/描述没写「什么时候该调」；或注册晚于回合 | 描述里写清触发条件；注册放 `apply` 里同步执行 |
| 工具报 `INVALID_TOOL_OUTPUT` | `output.schema` 声明与实际返回不一致（常见于 `additionalProperties: false`） | 同步改 schema |
| `ERR_MODULE_NOT_FOUND` 装载失败 | `@corum/plugin-sdk` 被写进 `peerDependencies` | 挪到 `dependencies`（宿主只链安装闭包进 profile） |
| 两份基座实例 / 运行期静默炸 | 把 `@deepseek-ai/*` 写进 `dependencies` | 挪进 `peerDependencies` 并镜像 dev（`docs/fork-delta.md §18.1` 的事故形态） |
| RPC 调用报 `unexpected "sessionId"` | `@Remote` 参数用对象/本地 interface（SRC 解析不出字段表） | 用**扁平标识符**参数 |
| 改了 host 半但没生效 | host 插件不热更 | 重启应用 |

---

## 7. 给 Agent 的最小规则集

写/改插件时，Agent 必须先做这四件事：

1. **先看骨架**：`node_modules/@corum/plugin-sdk/GUIDE.md`（本文）+ 本仓 `examples/*`；
   新插件一律 `npx corum-plugin-init` 生成，不要手写 package.json。
2. **只用两处 UI**：区域覆盖（`corum.editor` / `corum.trajectory` / `corum.panel`）与
   `settings.section`。白名单外的槽、布局写入面（`showRegion` 等）**一律不许碰**。
3. **依赖分层不许改**：`@corum/plugin-sdk` → dependencies；`@deepseek-ai/*` + `react` → peer + dev 镜像。
4. **交付前跑三门禁**：`pnpm typecheck`、`pnpm test`、`pnpm build`；改的是本仓插件时再加
   `node scripts/verify-plugin-spec.mjs` 与 `node scripts/verify-plugin-ui-surface.mjs`。

禁止清单（违反即返工）：
- 手写 banner/footer/externals（用 `definePluginBundle`）；
- 在插件里改网格布局 / 新增区域 / 注册内部槽；
- 把状态放模块级单例或 window 全局（跨 bundle 会分裂，用 cordis 服务）；
- 在 `apply` 里 `await` 之后再注册工具；
- 声称"完成"却没跑 build（"编译过"不是完成）。

---

## 8. 版本与兼容

```jsonc
"corum": { "plugin": { "api": 1, "host": ">=0.6.0 <0.7.0", "kind": "bundle" } }
```

启动预检会校验：包可解析 / 有 `dsh.bundle.patch` / patch 可读 / 兼容声明满足。
任一条不过 ⇒ **该插件被跳过、其余照常启动**，并在启动页与诊断文件里给出精确原因。
`api` 覆盖四件事：`definePlugin`/`defineClientPlugin` 签名、`corum.plugin` 语义、公开层导出面、
slot 注册协议 —— 任一变更即 `api + 1`。

---

## 9. 索引

| 想了解 | 去哪 |
|---|---|
| 全部规则与判据 | `docs/PLUGIN-SPEC.md` |
| 最小可运行样例 | `examples/hello-plugin` |
| 区域覆盖 + 设置页 + 工具注入的完整样例 | `examples/region-replacement-plugin` |
| 包形态守卫 | `scripts/verify-plugin-spec.mjs` |
| UI 面守卫 | `scripts/verify-plugin-ui-surface.mjs` |
| 发布形态验收 | `scripts/verify-plugin-publish-shape.mjs` |
