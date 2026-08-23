#!/usr/bin/env bash
# corum-desktop 唯一 dev launcher：稳定 dev home + HMR。会话/设置/profile 持久在
# .corum-dev-home（CORUM_HOME 可覆盖），跨重启保留上下文。
#
# 用法（参数透传给 lib/cli.js）：
#   bash scripts/dev.sh               # 默认：纯壳 combo 启动器页（IDE 等 combo 从启动器进入）
#   bash scripts/dev.sh --combo=coding  # 直接进指定 combo（如 IDE = coding）
#   bash scripts/dev.sh --smoke         # 无头握手验证
# 环境覆盖：CORUM_HOME（隔离 home）、CORUM_DEBUG_PORT（CDP 端口）等。
set -euo pipefail
cd "$(dirname "$0")/.."
# 让 macOS 记住中文输入法（patch vendored Electron.app 的 Info.plist 加中文
# localization；幂等，重装/升级 Electron 后自动重 patch）。
node scripts/patch-electron-locales.mjs || true
export CORUM_HOME="${CORUM_HOME:-$PWD/.corum-dev-home}"
export CORUM_DEV_HMR="${CORUM_DEV_HMR:-500}"
exec node lib/cli.js "$@"
