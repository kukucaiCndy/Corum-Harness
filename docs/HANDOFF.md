# corum-desktop 交接摘要

> 本文件是给**全新上下文**接手的 Agent 看的。若当前会话已能看到完整对话历史，可跳过；但落盘一份供跨会话/跨工具使用最稳妥。

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
- ✅ **设计 Agent（`designer` preset）已建好并验证**：绑定 Pencil MCP（`mcp__pencil__*`），用 Pencil 桌面端产 `.pen` 设计稿。`agentPreset.list` 能发现、`session.create` 指定 `agentPreset: designer` 挂载成功、`[MCP] Starting server in stdio mode` 证明 MCP 子进程实际启动。
- ✅ **交互设计文档已产出**：`docs/interaction-design.md`，交给 `designer` preset 即可直接进入 pencil SOP 第 6/7 步。**硬性要求：深色/浅色双主题。**
- ✅ **视觉设计稿已产出（矩道 Corum Harness，2026-08-17）**：`doc/UXDesign/design.pen`（液态玻璃风，深浅两套独立页面 + 组件库 + Lucide 图标）。品牌定名**矩道 Corum Harness**（立矩成道 · Agent 成团开发 / powered by DeepSeek Harness）。**开发者读取指引见 `doc/UXDesign/HANDOFF-design.md`**；设计规范 token 见 `corum-harness-design-style.md`；动效规范见 `corum-harness-motion-spec.md`。品牌/背景图片资产在 `doc/UXDesign/images/`。
- ✅ **三个 client 插件 fork（presentation 层）**：`@corum/ui-settings-models`（模型设置页加「支持图片输入」开关）、`@corum/ui-model-selection`（切模型时 model-unavailable 从错误 toast 改成友好信息提示）、`@corum/session-archive`（会话日志归档）。均已 `cordis.patch.yml` disable 官方行 + insert fork 行，构建 + boot graph 验证通过。**自定义 Kimi 看图**：设置里勾选模型「支持图片输入」→ 写 `input: [text, image]`，即可传图给模型。
- ✅ **已切回 registry 依赖（2026-08-16）**：官方 npm 发布追平 master（`dsh-*` 统一 `0.1.0-rc.6`，`dsh-tasks-local` 已移除）。全部 `link:` 换成 registry 版本号，补齐 25 个 client UI 包为 shell 显式依赖。验证：`pnpm install`（966 包无 404）+ build + bridge boot 36 entries + `session.create` 全通。遗留：`pack-macos.mjs` 仍抄 dsh checkout 的 host 闭包（见待办）。详见 `docs/TODO.md`。

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

**已完成（2026-08-17 本轮）**：

1. ✅ Monaco 已迁到常驻编辑器列：`EditorColumn.tsx` 注册进 `corum.editor` 槽（极简模式槽不声明 → 无编辑器入口）。
2. ✅ 液态玻璃主题骨架（overrideTokens + 玻璃 CSS + 光斑背景）已验证生效。
3. ✅ design.pen 四栏几何（会话列表 280 / 对话区 flex / 编辑器 430 / 资源管理器 210 + 底部 150 + 状态栏 34）+ 让步链已验证（CDP 实测 280/400/346/180）。
4. ✅ 占位插件 `corum-ui-theme` 已删。

**走查发现的问题（→ 架构切换的根因）**：对话区是官方「探索未至之境」hero、品牌区是 deepseek HARNESS、④ 资源管理器/⑥ 底部面板/⑦ 状态栏全空——「官方组件+玻璃皮」达不到设计稿。故切换为「壳+功能插件全量接管」。

**待办（按 PLAN-ide-roadmap.md）**：

- **S0（当前）**：建壳 `@corum/ide-shell` + 测试插件，验证「壳+槽位+插件组合」可行性（不碰真实业务）。
- **S1**：骨架内容（ide-sidebar/explorer/panel-bottom/statusbar + 对话区压玻璃主题）。
- **S2**：对话区消息流全量重写（独立大工程，~4500 行官方 ui-conversation）。
- **S3**：浮动窗；**S4**：动效打磨。
- 旧的 corum-layout / corum-theme 两个独立包将并入 `@corum/ide-shell`（迁移后删除）。

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

## fork 官方 client 插件的要点（本仓库已沉淀的模式）

fork 官方 presentation 层包（`dsh-client-ui-*`）到 `packages/plugins/session/corum-ui-*`，改完在 `cordis.patch.yml` disable 官方行 + insert fork 行。已做 3 个：`corum-ui-settings-models`、`corum-ui-model-selection`、`session-archive`。要点：

1. **复用 session-archive 的构建模板**：`tsconfig.json`（extends 根 base + jsx + DOM lib）、`tsdown.config.ts`（CLIENT_EXTERNALS 白名单 + `window.__ModuleLoader__.load` 闭包）、`scripts/inline-css.mjs`（tsdown 提取的 style.css 内联进 client.js）。
2. **`@deepseek-ai/cordis` 用 registry `^4.0.1`**（切 registry 后统一，不再用 link vendor/cordis）。历史：link 时代 fork 包的 cordis 若用 registry 版，dsh 包 `.d.ts` 里 `declare module '@deepseek-ai/cordis'` 的跨包 Context merge（`ctx.remote`/`ctx.modelDirectories`/`connection/reset` 事件等）会合并到不同物理实例导致 `TS2339`/`TS2353`；切 registry 后所有包同一 registry 版 cordis，实例统一，无需再 link。
3. **`noImplicitAny: false`**：link 的 `.d.ts` 泛型链路（`IApiClient` 等）比官方 paths 源码映射更粗，会在官方源码不报错的地方暴露 implicit any。在 fork 的 tsconfig 里关掉该检查。
4. **删掉官方 `src/invariant.ts`**（invariant companion，no-op），session-archive 就不带它。
5. **定制块用 `// CORUM-PATCH:` 注释围住**，官方升级时 `diff -ru` 对比官方目录与 fork 目录，只合并官方改动、保留 CORUM-PATCH 块。
6. **验证**：`pnpm --filter @corum/<name> run build` 后，跑 bridge 探针看 `graph.entries` 里 fork 行存在、官方行禁用、`clientPath` 指向 fork 的 `lib/client.js`。
