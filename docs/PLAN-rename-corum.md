# corum 全局重命名方案

> 目标：把 corum（fork 自 dsh 的桌面 IDE）的全局命名从当前不一致状态（`corum-shell` / `@corum/*` 无统一前缀 / `~/.corum-shell` / `~/.dsh` 混用）统一为产品名 **corum**，并给出可评审、可回滚、可验证的执行方案。

## 命名规则（新增插件必须遵循）

1. **产品名 = corum**：壳包叫 `corum-desktop`，所有第一方插件包统一 `@corum/corum-*` 前缀。
2. **不要出现 shell**：命名中禁用 `shell` 一词（唯一例外是 `corum-ui-base`，其语义已转为 UI 基础库而非壳）；界面相关统一叫 **ui**。
3. **正式 UI 插件 = 功能名 + `-ui` 后缀**：如 `@corum/corum-ide-ui`、`@corum/corum-ide-sidebar-ui`，用后缀区分功能插件（无后缀）与 UI 插件（`-ui` 后缀）。
4. **开发中插件 = 正式名 + `-dev` 后缀**：`-dev` 表示非正式版，用后缀而非前缀，如 `@corum/corum-agent-dev`、`@corum/corum-agent-ui-dev`；转正时去掉 `-dev` 即可。

## 决策已锁定

1. 产品名 = **corum**；壳包 `corum-shell` → `corum-desktop`，目录 `packages/shell` → `packages/desktop`
2. 命名中不出现 `shell`（`corum-ui-base` 除外，语义已转为 UI）；界面相关统一叫 **ui**
3. 正式 UI 插件 = 功能名 + `-ui` 后缀（`@corum/ide-shell` → `@corum/corum-ide-ui` 等）
4. 开发中插件 = 正式名 + `-dev` 后缀（`@corum/dev-agent` → `@corum/corum-agent-dev` 等）
5. `@corum/shell-base` → `@corum/corum-ui-base`（UI 基础组件库）
6. 桌面 home `~/.corum-shell` → `~/.corum`，需老目录迁移兼容
7. `~/.dsh` 退役：skill 全局目录语义不变，消除 home 初始化前真读 `~/.dsh` 的隐患

---

## A. 命名映射总表

### A.1 包名映射（20 个）

**壳包**

| # | 旧包名 | 新包名 | 旧目录 | 新目录 |
|---|--------|--------|--------|--------|
| 1 | `corum-shell` | `corum-desktop` | `packages/shell` | `packages/desktop` |

**UI 基础库**

| # | 旧包名 | 新包名 | 旧目录 | 新目录 |
|---|--------|--------|--------|--------|
| 2 | `@corum/shell-base` | `@corum/corum-ui-base` | `packages/plugins/ui/shell-base` | `packages/plugins/ui/corum-ui-base` |

**UI 插件（`-ui` 后缀）**

| # | 旧包名 | 新包名 | 旧目录 | 新目录 |
|---|--------|--------|--------|--------|
| 3 | `@corum/ide-shell` | `@corum/corum-ide-ui` | `packages/plugins/ui/ide-shell` | `packages/plugins/ui/corum-ide-ui` |
| 4 | `@corum/ide-sidebar` | `@corum/corum-ide-sidebar-ui` | `packages/plugins/ui/ide-sidebar` | `packages/plugins/ui/corum-ide-sidebar-ui` |
| 5 | `@corum/ide-explorer` | `@corum/corum-ide-explorer-ui` | `packages/plugins/ui/ide-explorer` | `packages/plugins/ui/corum-ide-explorer-ui` |
| 6 | `@corum/ide-conversation` | `@corum/corum-ide-conversation-ui` | `packages/plugins/ui/ide-conversation` | `packages/plugins/ui/corum-ide-conversation-ui` |
| 7 | `@corum/ide-panel-bottom` | `@corum/corum-ide-panel-bottom-ui` | `packages/plugins/ui/ide-panel-bottom` | `packages/plugins/ui/corum-ide-panel-bottom-ui` |
| 8 | `@corum/ide-statusbar` | `@corum/corum-ide-statusbar-ui` | `packages/plugins/ui/ide-statusbar` | `packages/plugins/ui/corum-ide-statusbar-ui` |
| 9 | `@corum/ide-test-sidebar` | `@corum/corum-ide-test-sidebar-ui` | `packages/plugins/ui/ide-test-sidebar` | `packages/plugins/ui/corum-ide-test-sidebar-ui` |
| 10 | `@corum/ide-test-conversation` | `@corum/corum-ide-test-conversation-ui` | `packages/plugins/ui/ide-test-conversation` | `packages/plugins/ui/corum-ide-test-conversation-ui` |
| 11 | `@corum/ide-test-statusbar` | `@corum/corum-ide-test-statusbar-ui` | `packages/plugins/ui/ide-test-statusbar` | `packages/plugins/ui/corum-ide-test-statusbar-ui` |

