# corum-desktop 交接摘要

> 本文件是给**全新上下文**接手的 Agent 看的。若当前会话已能看到完整对话历史，可跳过；但落盘一份供跨会话/跨工具使用最稳妥。
>
> **IDE 界面开发**（design.pen 严格还原 + S3 真实插件）交接见 [`docs/HANDOFF-ide-interface.md`](./HANDOFF-ide-interface.md)。

## 仓库与定位

- 仓库：`~/work/corum-desktop`（即本目录），**独立仓库**。
- 官方底座：`/Users/kukucai/dsh`（DeepSeek Harness checkout，**只读参照**，勿改）。
- 核心定位（路线 1）：DeepSeek Harness 为基座，**不改内核，只做用户空间**（插件 + overlay + preset + Electron 壳）。
- 承载层 shell 包：`packages/shell/`，包名 `corum-shell`。

## 当前状态（已核实）

- ✅ `pnpm install` 可跑通（`CI=true pnpm install --no-frozen-lockfile`）。
- ✅ `pnpm --filter corum-shell run build` **独立编译通过**。
- ✅ 桌面壳 smoke 通过：`node lib/cli.js --smoke` 输出 `corum-shell smoke: host child + IPC relay + renderer connection handshake OK`，exit 0。
- ✅ 桌面壳可创建并打开会话（已修复 preset 依赖缺失，见下文）。
- ⚠️ **code-editor（Monaco）已能渲染，已迁到常驻编辑器列**：注册进 `corum.editor` 槽（IDE 壳声明；极简模式无入口）。见「进行中工作」。
- ⚠️ **IDE 架构已切换（走查否决旧方案）**：「官方组件+玻璃皮」达不到设计稿，改为**壳 `@corum/ide-shell` + 功能插件组合**（`docs/PLAN-ide-architecture.md` + `docs/PLAN-ide-roadmap.md`）。
- ✅ **S0 壳可行性验证通过**（2026-08-17）：壳 `@corum/ide-shell` + 测试插件，「壳+槽位+插件组合」链路跑通，24 项 CDP 断言全过。
- ✅ **GridView 自由二维网格已落地（2026-08-18，当前主线）**：VSCode editor-group 式——分割树（拖放 split/swap/合并）+ **SplitView 绝对定位布局**（sash 零传导/缩放自适应不截断）+ localStorage 持久化 + 脱出浮动窗（运行时折叠/填满/dock-back/重启归位）+ 关闭区域可恢复 + 多实例 user-data-dir 隔离 + macOS 中文输入法记忆 patch。**详见下文「GridView 自由二维网格」段 + `docs/NOTE-vscode-gridview.md`。**
- ✅ **设计 Agent（`designer` preset）已建好并验证**：绑定 Pencil MCP（`mcp__pencil__*`），用 Pencil 桌面端产 `.pen` 设计稿。`agentPreset.list` 能发现、`session.create` 指定 `agentPreset: designer` 挂载成功、`[MCP] Starting server in stdio mode` 证明 MCP 子进程实际启动。
- ✅ **交互设计文档已产出**：`docs/interaction-design.md`，交给 `designer` preset 即可直接进入 pencil SOP 第 6/7 步。**硬性要求：深色/浅色双主题。**
- ✅ **视觉设计稿已产出（矩道 Corum Harness，2026-08-17）**：`doc/UXDesign/design.pen`（液态玻璃风，深浅两套独立页面 + 组件库 + Lucide 图标）。品牌定名**矩道 Corum Harness**（立矩成道 · Agent 成团开发 / powered by DeepSeek Harness）。**开发者读取指引见 `doc/UXDesign/HANDOFF-design.md`**；设计规范 token 见 `corum-harness-design-style.md`；动效规范见 `corum-harness-motion-spec.md`。品牌/背景图片资产在 `doc/UXDesign/images/`。
- ✅ **三个 client 插件 fork（presentation 层）**：`@corum/ui-settings-models`（模型设置页加「支持图片输入」开关）、`@corum/ui-model-selection`（切模型时 model-unavailable 从错误 toast 改成友好信息提示）、`@corum/session-archive`（会话日志归档）。均已 `cordis.patch.yml` disable 官方行 + insert fork 行，构建 + boot graph 验证通过。**自定义 Kimi 看图**：设置里勾选模型「支持图片输入」→ 写 `input: [text, image]`，即可传图给模型。
- ✅ **已切回 registry 依赖（2026-08-16）**：官方 npm 发布追平 master（`dsh-*` 统一 `0.1.0-rc.6`，`dsh-tasks-local` 已移除）。全部 `link:` 换成 registry 版本号，补齐 25 个 client UI 包为 shell 显式依赖。验证：`pnpm install`（966 包无 404）+ build + bridge boot 36 entries + `session.create` 全通。遗留：`pack-macos.mjs` 仍抄 dsh checkout 的 host 闭包（见待办）。详见 `docs/TODO.md`。
- ✅ **dsh 已升级 `0.1.0-rc.6` → `0.1.0-rc.7`（2026-08-18）**：10 个 package.json 全量 bump + `pnpm install` + 全包 build/typecheck + 双模式 smoke + `session.create` 全 preset 验证通过，零破坏性适配。注意：rc.7 RPC 协议要求 `ClientRequest` 信封（`{type:'client-request', rpcId, method, payload}`），preset 名是 `cordis` 不是 `corum`。**rc.7 重大变更参考**：slot 系统重构（single register/chain kind）、客户端加载内核重写（dsh-client-modules 两阶段 boot）、session-projection 重构。验证脚本：`packages/shell/scripts/test-presets.mjs`（bridge stdio 直调 session.create）。
- ✅ **框架修正：combo = 启动器 + 独立应用（2026-08-19）**：combo 从「进程内工作流切换」改为「壳层启动器」。纯壳（Electron 第一进程）不携带 DSH_HOME/dsh 内容（`cli.ts` 净化环境），启动后显示壳自带 combo 管理页（`corumapp://combo/index.html`，零 dsh 依赖静态页）；点击 combo → 壳按该 combo 注入 env/cwd/覆盖规则（`CORUM_COMBO_PLUGINS`/`CORUM_COMBO_PATCHES`）→ spawn 独立 host 子进程 → 窗口切换到 `corumapp://app/index.html?combo=<id>`。**每个 combo 是独立 Agent 产品（独立 composition / DSH_HOME / 插件集 / Agent）**。文件：`src/electron/combos.ts`（壳层数据模型 + `~/.corum-shell/combos.json`）、`combo-page.ts`、`main.ts`、`boot.ts`（combo 覆盖规则）。
- ⚠️ **旧机制已废弃（2026-08-19）**：进程内 comboLoad（`loader.create/remove` 动态插件切换）、渲染端 `combos.ts`/`ComboLauncher.tsx`（localStorage + `?combo=` 路由）已删除。dsh 的 `loader.create/remove` 动态插件能力本身仍存在（官方能力，`directory-picker-auto` 先例），但 combo 切换不再走此机制——combo 差异在进程级（独立 host）隔离。

