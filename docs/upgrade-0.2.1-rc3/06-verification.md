# 阶段 4 + 4.5：三层验证与 Electron 指纹验证

> 状态：待执行 | 前置：阶段 3（fork 包 rebase）完成 | 工程量：中（验证为主，不含代码改动）

---

## 1. 目标与范围

本阶段是 0.2.1-rc.3 升级的质量收口环节。目标：

1. **三道编译/测试/漂移门禁全绿**——确认 6026 commit 的跨度没有引入编译期或测试期破坏点。
2. **实机 CDP 冲烟通过**——在真实 Electron 窗口里验证 UI 渲染 + 行为 + 零 console 错误，覆盖三平台原则。
3. **存量会话 V3→V4 迁移预演**——官方 0.2.1 新增 `session-format-v3-to-v4` 包，0.1.5 只有 v0→v3 迁移链；本阶段必须先出迁移报告再决定放行口径。
4. **阶段 4.5：Electron 指纹验证**——corum 钉 electron 43.4.1，官方 0.2.1 用 `^44.7.0`；`SessionWriteLease` 依赖预编译 Node-API flock addon，需验证在旧指纹下可加载。

**范围边界**：本阶段只读验证为主，不改动 fork 源码。若验证发现缺陷，缺陷修复回退到阶段 1/3 对应环节处理，本阶段不改代码。

---

## 2. 前置条件

| 前置 | 来源 | 确认方式 |
|---|---|---|
| 阶段 1 完成（4 个被删/更名包 + session-title API + HMR 形态经阶段 -1 裁决后处置） | `docs/UPGRADE-0.2.1-rc3-feasibility.md` §六 阶段 1 | git log 含对应提交 |
| 阶段 2 完成（override 重算 + lock 重生成 + 闭包审计） | §六 阶段 2 | `pnpm install` 0 错、`assert-packaged-boot.mjs` 过 |
| 阶段 3 完成（50 个 fork 包 rebase 到 0.2.1） | §六 阶段 3 | `docs/fork-delta.md` 台账标齐 |
| 主实例 :9222 不可动 | AGENTS 红线 5、`corum-instance.sh` | 冲烟只走 `--home=verify` |
| 官方 dsh 仓只读可访问 | `/Users/kukucai/dsh` @ `dsh-v0.2.1-rc.3` | `git -C /Users/kukucai/dsh tag -l 'dsh-v0.2.1-rc.3'` |
| 完整备份已做 | §六 阶段 0 | `~/.corum-backup-pre-0.2.1` 存在 |

---

## 3. 输入与依赖

### 3.1 输入

| 输入 | 路径 / 来源 | 用途 |
|---|---|---|
| 可行性评估（单一事实源） | `docs/UPGRADE-0.2.1-rc3-feasibility.md` | 阶段定义、评审修订 |
| 评审证据报告 B 节 | `~/.corum/research-reports/06867ebb-…-d847-4ac5-97e7-4edab2ac1d23.md` §B | 进程隔离全证、Electron 指纹 |
| 评审证据报告 E2d 节 | 同上 §E2d | Electron 43.4.1 vs 44.7 指纹差 |
| 评审证据报告 E3 节 | 同上 §E3 | acp 能力面分析（阶段 5 用，本阶段不直接用） |
| 0.1.5 升级实录 | 历史交接口径 `HANDOFF-2026-09-29-official-0.1.5-upgrade.md` §2（当前不在库，仅作背景） | 三条方法论（`--force`、npm 打包缺陷、实机不可替代） |
| 0.1.5 会话清理前车之鉴 | 同上 §4 | 14 个 v2 会话无法迁移，备份在 `~/.corum/sessions-removed-20260929/` |

### 3.2 工具依赖

