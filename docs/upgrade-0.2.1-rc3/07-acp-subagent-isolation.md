# 阶段 5：装配 dsh-subagent-acp（子 agent 进程隔离）

> 状态：执行中（用户 2026-10-29 拍板 reject 先启用验证，后续一定支持 corum confined/worktree 核心功能） | 前置：阶段 4 flock addon 验证 | 工程量：中（launcher + provider row + dep + override + 测试 + 能力拒绝）

---

## 1. 目标与范围

### 1.1 目标

1. **装配 `dsh-subagent-acp` 作为第三 provider 选项**，与 corum-spawn / corum-fork / corum-isolated 并存（不替换任一现有 provider）。
2. **ACP 只支持 one-shot external activation**：无 continuable / send_message / resume / outputSchema / agentPreset / agentOptions / depthLimit / confined / worktree——明确能力拒绝。
3. **默认 `permission: reject` 启用验证**：reject 作为负例验证基线（所有 permission request 被 cancelled），allow 只作为后续独立评审，不在本阶段开。

### 1.2 设计裁决（用户 2026-10-29 拍板）

| 编号 | 决策项 | 结论 |
|---|---|---|
| D1 | 子进程命令形态 | 官方 `dsh` CLI + `--profile acp` 作为子进程；不自己写第二协议栈 |
| D2 | 子进程模型/凭据来源 | 子进程读同一 `CORUM_HOME`/`DSH_HOME` 的官方 profile/settings/credentials 机制，不复制父 env secrets；官方 acp env scrubbing 必须验证 |
| D3 | 权限策略 | `permission: reject`（负例验证基线）；不是 disabled，是 reject 启用 |

**关键约束**：
- 官方 `dsh` CLI 包（`@deepseek-ai/dsh`，`bin: { dsh: 'lib/bin.js' }`）作为子进程——不写第二协议栈。
- ACP 只支持 **one-shot external activation**（官方 `AcpProvider` 的 `capabilities` 全 `false`，`inheritsParentContext = false`，`prepareContinuable` 不存在 → 路由到 `startExternal` → `kind: 'external'`）。
- `Config.command` 是 `z.string().required()`——patch 行**必须**带 `command`，否则 zod 校验失败导致 boot 死。
- `permission` 只有 `z.union(['allow', 'reject'])`，没有 `inherit`——用户拍板 `reject`。
- `cf58d502` 不存在于任何 repo（已核实），旧文档的 BUG 修复引用删除。

### 1.3 能力面（rc3 官方源码 `subagent-acp/src/index.ts:81-86`）

| 能力 | AcpProvider | 说明 |
|---|---|---|
| `agentOptions` | ❌ `false` | 外部进程不认 |
| `agentPreset` | ❌ `false` | 外部进程不认 |
| `outputSchema` | ❌ `false` | 外部进程不认 |
| `depthLimit` | ❌ `false` | 外部进程不认 |
| `inheritsParentContext` | ❌ `false` | 进程边界，不继承父上下文 |
| `prepareContinuable` | ❌ 不存在 | 只有 one-shot external activation |
| `sendMessage` / `resume` | ❌ `NOT_CONTINUABLE` | external activation 不可持续 |
| `cwd` 透传 | ✅ | `request.cwd` → `assertUsableCwd` |
| `permission` | `reject`（本阶段默认） | `reject` → 所有请求 `cancelled`；`allow` 后续独立评审 |

**后续必做项**（不在本阶段）：corum confined/worktree 核心功能适配——fork `subagent-acp` 本身或写 corum 自有 wrapper 补能力面。

### 1.4 范围边界

| 在本阶段 | 不在本阶段 |
|---|---|
| 装配 acp provider（launcher + patch row + dep + override） | 全量切换到 acp（需 fork `subagent-acp` 本身） |
| one-shot external activation 负例验证（reject） | `permission: allow` 独立评审 |
| 能力拒绝（continuable/outputSchema/etc 报 unsupported） | corum confined/worktree 适配 |
| 启动器 dev+packaged 三平台路径解析 | 顶层会话进程隔离（属阶段 6 sidecar） |