## 依赖方案（关键）

**已完全切到 registry（2026-08-16）**：官方 npm 发布追平 master，`dsh-*` 统一 `0.1.0-rc.6`，`dsh-tasks-local` 已移除。**不再依赖 `/Users/kukucai/dsh` checkout**——只依赖官方发布的 npm 包，锁定版本，跟随官方升级。

- `dsh-*` 全系列 → `^0.1.0-rc.6`
- `cordis` 系列 → `cordis@^4.0.1`、`cordis-plugin-include@^1.0.6`、`cordis-plugin-loader@^1.0.2`（独立稳定版）
- 补齐 25 个 client UI 包为 shell 显式依赖（这些包在 registry 里**不在 `dependencies`，只被 cordis.patch.yml 的 insert 行引用**，link 时代靠 workspace BFS 发现，registry 时代必须显式声明）。
- 原生模块 build 脚本：`pnpm-workspace.yaml` 的 `allowBuilds`（pnpm 11 map 键）批准 `node-pty`/`koffi`/`protobufjs`/`dsh-subprocess-local`/`@google/genai`。
- Monaco：`monaco-editor@0.56.0`（registry）。
- peerDependencies：`react`、`react-dom`（`^18.2.0`，运行时由 dsh 客户端 seed 提供，不打包进 shell）。

**跟随官方升级**：升级只改版本号（`^0.1.0-rc.6` → 新版）+ `pnpm install`；打包态 host 闭包与 host manifest 均由脚本现场生成，无需改脚本。详见 `docs/TODO.md`。

## 编译配置（关键修复）

`tsconfig.base.json` 补上了官方底座同款的两项，否则 `.ts` 扩展名相对导入（源码里 `import ... from './boot.ts'` 等）无法编译：

```json
"allowImportingTsExtensions": true,
"rewriteRelativeImportExtensions": true
```

**注意**：改 tsconfig 后 tsc 增量缓存可能不重发旧的 `lib/` 产物，导致打包阶段残留 `.ts` 导入报 `UNRESOLVED_IMPORT`。遇到「类型检查过但 bundle 失败」时，先 `rm -rf packages/shell/lib` 再 build。

## 本地开发命令

```bash
cd ~/work/corum-desktop
CI=true pnpm install --no-frozen-lockfile   # 依赖有变更时
pnpm --filter corum-shell run build           # 独立编译（build:lib + bundle + css 内联）
pnpm --filter corum-shell run start           # 启动桌面壳（= node lib/cli.js）
pnpm --filter corum-shell run smoke           # = node lib/cli.js --smoke
packages/shell/scripts/dev.sh               # 开发模式：固定 dev home + 开启 HMR（推荐）
```

## 自我进化调试工作流（不中断任务，2026-08 新增）

桌面壳是三层进程，每层改动后的「生效成本」不同。**会话历史持久化在 `$CORUM_HOME/sessions/`**，所以只要 `CORUM_HOME` 不变，重启任何一层都不丢上下文。`scripts/dev.sh` 固定 `CORUM_HOME=.corum-dev-home` 并开启 HMR。

| 改动层 | 代码位置 | 生效方式 | 任务是否中断 |
|---|---|---|---|
| **渲染端 UI** | `src/client/**`、插件 `*/client` | 重建 `lib/client.js` → **自动热替换/刷新** | ❌ host/会话不动 |
| **宿主端** | `src/host/**`、`cordis.patch.yml` | 调 `window.corumDesktop.restartHost()` 热重启子进程 | ⚠️ 会话进程重启，历史落盘可恢复 |
| **Electron 主进程** | `src/electron/**` | 重启 App，重开会话 | ⚠️ 同上，可恢复 |

### 渲染端 HMR（改 UI 零中断）

- 开启：`CORUM_DEV_HMR=500`（轮询间隔 ms），`scripts/dev.sh` 已带。
- 链路：host 子进程 `modules.ts` stat 轮询每个 client bundle → `rebuilt(id)` 重算 rev → stdio 发 `hmr-rebuilt` → Electron main 转 `corum:hmr-event` IPC → preload → `src/client/hmr.ts` 热替换。
- **分级策略**（`hmr.ts` 的 `RELOAD_VIA_PAGE`）：
  - **core provider**（`corum-shell` wire root、`dsh-client-modules`）→ **页面刷新**。纤维热替换这些会重跑依赖级联，下游 `appShell` 无法可靠重挂，boot 审计报 `appShell service missing after settled`。页面刷新让整棵树干净重启，host/会话不动。
  - **叶子 UI 插件**（无底层服务被注入）→ **零刷新纤维热替换**（移植官方 `dsh-client-hmr` 算法：invalidate → prefetch → 卸旧 fiber → 挂新 fiber → 换 CSS）。
- 排障：dev 模式下渲染端 console 自动转发到终端（`main.ts` 的 `SMOKE || DEV` 分支）。看 `[corum-shell-hmr]` 日志：`bundle rebuilt`(host) → `main relay`(Electron) → `rebuilt notice received`(renderer) → `driver mounted`(刷新后重挂)。

### 宿主热重启（改 host/补丁）

- 渲染端调用 `window.corumDesktop.restartHost()`（或 DevTools console），或未来挂到 UI 按钮。
- `bridge-client.restart()`：杀旧子进程 → respawn → 新 `ready` 握手（graph 是新对象）→ `onReady` 触发 → `protocol.ts` 的 `update()` 换新 manifest → 重连 stream。窗口与渲染页保持。
- 会话断流后由 `connection-controller` 指数退避自动重连，历史从 `$CORUM_HOME/sessions/` 恢复。

### 关键文件

- `src/host/modules.ts` — `rebuilt()`/`onRebuilt()`/stat 轮询（`CORUM_DEV_HMR` 门控）
- `src/host/bridge.ts` — `hmr-rebuilt` stdio 上报
- `src/electron/bridge-client.ts` — `restart()`/`onHmr()`/`onReady()`
- `src/electron/protocol.ts` — `registerProtocols` 返回 `update()` 支持动态 graph
- `src/electron/preload.ts` / `src/client/ipc-bridge.ts` — `onHmrEvent`/`restartHost` 桥
- `src/client/hmr.ts` — 渲染端热替换驱动（移植官方算法 + 分级策略）
- `scripts/dev.sh` — 开发启动器（固定 home + HMR）

