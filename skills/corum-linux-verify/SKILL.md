---
name: corum-linux-verify
description: Use when building, packaging, running, or verifying corum Agent OS (kkc-desktop) on the Linux test machine (192.168.1.18, Ubuntu 24.04), or when producing/checking the Linux distributables (AppImage/deb) and the cross-platform smoke test — reach the machine over the local SOCKS5 proxy, bootstrap the toolchain, install, build, launch on the real desktop, drive the UI, and read the packaging platform split (macOS vs Linux vs Windows) before touching it. Also use when a Linux run "does nothing", the window is blank, CDP is unreachable, or the dir picker seems not to open.
---

# corum Linux 实机验证（Linux 技能）

本技能是**在 Linux 测试机上把 corum 跑起来、验出来、打出包**的可执行投影。
事实与裁决的家是 `docs/tasks/log.jsonl`（key 以 `tooling.linux-` / `bug.*linux*` 开头那几条）
与 `docs/PLAN-2026-10-06-linux-adaptation.md`；两者冲突以文档为准，并回来修本技能。

## 0. 一句话

**先证明「哪一层坏了」再动手：这台机器上的「没反应」八成不是产品 bug，而是焦点、合成器、
端口占用、或 FUSE 缺依赖 —— 每一条都有可复核的判据，先读第 5 节再开始排障。**

## 1. 目标机与访问（唯一入口）

| 事实 | 值 |
|---|---|
| 主机 | `192.168.1.18`（用户 2026-10-06 指定的 Linux 测试机） |
| 系统 | Ubuntu **24.04.4 LTS** / kernel 6.17 / **x86_64** / 8 核 / 15 GiB / 根分区 204 GB |
| 桌面 | GNOME，X 在 **`:1`**，属用户 `kukucai`（`root` 借其 Xauthority 可连） |
| 登录 | `root`（**密码由用户提供，不进仓库**：每次 `export SSH_PW=...`，或放你自己的密码管理器） |
| 仓库落地 | `/opt/corum/Corum-Harness`（`git clone` 自 Mac 打的 bundle） |

### 1.1 网络：沙箱内**无路由**，必须走用户系统代理

Mac 侧沙箱里 `ping`/`ssh` 直连目标机是 `No route to host`（ARP 解析不出），因为默认出网
**没走用户本机的代理**。可用的出口是用户系统里挂着的 **`127.0.0.1:7890`（HTTP/SOCKS5）**：

```bash
ssh -o "ProxyCommand=nc -X 5 -x 127.0.0.1:7890 %h %p" root@192.168.1.18 '<cmd>'
```

**判据纪律**：探活**绝不信 `nc -z`** —— 经代理对不可达目标它会把 22/80/443 **全报「开放」**。
只信**真实应答**（首连拿到 `Permission denied (publickey,password)` 就证明 sshd 在听；
HTTP 看状态码；SSH 看 banner）。

### 1.2 密码交互：**`expect` 在本沙箱内不可用**

`expect` 的 `spawn` 会失败并报 `The system has no more ptys`（Agent 沙箱不给 pty）。
`setsid` 在 macOS 上也不存在。**唯一可用的形态是 `SSH_ASKPASS`**：

```bash
export SSH_PW='<密码>'
export SSH_ASKPASS=/path/to/askpass.sh   # 内容仅 printf '%s\n' "$SSH_PW"，不含凭据
export SSH_ASKPASS_REQUIRE=force DISPLAY=:0
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    -o NumberOfPasswordPrompts=1 -o "ProxyCommand=nc -X 5 -x 127.0.0.1:7890 %h %p" \
    root@192.168.1.18 '<cmd>' </dev/null
```

`scripts/remote.sh` 已把这套封好（见 §7）。

## 2. 传输：**长连接会 stall，必须分块**

实测同一链路：10 MB 单独传 **1.4 s**（≈7.7 MB/s）；而一条 SSH 里 `cat` 传 52 MB
**卡在 21 MB / 10 分钟**。⇒ **>几 MB 的文件一律分块 + 逐块 SHA256 + 收尾全文件 SHA256**。