---

## 2. 前置条件

| 前置 | 来源 | 确认方式 |
|---|---|---|
| 阶段 4 三道门禁全绿 | `docs/upgrade-0.2.1-rc3/06-verification.md` | typecheck + test + fork-drift 全过 |
| `dsh-subprocess` / `dsh-subprocess-local` 在打包闭包 | 评审证据 §B2 | `build/host/node_modules/@deepseek-ai/` 下两包存在 |
| `@deepseek-ai/dsh` CLI + `dsh-subagent-acp` + `dsh-acp` 可解析 | 本阶段 dep + override | `pnpm install` 0 错 |
| 用户拍板 reject 启用 | 本文 §1.2 | 已确认 |

---

## 3. 输入与依赖

### 3.1 输入

| 输入 | 路径 / 来源 | 用途 |
|---|---|---|
| rc3 官方 AcpProvider 源码 | `dsh-v0.2.1-rc.3:packages/subagent/subagent-acp/src/index.ts` | Config schema / capabilities / permission |
| rc3 官方 ACP run.ts | 同上 `src/run.ts` | env scrubbing / permission policy / spawn spec |
| rc3 官方 subprocess scrub | `dsh-v0.2.1-rc.3:packages/subprocess/subprocess/src/index.ts:47-69` | `SENSITIVE_ENV_PATTERN` / `DSH_ENV_PREFIX` / `scrubbedParentEnv()` |
| rc3 官方 dsh CLI | `dsh-v0.2.1-rc.3:apps/cli/package.json` (`bin: { dsh: 'lib/bin.js' }`) | 子进程 command |
| 评审报告 | `~/.corum/orchestrate-reports/orchestrate_83_ed00e7bd.md` | 误报澄清（continuable 是 config-driven 非硬编码；cf58d502 不存在） |

### 3.2 依赖包

| 包 | 角色 | 版本 |
|---|---|---|
| `@deepseek-ai/dsh` | 官方 CLI（`bin: { dsh: 'lib/bin.js' }`，`--profile acp` 入口） | `0.2.1-rc.3` |
| `@deepseek-ai/dsh-subagent-acp` | Out-of-process 子 agent provider | `0.2.1-rc.3` |
| `@deepseek-ai/dsh-acp` | ACP 协议（JSON-RPC stdio） | `0.2.1-rc.3` |
| `@deepseek-ai/dsh-subprocess` + `dsh-subprocess-local` | 进程管理 seam（已在闭包） | `0.2.1-rc.3` |

---

## 4. 执行步骤

### 4.1 启动器：corum wrapper resolveAcpCommand

**设计**：corum wrapper（`@corum/corum-subagent/acp`）在 `apply()` 时从环境变量解析
`command`+`args`，调官方 `@deepseek-ai/dsh-subagent-acp` 的 `apply()`。

**路径推导**（dev + packaged 三平台）：

| 环境 | Node executable（`CORUM_HOST_NODE`） | dsh CLI bin.js（`CORUM_ACP_CLI_PATH`） |
|---|---|---|
| dev | `process.execPath`（cli.ts 注入） | `join(dirname(import.meta.url), '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')` = `packages/desktop/node_modules/...` |
| packaged (darwin/linux) | `join(resourcesPath, 'node', 'bin', 'node')` | 同上推导 = `Resources/host/node_modules/...` |
| packaged (win32) | `join(resourcesPath, 'node', 'node.exe')` | 同上 |

**路径推导原理**：`main.js` 在 `lib/` 目录（dev=`packages/desktop/lib/`，packaged=
`Resources/host/lib/`）。`dirname(import.meta.url)` = `lib/`，`..` = 上一级
（dev=`packages/desktop/`，packaged=`Resources/host/`），`node_modules` 在该级。
`acpCliPath()` = `join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules',
'@deepseek-ai', 'dsh', 'lib', 'bin.js')`。