## 桌面壳跑起来（smoke/start）的沙箱注意

开发会话通常在文件沙箱下运行（workspace-write），会挡住 workspace 外写入。跑桌面壳时：

1. **Electron 二进制**：首次需下载，默认缓存到 `~/Library/Caches/electron` 会被沙箱拒绝。
   - 解法：`export electron_config_cache="$PWD/.electron-cache"` 后手动 `node node_modules/.pnpm/electron@43.4.0/node_modules/electron/install.js`，下载到 workspace 内。
2. **harness home**：host 会在 `~/.corum-shell`（`CORUM_HOME` 未设时的默认）写 profile/node_modules，会被沙箱拒绝。
   - 解法：`CORUM_HOME="$PWD/.corum-dev-home" node lib/cli.js`，重定向到 workspace 内。
3. 跑完清理 `.electron-cache`、`.corum-dev-home` 等临时目录。

> 无沙箱/已授权 full-access 的正常机器上，直接 `pnpm --filter corum-shell run smoke` 即可，无需上述重定向。

## 已修复的运行时问题（重要，勿回退）

1. **EPIPE 崩溃**：smoke 成功后 Electron 退出，host bridge 子进程往已关闭 stdout 写崩溃。`src/host/bridge.ts` 的 `send()` 已用同步写 + `EPIPE` 事件监听处理。
2. **插件清单读不到**：`pluginInventory/list` 等 Typert Remote 端点依赖 `connection.rpc.intercept('/api')`。桌面 overlay 禁用官方 `connection` 行后，`CorumDesktopConnection` 内部托管了 `HostConnectionService` 提供 `connection` 服务 + 用 `createSharedFetchHandler` 组合 Typert 拦截器与 ApiProxy fallback。见 `src/host/connection.ts`。
3. **添加工作区缺失**：`directory-picker-auto` 动态创建 host 后端 + client 表面成对 entry。禁用 `-auto` 后需手动补 `dsh-client-ui-directory-picker-native` 表面。见 `cordis.patch.yml`。
4. **会话无法创建（本轮关键修复）**：桌面 host 闭包缺 `@deepseek-ai/dsh-persona` 和 `@deepseek-ai/dsh-tool-ask-user` 两个 preset 依赖包，导致 `standard` preset 挂载失败 → `session.create` 返回 `agent-preset-invalid` → 桌面停留在「选择工作区开始」空态。**修复**：把这两个包加到 `package.json` dependencies（link），让 `healProfilesModuleFallback` 把它们 symlink 进 profile node_modules。`pack-macos.mjs` 也补了 packaged 布局的 backfill。
5. **dev 态 boot 报「loader entries failed to apply」（2026-08-17 registry 切换后）**：registry 的 isolated 布局下，`@deepseek-ai/dsh-base` 在 `packages/shell/node_modules` 里是 symlink（指向 `.pnpm/@deepseek-ai+dsh-base@.../`），其自身依赖（`dsh-agent`/`dsh-llm` 等）只经 `.pnpm` 的**兄弟 symlink** 解析。官方 `healProfilesModuleFallback` 的 `packageDirFromAnchor` 用 `createRequire(anchor).resolve.paths()`（**不 realpath** symlink anchor），从 symlink 路径看不到 `.pnpm` 兄弟 symlink → BFS 走到 `dsh-base` 后断链。**修复**：`src/host/boot.ts` 新增 `healProfilesModuleFallbackRegistry()`（realpath-aware 的官方 heal 复刻）+ `packageDirFromRealAnchor()`（先 `realpathSync(anchor)` 再 `resolve.paths`），替代官方 `healProfilesModuleFallback`。官方 monorepo 因 `workspace:*` 是真实目录不踩此坑；registry 版必须 realpath。
6. **「kkc→corum 迁移中间态」导致无法启动（2026-08-17，本次恢复）**：Agent 变更项目信息（kkc→corum）时，只改了**目录名**（`packages/plugins/session/kkc-ui-*` → `corum-ui-*`）和 **package.json 的 name**（`@kkc/*` → `@corum/*`），但 **`pnpm-lock.yaml` 没重新生成、`node_modules` 里的旧 `@kkc/*` symlink 没清理**。后果：lockfile 仍记 `@kkc/ui-model-selection` 等，`link:` 指向已不存在的 `kkc-ui-model-selection` 路径；`healProfilesModuleFallbackRegistry` 遍历到 shell 的 `@corum/*`（`workspace:*`）依赖时无法 resolve → profile node_modules 没有 `@corum/` symlink → loader 解析 `@corum/session-archive`/`@corum/ui-settings-models`/`@corum/ui-model-selection` 失败 → 插件树加载失败 → 无法启动。**症状**：`boot` 报 `failed to apply loader entry include (cordis:include): loader entries failed to apply`，子错误 `Cannot find package '@corum/*' imported from profiles/web/`。**修复**：`rm -rf packages/shell/node_modules/@kkc` 清残留 + `CI=true pnpm install --no-frozen-lockfile` 让 lockfile 从 `@kkc/*` 重写为 `@corum/*` 并正确 link。**教训**：改名 workspace 包（尤其涉及 `workspace:*` 依赖）时，改完 name/目录后必须**立即重跑 `pnpm install --no-frozen-lockfile`**，并检查 `node_modules/<scope>/` 里旧 scope 的 symlink 是否清干净。
7. **`dsh-settings-file` 缺失导致 settings 服务「中途消失」（2026-08-18 出现 → 2026-08-19 验证已解决 ✅）**：升级 rc.7 后，onboarding「内测声明」弹窗点「继续」报「暂时无法保存确认状态」。`settings.mutate` 曾返回 `settings service is absent: this deployment does not mount a settings provider (e.g. @deepseek-ai/dsh-settings-file) in its composition`。**根因与修复**：`dsh-settings-file` 包未在闭包里，补进 `packages/shell/package.json` + `desktop-host/package.json` 依赖后即解决（见 rc.7 升级 commit）。**2026-08-19 完整验证关闭**（三轮实测，不轻信文档遗留的排查方向）：
   - 纯 stdio 探针：`settings.describe` 连续 30 秒全 ok，`session.create` 前后均正常。
   - Electron 运行态：dev.sh 启动 + CDP 连入，渲染端 describe 全 200。
   - 端到端：删掉 `settings.yaml` 的 `ui-onboarding.welcomeNoticeVersion` → 重启 → 弹窗重现 → CDP 点「继续」→ `settings.mutate` 成功 → 弹窗关闭 → 配置正确落盘。
   - **教训**：当时文档里怀疑的「服务启动后被 dispose」「dshHome config 注入缺失」均为错误方向——实际就是缺依赖包，修复后没人回头验证 onboarding 流程，导致问题在 HANDOFF 里挂了「未解决」一天。**修复后必须跑一次真实 UI 流程验证，再更新文档。**
   - 验证方法参考：`CORUM_DEBUG_PORT=9223 bash scripts/dev.sh` 起实例 + ws 连 9223 用 CDP `Runtime.evaluate` 找按钮 `.click()`（onboarding 弹窗是 `role=dialog`，「继续」按钮文本匹配）。

