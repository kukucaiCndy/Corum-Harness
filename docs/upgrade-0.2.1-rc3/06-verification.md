# 阶段 4 + 4.5：三层验证与 Electron 指纹验证

> 状态：**计划评审完成，待执行** → macOS CDP 冲烟已执行（§G），host 端全过，renderer 端因循环依赖行为项未全过 | 前置：阶段 3（fork 包 rebase）完成 | 工程量：中（验证为主，不含代码改动）
>
> **评审修订记录**（2026-10-28，编排报告 #78 `orchestrate_78_a1ce9587.md`）：
> 基于 `git show dsh-v0.2.1-rc.3` 官方源码对照 + 评审报告交叉复核，修订 9 处关键结论。
> 本修订不改阶段 3 结果，只修正阶段 4 计划。

---

## 1. 目标与范围

本阶段是 0.2.1-rc.3 升级的质量收口环节。目标：

1. **三道编译/测试/漂移门禁全绿**——确认 6026 commit 的跨度没有引入编译期或测试期破坏点。
2. **完整 pack + 实机 CDP 冲烟通过**——完整 `pack-macos.mjs`（含 `buildApp`/`smokeBridge`）+ `assert-packaged-boot.mjs` + 在真实 Electron 窗口里验证 UI 渲染 + 行为 + 零 console 错误，覆盖三平台原则。
3. **存量会话 V2→V3→V4 完整链迁移预演**——官方 0.2.1 新增 `session-format-v3-to-v4` 包，`session-format-catalog` 的 `currentVersion = 4`；0.1.5 只有 v0→v3 迁移链。存量会话 v2 占 59%（536/913），必须遍历完整 V2→V3→V4 链。
4. **阶段 4.5：Electron flock addon 验证**——corum 钉 electron 43.4.1，官方 0.2.1 用 `^44.7.0`；`SessionWriteLease` 依赖预编译 Node-API v8 flock addon，需验证在 Electron 43.4.1 下可加载。

**范围边界**：本阶段只读验证为主，不改动 fork 源码。若验证发现缺陷，缺陷修复回退到阶段 1/3 对应环节处理，本阶段不改代码。

> **`--skip-app` 模式**：阶段 2 用 `--skip-app` 跳过 `smokeBridge`/`buildApp` 做闭包审计。阶段 3 收口**允许以 `--skip-app` 刷新闭包 + 重跑 S4.3 断言与 S4.4 解析探针**作为退出门禁之一。但**作为最终验收只认阶段 4 完整 pack**——阶段 4 必须跑**完整** `pack-macos.mjs`（含 `buildApp`/`smokeBridge`）+ `assert-packaged-boot.mjs` + 全量 typecheck/test/fork-drift/CDP。`--skip-app` 不得替代阶段 4 完整验收。

---

## 2. 前置条件

| 前置 | 来源 | 确认方式 |
|---|---|---|
| 阶段 1 完成（4 个被删/更名包 + session-title API + HMR 形态经阶段 -1 裁决后处置） | `docs/UPGRADE-0.2.1-rc3-feasibility.md` §六 阶段 1 | git log 含对应提交 |
| 阶段 2 完成（override 重算 + lock 重生成 + 闭包审计） | §六 阶段 2 | `pnpm install` 0 错、`assert-packaged-boot.mjs` 过 |
| 阶段 3 完成（50 个 fork 包 rebase 到 0.2.1） | §六 阶段 3 | `docs/fork-delta.md` 台账标齐 |
| 主实例 :9222 不可动 | AGENTS 红线 5、`corum-instance.sh` | 冲烟只走 `--home=verify`；启动前检查 9222/9333 端口占用 |
| 官方 dsh 仓只读可访问 | `/Users/kukucai/dsh`（当前 checkout `dsh-v0.2.1-rc.2`，但 tag `dsh-v0.2.1-rc.3` 存在） | `git -C /Users/kukucai/dsh tag -l 'dsh-v0.2.1-rc.3'`；用 `git -C /Users/kukucai/dsh show dsh-v0.2.1-rc.3:<path>` 对照 |
| 完整备份已做 | §六 阶段 0 | `ls -d $HOME/corum-upgrade-backups/pre-0.2.1-rc3-*/` 目录存在 |

> ⚠️ **dsh checkout 版本注意**：`/Users/kukucai/dsh` 当前工作区在 `dsh-v0.2.1-rc.2`（`git describe --tags` 确认），但 `dsh-v0.2.1-rc.3` tag **存在**。官方对照必须用 `git show dsh-v0.2.1-rc.3:<path>`，不能依赖工作区当前 checkout 状态。rc.2 的 checkout 状态不重要——tag 才是对照锚点。

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
| 编排报告 #78 | `~/.corum/orchestrate-reports/orchestrate_78_a1ce9587.md` | 阶段 4 计划评审复核，9 处关键修订依据 |

### 3.2 工具依赖

