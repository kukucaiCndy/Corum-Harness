/**
 * corum-shell CLI launcher: spawns Electron with the built main entry. The
 * `electron` package's runtime export is the binary path (its types are the
 * Electron API namespace), so the path is read through createRequire. The
 * shebang is added by the tsdown banner at build time.
 * @module corum-shell/electron/cli
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as unknown as string
const main = fileURLToPath(new URL('./main.js', import.meta.url))

/**
 * 纯壳净化：不把 dsh 运行态环境透传给 Electron 主进程。DSH_HOME /
 * CORUM_DESKTOP_* / CORUM_COMBO_* / DSH_* 是 dsh 侧内容，由壳按所选 combo
 * 在 spawn host 子进程时注入（main.ts buildHostEnv + boot.ts 消费），壳自身
 * 不携带。CORUM_HOME 是壳的 home 配置（会话/设置目录），保留供 dev 隔离。
 */
const DSHSANITIZE = [
  'DSH_HOME',
  'DSH_CHECKOUT',
  'DSH_TELEMETRY_DISABLED',
  'CORUM_DESKTOP_MODE',
  'CORUM_DESKTOP_PROFILE',
  'CORUM_COMBO_PLUGINS',
  'CORUM_COMBO_PATCHES',
]

// The Electron main only hosts the combo-manager shell; it spawns the host
// bridge child under SYSTEM Node (this process's own binary) and relays IPC
// to it. Pass the node path down so the main never has to guess one.
const env: NodeJS.ProcessEnv = { ...process.env, CORUM_HOST_NODE: process.execPath }
for (const key of DSHSANITIZE) delete env[key]

const child = spawn(electronPath, [main, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
