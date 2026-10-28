# 阶段 6：顶层会话 sidecar（自研）

> 状态：设计任务书评审修订完成，待阶段 5 前置 | 前置：阶段 5 完成 | 工程量：大（自研，可独立排期）
>
> **本阶段不写代码。** 本册是设计任务书（边界与待定项），不含方案设计、不含源码实现。
> 评审修订（2026-10-30 编排报告 #46）：基于官方 0.2.1-rc.3 源码 `git show` 只读复核 + 两路评审（架构能力面 / 事实准确性）合并，修正事实性错误、收紧待定项边界、补 S6–S12 待定项、拆分验收为 DoR/DoD。

---

## 1. 目标与范围

### 1.1 目标

**自研顶层会话进程隔离（sidecar 架构）**，完成方案 C 的第二步（阶段 5 装配子 agent 进程隔离为第一步）。

原始问题（2026-10-26 热卸载 corum-dev 扩展包破坏运行中会话的事故，会话 ID `cf58d502-c658-48e2-9eb6-36afc562b468`，非 git commit）有两个路径：
- ✅ 子 agent 路径——**目标：阶段 5 通过 acp 子进程隔离修复；待阶段 5 验收实际完成后确认**。本册不宣称阶段 5 已实证修复。
- ❌ 顶层会话路径——顶层会话（卸载插件的那一侧）仍在主进程内，卸载扩展包时 Loader 重 init 反注册工具，导致运行中会话命中 `ToolNotFoundError`，会话不可恢复。**本阶段解决这一侧**。

> **事故根因**：corum 单进程架构下，所有插件、工具、子 agent 共享同一个进程。热卸载扩展包时 Loader 重 init 反注册工具，运行中会话的工具表被破坏。这不是某个 git commit 引入的 BUG，而是架构缺陷在热卸载触发条件下暴露。`cf58d502` 是会话 ID（非 git 对象，已核实不存在于任何 repo）。

### 1.2 定位：官方未做，corum 需自研

**官方 0.2.1 未做顶层会话进程化**。证据（评审证据 §B3）：

1. 0.2.1-rc.3 六个 bundle 中，`base` / `web-app` / `headless` / `sdk-app` / `sdk-minimal` 五者的 `cordis.patch.yml` grep `acp` **全为空**；唯一挂 acp 的是 `bundle/acp-app`（`- id: acp / name: '@deepseek-ai/dsh-acp'`），但那是「automation-only 的 ACP 端点应用」，不是把顶层用户会话进程化。
2. `base/cordis.patch.yml:359-370`：官方自己的顶层装配是 `subagent`（seam）+ `subagent-spawn-in-process` + `subagent-fork-in-process`，**全 in-process**。
3. `.agents/notes/`（3818 件）grep 无「顶层会话进程化 / top-level session ACP」相关设计稿——最接近的只有 `acp-selection`（模型选择）与 `subprocess-seam` 等已归档件。

**结论**：顶层会话 sidecar 是 corum 自研项，无可直接搬运的官方实现。

### 1.3 范围边界

> **本册只定边界，不定设计，不定方案。**

| 在本阶段（本册） | 不在本阶段（本册） |
|---|---|
| 可行性确认（可复用积木已就位） | sidecar 进程生命周期归属的方案设计 |
| 设计任务书（明确待定项 + 边界） | 与 Electron 主进程的 IPC 面设计 |
| 建议单独立项文档做方案设计 | 崩溃恢复与租约接管的方案设计 |
| | 三平台 spawn / 信号量差异的方案设计 |
| | 代码实现 |

---

## 2. 前置条件