## 桌面壳与官方 web UI 的差异排查模式（重要）

桌面壳跳过官方 CLI 的 `composeProfile`，且 overlay 会禁用一批官方「传输行」和「`-auto` 型动态装配插件」。排查「功能缺失」时优先看：

1. **Typert Remote 端点**（`pluginInventory/*`、`commands/*`、`goals/*`、`messageFeedback/*`）都走 `connection.rpc.intercept('/api')`，`connection` 服务没正确提供就全 404。
2. **`-auto` 型插件**（`directory-picker-auto`）动态创建「host 后端 + client 表面」成对 entry，禁用时必须成对补。
3. **preset 依赖包**：`standard`/`code`/`cordis` preset 的 `agent.cordis.yml` 引用的包（如 `dsh-persona`、`dsh-tool-ask-user`）必须在 host 闭包里可解析，否则 `session.create` 挂载 preset 失败。
4. **官方「浏览器式」插件与桌面 IPC 冲突**：`dsh-session-log-export` 走 GET `/api/session.export` 流式 + `a[download]` 浏览器下载，桌面 IPC 不支持流式 GET。桌面上要用原生对话框替代（见 session-archive 章节），并在 `cordis.patch.yml` 用 `- id: session-log-download / disabled: true` 禁用官方行，否则会出现「两个保存按钮 + 弹原生框时还残留『浏览器正在下载』dialog」。

## 桌面壳 Agent 预设的注入

桌面壳 boot（`src/host/boot.ts` 的 `bootDesktop`）不走官方 CLI 的 `composeProfile`，因此需要自己注入 `agent-presets` 的 shipped root。已修复：`boot.ts` 在 compose 后注入 `config.roots`，指向：

- `shipped-presets/corum`（本仓库 `.agent-presets/`，开发态回退到仓库根 `.agent-presets`）
- `shipped-presets/official`（官方 dsh `apps/cli/config/agent-presets/`）

`pack-macos.mjs` 打包时复制到 `host/shipped-presets/{corum,official}`。

**预设清理**：`.agent-presets/corum-dev/` 已移除（它只是官方 `cordis` preset 的定制副本，无实质差异）。官方 4 个 preset（`standard`/`code`/`minimal`/`cordis`）是 `trust: system`；`.agent-presets/` 下的产物（`designer`/`frontend` 等，经创造模式 `agentPresets.copy` 创建）是 `trust: user`。

### 关键坑：MCP `serverName` 必须进程内唯一

`@deepseek-ai/dsh-mcp-client` 对 `serverName` 做 **per-app 全局保留**（`activeServerNames` 是 keyed off `ctx.root` 的 `WeakMap`，同一 app 进程内所有 preset 共享）。撞名会在插件 load 时 throw，导致 preset 挂载失败 → 客户端静默回退到默认 preset（症状：选了新 preset 却自动变回「标准模式」）。

**后果**：给不同 preset 配 MCP 时，同一个 MCP 服务器（例如 Pencil）不能在不同 preset 里都用 `serverName: pencil`。当前 `designer` 用 `pencil`，`frontend` 必须用 `pencil-design`（工具名前缀也随之变成 `mcp__pencil-design__*`）。

**验证方式**：必须**同进程**先 `session.create` 一个 preset、再 `session.create` 另一个 preset 复现；单独逐个进程验证（每个 stdio 探针只 mount 一个 preset）永远测不出撞名。

### TODO：优化整个 DeepSeek Harness 的 MCP 服务机制

> 现状是「每个 preset 各自 spawn 一个 `mcp-client` 实例 + 一个 serverName 命名空间」，进程内靠 `serverName` 字符串去重，容易撞名、也造成同一个 MCP 服务器被多个 preset 重复 spawn。目标是**进程专用插件统一管理 MCP 服务**：

- **统一管理**：MCP 服务器（进程/连接）由 host-plane 的进程专用插件单例持有，保证进程内唯一，不再依赖「各 preset 手工约定不撞名」。
- **Agent 绑定**：使用层面 Agent 之间可自由配置「绑定哪个 MCP」，但底层的 MCP 连接由统一管理器持有，按需共享或复用（跨会话/跨 preset 单例）。
- **预期收益**：消除 `serverName` 撞名坑、避免同一 MCP 被多个 preset 重复 spawn 子进程、让「专人与专 MCP 绑定」这一设计哲学从「约定」变成「框架约束」。

**实现约束（铁律）**：只允许两种落点，**两者都不碰 `/Users/kukucai/dsh` 源码**：

1. **插件形式**（首选）：在 corum 仓库用户空间新增一个 host-plane 插件，作为「MCP 服务管理器」单例——它持有 MCP 连接/子进程，暴露一个「绑定」注册面给 preset 使用。preset 里不再各自写 `mcp-client` 行，改为引用该管理器的绑定配置。
2. **fork 官方插件覆盖**：fork `@deepseek-ai/dsh-mcp-client` 到 `packages/plugins/` 下改其保留/管理逻辑，经 `cordis.patch.yml` disable 官方行 + insert fork 行（沿用仓库已沉淀的 fork 模式）。仅在插件形式不足以承载时采用。

无论哪种，都走「用户空间 + overlay 覆盖」的既有纪律，与 README「不改内核，只做用户空间」一致。



## session-archive：日志强制落盘 + 原生导出/导入（2026-08 新增）

三项桌面差异化能力。归属判断：**传输/落盘/对话框属 shell 基础设施，UI 入口属插件**（符合「不改内核，只做用户空间」）。

### 1. 强制落盘（退出钩子）

- **问题**：`session-persistence-jsonl` 是 append-only + 到 turn/idle/dispose 才 flush。`Cmd+Q` 强退时缓冲尾段丢 → torn frame → 打开触发 repair（`.corrupt-bak-*`）。
- **实现**：`src/electron/main.ts` 的 `before-quit` → `bridge.sessionFlush()` → host `CorumSessionArchive.flushAll()` → `SessionStore.list() + flush()`，drain 完才 `app.exit(0)`。终端可见 `quit flush: N session(s) flushed`。

