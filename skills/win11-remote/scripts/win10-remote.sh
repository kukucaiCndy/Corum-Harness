#!/bin/bash
# corum-win10-remote: Windows 10 测试机远程入口。
#
# 与 win11-remote 同一套 win-remote.sh 脚本，仅环境变量不同：
#   · IP: 192.168.1.86（单网卡，不飘）
#   · 用户: remote（非 Administrator）
#   · 密钥: ~/.ssh/id_ed25519_win10
#   · 远程 shell: PowerShell 5.1（Windows PowerShell Desktop，非 PS7）
#     —— 注意 win-remote.sh 的 run 子命令用 cmd.exe 语法（& 串联），
#        在这台机器上要用 ps 子命令（PowerShell 语法）。
#
# 用法（同 win-remote.sh）：
#   win10-remote.sh check
#   win10-remote.sh run   '<cmd>'     # 注意：run 走 cmd.exe，如需 PowerShell 用 ps
#   win10-remote.sh ps    '<powershell>'
#   win10-remote.sh push  <本地文件> <远程路径>
#   win10-remote.sh pull  <远程路径> <本地文件>
#
# Windows 10 vs Windows 11 差异（适配要点）：
#   · Windows 10 Build 19045 (22H2)，系统 API 兼容性与 11 接近
#   · PowerShell 5.1 而非 7（写脚本按 5.1 假设：无 ternary、无 ??、
#     Get-Content 读 UTF-8 无 BOM 必须加 -Encoding UTF8）
#   · 默认 shell 是 PowerShell（win11 是 cmd.exe）—— win-remote.sh 的
#     run 子命令在这台机器上可能报语法错误，优先用 ps 子命令

export WIN_USER="remote"
export WIN_KEY="$HOME/.ssh/id_ed25519_win10"
export WIN_CANDIDATES="192.168.1.86"
export WIN_HOST="192.168.1.86"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/win-remote.sh" "$@"
