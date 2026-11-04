# 阶段 5：装配 dsh-subagent-acp（子 agent 进程隔离）

> 状态：待执行（含产品决策待用户拍板） | 前置：阶段 4.5 flock addon 验证结论 | 工程量：中（一行 patch row + dep + override + 产品决策 + BUG 验收用例）

---

## 1. 目标与范围

### 1.1 目标

1. **装配 `dsh-subagent-acp` 作为第三 provider 选项**，与 corum-spawn / corum-fork / corum-isolated 并存（不替换任一现有 provider）。
2. **修复原始 BUG（`cf58d502`）的子 agent 路径**：卸载扩展包破坏运行中的子 agent 会话——根因是单进程架构下 Loader 重 init 反注册工具；acp 子进程自带独立 runtime/session/tools，父进程 Loader 重 init 不再反注册子工具。
3. **明确能力面限制**：acp provider 的能力面与 corum 委派轴心互斥，本阶段只接入「能用的部分」，全量切换列为可选后续项。

### 1.2 定位改写（评审 E3 结论）

> ~~装配 `dsh-subagent-acp` 即可，工程量小。~~（可行性文档原口径，已评审推翻）

**改写后的定位**：acp 不是「替换」现有 provider，是「第三 provider 选项」，与 corum-spawn / corum-fork / corum-isolated 并存。

**依据**（评审证据 §E3）：

- `subagent-acp/src/index.ts` 的 `inject: ['subagents', 'subprocess']`——两个服务 corum 都有（fork 的 `subagents` 服务名与官方一致；`dsh-subprocess` / `dsh-subprocess-local` 已在打包闭包里）。
- 官方 provider 经 `ctx.subagents.registerProvider()` 注册 `'acp'`，可挂在 corum fork 的 seam 上。
- 组合面 = 一行 patch row + `package.json` dep + override。

### 1.3 范围边界

| 在本阶段 | 不在本阶段 |
|---|---|
| 装配 acp provider（patch row + dep + override） | 全量切换到 acp（需 fork `subagent-acp` 本身，列为可选后续项） |
| 子 agent 会话进程隔离（子进程一侧） | 顶层会话进程隔离（属阶段 6 sidecar 自研） |
| 修复 `cf58d502` 的子 agent 路径验收 | 顶层会话卸载插件路径修复（属阶段 6） |

---

## 2. 前置条件

| 前置 | 来源 | 确认方式 |
|---|---|---|
| 阶段 4.5 flock addon 验证结论 | `docs/upgrade-0.2.1-rc3/06-verification.md` §4.6 | 决策树有输出：43.4.1 下 addon 可加载 → 继续；不可加载 → 先升 Electron |
| 阶段 4 三道门禁全绿 | 同上 §4.1–4.3 | typecheck + test + fork-drift 全过 |
| `dsh-subprocess` / `dsh-subprocess-local` 在打包闭包 | 评审证据 §B2 | `build/host/node_modules/@deepseek-ai/` 下两包存在 |
| `dsh-acp` 包可解析 | 阶段 2 override | `pnpm install` 0 错 |
| 产品决策清单已用户拍板 | 本文档 §4.1 | 见下方决策清单 |

---

## 3. 输入与依赖

### 3.1 输入

| 输入 | 路径 / 来源 | 用途 |
|---|---|---|
| 可行性评估（单一事实源） | `docs/UPGRADE-0.2.1-rc3-feasibility.md` §六 阶段 5 | 定位改写原文 |
| 评审证据 §E3 | `~/.corum/research-reports/06867ebb-…-d847-4ac5-97e7-4edab2ac1d23.md` §E3 | acp 能力面分析、BUG 路径证实 |
| 评审证据 §B2 | 同上 §B2 | corum 装配的是 in-process 变体、打包产物实证 |
| 原始 BUG | commit `cf58d502` | 卸载扩展包破坏活会话 |
| fork-delta 台账 | `docs/fork-delta.md` §10 | corum-subagent fork 范围 |

### 3.2 依赖包

| 包 | 角色 | 状态 |
|---|---|---|
| `@deepseek-ai/dsh-acp` | ACP 协议（JSON-RPC stdio 驱动持久化 agent） | 0.1.0-rc.7 起存在，0.1.5 已含，corum 当前未装配 |
| `@deepseek-ai/dsh-subagent-acp` | Out-of-process 子 agent provider | 0.1.0 起存在，0.1.5 已含，corum 当前未装配 |
| `@deepseek-ai/dsh-subprocess` + `dsh-subprocess-local` | 进程管理 seam | 已在 corum 打包闭包 |
| `SessionWriteLease` | 跨进程会话写租约（flock addon） | 0.1.3-alpha.1 起有，0.2.1 版预编译 Node-API addon |

---