### 2. 原生保存对话框导出

- **问题**：官方「右上角下载」插件（`dsh-session-log-export`）走 GET `/api/session.export` 流式 Response + 浏览器 `a[download]`，桌面 IPC 只支持 POST unary，**流式走不通**。
- **实现**：渲染端 `window.corumDesktop.saveSessionLog(sessionId)` → Electron `dialog.showSaveDialog`（选路径）→ host `CorumSessionArchive.exportZip()` **复用官方 `apiProxy.downloads.sessionLog` 同一 ZIP 布局**（进程内调，不走 HTTP）→ main 写盘。

### 3. 导入

- **实现**：`window.corumDesktop.importSessionLog()` → `dialog.showOpenDialog`（多选）→ host `CorumSessionArchive.importZip()` 解 ZIP → 按 backend 的 **zstd 物理编码**（`node:zlib` 压缩，与桌面 store 一致）落到 `$CORUM_HOME/sessions/<project>/<id>/session.jsonl.zstd` → 下次 `session.list` 自动发现。已存在的 id 自动 skip（不覆盖 live store）。
- **媒体**（图片附件）v1 未还原（id 保持 referenced-but-absent）。

### 关键文件

- `src/host/session-archive.ts` — `CorumSessionArchive`（flushAll/exportZip/importZip），自包含 `projectKey`/`encodeSegment` 编码（包未导出 format 帮助函数）+ `node:zlib` 压缩。
- `src/host/bridge.ts` — stdio 消息 `session-flush`/`session-export`/`session-import`（二进制走 base64）。
- `src/electron/bridge-client.ts` — `sessionFlush/sessionExport/sessionImport` + `session-op-result` 分发。
- `src/electron/ipc.ts` — `corum:save-session-log`/`corum:import-session-log`（原生对话框）。
- `src/electron/preload.ts` + `src/client/ipc-bridge.ts` — `saveSessionLog`/`importSessionLog` 桥。
- `packages/plugins/session/session-archive/` — UI 插件：会话头部 `conversation.session.header.utilities` 的「保存日志到…」按钮 + 设置 `settings.general.item` 的「导入会话日志」行。包名 `@corum/session-archive`，作为 shell 的 `workspace:*` 依赖 heal 进 profile，`cordis.patch.yml` insert `session-archive` 行进 graph。

### 排障

- bridge stdio 直接发 `{type:'session-export',id,sessionId}` 可验证 host 导出；`{type:'session-import',id,zipBase64}` 验证导入。
- 导入的 artifact 物理格式：zstd 魔数 `28 52 2f fd`（`xxd` 看头 4 字节），解压首行是含 `id`/`cwd` 的 header。

## 打包方案（重要架构决策）

**已彻底脱离 dsh checkout（2026-08-17）**：`pack-macos.mjs` 用 `pnpm deploy` 从 `packages/shell/desktop-host`（dependency-only deploy 根，全 registry）物化 host 闭包，不再抄 `apps/desktop/build/host/node_modules`。

关键命令（官方 desktop 同款 flags，**`--config.node-linker=hoisted` 是正确性核心**）：

```bash
pnpm --filter corum-desktop-host deploy --legacy --prod \
  --config.node-linker=hoisted \
  --config.auto-install-peers=false \
  --config.link-workspace-packages=true <tmp>
```

- `hoisted` 让 deploy 把整个闭包（**含 peer 依赖**）平铺到顶层 `node_modules`（真实目录、只剩 `.bin` symlink）。这正是 `healProfilesModuleFallback` BFS 需要的布局——它用 `createRequire(host/package.json).resolve.paths()` 解析 profile 裸插件名；缺 hoisted 时是 `.pnpm` 隔离布局，peer 依赖（如 `dsh-llm` 的 peer `dsh-timeout`）只藏在 `.pnpm` 嵌套，boot 报「loader entries failed to apply」。
- `desktop-host` 的 72 个 registry 依赖 = 官方 desktop-host 36 基线 + shell host 直接导入 + preset 引用包 + mcp-client + fflate + 3 fork `workspace:*`。
- **host manifest 现场生成**：`writeHostManifest()` 从 corum-shell 的 `name`/`dsh`/`exports` + desktop-host 的 `dependencies` 合成 `build/host/package.json`，静态 `host-manifest.json` 已删（消除漂移）。
- 部署后 `materializeSymlinks` + `cleanupBrokenSymlinks` 物化残留 symlink（官方 legacy deploy 的坑）。
- `fetch-node.mjs` 只保留 NODE_MIRROR 下载回退，去掉了 dsh checkout 优先。

打包验证：DMG 构建需要 `hdiutil`（磁盘映像），需 `danger-full-access`。

## 进行中工作：IDE 壳 + 功能插件（架构 v3）

> **架构已切换（2026-08-17 走查后）**：详见 `docs/PLAN-ide-architecture.md`（技术方案）+ `docs/PLAN-ide-roadmap.md`（实施阶段）。旧「保留官方组件+玻璃皮」方案走查否决；新方向 = **单一壳插件 `@corum/ide-shell`（区域系统+槽位+主题+ambient）+ 一组独立功能插件（会话列表/资源管理器/编辑器/底部面板/状态栏/对话区…）往壳声明的槽位注册组件**。加功能 = 加插件包 + overlay 一行 insert。

**S0 已完成（2026-08-17 本轮）**：壳 `@corum/ide-shell` + 三个测试插件跑通「壳+槽位+插件组合」链路，24 项 CDP 断言全过。

1. ✅ **壳 `@corum/ide-shell`**（`packages/plugins/ui/ide-shell/`）：并入旧 corum-layout + corum-theme。区域系统声明 `corum.sidebar`/`corum.editor`/`corum.explorer`/`corum.tabStrip`/`corum.panel`/`corum.statusBar`/`corum.floating` + 重声明官方 `conversation`/`details`/`shell.overlay`/`sidebar.settings`（**故意不重声明官方 `sidebar`**——左列内容走 `corum.sidebar`）。几何求解（四栏让位链 + 拖拽把手 + 窄屏自动收起为 56px rail）+ 液态玻璃主题（corum-glass overrideTokens + 玻璃 CSS + ambient 光斑 + ThemePresenter）+ ctx.layout 面板动作面（官方三方法保语义 + editor/explorer/panel 扩展）。
2. ✅ **三个测试插件**：`@corum/ide-test-sidebar`（corum.sidebar 占位卡）、`@corum/ide-test-statusbar`（corum.statusBar 占位条）、`@corum/ide-test-panel`（corum.panel 占位 + togglePanel 验证）。注册统一走 `ctx.slots.inject(slotKey, cb)` 延迟解（声明即授权，与壳的注册顺序解耦）。
3. ✅ **接线**：`cordis.ide.patch.yml` disable 官方 `ui-layout`/`ui-sidebar`/`ui-workspace` 三行 + insert ide-shell + 三测试插件行；四包加进 shell `workspace:*` 依赖 + desktop-host 闭包。
4. ✅ **验证**：build + typecheck 全过；smoke 双模式过（极简 36 entries 不变 / IDE 37 entries）；CDP 走查脚本 `packages/shell/scripts/walkthrough-ide.mjs`（`CORUM_DEBUG_PORT=9222` 启动 + `node scripts/walkthrough-ide.mjs --mode ide|minimal`）——IDE 模式 24 项断言全过（四栏几何 1280 收缩 280/346/180、1600 全尺寸 280/430/210、状态栏 34、底部 150、窄屏 rail 56、拖拽把手、深浅双 token、ambient 光斑、三占位渲染、settings 座），产出 `build/walkthrough/s0-{light,dark,minimal}.png`；极简模式 6 项断言全过（官方壳零变化、无 corum 槽/token）。