| 工具 | 路径 | 作用 |
|---|---|---|
| `run-forced-typecheck.mjs` | `scripts/run-forced-typecheck.mjs` | 逐包 `tsc -b --force` + spec `--noEmit`（TS5093 安全） |
| `verify-fork-drift.sh` | `scripts/verify-fork-drift.sh` | fork 核心文件字节级对账 |
| `pack-macos.mjs` | `packages/desktop/scripts/pack-macos.mjs` | 完整 macOS 打包（含 `smokeBridge` + `buildApp`） |
| `assert-packaged-boot.mjs` | `scripts/assert-packaged-boot.mjs` | 产物级宿主启动断言（三平台通用） |
| `corum-instance.sh` | `scripts/corum-instance.sh` | verify 实例启停 |
| `corum-smoke.mjs` | `scripts/corum-smoke.mjs` | macOS X 层像素判据冲烟 |
| `corum-linux-verify` 技能 | `corum-dev-preset/skills/corum-linux-verify`（独立扩展包仓，不在当前 repo） | Linux 参考技能 |
| `tsc` / `vitest` | 全仓 devDependencies | 编译 + 测试 |

---

## 4. 执行步骤

### 4.1 门禁 ①：全仓 typecheck

> **根目录无 `tsconfig.json`**（实测 `ls tsconfig.json` 不存在），字面命令 `tsc -b --force` 在仓库根**无法执行**（tsc 找不到 tsconfig 会报错）。全仓 typecheck 走 `scripts/run-forced-typecheck.mjs`，它逐包执行 `tsc -b --force` + spec `--noEmit`。

**命令**（统一走 `run-forced-typecheck.mjs`）：

```bash
# (a) 全仓盘点（pnpm -r --no-bail 递归，各包自己的 tsc -b；必须 --no-bail 否则第一个失败包就停）
pnpm -r --no-bail run typecheck

# (b) 逐包强制重编 + spec 检查（清掉 tsbuildinfo 增量缓存；TS5093 安全）
#     --force 是必须的：0.1.5 升级时增量编译 0 错，--force 后冒出 31 处报错。
#     run-forced-typecheck.mjs 自动发现 packages/plugins/{agent,session,ui}/* + packages/desktop
#     下含 tsconfig.json 的包，逐个跑：
#       npx tsc -b --force           ← 主编译强制重编
#       npx tsc -p tsconfig.spec.json --noEmit   ← spec 检查（--force 不能用于 --noEmit，否则 TS5093）
#     收集结果、分类错误（TS5033 env vs 语义错误），写摘要 + 日志。
node scripts/run-forced-typecheck.mjs --log .corum-tmp/stage4-typecheck.log
```

> **为什么不能手写 `for` 循环 + `npx tsc -b --force`**：`run-forced-typecheck.mjs` 已在阶段 3 创建并验证（51/51 PASS, 0 FAIL, 0 semantic errors, 0 TS5033），它正确处理了：
> 1. 包发现逻辑（`packages/plugins/{agent,session,ui}/*` + `packages/desktop`，只选含 `tsconfig.json` 的）；
> 2. spec 检查用 `--noEmit`（`--force` 不能与 `--noEmit` 同用，否则 `TS5093: Option 'force' cannot be specified with option 'noEmit'`）；
> 3. 错误分类（TS5033 环境声明缺失 vs 真实语义错误）；
> 4. 日志 + JSON 摘要输出。
> 手写 shell 循环容易遗漏 spec 检查或误用 `--force --noEmit`。

> **必须 `--force`**。`tsc -b` 是增量编译，会藏住破坏点——0.1.5 升级时增量编译 0 错，`--force` 后冒出 31 处报错。`build-all.mjs:297-304` 的注释也印证 tsbuildinfo 缓存会骗过 tsc。`run-forced-typecheck.mjs` 内部对每个包执行 `tsc -b --force`（主编译）和 `tsc -p tsconfig.spec.json --noEmit`（spec），正确分离了这两个场景。

**每步验证**：

- 退出码 = 0，无 `error TS` 输出（TS5033 环境声明缺失不计为语义错误）。
- `run-forced-typecheck.mjs` 的 JSON 摘要中 semantic errors = 0。
- 若有错误：记录错误文件 + 错误码，回退到阶段 1/3 修复，修复后重跑 `run-forced-typecheck.mjs`。

### 4.2 门禁 ②：全仓测试

**命令**：

```bash
# 必须 --no-bail：否则在第一个失败包停下，无法盘点全量失败清单
pnpm -r --no-bail run test
```

**每步验证**：

- 全部 suite 通过，0 失败。
- 测试数应 ≥ 0.1.5 基线（1932 通过）。阶段 3 实测 3524 tests 0 fail（含 3389 vitest + 135 node:test desktop），因新增 fork 包测试而增长。
- 若有失败：记录失败 spec + 堆栈，回退到阶段 3 对应 fork 包修复。

### 4.3 门禁 ③：fork-drift 守卫

**命令**：

```bash
TMPDIR="$PWD/.corum-tmp" \
DSH_CHECKOUT=/Users/kukucai/dsh \
DSH_BASELINE_TAG=dsh-v0.2.1-rc.3 \
./scripts/verify-fork-drift.sh
```

**判据**：真实 tag 导出成功（无回落警告）+ **逐项身份清单对照**（不以 N≤3 判）。