## 4. 执行步骤

### 4.1 产品决策清单（本阶段开工前需用户拍板）

> 以下三项是评审 §E3 指出的产品决策，不是一行配置能解决的。开工前必须由用户拍板。

| 编号 | 决策项 | 选项 | 推荐 |
|---|---|---|---|
| D1 | 子进程命令形态 | (a) 官方预期 `dsh acp-app` + 显式绝对 `DSH_HOME`；(b) 第三方 ACP agent | (a)——与官方形态对齐，降低维护负担 |
| D2 | 子进程模型配置来源 | (a) 读 corum 的 settings.yaml；(b) 独立配置文件；(c) 父进程注入 | (a)——复用现有配置面 |
| D3 | 权限策略 | (a) 默认 reject（最安全）；(b) 默认 inherit（继承父进程档位）；(c) 默认 allow | (a)——acp 子进程独立 runtime，默认 reject 符合最小权限原则 |

**未拍板则不开工**：子进程命令 / 模型配置 / 权限策略缺失会导致 acp 装配后行为不可控。

### 4.2 装配 acp provider

**组合面改动**（一行 patch row + dep + override）：

**步骤 1：`packages/desktop/package.json` 加 dep**

```json
"dependencies": {
  "@deepseek-ai/dsh-subagent-acp": "^0.2.1-rc.3",
  "@deepseek-ai/dsh-acp": "^0.2.1-rc.3"
}
```

**步骤 2：`packages/desktop/cordis.patch.yml` 加一行 patch row**

在 `corum-subagent-spawn` / `corum-subagent-fork` / `corum-subagent-isolated` 等 provider 行之后加：

```yaml
- id: acp
  name: '@deepseek-ai/dsh-subagent-acp'
```

> ⚠️ 红线 5：**不要 filter 掉 disabled 行**。若 acp 行暂不启用，标 `disabled: true` 但**不要从 patch 数组里删除**——disabled 行有双重职责（索引标记 + 抑制官方同名包让 fork 垄断服务名）。

**步骤 3：`pnpm-workspace.yaml` override 加对应行**

```yaml
'@deepseek-ai/dsh-subagent-acp': 0.2.1-rc.3
'@deepseek-ai/dsh-acp': 0.2.1-rc.3
```

**步骤 4：`pnpm install` 验证可解析性**

```bash
pnpm install
```

**每步验证**：

- `pnpm install` 0 错。
- `build/host/node_modules/@deepseek-ai/` 下出现 `dsh-acp` + `dsh-subagent-acp`（打包闭包补齐）。
- cordis.patch.yml 语法正确（`node -e "require('js-yaml').load(require('fs').readFileSync('packages/desktop/cordis.patch.yml','utf8'))"`）。

### 4.3 能力面互斥表

> 评审 §E3 结论：acp 的 `AcpProvider` capabilities 全 false，corum 委派轴心逐项标注。

| 能力 | corum-spawn/fork/isolated | acp provider | 互斥原因 |
|---|---|---|---|
| cwd 透传 | ✅ | ✅ | acp 认 `request.cwd` |
| worktree 隔离沙箱钳制（confinedSandbox） | ✅ | ❌ | seam 直接拒绝请求 |
| 角色契约（kind + personaHint） | ✅ | ❌ | acp 不认角色契约 |
| agentPreset | ✅ | ❌ | capabilities.agentPreset = false |
| 结构化输出（outputSchema） | ✅ | ❌ | capabilities.outputSchema = false |
| 深度上限（depthLimit） | ✅ | ❌ | capabilities.depthLimit = false |

**结论**：

- acp 可作为**第三种 provider 选项**并存（corum-spawn / corum-fork / corum-isolated 之外）。
- `inheritsParentContext = false`——子进程不继承父进程上下文。
- **要全量切 acp 需 fork `subagent-acp` 本身**（列为可选后续项，不在本阶段）。
- corum-isolated 与 acp 不可叠加（两者都做隔离但机制不同，混用无意义）。

### 4.4 修复目标验证：BUG `cf58d502` 子 agent 路径

**原始 BUG**（commit `cf58d502`）：用户卸载 corum-dev 扩展包时，热应用破坏了运行中的子 agent 会话，bash 工具命中 `ToolNotFoundError`。根因 = 单进程架构下 Loader 重 init 反注册子工具。

**acp 的修复原理**（评审 §E3 证实）：子进程内 child 自带 runtime / session / tools，父进程 Loader 重 init 不再反注册子工具——子进程的工具表与父进程解耦。

**验收用例**：

