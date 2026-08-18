#!/usr/bin/env bash
# corum-shell dev launcher: stable dev home + HMR enabled. Session history,
# settings, and profiles persist under .corum-dev-home across restarts, so the
# agent can hot-reload UI (zero refresh) or hot-restart the host (recoverable
# session) without losing context.
set -euo pipefail
cd "$(dirname "$0")/.."
# 让 macOS 记住中文输入法（patch vendored Electron.app 的 Info.plist 加中文
# localization；幂等，重装/升级 Electron 后自动重 patch）。
node scripts/patch-electron-locales.mjs || true
export CORUM_HOME="${CORUM_HOME:-$PWD/.corum-dev-home}"
export CORUM_DEV_HMR="${CORUM_DEV_HMR:-500}"
exec node lib/cli.js "$@"