**开发插件（`-dev` 后缀）**

| # | 旧包名 | 新包名 | 旧目录 | 新目录 |
|---|--------|--------|--------|--------|
| 12 | `@corum/dev-agent` | `@corum/corum-agent-dev` | `packages/plugins/agent/dev-agent` | `packages/plugins/agent/corum-agent-dev` |
| 13 | `@corum/dev-mcp-manager` | `@corum/corum-mcp-manager-dev` | `packages/plugins/agent/dev-mcp-manager` | `packages/plugins/agent/corum-mcp-manager-dev` |
| 14 | `@corum/dev-skill-manager` | `@corum/corum-skill-manager-dev` | `packages/plugins/agent/dev-skill-manager` | `packages/plugins/agent/corum-skill-manager-dev` |
| 15 | `@corum/dev-agent-shell` | `@corum/corum-agent-ui-dev` | `packages/plugins/ui/dev-agent-shell` | `packages/plugins/ui/corum-agent-ui-dev` |
| 16 | `@corum/dev-skill-manager-shell` | `@corum/corum-skill-manager-ui-dev` | `packages/plugins/ui/dev-skill-manager-shell` | `packages/plugins/ui/corum-skill-manager-ui-dev` |

**功能插件（加 `corum-` 前缀）**

| # | 旧包名 | 新包名 | 旧目录 | 新目录 |
|---|--------|--------|--------|--------|
| 17 | `@corum/project-core` | `@corum/corum-project-core` | `packages/plugins/agent/project-core` | `packages/plugins/agent/corum-project-core` |
| 18 | `@corum/session-archive` | `@corum/corum-session-archive` | `packages/plugins/session/session-archive` | `packages/plugins/session/corum-session-archive` |
| 19 | `@corum/ui-model-selection` | `@corum/corum-ui-model-selection` | `packages/plugins/session/corum-ui-model-selection` | `packages/plugins/session/corum-ui-model-selection`（目录名已含 corum-，仅包名对齐） |
| 20 | `@corum/ui-settings-models` | `@corum/corum-ui-settings-models` | `packages/plugins/session/corum-ui-settings-models` | `packages/plugins/session/corum-ui-settings-models`（同上） |

**目录名原则**：目录名与包名同步（去掉 `@corum/` 前缀），避免「包名与目录名不一致」的认知负担。例外：两个 `session/` 下目录名已含 `corum-`，保持不动。

### A.2 目录映射

| 旧目录 | 新目录 | 说明 |
|--------|--------|------|
| `packages/shell` | `packages/desktop` | 壳包目录；内部结构不变 |
| `packages/shell/desktop-host` | `packages/desktop/desktop-host` | 随父目录搬迁 |
| `packages/shell/.corum-ide-home` | `packages/desktop/.corum-ide-home` | dev home 目录随仓库搬迁 |
| `packages/shell/.kkc-dev-home` | `packages/desktop/.kkc-dev-home` | 同上 |
| `packages/shell/.kkc-pack-home` | `packages/desktop/.kkc-pack-home` | 同上 |
| 各插件目录 | 见 A.1 表 | 目录名与包名同步 |

**pnpm workspace 影响**：`pnpm-workspace.yaml` 的 `packages:` 列表需同步更新（`packages/shell` → `packages/desktop`，`packages/shell/desktop-host` → `packages/desktop/desktop-host`）。改完后必须 `pnpm install` 重建 workspace 链接。

### A.3 home/路径映射

| 旧路径 | 新路径 | 说明 |
|--------|--------|------|
| `~/.corum-shell` | `~/.corum` | 桌面 home 根目录（`CORUM_HOME` 环境变量不变） |
| `~/.corum-shell/combos.json` | `~/.corum/combos.json` | 壳层 combo 配置 |
| `~/.corum-shell/.agent-presets/` | `~/.corum/.agent-presets/` | Agent 预设目录 |
| `~/.corum-shell/mcp-servers.json` | `~/.corum/mcp-servers.json` | MCP 服务注册表 |
| `~/.corum-shell/plugins.disabled.json` | `~/.corum/plugins.disabled.json` | 插件启停清单 |
| `~/.corum-shell/settings.yaml` | `~/.corum/settings.yaml` | 设置持久化 |
| `~/.corum-shell/memory/` | `~/.corum/memory/` | Agent 记忆目录 |
| `~/.corum-shell/sessions/` | `~/.corum/sessions/` | 会话持久化 |
| `~/.corum-shell/profiles/node_modules/` | `~/.corum/profiles/node_modules/` | profile 依赖 symlink |
| `~/.corum-shell/.credentials.yaml` | `~/.corum/.credentials.yaml` | 凭据存储 |
| `~/.corum-shell/storages/` | `~/.corum/storages/` | 命名存储 |
| `~/.corum-shell/attachments/` | `~/.corum/attachments/` | 附件内容寻址存储 |
| `~/.dsh` | **退役** | skill 全局目录语义不变（仍指向 `~/.dsh/skills/`），但消除「home 初始化前真读 `~/.dsh`」的隐患 |

