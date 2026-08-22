# 交接：dsh 基座升级 0.1.0-rc.7 → 0.1.1-rc.2 的兼容性处理

> 状态：**进行中，已暂停交接**。本文件记录已完成的修复、已定位但待决策的问题、关键证据与下一步选项，供下一个 Agent 接手。
> 日期：2026-08-21 · 分支：`feat/ide-s4-restore`

---

## 1. 背景与目标

- corum（kkc-desktop）fork 自 DSH，dsh 基座以 npm 依赖 `@deepseek-ai/dsh-*` 引用。
- 本地官方源码：`/Users/kukucai/dsh`（已同步到 tag `dsh-v0.1.1-rc.2`）。
- 用户要求把基座从 rc.7 升级到最新（registry next = `0.1.1-rc.2`）。

---

## 2. 已完成（已提交 git）

| 提交 | 内容 |
|---|---|
| `559cfea6` | chore: 升级 dsh 基座 0.1.0-rc.7 → 0.1.1-rc.2（fork 内联 injectBootManifest 适配） |
| `66146a10` | chore: pnpm-workspace 豁免 0.1.1-rc.2 dsh 包的最小发布时长策略 |
| `209f108d` | fix: 适配 dsh 0.1.1 引导协议——index 注入三段 bootInjections |
| （未提交） | fix: modules.ts 引导包 dsh-client-modules 无条件入 graph |

**版本对齐细节**：dsh 各包版本不齐——绝大多数升到 `0.1.1-rc.2`，但 `dsh-client-schema-form`、`dsh-client-web-react` 的 registry next 只有 `0.1.0-rc.7`（保持 rc.7）。cordis 系列（4.0.1 等）未动。改了 15 个 package.json + pnpm-lock.yaml + pnpm-workspace.yaml。

**构建/类型验证**：`pnpm typecheck`（15 插件包 + shell）✅、`pnpm build` ✅。

---

## 3. 已修复的两个破坏性变更（运行时已验证）

### 3.1 `injectBootManifest` 被官方移除
- rc.2 删除了 `dsh-client-modules` 导出的 `injectBootManifest`。
- **修复**：fork 在 [packages/shell/src/electron/protocol.ts](../packages/shell/src/electron/protocol.ts) 内联补回，并升级为 rc.2 的三段 `bootInjections` 协议（①inline queue facade 脚本 → ②blocking preload `dsh-client-modules`+`dsh-client-runtime` 两个 client.js → ③`__DSH_BOOT__` global）。

### 3.2 引导包 `dsh-client-modules` 不进 graph
- **现象**：`web boot: window.__ModuleLoader__ bootstrap facade is missing` → `client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js`。
- **根因（CDP 实证）**：`dsh-client-modules` 是模块系统自举包，由 HTML parser-preload 直接执行、**不经 cordis fiber 物化**；fork 的 `CorumDesktopModuleRegistry.flush()` 只收 `entry.fiber !== undefined` 的条目 → 把它滤掉了 → graph 缺它 → preload 404 → queue 缺 modules → boot 失败。
- **修复**：[packages/shell/src/host/modules.ts](../packages/shell/src/host/modules.ts) 新增 `BOOTSTRAP_PACKAGE`，`flush()` 里**无条件** `processOne(BOOTSTRAP_PACKAGE)`。
- **post-fix 验证（CDP）**：`__ModuleLoader__.mode: 'live'`、`__DSH_BOOT__` 含 modules+runtime、preload script 标签两条都在、client entries 40→41。引导阶段错误消失。

---

## 4. 待决策的核心问题（已定位，未修）

### 现象
```
@corum/ui-settings-models: require("@deepseek-ai/dsh-client-web-react")
  missed the module table — not a platform seed word, not a materialized module,
  and no registered package factory
```

### 根因（已查清，证据链完整）
官方 rc.2 把 `PLATFORM_MODULES`（共享 seed，见 `/Users/kukucai/dsh/packages/client/web/src/platform.ts`）从 **10 词砍到 7 词**，移除了：
- `@deepseek-ai/dsh-client-web-react`
- `@deepseek-ai/dsh-client-ui-attachment`
- `@deepseek-ai/dsh-client-schema-form`

官方在 rc.2 把这套 React 绑定**内化进 UI renderer**（commit `cf5e686408` "merge React bindings into UI renderer"），官方插件不再 import 这三个包。

