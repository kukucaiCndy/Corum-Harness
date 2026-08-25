#!/usr/bin/env bash
# dev-agent combo 一键维护脚本：清残留 → 全量直编（.bin，不走 pnpm run）→ 记录 PID → 启动。
#
# 用法：
#   ./scripts/dev-agent.sh             # 默认 restart：清理旧实例 + 全编译 + 启动
#   ./scripts/dev-agent.sh restart     # 同上
#   ./scripts/dev-agent.sh build       # 只全编译
#   ./scripts/dev-agent.sh start       # 清理旧实例 + 启动（不编译；--no-build 等价）
#   ./scripts/dev-agent.sh stop        # 只清理旧实例（PID 记录 + 兜底模式）
#
# 环境覆盖：
#   CORUM_HOME         默认 packages/desktop/.corum-dev-home
#   CORUM_DEBUG_PORT   默认 9222（CDP）
#   CORUM_DEV_HMR      默认 500（dev.sh 内默认）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
DESKTOP="$ROOT/packages/desktop"
COMBO_ID="dev-agent"
export CORUM_HOME="${CORUM_HOME:-$DESKTOP/.corum-dev-home}"
export CORUM_DEBUG_PORT="${CORUM_DEBUG_PORT:-9222}"
RUN_DIR="$CORUM_HOME/run"
PID_FILE="$RUN_DIR/$COMBO_ID.pid"
CMD="${1:-restart}"
if [[ "${1:-}" == "--no-build" ]]; then CMD="start"; fi

mkdir -p "$RUN_DIR"

log() { printf '[dev-agent] %s\n' "$*"; }

# 递归杀进程树（macOS pgrep -P；先子后父）。
kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" || true
  done
  kill "$pid" 2>/dev/null || true
}

# 清理上一次实例：优先 PID 记录（校验命令仍属本仓库 desktop，防 PID 复用误杀），
# 再兜底清本仓库 desktop 的 cli/main/bridge 残留（防孤儿 bridge 双派，见 docs/TODO.md）。
cleanup() {
  local killed=0
  if [[ -f "$PID_FILE" ]]; then
    local pid cmdline
    pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PID_FILE" | head -1)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if [[ "$cmdline" == *"$ROOT/packages/desktop/lib/"* || "$cmdline" == *"lib/cli.js --combo=$COMBO_ID"* || "$cmdline" == *"packages/desktop/scripts/dev.sh"* ]]; then
        log "清理 PID 记录实例：${pid}"
        kill_tree "$pid" || true
        killed=1
      else
        log "PID ${pid} 已被复用（${cmdline}），不杀，仅移除记录"
      fi
    fi
    rm -f "$PID_FILE"
  fi

  # 兜底：只杀命令行含本仓库 packages/desktop/lib 或本 combo 相对 cli 的进程。
  local pids pid
  pids="$( { pgrep -f "$ROOT/packages/desktop/lib" 2>/dev/null || true; pgrep -f "node lib/cli.js --combo=$COMBO_ID" 2>/dev/null || true; } | sort -u )"
  if [[ -n "$pids" ]]; then
    log "兜底清理本仓库 desktop 残留进程：$(echo "$pids" | tr '\n' ' ')"
    for pid in $pids; do kill "$pid" 2>/dev/null || true; done
    sleep 1
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
    done
    killed=1
  fi
  if [[ "$killed" == "1" ]]; then sleep 1; fi
}

run_step() {
  log "$*"
  ( cd "$1" && shift && "$@" )
}

build_all() {
  # 直调各包 .bin，避开 pnpm run 的 verify-deps 自动 install（见 docs/TODO.md 工程约束）。
  run_step "$ROOT/packages/plugins/agent/corum-agent-dev" ./node_modules/.bin/tsc -b --pretty false
  run_step "$ROOT/packages/plugins/agent/corum-agent-dev" ./node_modules/.bin/tsdown

  run_step "$ROOT/packages/plugins/agent/corum-skill-manager-dev" ./node_modules/.bin/tsc -b --pretty false
  run_step "$ROOT/packages/plugins/agent/corum-skill-manager-dev" ./node_modules/.bin/tsdown

  run_step "$ROOT/packages/plugins/agent/corum-mcp-manager-dev" ./node_modules/.bin/tsc -b --pretty false
  run_step "$ROOT/packages/plugins/agent/corum-mcp-manager-dev" ./node_modules/.bin/tsdown

  run_step "$ROOT/packages/plugins/ui/corum-agent-ui-dev" ./node_modules/.bin/tsc -b --pretty false
  run_step "$ROOT/packages/plugins/ui/corum-agent-ui-dev" ./node_modules/.bin/tsdown
  run_step "$ROOT/packages/plugins/ui/corum-agent-ui-dev" node scripts/inline-css.mjs

  run_step "$DESKTOP" ./node_modules/.bin/tsc -b tsconfig.host.json --pretty false
  run_step "$DESKTOP" ./node_modules/.bin/tsc -b tsconfig.client.json --pretty false
  run_step "$DESKTOP" ./node_modules/.bin/tsdown --config tsdown.config.ts
  run_step "$DESKTOP" node scripts/inline-monaco-css.mjs
}

write_pid() {
  # exec 后脚本进程即被 dev.sh/node 替换，$$ 就是最终 cli 进程 PID。
  printf '{"pid":%s,"combo":"%s","home":"%s","debugPort":%s,"startedAt":%s,"command":"%s"}\n' \
    "$$" "$COMBO_ID" "$CORUM_HOME" "$CORUM_DEBUG_PORT" "$(date +%s)" "$ROOT/packages/desktop/scripts/dev.sh --combo=$COMBO_ID" \
    > "$PID_FILE"
  log "PID 记录 → $PID_FILE"
}

case "$CMD" in
  stop)
    cleanup
    ;;
  build)
    build_all
    ;;
  start)
    cleanup
    write_pid
    exec bash "$DESKTOP/scripts/dev.sh" "--combo=$COMBO_ID"
    ;;
  restart)
    cleanup
    build_all
    write_pid
    exec bash "$DESKTOP/scripts/dev.sh" "--combo=$COMBO_ID"
    ;;
  -h|--help|help)
    sed -n '2,22p' "${BASH_SOURCE[0]}"
    ;;
  *)
    echo "未知命令: $CMD（支持 restart/build/start/stop）" >&2
    exit 2
    ;;
esac