**home 内内容不变**：目录结构、文件名、文件格式均不变，仅根目录改名。

---

## B. 每个改名点的精确影响清单

### B.1 壳包 `corum-shell` → `corum-desktop`

| 文件 | 行号 | 当前内容 | 改动 |
|------|------|----------|------|
| `packages/shell/package.json` | 2 | `"name": "corum-shell"` | → `"corum-desktop"` |
| `packages/shell/package.json` | 10 | `"corum-shell": "lib/cli.js"` | → `"corum-desktop": "lib/cli.js"` |
| `packages/shell/package.json` | 63 | `"appId": "com.corum.agentos"` | 保留（已是 corum） |
| `packages/shell/package.json` | 64 | `"productName": "corum Agent OS"` | 保留（已是 corum） |
| `packages/shell/src/host/boot.ts` | 43 | `const NAME = 'corum-shell'` | → `'corum-desktop'` |
| `packages/shell/src/index.ts` | 19 | `export const name = 'corum-shell-app'` | → `'corum-desktop-app'` |
| `packages/shell/src/index.ts` | 104 | `name: 'corum-shell-runtime'` | → `'corum-desktop-runtime'` |
| `packages/shell/src/invariant.ts` | 12 | `export const name = 'corum-shell-app-invariant'` | → `'corum-desktop-app-invariant'` |
| `packages/shell/src/invariant.ts` | 30 | `ctx.invariants.register('corum-shell', install)` | → `'corum-desktop'` |
| `packages/shell/src/client/hmr.ts` | 26 | `export const name = 'corum-shell-hmr'` | → `'corum-desktop-hmr'` |
| `packages/shell/src/client/hmr.ts` | 64 | `const RELOAD_VIA_PAGE = new Set(['corum-shell', ...])` | → `'corum-desktop'` |
| `packages/shell/tsdown.config.ts` | 22 | `const CLIENT_ID = 'corum-shell'` | → `'corum-desktop'` |
| `packages/shell/src/electron/main.ts` | 230 | `join(os.tmpdir(), \`corum-shell-ud-...\`)` | → `corum-desktop-ud-...` |
| `packages/shell/src/host/home.ts` | 16 | `const DEFAULT_DESKTOP_HOME = '~/.corum-shell'` | → `'~/.corum'`（含迁移逻辑） |
| `packages/shell/src/host/plugin-manager.ts` | 44 | `'@corum/ui-model-selection'` | → `'@corum/corum-ui-model-selection'` |
| `packages/shell/src/host/plugin-manager.ts` | 52 | `'corum-ui-model-selection'` | → `'corum-ui-model-selection'`（entryId 不变） |
| `packages/shell/src/host/plugin-manager.ts` | 340 | `moduleName === 'corum-shell' \|\| moduleName.startsWith('corum-shell/')` | → `'corum-desktop'` |
| `packages/shell/src/host/plugin-manager.ts` | 354 | `moduleName.startsWith('@corum/') \|\| moduleName.startsWith('corum-shell')` | → `'corum-desktop'` |
| `packages/shell/src/electron/combos.ts` | 24 | `join(os.homedir(), '.corum-shell', 'combos.json')` | → `'.corum'`（含迁移逻辑） |
| `packages/shell/src/electron/combos.ts` | 84 | `plugins: ['@corum/ide-test-sidebar', '@corum/ide-test-conversation']` | → `['@corum/corum-ide-test-sidebar-ui', '@corum/corum-ide-test-conversation-ui']` |
| `packages/shell/src/electron/combos.ts` | 98 | `plugins: ['@corum/dev-agent', '@corum/dev-agent-shell', '@corum/dev-skill-manager', '@corum/dev-mcp-manager']` | → `['@corum/corum-agent-dev', '@corum/corum-agent-ui-dev', '@corum/corum-skill-manager-dev', '@corum/corum-mcp-manager-dev']` |
| `packages/shell/package.json` | 162-179 | 18 条 `@corum/*` 依赖 | → 新包名 |
| `packages/shell/desktop-host/package.json` | 77-83 | 7 条 `@corum/*` 依赖 | → 新包名 |
| `packages/shell/scripts/dev.sh` | 2 | 注释中的 `corum-shell` | → `corum-desktop` |
| `packages/shell/scripts/test-presets.mjs` | 6 | `packages/shell/.corum-dev-home` | → `packages/desktop/.corum-dev-home` |
| `packages/shell/scripts/pack-macos.mjs` | 多处 | `corum-shell` / `packages/shell` | → `corum-desktop` / `packages/desktop` |
| `packages/shell/scripts/fetch-node.mjs` | 2,10,13 | `corum-shell` / `packages/shell` | → 同步 |
| `packages/shell/scripts/patch-electron-locales.mjs` | 11 | `corum-shell` | → `corum-desktop` |
| `packages/shell/scripts/inline-monaco-css.mjs` | 5,14 | `corum-shell` | → `corum-desktop` |