| 前置 | 来源 | 确认方式 |
|---|---|---|
| 阶段 5 完成（acp provider 装配 + 子 agent 路径修复） | `docs/upgrade-0.2.1-rc3/07-acp-subagent-isolation.md` | 阶段 5 验收全部通过（当前状态 ☐ 待开工） |
| 阶段 4.5 flock addon 验证通过 | `docs/upgrade-0.2.1-rc3/06-verification.md` §4.6 | addon 可加载（macOS 已验证；Linux/Windows 未验证） |
| SessionWriteLease 可用（0.2.1 预编译 flock addon） | 可行性文档 §2.1 | 子进程写 jsonl 路径验证过 |
| subprocess seam 可用 | 评审证据 §B2 | `dsh-subprocess` / `dsh-subprocess-local` 在闭包 |
| acp 协议可用 | 阶段 5 装配 | **待阶段 5 装配**：`package.json` 已声明 `@deepseek-ai/dsh-acp: ^0.2.1-rc.3` + `dsh-subagent-acp: ^0.2.1-rc.3`，但阶段 5 尚未执行，当前打包闭包是否已含 dsh-acp 需阶段 5 完成后确认 |

> **注意**：前置条件表中「acp 协议可用」原先写「阶段 5 装配 / dsh-acp 在闭包」——这是不实表述，阶段 5 尚未执行。已修正为「待阶段 5 装配」。

---

## 3. 输入与依赖

### 3.1 输入

| 输入 | 路径 / 来源 | 用途 |
|---|---|---|
| 可行性评估（单一事实源） | `docs/UPGRADE-0.2.1-rc3-feasibility.md` §2.2 + §六 阶段 6 | 定位 + 可复用积木 |
| 评审证据 §B3 | `~/.corum/research-reports/06867ebb-…-d847-4ac5-97e7-4edab2ac1d23.md` §B3 | 官方未做顶层进程化全证 |
| 评审证据 §B4 | 同上 §B4 | SessionWriteLease 时间线 + flock addon |
| 原始事故 | 会话 `cf58d502-c658-48e2-9eb6-36afc562b468`（会话 ID，非 git commit；备份已保全） | 顶层会话路径问题定义 |
| 红线 7（三平台） | `AGENTS.md` 红线 7 + `docs/dev-conventions.md` §16 | 三平台 spawn / 信号量差异 |

### 3.2 可复用积木

> 以下三个积木已在 0.2.1 就位。**但「积木就位」不等于「可直接复用为 sidecar 通信通道」**——ACP 协议的能力面需独立评估（见 §4.2 S2）。

| 积木 | 包 | 自何时 | 作用 | sidecar 复用方式 |
|---|---|---|---|---|
| Subprocess seam | `dsh-subprocess` + `dsh-subprocess-local` | 0.1.4 前 | 进程管理抽象 | sidecar 进程的生命周期管理走 seam |
| 跨进程会话写租约 | `SessionWriteLease`（`session-persistence-jsonl` 包内） | 0.1.3-alpha.1 起（0.1.5 已含，0.2.1 预编译 flock addon `d927cbff99`） | 内核级跨进程写锁：POSIX 用 `@deepseek-ai/node-addon-system@0.1.2` 的 Node-API v8 flock(2) addon（仅 linux/darwin）；Windows 用 koffi FFI 调 `kernel32.dll` `CreateSemaphoreW` 命名内核信号量（无 native addon）；两者均在进程崩溃时由内核自动释放 | sidecar 进程与主进程读写同一会话 jsonl 时用租约防冲突 |
| ACP 协议 | `dsh-acp` | 0.1.0-rc.7 | JSON-RPC stdio 驱动持久化 agent | **仅作为 automation 基础面候选**——ACP 是为 out-of-process subagent 设计的 automation-only 协议，能力面不足以承载 corum 顶层交互会话（详见 §4.2 S2） |

**三个积木的组合关系**：subprocess seam 管 sidecar 进程生死 → SessionWriteLease 管两边写同一会话不冲突 → 通信通道待定（ACP 是候选之一，但不可直接复用，见 S2）。

---

## 4. 执行步骤

### 4.1 可行性确认

