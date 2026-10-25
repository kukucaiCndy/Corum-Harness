import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostBridgeClient } from '../lib/types/electron/bridge-client.js'
import { CorumSessionArchive } from '../lib/types/host/session-archive.js'
import { Context } from '@deepseek-ai/cordis'
import * as gateModule from '../lib/types/host/default-session-directory-gate.js'
import { getDefaultSessionDirectoryStatus } from '../lib/types/host/default-session-directory-status.js'

test('Cordis 吞掉的 disposer 错误仍必须使迁移正常停机失败', async () => {
  const ctx = new Context()
  ctx.effect(() => () => { throw new Error('teardown failed') })
  await assert.rejects(gateModule.stopDefaultSessionDirectoryHost(ctx), /teardown failed/)
})

test('迁移要求 strict flush，单个 session 保存失败也拒绝 ACK', async () => {
  const archive = { sessions: { list: () => [{ id: 'broken' }], flush: async () => { throw new Error('disk full') } }, ctx: { logger: { warn() {} } } }
  await assert.rejects(CorumSessionArchive.prototype.flushAll.call(archive, true), /disk full/)
})

async function fixture(t, mode = 'ok') {
  const home = await mkdtemp(join(tmpdir(), 'corum-migrate-restart-'))
  const entry = join(home, 'host.cjs')
  await writeFile(entry, `
const fs = require('node:fs'), path = require('node:path')
const log = path.join(process.env.CORUM_HOME, 'events')
fs.appendFileSync(log, 'spawn\\n')
if (process.env.TEST_MODE === 'startup-fail' && fs.readFileSync(log, 'utf8').split('spawn').length > 2) process.exit(7)
console.log(JSON.stringify({ type: 'ready', authenticatedUrl: 'http://localhost/' + process.pid }))
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  fs.appendFileSync(log, request.type + '\\n')
  const ok = !(process.env.TEST_MODE === 'flush-fail' && request.type === 'default-directory-prepare')
  console.log(JSON.stringify({ type: 'session-op-result', id: request.id, ok, error: ok ? undefined : 'flush failed' }))
  if (request.type === 'default-directory-shutdown' && process.env.TEST_MODE !== 'shutdown-hang') {
    fs.appendFileSync(log, 'exit\\n'); process.exit(0)
  }
})`)
  const bridge = new HostBridgeClient(process.execPath, entry, { ...process.env, CORUM_HOME: home, TEST_MODE: mode })
  await bridge.ready()
  t.after(async () => { bridge.dispose(); await new Promise(done => setTimeout(done, 50)); await rm(home, { recursive: true, force: true }) })
  return { bridge, home, log: () => readFile(join(home, 'events'), 'utf8') }
}

test('迁移 restart 等待 flush ACK、旧 child exit，才启动并等待新一代 ready', async t => {
  const f = await fixture(t)
  const first = f.bridge.readyPayload.authenticatedUrl
  const next = await f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new'))
  assert.notEqual(next.authenticatedUrl, first)
  assert.match(await f.log(), /spawn\ndefault-directory-prepare\ndefault-directory-shutdown\nexit\nspawn\n/)
  assert.equal(f.bridge.home, f.home)
})

test('flush 拒绝时没有停机或新 child', async t => {
  const f = await fixture(t, 'flush-fail')
  await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new')), /flush failed/)
  assert.equal((await f.log()).match(/spawn/g).length, 1)
  assert.doesNotMatch(await f.log(), /shutdown/)
})

test('停机超时拒绝下一代且尝试释放门禁，可重试', async t => {
  const f = await fixture(t, 'shutdown-hang')
  await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new'), 100), /退出|停机|timeout/)
  assert.equal((await f.log()).match(/spawn/g).length, 1)
  assert.match(await f.log(), /default-directory-cancel/)
})

test('新 Host 启动失败及时返回，持久错误仍能离线读取', async t => {
  const f = await fixture(t, 'startup-fail')
  await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new')), /code 7/)
  const offline = await getDefaultSessionDirectoryStatus(f.home)
  assert.match(offline.error, /code 7/)
  assert.equal(offline.root, join(f.home, 'workspaces'))
})
