# 阶段 6：顶层会话 sidecar（自研）

> 状态：可行性确认 + 设计任务书（不含代码） | 前置：阶段 5 完成 | 工程量：大（自研，可独立排期）

---

## 1. 目标与范围

### 1.1 目标

**自研顶层会话进程隔离（sidecar 架构）**，完成方案 C 的第二步（第一阶段 5 已完成子 agent 进程隔离）。

原始问题（commit `cf58d502`）有两个路径：
- ✅ 子 agent 路径——阶段 5 已通过 acp 子进程隔离修复。
- ❌ 顶层会话路径——顶层会话（卸载插件的那一侧）仍在主进程内，卸载扩展包时 Loader 重 init 仍会破坏顶层会话的工具表。**本阶段解决这一侧**。

### 1.2 定位：官方未做，corum 需自研

**官方 0.2.1 未做顶层会话进程化**。证据（评审证据 §B3）：

1. 0.2.1-rc.3 六个 bundle 中，`base` / `web-app` / `headless` / `sdk-app` / `sdk-minimal` 五者的 `cordis.patch.yml` grep `acp` **全为空**；唯一挂 acp 的是 `bundle/acp-app`（`- id: acp / name: '@deepseek-ai/dsh-acp'`），但那是「automation-only 的 ACP 端点应用」，不是把顶层用户会话进程化。
2. `base/cordis.patch.yml:359-370`：官方自己的顶层装配是 `subagent`（seam）+ `subagent-spawn-in-process` + `subagent-fork-in-process`，**全 in-process**。
3. `.agents/notes/`（3818 件）grep 无「顶层会话进程化 / top-level session ACP」相关设计稿——最接近的只有 `acp-selection`（模型选择）与 `subprocess-seam` 等已归档件。

**结论**：顶层会话 sidecar 是 corum 自研项，无可直接搬运的官方实现。

### 1.3 范围边界

> **本册只定边界，不定设计。**

| 在本阶段（本册） | 不在本阶段（本册） |
|---|---|
| 可行性确认（可复用积木已就位） | sidecar 进程生命周期归属的方案设计 |
| 设计任务书（明确待定项 + 边界） | 与 Electron 主进程的 IPC 面设计 |
| 建议单独立项文档做方案设计 | 崩溃恢复与租约接管的方案设计 |
| | 三平台 fork / 信号量差异的方案设计 |
| | 代码实现 |

---

## 2. 前置条件

| 前置 | 来源 | 确认方式 |
|---|---|---|
| 阶段 5 完成（acp provider 装配 + BUG 子 agent 路径修复） | `docs/upgrade-0.2.1-rc3/07-acp-subagent-isolation.md` | 验收 V1–V6 全过 |
| 阶段 4.5 flock addon 验证通过 | `docs/upgrade-0.2.1-rc3/06-verification.md` §4.6 | addon 可加载 |
| SessionWriteLease 可用（0.2.1 预编译 flock addon） | 可行性文档 §2.1 | 子进程写 jsonl 路径验证过 |
| subprocess seam 可用 | 评审证据 §B2 | `dsh-subprocess` / `dsh-subprocess-local` 在闭包 |
| acp 协议可用 | 阶段 5 装配 | `dsh-acp` 在闭包 |

---

## 3. 输入与依赖

### 3.1 输入

| 输入 | 路径 / 来源 | 用途 |
|---|---|---|
| 可行性评估（单一事实源） | `docs/UPGRADE-0.2.1-rc3-feasibility.md` §2.2 + §六 阶段 6 | 定位 + 可复用积木 |
| 评审证据 §B3 | `~/.corum/research-reports/06867ebb-…-d847-4ac5-97e7-4edab2ac1d23.md` §B3 | 官方未做顶层进程化全证 |
| 评审证据 §B4 | 同上 §B4 | SessionWriteLease 时间线 + flock addon |
| 原始 BUG | commit `cf58d502` | 顶层会话路径问题定义 |
| 红线 7（三平台） | `AGENTS.md` 红线 7 + `docs/dev-conventions.md` §16 | 三平台 fork/信号量差异 |

### 3.2 可复用积木

> 以下三个积木已在 0.2.1 就位，sidecar 自研可直接复用。

| 积木 | 包 | 自何时 | 作用 | sidecar 复用方式 |
|---|---|---|---|---|
| Subprocess seam | `dsh-subprocess` + `dsh-subprocess-local` | 0.1.4 前 | 进程管理抽象，背景进程生命周期脱离 executor fiber | sidecar 进程的生命周期管理走 seam |
| 跨进程会话写租约 | `SessionWriteLease`（`session-persistence-jsonl` 包内） | 0.1.3-alpha.1 起（0.1.5 已含，0.2.1 预编译 flock addon `d927cbff99`） | 内核级 flock(POSIX) / 命名信号量(Win)，多进程操作同一会话的协调 | sidecar 进程与主进程读写同一会话 jsonl 时用租约防冲突 |
| ACP 协议 | `dsh-acp` | 0.1.0-rc.7 | JSON-RPC stdio 驱动持久化 agent | sidecar 进程与主进程的 RPC 通信走 acp 协议 |

**三个积木的组合**：subprocess seam 管 sidecar 进程生死 → acp 协议管主↔sidecar 通信 → SessionWriteLease 管两边写同一会话不冲突。

---

## 4. 执行步骤

### 4.1 可行性确认

**结论：可行**。三个可复用积木（subprocess seam + SessionWriteLease + acp 协议）均在 0.2.1 就位，sidecar 自研有现成基础设施。

**确认依据**：