**结论：可行**。三个可复用积木（subprocess seam + SessionWriteLease + acp 协议）均在 0.2.1 就位，sidecar 自研有现成基础设施。

**确认依据**：

1. subprocess seam 已在 corum 打包闭包（评审 §B2 实证：`build/host/node_modules/@deepseek-ai/` 下有 `dsh-subprocess` + `dsh-subprocess-local`）。**但 subprocess seam 的进程生命周期绑在 host 进程的 exit 事件上（见 S1），不保证 sidecar 独立于 host 退出存活。**
2. SessionWriteLease 自 0.1.3-alpha.1 起就有（0.1.5 已含），0.2.1 版升级为预编译 Node-API flock addon（`d927cbff99`，37 文件 +2621/−544）。**POSIX 与 Windows 内核锁均在进程崩溃时由内核自动释放**（POSIX flock 文件锁随 fd 关闭释放；Windows 命名信号量句柄随进程退出关闭释放）。
3. acp 协议**待阶段 5 装配**（`package.json` 已声明 `@deepseek-ai/dsh-acp` + `dsh-subagent-acp: ^0.2.1-rc.3`，但阶段 5 尚未执行，当前打包闭包是否已含 dsh-acp 需阶段 5 完成后确认）。

### 4.2 设计待定项（本册只定边界不定设计）

> 以下十二项是 sidecar 方案设计必须回答的问题，但**本册只标注边界与约束，不做方案设计，不定案**。方案设计单独立项文档。
>
> 编号 S1–S5 为原有待定项（边界已收紧），S6–S12 为本次评审新增的必须补充项。