| 工具 | 路径 | 作用 |
|---|---|---|
| `verify-fork-drift.sh` | `scripts/verify-fork-drift.sh` | fork 核心文件字节级对账 |
| `corum-instance.sh` | `scripts/corum-instance.sh` | verify 实例启停 |
| `corum-smoke.mjs` | `scripts/corum-smoke.mjs` | macOS X 层像素判据冲烟 |
| `corum-linux-verify` 技能 | `corum-dev-preset/skills/corum-linux-verify` | Linux 参考技能 |
| `tsc` / `vitest` | 全仓 devDependencies | 编译 + 测试 |

---

## 4. 执行步骤

### 4.1 门禁 ①：全仓强制 typecheck

**命令**：

```bash
tsc -b --force
```

**必须 `--force`**。`tsc -b` 是增量编译，会藏住破坏点——0.1.5 升级时增量编译 0 错，`--force` 后冒出 31 处报错。这个教训已记入历史交接 `HANDOFF-2026-09-29-official-0.1.5-upgrade.md` §2 方法论 ①（当前不在库，仅作背景），本次不得跳过。

**每步验证**：

- 退出码 = 0，无 `error TS` 输出。
- 若有错误：记录错误文件 + 错误码，回退到阶段 1/3 修复，修复后重跑 `--force`。

### 4.2 门禁 ②：全仓测试

**命令**：

```bash
pnpm -r run test
```

**每步验证**：

- 全部 suite 通过，0 失败。
- 测试数应 ≥ 0.1.5 基线（1932 通过）。若因 `dsh-invariants` 删除导致测试数略降属预期（可行性文档 §三·1 影响评估已标注）。
- 若有失败：记录失败 spec + 堆栈，回退到阶段 3 对应 fork 包修复。

### 4.3 门禁 ③：fork-drift 守卫

**命令**：

```bash
TMPDIR="$PWD/.corum-tmp" \
DSH_CHECKOUT=/Users/kukucai/dsh \
DSH_BASELINE_TAG=dsh-v0.2.1-rc.3 \
./scripts/verify-fork-drift.sh
```

**判据**：真实 tag 导出成功（无回落警告）+ 失败项数 ≤ 阶段 0 记录的基线 N 项（只许收敛不许扩大）。

**注意**：

- 阶段 0 以真实 tag 导出重跑并记录了基线 N 项失败（历史交接称 24 项，但无当前在库证据；评审试跑得 23 项但 TMPDIR 失效回落 rc.2，不能当真实基线）。切换基线到 `dsh-v0.2.1-rc.3` 后既存失败应随官方方向收敛（官方也删了 `invariant.ts`，drift 应收窄而非扩大）。**未跑前不得宣称 0/23/24**。
- `scripts/verify-fork-drift.sh` 的 `:1129` 循环清单与 `:1180` `SUBAGENT_DELTA_FILES` 已在阶段 1 去掉 `invariant.ts`（可行性文档 §三·1 新增步骤）。若未改，守卫自身误报——回阶段 1 补。
- 运行守卫前必须设 `TMPDIR="$PWD/.corum-tmp"`（该目录已在 .gitignore），防止 `mktemp` 在 `/var/folders` 被沙箱拒后静默回落 rc.2 使基线从未真正建立。运行后确认日志无「无法导出/回落到检出工作区」。

### 4.4 实机 CDP 冲烟

**原则**：

- 冲烟走 `--home=verify` 实例（`scripts/corum-instance.sh start --home=verify`），**不动主实例 :9222**。主实例是用户正在使用的，重启会毁掉用户工作（AGENTS 红线 5）。
- 三平台覆盖原则（红线 7）：macOS / Linux / Windows 每个改动都要问「是否在这三个平台上行为不同」。

**macOS 冲烟**：

```bash
# 1. 启 verify 实例
./scripts/corum-instance.sh start --home=verify

# 2. 跑冲烟（X 层真实像素判据）
node scripts/corum-smoke.mjs

# 3. CDP 实机验证（UI 渲染 + 行为 + 零 console 错误）
#    用 corum-cdp-verify 技能的流程：attach → 截图 → 比对 → 行为触发 → console 清查
```

