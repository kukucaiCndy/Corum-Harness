---
name: win11-remote
description: Use when connecting to, running commands on, or deploying/building on a Windows machine from the Mac — covers TWO machines: Windows 11 (USER-20231001WG, 192.168.1.121 / .216) and Windows 10 (DESKTOP-UATGHRF, 192.168.1.86). Each has its own key, user, and shell (Win11=cmd.exe/Win10=PowerShell 5.1). Use win-remote.sh for Win11, win10-remote.sh for Win10. Or when "Windows 那台机器连不上" — covers the SSH entry through the user's SOCKS5 proxy, automatic NIC picking, RDP login facts, and pitfalls. Do not use for the Linux test machine (that is corum-linux-verify).
---

# Windows 远程操控（win11-remote）

## 0. 一句话

**两台 Windows 机器，各用各的脚本：**

| 机器 | 脚本 | IP | 用户 | 密钥 | 系统 | 默认 shell |
|---|---|---|---|---|---|---|
| **Windows 11** | `win-remote.sh` | 192.168.1.121 / .216 | Administrator | `~/.ssh/win11_lan_ed25519` | Win11 26200 | cmd.exe |
| **Windows 10** | `win10-remote.sh` | 192.168.1.86 | remote | `~/.ssh/id_ed25519_win10` | Win10 19045 (22H2) | PowerShell 5.1 |

**别直连、别写死 IP、别用 ping 判断死活。** 沙箱里直连局域网对等设备会在 **0.0 ms** 内失败，
目标地址会在两块网卡之间飘，而那台机器**故意不回 ICMP**。`scripts/win-remote.sh` 把这三件事都处理好了。

## 1. 目标机事实

### Windows 11（USER-20231001WG）

| 事实 | 值 |
|---|---|
| 主机名 | `USER-20231001WG` |
| 系统 | Windows 11 专业版 / Build 10.0.26200.9457 / AMD64（Build 会随系统更新变化，实测过 .8737→.9457） |
| 硬件 | 24 逻辑核 / 63.7 GB RAM / C: 约 398 GB 可用（2026-10-12 实测） |
| 网卡 | **两块在同一网段**：`192.168.1.121`、`192.168.1.216`（另有 169.254.x 与两个虚拟网卡） |
| 网关 | 192.168.1.1 |
| SSH | `Administrator@<ip>:22`，密钥 `~/.ssh/win11_lan_ed25519`（ed25519，注释 `win11-lan-login`）。**sshd 必须设为自启**，否则机器一重启就失效（判据见第 5 节） |
| 远程 shell | **cmd.exe**（用 `&` 串联；`net` / `dir` / `where` 直接可用） |
| RDP | **3389 开放**；账号 `remote`（已在 Administrators + Remote Desktop Users） |
| 其他端口 | 445 / 135 / 139 / 5985 / 5986 **全不通**（被 Windows 防火墙挡） |

### Windows 10（DESKTOP-UATGHRF）

| 事实 | 值 |
|---|---|
| 主机名 | `DESKTOP-UATGHRF` |
| 系统 | Windows 10 / Build 10.0.19045.0 (22H2) / AMD64 |
| IP | `192.168.1.86`（单网卡，不飘） |
| 网关 | 192.168.1.1 |
| SSH | `remote@192.168.1.86:22`，密钥 `~/.ssh/id_ed25519_win10`（ed25519，注释 `remote@DESKTOP-UATGHRF`） |
| 远程 shell | **PowerShell 5.1**（Windows PowerShell Desktop，非 PS7）—— 注意：`win-remote.sh run` 走 cmd.exe 语法在这台机器上可能报错（PowerShell 不认 `&` 连接符），优先用 `ps` 子命令 |
| RDP | 3389 开放（待确认账号） |
| 与 Win11 差异 | PowerShell 5.1（无 ternary/??）；默认 shell 是 PS 而非 cmd；单网卡不飘；无加速器掐直连问题 |

## 2. 入口脚本

### Windows 11：`win-remote.sh`（自动选通道，双网卡 + 加速器兜底）

```bash
SK=$HOME/.corum/skills/win11-remote
$SK/scripts/win-remote.sh check                                    # 连通性体检（先跑这个）
$SK/scripts/win-remote.sh run 'hostname & whoami & ver'
$SK/scripts/win-remote.sh ps  '(Get-CimInstance Win32_OperatingSystem).Caption'
$SK/scripts/win-remote.sh push ./build.ps1 C:/build/build.ps1
$SK/scripts/win-remote.sh pull C:/build/out.zip ./out.zip
$SK/scripts/win-remote.sh rdp                                      # 打印 RDP 登录事实
```