**日志前缀 `[corum-shell]`**：grep 统计 30+ 处（`packages/shell/src/**/*.ts`），全部统一替换为 `[corum-desktop]`。

**`corum-shell/modules` / `corum-shell/connection` 子路径**：`cordis.patch.yml` 中的 insert 行 id 与 name 需同步（见 B.2）。

### B.2 patch yml 三件套

| 文件 | 行号 | 改动 |
|------|------|------|
| `packages/shell/cordis.patch.yml` | 1 | 注释 `# The corum-shell bundle patch` → `corum-desktop` |
| `packages/shell/cordis.patch.yml` | 27,32 | 注释中 `corum-shell-modules` / `corum-shell-connection` → `corum-desktop-modules` / `corum-desktop-connection` |
| `packages/shell/cordis.patch.yml` | 83-84 | `- id: corum-shell-modules` / `name: 'corum-shell/modules'` → `corum-desktop-modules` / `corum-desktop/modules` |
| `packages/shell/cordis.patch.yml` | 86-87 | `- id: corum-shell-connection` / `name: 'corum-shell/connection'` → `corum-desktop-connection` / `corum-desktop/connection` |
| `packages/shell/cordis.patch.yml` | 104-105 | `- id: corum-shell-app` / `name: 'corum-shell'` → `corum-desktop-app` / `corum-desktop` |
| `packages/shell/cordis.patch.yml` | 118-119,124-125 | `@corum/ui-settings-models` / `@corum/ui-model-selection` → `@corum/corum-ui-settings-models` / `@corum/corum-ui-model-selection` |
| `packages/shell/cordis.ide.patch.yml` | 1 | 注释 `# corum-shell — IDE 模式 overlay` → `corum-desktop` |
| `packages/shell/cordis.ide.patch.yml` | 54-55,59-69 | `@corum/ide-shell` / `@corum/ide-sidebar` / `@corum/ide-explorer` / `@corum/ide-conversation` / `@corum/ide-panel-bottom` → `@corum/corum-ide-ui` / `@corum/corum-ide-sidebar-ui` / `@corum/corum-ide-explorer-ui` / `@corum/corum-ide-conversation-ui` / `@corum/corum-ide-panel-bottom-ui` |
| `packages/shell/cordis.dev-agent.patch.yml` | 1 | 注释 `# corum-shell — dev-agent 模式 overlay` → `corum-desktop` |
| `packages/shell/cordis.dev-agent.patch.yml` | 32-33 | `@corum/dev-agent-shell` → `@corum/corum-agent-ui-dev` |
| `cordis.patch.yml`（根目录） | 4,8 | 注释中 `corum-shell` → `corum-desktop` |

**disabled 锚点 id**：`ui-layout` / `ui-sidebar` / `ui-workspace` / `ui-conversation` / `ui-settings-general` / `ui-settings-models` / `ui-model-selection` / `session-log-download` / `webserver` / `web-startup` / `web-runtime` / `modules` / `connection` / `client-hmr` / `directory-picker` / `system-prompt` 等均为官方 entryId，**不受重命名影响**，保持不变。

### B.3 combos.ts 的 plugins 列表 + combos.json 路径

- `packages/shell/src/electron/combos.ts:24` — `COMBO_CONFIG_PATH` 从 `~/.corum-shell/combos.json` 改为 `~/.corum/combos.json`（含迁移逻辑）
- `packages/shell/src/electron/combos.ts:84,98` — `BUILTIN_COMBOS` 的 `plugins` 数组同步新包名（见 B.1 表）

### B.4 plugin-manager.ts 白名单与前缀匹配

| 行号 | 改动 |
|------|------|
| 44 | `CORE_PLUGIN_PACKAGES` 的 `'@corum/ui-model-selection'` → `'@corum/corum-ui-model-selection'` |
| 52 | `CORE_PLUGIN_ENTRIES` 的 `'corum-ui-model-selection'` 保留（entryId 不变） |
| 340 | `moduleName === 'corum-shell' \|\| moduleName.startsWith('corum-shell/')` → `'corum-desktop'` |
| 354 | `moduleName.startsWith('@corum/') \|\| moduleName.startsWith('corum-shell')` → `'corum-desktop'` |

### B.5 包间依赖