**env 注入**（Electron main `buildHostEnv`，combo=null smoke 也一样）：
- `CORUM_HOST_NODE` = `hostNode()`（dev=`process.env.CORUM_HOST_NODE ?? process.execPath`，
  packaged darwin/linux=`Resources/node/bin/node`，win32=`Resources/node/node.exe`）
- `CORUM_ACP_CLI_PATH` = `acpCliPath()`（上述路径推导）

**host launcher**（corum wrapper `resolveAcpCommand`）只读这些固定值，不猜 cwd/PATH。
缺少任一 → fail-loud（throw，不静默降级）。

**DSH_HOME/CORUM_HOME 传递**：官方 `scrubbedParentEnv()` 会删掉所有 ambient `DSH_*`
和 credential-shaped（`KEY/PASSWORD/SECRET/TOKEN`）名称，然后 `spec.env` merge。
wrapper 的 `resolveAcpEnv()` 显式传 deployment-owned 的 `DSH_HOME` + `CORUM_HOME`
（父进程真实绝对路径值，非空校验），**不**传 KEY/TOKEN/SECRET 等。

### 4.2 装配 acp provider

**步骤 1：`packages/desktop/desktop-host/package.json` + `packages/desktop/package.json` 加 dep**

```json
"@deepseek-ai/dsh": "0.2.1-rc.3",
"@deepseek-ai/dsh-acp": "0.2.1-rc.3",
"@deepseek-ai/dsh-subagent-acp": "0.2.1-rc.3"
```

`@corum/corum-subagent` 的 `dependencies`（非 devDeps）也加 `@deepseek-ai/dsh-subagent-acp`
（wrapper 运行时直接 import，打包/插件部署必须可解析）。

**步骤 2：`pnpm-workspace.yaml` override**（已存在 rc3 pin，确认）

**步骤 3：`pnpm install` 验证可解析性**

**步骤 4：`packages/desktop/cordis.patch.yml` 加一行 provider row**

在 `corum-subagent-tracked` 行之后加：

```yaml
- id: corum-subagent-acp
  name: '@corum/corum-subagent/acp'
```

> wrapper 的 `Config` 只有 `providerName`（默认 `'acp'`）——**不写 `command`**。
> `command`/`args` 在 wrapper `apply()` 时从 `CORUM_HOST_NODE` + `CORUM_ACP_CLI_PATH`
> 解析。官方 `Config.command` 是 required，但 wrapper 构建完整 config 后才调官方 apply，
> 所以 patch 行不需要 `command`。

**步骤 5：`packages/plugins/agent/corum-subagent/tsdown.config.ts` 加 acp 入口**

`host.entries` 追加 `'lib/types/acp/index.js'`；`external` 追加
`'@deepseek-ai/dsh-subagent-acp'` + `'@deepseek-ai/dsh-subprocess'`。
构建后确认 `lib/acp/index.js` + `lib/types/acp/index.d.ts` 存在。

### 4.3 能力拒绝

corum-tool-subagent 的 `continuable` 在当前 src 中恒为 `true`（2026-10-27 后台统一
activation）。如果某 tool-subagent 实例选了 `provider: 'acp'`，`assertSubagentProviderConfiguration`
会因 ACP 无 `prepareContinuable` 抛错——这是**正确的行为**。本阶段 ACP provider
只注册在 registry，**不被 compile.ts 的任何 tool 行选中**（compile.ts 不生成
`provider: 'acp'` 行），所以不会触发 assert。