| 编号 | 待定项 | 边界 / 约束 | 备注 |
|---|---|---|---|
| S1 | sidecar 进程生命周期归属 | **owner 候选矩阵**（本册不定案，禁止提前选定）：<br>① Electron main 进程——生命周期最长（窗口关了不死），但 main 退出 = sidecar 死；main 无 cordis ctx<br>② host root ctx（cordis）——cordis 服务自然 owner（dispose 钩子），但 host 随 main 退，不独立于 main<br>③ 独立 supervisor 进程——真正独立于 Electron，但 corum 无此架构，需自研<br><br>**关键约束（官方源码已核实）**：subprocess seam 绑定 host 进程 exit——`subprocess-local/src/index.ts:93-94`：`process.prependListener('exit', onHostExit)` → `onHostExit = () => { this.terminateForHostExit() }`（同步强制终止所有托管句柄和终端）。因此 **sidecar 经 subprocess seam 托管时不保证独立于 host 进程死亡存活**。<br><br>**后续硬决策**：必须明确「窗口关闭时 sidecar 是否存活」「主进程退出时 sidecar 是否存活」是否为硬需求——如果是，subprocess seam 不够用，需自研 supervisor 或接受「main 退出 = sidecar 死」 | 不再表述为「脱离 Electron renderer fiber」——真正的问题不是 renderer fiber，而是 host 进程本身的生命周期 |
| S2 | 与 Electron 主进程的通信通道 | **ACP 仅是 automation 基础面，不可直接复用为 sidecar 通信通道**（已核实 `dsh-acp` README + `subagent-acp/src/index.ts:81-86`）：<br><br>ACP 能承载：prompt、partial updates（agent_message_chunk）、model switching（set_config_option + config_option_update）<br>ACP 不足：permission（只有 allow-once/reject-once，无 always/inherit）<br>ACP 不承载：elicitation / ask_user_question（明确排除）、compaction 事件转发、goal / plans、subagent UI 事件、todo / task status、corum 自有通知<br><br>**三个候选方案**（本册不定案，禁止「直接复用 ACP」）：<br>• 选项 A：扩展 ACP（fork `dsh-acp`，在 session/update 中增加 corum 自有事件转发）——违背 ACP 设计哲学，SessionUpdate 类型是 closed union<br>• 选项 B：自研 RPC 面（走 corum 自有 IPC，只复用 subprocess seam + SessionWriteLease）<br>• 选项 C：ACP 基础面 + 辅助通道（ACP 管标准语义更新，corum 自有 IPC 管交互事件）——双通道，复杂度最高 | ACP README 第 32 行明确：「Avoid it when a human needs DSH-specific presentation cards, plans, titles, todos, terminal views, or elicitation」；第 80 行不支持列表含 elicitation / plans / terminals / goals |
| S3 | 崩溃恢复与租约接管 | **flock 释放 ≠ 会话状态恢复**（三约束）：<br>① **jsonl 重建 tracker**：主进程的 `sessionPersistence` 持有 in-process write tracker，sidecar 无法读主进程内存状态——必须从 jsonl 文件重建写入位置<br>② **正常/崩溃租约交接**：正常切换 = 主进程 `lease.release()` → sidecar `lease.acquire()`；崩溃切换 = flock 内核自动释放 → sidecar acquire 成功——但 sidecar 不知道主进程是否真的崩溃还是只是慢（flock 无超时，卡死进程不会被抢占）<br>③ **探活/心跳**：需设计主进程心跳/探活机制以区分「崩溃」与「慢」<br><br>**未 flush 数据丢失口径**：崩溃时未 flush 的写入在 jsonl 文件中不存在，恢复时无法找回——这是已知约束，需在设计阶段明确定义丢失边界<br><br>**内核锁崩溃释放（POSIX 与 Windows 均成立）**：POSIX flock 随 fd 关闭释放；Windows 命名信号量句柄随进程退出关闭释放——两者均在进程崩溃时由内核自动释放（已核实 `lease.ts:76-85` 平台分支 + `win32.ts` koffi 实现） | 不再表述为「会话状态恢复需设计」——需明确三约束 |
| S4 | 三平台 spawn / 进程树终止差异（红线 7） | **官方源码已核实**（`git show dsh-v0.2.1-rc.3:packages/subprocess/subprocess-local/src/spawn.ts`）：<br>• **macOS/Linux**：`child_process.spawn()` with `detached: true`（进程组）+ POSIX flock(2)（Node-API addon）；进程树终止用 `process.kill(-pid, sig)`（负 PID = 进程组信号），SIGTERM → grace → SIGKILL<br>• **Windows**：`spawn()` with `detached: false` + `windowsHide: true` + `taskkill /PID <pid> /T /F` 进程树终止（`/T` = 递归子树，`/F` = 强制）；跨进程锁用 `CreateSemaphoreW` 命名内核对象（经 koffi FFI，非 native addon）<br>• **路径 join**：不能用 `/`-only（Windows 用反斜杠，Node 的 `path.join` 已处理，但硬编码 `/` 会失败）<br><br>**不写 macOS/Linux fork 或 Windows CreateProcess 为 seam 实现**——subprocess seam 不直接调用 fork / CreateProcess，而是用 Node `child_process.spawn()` + 平台差异在 spawn 选项层 | 红线 7：每个设计决策问「darwin/linux/win32 是否不同」；参考 `docs/dev-conventions.md` §16 + `docs/PLATFORM-SPLIT.md` §4.2（约 35 处隐式假设） |
| S5 | 会话迁移 | **不假设迁移全部成功**（v4-migration-report 已实证）：<br>• 存量会话 909 文件（v2=536, v3=373, v4=0），903/946（95.7%）可迁移到 v4<br>• **43 个不可迁移**（v2 旧 descriptor 28 + v3 未关闭工具调用 8 + v0 旧 descriptor 5 + 其他 2）<br><br>**迁移窗口并发写风险**：sidecar 启动时主进程可能仍持有存量会话的写租约（SessionWriteLease），sidecar acquire 会得 `SessionAlreadyOwnedError`——需设计迁移协议（等租约释放 / 主进程主动让出 / quarantine 不可迁移会话）<br><br>**单写者约束**：同一会话 jsonl 在任一时刻只有一个写者持有租约，迁移期间不能两边同时写<br><br>是否需要 V4 格式取决于 sidecar 的持久层版本 | 与阶段 4 V2→V3→V4 迁移报告联动（`docs/upgrade-0.2.1-rc3/v4-migration-report.md`） |
| S6 | 身份 / 凭据传递 | sidecar 进程需 LLM API key 等凭据；subprocess seam 的 `scrubbedParentEnv` 不传 credential-shaped names（已核实 `spawn.ts` `childEnv()`）；ACP `authMethods: []` 无认证机制。需设计凭据传递通道——不复制父 env secrets（参考阶段 5 D2 决策：子进程读同一 `CORUM_HOME`/`DSH_HOME` 的官方 profile/settings/credentials 机制） | 新增项 |
| S7 | 工作区（cwd）同步 | sidecar 需获取/同步顶层会话的工作区；ACP `session/new` 要求绝对 cwd（`request.cwd` → `assertUsableCwd`）。需设计 cwd 传递与同步机制 | 新增项 |
| S8 | 权限 / confined / worktree 档位 | corum 有完整权限体系（tool-policy / sandbox / confined / worktree）；ACP 只有 `allow-once` / `reject-once`（`z.union(['allow','reject'])`，无 `inherit`/`always`）。sidecar 如何继承主进程的权限档位需设计——阶段 5 的 `permission: reject` 是负例验证基线，sidecar 顶层会话需要完整权限语义 | 新增项 |
| S9 | 会话索引与激活 | sidecar 的会话如何被主进程 UI 发现 / 切换 / 激活；会话索引是否走主进程统一索引还是 sidecar 自维护；跨进程的会话列表一致性 | 新增项 |
| S10 | 通知 / 任务状态通道 | corum 通知在主进程；sidecar 的 agent / goal / subagent / todo 事件如何到达 UI；不能走 ACP（ACP 不转发 corum 自有事件，见 S2） | 新增项 |
| S11 | sidecar 进程运行时 | **独立 Node runtime**（非 Electron 内嵌 Node）：host 运行时是 `build/node/bin/node` v26.4.0（已核实 `main.ts` `hostNode()`），Electron 只负责窗口 shell，host 桥在独立 Node 子进程中运行。sidecar 应复用此模式（影响 native addon 兼容性 / flock / 三平台）。**Electron 版本指纹差不适用**（`06-verification.md` §4.6 已删 V8 指纹错误前提：flock 用 Node-API v8 ABI 稳定，与 Electron 版本无关） | 新增项；与 S4 的三平台覆盖一致 |
| S12 | sidecar 插件链与热卸载边界 | **主 loader 隔离不等于 sidecar 自身热重载安全**：<br>① sidecar 是独立 cordis context，需自己 boot 插件链——谁加载、加载哪些子集（全量 vs 会话相关 vs 工具表序列化传入）需设计<br>② sidecar 隔离的是**主进程的 Loader 重 init**，不是**自己的 Loader 重 init**——如果 sidecar 也需运行时热卸载插件，则 sidecar 内部仍会破坏自己的工具表<br>③ 必须明确「sidecar 是否支持运行时热卸载插件」——如果不支持（只重启时更新），则热卸载问题在 sidecar 内部消失 | 新增项；直击 §1.1 事故根因 |