| 文件 | 改动 |
|------|------|
| `packages/shell/package.json:162-179` | 18 条 `@corum/*` → 新包名 |
| `packages/shell/desktop-host/package.json:77-83` | 7 条 `@corum/*` → 新包名 |
| `packages/plugins/ui/*/package.json` | 各 UI 插件对 `@corum/shell-base` 的依赖 → `@corum/corum-ui-base` |
| `packages/plugins/ui/*/src/**/*.tsx` | `import ... from '@corum/shell-base/client'` → `@corum/corum-ui-base/client` |
| `packages/plugins/ui/corum-ide-ui/src/client/plugin-meta.ts:20-22` | `'corum-shell'` / `'corum-shell/modules'` / `'corum-shell/connection'` → `'corum-desktop'` / `'corum-desktop/modules'` / `'corum-desktop/connection'` |
| `packages/plugins/ui/corum-ide-ui/src/client/index.tsx:341,366,371` | 字符串 `'corum-shell'` → `'corum-desktop'` |
| `packages/plugins/ui/corum-ide-ui/src/client/PluginManagerPanel.tsx:325` | `startsWith('@corum/') \|\| startsWith('corum-shell')` → `startsWith('corum-desktop')` |
| `profile/corum/package.json:10,17` | `"corum-shell"` → `"corum-desktop"` |

### B.6 每个 UI 插件 tsdown.config.ts 的 CLIENT_ID

CLIENT_ID 同时出现在：① tsdown 闭包工厂 banner（`window.__ModuleLoader__.load({ id: ... })`）；② `__ModuleLoader__` 注册 id；③ 模块图 entry id。三处必须一致。

| 文件 | 当前 CLIENT_ID | 新 CLIENT_ID |
|------|----------------|--------------|
| `packages/shell/tsdown.config.ts:22` | `'corum-shell'` | `'corum-desktop'` |
| `packages/plugins/ui/shell-base/tsdown.config.ts:21` | `'@corum/shell-base'` | `'@corum/corum-ui-base'` |
| `packages/plugins/ui/dev-agent-shell/tsdown.config.ts:18` | `'@corum/dev-agent-shell'` | `'@corum/corum-agent-ui-dev'` |
| `packages/plugins/ui/dev-skill-manager-shell/tsdown.config.ts:15` | `'@corum/dev-skill-manager-shell'` | `'@corum/corum-skill-manager-ui-dev'` |
| `packages/plugins/ui/ide-shell/tsdown.config.ts:15` | `'@corum/ide-shell'` | `'@corum/corum-ide-ui'` |
| `packages/plugins/ui/ide-sidebar/tsdown.config.ts:15` | `'@corum/ide-sidebar'` | `'@corum/corum-ide-sidebar-ui'` |
| `packages/plugins/ui/ide-explorer/tsdown.config.ts:13` | `'@corum/ide-explorer'` | `'@corum/corum-ide-explorer-ui'` |
| `packages/plugins/ui/ide-conversation/tsdown.config.ts:15` | `'@corum/ide-conversation'` | `'@corum/corum-ide-conversation-ui'` |
| `packages/plugins/ui/ide-panel-bottom/tsdown.config.ts:15` | `'@corum/ide-panel-bottom'` | `'@corum/corum-ide-panel-bottom-ui'` |
| `packages/plugins/ui/ide-statusbar/tsdown.config.ts:15` | `'@corum/ide-statusbar'` | `'@corum/corum-ide-statusbar-ui'` |
| `packages/plugins/ui/ide-test-conversation/tsdown.config.ts:15` | `'@corum/ide-test-conversation'` | `'@corum/corum-ide-test-conversation-ui'` |
| `packages/plugins/ui/ide-test-sidebar/tsdown.config.ts:15` | `'@corum/ide-test-sidebar'` | `'@corum/corum-ide-test-sidebar-ui'` |
| `packages/plugins/ui/ide-test-statusbar/tsdown.config.ts:15` | `'@corum/ide-test-statusbar'` | `'@corum/corum-ide-test-statusbar-ui'` |
| `packages/plugins/session/corum-ui-model-selection/tsdown.config.ts:18` | `'@corum/ui-model-selection'` | `'@corum/corum-ui-model-selection'` |
| `packages/plugins/session/corum-ui-settings-models/tsdown.config.ts:19` | `'@corum/ui-settings-models'` | `'@corum/corum-ui-settings-models'` |
| `packages/plugins/session/session-archive/tsdown.config.ts:21` | `'@corum/session-archive'` | `'@corum/corum-session-archive'` |

### B.7 脚本

| 文件 | 改动 |
|------|------|
| `scripts/combos.mjs:26` | `const SHELL_PKG = 'corum-shell'` → `'corum-desktop'` |
| `scripts/combos.mjs:24` | `join(ROOT, 'packages', 'shell')` → `'desktop'` |
| `scripts/combo.sh:20` | `packages/shell/scripts/dev.sh` → `packages/desktop/scripts/dev.sh` |
| `package.json:14-16` | `shell:dev` / `shell:smoke` / `pack` 的 `--filter corum-shell` → `--filter corum-desktop` |
| `packages/shell/scripts/dev.sh` | 注释中的 `corum-shell` → `corum-desktop` |
| `packages/shell/scripts/test-presets.mjs:6` | `packages/shell/.corum-dev-home` → `packages/desktop/.corum-dev-home` |
| `packages/shell/scripts/pack-macos.mjs` | 多处 `corum-shell` / `packages/shell` → 同步 |
| `packages/shell/scripts/fetch-node.mjs` | 多处同步 |
| `packages/shell/scripts/patch-electron-locales.mjs` | 注释同步 |
| `packages/shell/scripts/inline-monaco-css.mjs` | 注释同步 |