- 分块传输（上行）：`scripts/chunked-push.sh <本地文件> <远程路径> [块大小]`
- 分块传输（下行）：`scripts/chunked-pull.sh <远程文件> <本地路径> [块大小]`（chunked-push 的反向，长连接会 stall 时用）
- 小文件（脚本、配置、产物 JS）：**base64 内联进一条 SSH** 最稳，无外部依赖
  （`remote.sh push-run` 就是这条路径）。
- **不用 `scp`/`rsync`**：Mac 侧 rsync 是 `openrsync 2.6.9`，且 stub 传输同样会 stall。

首次上机用 **`git bundle`** 而不是目录同步（单文件、可校验、`git clone` 出来是真仓库）：

```bash
git bundle create /tmp/corum.bundle --all      # Mac 侧
chunked-push.sh /tmp/corum.bundle /tmp/corum.bundle
# 远程：git clone -b main /tmp/corum.bundle /opt/corum/Corum-Harness
```

## 3. 上机自检 + 引导（`scripts/bootstrap-ubuntu.sh`）

原机只有 `bwrap`/`tar`/`python3`/`unzip`。缺的全部装齐：

```bash
apt-get install -y git curl rsync ca-certificates bubblewrap libfuse2t64 fuse3 \
                   xvfb x11-utils xauth imagemagick xdotool
# Node 22（满足 engines ^22.19.0 || >=24）：
#   curl -fsSL nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz | tar -xJ -C /usr/local
#   ln -sfn .../bin/{node,npm,npx,pnpm,corepack} /usr/local/bin/
npm i -g pnpm@11.7.0          # 必须与 package.json 的 packageManager 一致
```

**踩点**：`npm i -g` 把 pnpm 装进 **node 自己的 prefix**，不在 PATH ⇒ 必须逐个 `ln -sfn` 到
`/usr/local/bin`（另写 `/etc/profile.d/corum-node.sh` 兜底）。

**必备系统前置（缺了会以奇怪方式失败）**：

| 包 | 为什么必需 |
|---|---|
| `bubblewrap` | Agent 沙箱 Linux 首选档；**缺它沙箱 fail-closed ⇒ 每一次 bash 工具调用都失败**（不是退化成无沙箱） |
| `libfuse2t64` | **AppImage 运行依赖**；Ubuntu 24.04 默认不带（`fuse3` 不含 `libfuse.so.2`） |
| `xvfb` / `x11-utils` / `imagemagick` / `xdotool` | 无头运行与真实像素/输入验证 |
| `zenity`（桌面自带） | 原生目录选择器在 Linux 上就是 `zenity --file-selection` |

## 4. 装依赖与配置

### 4.1 `.npmrc`：`@deepseek-ai` 必须指向 **Mac 上的 verdaccio**

`@deepseek-ai/dsh-tools@0.1.3-alpha.1` **只发布到私服**（公共 npm 只有 `-alpha.2`），
而 lockfile 钉死该版本 ⇒ 公共 registry **必然 404**。verdaccio 监听 `*:4873`，Linux 实测可达：

```ini
@deepseek-ai:registry=http://192.168.1.4:4873/
registry=https://registry.npmjs.org/
strict-ssl=false
```

然后 `pnpm install --frozen-lockfile`（实测 15.7 s 成功）。

### 4.2 Electron 二进制：必须走镜像

releases 会 302 到 `objects.githubusercontent.com`（**超时**）。
用 `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`（实测可下，313 MB）。

### 4.3 LLM 供应商（要用真 Agent 时）

官方适配器 **不在配置里内联 key**：key 取自 ① credentials 服务（网页 Models 页写入）
或 ② 启动环境变量 `DEEPSEEK_API_KEY`。**用环境变量最省事、且不落盘**。
settings 段按 `llm-deepseek` 的 schema 写（`models[]` + `agent-default-model`）。
**省钱纪律：先 `GET /models` 查该 key 有哪些模型，再挑便宜的（避免 pro）。**

## 5. 运行与验证（本技能的核心：先定位是哪一层）

### 5.1 启动形态

