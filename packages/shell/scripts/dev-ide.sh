#!/usr/bin/env bash
# corum-shell IDE dev launcher：与对话窗口（dev.sh 的极简实例）完全隔离的
# IDE 测试实例。隔离三件套：
#   1. 独立 CORUM_HOME（.corum-ide-home）——会话/设置/profile 不共享
#   2. 独立 user-data-dir（main.ts 按 CORUM_DEBUG_PORT 区分）——Chromium
#      profile / 锁 / 网络服务进程独立，一侧崩溃不传染另一侧
#   3. 独立 CORUM_DEBUG_PORT=9222——CDP 走查端口不与对话窗口撞
# 用法：packages/shell/scripts/dev-ide.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export CORUM_HOME="${CORUM_HOME:-$PWD/.corum-ide-home}"
export DSH_HOME="${DSH_HOME:-$CORUM_HOME}"
export CORUM_DEV_HMR="${CORUM_DEV_HMR:-500}"
export CORUM_DEBUG_PORT="${CORUM_DEBUG_PORT:-9222}"
exec node lib/cli.js --ide "$@"