### 4.3 建议：单独立项文档

**建议**：sidecar 方案设计单独立项，产出 `docs/PLAN-*.md`（如 `docs/PLAN-2026-XX-top-level-sidecar-design.md`），再做方案设计。

**理由**：

1. 顶层会话进程化是 corum 首次自研进程隔离架构，设计复杂度高（十二项待定 + 三平台差异 + 崩溃恢复 + ACP 能力面评估）。
2. 本升级文档系列定位是「升级执行文档」，sidecar 自研已超出「升级」范畴，属于「升级后的能力建设」。
3. 单独立项可独立排期，不阻塞 0.2.1 升级本身的收口（阶段 1–5 已覆盖升级全流程）。

**本阶段只交付**：

- ✅ 可行性确认（§4.1）
- ✅ 设计任务书（§4.2 待定项 S1–S12 + §3.2 可复用积木 + §1.2 定位）
- ❌ 不含代码
- ❌ 不含方案设计
- ❌ 不提前选 owner 方案 / 不提前选 RPC 方案

---

## 5. 验收标准

> **DoR / DoD 拆分**：本册验收（DoR）= 任务书评审通过（不含代码、不含方案设计、不含原型）；后续设计/原型阶段验收（DoD）= 方案设计 + 最小 POC + 威胁模型 + 故障注入 + 三平台 + 并发写 + 热卸载 + UI 事件完整性。

