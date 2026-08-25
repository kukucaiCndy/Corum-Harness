# 待办 / 技术债

## [✅ 已解决 2026-08-16] npm 官方分发渠道已追平，`link:` 已切回 registry

**结论**：官方 npm 发布已追平 master，`dsh-tasks-local` 已移除，版本号统一到 `0.1.0-rc.6`。本仓库已从 `link:` 切回 registry 版本。

**切换明细**：

- `dsh-*` 全系列 → `^0.1.0-rc.6`（版本已对齐）
- `cordis` 系列 → `cordis@^4.0.1`、`cordis-plugin-include@^1.0.6`、`cordis-plugin-loader@^1.0.2`（独立稳定版）
- 补齐了 25 个官方 client UI 包（`ui-layout`/`ui-sidebar`/`ui-workspace`/`ui-theme`/`ui-tool`/`ui-cordis`/`api-gateway`/`typert-registry`/`cordis-client-runner` 等）为 shell 的**显式 dependencies**——这是关键修复：这些包在官方 registry 里**不在 `dependencies`（只被 cordis.patch.yml 的 insert 行引用），link 版靠 workspace 关系被发现，registry 版必须显式声明**。
- 原生模块 build 脚本：`pnpm-workspace.yaml` 的 `allowBuilds` 批准 `node-pty`/`koffi`/`protobufjs`/`dsh-subprocess-local`/`@google/genai`（pnpm 11 用 `allowBuilds` map，不是 `onlyBuiltDependencies` 数组）。

**验证**：`rm -rf node_modules pnpm-lock.yaml && pnpm install` 成功（966 包无 404）；`pnpm --filter corum-shell run build` 通过；bridge boot 36 entries（含全部 client 半）+ `session.create` 成功。

**遗留**：~~`pack-macos.mjs` 仍依赖 dsh checkout~~（已解决，见下）。

---

## [✅ 已解决 2026-08-17] 打包态 host 闭包完全脱离 dsh checkout

**结论**：`pack-macos.mjs` 已改为 `pnpm deploy --legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true` 从 `packages/shell/desktop-host`（dependency-only deploy 根，全 registry）物化 host 闭包，彻底不再依赖 `/Users/kukucai/dsh` 源码 checkout。`fetch-node.mjs` 也去掉了 dsh 优先、仅保留下载回退。

**关键修复**：`--config.node-linker=hoisted` 是正确性的核心——它让 deploy 把整个闭包（**含 peer 依赖**）平铺到顶层 `node_modules`（真实目录、只剩 `.bin` 的 symlink）。这正是 `healProfilesModuleFallback` BFS 需要的布局：它用 `createRequire(host/package.json).resolve.paths()` 逐级向上解析 profile 里的裸插件名；缺 hoisted 时是 `.pnpm` 隔离布局，peer 依赖（如 `dsh-llm` 的 peer `dsh-timeout`）只藏在 `.pnpm` 嵌套目录，导致 boot 失败「loader entries failed to apply」。

**host manifest 现场生成**：`writeHostManifest()` 每次 pack 从两个事实源合成 `build/host/package.json`，删除静态 `host-manifest.json`（消除漂移）：
- corum-shell 的 `name`/`dsh`/`exports`（heal 自链 app 名 + loader 解析 `corum-shell/*` 子路径）
- desktop-host 的 `dependencies`（75 个 host 侧 registry 包，BFS 只遍历真实存在的闭包，不含住在前端 dist 里的 client UI 包）

**补 3 个 preset peer 依赖（2026-08-17 全链路验证时发现）**：`session.create` 指定 `standard` preset 时返回 `agent-preset-invalid`，reason 是 `dsh-workflow`（`dsh-workflow-worker-thread` 的 peerDependency）不在闭包。已在 `desktop-host/package.json` 显式补：`dsh-compaction`、`dsh-pwsh-local`、`dsh-workflow`（三个都是 host 侧包的 peer，isolated 布局下 deploy 不平铺 peer，必须显式声明）。

**验证**：`node packages/shell/scripts/pack-macos.mjs` 完整跑通，产出 `build/host`（257 顶层包、0 symlink、全部关键包平铺），`host bridge boots OK (ready emitted)`。

**跟随官方升级**：`dsh-* → ^0.1.0-rc.6` 全部 registry 锁定；升级只需 bump 版本号 + `pnpm install`，deploy 闭包与 manifest 均从 package.json 现场生成，无需改脚本。

---

## [✅ 已解决 2026-08-17] dev 态 realpath-aware heal（registry isolated 布局）

**问题**：registry 的 isolated 布局下，`@deepseek-ai/dsh-base` 在 `packages/shell/node_modules` 里是 symlink（指向 `.pnpm/@deepseek-ai+dsh-base@.../`），其自身依赖只经 `.pnpm` 的**兄弟 symlink** 解析。官方 `healProfilesModuleFallback` 的 `packageDirFromAnchor` 用 `createRequire(anchor).resolve.paths()`（**不 realpath** symlink anchor），从 symlink 路径看不到 `.pnpm` 兄弟 symlink → BFS 走到 `dsh-base` 后断链 → dev boot 报「loader entries failed to apply」。