**S0 踩坑记录**：
- **跨插件槽注册必须延迟**：内容插件直接 `ctx.slots.register` 进壳声明的槽会撞「slot not declared」（fiber 激活顺序不保）——统一 `ctx.slots.inject(slotKey, cb)`（壳的 EditorColumn 同款模式）。
- **list 槽注册需 `id`**：`corum.statusBar`（list kind）register 必须带 `id` 字段。
- **CDP 走查**：Electron 43（Chrome 150）已删 `Browser.getWindowForTarget`/`setWindowBounds`——改 `Emulation.setDeviceMetricsOverride` 调视口（壳的几何求解读自身 box，等价）。窗口尺寸断言是 track 值（border-box 减边框）。
- **主题翻转走真实链路**：console 直接改 body 属性不会重投影 inline alias token（主题是 overrideTokens 静态层，投影只在 theme/change 发生）——测试插件发布 walkthrough 专用 `window.__corumTestSetTheme`（`ctx.theme.setTheme` 桥）走真实偏好写 → theme/change → presenter 链。

---

## 进行中工作：GridView 自由二维网格（S0 之后的主线，2026-08-18）

> S0（壳可行性）完成后，主线是把壳升级为 **VSCode editor-group 式自由二维网格** + 周边硬化。设计/机制笔记见 `docs/NOTE-vscode-gridview.md`（必读，含 VSCode SplitView/GridView/Sash 机制提炼 + 我们的取舍）。

### 已完成（全部 commit，树干净）

**1. GridView 自由二维网格**（`packages/plugins/ui/ide-shell/src/client/{grid.ts,GridView.tsx,GridView.module.css}`）：
- **分割树模型**（grid.ts）：`LeafNode{slot,hidden?}` / `BranchNode{direction:row|column, children[], weights[]}`。操作：`dropLeaf`（拖到四边 split/中心 swap）/`removeLeaf`+`prune`（拖空自动合并）/`resizeBranch`（sash 相邻转移）/`rescaleGrid`（窗口缩放等比重标定）/`pathOfLeaf`+`insertLeafAtPath`（脱出路径还原）/`setLeafHidden`+`hiddenSlots`（关闭区域）+ 序列化（localStorage `corum.ide.grid.v1`，带 hidden `"h":1`）。
- **布局引擎 = VSCode SplitView 绝对定位 + JS 计算**（GridView.tsx `computeCellSizes` + `BranchView`）：容器 `position:relative` + ResizeObserver（rAF 节流），每格 `position:absolute`，`useLayoutEffect` 直接写 `left/top/width/height`（不经 setState）。**weights 是像素**。可见格按 weight 占比瓜分 span、min 150 夹取、Σmin 超容器时等比压缩（不溢出截断）。
- **窗格交互**：标题栏可拖到另一窗格上/下/左/右 split（HTML5 DnD + dropHint 高亮）/中心 swap；标题栏右侧 ⇱ 脱出、× 关闭；sash 拖拽相邻调整（VSCode Sash 机制：mousedown + window 监听 + 全局 cursor/user-select 样式）。
- **CDP 实测全过**：三缝拖动零传导（只相邻两列变）、窗口缩放等比不截断、拖 conversation 到 editor 上方成 column split、布局 localStorage 持久化 + 重启恢复。

**2. 脱出 / 浮动窗**：
- 拖出窗口外即脱出（dragend 越界 → `openFloating`）；浮动窗 = `?floating=<slotKey>` 独立 BrowserWindow（`titleBarStyle:'hidden'` 单层 Window Chrome），只 mount 该槽。
- **脱出是运行时状态，不动树/持久化**——主窗该位置被相邻格填满（detached 折叠为 0 + 相邻瓜分），dock back（浮动窗拖回主窗区域，Electron move 监听 + 中心点重叠 debounce）或关闭浮动窗即还原原位。重启后所有区域归位（这是修过的 bug：旧代码把 leaf 从树删了存盘导致重启丢区域）。
- **拖回实时吸附预览**：浮动窗拖动时 main 把坐标推主窗（`corum:floating-drag`），GridView 显示 dockPreview 高亮插入位置；停稳 ~350ms 才吸附（不再「手没放开就消失」）。

**3. 关闭区域（可恢复）**：
- 窗格标题栏 × 关闭 → leaf 标 `hidden`（树保留），相邻填满；状态栏右侧「已关闭 N 个区域 ▴」→ ClosedAreasMenu 下拉列出所有关闭项，点任意一个单独恢复（回原位置原尺寸）。hidden 持久化（重启保持关闭）。

**4. 多实例隔离**（修「IDE 启动卡死对话窗口」）：
- `main.ts`：每个实例独立 `userData`（`os.tmpdir()/corum-shell-ud-<mode>-<debugPort>`，`CORUM_USER_DATA_DIR` 可覆盖）——此前所有实例挤默认 `~/Library/Application Support/Electron`，共享 Chromium profile/锁/网络服务，IDE 崩溃/浮动窗传染对话窗口（`Render frame was disposed` + `Network service crashed`）。
- `sendToMain`（stream-frame/floating-change/hmr-event）加 `isDestroyed + isCrashed + try/catch` 防护。
- `scripts/dev.sh`（唯一启动脚本：默认纯壳 combo 启动器；`--combo=coding` 直接进 IDE 测试，独立 `.corum-dev-home` + user-data-dir + CDP）。