**逐项身份判据**：
1. 失败项逐文本对照阶段 0 基线 `.corum-tmp/stage0-fork-drift-baseline.log` 的 `✗` 行。
2. 阶段 3 fork rebase 完成后，rc.3 基线守卫应 exit 0 / 0 red（阶段 3 实测：exit 0, 0 red, 13 informational skip）。如出现新的 red 项，需逐项解释。
3. 13 个 informational skip 项均已解释（§4 host emit 面 3 项 corum 自有事件 / §8 客户端挂载点 5 项有意不挂载 / §17 preset 本地副本 5 项 rc3 格式迁移待后续更新）。

**注意**：

- 阶段 0 基线 N=3 项逐项身份为：sandbox-local（`[15]` corum-sandbox-local `src/index.ts` 增量越出登记面）、orchestrate（`[17]` 缺 script 模式接线）、ui-verify（`[18]` corum-cdp-verify 技能副本不一致）。只看 N=3 有一致性风险（理论上一项消失+一项新增时 N 不变），必须比对身份。
- `scripts/verify-fork-drift.sh` 的 `:1129` 循环清单与 `:1180` `SUBAGENT_DELTA_FILES` 已在阶段 1 去掉 `invariant.ts`（含 `:1174` 注释）。若未改，守卫自身误报——回阶段 1 补。
- 运行守卫前必须设 `TMPDIR="$PWD/.corum-tmp"`（该目录已在 .gitignore），防止 `mktemp` 在 `/var/folders` 被沙箱拒后静默回落 rc.2 使基线从未真正建立。运行后确认日志无「无法导出/回落到检出工作区」。

### 4.4 完整 pack + assert-packaged-boot + 实机 CDP 冲烟

#### 4.4.1 完整 pack（macOS）

> ⚠️ **前置**：`dist/mac-arm64/` 当前只有 `Electron.app`（历史 `--skip-app` 产物），**没有** `Corum.app`。`assert-packaged-boot.mjs` 的 `findResourcesDir()` 探测 `dist/mac-arm64/Corum.app/Contents/Resources` → 找不到 → **exit 2**。因此**必须先跑完整 pack 生成 `Corum.app`**，再跑 `assert-packaged-boot.mjs`。

> ⚠️ **`--skip-app` 不能替代完整 pack**：`--skip-app` 跳过 `smokeBridge` + `buildApp`，只做闭包审计。阶段 3 已用 `--skip-app` 做了闭包审计（258 dsh uniform + 311 probes OK + 8 blacklist OK + 7 vendor OK + 7 platform OK）。阶段 4 必须跑**完整** `pack-macos.mjs`，让 `smokeBridge` + `buildApp` 实际执行。

**命令**：

```bash
# 1. 完整 pack（含 smokeBridge + buildApp + electron-builder）
#    smokeBridge: 用宿主 Node boot 闭包，home 重定向到 build/.smoke-home（不触碰 ~/.corum）
#    buildApp: 临时清空 dependencies → electron-builder → 恢复 package.json
#    产物：dist/mac-arm64/Corum.app/Contents/Resources/host/lib/bridge.js
pnpm --filter corum-desktop run pack:host:mac

# 2. 验证产物存在
ls -la packages/desktop/dist/mac-arm64/Corum.app/Contents/Resources/host/lib/bridge.js

# 3. 记录产物时间戳 + HEAD 作为证据
stat -f '%Sm' packages/desktop/dist/mac-arm64/Corum.app  # macOS
git rev-parse HEAD  # 当前 HEAD

# 4. 产物级宿主启动断言（三平台通用，无 GUI 依赖）
#    判据：① exit 0  ② stdout 出现 {"type":"ready"  ③ stderr 不含 "plugin tree failed to load"
node scripts/assert-packaged-boot.mjs
```

**pack 安全性**（评审报告 #78 确认）：
- `smokeBridge()` 将 home 重定向到 `packages/desktop/build/.smoke-home`，设置 `CORUM_HOME` + `DSH_HOME` 指向该临时目录，随后删除它。**永远不会触碰 `~/.corum`**。
- `materializeDeployWorkspace()` 将工作区复制到 `tmpdir()/corum-pack-ws-${pid}`；`pnpm deploy` 在该副本中运行。真实工作区保持原样。
- `buildApp()` 在 `finally` 中临时清空 `package.json` 的 dependencies 并恢复它们；不触碰 `node_modules` / lockfile。
- 主实例端口 9222 不受影响（pack 不起 Electron 实例）。

**每步验证**：
- `Corum.app` 目录存在，`Resources/host/lib/bridge.js` 存在。
- `assert-packaged-boot.mjs` exit 0。
- 产物时间戳为当前执行时间（非历史 `--skip-app` 产物）。

#### 4.4.2 实机 CDP 冲烟

**原则**：

- 冲烟走 `--home=verify` 实例（`scripts/corum-instance.sh start --home=verify`），**不动主实例 :9222**。主实例是用户正在使用的，重启会毁掉用户工作（AGENTS 红线 5）。
- **启动前端口检查**（必做）：
  ```bash
  # 检查 9222（主实例）和 9333（verify）是否已被占用
  lsof -nP -iTCP:9222 -sTCP:LISTEN 2>/dev/null && echo "9222 IN USE" || echo "9222 free"
  lsof -nP -iTCP:9333 -sTCP:LISTEN 2>/dev/null && echo "9333 IN USE" || echo "9333 free"
  ```
  - **9222 永不 restart/kill**：即使 9222 被占用（主实例正在运行），也不得 stop/restart 它。冲烟只走 9333。
  - 9333 如被占用（旧 verify 实例残留），先 `corum-instance.sh stop --home=verify` 再启动。