**修复**：`src/host/boot.ts` 新增 `healProfilesModuleFallbackRegistry()`（realpath-aware 复刻官方 heal）+ `packageDirFromRealAnchor()`（先 `realpathSync(anchor)` 再 `resolve.paths`），替代官方 `healProfilesModuleFallback`。官方 monorepo 因 `workspace:*` 是真实目录不踩此坑；registry 版必须 realpath。

---

## [✅ 已解决 2026-08-17] 全链路验证（编译 + dev 启动 + 打包 + 打包态运行）

- **dev 编译**：`CI=true pnpm --filter corum-shell run build` 通过（build:lib + tsdown bundle + monaco worker + CSS 内联）。
- **dev 启动**：`node lib/cli.js --smoke` 输出 `corum-shell smoke: host child + IPC relay + renderer connection handshake OK`（exit 0）。
- **打包 host 闭包**：`node packages/shell/scripts/pack-macos.mjs` 通过，`host bridge boots OK (ready emitted)`。
- **打包 app**：`electron-builder --mac --arm64` 产出 `corum Agent OS-0.1.0-arm64.dmg`（320MB）+ `-mac.zip`（322MB）。
- **打包态运行**：启动 `.app` 二进制输出 `[corum-shell] host child ready (36 client entries)` + `[corum-shell] window created` + renderer handshake OK，窗口常驻。
- **打包态 preset 挂载**：bridge stdio 直接发 `session.create`，`standard`/`code`/`minimal`/`cordis`/`designer` 全部 `ok: true`；`designer` 触发 `[MCP] Starting server in stdio mode` 证明 Pencil MCP 子进程实际启动。

> **注意**：`pnpm run` 会触发 pnpm 11 的 `verify-deps-before-run`，若 workspace state 记录过 `production: true`（例如曾跑过 `pnpm install --production`），每次 `pnpm run` 都会先自动 `pnpm install --production` 剥离 devDeps。**规避**：用 `CI=true pnpm install --no-frozen-lockfile` 恢复完整依赖 + 重置 state，或直接调 `packages/shell/node_modules/.bin/<tool>` 绕过 `pnpm run` 包装。

---

## [📍 进展快照 2026-08-25] Agent 地基已落地（corum-agent-dev）

**已落地并 CDP 实测通过**（详见 docs/agent-foundation/ 各文档进展标注）：
- 领域事件词汇（`corum/<域>/<动作>`）+ 项目级持久事件日志（scheduler-events.jsonl + fold 恢复）
- 调度器（任务队列 + 可阻塞循环 + 成员边界 + fold 重启恢复）
- 调度工具四件套（assign_task/list_team_tasks/complete_task/report_blocked，laneSetupHook 全会话统一装配）
- 泳道路由框架 LanePool（type → 独立泳道会话；标签语义待升级，机制不变）
- 阻塞依赖链（report_blocked 挂起 + 方案 A 反查唤醒 + causedBy 因果边）
- 卡住感知与三级干预（stalled 事件 + steer/cancel/reassign，PM 专属协调工具 + 用户 RPC）
- UI：AgentTestPanel 事件 tab（持久日志回放）+ 运行时面板（泳道 chips + 任务健康行 + 干预按钮）

**已知待办/下一步**：
- 第 1 步：`ctx.project` 数据层（任务/BUG/需求实体 + 权限网关），见 GAP §5
- session 标签语义（「需求ID + 类型」池路由 + 快照/回收），见 DESIGN §3.6/§3.7
- `causedBy` 目前只在阻塞派生/改派挂边，其他事件暂未填
- 队列条目完整 schema（entityType/label/source.via/priority 等）待数据层一并上

---

## [⚠️ 已记录 2026-08-25] 多 host 实例共享 CORUM_HOME 会双重派发

**现象**：dev 调试中 Ctrl+C 杀掉 dev.sh 包装脚本后，Electron 主进程退出但
`lib/bridge.js` host 子进程残留成孤儿；新实例启动后两个 host 各跑一个
AgentRuntime，共享同一 `scheduler-events.jsonl`，同一任务被两个实例双重派发
（事件流出现重复 `corum/task/started`）。

**已做的防御**：
- `AgentRuntime.startLoop()` 实例级防重入（`loopActive` 互斥），单 host 内
  不可能出现双 runLoop 互相覆盖唤醒点。
- fold 恢复是幂等的（事件唯一事实源）。

**遗留（后续可做）**：
- bridge 子进程应监听父进程断开自行退出（或 dev.sh trap 清理进程组）。
- 如需支持多实例共 CORUM_HOME，事件日志需加实例锁（`$CORUM_HOME/scheduler.lock`）
  或跨进程 leader 选举；当前约定「一个 CORUM_HOME 一个应用实例」。

---

## 相关决策记录

- 路线 1：DeepSeek Harness 为基座，不改内核，只做用户空间。见 README「插件收录原则」。
- 插件命名：随意起名，不加前缀，复用官方/社区插件为主。