**判据**：

- UI 渲染：X 层像素判据通过（`corum-smoke.mjs` 的像素对比）。
- 行为：核心交互路径（起会话 / 发消息 / 子 agent 委派 / 扩展包启停）全部正常。
- 零 console 错误：CDP `Runtime.consoleAPICalled` + `Log.entryAdded` 无 error 级别条目。

**Linux 冲烟**：

- 参考 `corum-dev-preset/skills/corum-linux-verify` 技能流程。
- 原生依赖必须在 Linux 上 install，交叉打包不通（历史交接 `HANDOFF-2026-10-08-…` §2 已验证，当前不在库，仅作背景）。

**Windows 冲烟**：

- ⚠️ **既知缺口**：Windows 真机未验。唯一前置 = 那台闲置笔记本（历史交接 `HANDOFF-2026-10-08-…` §3.1，当前不在库，仅作背景）。若笔记本不可用，本阶段如实标注「Windows 未验」并记录为遗留缺口，不强制。

### 4.5 V3→V4 会话迁移预演（阶段 4 新增）

**背景**：官方 0.2.1 新增 `session/session-format-v3-to-v4` 包（评审证据 §C 漏列项）。corum 现役 0.1.5 只有 v0→v3 迁移链。0.1.5 升级时 14 个 v2 会话无法迁移被清除（备份在 `~/.corum/sessions-removed-20260929/`），本次必须先出迁移报告再决定放行口径。

**步骤**：

```bash
# 1. 备份 verify 实例的 sessions（以防迁移有副作用）
cp -a ~/.corum-verify/sessions ~/.corum-verify/sessions-backup-pre-v4

# 2. 将真实存量会话（从主 home 拷一份到 verify 实例）
cp ~/.corum/sessions/*.jsonl ~/.corum-verify/sessions/

# 3. 启 verify 实例，触发会话格式迁移
./scripts/corum-instance.sh start --home=verify

# 4. 观察迁移日志（SessionWriteLease + format-v3-to-v4 包输出）

# 5. 记录不可迁移会话数
```

**每步验证**：

- 迁移后 verify 实例可正常打开历史会话。
- 记录：总会话数 / 成功迁移数 / 不可迁移数 / 不可迁移原因。
- **放行口径**：必须先出迁移报告（`docs/upgrade-0.2.1-rc3/v4-migration-report.md`），再由用户决定是否清理不可迁移会话。**不得直接清除**——0.1.5 的 14 个 v2 会话被清除是教训，本次必须先报告。

### 4.6 阶段 4.5：Electron 指纹验证

**背景**（评审证据 §E2d）：

- corum 钉 `electron: 43.4.1`（`packages/desktop/package.json`），官方 0.2.1 用 `^44.7.0`。
- 0.2.1 的 `SessionWriteLease` 依赖预编译 Node-API flock addon（commit `d927cbff99`），包内 37 文件 +2621/−544。
- `node-addon-native-custom-loader@0.1.9` 按 Electron 44.7.0 的 Node/V8 指纹识别。
- 若 corum 继续用 43.4.1 跑 host，需验证该 addon 在旧 V8 指纹下可加载。

**步骤**：

```bash
# 1. 确认 corum 当前 electron 版本
grep '"electron"' packages/desktop/package.json

# 2. 在 verify 实例（43.4.1）下实际加载 flock addon
./scripts/corum-instance.sh start --home=verify

# 3. CDP attach，触发 SessionWriteLease 读写路径
#    （起一个子 agent 会话 → 子进程会通过 SessionWriteLease 拿租约写 jsonl）

# 4. 检查 addon 加载日志
#    node-addon-native-custom-loader 的输出在 stderr / process.log
```

**每步验证**：

- addon 加载成功 → 记录「43.4.1 可加载」，继续阶段 5。
- addon 加载失败 → 讓记录错误信息，触发**决策树**：