1. subprocess seam 已在 corum 打包闭包（评审 §B2 实证：`build/host/node_modules/@deepseek-ai/` 下有 `dsh-subprocess` + `dsh-subprocess-local`）。
2. SessionWriteLease 自 0.1.3-alpha.1 起就有（0.1.5 已含），0.2.1 版升级为预编译 Node-API flock addon（`d927cbff99`，37 文件 +2621/−544），形态是「内核级 flock(POSIX) / 命名信号量(Win)」——跨进程协调的正解。
3. acp 协议已在阶段 5 装配（`dsh-acp` 在闭包）。

### 4.2 设计待定项（本册只定边界不定设计）

> 以下五项是 sidecar 方案设计必须回答的问题，但**本册只标注边界与约束，不做方案设计**。方案设计单独立项文档。

| 编号 | 待定项 | 边界 / 约束 | 备注 |
|---|---|---|---|
| S1 | sidecar 进程生命周期归属 | 必须脱离 Electron renderer fiber；生命周期不能绑在单个窗口上（窗口关了 sidecar 不应死） | 可参考 subprocess seam 的「背景进程生命周期脱离 executor fiber」模式 |
| S2 | 与 Electron 主进程的 IPC 面 | 主进程（Electron main）↔ sidecar 进程的通信通道；不能走 renderer（renderer 可被用户关掉） | acp 协议（JSON-RPC stdio）是候选 |
| S3 | 崩溃恢复与租约接管 | sidecar 崩溃后会话租约如何释放 / 主进程如何接管 / 用户是否感知 | SessionWriteLease 的 flock 在进程崩溃时由内核自动释放（POSIX flock 特性），但会话状态恢复需设计 |
| S4 | 三平台 fork / 信号量差异（红线 7） | macOS/Linux 用 fork + POSIX flock；Windows 无 fork（用 CreateProcess）+ 命名信号量；路径 join 不能用 `/`-only | 红线 7：每个设计决策问「darwin/linux/win32 是否不同」；参考 `docs/dev-conventions.md` §16 + `docs/PLATFORM-SPLIT.md` §4.2（约 35 处隐式假设） |
| S5 | 会话迁移 | 存量 in-process 会话如何切到 sidecar；是否需要 V4 格式（阶段 4 迁移预演的输出） | 与阶段 4 V3→V4 迁移报告联动 |

### 4.3 建议：单独立项文档

**建议**：sidecar 方案设计单独立项，产出 `docs/PLAN-*.md`（如 `docs/PLAN-2026-XX-top-level-sidecar-design.md`），再做方案设计。

**理由**：

1. 顶层会话进程化是 corum 首次自研进程隔离架构，设计复杂度高（五项待定 + 三平台差异 + 崩溃恢复）。
2. 本升级文档系列定位是「升级执行文档」，sidecar 自研已超出「升级」范畴，属于「升级后的能力建设」。
3. 单独立项可独立排期，不阻塞 0.2.1 升级本身的收口（阶段 1–5 已覆盖升级全流程）。

**本阶段只交付**：

- ✅ 可行性确认（§4.1）
- ✅ 设计任务书（§4.2 待定项 + §3.2 可复用积木 + §1.2 定位）
- ❌ 不含代码
- ❌ 不含方案设计

---

## 5. 验收标准

| 编号 | 验收项 | 判据 |
|---|---|---|
| V1 | 可行性确认 | §4.1 结论明确（可行 + 三积木就位） |
| V2 | 设计任务书评审通过 | §4.2 五项待定项边界清晰，由用户/架构评审通过 |
| V3 | 不含代码 | 本阶段交付物为文档，无源码改动 |

> 本阶段验收 = 任务书评审通过，不含代码。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| sidecar 自研复杂度高，排期失控 | **高** | §4.3 建议单独立项，独立排期，不阻塞升级收口 |
| 三平台 fork/信号量差异导致隐式 bug（红线 7） | **高** | §4.2 S4 明确约束；方案设计时逐项过三平台判据 |
| 崩溃恢复设计不足导致会话丢失 | **高** | §4.2 S3 明确约束；SessionWriteLease 的 flock 崩溃自动释放是底线 |
| 与阶段 4 V3→V4 迁移报告联动不足 | 中 | §4.2 S5 标注联动 |
| Electron 43.4.1 vs 44.7 的 addon 指纹差影响 sidecar | 中 | 阶段 4.5 已验证；若 sidecar 用独立 Node runtime（非 Electron），指纹差不适用 |
| 顶层会话路径 BUG（`cf58d502`）在 sidecar 落地前仍存在 | 中 | 阶段 5 已修子 agent 路径；顶层路径在 sidecar 落地前靠「不热卸载扩展包」规避 |

---

## 7. 回滚方案

本阶段不含代码，**回滚 = 不立项**。

- 若设计任务书评审未通过 → 修订或搁置，顶层会话继续走 in-process（原始 BUG 的顶层路径仍在，但不阻塞）。
- 若 sidecar 实现后出问题 → 禁用 sidecar，回退到 in-process 顶层会话。

---

## 8. 产出物与下游接口

| 产出物 | 路径 | 下游 |
|---|---|---|
| 可行性确认 + 设计任务书 | 本文档 | `docs/PLAN-*.md`（sidecar 方案设计立项） |
| 可复用积木清单 | 本文档 §3.2 | 方案设计时直接引用 |
| 设计待定项边界 | 本文档 §4.2 | 方案设计必须逐项回答 |

---

## 9. 实录要求

- 可行性确认的依据（三积木就位的验证记录）。
- 设计任务书评审的时间 + 参与人 + 结论。
- 待定项边界在方案设计时的回答情况。
- 与计划的偏差如实记录。