### 5.1 本册 DoR（Definition of Ready）

| 编号 | 验收项 | 判据 |
|---|---|---|
| V1 | 可行性确认 | §4.1 结论明确（可行 + 三积木就位 + 边界约束已标注） |
| V2 | 设计任务书评审通过 | §4.2 十二项待定项（S1–S12）边界清晰，由用户/架构评审通过 |
| V3 | 不含代码 | 本阶段交付物为文档，无源码改动 |
| V4 | 事实准确性 | cf58d502 为会话 ID 非 commit；ACP 装配状态准确（待阶段 5）；平台实现描述与官方源码一致；addon 运行时描述准确（独立 Node 非 Electron） |
| V5 | 禁止过度乐观表述 | 不宣称「阶段 5 已实证修复」直到阶段 5 验收实际完成；不宣称「ACP 可直接复用」；不假设迁移全部成功 |

> 本阶段验收 = 任务书评审通过（DoR），不含代码、不含方案设计。

### 5.2 后续设计 / 原型阶段 DoD（Definition of Done）

> 以下验收项不属于本册，属于后续方案设计 / 原型实现阶段。本册列出以明确下游验收口径。

| 编号 | 验收项 | 判据 | 说明 |
|---|---|---|---|
| D1 | 威胁模型 | sidecar 进程边界的安全威胁建模完成（凭据泄露 / 进程逃逸 / 权限越界 / 孤儿进程） | S6 / S8 / S12 相关 |
| D2 | 故障注入 | 主进程崩溃 / sidecar 崩溃 / 租约竞争 / 热卸载触发场景的故障注入测试通过 | S3 / S12 相关 |
| D3 | 三平台覆盖 | macOS / Linux / Windows 三平台 spawn + flock/信号量 + 进程树终止验证 | S4 相关；macOS flock 已验证，Linux/Windows 未验证 |
| D4 | 并发写验证 | 主进程与 sidecar 同时写同一会话 jsonl 的并发场景验证（租约正确互斥） | S3 相关 |
| D5 | 热卸载验证 | sidecar 隔离主进程 Loader 重 init 的实证验证 + sidecar 自身热卸载边界验证 | S12 相关；直击事故根因 |
| D6 | UI 事件完整性 | sidecar 的 agent / goal / subagent / todo / notification 事件完整到达 UI | S10 相关；ACP 不转发 corum 自有事件 |
| D7 | 最小 POC | 可运行的最小 sidecar 原型（不要求生产就绪），验证进程隔离 + 通信 + 租约三积木组合可用 | 整体验收 |
| D8 | ACP 能力面实证 | 若选 S2 选项 A/C，fork ACP 或辅助通道转发 corum 自有事件的能力面实证完成 | S2 相关 |
| D9 | 会话迁移验收 | 存量会话切到 sidecar 的迁移协议验证（含 quarantine 不可迁移会话） | S5 相关 |

