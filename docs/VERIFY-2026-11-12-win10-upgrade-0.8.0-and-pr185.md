# 验证记录 · 2026-11-12 · Windows 10 真机：0.8.0 覆盖升级 + PR #185 复验

> 性质：**真机验证记录**（不是方案、不是交接）。所有判据均为当场实测值原文；未测到的显式标「未测」，推断的显式标「假设」。
> 被测机：Windows 10 专业版 22H2 `DESKTOP-UATGHRF`（`192.168.1.86`），从已装的 0.7.0 升级到 0.8.0。
> 驱动方：macOS（仓库 `main` = `9f13972a`）。

---

## §1 一句话结论

**Windows 10 22H2 上 0.8.0 覆盖升级成功、可启动、核心 UI 可交互、零错误面**（stderr 26 行 0 条 suspicious；6 秒监听窗 0 console error / 0 exception / 0 log.error），**`.corum` 旧状态未被破坏**（`.master-key` 未再改写、`.credentials.yaml` mtime 仍 10/23、`corrupt` 文件当天无新增）；**但 PR #185 未修好真机红**——真因是 `orchestration.ts` 在 win32 硬编码 `pwsh`，该机 `pwsh` 缺失，属**另一处缺陷**，需单独立项。

---

## §2 环境事实

### macOS 侧（驱动方）

| 项 | 实测值 |
|---|---|
| 系统 | macOS 27.0.1 (26A434) |
| 仓库 `main` | `9f13972a` |
| node | `/opt/homebrew/bin` 下（本场以 `export PATH=/opt/homebrew/bin:$PATH` 固定） |

### Windows 侧（被测机 `192.168.1.86`）

| 项 | 实测值 |
|---|---|
| SSH | 用户 `remote`，密钥 `~/.ssh/id_ed25519_win10` |
| 主机名 | **DESKTOP-UATGHRF** |
| 系统 | Windows 10 专业版 22H2，build **19045**，系统安装日 2026-10-13 |
| node | **v22.20.0** |
| git | ✅（可用） |
| pnpm | **v11.7.0** |
| python | ✅（可用） |
| pwsh（PowerShell 7） | **缺失**；本机只有 Windows PowerShell **5.1.19041.6456** |
| C: 剩余 | **58.4G** |

### 升级前的既有状态

- 已装 Corum **0.7.0**（10/23 安装）。
- `~/.corum` 内有 `.master-key` + **5 个 `.master-key.corrupt.*`**（最晚 10/24）；这批是 10/23 那次 DPAPI 故障注入留下的。
- `.credentials.yaml` **166B**（mtime 10/23）；`settings.yaml` **2268B**。

---

## §3 链路（怎么打的包、怎么部署、怎么驱动）

### 3.1 打包（Mac 侧）

```
cd packages/desktop && node scripts/pack.mjs win32
```

- 耗时约 **8 分钟**，五步链：全仓 build 3min → pack:node / pack:git 1.5min → pack:host 3.5min。
- 产物：
  - `dist/Corum-0.8.0-win-x64.exe` —— **481,924,852B**（NSIS 安装包）
  - `dist/win-unpacked/` —— **1.7GB**，**27,883 个文件**

### 3.2 win 目标不出 zip ⇒ 自行打包

win32 目标**不产出 zip**（zip 资产只属于 macOS），故手工打：

```
cd dist/win-unpacked && zip -r -q -X ../Corum-0.8.0-win-x64.zip .
```

- 结果：**627,330,494B**、**32,667 条目**（27,883 文件 + 4,784 目录）
- `__MACOSX` 条目 **0**；与源目录逐条名称 diff **无差异**

### 3.3 推送与安装（Windows 侧）

- `scp` 到 `C:\Users\remote\corum-080.zip`；远端字节数 **627,330,494**，与本地一致。
- 安装步骤（覆盖升级 + 保留回滚）：
  1. `Get-Process Corum | Stop-Process`
  2. 旧目录 `Move-Item` → `C:\Users\remote\AppData\Local\Programs\Corum-0.7.0.bak`（**保留回滚**）
  3. 建新目录
  4. `Expand-Archive` —— 耗时 **635.4s**
  5. 三处存在性校验全 `True`：`Corum.exe` / `resources\node\node.exe` / `resources\host\node_modules\js-yaml\package.json`
- 附带确认：`vc_redist.x64.exe` 在；版本 **0.8.0**；安装体积 **1,571MB**。

### 3.4 启动（拉进 RDP 交互会话）

`C:\Users\remote\corum-launch.ps1` 设定：