### B.8 文档

| 文件 | 改动要点 |
|------|----------|
| `docs/*.md` | 全文替换 `corum-shell` → `corum-desktop`、`packages/shell` → `packages/desktop`、`@corum/shell-base` → `@corum/corum-ui-base`、`~/.corum-shell` → `~/.corum`、各插件旧包名 → 新包名 |
| `README.md` | 同上 |
| `.trae/rules/project.md` | **每次对话必载的规则文件，必须同步**：`packages/shell` → `packages/desktop`、`~/.corum-shell` → `~/.corum`、`@corum/shell-base` → `@corum/corum-ui-base`、`pnpm --filter corum-shell` → `pnpm --filter corum-desktop`、各插件包名 → 新包名（含 `-ui` / `-dev` 后缀规则） |
| `doc/` | 若存在，同步替换 |

---

## C. home 迁移设计（`~/.corum-shell` → `~/.corum`）

### C.1 迁移时机

在 `resolveDesktopHome()`（`packages/shell/src/host/home.ts`）内完成：

1. 解析 `CORUM_HOME` 环境变量（若设置则跳过迁移，用户显式指定）
2. 检测 `~/.corum-shell` 存在且 `~/.corum` 不存在 → 触发迁移
3. 迁移完成后设置 `process.env.DSH_HOME = ~/.corum`（保持现有语义）

### C.2 迁移策略对比

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| **rename**（`fs.renameSync`） | 原子、快、无 IO | 跨设备失败（EXDEV）；Windows 上目标存在时失败 | **推荐**：桌面 home 与用户目录同卷概率极高；失败时降级 copy+删除 |
| copy + 删除 | 跨设备安全 | 大目录 IO 慢；中途失败留半成品 | rename 失败的降级方案 |
| symlink 兼容 | 零迁移成本 | 双路径并存认知负担；后续清理麻烦 | 不推荐：长期技术债 |

**推荐方案**：`rename` 优先，`EXDEV` 时降级 `copyRecursiveSync + rmSync`。迁移前打日志 `[corum-desktop] migrating home: ~/.corum-shell → ~/.corum`，完成后打 `[corum-desktop] migration complete`。

### C.3 需要迁移的内容清单

| 内容 | 迁移必要性 | 说明 |
|------|------------|------|
| `combos.json` | 必须 | 用户 combo 配置 |
| `.agent-presets/` | 必须 | Agent 预设（含编译产物） |
| `mcp-servers.json` | 必须 | MCP 服务注册表 |
| `plugins.disabled.json` | 必须 | 插件启停清单 |
| `settings.yaml` | 必须 | 设置持久化 |
| `memory/` | 必须 | Agent 记忆 |
| `sessions/` | 必须 | 会话持久化（JSONL） |
| `.credentials.yaml` | 必须 | 凭据 |
| `storages/` | 必须 | 命名存储 |
| `attachments/` | 必须 | 附件内容寻址存储 |
| `profiles/` | 必须 | profile 目录（含 `cordis.yml` / `cordis.patch.yml` / `package.json` / `pnpm-workspace.yaml`） |
| `profiles/node_modules/` | **可重建** | symlink 目录，boot 时 `healProfilesModuleFallbackRegistry` 会重建；迁移时可跳过以加速 |
| `*.bak-*` | 建议保留 | 备份文件（如 `workspace.json.bak-*`） |

### C.4 dev home 处理

`.corum-dev-home` / `.kkc-dev-home` / `.kkc-pack-home` / `.corum-ide-home` 均在仓库内（`packages/shell/` 下），随 `packages/shell` → `packages/desktop` 目录搬迁即可，无需运行时迁移逻辑。

### C.5 回滚方案

1. 迁移前检测 `~/.corum` 是否已存在：存在则跳过迁移，直接使用新目录（用户已手动处理）
2. 迁移失败时保留 `~/.corum-shell` 不动，打错误日志并继续用老目录启动（降级兼容）
3. 若用户需要回退到旧版本，旧版本检测到 `~/.corum-shell` 不存在时会新建空目录，数据不丢（仍在 `~/.corum`）

---

## D. `~/.dsh` 退役方案

### D.1 4 处功能代码的精确改法

当前 `resolveDshHome('~/.dsh')` 在 home 初始化前执行会真读 `~/.dsh`，需改为无参 `resolveDshHome()`（此时 `DSH_HOME` 已由 `resolveDesktopHome()` 设置，无参调用返回 `~/.corum`）。