**能力拒绝清单**（测试覆盖，从真实 AcpProvider 实例读 capabilities）：
- `agentOptions` / `agentPreset` / `outputSchema` / `depthLimit` → 全 `false`（service rejects before execution）
- `prepareContinuable` 不存在 → continuable 请求被 `assertSubagentProviderConfiguration` 拒绝
- `sendMessage` / `resume` → `NOT_CONTINUABLE`（external activation 不可持续）
- `confined` / `worktree` → 后续必做项，本阶段不支持

### 4.4 重打包 + 冲烟

```bash
# 1. pack --skip-app（闭包检查 dsh CLI / acp 可解析）
pnpm run pack -- --skip-app

# 2. 确认闭包含 dsh CLI bin.js + ACP provider
ls packages/desktop/build/host/node_modules/@deepseek-ai/dsh/lib/bin.js
ls packages/desktop/build/host/node_modules/@deepseek-ai/dsh-subagent-acp/lib/index.js
# closure probe：从 corum-subagent/acp export 解析（不只检查 dsh bin 存在）

# 3. 重启 verify 实例（独立 temp home，不碰主实例）
./scripts/corum-instance.sh start --home=verify

# 4. ACP smoke（至少 acp --help / profile boot）
```

---

## 5. 验收标准

| 编号 | 验收项 | 判据 |
|---|---|---|
| V1 | reject 用户决策已记录 | §1.2 D3 = reject |
| V2 | acp provider 装配 | `pnpm install` 0 错 + 闭包含 `dsh` / `dsh-subagent-acp` / `dsh-acp` |
| V3 | 启动器三平台路径 | dev/packaged darwin/linux/win32 的 Node + CLI 路径可解析 |
| V4 | wrapper 解析有效 command | wrapper 从 `CORUM_HOST_NODE` + `CORUM_ACP_CLI_PATH` 解析出有效绝对路径，调官方 apply 注册成功 |
| V5 | permission 永远 reject | 所有 permission request → cancelled → child `stopReason: 'aborted'` |
| V6 | env scrub + deployment-owned 保留 | 敏感/ambient 值（`KEY/PASSWORD/SECRET/TOKEN`）不透传；deployment-owned `DSH_HOME`/`CORUM_HOME` 显式保留 |
| V7 | continuable/outputSchema/etc 报 unsupported | 明确错误信息 |
| V8 | 热重 init 不影响 acp 工具注册表 | 独立 fixture 验证 |
| V9 | 真实 ACP smoke | acp CLI `--help` / profile boot 至少一次 |
| V10 | fork-drift 守卫 | 装配后 drift 不扩大 |

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| acp 能力面不足，用户期望全量切换 | **高** | §1.3 能力表标注；corum confined/worktree 列为后续必做 |
| `command` 缺失导致 boot 死 | **高** | Config required，launcher 必须返回有效路径 |
| 父 env secret 泄漏 | **高** | 官方 `scrubbedParentEnv()` + 测试验证 |
| disabled 行被 filter 掉 | **高** | 红线 5：不 filter disabled 行 |
| 三平台路径差异（Windows `node.exe` 无 `bin/`） | 中 | `hostNode()` 已处理，launcher 复用 |
| `permission: allow` 不在本阶段 | 中 | reject 负例验证；allow 后续独立评审 |

---

## 7. 回滚方案

| 场景 | 回滚操作 |
|---|---|
| acp provider 装配后出问题 | cordis.patch.yml 的 acp 行标 `disabled: true`（不删行）→ 重打包 → 回到三 provider |
| 启动器路径错误 | 修 `resolveAcpCommand` / `buildHostEnv` env 注入 |
| 闭包缺包 | 补 `desktop-host/package.json` dep + topUp |

---

## 8. 产出物与下游接口

| 产出物 | 路径 | 下游 |
|---|---|---|
| acp provider 装配提交 | git commit | 阶段 6（sidecar 可复用 acp 协议） |
| 启动器 `resolveAcpCommand` | host 侧 | 三平台路径推导 |
| 能力表 | 本文档 §1.3 | 用户决策全量切换时参考 |
| 验收记录 | `docs/upgrade-0.2.1-rc3/verification-log.md` | 用户验收 |

