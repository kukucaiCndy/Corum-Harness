#!/usr/bin/env bash
# corum combo 快速启动（bash 包装 scripts/combos.mjs + 官方 dev.sh）。
#
# 用法：
#   ./scripts/combo.sh                  列出可用 combo
#   ./scripts/combo.sh list           列出可用 combo
#   ./scripts/combo.sh build <id>     构建指定 combo（插件 + corum-desktop）
#   ./scripts/combo.sh start <id>     构建并启动指定 combo（复用官方 dev.sh，含
#                                     CORUM_HOME=.corum-dev-home + HMR + 输入法 patch）
#   ./scripts/combo.sh <id>           等价 start <id>（省略子命令）
#   ./scripts/combo.sh start <id> --no-build   跳过构建直接启动
#
# 例：
#   ./scripts/combo.sh dev-agent      等价 scripts/dev-agent.sh restart（清残留+直编+PID 记录+启动）
#   ./scripts/combo.sh coding         等价 scripts/dev-ide.sh restart（IDE/coding 同款维护脚本）
set -euo pipefail

# 脚本所在目录 → 仓库根（scripts/ 的上一级），保证任意 cwd 可调。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
DEV_SH="$ROOT/packages/desktop/scripts/dev.sh"
cd "$ROOT"

CMD="${1:-list}"

case "$CMD" in
  list)
    exec node "$SCRIPT_DIR/combos.mjs" list
    ;;
  build)
    exec node "$SCRIPT_DIR/combos.mjs" build "${2:?缺少 combo id}"
    ;;
  start)
    ID="${2:?缺少 combo id}"
    shift 2
    # dev-agent / coding(IDE) 走带 PID 记录/自动清理/直编 .bin 的维护脚本。
    if [[ "$ID" == "dev-agent" ]]; then
      if [[ " $* " == *" --no-build "* ]]; then
        exec "$SCRIPT_DIR/dev-agent.sh" start
      else
        exec "$SCRIPT_DIR/dev-agent.sh" restart
      fi
    fi
    if [[ "$ID" == "coding" ]]; then
      if [[ " $* " == *" --no-build "* ]]; then
        exec "$SCRIPT_DIR/dev-ide.sh" start
      else
        exec "$SCRIPT_DIR/dev-ide.sh" restart
      fi
    fi
    # --no-build 之外的参数透传；默认先构建。
    if [[ " $* " != *" --no-build "* ]]; then
      node "$SCRIPT_DIR/combos.mjs" build "$ID"
    fi
    # 复用官方 dev.sh（设 CORUM_HOME / HMR / 输入法 patch），直接进指定 combo。
    exec bash "$DEV_SH" "--combo=$ID"
    ;;
  -h|--help|help)
    sed -n '2,16p' "${BASH_SOURCE[0]}"
    ;;
  *)
    # 首参数不是子命令：当作 combo id，等价 start <id>。
    ID="$CMD"
    shift || true
    if [[ "$ID" == "dev-agent" ]]; then
      if [[ " $* " == *" --no-build "* ]]; then
        exec "$SCRIPT_DIR/dev-agent.sh" start
      else
        exec "$SCRIPT_DIR/dev-agent.sh" restart
      fi
    fi
    if [[ "$ID" == "coding" ]]; then
      if [[ " $* " == *" --no-build "* ]]; then
        exec "$SCRIPT_DIR/dev-ide.sh" start
      else
        exec "$SCRIPT_DIR/dev-ide.sh" restart
      fi
    fi
    if [[ " $* " != *" --no-build "* ]]; then
      node "$SCRIPT_DIR/combos.mjs" build "$ID"
    fi
    exec bash "$DEV_SH" "--combo=$ID"
    ;;
esac