- `CORUM_DEBUG_PORT=9333`
- `CORUM_HOME=%USERPROFILE%\.corum`
- `CORUM_USER_DATA_DIR=%APPDATA%\corum-desktop-ud-minimal-noport` —— **必须显式钉住 profile**：否则 `CORUM_DEBUG_PORT` 会改变 user-data-dir 的叶子名（`corum-desktop-ud-<mode>-<port>`），等同于换了一个 profile。

调度：

```
schtasks /create /tn corum_ps /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\remote\corum-launch.ps1" /sc once /st 23:59 /ru remote /it /f
schtasks /run /tn corum_ps
```

- `/tr` 上限 **261 字符**，长命令必须落 `.ps1` 再引用。
- 验完已 `schtasks /delete`。

### 3.5 CDP 驱动

```
winx.sh tunnel 9401 9333      # 本质 ssh -N -L
```

隧道回 Mac 后，`http://127.0.0.1:9401` 即远程实例的 CDP 端点。

---

## §4 判据表

| # | 判据 | 实测值原文 | 判定 |
|---|---|---|---|
| 1 | 0.8.0 启动 stderr 干净 | 全文 **26 行、0 条 suspicious**（无 `error` / `warn` / `ENOENT` / 失败字样） | ✅ |
| 2 | 关键启动事件齐 | `DevTools listening on ws://127.0.0.1:9333/...`、`window created (combo launcher)`、`combo "coding" host ready (http://127.0.0.1:50980/?token=…)` | ✅ |
| 3 | host 子进程起得来 | `host 子进程 spawn→ready +12019ms` | ✅ |
| 4 | 版本正确 | CDP 页面读到 `v0.8.0-local+202611120211`；基座 `0.2.1-rc.3@be72761`；`rev 253cbb2c9dd7`；`bootEntries 75` | ✅ |
| 5 | 页面渲染完整 | **24 个 button** | ✅ |
| 6 | 真实工作区在 | `corum-harness`、`test-win10` | ✅ |
| 7 | 历史会话在 | 10/15、10/24 的会话都在 | ✅ |
| 8 | 「新建任务」表单 | 真实 `Input.dispatchMouseEvent` 点击后出现；模型 `loaclprovider/deepseek-v4.1-flash`、三档访问权限（只读 / 工作区读写 / 完全权限）、取消 / 开始 | ✅ |
| 9 | 终端可用（含 pwsh 回落） | 点终端 → xterm 挂载 **61 行**，出现真实提示符 `PS C:\Users\remote\AppData\Local\Programs\Corum>` ⇒ pwsh 缺失时回落 `powershell.exe` 生效，与 `packages/desktop/src/electron/platform/win32.ts:39-55` 的探测链一致 | ✅ |
| 10 | 智能体设置页 | 用户菜单 → 设置 → **智能体设置**：整块「子 Agent 候选模型」UI 正常渲染（开启开关说明、候选清单 = 供应商 / 模型 / 思考程度 + 标签、空态文案、「保存候选 / 放弃」） | ✅ |
| 11 | 错误面 | 6 秒监听窗口内 **0 console error、0 exception、0 log.error**；host stderr 同样 0 错误 | ✅ |
| 12 | `.master-key` 未被再改写 | 0.8.0 启动后 mtime 仍为 **12:13:31**（即我做 0.7.0 基线启动那一刻写下的） | ✅ |
| 13 | `.credentials.yaml` 未被改写 | mtime 仍 **10/23** | ✅ |
| 14 | `corrupt` 文件无新增 | 仍 **5 个**，最晚 **10/24**，当天无新增 | ✅（附注见 §6.8） |
| 15 | 启动耗时（对照，**非受控**） | 0.8.0 `spawn→ready +12019ms`；同机 0.7.0 基线（同 env、空闲）**+33.9s** | ⚠️ 各一次、非受控对比，见 §5.4 |

---

## §5 PR #185 复验

### 5.1 传输方式（受限出网）

该机 **GitHub 出网被 reset**（`git ls-remote` 失败）、**npm registry 通**（HEAD **200**）⇒ 不能 `git clone`/`git fetch`，代码只能打 tar 包带过去：

- 用 `git archive` 打出分支 `origin/fix/windows-validation-portability` 的完整工作树，并附 `__main__/` 原版对照；
- `tar.gz` **44MB**，解到 `C:\work-185`。

### 5.2 守卫 `scripts/verify-plugin-spec.mjs`（真机实测）

| 版本 | 实现 | 结果 |
|---|---|---|
| **BEFORE**（origin/main 版） | `dir.split('/').pop()` | 51 个包 → **51 errors** |
| **AFTER**（#185 分支版） | `basename(dir)` | 51 个包 → **0 errors**、204 warns |

- BEFORE 报错原文形如：`包名 @corum/C:\work-185\packages\plugins\agent\corum-agent 与目录名不符（实际 @corum/corum-agent）`
- AFTER 的 **204 warns** 是「未构建 `lib/`」的既有警告，与本次改动无关。
- ⇒ #185 修的那两处**确实是对的**：win32 反斜杠路径确实会让守卫对全部 51 个包误报。