- 三平台覆盖原则（红线 7）：macOS / Linux / Windows 每个改动都要问「是否在这三个平台上行为不同」。

**CDP 隔离语义**（评审报告 #78 确认）：

> `corum-instance.sh` 的角色判定逻辑（第 228 行）：`if [[ "$HOME_SEL" == "verify" || "$HOME_SEL" == "legacy-verify" ]]`。此检查针对的是 **`HOME_SEL`**（`--home` 标志的值），**不是 `CORUM_HOME` 的值**。因此 `CORUM_HOME="$V4_TEMP_HOME" ./scripts/corum-instance.sh start --home=verify` 会正确获得 role=verify + port=9333，无论 `CORUM_HOME` 的值如何。

- **`--home=verify` 确为 verify 9333**：`HOME_SEL="verify"` → 第 228 行为 true → `CORUM_HOME_SEL=verify` → 端口 9333。`HOME_SEL` 决定角色，不受 `CORUM_HOME` 值影响。
- **但 verify 不隔离 home**：`resolve_home()` 在设置了 `CORUM_HOME` 时返回 `CORUM_HOME` 的值；未设置时返回 `~/.corum`（默认 home）。`corum-instance.sh --home=verify` 不带 `CORUM_HOME` 时，home 仍为 `~/.corum`（与主实例同一个 home）。
- **独立 home 需一致设置**：需要隔离 home 时，必须同时设置 `CORUM_HOME`、`DSH_HOME`、`CORUM_USER_DATA_DIR` 一致指向临时目录。不能假设 verify 角色默认隔离 home。
- **packed `smokeBridge` 已自有 `.smoke-home`**：`pack-macos.mjs` 的 `smokeBridge()` 将 `CORUM_HOME` + `DSH_HOME` 指向 `build/.smoke-home`，不触碰 `~/.corum`。CDP 行为验证（§4.4.2 行为清单）需另用独立 temp home，不能复用 `smokeBridge` 的 `.smoke-home`（它会在 smoke 结束后被删除）。

**macOS CDP 冲烟**：

```bash
# 0. 端口检查（必做）
lsof -nP -iTCP:9222 -sTCP:LISTEN 2>/dev/null && echo "WARN: 9222 in use (main instance, do NOT touch)" || echo "9222 free"
lsof -nP -iTCP:9333 -sTCP:LISTEN 2>/dev/null && echo "9333 in use (stale verify, will stop)" || echo "9333 free"

# 如 9333 被占用，先停旧实例
./scripts/corum-instance.sh stop --home=verify 2>/dev/null

# 1. 启 verify 实例（home = ~/.corum，port = 9333）
./scripts/corum-instance.sh start --home=verify

# 2. 跑冲烟（X 层真实像素判据）
node scripts/corum-smoke.mjs

# 3. CDP 实机验证（UI 渲染 + 行为 + 零 console 错误）
#    用 corum-cdp-verify 技能的流程：attach → 截图 → 比对 → 行为触发 → console 清查
#    CDP attach: CDP_PORT=9333
```

**判据**：

- UI 渲染：X 层像素判据通过（`corum-smoke.mjs` 的像素对比）。
- **Electron 指纹运行时确认**：CDP `Runtime.evaluate` → `process.versions.electron === "43.4.1"`（不仅静态 grep `package.json`，运行时实探）。
- **行为清单**（E/P/D/B 新机制全覆盖）：
  1. **E（extension）**：
     - 扩展包启停（install/remove）正常
     - preset list / default settings 持久化（切换后 recompose 生效，重启后保持）
     - 动态用户 preset register（用户自定义 preset 注册成功）
  2. **P（preset）**：
     - preset 切换/保存后 recompose 生效（0.2.1 registry 的 `recompose` 仍存在）
     - foreground/background activation：后台 continuable 委派 + completion notice + send_message 续聊（activation 迁移已在阶段 3 完成）
  3. **D（desktop/session）**：
     - 起会话 / 发消息（首条消息 prompt 组装成功——`{{cwd}}` 已清除，无 unresolved 变量 fail-fast）
     - cold-resume confinement：真实越界拒绝（子 agent 尝试访问授权范围外资源被拒绝，非静默放行）
     - 会话切换 retain 不泄漏：open A→B 旧 release、快速切换只 1 live、clear/dispose/retain throw 不破坏旧选择
     - trustedHosts/Connection：host 启动 + Connection 建立（失败形态是「Connection 永远 pending」，静默，必须显式验证）
  4. **B（backend/settings）**：
     - settings ns roundtrip（agent/review/websearch/conversation/chat/subagent/memory/onboarding 各 ns 读写一致）
     - V4 历史会话打开（read open 可读取旧版本会话，不崩溃）
     - flock 写租约（SessionWriteLease 真实写入 jsonl，见 §4.6）
- 零 console 错误：CDP `Runtime.consoleAPICalled` + `Log.entryAdded` 无 error 级别条目。

**Linux 冲烟**：