### Windows 10：`win10-remote.sh`（单网卡，PowerShell 5.1）

```bash
SK=$HOME/.corum/skills/win11-remote
$SK/scripts/win10-remote.sh check                                  # 连通性体检
$SK/scripts/win10-remote.sh ps 'hostname; whoami; [System.Environment]::OSVersion.VersionString'
$SK/scripts/win10-remote.sh push ./file.ps1 C:/build/file.ps1
$SK/scripts/win10-remote.sh pull C:/build/out.zip ./out.zip
```

⚠️ **Win10 注意**：默认 shell 是 PowerShell 5.1，`run` 子命令（走 cmd.exe）可能报语法错误
（PowerShell 不认 `&` 连接符），优先用 `ps` 子命令。win10-remote.sh 只是 win-remote.sh
的 wrapper（设 `WIN_USER=remote WIN_KEY=~/.ssh/id_ed25519_win10 WIN_CANDIDATES=192.168.1.86`）。

脚本**先试直连，直连不通再经 SOCKS5 代理**（`ProxyCommand=nc -X 5 -x 127.0.0.1:7890 %h %p`，
与 `corum-linux-verify` 同一套约定）。用 `WIN_NO_PROXY=1` 可强制只直连。

## 3. 直连为什么时通时不通：**是加速器，不是沙箱**（2026-10-12 更正）

| 观察 | 真实含义 |
|---|---|
| `bludcloud`（`/Applications/蓝鸟加速器.app`）**在运行**时，shell 直连 .121/.216 → **0.0–0.2 ms** 返回 `No route to host` | 加速器的网络扩展**掐掉了到局域网对等设备的直连**（不是 ARP 失败，真 ARP 失败要 ~1s） |
| 该进程**完全退出**后，同一 shell 直连 → **立刻正常**（实测 `.121:3389` succeeded） | 证明原因在加速器，**不在 Corum 沙箱** |
| 打网关 `192.168.1.1` 却一直正常 | 掐的只是**局域网对等设备** |

⚠️ **不要再把它归因于"Corum 子进程被沙箱限制"**——那是 2026-10-11 的误判（当时只查了系统代理
例外表与 TUN 模式，没查到加速器的网络扩展这一层）。用户第一直觉"是不是代理导致的"才是对的。

对**不存在**的地址（例如 .250）返回的错误一模一样 ⇒
**用"连不上"推断"机器没开机"是错的**，这个错误本轮排查里真实发生过。

⚠️ **代理自己也会骗你**：`nc -z -X 5 -x 127.0.0.1:7890 <ip> <port>` 报 `succeeded`
**不代表真能连**。实测该加速器的 SOCKS5 会先接受 CONNECT、随后却不转发数据：
`nc -z` 说 22 开放，而 `ssh` 在 `kex_exchange_identification: Connection closed by
remote host` 就断了。**端口可达性只认"真跑一次 ssh 并拿到 hostname"**，
不要用经代理的 `nc -z` 下结论。代理路径本身也是**间歇**的（同一晚通了又断），
拿不准就换第 6 节的 launchd 直连通道复核。

## 4. 已知坑（全部实测踩过）

1. **双网卡飘 IP**：`.216` 确实掉过一次（`Host is down`），`.121` 正常。**永远先 `check`**。
   根治：在 Windows 上开 `ncpa.cpl` 禁用闲置那块网卡。
2. **两端时钟可能不同步**：排查期间观察到 Windows 与 Mac 相差约 20 小时，**后来 Mac 侧时间
   又追上了**——所以**不要假定哪边准**。构建/打包前两端各自校时（Windows 用
   `w32tm /resync`），否则产物时间戳错乱、TLS 证书校验失败。
3. **ICMP 被挡**：`ping` 不通是设计如此，不能当死活判据。
4. **机器会睡眠**：长期不用会断连；`powercfg /change standby-timeout-ac 0` 可关。
5. **上传的 `.ps1` 里别放中文**：scp 过去后 PowerShell 按 GBK 解析，中文会破坏引号 →
   直接 `ParserError / UnexpectedToken`（本轮踩过）。脚本用**纯 ASCII**，或带 BOM 的 UTF-8。
6. **`net user` 的中文输出是 GBK**：读的时候用 `iconv -f GBK -t UTF-8 -c`，
   **不要用 `tr`**（会报 `Illegal byte sequence` 并截断输出）。

## 5. 连不上时的判据表