| 文件 | 行号 | 当前 | 改为 |
|------|------|------|------|
| `packages/plugins/agent/corum-agent-dev/src/agent-service.ts` | 476 | `resolveDshHome('~/.dsh')` | `resolveDshHome()` |
| `packages/plugins/agent/corum-agent-dev/src/agent-service.ts` | 687 | `resolveDshHome('~/.dsh')` | `resolveDshHome()` |
| `packages/plugins/agent/corum-agent-dev/src/compile.ts` | 72 | `resolveDshHome('~/.dsh')` | `resolveDshHome()` |
| `packages/plugins/agent/corum-skill-manager-dev/src/skill-manager-service.ts` | 139,142 | `const DSH_SKILLS = '~/.dsh'` + `resolveDshHome(DSH_SKILLS)` | 删除常量，`resolveDshHome()` |

**语义不变**：skill 全局目录仍是 `$DSH_HOME/skills/`（即 `~/.corum/skills/`），与桌面 home 一致。官方 CLI `dsh` 仍用自己的 `~/.dsh`，两者并存不冲突。

### D.2 注释/文档清理清单

| 文件 | 改动 |
|------|------|
| `packages/plugins/agent/corum-agent-dev/src/profile.ts:17,47,52` | `~/.dsh/skills/` → `~/.corum/skills/`（或 `$DSH_HOME/skills/`） |
| `packages/plugins/agent/corum-agent-dev/src/agent-service.ts:75,310,401,403,634,684` | 同上 |
| `packages/plugins/agent/corum-agent-dev/src/compile.ts:71` | 同上 |
| `packages/plugins/agent/corum-agent-dev/src/profile-store.ts:10` | 同上 |
| `packages/plugins/agent/corum-skill-manager-dev/src/index.ts:7` | 同上 |
| `packages/plugins/agent/corum-skill-manager-dev/src/skill-manager-service.ts:4,11` | 同上 |
| `packages/plugins/agent/corum-skill-manager-dev/package.json:4` | description 中 `~/.dsh/skills/` → `~/.corum/skills/` |

---

## E. 执行顺序与验证

### 阶段 ① 文档确认

- 评审本文档，确认映射表无遗漏、无歧义
- 确认命名规则（无 `shell` / UI 插件 `-ui` 后缀 / 开发插件 `-dev` 后缀 / `@corum/shell-base` → `@corum/corum-ui-base`）
- 确认 `~/.dsh` 退役方案（skill 目录语义不变，仅消除真读隐患）

### 阶段 ② home 迁移逻辑

**改动**：`packages/shell/src/host/home.ts` + `packages/shell/src/electron/combos.ts`

**验证**：
```bash
# 模拟老目录存在
mkdir -p ~/.corum-shell && echo '{"test":true}' > ~/.corum-shell/combos.json
# 启动 dev（会自动迁移）
cd packages/shell && bash scripts/dev.sh --smoke
# 检查 ~/.corum-shell 已消失、~/.corum 存在且内容完整
ls ~/.corum/combos.json
```

### 阶段 ③ 包名/目录重命名

**改动顺序**（避免中间态构建失败）：

1. 改目录名：`git mv packages/shell packages/desktop`、`git mv packages/plugins/agent/dev-agent packages/plugins/agent/corum-agent-dev` 等（按 A.1 表）
2. 改包名：各 `package.json` 的 `name` 字段
3. 改 `pnpm-workspace.yaml`：`packages/shell` → `packages/desktop` 等
4. `pnpm install` 重建 workspace 链接

**验证**：
```bash
pnpm install
pnpm -r --filter './packages/**' run typecheck
```

### 阶段 ④ patch/引用同步

**改动**：
- 三个 patch yml 的 id/name
- `plugin-manager.ts` 白名单与前缀匹配
- `plugin-meta.ts` / `corum-ide-ui/index.tsx` 的字符串
- 各 UI 插件的 `@corum/shell-base` import → `@corum/corum-ui-base`
- `profile/corum/package.json`
- 根 `package.json` 的 filter
- 脚本路径与包名

**验证**：
```bash
pnpm -r --filter './packages/**' run build
```

### 阶段 ⑤ 构建验证

```bash
# 全量构建
pnpm build
# 单独构建壳包（验证 tsdown 闭包工厂 banner 的 CLIENT_ID 正确）
pnpm --filter corum-desktop build
# 检查产物
ls packages/desktop/lib/client.js
grep -o '__ModuleLoader__.load({ id: "[^"]*"' packages/desktop/lib/client.js | head -5
```

### 阶段 ⑥ 运行时验证

```bash
# 启动 IDE combo
node scripts/combos.mjs start coding
# 检查项：
# 1. 窗口正常打开，无白屏/报错
# 2. 插件中心列表正常（包名显示为新名）
# 3. RPC 正常（如会话列表加载、模型选择器可用）
# 4. 启动日志 [corum-desktop] desktop mode: ide
# 5. home 迁移日志（如老目录存在）

# 启动 dev-agent combo
node scripts/combos.mjs start dev-agent
# 检查 AgentTestPanel / SkillManagerPanel / McpManagerPanel 正常
```