### 5.3 套件 `tests/integrate-verify-gate.spec.ts`（真机实测）

- **26 tests → 8 failed / 18 passed**
- 失败形态：`expected -1 to be 1`；报告 `exit code: -1 · took 1ms`

### 5.4 🔴 新发现（本场最重要的结论）：真因不是 #185 修的那两个文件

真因在 `packages/plugins/agent/corum-orchestration/src/orchestration.ts`（约 **1580-1587 行**）：**win32 硬编码 `pwsh`**，且 ENOENT 回退分支只覆盖 POSIX：

```ts
let result = process.platform === 'win32'
  ? run('pwsh', ['-NoProfile','-NonInteractive','-Command', command])
  : run('bash', ['-c', command])
if (process.platform !== 'win32' && …ENOENT) result = run('sh', ['-c', command])
```

独立坐实（同一台机）：

- `spawnSync('pwsh')` → `{status:null, error.code:'ENOENT'}`
- `spawnSync('powershell')` → `{status:0}`

⇒ `code = status ?? -1` 把「**外壳没起来**」读成「**命令失败**」，于是 verify 判红。CI 的 `windows-latest` 自带 pwsh 7 ⇒ **CI 绿、真机红**，这是一类系统性盲区。

- **交叉印证**（⚠️ 标注：此条由子 Agent 在其会话内完成，我未见独立复跑）：把 `powershell.exe` 复制成 `pwsh.exe` 垫进 `PATH` 后，同一份树 **26/26 全绿**。
- **建议修法**：win32 回落 `powershell`（5.1）或 `cmd /c`；并把 spawn 失败单列（如 `spawnError:'ENOENT pwsh'`），不要与命令自身退出码混为 `-1`。

### 5.5 如实标注的两条限定

1. **BEFORE / AFTER 只换了 spec、未换 src**：`__main__/` 只带了那一个 spec 文件，src 未变。因此两者结果相同属**预期**，只能证明「这 8 条**不是**改 spec 能救回来的」，不能证明「src 也无关」。
2. **启动耗时对比非受控**：0.8.0 的 `+12019ms` 与 0.7.0 的 `+33.9s` 各只测到一次，机况不同期、未做多轮。另有一次 0.7.0 启动在**并行推 598MB 包**时直接失败：`combo "coding" launch failed: Error: 后台启动超时`（boot 走到 **+35.4s**）。⇒ 只能说「慢盘上启动超时阈值偏紧是可观察风险」，**不能**得出「0.8.0 比 0.7.0 快 3 倍」这种结论。

---

## §6 环境坑（复现必须先知道）

1. **本机（Mac）普通 shell 到局域网对端不通**：`ssh` / `nc` 到 `192.168.1.86:22` 报 `No route to host`，即使 **蓝鸟加速器 `bludcloudCore` 进程已退出**仍不通；但 `curl https://github.com` 正常（**200**）。而**由 `launchctl submit` 启动的进程能正常连**（同一台机、同一块网卡）。因此本场全部 `ssh`/`scp` 走新造的助手 `~/.corum-win/winx.sh`（`run` / `ps` / `push` / `pull` / `tunnel` / `tunnel-stop`；`ps` 子命令把 PowerShell 脚本在本地编成 UTF-16LE base64 后走 `-EncodedCommand`）。
   - ⚠️ **假设（未坐实，不可当结论）**：macOS「本地网络」隐私授权只作用在 Corum.app 这个 TCC 主体上，于是它的子进程（bash）被挡、launchd 子进程不受限。**待用户确认。**
2. **该 Windows 机 GitHub 出网被 reset**、npm registry 通 ⇒ 代码只能用 tar 包带过去。
3. **Windows 默认 shell 是 PowerShell 5.1**：`&` 不能当语句分隔符（会 `ParserError`）；读中文日志要 `Get-Content -Encoding UTF8`（默认按 GBK 读成乱码）；PS 5.1 的 progress 会被序列化成 `#< CLIXML` 混进输出。
4. **`schtasks /tr` 上限 261 字符** ⇒ 长命令必须落 `.ps1` 再引用，否则报 `ERROR: Value for '/tr' option cannot be more than 261 character(s)`。
5. **7890 那个 SOCKS 对任意端口都返回 succeeded**（连 12345 也「成功」）⇒ 假阳，不能用来判端口可达；只认真正的 ssh 拿到 hostname。
6. **该机慢**：`Expand-Archive` 解 27,883 个文件耗时 **10.5 分钟**；`pnpm install --frozen-lockfile --prefer-offline` 在有暖 store 时 **6m55s**（resolved 1016 / reused 1002 / downloaded 1）。`pnpm.ps1` 会被 ExecutionPolicy 拦（`禁止运行脚本`）⇒ 必须用 `pnpm.cmd`。
7. **没有 pwsh 但桌面端终端能自动回落**到 `powershell.exe`（见 §4 判据 9）；缺 pwsh **只影响 orchestration 的 verify 执行面**，不影响终端与主界面。
8. ⚠️ **一条计数不一致，如实记**：基线探测时脚本数出 **4 个** `.master-key.corrupt.*`，随后 `Get-ChildItem` 列出 **5 个**。判为**计数取法差异**（同一批文件，非新增）；`corrupt` 文件最晚日期仍 10/24，当天无新增。