| 现象 | 先查什么 |
|---|---|
| 直连 **0.0ms** 报 `No route to host` | **加速器在跑**（`pgrep -l bludcloud`）——让它完全退出，或让脚本回退走代理。**不要误判成"机器不在网里"** |
| `.121` 与 `.216` 都不通 | `win-remote.sh check` 先看：代理状态 + 两块网卡端口 |
| 代理没跑、直连也不通 | 见第 6 节 launchd 兜底 |
| 一块通、一块不通 | **正常**（双网卡），用通的那个 |
| 返回 `Host is down` | 该网卡掉了，换地址重试 |
| 22 超时、但 3389 能连 | **服务／防火墙问题**。2026-10-12 实测根因：sshd 其实**一直在** `0.0.0.0:22` LISTENING，缺的是**防火墙入站规则**；该机网络是 **Public**（profile 名 `kukucai_5G`），公用网络入站默认丢弃 ⇒ 表现为"超时"而非"拒绝"。RDP 进去跑：`Set-Service sshd -StartupType Automatic; Start-Service sshd; Remove-NetFirewallRule -Name sshd -EA 0; New-NetFirewallRule -Name sshd -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Any` |
| ssh 报 `kex_exchange_identification ... closed` | 代理接受连接却不转发 → 换直连或第 6 节 launchd 通道 |
| `nc -z` 经代理说"开放"但 ssh 连不上 | **假阳性**，别信；只认真的 ssh 成功 |
| SSH 通但 RDP 连不上 | 分别验；3389 与 22 是两件独立的事 |

## 6. 兜底：直连与代理都不行时，用 launchd 通道

当**加速器在跑（掐直连）**又**代理不转发**时，还有第三条路：把命令交给 **由 launchd 启动的
进程**执行。写一个 plist 到 `/tmp`：

```bash
launchctl bootstrap gui/$(id -u) /tmp/com.corum.winrun.plist    # 启动任务
# ... 轮询它写出的结果文件 ...
launchctl bootout   gui/$(id -u) com.corum.winrun               # 必须收尾，别留后台任务
```

plist 的 `ProgramArguments` 指向一个 bash 脚本，脚本内部再 ssh。**要注意**：这一条在
2026-10-11 那次"加速器在跑"的窗口里**能连上而 shell 直连不能**（可能是加速器的扩展按进程
放行），所以它在加速器场景下仍有价值；但**别据此推断成"沙箱限制"**（见第 3 节的更正）。
它的代价是每次要写 plist + 轮询输出文件，用完务必 `bootout`。

## 7. RDP 登录（人工使用）

```
计算机: 192.168.1.121（登录前先 check）    用户名: remote（或 USER-20231001WG\remote）
密码:   由用户保管，不进仓库/技能 —— 需要时问用户
```

- 客户端：macOS 用 App Store 的 **Windows App**（免费），或 `brew install freerdp` +
  `xfreerdp /v:<ip> /u:remote /dynamic-resolution`。
- **RDP 不能用 PIN**；该机未加域、非 AzureAD，只能"账号 + 密码"登录。
- 忘记密码 → 用 SSH 重置（当前已有管理员权限）：
  `win-remote.sh run 'net user remote <新密码>'`，再用 `LogonUser` 复核。
- `remote` 已在 **Administrators** 与 **Remote Desktop Users**；UAC 弹窗点"是"即可通过。

## 8. 构建环境现状（部署/编译/打包/测试前必读）

- **已有**：git 2.53、ninja 1.13、python 3.14（`C:\Python314`）、node 24 + npm、
  winget、curl、tar、msys64、vcpkg
- **缺失**：`cmake`、**MSVC（`cl` / `msbuild`）**、`dotnet`

⇒ **现在直接跑编译一定失败。** 先补：

```powershell
winget install Kitware.CMake
winget install Microsoft.VisualStudio.2022.BuildTools   # 勾"使用 C++ 的桌面开发"
# 仅 .NET 项目需要： winget install Microsoft.DotNet.SDK.8
```

**目录**：`F:\work`（agent / ai-skills / blender / esp32 / hardware / software / winshark /
test-loacl-v4flash）、`D:\Wechat\MyApp` 等；建议构建放 `C:\build` 这类纯英文无空格路径。

## 9. 维护约定

本技能是"**能连上、能跑起来**"的可执行投影。事实源在用户机器上（`ipconfig` / `net user` /
`quser` / `netstat` 的实测输出）。任何一条与实测冲突，**以实测为准并回来改本技能**——
尤其 IP 地址、账号组成员、工具链有无。相关技能：`corum-linux-verify`（Linux 测试机）。