### 后续必做项（不在本阶段）

- **fork `subagent-acp` 本身**：若用户需要全量切换到 acp（带 corum 委派轴心的 worktree 隔离 / 角色契约 / agentPreset / 结构化输出 / 深度上限），需 fork `subagent-acp` 源码补能力面。工程量大，独立排期。
- **corum confined/worktree 适配**：用户已拍板「后续一定支持 corum confined/worktree 核心功能」。

---

## 9. 实录要求

- reject 用户决策的拍板时间 + 决策人 + 结论。
- 装配步骤的每步命令 + 退出码 + 闭包产物路径。
- 启动器三平台路径的实物解析结果。
- 能力拒绝的测试输出。
- ACP smoke 的命令 + 输出。
- 与计划的偏差如实记录。

---

## 更新日志（2026-10-28 阶段5纠偏）

### acpCliPath 打包路径修复

`acpCliPath()` 原不支持 packaged 路径（总是 dev 路径）。
抽可测 helper `resolveAcpCliPath(packaged, resourcesPath, mainFileUrl)` 到
`packages/desktop/src/electron/acp-paths.ts`。

- packaged: `join(resourcesPath, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')`
- dev: `join(dirname(main.js), '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')`

测试 `acp-paths.test.mjs`：8 passed（三平台 dev/packaged 全覆盖）。

### resolveAcpEnv 绝对路径 + DSH_HOME 必填

`resolveAcpEnv()` 强化校验：
- `DSH_HOME` 必填且 `node:path.isAbsolute()`（非空不够）
- `CORUM_HOME` 可选但必须绝对路径且与 `DSH_HOME` 一致
- 不传 secret

corum-subagent vitest 新增 isAbsolute/mismatch/required 测试。

### 真实 ACP activation mock server

新增 `mock-acp-server.mjs`（最小 ACP JSON-RPC over NDJSON stdio）实现
initialize/session/new/prompt/session/close。
`acp-real-activation.spec.ts` 验证 mock server 真实响应 + env report。
已用真实 mock server 覆盖端到端 activation 路径——**0 skip**。
完整 cordis context 下的 SubagentManager + subprocess 端到端测试属打包态验证。

---

## 更新日志（2026-10-30 阶段5最终验收）

### 全量门禁 + 完整 pack + 真实 ACP CLI 部署验收

**HEAD**：63cdb2da | **分支**：upgrade/0.2.1-rc3 | **基座 tag**：dsh-v0.2.1-rc.3

全量门禁：
- 强制 typecheck：51/51 PASS, 0 semantic errors ✓
- 全仓测试：3581 tests (3427 vitest + 154 desktop node:test), 0 failed ✓
- 全仓 build（含 UI inline-css）：exit 0 ✓
- fork-drift（rc.3 tag）：exit 0, 0 red, 13 informational skip ✓

完整 pack:host:mac（无 --skip-app）：
- PACK_EXIT=0, smokeBridge ready, electron-builder DMG+ZIP ✓
- package.json deps 恢复（115 个），生成物不提交 ✓

assert-packaged-boot：exit 0, ready ✓

打包产物验证：
- `Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js` ✓
- `Resources/host/node_modules/@corum/corum-subagent/lib/acp/index.js` ✓
- `Resources/node/bin/node` ✓

真实 ACP CLI smoke（打包 Node + 打包 dsh CLI `--profile acp`，独立临时 home）：
- initialize 返回协议能力：`protocolVersion=1`, `agentInfo={name:"deepseek-harness-acp",version:"0.0.1"}`,
  `agentCapabilities.mcpCapabilities.http=true`, `sessionCapabilities={close,list,resume}`
- 无 Cannot find package / plugin tree failed / stderr 为空
- session/new 返回 sessionId + configOptions