```bash
# 以**桌面用户**启动（不是 root），在真实桌面 :1 上
su - kukucai -c "cd /opt/corum/Corum-Harness/packages/desktop && \
  DISPLAY=:1 XAUTHORITY=/run/user/1000/gdm/Xauthority \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  DEEPSEEK_API_KEY='$KEY' nohup node lib/cli.js --no-sandbox --remote-debugging-port=9333 >/tmp/app.log 2>&1 &"
```

**为什么必须用桌面用户**：以 root 借他人 X display 启动，窗口**全空白**，日志是
`x11_software_bitmap_presenter: XGetWindowAttributes failed` + 反复 `Authorization required`。
非 root 还顺带修好 `safeStorage`（不再打 `credentials encryption disabled`）。

### 5.2 `safeStorage` 必须显式指定密码后端（已在代码里修）

Linux 上 Chromium **不会自动选中**密钥环后端，默认落到「无可用后端」⇒
`isEncryptionAvailable()` 为 false ⇒ 凭证层整体降级（用户可见症状：「暂时无法保存确认状态」）。
`main.ts` 已在 Linux 上 `appendSwitch('password-store', 'gnome-libsecret')`
（可用 `CORUM_LINUX_PASSWORD_STORE` 覆盖）。三组对照实测：默认❌ / `gnome-libsecret`✅ / `basic`❌。

### 5.3 真实像素判据（**只看 DOM / CDP 截图会漏掉「窗口没显示」**）

实测过：DOM `readyState=complete`、CDP 截图 1990 色，而**物理窗口全空白**。故必须在 X 层看：

```bash
W=$(xwininfo -root -children | grep -iE 'Corum|Harness' | awk '{print $1}' | head -1)
import -window root /tmp/root.png
convert /tmp/root.png -crop ${gw}x${gh}+${gx}+${gy} +repage /tmp/crop.png   # 几何取自 xwininfo -id
identify -format '%k' /tmp/crop.png                                          # 唯一色
```

**阈值**：空白窗口 **118~188** 色；有内容 **1959~36301**。取 500 作分界。

**两个必须同时做的动作**（否则判据会骗你）：
1. **先把窗口抬到最前并激活**：`xdotool windowactivate/windowraise/windowfocus`。
   漏了这步会抓到「唯一色=1」，并误判成「窗口空白」。
2. **两种抓法取最大值**：mutter(GNOME) 下抓**窗口自身 pixmap 会得空白**，必须抓 root 再按几何裁剪；
   Xvfb 下两种都行。只信一种就会假失败/假通过。

### 5.4 驱动 UI：**先聚焦，否则事件根本不送达**

**这是本机最耗时间的一个坑**。未聚焦时 CDP `Input.dispatchMouseEvent` 与手写事件
**完全不产生任何反应**（0 console、0 exception、0 DOM 变化 —— 看起来像「按钮坏了」）。
本仓 `scripts/cdp-click.mjs` 头注释已记载同类现象（React 忽略合成事件）。

**正确顺序**：
```bash
eval "$(xdotool getwindowgeometry --shell "$WID")"     # 拿 X/Y 偏移
xdotool windowactivate "$WID"; xdotool windowraise "$WID"; xdotool windowfocus "$WID"; sleep 2
xdotool mousemove --sync $((X+relX)) $((Y+relY)); xdotool click 1
```
- **窗口内相对坐标 + 窗口偏移 = 屏幕绝对坐标**；直接拿相对坐标当绝对坐标会点到别处。
- 需要更多把握时用 `xdotool` 的**真实 X 事件**（比 CDP 合成事件更容易被 React 接受）。
- 表单里的原生目录选择器：先 `xdotool search --class zenity` 找到**它自己的**窗口再驱动
  （`Ctrl+L` 输路径 + Enter），**别假设它在主窗坐标系里**。

### 5.5 冲烟测试

```bash
cd /opt/corum/Corum-Harness
DISPLAY=:1 CDP_PORT=9333 node scripts/corum-smoke.mjs --fast   # 快档
DISPLAY=:1 CDP_PORT=9333 node scripts/corum-smoke.mjs --full   # 全档（含沙箱真约束）
```
`skip` **不等于通过** —— 报告末尾会逐条打印跳过原因。

## 6. 打包（B 阶段）与平台区分

### 6.1 打包链路（四步，顺序不可换）

