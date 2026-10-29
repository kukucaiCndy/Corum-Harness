# RC3 手工核验与下一会话交接（2026-10-30）

> **当前入口**：用户正在对本场启动的隔离 packaged 实例做手工核验。本文件记录实例现场、核验清单与下一会话任务。
> **代码基线**：`41b0bedb58c1ddbc9c64e0ac45930f4946ae23a0`（`upgrade/0.2.1-rc3`）。文档提交前工作树干净；文档提交产生的新 hash 以最终报告和 git 实况为准。
> **范围结论**：macOS / darwin-arm64 升级链已完成并通过门禁；**Linux / Windows 真机未验，三平台尚未全部完成**。

## 0. 不可违反的现场纪律

1. **保留当前核验实例供用户操作**：不要停止、重启或替换它，不要启动其他实例或子 Agent。
2. **绝不操作主实例 `:9222`**，也不要使用或修改当前用户的 `~/.corum`。本交接中的启动、停止、CDP 操作只允许针对下述隔离 home 与 `:9333`。
3. 手工核验若需修改设置，只改 `/tmp/rc3-iso-final5/.corum-verify-home`；不得把配置写回源 home。源 home hash 已确认未变。
4. 页面 URL 含临时 token，**不要在文档、日志或提交中记录完整 token**。从正在运行的实例现场获取入口，不凭历史 URL 拼接。
5. 当前无需为了核验而重启主实例；下列“重启”均仅指 `:9333` 的隔离实例，并须先确认用户已结束手工操作。

## 1. 当前隔离实例现场

| 项 | 当前事实 |
|---|---|
| 应用 | 本仓 `dist/mac-arm64/Corum.app`，packaged 模式 |
| PID | `86695` |
| role | `verify` |
| CDP | `http://127.0.0.1:9333` |
| 页面 host | `http://127.0.0.1:55109`（完整入口含临时 token，不入文档） |
| `CORUM_HOME` | `/tmp/rc3-iso-final5/.corum-verify-home` |
| `DSH_HOME` | `/tmp/rc3-iso-final5/.corum-verify-home` |
| `CORUM_USER_DATA_DIR` | `/tmp/rc3-iso-final5/user-data` |
| PID 文件 | `/tmp/rc3-iso-final5/.corum-verify-home/run/pack-9333.pid` |
| 日志 | `/tmp/rc3-iso-final5/.corum-verify-home/run/pack-9333.log` |
| 就绪截图 | `/tmp/rc3-manual-verify/ready.png` |

已观察到的真实 UI 状态：主 IDE 已渲染且 `data-session-band=active`；默认 `conductor`；V4 历史中存在“阅读交接文档并走查集成中心UI”。

### 只读核验命令

在仓库根目录执行；这些命令只读取进程、CDP target 和 DOM，不修改实例：

```bash
ps -p 86695 -o pid=,stat=,command=
curl -fsS http://127.0.0.1:9333/json/version
curl -fsS http://127.0.0.1:9333/json/list
```

可通过 CDP WebSocket 对页面执行只读 `Runtime.evaluate`：

```js
({
  ready: document.readyState,
  sessionBand: document.querySelector('[data-session-band]')?.getAttribute('data-session-band'),
  title: document.title,
})
```

不要把完整页面 URL（尤其 token）复制进文档或提交。

### 实例启停（仅隔离实例）

以下命令均从仓库根目录执行，三个环境变量缺一不可。

停止：

```bash
CORUM_HOME=/tmp/rc3-iso-final5/.corum-verify-home \
DSH_HOME=/tmp/rc3-iso-final5/.corum-verify-home \
CORUM_USER_DATA_DIR=/tmp/rc3-iso-final5/user-data \
./scripts/corum-instance.sh stop --mode=packaged \
  --home=/tmp/rc3-iso-final5/.corum-verify-home --port=9333
```

需要重新启动时使用相同隔离 env：

```bash
CORUM_HOME=/tmp/rc3-iso-final5/.corum-verify-home \
DSH_HOME=/tmp/rc3-iso-final5/.corum-verify-home \
CORUM_USER_DATA_DIR=/tmp/rc3-iso-final5/user-data \
./scripts/corum-instance.sh start --mode=packaged \
  --home=/tmp/rc3-iso-final5/.corum-verify-home --port=9333
```

**用户手工核验期间不要执行上述 stop/start。不得对主实例执行 restart。**

## 2. 手工核验清单（按优先级）

按顺序核验并记录实际结果；任何失败保留截图、日志和复现步骤，不通过修改源 home 来“修绿”。

### P0 — 主 IDE 与 preset

- [ ] 主 IDE 正常显示，不白屏；`data-session-band=active`，会话输入和主要工作区可用。
- [ ] 五个 preset 均可查看/选择，默认仍是 `conductor`；切换后 UI 状态与实际角色一致。
- [ ] 查看浏览器控制台与实例日志，区分已有启动警告和手工操作新增错误。

### P0 — 设置四值与持久化