```
addon 在 43.4.1 下可加载？
├── 是 → 记录继续，Electron 暂不升，进阶段 5
└── 否 → 评估升 Electron 44.7.0
         ├── 联动 desktop 打包链（pack-macos.mjs / electron-builder）
         ├── 原生依赖需在对应平台重编（node-pty 等）
         └── 升级后重跑本步验证
```

**注意**：升 Electron 44.7 是独立决策，不在本阶段执行——本阶段只出验证结论 + 决策树输出。

---

## 5. 验收标准

| 编号 | 验收项 | 判据 |
|---|---|---|
| V1 | 全仓 typecheck | `tsc -b --force` 退出码 0，0 error |
| V2 | 全仓测试 | 全 suite 通过，0 failed |
| V3 | fork-drift 守卫 | 真实 tag 导出成功（设 TMPDIR 防回落）+ 失败项数 ≤ 阶段 0 基线 N 项 |
| V4 | macOS CDP 冲烟 | UI 渲染 + 行为 + 零 console error |
| V5 | Linux 冲烟 | 参考 `corum-linux-verify` 技能流程通过 |
| V6 | Windows | 如实标注「未验」或「已验」——不强制 |
| V7 | V3→V4 迁移报告 | `docs/upgrade-0.2.1-rc3/v4-migration-report.md` 落盘，含总会话数 / 迁移数 / 不可迁移数 |
| V8 | Electron 指纹验证 | 决策树有输出（可加载记录 或 不可加载评估结论） |

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| `--force` 被跳过，增量编译藏破坏点 | **高** | 0.1.5 有 31 处前车之鉴；本阶段命令写死 `--force` |
| V3→V4 迁移清除不可迁移会话（重蹈 0.1.5 覆辙） | **高** | 先备份 → verify 实例跑 → 出报告 → 用户拍板，不直接清除 |
| Electron 43.4.1 下 flock addon 不可加载 | 中 | 决策树兜底（评估升 44.7），阶段 4.5 只出结论 |
| Windows 真机不可用 | 低 | 如实标注缺口，不强制 |
| 主实例被误动 | **高** | 冲烟只走 `--home=verify`；`corum-instance.sh` 默认不动 :9222 |
| 三平台隐式假设未覆盖 | 中 | 红线 7：每个改动问三平台差异；冲烟覆盖 macOS + Linux |

---

## 7. 回滚方案

本阶段以只读验证为主，**回滚 = 回到阶段 3 产物**（fork 包 rebase 完成态）。

具体：

- 若门禁①/②/③失败 → 缺陷回退到阶段 1/3 修复，本阶段不改代码。
- 若 CDP 冲烟失败 → 缺陷回退到阶段 1/3 修复。
- 若 V3→V4 迁移有副作用 → 恢复 `~/.corum-verify/sessions-backup-pre-v4`。
- 若 Electron 指纹验证不可加载且决定不升 → 暂停阶段 5，由用户决策。

---

## 8. 产出物与下游接口

| 产出物 | 路径 | 下游 |
|---|---|---|
| 三道门禁通过记录 | `docs/upgrade-0.2.1-rc3/verification-log.md`（实录） | 阶段 5/6 前置 |
| CDP 冲烟截图 + console 清查记录 | 同上 | 用户验收 |
| V3→V4 迁移报告 | `docs/upgrade-0.2.1-rc3/v4-migration-report.md` | 用户放行决策 |
| Electron 指纹验证结论 | 同 verification-log | 阶段 5 前置（acp 子进程会起独立 runtime，依赖 flock addon） |

---

## 9. 实录要求

- 每步执行时间戳 + 命令 + 退出码 + 关键输出。
- 门禁失败时的错误全文。
- CDP 冲烟截图存档路径。
- V3→V4 迁移报告的原始数据（总会话数 / 迁移数 / 不可迁移列表）。
- Electron 指纹验证的 addon 加载日志原文。
- 与计划的偏差如实记录（如 Windows 未验）。
