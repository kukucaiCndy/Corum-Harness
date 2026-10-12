---
name: win-cdp-debug
description: Use when verifying a corum Agent OS (kkc-desktop) change on the Windows 11 real machine (USER-20231001WG, 192.168.1.121) end-to-end — cross-pack the win32/x64 build, deploy the freshly built artifact over SSH, launch the app with a CDP port into the remote user's desktop session, tunnel that CDP port back to the Mac via SSH, and drive the real Windows Electron instance with the chrome-devtools MCP / ui-verify spec. Also use when "Windows 上应用白屏 / 起不来 / node.exe ENOENT / Cannot find package 'js-yaml' / NSIS 静默安装装不全". Do NOT use for just running commands on Windows (that is win11-remote) or for local-mac CDP verification (that is corum-cdp-verify).
---

# Windows 真机 CDP 跨机验证（win-cdp-debug）

## 0. 一句话

**改动 → 交叉打包 win32/x64 → 推产物到 192.168.1.121 → 解压覆盖安装目录 → schtasks 以 `remote` 用户交互式带 CDP 启动 → SSH 端口转发回 Mac → chrome-devtools MCP / ui-verify 驱动真机。** 全程不碰本地主实例 :9222；远程的 9222 经隧道回到 Mac 的 127.0.0.1:9222。

与姊妹技能的边界（别用错）：

| 技能 | 干什么 | 什么时候用 |
|---|---|---|
| `win11-remote` | SSH 连上 Windows、跑命令、RDP、推/拉文件 | 只是要在 Windows 上执行命令 |
| `corum-cdp-verify` | 本地 Mac 起自己的验证实例 :9333，声明式规格验证 | 改了 UI/功能，先在 Mac 本地验 |
| **`win-cdp-debug`（本技能）** | **改动的产物部署到 Windows 真机 + 跨机 CDP 驱动验证** | **改了 Windows 相关代码（标题栏/平台分叉/原生依赖），必须在真 Windows 上验** |

## 1. 目标机与前置事实（先读 win11-remote，这里只补本技能专有的）

| 事实 | 值 / 说明 |
|---|---|
| 机器 | `USER-20231001WG`，192.168.1.121（详见 `win11-remote` §1） |
| corum 安装位置 | `C:\Users\remote\AppData\Local\Programs\Corum\`（perUser NSIS，asInvoker） |
| corum 跑在哪个用户 | **`remote`**（不是 Administrator）。RDP 会话 `rdp-tcp#0`，会话 ID 见 `query user` |
| SSH 登录用户 | `Administrator`（见 win11-remote）—— 与 corum 的运行用户**不同**，这是跨会话启动的核心难点 |
| 入口脚本 | `win11-remote` 的 `win-remote.sh`（push/run/ps 全靠它） |
| CDP 端口 | 9222（corum 读 `CORUM_DEBUG_PORT` 环境变量，见 `main.ts:510-518`） |
| CDP 绑定 | `127.0.0.1`（`remote-debugging-address`）—— 远程本地可达，Mac 经 SSH 隧道可达 |

## 2. 完整链路（照抄即可）

### 2.1 交叉打包（在 Mac 本地，仓库 `packages/desktop`）

```bash
cd packages/desktop
pnpm run pack:win      # 四步链：build → pack:host → pack:node → pack:app，约 5 分钟
# 产物：
#   dist/Corum-0.2.2-win-x64.exe   (NSIS 安装器 ~301MB)
#   dist/Corum-0.2.2-win-x64.zip   (完整解压包 ~392MB) ← 用这个，不用 NSIS
#   dist/win-unpacked/             (已解压态)
```

> **为什么用 zip 不用 NSIS exe**：NSIS 静默安装在 schtask 交互式会话 + `Start-Process -Wait` 下**装不全**（node 目录、host 闭包都缺，见 §4 坑 1）。zip 解压 100% 可靠。

### 2.2 推产物到 Windows

```bash
SK="$HOME/.corum/skills/win11-remote"
# 推完整 zip（392MB，SSH 直连约 1-2 分钟）
"$SK/scripts/win-remote.sh" push packages/desktop/dist/Corum-0.2.2-win-x64.zip 'C:/corum/Corum-full.zip'
```

### 2.3 解压覆盖安装目录

```bash
# 先 kill 残留 corum + 清空安装目录
"$SK/scripts/win-remote.sh" ps 'Get-Process Corum -ErrorAction SilentlyContinue | Stop-Process -Force; Remove-Item -Recurse -Force "C:\Users\remote\AppData\Local\Programs\Corum" -ErrorAction SilentlyContinue; Start-Sleep 2; New-Item -ItemType Directory -Path "C:\Users\remote\AppData\Local\Programs\Corum" -Force | Out-Null'
# 解压 zip 到安装目录（PowerShell Expand-Archive，392MB 约 2 分钟）
"$SK/scripts/win-remote.sh" ps 'Expand-Archive -Path "C:\corum\Corum-full.zip" -DestinationPath "C:\Users\remote\AppData\Local\Programs\Corum" -Force; Write-Host "解压完成"'
# 验证关键文件
"$SK/scripts/win-remote.sh" ps 'Test-Path "C:\Users\remote\AppData\Local\Programs\Corum\Corum.exe"; Test-Path "C:\Users\remote\AppData\Local\Programs\Corum\resources\node\node.exe"; Test-Path "C:\Users\remote\AppData\Local\Programs\Corum\resources\host\node_modules\js-yaml"'
```

