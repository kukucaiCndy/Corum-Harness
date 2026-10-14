#!/bin/bash
# corum-win11-remote: 统一远程入口（连接 Windows 11 构建机）。
#
# 为什么长这样（每一条都是实测付过学费的）：
#   · **连接方式要按环境自动选**：默认先试**直连**；直连不通再试用户系统的 SOCKS5
#     代理 127.0.0.1:7890。实测规律：
#       - 蓝鸟加速器（/Applications/蓝鸟加速器.app，进程名 bludcloud）**完全退出**时，
#         Corum shell 直连局域网对等设备**正常**；
#       - 它**在运行**时，同样直连会在 0.0ms 内返回 EHOSTUNREACH（不是 ARP 失败，
#         真 ARP 失败要 ~1s）—— 这是它的网络扩展掐掉了直连，**不是**沙箱限制。
#       （2026-10-11 我曾把它误判成"Corum 子进程被沙箱限制"，2026-10-12 更正。）
#   · **经代理的 `nc -z` 会假阳性**：SOCKS 先接受 CONNECT 却不转发数据，
#     `nc -z` 报 succeeded 而 ssh 死在 kex_exchange_identification。
#     所以端口可达性只认"真跑一次 ssh 并拿到 hostname"。
#   · 目标机两块网卡在**同一网段**（192.168.1.121 / .216）且会飘，脚本自动挑在线的。
#   · ICMP 被 Windows 防火墙挡，**ping 不通是常态**。
#   · 默认远程 shell 是 cmd.exe（`&` 串联命令）。
#   · 密钥登录，密码全程不落盘。
#
# 用法：
#   win-remote.sh check                      # 连通性体检（代理状态 + 端口 + 身份）
#   win-remote.sh run   '<cmd>'              # 在 cmd.exe 里执行
#   win-remote.sh ps    '<powershell 语句>'  # 在 PowerShell 里执行
#   win-remote.sh push  <本地文件> <远程路径>
#   win-remote.sh pull  <远程路径> <本地文件>
#   win-remote.sh rdp                        # 打印 RDP 登录事实
#
# 环境变量：
#   WIN_USER   默认 Administrator
#   WIN_KEY    默认 ~/.ssh/win11_lan_ed25519
#   WIN_SOCKS  默认 127.0.0.1:7890
#   WIN_HOST   指定则只用该地址（跳过自动挑选）
#   WIN_NO_PROXY 1 = 禁用代理回退，只直连
set -uo pipefail

KEY="${WIN_KEY:-$HOME/.ssh/win11_lan_ed25519}"
WINUSER="${WIN_USER:-Administrator}"
SOCKS="${WIN_SOCKS:-127.0.0.1:7890}"
KNOWN="${WIN_KNOWN_HOSTS:-/tmp/corum_win_known_hosts}"
CANDIDATES="${WIN_CANDIDATES:-192.168.1.121 192.168.1.216}"

[ -f "$KEY" ] || { echo "密钥不存在：$KEY" >&2; exit 1; }

BASE_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o "UserKnownHostsFile=$KNOWN"
           -o BatchMode=yes -o ConnectTimeout=8 -o LogLevel=ERROR
           -o PreferredAuthentications=publickey -o ServerAliveInterval=30)
DIRECT_OPTS=("${BASE_OPTS[@]}")
PROXY_OPTS=("${BASE_OPTS[@]}" -o "ProxyCommand=nc -X 5 -x $SOCKS %h %p")
DIRECT_SCP=(-i "$KEY" -o StrictHostKeyChecking=no -o "UserKnownHostsFile=$KNOWN"
            -o BatchMode=yes -o ConnectTimeout=8 -o LogLevel=ERROR)
PROXY_SCP=("${DIRECT_SCP[@]}" -o "ProxyCommand=nc -X 5 -x $SOCKS %h %p")

HOST=""; MODE=""; ERR=""

ssh_try() {  # $1=direct|proxy  $2=ip  $3=远程命令
  if [ "$1" = proxy ]; then ssh "${PROXY_OPTS[@]}" "$WINUSER@$2" "$3" </dev/null
  else                      ssh "${DIRECT_OPTS[@]}" "$WINUSER@$2" "$3" </dev/null; fi
}

scp_opts() {  # $1=direct|proxy → 回显该模式下的 scp 选项数组名
  [ "$1" = proxy ] && echo PROXY_SCP || echo DIRECT_SCP
}