> **本册无源码**——D1–D9 全部属于后续阶段，本册不交付。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| sidecar 自研复杂度高，排期失控 | **高** | §4.3 建议单独立项，独立排期，不阻塞升级收口 |
| 三平台 spawn / 信号量差异导致隐式 bug（红线 7） | **高** | §4.2 S4 已核实官方源码；方案设计时逐项过三平台判据；macOS flock 已验证，Linux/Windows 未验证 |
| 崩溃恢复设计不足导致会话丢失 | **高** | §4.2 S3 明确三约束（jsonl 重建 / 租约交接 / 探活心跳）；未 flush 数据丢失为已知约束 |
| ACP 能力面不足以承载顶层交互会话 | **高** | §4.2 S2 明确 ACP 不可直接复用，三个候选方案待定案；禁止「直接复用 ACP」 |
| subprocess seam 绑 host exit，sidecar 不独立于 host 死亡 | **高** | §4.2 S1 owner 矩阵三候选 + host exit 绑定已核实源码；是否需独立于 main 退出为后续硬决策 |
| 热卸载隔离边界不完整（sidecar 自身热重载） | 中 | §4.2 S12 明确主 loader 隔离 ≠ 自身热重载安全 |
| 与阶段 4 V2→V3→V4 迁移报告联动不足 | 中 | §4.2 S5 标注联动 + 不可迁移会话口径 |
| flock addon 在独立 Node v26.4.0 下三平台加载 | 中 | host 用独立 Node runtime（`build/node/bin/node` v26.4.0），非 Electron 内嵌 Node；Electron 指纹差不适用（`06-verification.md` §4.6 已删 V8 指纹错误前提）；macOS 已验证（verification-log C.3），Linux/Windows 未验证 |
| 顶层会话路径事故（`cf58d502`）在 sidecar 落地前仍存在 | 中 | 阶段 5 目标修复子 agent 路径（待验收）；顶层路径在 sidecar 落地前靠「不热卸载扩展包」规避 |

---

## 7. 回滚方案

本阶段不含代码，**回滚 = 不立项**。

- 若设计任务书评审未通过 → 修订或搁置，顶层会话继续走 in-process（原始事故的顶层路径仍在，但不阻塞）。
- 若 sidecar 实现后出问题 → 禁用 sidecar，回退到 in-process 顶层会话。

---

## 8. 产出物与下游接口

| 产出物 | 路径 | 下游 |
|---|---|---|
| 可行性确认 + 设计任务书 | 本文档 | `docs/PLAN-*.md`（sidecar 方案设计立项） |
| 可复用积木清单 | 本文档 §3.2 | 方案设计时直接引用 |
| 设计待定项边界 | 本文档 §4.2 S1–S12 | 方案设计必须逐项回答 |
| 验收口径 DoR/DoD | 本文档 §5 | 本册 DoR = 任务书评审；后续阶段 DoD = D1–D9 |

---

## 9. 实录要求

- 可行性确认的依据（三积木就位的验证记录）。
- 设计任务书评审的时间 + 参与人 + 结论。
- 待定项边界在方案设计时的回答情况。
- 与计划的偏差如实记录。

---

## 附录 A：评审修订记录（2026-10-30 编排报告 #46）

> 两路评审合并：task 0（架构能力面深度评审）+ task 1（事实准确性 + 三平台 + 迁移评审）。
> 关键结论已用 `git -C /Users/kukucai/dsh show dsh-v0.2.1-rc.3:<path>` 独立只读复核。

### 修订清单