**高风险点**：
- **CLIENT_ID / hmr 耦合**：`hmr.ts:64` 的 `RELOAD_VIA_PAGE` 集合与 `tsdown.config.ts` 的 `CLIENT_ID` 必须一致，否则热更新失效
- **patch disabled 锚点**：`cordis.patch.yml` 的 insert 行 id（`corum-desktop-modules` / `corum-desktop-connection` / `corum-desktop-app`）与 `boot.ts` 的 `NAME`、插件的 `export const name` 必须一致，否则 boot 失败
- **pnpm workspace 目录改名后的 install**：必须 `pnpm install` 重建 `node_modules`  symlink，否则 `@corum/*` 解析失败
- **`__DSH_BOOT__` 模块图**：`modules.ts` 扫描 `dsh.client` 声明的包，包名改变后模块图 entry id 同步改变，需确认 `hmr.ts` 的 `findEntry` 逻辑兼容

---

## F. 风险与开放问题

### 已识别风险

1. **CLIENT_ID 与 __ModuleLoader__ 注册 id 强耦合**：`tsdown.config.ts` 的 `CLIENT_ID`、闭包工厂 banner 的 `id`、`hmr.ts` 的 `RELOAD_VIA_PAGE` 三处必须同步，任何一处遗漏都会导致热更新或模块加载失败。
2. **patch yml 的 insert 行 id 与插件 name 一致性**：`cordis.patch.yml` 的 `id: corum-desktop-app` 必须与 `src/index.ts` 的 `export const name = 'corum-desktop-app'` 一致，否则 cordis 插件注册失败。
3. **home 迁移中的 symlink 重建**：`profiles/node_modules/` 下的 symlink 指向 `packages/shell/node_modules/...`，目录改名后 symlink 失效，boot 时 `healProfilesModuleFallbackRegistry` 会重建，但首次启动可能有短暂延迟。
4. **`.trae/rules/project.md` 是每次对话必载的规则文件**：若不同步，后续 AI 辅助开发会持续引用旧路径/旧包名，造成混乱。
5. **`profile/corum/package.json` 的 `bundles` 列表**：`corum-shell` 改为 `corum-desktop` 后，需确认 `dsh.profile.bundles` 的解析逻辑兼容。

### 开放问题

1. **`~/.corum` 与官方 `~/.dsh` 的并存策略**：当前桌面 home 与 CLI home 完全隔离（`DSH_HOME` 环境变量隔离），重命名后保持同样策略。是否需要在未来支持「桌面读取 CLI 的 skill 目录」？（当前决策：不需要，skill 全局目录语义不变，仍指向桌面 home 下）
2. **`com.corum.agentos` 的 appId 是否需要同步改为 `com.corum.desktop`**：当前 appId 已是 corum 系，不影响功能，但可考虑统一。建议保留（避免已安装用户的 user-data-dir 变更）。
3. **`corum-shell-ud-*` 的临时目录命名**：`main.ts:230` 的 `corum-shell-ud-` 前缀改为 `corum-desktop-ud-` 后，旧临时目录会残留。建议保留旧前缀或加清理逻辑（低优先级）。

---

## 附：快速校验命令

```bash
# 检查是否还有遗漏的 corum-shell 引用
grep -rn 'corum-shell' packages/ --include='*.ts' --include='*.tsx' --include='*.json' --include='*.yml' --include='*.mjs' --include='*.sh' | grep -v node_modules | grep -v lib/ | grep -v dist/

# 检查是否还有遗漏的 ~/.corum-shell 引用
grep -rn '\.corum-shell' packages/ --include='*.ts' --include='*.tsx' --include='*.json' --include='*.yml' --include='*.mjs' --include='*.sh' | grep -v node_modules | grep -v lib/ | grep -v dist/

# 检查是否还有遗漏的 @corum/shell-base 引用
grep -rn '@corum/shell-base' packages/ --include='*.ts' --include='*.tsx' --include='*.json' | grep -v node_modules | grep -v lib/ | grep -v dist/

# 检查是否还有遗漏的旧插件包名（dev- 前缀 / ide-* 无 -ui 后缀 / shell 残留）
grep -rn "@corum/\(dev-\|ide-\|shell-base\|project-core\|session-archive\|ui-model-selection\|ui-settings-models\)" packages/ --include='*.ts' --include='*.tsx' --include='*.json' --include='*.yml' | grep -v node_modules | grep -v lib/ | grep -v dist/

# 检查是否还有遗漏的 ~/.dsh 引用（功能代码）
grep -rn "resolveDshHome('~/.dsh')" packages/ --include='*.ts' | grep -v node_modules | grep -v lib/
```