```bash
# 1. 启 verify 实例
./scripts/corum-instance.sh start --home=verify

# 2. 起一个 acp 子 agent 会话（走 corum-subagent-acp provider）
#    在 UI 里起子 agent，provider 选 'acp'

# 3. 在子 agent 会话里跑一个 bash 工具调用，确认可用

# 4. 热卸载某个扩展包（如 corum-dev）
#    在插件中心点「卸载」

# 5. 断言子会话 bash 工具仍可用（不再 ToolNotFoundError）
#    再跑一次 bash 调用
```

**判据**：

- 步骤 3：子 agent 会话的 bash 工具可调用（ToolNotFoundError 不出现）。
- 步骤 5：卸载扩展包后，子 agent 会话的 bash 工具**仍可用**（不再 `ToolNotFoundError`）。

**注明**：顶层会话一侧（卸载插件的那一侧）不在本阶段——属阶段 6 的 sidecar 自研。本阶段只验子 agent 路径。

### 4.5 重打包 + CDP 冲烟

**步骤**：

```bash
# 1. 重打包（host-plugin 改动需 app restart，红线 5）
pnpm run pack

# 2. 重启 verify 实例
./scripts/corum-instance.sh stop --home=verify
./scripts/corum-instance.sh start --home=verify

# 3. CDP 冲烟
node scripts/corum-smoke.mjs
```

**每步验证**：

- 打包 0 错（注意红线：`pack-macos.mjs` 的 `buildApp()` 会临时清空 `dependencies` 再恢复）。
- CDP 冲烟：UI 渲染 + 行为 + 零 console error。
- 子 agent 委派路径（起子 agent → 发消息 → 子进程存活）正常。

---

## 5. 验收标准

| 编号 | 验收项 | 判据 |
|---|---|---|
| V1 | 产品决策清单已拍板 | D1/D2/D3 三项有明确结论 |
| V2 | acp provider 装配 | `pnpm install` 0 错 + 闭包含 `dsh-acp` / `dsh-subagent-acp` |
| V3 | 能力面互斥表已记录 | 本文档 §4.3 六行全在 |
| V4 | BUG `cf58d502` 子 agent 路径修复 | 卸载扩展包后子会话 bash 工具仍可用 |
| V5 | CDP 冲烟 | UI 渲染 + 行为 + 零 console error |
| V6 | fork-drift 守卫 | 装配后 drift 不扩大 |

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| acp provider 能力面不足，用户期望全量切换 | **高** | §4.3 互斥表明确标注；全量切换列为可选后续项 |
| 子进程命令形态未定就开工 | **高** | §4.1 产品决策清单必须先拍板 |
| flock addon 在 43.4.1 下不可加载（acp 子进程会起独立 runtime，依赖 flock） | 中 | 阶段 4.5 前置验证兜底 |
| disabled 行被 filter 掉导致官方包重激活 | **高** | 红线 5：不 filter disabled 行 |
| 顶层会话一侧未修（属阶段 6） | 中 | §1.3 范围边界明确标注 |
| corum-subagent rebase 基线落后（0.1.3-alpha.1） | 中 | 阶段 3 已处理，但 acp 装配后需回归验证 |

---

## 7. 回滚方案

| 场景 | 回滚操作 |
|---|---|
| acp provider 装配后出问题 | cordis.patch.yml 的 acp 行标 `disabled: true`（不删行）→ 重打包 → 回到 corum-spawn/fork/isolated 三 provider |
| BUG `cf58d502` 未修复 | acp provider 是可选路径，禁用后回退到 in-process 变体（原始 BUG 仍在但不阻塞） |
| flock addon 不可加载 | 回退到阶段 4.5 决策树，先升 Electron |

---

## 8. 产出物与下游接口

| 产出物 | 路径 | 下游 |
|---|---|---|
| acp provider 装配提交 | git commit | 阶段 6（顶层 sidecar 可复用 acp 协议） |
| 能力面互斥表 | 本文档 §4.3 | 用户决策全量切换时参考 |
| BUG `cf58d502` 子 agent 路径验收记录 | `docs/upgrade-0.2.1-rc3/verification-log.md` | 用户验收 |
| 产品决策清单结论 | 本文档 §4.1 | 后续 fork `subagent-acp` 时参考 |

### 可选后续项

- **fork `subagent-acp` 本身**：若用户需要全量切换到 acp（带 corum 委派轴心的 worktree 隔离 / 角色契约 / agentPreset / 结构化输出 / 深度上限），需 fork `subagent-acp` 源码补能力面。工程量大，独立排期。

---

## 9. 实录要求

- 产品决策清单的拍板时间 + 决策人 + 结论。
- 装配步骤的每步命令 + 退出码 + 闭包产物路径。
- 能力面互斥表的验证依据（官方源码行号或 README 引文）。
- BUG `cf58d502` 验收用例的执行截图 / 日志。
- CDP 冲烟截图 + console 清查记录。
- 与计划的偏差如实记录。