但 corum fork 的多个插件**仍把它们当 external 引用**（构建时 tsdown `CLIENT_EXTERNALS`）：
- `packages/shell/tsdown.config.ts`（corum-shell）
- `packages/plugins/session/corum-ui-model-selection/tsdown.config.ts`
- `packages/plugins/session/corum-ui-settings-models/tsdown.config.ts`
- `packages/plugins/session/session-archive/tsdown.config.ts`
- `packages/plugins/ui/ide-shell/tsdown.config.ts`
- `packages/plugins/ui/shell-base/tsdown.config.ts`

这三个包**没有 `dsh.client` 声明**（不是 graph client bundle 包）、**也不在 rc.2 的 seed 里**，所以运行时模块表答不出 → import miss。

### 官方 rc.2 的外部解析契约（重要）
官方 `clientExternals`（`/Users/kukucai/dsh/packages/client/tsdown.client.ts` L415）：
```
external = PLATFORM_MODULES(基线7词) + PRELOADED_CLIENT_EXTERNALS + 包自己的 dsh.client.external 字段
```
即非基线的共享依赖要写在**包自己 package.json 的 `dsh.client.external`** 字段里。fork 插件把这三个写在了 tsdown.config 的 CLIENT_EXTERNALS（构建期），但**没写进 package.json 的 `dsh.client.external`**（运行期模块表查询依据）。

### 候选修复方案（用户未拍板，标"暂停交接"）
1. **inline 打包（改动最小）**：把这三个从各插件 tsdown `CLIENT_EXTERNALS` 移除，让 rolldown 打包进各自 bundle。⚠️ 风险：多份实例（每插件一份 web-react/React 封装），可能有跨插件单例冲突（slot renderer、snapshot selector 的 instanceof/Symbol 比较），需验证。
2. **fork 自建扩展 seed**：fork 引导处不用官方 `getStaticModules()`（锁死 `satisfies Record<PlatformModule>` 不可扩展），改用自己的扩展 seed 把 web-react 等加回。⚠️ 需 fork 整个前端引导链路（`AppWebEntry`），改动大。
3. **对齐官方架构**：fork 也把 React 绑定内化进自己的 UI 层，移除对这三个包的外部依赖。最彻底但工作量最大，接近小重构。
4. **回退基座到 rc.7**：rc.2 破坏性变更多，先退回保可用，后续再评估。

---

## 5. 调试环境（可复用）

- **CDP 端口**：`CORUM_DEBUG_PORT=9240`（main.ts 已支持，`remote-allow-origins: *`）。
- **启动**：`cd packages/shell && CORUM_DEBUG_PORT=9240 CORUM_DESKTOP_MODE=ide node lib/cli.js`
- **CDP 检查脚本**（在 /tmp，重启后需重写）：
  - `/tmp/cdp-inspect.mjs` — 查 `__ModuleLoader__` 状态、`__DSH_BOOT__` entries、preload script、console 错误、corump fetch。
  - 依赖 `ws`（路径 `node_modules/.pnpm/ws@8.21.3/node_modules/ws`）。
- **注意**：`corumapp://` 是自定义协议（standard+secure+fetch），页面 URL 形如 `corumapp://app/index.html?combo=coding`。

---

## 6. 给下一个 Agent 的建议

1. 先确认当前 graph 状态（跑 `/tmp/cdp-inspect.mjs` 或重写）——引导问题应已修复（mode=live）。
2. 聚焦 §4 的 web-react 脱节：这是当前唯一阻断点（`@corum/ui-settings-models` import 失败，可能导致部分插件 failed）。
3. 与用户确认 §4 的四个方案选哪个，再动手。方案 1（inline）最快验证：先改一个插件（如 corum-ui-settings-models）试 inline，看是否报单例冲突。
4. 提交前 `pnpm --filter <pkg> build` + 重启应用 CDP 验证。

---

## 7. 相关文件

- 升级适配：`packages/shell/src/electron/protocol.ts`（injectBootManifest 三段注入）
- 引导包入 graph：`packages/shell/src/host/modules.ts`（BOOTSTRAP_PACKAGE）
- fork 各插件 external 声明：上述 6 个 `tsdown.config.ts`
- 官方契约参考：`/Users/kukucai/dsh/packages/client/{web/src/platform.ts, web/src/seed.ts, tsdown.client.ts, modules/src/client/manifest.ts}`
- 项目规则：`.trae/rules/project.md`