- [ ] 设置中确认四个目标值：`17` / `23` / `deepseek` / `steer`。
- [ ] 在隔离实例内修改后读回，确认写入成功。
- [ ] 用户结束当前手工核验后，使用 §1 的隔离命令重启 `:9333`，再次确认修改持久化。
- [ ] 不检查、不改动 `~/.corum`，不要求重启主实例。

### P1 — V4 历史与会话导航

- [ ] 打开 V4 历史“阅读交接文档并走查集成中心UI”，历史内容完整可见。
- [ ] `6/6` needle 均可自由查看，无锁定、空白或跳转失效。
- [ ] 会话 A/B 来回切换内容正确；清空与归档行为符合预期，归档后列表状态正确。

### P1 — 详情与 queue-revert

- [ ] 打开右侧 details，开发者模式内容和开合状态正常。
- [ ] 验证 queue-revert 的真实行为与 UI 状态；不要只确认按钮存在。
- [ ] 若操作涉及会话内容变更，只在隔离 home 中进行并记录结果。

### P2 — ACP 注册边界

- [ ] **只验证 ACP 注册/能力呈现**。
- [ ] 不触发真实模型请求，不启动子 Agent，不据此宣称 continuable/preset 或 confined/worktree 已支持。

## 3. 下一会话首要任务

1. **调查 HMR application readiness 警告并归因**：启动日志出现
   `hmr (@deepseek-ai/dsh-hmr): Error: Profile HMR requires application readiness`。
   当前 UI 虽已 ready，但不能据此忽略警告或宣称“无警告”。定位触发时序、调用方与影响，记录根因和处置；修复须有针对性验证。
2. **Linux / Windows 真机验证**：当前只完成 macOS 升级链。Linux 原生依赖必须在 Linux 上安装，交叉打包不能替代真机；Windows 也须以当前提交产物验证。
3. **ACP confined/worktree 适配**：目前只装配 provider、one-shot 与能力拒绝；按任务书补齐 corum confined/worktree 核心能力，不提前宣称支持。
4. **顶层 sidecar 仅任务书**：`08-top-level-sidecar.md` 仍是任务书，无源码实现；不得把阶段 6 描述为已落地。

## 4. 已通过的证据与边界

| 门禁/证据 | 结果 |
|---|---|
| 硬隔离行为验收 | full `12/12`，persist `7/7` |
| 强制 typecheck | `52/52`，0 错 |
| 全仓测试 | `3643` passed，0 failed，2 skipped |
| 全仓 build | `57` 个包完成 |
| fork-drift | 0 red |
| V4 迁移 | `962` publish + `962` verify 成功，`1` quarantine，`59` 会话字段恢复 |
| Electron | `43.4.1` flock 通过 |
| ACP | one-shot CLI 握手通过；不支持的能力明确 reject |
| 隔离性 | 源 home hash 未变 |
| 当前启动日志 | **仍有 HMR application readiness 警告，待下一会话归因** |

这些结果不覆盖 Linux/Windows 真机，也不代表 ACP confined/worktree 或顶层 sidecar 已完成。

## 5. 关键索引

### 行为、迁移与验证

- [`docs/RC3-BEHAVIOR-ACCEPTANCE-2026-10-29.md`](RC3-BEHAVIOR-ACCEPTANCE-2026-10-29.md)：行为判据、隔离纪律与收口证据。
- [`docs/RC3-PROFILECONTEXT-RECOMPOSE-FIX-2026-10-29.md`](RC3-PROFILECONTEXT-RECOMPOSE-FIX-2026-10-29.md)：profile context / recompose 修复记录。
- [`docs/upgrade-0.2.1-rc3/v4-migration-report.md`](upgrade-0.2.1-rc3/v4-migration-report.md)：V4 迁移报告。
- [`docs/upgrade-0.2.1-rc3/verification-log.md`](upgrade-0.2.1-rc3/verification-log.md)：Electron flock 等验证日志。
- [`docs/upgrade-0.2.1-rc3/06-verification.md`](upgrade-0.2.1-rc3/06-verification.md)：阶段 4 验证手册。
- [`docs/upgrade-0.2.1-rc3/07-acp-subagent-isolation.md`](upgrade-0.2.1-rc3/07-acp-subagent-isolation.md)：阶段 5 ACP 进程隔离手册。
- [`docs/upgrade-0.2.1-rc3/08-top-level-sidecar.md`](upgrade-0.2.1-rc3/08-top-level-sidecar.md)：阶段 6 顶层 sidecar **任务书**。
- [`docs/UPGRADE-0.2.1-rc3.md`](UPGRADE-0.2.1-rc3.md)：完整升级实录与最终门禁。

### 可复跑脚本

- `scripts/rc3-behavior-check.mjs`：真 RPC + 真 UI 行为验收。
- `scripts/rehearse-v4-migration.mjs`：V4 迁移演练与核对。
- `scripts/verify-electron-flock.mjs`：Electron flock 验证。
- `scripts/corum-instance.sh`：实例管理；本场只能使用 §1 的隔离参数。
