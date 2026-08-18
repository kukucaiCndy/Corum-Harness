import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const child = spawn(process.execPath, ['lib/bridge.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CORUM_HOME: resolve('packages/shell/.corum-dev-home') },
})

let buf = ''
const presets = ['standard', 'code', 'minimal', 'cordum', 'designer']
let idx = 0

child.stderr.on('data', d => process.stderr.write(d))

child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    try {
      const msg = JSON.parse(line)
      if (msg.type === 'ready') {
        console.log('[ready] host booted, entries:', msg.graph.entries.length)
        sendNext()
      }
      if (msg.type === 'result' && msg.id?.startsWith('test-')) {
        const presetIdx = Number(msg.id.split('-')[1])
        const preset = presets[presetIdx]
        const body = msg.body ? JSON.parse(msg.body) : null
        if (msg.status === 200 && body?.result?.ok) {
          console.log(`[ok] preset=${preset} sessionId=${body.result.value.sessionId}`)
        } else {
          console.log(`[FAIL] preset=${preset} status=${msg.status}`, JSON.stringify(body?.result || body)?.slice(0, 300))
        }
        idx++
        if (idx < presets.length) {
          sendNext()
        } else {
          console.log('[done] all presets tested')
          child.kill()
          process.exit(0)
        }
      }
    } catch {}
  }
})

function sendNext() {
  const preset = presets[idx]
  const rpcId = `rpc-${idx}-${Date.now()}`
  const envelope = {
    type: 'client-request',
    rpcId,
    method: 'session.create',
    payload: { agentPreset: preset },
  }
  const body = JSON.stringify(envelope)
  const req = { type: 'unary', id: `test-${idx}`, pathname: '/api/session.create', body }
  console.log(`[send] session.create agentPreset=${preset}`)
  child.stdin.write(JSON.stringify(req) + '\n')
}
