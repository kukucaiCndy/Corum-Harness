#!/usr/bin/env bash
# 启动环境守卫：**应用绝不能在 Agent 工具的文件沙箱内启动**。
#
# 为什么需要这个守卫（2026-09-11 实机定位，详见 docs/HANDOFF-2026-09-11-bug-fixes.md）：
# Agent 的 bash 工具是 seatbelt 沙箱化的（`workspace-write`：只允许写会话工作区）。
# 沙箱是**进程级**属性，会被子进程继承 —— 而 `nohup` / `disown` / 后台作业**都摆脱不了它**。
# 于是从 Agent 工具里启动的 Corum 应用，整棵进程树（Electron 主进程 + bridge host +
# 它派生的一切）都被关进了「Agent 的会话工作区」这个笼子里，症状是**功能残缺但不报错**：
#
#   1. 任何会话的 bash 工具都报 `posix_openpt failed: Operation not permitted`
#      —— 连伪终端都开不出来（`pty.openpty()` 同样失败）；
#   2. 隔离 worktree 全部建不起来：`git worktree add` 报
#      `fatal: cannot lock ref 'refs/heads/wt/...': unable to create directory for
#       .git/refs/heads/wt/...`（因为目标工作区在 Agent 的工作区之外，被拒写）；
#      即使 worktree 侥幸建出来，子 Agent 的 `git add` 也会报
#      `index.lock: Operation not permitted` —— 「子 Agent 提交 → 集成者合并」整条断裂；
#   3. 打开非本仓工作区（如 ~/work/ai-lib）的会话，一切写操作 EPERM。
#
# 这三点**全都不是产品 bug**，但看现象极像产品 bug（2026-09-11 就为此查了一轮）。
# 守卫的作用：在启动前把这件事**说清楚**，而不是让下一次会话再排查一遍。
#
# 用法（可被 dev-ide.sh / cdp.sh 直接调用，也可手工跑）：
#   bash scripts/app-launch-guard.sh [<repo-root>]
# 退出码：永远 0（本脚本只负责**告知**）。沙箱内想强行启动：
#   CORUM_ALLOW_SANDBOXED_LAUNCH=1 ./scripts/corum-instance.sh start --home=dev --allow-sandboxed
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [[ "${CORUM_ALLOW_SANDBOXED_LAUNCH:-}" == "1" ]]; then
  exit 0
fi

# 探针：在「本仓之外」建一个临时目录再删掉，结果写进全局 PROBE_RESULT。
#
# 两个坑（都实测过）：
#   · **不能用 `-w` 预筛**：seatbelt 连 `access(W_OK)` 一起过滤，沙箱内 `[[ -w <dir> ]]`
#     返回假，会让探针误判成「没有可用目录」而静默放行 —— 守卫就成了摆设。
#     一律以 `mkdir` 的真实结果作唯一事实源。
#   · **不能只探一个目录**：仓库上级目录可能本来就是只读（正常非沙箱环境也会 denied），
#     故同时探 `$HOME`；只要有一个能写就不是沙箱，避免假阳性。
#
# PROBE_RESULT：0 = 能写；1 = 被权限/沙箱拒绝；2 = 目录不存在等无关原因。
PROBE_RESULT=2
probe() {
  local dir="$1" target err
  PROBE_RESULT=2
  [[ -n "$dir" && -d "$dir" ]] || return 0
  target="$dir/.corum-launch-guard-$$"
  if err="$(mkdir -p "$target" 2>&1)"; then
    rmdir "$target" 2>/dev/null || true
    PROBE_RESULT=0
    return 0
  fi
  case "$err" in
    *"Operation not permitted"*|*"Permission denied"*|*"Read-only file system"*) PROBE_RESULT=1 ;;
    *) PROBE_RESULT=2 ;;
  esac
  return 0
}

probe "$(dirname "$ROOT")"
parent_result="$PROBE_RESULT"
probe "${HOME:-}"
home_result="$PROBE_RESULT"

# 有一个能写 → 不在沙箱里，放行。
if [[ "$parent_result" == "0" || "$home_result" == "0" ]]; then
  exit 0
fi
# 两个都不能写、且至少有一个是「权限类拒绝」→ 判定为沙箱，告警。
if [[ "$parent_result" != "1" && "$home_result" != "1" ]]; then
  exit 0
fi

cat >&2 <<'EOF'

================================================================================
⚠️  启动环境守卫：当前处于 Agent 工具的文件沙箱内！
================================================================================
在本沙箱里启动的 Corum 应用会被「关进 Agent 的工作区」，功能残缺但不报错：

  · 任何会话的 bash 工具都失败：posix_openpt failed: Operation not permitted
  · 隔离 worktree 全部建不起来：git worktree add 报
    cannot lock ref 'refs/heads/wt/...': unable to create directory
    （子 Agent 的 git add 也会 index.lock: Operation not permitted）
  · 打开本仓之外的工作区会话，所有写操作 EPERM

这不是产品 bug，是**启动方式**的问题。请改由以下任一方式启动：

  · 用户在自己的终端 / Finder 里启动（推荐）
  · 或把 Agent 会话的文件策略放宽到 danger-full-access 后再启动

确知后果、仍要在沙箱内启动：
  CORUM_ALLOW_SANDBOXED_LAUNCH=1 ./scripts/corum-instance.sh start --home=dev --allow-sandboxed
================================================================================

EOF
exit 0
