#!/usr/bin/env bash
# corum-shell dev launcher: stable dev home + HMR enabled. Session history,
# settings, and profiles persist under .corum-dev-home across restarts, so the
# agent can hot-reload UI (zero refresh) or hot-restart the host (recoverable
# session) without losing context.
set -euo pipefail
cd "$(dirname "$0")/.."
export CORUM_HOME="${CORUM_HOME:-$PWD/.corum-dev-home}"
export CORUM_DEV_HMR="${CORUM_DEV_HMR:-500}"
exec node lib/cli.js "$@"