- 参考 `corum-dev-preset/skills/corum-linux-verify` 技能流程（该技能在独立扩展包仓 `corum-dev-preset`，不在当前 repo）。
- 原生依赖必须在 Linux 上 install，交叉打包不通（历史交接 `HANDOFF-2026-10-08-…` §2 已验证，当前不在库，仅作背景）。
- ⚠️ **当前状态**：无可用 Linux 主机（`~/.ssh/known_hosts` 仅 github.com，无 Linux 机器 SSH 配置）。本阶段如实标注「Linux 未验」并记录为遗留缺口。

**Windows 冲烟**：

- ⚠️ **当前状态**：Windows 真机不可用。唯一前置 = 那台闲置笔记本（历史交接 `HANDOFF-2026-10-08-…` §3.1，当前不在库，仅作背景）。
- ⚠️ **历史 Windows dist 不是当前 HEAD 证据**：`packages/desktop/dist/win-unpacked/resources/host/lib/bridge.js` 存在，但那是历史构建（非当前 HEAD `f9f5cfc8` 产物），不能作为当前验收证据。
- 若笔记本不可用，本阶段如实标注「Windows 未验」并记录为遗留缺口。

> ⚠️ **三平台覆盖与阶段总验收的关系**：如果最终升级目标要求三平台均通过实机验证，则阶段 4 只能标记为 **conditional/blocked** 直到 Linux + Windows 真实覆盖。不能将「不强制」（V6 验收项）写成阶段总验收可 PASS。macOS 通过 ≠ 三平台通过。

### 4.5 V2→V3→V4 会话迁移预演（阶段 4 新增）

> **标题修订**：原「V3→V4」改为「V2→V3→V4 完整链」。存量会话 v2 占 59%（536/913），v3 占 377/913，v4 = 0。v2 会话必须遍历 V2→V3→V4 两阶段迁移，不能只验 V3→V4。

**背景**：官方 0.2.1 新增 `session/session-format-v3-to-v4` 包（评审证据 §C 漏列项）。`session-format-catalog` 的 `generated.ts` 确认 `currentVersion: 4`。corum 现役 0.1.5 只有 v0→v3 迁移链。0.1.5 升级时 14 个 v2 会话无法迁移被清除（备份在 `~/.corum/sessions-removed-20260929/`），本次必须先出迁移报告再决定放行口径。

**目录结构**（评审报告 #78 确认）：三层 `sessions/<project-hash>/<session-uuid>/session.vN.jsonl.zstd`。顶层**没有** `.jsonl` 文件，原 `cp ~/.corum/sessions/*.jsonl` 匹配 0 个文件。

> **verify 不隔离 home**：`corum-instance.sh --home=verify` 的实际语义 = role verify + port 9333，但 **home 仍为 `~/.corum`**（与主实例完全同一个 home），不是隔离 home（02 册 §步骤 8 已实测确认）。V2→V3→V4 预演**必须复制到独立临时 home**，不得写 `~/.corum`。

**迁移机制**（`git show dsh-v0.2.1-rc.3:packages/session/session-persistence-jsonl/src/index.ts` 确认）：

- `open(id, access)` 第 388 行：
  - `access === 'read'`（第 393 行）：调用 `requireStoredLog` → 如果 `stored.status === 'prepared'`（第 405 行），仅将 prepared log 存储在内存中（`primed: stored`，第 410 行）并返回一个 handle。**不调用 `publishStoredMigration`**。→ **read open 不发布 V4 后续文件，不触碰源文件**。
  - `access === 'write'`（第 429-433 行）：仅在 `prepared.status === 'prepared'` 时调用 `publishStoredMigration(id, prepared)`（第 433 行）。→ **只有 write open 才发布 V4**。
- `publishStoredMigration` 调用 `migration.value.publish()`，最终通过 `fs.link(staged, currentPath)`（generation.ts 第 834 行）创建新版本文件，**不删除源文件**。
- 迁移失败抛出 `SessionFormatUnsupportedMigrationError`（不可迁移），源文件保持不变。
- `prepareStoredMigration` 通过 `prepareCatalogFacts` 自动收集子会话证据（`source.header.origin === 'subagent' && source.header.parentSession === id`）。

**步骤**：