# 先直连、后代理，挑出第一块能用的网卡 + 可用的通道
resolve() {
  [ -n "$HOST" ] && return 0
  local ip out
  for ip in $CANDIDATES; do
    out="$(ssh_try direct "$ip" hostname 2>&1)" && { HOST="$ip"; MODE=direct; return 0; }
    ERR="$out"
    if [ "${WIN_NO_PROXY:-0}" != "1" ]; then
      out="$(ssh_try proxy "$ip" hostname 2>&1)" && { HOST="$ip"; MODE=proxy; return 0; }
      ERR="$out"
    fi
  done
  return 1
}

why_failed() {  # 把 $ERR 翻成人话
  case "$ERR" in
    *kex_exchange_identification*|*"Connection closed"*) echo "代理接受连接却不转发（换直连或 launchd 通道）" ;;
    *"Host is down"*)        echo "该网卡不在线" ;;
    *"Permission denied"*)   echo "密钥被拒（authorized_keys / 文件权限问题）" ;;
    *"Connection refused"*)  echo "端口被拒绝（sshd 未监听）" ;;
    *"timed out"*)           echo "端口不通（sshd 没在跑／防火墙；RDP 可能仍可用）" ;;
    *)                       echo "失败：$(printf '%s' "$ERR" | tail -1)" ;;
  esac
}

mode=""; [ $# -gt 0 ] && { mode="$1"; shift; }

case "$mode" in
  check)
    if lsof -nP -iTCP:${SOCKS##*:} -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  代理 $SOCKS : 在运行（直连可能被它掐断，见脚本头）"
    else
      echo "  代理 $SOCKS : 未运行（直连应可用）"
    fi
    for ip in $CANDIDATES; do
      echo "  --- $ip ---"
      for p in 22 3389; do
        printf '     %-5s 直连: ' "$p"
        if /usr/bin/nc -z -G 4 "$ip" "$p" 2>/dev/null; then echo "开放 ✅"; else echo "不通 ❌"; fi
      done
      printf '     SSH 登录  : '
      # 变量后面紧跟中文必须写 ${var}：bash 会把多字节字符当成变量名的一部分（踩过）
      if out="$(ssh_try direct "$ip" hostname 2>&1)"; then echo "${out}（直连）"
      elif [ "${WIN_NO_PROXY:-0}" != "1" ] && out2="$(ssh_try proxy "$ip" hostname 2>&1)"; then echo "${out2}（经代理）"
      else ERR="$out"; echo "$(why_failed)"; fi
    done
    ;;

  run|ps|push|pull|rdp)
    if ! resolve; then
      case "$mode" in
        rdp) HOST="${CANDIDATES%% *}";;   # rdp 只打印事实，不要求此刻连得上
        *)   echo "目标不可达：$(why_failed)" >&2; exit 1;;
      esac
    fi
    case "$mode" in
      run)  ssh_try "$MODE" "$HOST" "${1:?需要远程命令}";;
      ps)   # base64(UTF-16LE) 交给 -EncodedCommand：彻底绕开 cmd/ssh 的嵌套引号吞噬与中文编码问题。
            # （曾经直接内联 "powershell -Command \"...\"" ，被 cmd 吃掉内层双引号后命令全乱。）
            cmd="\$ProgressPreference='SilentlyContinue'; ${1:?需要 PowerShell 语句}"
            b64="$(printf '%s' "$cmd" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')"
            ssh_try "$MODE" "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $b64";;
      push) src="${1:?需要本地文件}"; dst="${2:?需要远程路径}"
            [ -f "$src" ] || { echo "本地文件不存在：$src" >&2; exit 1; }
            eval "o=(\"\${$(scp_opts "$MODE")[@]}\")"; scp "${o[@]}" "$src" "$WINUSER@$HOST:$dst";;
      pull) src="${1:?需要远程路径}"; dst="${2:?需要本地路径}"
            eval "o=(\"\${$(scp_opts "$MODE")[@]}\")"; scp "${o[@]}" "$WINUSER@$HOST:$src" "$dst";;
      rdp)  cat <<EOF
  计算机: $HOST        （两块网卡会飘，登录前先 check）
  用户名: remote       （或 USER-20231001WG\\remote）
  密码:   由用户保管，不进仓库（见 SKILL.md 第 7 节）
  客户端: macOS 用 "Windows App"(App Store 免费)，或 brew install freerdp
  注意:   RDP 不能用 PIN；该机未加域、非 AzureAD，只能账号+密码登录
EOF
      ;;
    esac
    ;;

  *)
    echo "未知模式：${mode:-（空）}（可用 check / run / ps / push / pull / rdp）" >&2
    exit 2
    ;;
esac