ACP packaged provider wiring 探针：
- 注入 `CORUM_HOST_NODE`/`CORUM_ACP_CLI_PATH` 指向打包实物
- bridge boot ready, acp provider 注册无 error, CORUM_HOST_NODE/CORUM_ACP_CLI_PATH resolved
- queue-revert descriptor 未 fail

pack smoke 未激活/warn 审计：
1. corum-subagent-acp: smokeBridge 时序特性（env 未注入），非生产 bug — provider 探针已确认
2. corum-web-search: cordis 惰性激活，留 CDP 验证
3. corum-session-queue-revert: 无 descriptor fail ✓

详见 `docs/upgrade-0.2.1-rc3/verification-log.md` §F。

剩余项：仅 macOS CDP 冲烟 + Linux/Windows 三平台（下任务）。

---

## macOS 隔离 CDP 行为验收（2026-10-28）

> 详见 `verification-log.md` §G。

### 结果

- **smoke 通用项全过**：DOM 渲染 ✓ / 控制台零错误 ✓ / 凭证加密 ✓ / Electron 身份 = pin ✓ / CDP 连接 ✓
- **host 端全过**（§F + §G.2）：typecheck / test / build / fork-drift / pack / assert / ACP CLI smoke / ACP wiring 探针 / queue-revert descriptor 无 fail / corum-subagent-acp host 注册无 error
- **renderer 端行为项受限**：主界面加载超时（23 插件未激活，循环依赖 `corum-ide-ui` provide `layout` ↔ `corum-ui-conversation` provide `corumNavigation`），renderer RPC 桥不可用，settings roundtrip / 会话导航 / queue-revert schema / web-search / ACP 注册 / V4 历史 标 SKIP

### ACP CDP 验证状态

| ACP 验收项 | 结果 | 说明 |
|------------|------|------|
| V2 acp provider 装配 | ✓ PASS | 闭包含 dsh/dsh-subagent-acp/dsh-acp（§F.4） |
| V3 启动器三平台路径 | ✓ PASS | acp-paths.test.mjs 8 passed（§F.5） |
| V4 wrapper 解析有效 command | ✓ PASS | wiring 探针 §F.6 确认 CORUM_HOST_NODE/CORUM_ACP_CLI_PATH resolved |
| V5 permission 永远 reject | ✓ PASS | mock server 测试 §E.3 B9 |
| V9 真实 ACP smoke | ✓ PASS | CLI initialize 返回协议能力（§F.5） |
| ACP provider 注册（CDP） | – SKIP | renderer 未就绪，host 探针已验证 §F.6 |
| ACP 不支持 continuable/preset 在 UI 误宣称 | – SKIP | UI 未渲染，无法检查；能力拒绝清单已在测试中覆盖 |

### 不宣称 ACP 已支持 continuable/preset

ACP provider 的能力面（`agentOptions`/`agentPreset`/`outputSchema`/`depthLimit`/`inheritsParentContext`/`prepareContinuable`/`sendMessage`/`resume`/`confined`/`worktree` 全 `false` 或不支持）已在 §1.3 能力表 + 测试中确认。CDP 无法在 UI 层补充验证（renderer 未就绪），但**不宣称 ACP 已支持 continuable/preset**——这些能力面仍列为后续必做项（fork `subagent-acp` 本身或写 corum wrapper）。

### 阶段 5 confined/worktree 后续必做

用户已拍板「后续一定支持 corum confined/worktree 核心功能」。本阶段只装配 acp provider + one-shot external activation 负例验证 + 能力拒绝。confined/worktree 适配不在本阶段。

### 三平台

| 平台 | ACP 验证状态 |
|------|-------------|
| macOS darwin-arm64 | ✓ host 端全过；CDP renderer 端因循环依赖 SKIP |
| Linux x64 | ❌ 未验证 |
| Windows x64 | ❌ 未验证 |