```
build → pack:host → pack:node → pack:app(:linux)
```

**⚠️ 已知缺陷**：`pack:linux` 只调 `electron-builder`，**跳过了 `build`/`pack:host`/`pack:node`**——
若 `build/host`、`build/node` 还是 Mac 上跑出来的，就会**静默把 Mach-O 的 Node 打进 Linux 包**。
**判据**：`file packages/desktop/build/node/bin/node` 必须是 `ELF ... x86-64`。

### 6.2 平台区分的**三个层次**（详细版见 `docs/PLATFORM-SPLIT.md`）

| 层次 | 机制 | 本仓现状 |
|---|---|---|
| ① 打包期 | electron-builder 的 `mac` / `linux` / `win` 段 + CLI 的 `--mac/--linux` | mac + linux 已备；**win 段不存在**（无 `.ico`、无 NSIS） |
| ② 物化期 | `fetch-node.mjs` 按 `process.platform/arch` 取对应 Node 归档；`pack-macos.mjs` **零平台分支**（名字骗人） | 三平台归档映射已实现 |
| ③ 运行期 | 应用代码里 `process.platform` 分支 + **隐式假设** | ≈65 处分叉 / 10 个子系统；其中 **≈35 处是隐式假设** |

**维护代价的结论**：真正贵的不是显式分支（那些有定义好的答案），而是
**隐式假设**（硬编码 `/bin/zsh`、`~/` 点目录、`/` 拼路径、macOS 交通灯 76px 内边距、
POSIX 命令名白名单）——它们在第三个平台上**静默走样**，不报错。

## 7. 复用脚本

| 脚本 | 用途 |
|---|---|
| `scripts/remote.sh` | 统一入口：`run <cmd>` / `script <file>` / `push <local> <remote>` / `push-run <local> <remote> <cmd>` |
| `scripts/chunked-push.sh` | 分块 + 逐块校验 + 重试的文件传输（>几 MB 必用） |
| `scripts/chunked-pull.sh` | chunked-push 的反向：从远端分块拉取（长连接 stall 时用） |
| `scripts/bootstrap-ubuntu.sh` | 目标机幂等引导（apt 依赖 / Node / pnpm / npmrc / 校验） |

四个脚本都只从**环境变量**读密码（`SSH_PW`），**不含任何凭据**。

## 8. 陷阱速查（每一条都花过时间）

| 现象 | 真因 | 处置 |
|---|---|---|
| `ping`/`ssh` 直连 `No route to host` | 沙箱无路由，未走代理 | 用 `-o ProxyCommand=nc -X 5 -x 127.0.0.1:7890 %h %p` |
| `nc -z` 报「端口全开」 | 经代理的乐观假成功 | **只信真实应答**（banner / 状态码） |
| `expect ... no more ptys` | 沙箱不给 pty | 改 `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` |
| 传输卡在中途不动 | 长连接 stall | 分块 + 逐块校验 |
| `pnpm install` 报 404 `dsh-tools@0.1.3-alpha.1` | 该版本只在 Mac 私服 | `.npmrc` 指向 `http://192.168.1.4:4873/` |
| Electron 下载卡住 | release 302 到 `objects.githubusercontent.com` | `ELECTRON_MIRROR` 走 npmmirror |
| 启动 core dump（exit 133），日志 `Running as root without --no-sandbox` | 该 FATAL 在 **C++ 层、JS 之前**抛 | `--no-sandbox` **必须在 argv**（`main.ts` 的 `appendSwitch` 来不及） |
| `FATAL: ... permissions on /dev/shm`（`/dev/shm` 明明是 1777） | **被误导**：真因是 `chrome-sandbox` 未正确配置（需 root:root + 4755） | 修 `chrome-sandbox` 权限或用 `--no-sandbox`，**别去改 `/dev/shm`** |
| 窗口全空白 | 以 root 借他人 X display | 用桌面用户启动 |
| 窗口唯一色=1 | 抓图前没把窗口抬到最前 | 先 activate/raise/focus |
| 抓到「大号时钟」 | 抓到的是 **GNOME 锁屏**（壁纸色彩极多，唯一色**不构成判据**） | 按**窗口 id** 定位；必要时 `loginctl unlock-session` |
| 点击毫无反应 | **窗口未聚焦** | 先 `xdotool windowactivate/windowraise/windowfocus` |
| CDP 连不上但进程活着、端口在 LISTEN | **残留 `zenity` 占着该端口** | `ss -tlnp \| grep <port>` 看占用者是不是自己的进程 |
| 「目录选择器没弹出」 | 其实弹了（`zenity`），只是不在你驱动的那块屏上 | 找 zenity 自己的窗口再驱动 |
| 新建任务里工作区无可选项 | Linux home 全新 ⇒ `workspaceIds: []` | 先注册工作区（见下） |
| `another instance already owns the lock` | root 起过一次，该实例 userData 目录（`$XDG_CONFIG_HOME`/`~/.config` 下的 `corum-desktop-ud-*`；2026-10-23 前在 `/tmp`）属 root，普通用户 `readlink` 得 EACCES。**同时也是副作用证据**：root 起过 ⇒ 会在 `~/.config` 下留 root 属主的目录 | 清掉那个 userData 目录（用 root 清）；见下方「userData 落点」 |