**5. macOS 中文输入法记忆**：
- 现象：聚焦 corum 窗口输入法切回 ABC。根因：vendored Electron.app `Info.plist` 无 `CFBundleLocalizations`，macOS 认为 app 只支持英文。
- 修：`scripts/patch-electron-locales.mjs` 加 `CFBundleLocalizations=[en, zh-Hans]` + `CFBundleAllowMixedLocalizations`（幂等；dev.sh 启动时自动跑）；electron-builder `extendInfo` 注入同键覆盖打包态。**注意**：per-app 记忆需用户在 app 里先用一次中文输入法才建立关联，之后启动/聚焦才切回。

**6. Code review 整改**（子 Agent review 后修）：2 blocker（跨向 split 包壳 weights=[1,1] 塌陷、双子根分支同向 drop 丢窗格）+ rescale 基准改测 mainRow + saveGrid 300ms debounce + **死代码大扫除**（stores 瘦身为 `{details,bottom}`、删 columns.ts、ILayout 删 7 个死方法 openEditor/toggleExplorer 等）。

### 关键机制（改代码前必读）

- **weights 语义 = 像素**（flexBasis/绝对定位 width），不是比例。比例分配在 `computeCellSizes`（可见格按 weight/Σweights × span）和 `rescaleGrid`（窗口缩放时等比重标定）里做。
- **传导 vs 自适应**：sash 拖动只走 `resizeBranch`（相邻两格像素转移，多余 delta 丢弃不外传）→ 零传导；自适应走 `rescaleGrid`/`computeCellSizes`（按比例）→ 两者分离。
- **折叠统一处理**：`BranchView.detached = 运行时脱出(detachedSlots) || leaf.hidden(持久化关闭)`，折叠格 size=0 不占 offset、相邻格瓜分。**脱出/关闭都不动树结构，只翻运行时/hidden 标记**。
- **浮动窗/关闭按钮入口**：⇱ 脱出（GridView leafPopOut）、× 关闭（leafClose）、状态栏「已关闭区域」恢复、「重置布局」回默认四列。

### 启动 / 验证

```bash
packages/shell/scripts/dev.sh               # 纯壳（combo 启动器，隔离 ud-minimal-noport）
packages/shell/scripts/dev.sh --combo=coding  # 直接进 IDE（coding）combo，独立 .corum-dev-home + CDP
# 验证：CI=true pnpm -r --filter './packages/**' run build / typecheck
# CDP 走查：CORUM_DEBUG_PORT=9222 bash scripts/dev.sh --combo=coding，ws 连 9222（见 scripts/e2e-grid.mjs / walkthrough-ide.mjs）
```

### 踩坑记录（本轮新增）

- **HMR 对 AppFrame 根结构改动热替换不干净**：改 GridView/AppFrame 布局结构后必须**重启实例**（`bash scripts/dev.sh --combo=coding`），否则实例跑旧 bundle——「点击没作用」「菜单一闪即关」多数是旧实例假象，先强制刷新/重启再判 bug。
- **9222 端口占用**：多实例/残留会占 `Cannot start http server for devtools`——`lsof -ti:9222 | xargs kill -9`。
- **pkill 误伤**：`pkill -f corumapp` 会杀渲染/helper 进程但留主进程 → 窗口卡死。只杀 `node lib/cli.js` 主进程让 Electron 正常退出。
- **CDP 选择器**：`[data-branch] > .branchCell` 在嵌套分支会重复命中；窗口缩放用 `Emulation.setDeviceMetricsOverride`（Electron 43 删了 Browser.setWindowBounds）。
- **「已关闭区域」菜单一闪即关**：「点击外部关闭」从 mousedown 改 document click + 按钮/菜单项 `stopPropagation`（打开菜单的同一次点击会被误判为外部）。

### 待办

- **S1（当前）**：骨架内容（ide-sidebar 品牌区+会话列表 / ide-explorer 文件树 / ide-editor Monaco / ide-panel-bottom 终端+待办+队列 / ide-statusbar 连接+项目+模型 + 对话区压玻璃主题），替换三个测试插件行（`cordis.ide.patch.yml` 的 ide-test-sidebar/statusbar/panel/conversation）。**「添加新区域」能力待设计**（从已有槽位选未显示的加进网格 vs 任意新槽位 vs 复制现有区域——方向未定，见对话记录）。
- **S2**：对话区消息流全量重写（独立大工程，~4500 行官方 ui-conversation）。
- **S3**：浮动窗打磨（`corum.floating` 槽已声明 + 机制已通，跨窗状态同步是后续）；**S4**：动效打磨。
- GridView 遗留 minor（子 Agent review 报告 §二/§三，不阻塞 S1）：dragleave 抖动、zone 判定(25%)与高亮(50%)不一致、previewTarget 在 render 期读 DOM、DragHandle(AppFrame)/Sash(GridView) 两套 sash 实现可合并、detached 占位 swap 语义、嵌套 column 分支未 CDP 实测。

### 关键文件

- `src/client/editor/MonacoEditor.tsx` — Monaco React 封装
- `src/client/editor/CodeEditorView.tsx` — conversation.view 的 view（Phase 1 临时位）
- `src/client/editor/worker.ts` — Monaco worker 分发（`corumapp://app/monaco/*.worker.js`）
- `src/client/editor/monaco-modules.d.ts` — monaco 子路径类型 shim
- `src/client/index.ts` — view 注册（`ctx.inject(['slots'])` 延迟注册，**不能**顶层 `inject: ['slots']`，会死锁 wire root）
- `tsdown.config.ts` — worker iife entry + `inlineDynamicImports`（Monaco 必须内联单 bundle，否则 `__ModuleLoader__` 报 chunk miss）
- `scripts/inline-monaco-css.mjs` — 把 monaco CSS 注入 client.js `<style>`
- `src/electron/protocol.ts` — `corumapp://app/monaco/` 前缀服务 worker
- `scripts/pack-macos.mjs` — 打包时复制 worker + preset backfill

### Monaco 集成的关键技术点（踩坑记录）

1. **ESM 入口**：用 `monaco-editor/editor/editor.api`（exports `./*` 子路径），**不要**用 `monaco-editor` 主入口（会内联全语言 + LSP client + 全部 CSS）。
2. **chunk 拆分**：tsdown 默认 code-split Monaco 成多个 `.cjs` chunk，但 `__ModuleLoader__` 只加载单 bundle → 必须 `inlineDynamicImports: true`。
3. **worker**：Monaco 的 ESM worker 入口必须 bundle 成 iife classic 脚本（`tsdown.config.ts` 的 worker entry），走 `corumapp://` 协议加载。
4. **CSS**：monaco CSS 被 tsdown 提取成 `lib/style.css`，但 client 是 CJS 无法 import → `scripts/inline-monaco-css.mjs` 注入 `<style>`。
5. **wire root 死锁**：corum-shell 是 `inject: []` 的 wire root，注册 view 必须用 `ctx.inject(['slots'])` 延迟，**不能**顶层 `inject: ['slots']`（会与 runtime 的 connection 依赖成环）。