```bash
# 1. 创建独立临时 home（不写 ~/.corum）
V4_TEMP_HOME="$PWD/.corum-v4-test-home"
mkdir -p "$V4_TEMP_HOME"

# 2. 复制完整 home 到临时 home（三层目录结构）
#    ⚠️ 原 `cp ~/.corum/sessions/*.jsonl` 匹配 0 个文件（顶层无 .jsonl，真实路径是三层嵌套）
#    ⚠️ 必须复制完整 home（含 config.yaml 等），否则持久层后端无法初始化 cordis context
#    最小复制集：sessions/ + config.yaml + 必要的 home 结构
#    排除敏感 credentials/密钥（迁移只需要 session 相关文件）
#    建议用脚本探测最小复制集（见下方 rehearse 脚本）
cp -R ~/.corum/sessions "$V4_TEMP_HOME/sessions"
# 如需 config.yaml 等使持久层后端可初始化，一并复制（排除 credentials/）
# cp ~/.corum/config.yaml "$V4_TEMP_HOME/" 2>/dev/null

# 3. 预演：直接 Node 脚本遍历持久层后端（不启动 Electron 实例）
#    ⚠️ 原步骤 4-5（"观察迁移日志"、"记录不可迁移会话数"）无法执行：
#    没有独立的迁移日志输出，也没有 CLI 统计不可迁移会话。
#    正确方法：直接 Node 脚本加载持久层后端，遍历 backend.list()，对每个项 open(id, 'read')，
#    捕获 SessionFormatUnsupportedMigrationError。
#    脚本将在阶段 4 执行时创建：scripts/rehearse-v4-migration.mjs
#    脚本逻辑：
#      a. 设置 CORUM_HOME / DSH_HOME / CORUM_USER_DATA_DIR 一致指向 $V4_TEMP_HOME
#      b. 加载持久层后端（require @deepseek-ai/dsh-session-persistence-jsonl）
#      c. 遍历 backend.list() 获取所有 SessionId
#      d. 对每个 id 执行 backend.open(id, 'read')（read open 不发布 V4，不触碰源文件）
#      e. 捕获异常：SessionFormatUnsupportedMigrationError = 不可迁移
#      f. 统计：总数 / v2 数 / v3 数 / v4 数 / 成功数 / 失败数 / 失败原因
#      g. 写报告到 docs/upgrade-0.2.1-rc3/v4-migration-report.md
#
#    预演统计：read 迁移可准备（prepared），不发布源
#    预演后可在临时副本上 write publish 验证，比较源 home hash 不变
#    源 home 只读、绝不删除不可迁移会话

# 4. （可选）在临时副本上验证 write publish
#    对临时副本中的会话执行 open(id, 'write')，确认 V4 文件生成
#    比较源 home 的 session 文件 hash 不变（确认 read open 不修改源）

# 5. 验证后清理临时 home
rm -rf "$V4_TEMP_HOME"
```

**每步验证**：

- 迁移后临时 home 的 verify 实例可正常打开历史会话。
- 记录：**总会话数 / v2 数 / v3 数 / v4 数 / 成功迁移数 / 不可迁移数 / 不可迁移原因**。
- **放行口径**：必须先出迁移报告（`docs/upgrade-0.2.1-rc3/v4-migration-report.md`），再由用户决定是否清理不可迁移会话。**不得直接清除**——0.1.5 的 14 个 v2 会话被清除是教训，本次必须先报告。
- **不得写 `~/.corum`**：V2→V3→V4 预演全程在独立临时 home 执行。源 home 只读。
- **源 home 绝不删除不可迁移会话**：即使迁移失败，源文件保持不变。

> **脚本/工具交付路径**：`scripts/rehearse-v4-migration.mjs` 将在阶段 4 执行时创建。该脚本封装上述预演逻辑（设置临时 home → 加载后端 → 遍历 list → read open → 统计 → 写报告），避免手动操作出错。

### 4.6 阶段 4.5：Electron flock addon 验证

> **评审修订**（评审报告 #78 确认）：原 §4.6 的 V8 指纹决策树建立在**错误前提**上——`node-addon-native-custom-loader@0.1.9` 按 Electron 44.7.0 的 Node/V8 指纹识别。**实际 flock addon 不经过 custom-loader**，使用 Node-API v8（ABI 稳定），与 Electron 版本无关。删除 V8 指纹错误前提。

**背景**（评审证据 §E2d + 评审报告 #78 确认）：

- corum 钉 `electron: 43.4.1`（`packages/desktop/package.json`），官方 0.2.1 用 `^44.7.0`。
- 0.2.1 的 `SessionWriteLease` 依赖预编译 Node-API flock addon（commit `d927cbff99`）。
- **flock addon 加载机制**（`git show` + 源码确认）：
  - `flock.js`（`node_modules/.pnpm/@deepseek-ai+node-addon-system@0.1.2/.../lib/flock.js`）：使用 `createRequire` + `require(join(dirname(manifest), 'bin', filename))`——**原生 Node `require()`，没有 custom-loader 中间件**。
  - `flock.c` 头文件：`Node-API v8 binding for asynchronous flock`；包含 `<node_api.h>`（Node-API，非 NAN/V8 绑定）。
  - `prebuilds.json`：`{"kind": "node-api", "napi": 8}`——确认使用 Node-API v8，在 Node 20/22/24/26 之间 ABI 稳定。
  - `@deepseek-ai/node-addon-system@0.1.2` package.json：`dependencies: {}`，`optionalDependencies` 仅列出平台子包。**不依赖 `node-addon-native-custom-loader` 或 `node-addon-require-builtin`**。
  - `packages/` 源代码中**完全没有**对 `node-addon-native-custom-loader` 的引用（grep 返回 0）。
  - custom-loader 的使用者是 `node-addon-require-builtin`（由 `cordis-plugin-loader` / `dsh-app-boot` / `dsh-hmr` 使用）——与 flock 完全无关。

**含义**：Electron 43.4.1（Node 20.x ABI）和 44.7.0（Node 22.x ABI）在加载 Node-API v8 addon 时**没有区别**。flock 加载失败（如果发生）将是**缺少平台二进制文件**（`bin/system.node` 缺失），**不是 ABI 不匹配**。

**步骤**：

```bash
# 1. 确认 corum 当前 electron 版本（静态）
grep '"electron"' packages/desktop/package.json

# 2. 确认平台子包 bin/system.node 存在
ls -la node_modules/.pnpm/@deepseek-ai+node-addon-system@0.1.2/node_modules/@deepseek-ai/node-addon-system/bin/system.node

# 3. 直接 Node require 加载测试（秒级，不需要启动 Electron 实例）
#    flock addon 用原生 require 加载，不需要 custom-loader
node -e "
const addon = require('@deepseek-ai/node-addon-system');
const flock = addon.flock || addon;
console.log('flock addon loaded:', typeof flock);
console.log('SessionWriteLease available:', typeof addon.SessionWriteLease);
"

# 4. 在 verify 实例（43.4.1）下 CDP 运行时确认
#    启动 verify 实例（独立 temp home，不触碰 ~/.corum）
V4_TEMP_HOME="$PWD/.corum-cdp-test-home"
mkdir -p "$V4_TEMP_HOME"
CORUM_HOME="$V4_TEMP_HOME" DSH_HOME="$V4_TEMP_HOME" CORUM_USER_DATA_DIR="$V4_TEMP_HOME" \
  ./scripts/corum-instance.sh start --home=verify

# 5. CDP attach (CDP_PORT=9333)，Runtime.evaluate 确认：
#    - process.versions.electron === "43.4.1"
#    - require('@deepseek-ai/node-addon-system') 可加载
#    - 起一个子 agent 会话 → 子进程通过 SessionWriteLease 拿租约写 jsonl（真实写入验证）

# 6. 验证后清理
./scripts/corum-instance.sh stop --home=verify
rm -rf "$V4_TEMP_HOME"
```

**每步验证**：

- **平台子包 bin/system.node 存在**：`ls` 确认二进制文件在。如果不存在 → 优先排查缺二进制/平台包，**不自动升级 Electron**。
- **Node require 加载成功**：`node -e` 直接 require addon，确认 `typeof flock` 为 function/object。
- **Electron 43.4.1 实际加载**：CDP `Runtime.evaluate` → `process.versions.electron === "43.4.1"` + `require('@deepseek-ai/node-addon-system')` 在 Electron renderer/main 进程中可加载。
- **真实 SessionWriteLease 写入**：起一个子 agent 会话，子进程通过 `SessionWriteLease` 拿租约写 jsonl，确认写入成功（文件生成 + 内容可读）。
- addon 加载成功 → 记录「43.4.1 可加载 Node-API v8 flock addon」，继续阶段 5。
- addon 加载失败 → 记录错误信息，**优先排查缺二进制/平台包**（不是 ABI 不匹配），**不自动升级 Electron**：
  ```
  addon 在 43.4.1 下可加载？
  ├── 是 → 记录继续，Electron 暂不升，进阶段 5
  └── 否 → 优先排查：
           ├── 平台子包 bin/system.node 是否存在？→ 缺二进制：装对应平台包
           ├── @deepseek-ai/node-addon-system 是否在闭包内？→ 闭包补齐
           └── 以上均排除后，才评估升 Electron 44.7.0（独立决策，不在本阶段执行）
  ```

**注意**：升 Electron 44.7 是独立决策，不在本阶段执行——本阶段只出验证结论 + 决策树输出。**失败时优先排查缺二进制/平台包，不自动升级 Electron**。

---

## 5. 验收标准

| 编号 | 验收项 | 判据 |
|---|---|---|
| V1 | 全仓 typecheck | `pnpm -r --no-bail run typecheck` + `node scripts/run-forced-typecheck.mjs`（逐包 `tsc -b --force` + spec `--noEmit`，TS5093 安全），0 semantic error |
| V2 | 全仓测试 | `pnpm -r --no-bail run test`，全 suite 通过，0 failed |
| V3 | fork-drift 守卫 | 真实 tag 导出成功（设 TMPDIR 防回落）+ **逐项身份清单对照**（不以 N≤3 判；阶段 3 完成后 rc.3 基线应 exit 0 / 0 red / 13 informational skip） |
| V4a | 完整 pack | `pnpm --filter corum-desktop run pack:host:mac`（含 `smokeBridge` + `buildApp`）→ `dist/mac-arm64/Corum.app` 存在 + 产物时间戳为当前 HEAD 执行时间 |
| V4b | assert-packaged-boot | `node scripts/assert-packaged-boot.mjs` exit 0 + stdout 含 `{"type":"ready"` + stderr 无致命启动行 |
| V4c | macOS CDP 冲烟 | UI 渲染（启动页 ✓）+ 行为（E/P/D/B：renderer 端循环依赖致 23 插件未激活，RPC 行为 SKIP）+ Electron 43.4.1 运行时确认 ✓ + 零 console error（reload 后 ✓）。详见 `verification-log.md` §G |
| V5 | Linux 冲烟 | 参考 `corum-linux-verify` 技能流程通过。⚠️ 当前无可用 Linux 主机 → 标注「未验」 |
| V6 | Windows | 如实标注「未验」或「已验」。⚠️ 当前 Windows 真机不可用 + 历史 dist 非当前 HEAD 产物 → 标注「未验」。如最终升级目标要求三平台，本项 blocked |
| V7 | V2→V3→V4 迁移报告 | `docs/upgrade-0.2.1-rc3/v4-migration-report.md` 落盘，含总会话数 / v2 数 / v3 数 / v4 数 / 成功迁移数 / 不可迁移数 / 不可迁移原因 |
| V8 | Electron flock addon 验证 | 平台子包 bin/system.node 存在 + Node require 加载成功 + Electron 43.4.1 运行时加载 + 真实 SessionWriteLease 写入；失败时优先排查缺二进制/平台包 |

> ⚠️ **三平台验收说明**：V5（Linux）和 V6（Windows）当前均标注「未验」。如果最终升级目标要求三平台均通过实机验证，则阶段 4 总验收只能标记为 **conditional/blocked** 直到 Linux + Windows 真实覆盖。「不强制」（V6 原措辞）不能写成阶段总验收可 PASS——macOS 通过 ≠ 三平台通过。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| `--force` 被跳过，增量编译藏破坏点 | **高** | 0.1.5 有 31 处前车之鉴；统一走 `run-forced-typecheck.mjs`（内部 `tsc -b --force` + spec `--noEmit`） |
| 完整 pack 未跑，旧 `--skip-app` 产物冒充 | **高** | 阶段 4 必须跑完整 `pack-macos.mjs`；`assert-packaged-boot.mjs` 探测 `Corum.app` 不存在则 exit 2 |
| V2→V3→V4 迁移清除不可迁移会话（重蹈 0.1.5 覆辙） | **高** | 先备份到临时 home → read open 预演（不发布 V4）→ 出报告 → 用户拍板，不直接清除；源 home 只读 |
| V2→V3→V4 迁移只验 V3→V4，遗漏 V2→V3 | **高** | v2 占 59%（536/913），必须遍历完整 V2→V3→V4 链 |
| Electron 43.4.1 下 flock addon 不可加载 | 中 | Node-API v8 ABI 稳定（43.4.1 Node 20.x ↔ 44.7.0 Node 22.x 无区别）；失败优先排查缺二进制/平台包，不自动升级 Electron |
| Windows 真机不可用 + Linux 无可用主机 | 中 | 如实标注缺口；如最终目标要求三平台，阶段 4 blocked 直到真实覆盖；历史 Windows dist 非当前 HEAD 产物 |
| 主实例被误动 | **高** | 启动前检查 9222/9333 端口占用；冲烟只走 `--home=verify`；9222 永不 restart/kill |
| 独立 home 不一致（CORUM_HOME/DSH_HOME/CORUM_USER_DATA_DIR） | 中 | 独立 home 需三变量一致设置；不能假设 verify 隔离默认 home；packed smokeBridge 已自有 .smoke-home |
| 三平台隐式假设未覆盖 | 中 | 红线 7：每个改动问三平台差异；冲烟覆盖 macOS（Linux/Windows 标未验） |

---

## 7. 回滚方案

本阶段以只读验证为主，**回滚 = 回到阶段 3 产物**（fork 包 rebase 完成态）。

具体：

- 若门禁①/②/③失败 → 缺陷回退到阶段 1/3 修复，本阶段不改代码。
- 若 CDP 冲烟失败 → 缺陷回退到阶段 1/3 修复。
- 若 V2→V3→V4 迁移有副作用 → 恢复 `$V4_TEMP_HOME/sessions` 备份（**不是** `~/.corum-verify/sessions-backup-pre-v4`——后者路径不存在；verify 角色 home 为 `~/.corum`，预演使用 `$V4_TEMP_HOME`）。
- 若 Electron flock addon 验证不可加载且决定不升 → 暂停阶段 5，由用户决策。

> **回滚路径修订**：原 §7 回滚路径 `~/.corum-verify/sessions-backup-pre-v4` 不存在。verify 角色 home 为 `~/.corum`（与主实例同一个 home），预演使用 `$V4_TEMP_HOME` 独立临时 home。回滚应引用 `$V4_TEMP_HOME/sessions` 备份。

---

## 8. 产出物与下游接口

| 产出物 | 路径 | 下游 |
|---|---|---|
| 三道门禁通过记录 | `docs/upgrade-0.2.1-rc3/verification-log.md`（实录） | 阶段 5/6 前置 |
| 完整 pack 产物 + assert-packaged-boot 记录 | 同上（含产物时间戳 + HEAD 证据） | 用户验收 |
| CDP 冲烟截图 + console 清查记录 | 同上 | 用户验收 |
| V2→V3→V4 迁移报告 | `docs/upgrade-0.2.1-rc3/v4-migration-report.md` | 用户放行决策 |
| 迁移预演脚本 | `scripts/rehearse-v4-migration.mjs`（阶段 4 执行时创建） | 迁移预演工具 |
| Electron flock addon 验证结论 | 同 verification-log | 阶段 5 前置（acp 子进程会起独立 runtime，依赖 flock addon） |

---

## 9. 实录要求

- 每步执行时间戳 + 命令 + 退出码 + 关键输出。
- 门禁失败时的错误全文。
- 完整 pack 产物时间戳 + HEAD hash（证明是当前 HEAD 产物，非历史 `--skip-app` 残留）。
- CDP 冲烟截图存档路径。
- V2→V3→V4 迁移报告的原始数据（总会话数 / v2 数 / v3 数 / v4 数 / 成功迁移数 / 不可迁移列表 / 不可迁移原因）。
- Electron flock addon 验证的 addon 加载日志原文 + 平台子包 bin/system.node 存在性证据。
- 与计划的偏差如实记录（如 Linux/Windows 未验）。