---

## §7 未验证项（照实列，均**未测**）

1. **NSIS 静默安装**：本场仍用 zip 解包安装。NSIS 静默装在 schtask 会话下装不全（技能里已记该坑），**本次未复验**。
2. **自动更新**：未测。
3. **终端内执行真实命令**：只验到出现提示符（§4 判据 9），未在其中真正跑命令。
4. **`.credentials.yaml` 里的凭证能否被解出来**：未做 RPC 级验证。
5. **`docs/HANDOFF-2026-11-12-issue-cleanup-and-subagent-candidates.md` §4** 里那些与平台无关的待验项（如 **#211 排队图片三条**）：本场未测。

---

## §8 现场残留与如何复现

### Windows 侧残留

| 路径 | 用途 |
|---|---|
| `C:\work-185` | #185 分支快照 + 已装依赖 + 已构建 `@corum/corum-tools`、`@corum/corum-tool-subagent` |
| `C:\Users\remote\corum-launch.ps1` | 启动脚本（含 `CORUM_DEBUG_PORT=9333` 与钉住的 `CORUM_USER_DATA_DIR`） |
| `C:\Users\remote\corum-080.zip` | 0.8.0 的 win-x64 zip（627,330,494B） |
| `C:\Users\remote\payload.tar.gz` | #185 传输包（44MB 解前原包） |
| `Programs\Corum-0.7.0.bak` | **回滚用**旧目录 |
| `C:\work` | 更老的 checkout，本场只读未动 |

- 机器上 **0.8.0 仍在运行**：**4 个进程**、CDP **9333 在听**。
- `corum_ps` 计划任务**已删除**。

### Mac 侧残留

- `~/.corum-win/winx.sh`（本场新造）。
- `~/.corum/verify-targets/targets.json` 已更新：`win10-box → 192.168.1.86 / remote / C:\Users\remote\AppData\Local\Programs\Corum / cdpPort 9333`（`notes` 里记了 `winx.sh` 与出网限制）。
- 隧道与 launchd 作业**已清理**。

### 复现最小步骤

1. Mac：`cd packages/desktop && node scripts/pack.mjs win32`（约 8 分钟）→ 手工打 zip（§3.2）。
2. `winx.sh push <zip> C:\Users\remote\corum-080.zip` → 按 §3.3 五步覆盖安装（保留 `.bak`）。
3. 按 §3.4 用 `schtasks` 把 `corum-launch.ps1` 拉进 RDP 交互会话（`.ps1` 里必须显式钉 `CORUM_USER_DATA_DIR`）。
4. `winx.sh tunnel 9401 9333`，Mac 上对 `http://127.0.0.1:9401` 做 CDP 断言。
5. 验完 `schtasks /delete /tn corum_ps /f`、`winx.sh tunnel-stop`。

---

## §9 对后续会话的移交建议

1. **单独立项修 `orchestration.ts` 的 win32 外壳选择**（§5.4）：这是「CI 绿、真机红」的典型盲区，优先级应高于 #185 本身。修法见 §5.4 建议；验收判据 = 在**无 pwsh 的 win32** 上 `integrate-verify-gate.spec.ts` 26/26，且 spawn 失败能显式区分出 `spawnError`。
2. **给 CI 补一台「无 pwsh 的 Windows」判别维度**，否则这类缺口永远只在真机暴露。
3. **启动超时阈值**（§5.5-2）：慢盘上 0.7.0 已在 `+35.4s` 处超时失败，值得单独评估阈值与「并行大流量传输」场景。
4. **补齐 §7 的未验证项**：NSIS 静默安装、自动更新、终端真实执行、凭证解密、handoff §4 的平台无关待验项。
5. **新会话开场先做的三件事**：① 确认 `192.168.1.86` 可达（走 `winx.sh`，别用裸 `ssh`，见 §6.1）；② 确认那台机 0.8.0 是否仍在跑（4 进程 / CDP 9333）；③ 若要做 #185 相关的事，先看 `C:\work-185` 是否还在，避免重传 44MB。