## 待办

- **IDE 壳 + 功能插件（当前主线）**：按 `docs/PLAN-ide-roadmap.md` 的 S0（壳可行性验证）→ S1（骨架内容）→ S2（对话区重写）→ S3（浮动窗）→ S4（动效）推进。详见「进行中工作」段。
- **交互设计稿**：已完成（`doc/UXDesign/design.pen`，深浅双主题，矩道 Corum Harness 液态玻璃风）。
- **pack-macos.mjs 已重构（2026-08-17）**：打包脚本不再抄 dsh checkout 的 host 闭包，改用 `pnpm deploy --legacy --prod --config.node-linker=hoisted ...` 从 registry 物化，彻底脱离 checkout。已验证：`node packages/shell/scripts/pack-macos.mjs` 完整跑通，`host bridge boots OK (ready emitted)`。剩余：完整 `pnpm pack`（electron-builder + hdiutil）未跑（需 danger-full-access），`designer` preset 打包态（MCP backfill）未验证。
- 签名/图标（打包产物未签名，用默认 Electron 图标）。
- **designer preset 打包态未验证**：`pack-macos.mjs` 的 MCP backfill 已做语法检查，完整 `pnpm pack`（需 hdiutil + danger-full-access）未跑；dev 态已验证。

## 给新 Agent 的提示

- 开发本仓库时，官方底座在 `/Users/kukucai/dsh`（只读参照），别在那里改代码。
- 官方包的 API/类型以 dsh checkout 里的源码 + `lib/types/*.d.ts` 为准。
- 改动 `packages/shell/package.json` 依赖后，用 `CI=true pnpm install --no-frozen-lockfile` 更新 lockfile。
- 插件命名随意、不加前缀，复用官方/社区插件为主（见 README「插件收录原则」）。
- **调试渲染进程**：Electron 43 的 `console-message` 事件是新签名 `(details, level, ...)`，`details.message` 才是消息文本。已在 `main.ts` 的 smoke 分支修好转发。开发态要抓 renderer console，跑 `node lib/cli.js --smoke` 看 `[renderer:...]` 输出。
- 验证宿主 API：用 bridge stdio 协议直接发 unary（`{type:'unary', id, pathname:'/api/...', body: {...client-request信封...}}`），看 host 确切报错。这是排查「UI 无响应」最快的方式。
- **环境变量前缀是 `CORUM_HOME`**（不是 `KKC_HOME`）：启动时 `CORUM_HOME="$PWD/.corum-dev-home" DSH_HOME="$PWD/.corum-dev-home" node lib/cli.js`。用错前缀会落到默认 `~/.corum-shell`（workspace 外，EPERM）。
- **改名 workspace 包后必须立即重跑 install**：改 `@corum/*` 这类 `workspace:*` 依赖的 name 或目录名时，改完立刻 `CI=true pnpm install --no-frozen-lockfile`，并检查 `node_modules/<scope>/` 旧 symlink 是否清理（见「已修复的运行时问题」第 6 条，这是本次无法启动的根因）。
- **bridge.ts 的 main catch 已增强**：会沿 `cause` 链打印 AggregateError 的子错误（loader 树失败时能看到具体是哪个 entry 失败）。这是本次排障加的，保留有价值。
- **GridView/布局改动后必须重启实例验证**：HMR 对 AppFrame/GridView 根结构改动热替换不干净（React 树需整树重挂），实例会跑旧 bundle造成「点击没作用/菜单一闪即关」假象。改完 `pnpm --filter @corum/ide-shell build` 后**重启 `bash scripts/dev.sh --combo=coding`** 再判 bug。
- **启动实例只用手动脚本**：`packages/shell/scripts/dev.sh`（唯一启动脚本：默认纯壳 combo 启动器；`--combo=coding` 直接进 IDE）。**不要 `pkill -f corumapp`**（误伤渲染/helper 进程致窗口卡死）；要停实例只 `pkill -f "node lib/cli.js"`。
- **CDP 走查**：`CORUM_DEBUG_PORT=9222` 起 IDE 实例，ws 连 `http://127.0.0.1:9222`（库：`ws`，根 node_modules 有）。参考脚本 `packages/shell/scripts/e2e-grid.mjs`、`walkthrough-ide.mjs`。9222 被占报 `Cannot start http server for devtools` → `lsof -ti:9222 | xargs kill -9`。

## fork 官方 client 插件的要点（本仓库已沉淀的模式）

fork 官方 presentation 层包（`dsh-client-ui-*`）到 `packages/plugins/session/corum-ui-*`，改完在 `cordis.patch.yml` disable 官方行 + insert fork 行。已做 3 个：`corum-ui-settings-models`、`corum-ui-model-selection`、`session-archive`。要点：

1. **复用 session-archive 的构建模板**：`tsconfig.json`（extends 根 base + jsx + DOM lib）、`tsdown.config.ts`（CLIENT_EXTERNALS 白名单 + `window.__ModuleLoader__.load` 闭包）、`scripts/inline-css.mjs`（tsdown 提取的 style.css 内联进 client.js）。
2. **`@deepseek-ai/cordis` 用 registry `^4.0.1`**（切 registry 后统一，不再用 link vendor/cordis）。历史：link 时代 fork 包的 cordis 若用 registry 版，dsh 包 `.d.ts` 里 `declare module '@deepseek-ai/cordis'` 的跨包 Context merge（`ctx.remote`/`ctx.modelDirectories`/`connection/reset` 事件等）会合并到不同物理实例导致 `TS2339`/`TS2353`；切 registry 后所有包同一 registry 版 cordis，实例统一，无需再 link。
3. **`noImplicitAny: false`**：link 的 `.d.ts` 泛型链路（`IApiClient` 等）比官方 paths 源码映射更粗，会在官方源码不报错的地方暴露 implicit any。在 fork 的 tsconfig 里关掉该检查。
4. **删掉官方 `src/invariant.ts`**（invariant companion，no-op），session-archive 就不带它。
5. **定制块用 `// CORUM-PATCH:` 注释围住**，官方升级时 `diff -ru` 对比官方目录与 fork 目录，只合并官方改动、保留 CORUM-PATCH 块。
6. **验证**：`pnpm --filter @corum/<name> run build` 后，跑 bridge 探针看 `graph.entries` 里 fork 行存在、官方行禁用、`clientPath` 指向 fork 的 `lib/client.js`。
