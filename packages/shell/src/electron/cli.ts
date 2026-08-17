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

// The Electron main only hosts the UI shell; it spawns the host bridge child
// under SYSTEM Node (this process's own binary) and relays IPC to it. Pass
// the node path down so the main never has to guess one.
const child = spawn(electronPath, [main, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CORUM_HOST_NODE: process.execPath,
  },
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