三个 `True` 才算装好。任一 `False` ⇒ 解压不完整，重跑 Expand-Archive（§4 坑 2）。

### 2.4 带 CDP 启动（schtasks 跨会话）

```bash
# 启动脚本（捕获 stderr 到日志，便于排错）
cat > /tmp/corum-launch-ps.ps1 <<'PS1'
$env:CORUM_DEBUG_PORT = '9222'
$env:CORUM_HOME = "$env:USERPROFILE\.corum"
Set-Location 'C:\Users\remote\AppData\Local\Programs\Corum'
$p = Start-Process -FilePath '.\Corum.exe' -PassThru -RedirectStandardOutput 'C:\corum\corum-stdout.log' -RedirectStandardError 'C:\corum\corum-stderr.log'
Start-Sleep -Seconds 8
Write-Host "PID: $($p.Id) HasExited: $($p.HasExited)"
PS1
"$SK/scripts/win-remote.sh" push /tmp/corum-launch-ps.ps1 'C:/corum/launch-ps.ps1'

# 用 schtasks 以 remote 用户交互式会话运行（key：/it + /ru remote）
"$SK/scripts/win-remote.sh" run 'schtasks /create /tn corum_ps /tr "powershell -ExecutionPolicy Bypass -File C:\corum\launch-ps.ps1" /sc once /st 23:59 /ru remote /it /f'
"$SK/scripts/win-remote.sh" run 'schtasks /run /tn corum_ps'
sleep 12
# 验证：进程数 > 0 + 9222 监听
"$SK/scripts/win-remote.sh" ps '$p=Get-Process Corum -ErrorAction SilentlyContinue; Write-Host "进程数: $($p.Count)"; (Get-NetTCPConnection -State Listen -LocalPort 9222 -ErrorAction SilentlyContinue) -ne $null'
# 看日志确认 host bridge 起来（关键行：combo "coding" host ready）
"$SK/scripts/win-remote.sh" run 'type C:\corum\corum-stderr.log'
# 用完删任务（别留）
"$SK/scripts/win-remote.sh" run 'schtasks /delete /tn corum_ps /f'
```

> **为什么 schtasks 不直接 `Corum.exe`**：SSH 会话是 Administrator，corum 要跑在 `remote` 用户的**交互式桌面会话**才有 GUI。`schtasks /ru remote /it` 把进程注入 remote 的会话。直接 `ssh ... Corum.exe` 起的是 service-session 进程，无窗口。

### 2.5 SSH 端口转发 + CDP 驱动

```bash
# Mac 本地：建隧道（后台 -f -N）
pkill -f "ssh.*9222.*192.168.1.121" 2>/dev/null
ssh -i ~/.ssh/win11_lan_ed25519 -o ConnectTimeout=10 -o StrictHostKeyChecking=no -f -N \
  -L 127.0.0.1:9222:127.0.0.1:9222 Administrator@192.168.1.121
# 验证隧道
curl -sS -m 5 http://127.0.0.1:9222/json/version   # 应返回 Chrome/Electron 版本
```

隧道通了之后，**Mac 的 127.0.0.1:9222 就是远程 Windows 的 corum CDP**。两种驱动方式：

**方式 A：chrome-devtools MCP（交互式、首选）**

MCP 默认连 `127.0.0.1:9222`，隧道建好后直接用 `list_pages` / `take_snapshot` / `evaluate_script` / `click` / `take_screenshot` 等工具驱动远程实例。

**方式 B：ui-verify.mjs 声明式规格（断言门禁）**

```bash
SK_CDP="/Users/kukucai/.agents/skills/corum-cdp-verify"
# spec.json 里 "port": 9222
# ⚠️ ui-verify.mjs 默认拒绝打 9222（认为是本地主实例）。经隧道连远程时设：
CORUM_ALLOW_MAIN=1 node "$SK_CDP/scripts/ui-verify.mjs" /tmp/spec.json
```

> `CORUM_ALLOW_MAIN=1` 在这里是**安全**的：此 9222 经 SSH 隧道指向远程 Windows 的 corum，不是本地主实例。但用完隧道要拆，别常驻。

## 3. 验证判据（host bridge 真起来才算）

看 stderr 日志（`C:\corum\corum-stderr.log`），关键行按顺序：

```
DevTools listening on ws://127.0.0.1:9222/...        ← CDP 端口开了
[corum-desktop] window created (combo launcher)       ← 壳窗口起来了
[corum-desktop] combo "coding" host ready (...)        ← host bridge 起来了（决定性）
```

**只要没看到 `combo ... host ready`，就是没起来**，往下翻日志看错误（§4 是错误速查表）。