| # | 修订点 | 原文问题 | 修订内容 |
|---|---|---|---|
| 1 | cf58d502 provenance | 原文称「commit cf58d502」（第 13/62/143 行） | 修正为会话 ID `cf58d502-c658-48e2-9eb6-36afc562b468`（非 git commit，已核实不存在于任何 repo） |
| 2 | 事故描述 | 未准确描述事故根因 | 补充：2026-10-26 热卸载 corum-dev 扩展包破坏运行中会话 ToolNotFoundError；不称阶段 5 已实证修复，改「目标 / 待阶段 5 验收」 |
| 3 | S1 owner 矩阵 | 只说「脱离 renderer fiber」，未触及 host 进程死亡 | 补 owner 三候选（Electron main / host root ctx / 独立 supervisor）+ subprocess seam 绑 host exit 源码证据；明确窗口关闭/主进程退出存活为后续硬决策 |
| 4 | S2 ACP 能力面 | 说「acp 协议是候选」，过于乐观 | 改为 ACP 仅 automation 基础面，逐项对比 corum 需求（缺 elicitation/plans/todos/compaction/goal/subagent/corum notifications/permission 语义）；三候选方案不定案，禁止「直接复用 ACP」 |
| 5 | S3 崩溃恢复 | 只说「会话状态恢复需设计」，不完整 | 补三约束（jsonl 重建 tracker / 正常崩溃租约交接 / 探活心跳）+ 未 flush 数据丢失口径；POSIX 与 Windows 内核锁均崩溃释放 |
| 6 | S4 平台实现 | 说「macOS/Linux 用 fork + POSIX flock；Windows 用 CreateProcess」，与官方源码不符 | 改为准确描述：spawn detached POSIX 进程组 / Win taskkill；POSIX Node-API flock，Win koffi CreateSemaphoreW；不写 fork/CreateProcess 为 seam 实现 |
| 7 | S5 迁移 | 未展开迁移窗口 | 补迁移窗口 / 单写者 / 租约冲突 / quarantine 不可迁移会话（43 个）；不假设迁移全部成功 |
| 8 | 新增 S6–S12 | 原 S1–S5 缺 7 个必须补充项 | S6 凭据 / S7 cwd / S8 权限 / S9 会话索引 / S10 通知 / S11 独立 Node runtime / S12 插件链热卸载边界 |
| 9 | addon 指纹风险 | 说「Electron 43.4.1 vs 44.7 addon 指纹差影响 sidecar」 | 改为独立 Node v26.4.0 三平台 addon 验证；macOS flock 已验，Linux/Win 未验；ACP 闭包以阶段 5 实际为准，不提前宣称 |
| 10 | 验收 DoR/DoD | 只有 V1–V3，无 DoR/DoD 拆分 | 拆为本册 DoR（V1–V5）+ 后续 DoD（D1–D9：威胁模型/故障注入/三平台/并发写/热卸载/UI 事件完整性/最小 POC/ACP 能力面/迁移） |

### 已核实源码引用

| 声明 | 源码位置 | 核实方式 |
|---|---|---|
| subprocess seam 绑 host exit | `subprocess-local/src/index.ts:93-94,105-115` | `git show dsh-v0.2.1-rc.3` |
| POSIX flock + Windows 信号量平台分支 | `session-persistence-jsonl/src/lease.ts:76-85` | `git show dsh-v0.2.1-rc.3` |
| Windows koffi CreateSemaphoreW | `session-persistence-jsonl/src/win32.ts` | `git show dsh-v0.2.1-rc.3` |
| spawn detached/taskkill 平台差异 | `subprocess-local/src/spawn.ts` | `git show dsh-v0.2.1-rc.3` |
| ACP 能力面（capabilities 全 false） | `subagent-acp/src/index.ts:81-86` | 阶段 5 文档 07 册引用 |
| cf58d502 非 git commit | README + 07 册已纠正 | 本仓文档交叉核实 |

### 未独立复核项（委托方知悉）

以下来自评审报告，逻辑自洽但未由本阶段独立复核：
- `lease.ts` 的 in-process tracker 跨进程不可见性（task 0 引用 `index.ts:289,309`）
- 当前打包闭包是否已含 dsh-acp（阶段 5 未执行，无法确认）
- ACP `SessionUpdate` 类型是否为 closed union（task 0 标注「未深入验证」）