### userData 落点（2026-10-23 变更）

Electron 的 userData 目录**不再在 `/tmp`**，改到每用户持久目录：
`$XDG_CONFIG_HOME/corum-desktop-ud-<mode>-<port>`（无 XDG 时 `~/.config/...`）。
原因 = 该目录里的 `Local State` 存着 safeStorage 的 OSCrypt 主密钥，放 `/tmp` 会被
清理工具删掉 ⇒ 全部 `enc:v1:` 凭证失效 ⇒ host `exit 1`（详见 `main.ts` 的
userData 段落与 `src/electron/user-data-dir.ts` 模块注释）。

验证时的相应调整：
- 要「干净 profile」⇒ 删**这个**目录，不是 `/tmp/corum-desktop-ud-*`（旧路径可能还有残留，
  迁移逻辑会读它一次，删之前先确认新落点已自带 `Local State`）。
- `CORUM_USER_DATA_DIR` 显式指定仍然优先（验证实例应该用它，避免碰用户真实 profile）。

### 工作区注册（应用读的地方）
`$CORUM_HOME/storages/kv.sqlite`：
- 表 `u_workspace_workspaces(key, value)`，value = `{"path","title","sessionIds","createdAt","updatedAt"}`
- 表 `unit_globals(unit, value)`，`unit='workspace'` 的行 = `{"initialized":true,"workspaceIds":[...],...}`
  —— **`workspaceIds` 里必须同时登记**，否则记录存在但列表仍为空。

## 9. 纪律

- **验收必须走用户真实使用的那条路径**。我曾用 `--appimage-extract-and-run` 验 AppImage ——
  那个 flag 正是**绕开 FUSE** 的，于是验收必然通过，而用户双击必然失败
  （真因是缺 `libfuse2t64`）。**用绕行方式跑通只能说明「内容物没坏」，证明不了「产物能运行」**。
- **装置起不来就别 debug 环境**：同一现象换一种探法**一次**，仍失败就停下来报 blocked 并贴原始输出。
- **密钥不进仓库、不进日志**；每次 `export SSH_PW=...`，收尾检查 `grep -c 'sk-' <log>` 为 0。
- **未验证的写「未验证」**，不要用措辞掩盖。

## 10. 已验证 / 未验证的边界

**已在本机验证**：SSH/代理访问、bundle 传输、`pnpm install`（走私服）、
`node-pty` 真开 PTY、`koffi` 真调 libc、`landlock probe()=full`、bwrap 真拒绝越界写、
全仓 `typecheck` 0 错 + `build` 0、应用启动 + 完整 IDE 渲染（中文无乱码、零新增控制台错误）、
AppImage（**真实双击路径**，需 `libfuse2t64`）+ deb 产出、`deepseek-flash` → bash → 沙箱端到端。

**未验证**：GNU `mktemp -t` 是否真会中断 `corum-instance.sh`；deb 在**干净**机器上的安装；
`--full` 冲烟里「应用 UI 内跑完一轮真实会话」（UI 自动化在本机时序敏感，未走完）。