## 4. 错误速查表（全部实测踩过）

| stderr 错误 | 真因 | 解法 |
|---|---|---|---|
| `spawn ...resources\node\node.exe ENOENT` | **NSIS 静默安装没装 node 目录**（§4 坑 1） | 改用 zip 解压（§2.3），别用 NSIS |
| `Cannot find package 'js-yaml' imported from ...dsh-app-boot` | host 闭包缺包（NSIS 装不全 / 解压不完整） | 重新 Expand-Archive，验 §2.3 三个 True |
| `MainWindowHandle 全为 0` / 窗口白屏 / 进程数=0 | host bridge 起不来 ⇒ 窗口没内容 | 看 stderr 找上面的根因 |
| `combo ... host ready` 一直不出现 + 进程秒退 | 多半是 `resources/node` 或 `resources/host` 不全 | 同上，验文件 |
| `Get-Process Corum` 为空但 9222 在监听 | 时序：壳起了但 host 还没 spawn | `sleep 12` 再查；host ready 才算 |
| 隧道 `curl: (52) Empty reply` | corum 退出了（崩溃） | 重看 stderr 日志 |
| `ssh` 报 `Permission denied (publickey)` | 用错 key / 用户名 | 用 `win11-remote` 的 `~/.ssh/win11_lan_ed25519` + `Administrator` |
| `ui-verify.mjs` 报 `拒绝操作 :9222（用户主实例）` | 守卫把隧道的 9222 当本地主实例 | `CORUM_ALLOW_MAIN=1`（隧道连远程时安全） |
| NSIS `Start-Process -Wait` 返回但文件没装上 | schtasks 交互式会话 + NSIS asInvoker 冲突 | **别用 NSIS，用 zip 解压** |

## 5. 坑（这一条最值钱，本轮真实踩过）

### 坑 1：NSIS 静默安装在 schtasks 交互式会话下装不全

**现象**：`Corum-0.2.2-win-x64.exe /S /currentuser` 经 `schtasks /ru remote /it` 运行后，`Corum.exe` 和 dll 装上了，但 `resources/node/` 目录**整个不存在**、`resources/host/node_modules/` 缺一堆包（js-yaml 等）。

**误判**：以为是我的代码改动导致起不来，查了半天 main.ts。实际是**安装不完整**，跟代码无关。

**判据**：`combo "coding" host ready` 不出现 + stderr 有 `ENOENT` / `Cannot find package` ⇒ 先怀疑安装不完整，不是代码 bug。

**根治**：**永远用 zip 解压，不用 NSIS 静默安装**（§2.2-2.3）。NSIS exe 只用于交互式双击安装。

### 坑 2：解压后 PS 异步未刷盘，Test-Path 暂时 False

`Expand-Archive` 在 schtasks 会话里返回"完成"但文件还没刷盘，紧接着 `Test-Path` 可能假 False。**等 2-3 秒再验**，或直接启动看 host ready 日志（日志是唯一权威）。

### 坑 3：corum 跑在 remote 用户，SSH 是 Administrator

跨用户启动 GUI 进程到另一个用户的桌面会话，只有 `schtasks /ru <user> /it` 这一条干净路径。`psexec -i` 也可以但要装 PsTools。**别试** `ssh ... runas /user:remote`（会卡密码/UAC）。

### 坑 4：SSH 隧道随 corum kill 而断

kill 远程 corum 时，如果隧道进程的 keepalive 探测触发，隧道可能退。**每次 kill+重启 corum 后，重建隧道**（§2.5 的 pkill + ssh 重连）。

## 6. 清理（每次验完）

```bash
# 1. 删 schtasks（别留后台任务）
"$SK/scripts/win-remote.sh" run 'schtasks /delete /tn corum_ps /f'  # 临时任务的固定名
# 2. kill 远程 corum（验完就关，别常驻占资源）
"$SK/scripts/win-remote.sh" ps 'Get-Process Corum -ErrorAction SilentlyContinue | Stop-Process -Force'
# 3. 拆 Mac 本地隧道
pkill -f "ssh.*9222.*192.168.1.121"
# 4. 推上去的 zip/installer 留在 C:\corum\ 下次复用（不删，推一次要 1-2 分钟）
```

## 7. 一轮完整验证的最小动作序列

```bash
# 0. 前置：win11-remote check 通过（机器在、SSH 通）
# 1. Mac：交叉打包
cd packages/desktop && pnpm run pack:win
# 2. 推 zip + 解压（§2.2-2.3）
# 3. schtasks 带 CDP 启动（§2.4）
# 4. SSH 隧道（§2.5）
# 5. chrome-devtools MCP 或 ui-verify 驱动验证
# 6. 看 stderr 确认 combo "coding" host ready（§3）
# 7. 清理（§6）
```

> **"编译过"和"Mac 上验过"都不等于 Windows 验过**（红线 5/7）。Windows 平台分叉（标题栏/原生依赖/终端 shell/路径拼接）必须在真 Windows 上验。改了 `platform/win32.ts` 或 host 侧 Electron 代码，**必走本技能**。
