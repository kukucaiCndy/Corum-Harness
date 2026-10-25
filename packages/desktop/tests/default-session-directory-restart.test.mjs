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
import { acquireDefaultSessionDirectoryGuard } from '../lib/types/host/default-session-directory-lock.js'
import { fileURLToPath } from 'node:url'

test('Cordis 吞掉的 disposer 错误仍必须使迁移正常停机失败', async () => {
  const ctx = new Context()
  ctx.effect(() => () => { throw new Error('teardown failed') })
  await assert.rejects(gateModule.stopDefaultSessionDirectoryHost(ctx), /teardown failed/)
})

test('迁移要求 strict flush，单个 session 保存失败也拒绝 ACK', async () => {
  const archive = { sessions: { list: () => [{ id: 'broken' }], flush: async () => { throw new Error('disk full') } }, ctx: { logger: { warn() {} } } }
  await assert.rejects(CorumSessionArchive.prototype.flushAll.call(archive, true), /disk full/)
})

test('teardown 前 flush 拒绝时保留真实 Service；disposer 拒绝时保持 gate 关闭', async () => {
  const ctx = new Context()
  ctx.provide('probeService', { ping: () => 'available' })
  let released = 0
  const gate = { assertQuiet() {}, release() { released++ } }
  const before = await gateModule.shutdownDefaultSessionDirectoryHost(ctx, gate, async () => { throw new Error('flush failed') })
  assert.equal(before.teardown, false)
  assert.equal(released, 1)
  assert.equal(ctx.get('probeService').ping(), 'available')
  ctx.effect(() => () => { throw new Error('disposer failed') })
  const after = await gateModule.shutdownDefaultSessionDirectoryHost(ctx, gate, async () => {})
  assert.equal(after.teardown, true)
  assert.equal(after.ok, false)
  assert.equal(released, 1)
  assert.equal(ctx.get('probeService'), undefined)
})

async function fixture(t, mode = 'ok', readyTimeoutMs = 60_000) {
  const home = await mkdtemp(join(tmpdir(), 'corum-migrate-restart-'))
  const entry = join(home, 'host.mjs')
  await writeFile(entry, `
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { Context, Service } from ${JSON.stringify(import.meta.resolve('@deepseek-ai/cordis'))}
import { DefaultSessionDirectoryGate, shutdownDefaultSessionDirectoryHost } from ${JSON.stringify(new URL('../lib/types/host/default-session-directory-gate.js', import.meta.url).href)}
if (process.env.CORUM_DEFAULT_SESSION_DIRECTORY_RECOVERY) {
  const request = JSON.parse(process.env.CORUM_DEFAULT_SESSION_DIRECTORY_RECOVERY)
  const { recoverDefaultSessionDirectoryAfterExit } = await import(${JSON.stringify(new URL('../lib/types/host/default-session-directory-recovery.js', import.meta.url).href)})
  try { await recoverDefaultSessionDirectoryAfterExit(process.env.CORUM_HOME, request.error, request.migrationId) }
  catch (error) { console.log(JSON.stringify({ type: 'error', message: String(error) })); process.exit(1) }
}
const log = path.join(process.env.CORUM_HOME, 'events')
fs.appendFileSync(log, 'spawn\\n')
const generation = fs.readFileSync(log, 'utf8').split('spawn').length - 1
if (process.env.TEST_MODE === 'startup-fail' && generation > 1) process.exit(7)
const ctx = new Context()
const gate = new DefaultSessionDirectoryGate(ctx)
class Probe extends Service { constructor(ctx) { super(ctx, 'probeService') } ping() { return 'available' } }
new Probe(ctx)
if (generation === 1 && process.env.TEST_MODE === 'disposer-fail') ctx.effect(() => () => { throw new Error('disposer failed') })
if (generation === 1 && process.env.TEST_MODE === 'shutdown-slow') ctx.effect(() => async () => { await new Promise(done => setTimeout(done, 350)) })
const journal = path.join(process.env.CORUM_HOME, 'default-session-directory-migration.json')
const manifest = path.join(process.env.CORUM_HOME, 'default-session-directories.json')
if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ version: 1, root: path.join(process.env.CORUM_HOME, 'old'), sessions: {} }))
if (process.env.TEST_MODE === 'cold-slow' && generation === 1) fs.writeFileSync(journal, JSON.stringify({ id: 'cold', destination: path.join(process.env.CORUM_HOME, 'new') }))
if (fs.existsSync(journal)) {
  console.log(JSON.stringify({ type: 'default-directory-migration', active: true }))
  const pending = JSON.parse(fs.readFileSync(journal, 'utf8'))
  fs.appendFileSync(log, 'migration-started\\n')
  if (['boot-slow', 'cold-slow', 'boot-fail', 'business-stuck'].includes(process.env.TEST_MODE)) await new Promise(done => setTimeout(done, 1500))
  if (process.env.TEST_MODE === 'boot-fail') fs.writeFileSync(path.join(process.env.CORUM_HOME, 'default-session-directory-result.json'), JSON.stringify({ error: 'copy failed; old root restored' }))
  else fs.writeFileSync(manifest, JSON.stringify({ version: 1, root: pending.destination, sessions: {} }))
  fs.unlinkSync(journal)
}
console.log(JSON.stringify({ type: 'default-directory-migration', active: false }))
if (process.env.TEST_MODE === 'business-stuck' && generation > 1 || process.env.TEST_MODE === 'ordinary-stuck') await new Promise(() => { setInterval(() => {}, 1000) })
console.log(JSON.stringify({ type: 'ready', authenticatedUrl: 'http://localhost/' + process.pid }))
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  fs.appendFileSync(log, request.type + '\\n')
  if (process.env.TEST_MODE === 'op-stuck' && request.type === 'session-export') continue
  if (request.type === 'probe-service') {
    console.log(JSON.stringify({ type: 'session-op-result', id: request.id, ok: ctx.get('probeService')?.ping() === 'available' })); continue
  }
  if (request.type === 'default-directory-prepare') {
    await gate.prepare()
    fs.appendFileSync(log, 'gate-closed\\n')
    if (process.env.TEST_MODE.startsWith('prepare-slow')) await new Promise(done => setTimeout(done, 220))
  }
  const ok = !(['flush-fail', 'prepare-slow-fail'].includes(process.env.TEST_MODE) && request.type === 'default-directory-prepare')
  if (!ok) gate.release()
  if (request.type === 'default-directory-prepare' && ok) fs.writeFileSync(journal, JSON.stringify({ id: 'migration-' + generation, phase: 'requested', destination: request.path, sessionIds: [], moves: [], completed: 0 }))
  if (request.type === 'default-directory-cancel' && fs.existsSync(journal)) fs.unlinkSync(journal)
  let result = { ok, migrationId: ok && request.type === 'default-directory-prepare' ? 'migration-' + generation : undefined, error: ok ? undefined : 'flush failed' }
  if (request.type === 'default-directory-shutdown') {
    result = await shutdownDefaultSessionDirectoryHost(ctx, { assertQuiet() {}, release() {} }, async () => {})
    fs.appendFileSync(log, 'serviceAfterTeardown=' + !!ctx.get('probeService') + '\\n')
    if (result.ok || result.teardown) {
      fs.appendFileSync(log, 'exit\\n')
      await new Promise(done => process.stdout.write(JSON.stringify({ type: 'session-op-result', id: request.id, ...result }) + '\\n', done))
      process.exit(0)
    }
  }
  console.log(JSON.stringify({ type: 'session-op-result', id: request.id, ...result }))
}`)
  const bridge = new HostBridgeClient(process.execPath, entry, { ...process.env, CORUM_HOME: home, TEST_MODE: mode }, undefined, readyTimeoutMs)
  t.after(async () => { bridge.dispose(); await new Promise(done => setTimeout(done, 50)); await rm(home, { recursive: true, force: true }) })
  if (mode !== 'ordinary-stuck') await bridge.ready()
  return { bridge, home, log: () => readFile(join(home, 'events'), 'utf8') }
}

test('迁移 restart 等待 flush ACK、旧 child exit，才启动并等待新一代 ready', async t => {
  const f = await fixture(t)
  const first = f.bridge.readyPayload.authenticatedUrl
  const next = await f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new'))
  assert.notEqual(next.authenticatedUrl, first)
  assert.match(await f.log(), /spawn\ndefault-directory-prepare\ngate-closed\ndefault-directory-shutdown\nserviceAfterTeardown=false\nexit\nspawn\nmigration-started\n/)
  assert.equal(f.bridge.home, f.home)
})

for (const mode of ['prepare-slow', 'prepare-slow-fail']) test(`${mode} 超过普通 op 预算仍保留互斥与迟到 ACK 责任`, async t => {
  const f = await fixture(t, mode)
  const foreignPath = join(f.home, 'default-session-directory-migration.json')
  const foreign = JSON.stringify({ id: 'foreign', phase: 'requested', moves: [], sessionIds: [] })
  if (mode.endsWith('fail')) await writeFile(foreignPath, foreign)
  const setTimer = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => setTimer(fn, ms === 30_000 ? 40 : ms, ...args)
  try {
    const result = f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new')).then(value => ({ value }), error => ({ error }))
    await new Promise(done => setTimer(done, 100))
    await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'other')), /正在迁移/)
    const outcome = await result
    if (mode.endsWith('fail')) {
      assert.match(String(outcome.error), /flush failed/)
      assert.equal(await readFile(foreignPath, 'utf8'), foreign)
      assert.equal((await f.bridge.sessionOp({ type: 'probe-service' })).ok, true)
      // 失败必须释放真实 gate，第二次 prepare 能进入，而非“正在迁移”。
      await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new')), /flush failed/)
    } else {
      assert.equal(outcome.error, undefined)
      assert.equal((await getDefaultSessionDirectoryStatus(f.home)).root, join(f.home, 'new'))
    }
  } finally { globalThis.setTimeout = setTimer }
})

for (const mode of ['boot-slow', 'cold-slow', 'boot-fail']) test(`${mode} 迁移启动不受普通 ready 预算中断`, async t => {
  const f = await fixture(t, mode, 700)
  if (mode !== 'cold-slow') await f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new'))
  const status = await getDefaultSessionDirectoryStatus(f.home)
  assert.equal(status.root, join(f.home, mode === 'boot-fail' ? 'old' : 'new'))
  if (mode === 'boot-fail') assert.match(status.error, /copy failed/)
  assert.equal((await f.bridge.sessionOp({ type: 'probe-service' })).ok, true)
})

test('普通启动无迁移仍超时；迁移完成后业务启动卡死重新受 ready 预算约束', async t => {
  const ordinary = await fixture(t, 'ordinary-stuck', 700)
  await assert.rejects(ordinary.bridge.ready(), /启动超时/)
  const f = await fixture(t, 'business-stuck', 700)
  await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new')), /启动超时/)
  assert.match((await getDefaultSessionDirectoryStatus(f.home)).error, /启动超时/)
})

test('普通 session export 无回复仍使用有界 op timeout', async t => {
  const f = await fixture(t, 'op-stuck')
  const setTimer = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => setTimer(fn, ms === 30_000 ? 40 : ms, ...args)
  try { assert.deepEqual(await f.bridge.sessionExport('s'), { ok: false, error: 'session op timed out' }) }
  finally { globalThis.setTimeout = setTimer }
})

test('flush 拒绝时没有停机或新 child', async t => {
  const f = await fixture(t, 'flush-fail')
  await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new')), /flush failed/)
  assert.equal((await f.log()).match(/spawn/g).length, 1)
  assert.doesNotMatch(await f.log(), /shutdown/)
})

test('prepare 未取得本次 ID 时不能取消其它 requested journal', async t => {
  const f = await fixture(t, 'flush-fail')
  const path = join(f.home, 'default-session-directory-migration.json')
  const foreign = JSON.stringify({ id: 'foreign', phase: 'requested', sessionIds: [], moves: [] })
  await writeFile(path, foreign)
  await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new')), /flush failed/)
  assert.equal(await readFile(path, 'utf8'), foreign)
  assert.doesNotMatch(await f.log(), /default-directory-cancel/)
})

for (const mode of ['shutdown-slow', 'disposer-fail']) test(`${mode} 串行 teardown 失败后等待旧 exit，恢复旧位置和真实 Service，再允许重试`, async t => {
  const f = await fixture(t, mode)
  const first = f.bridge.readyPayload.authenticatedUrl
  const migrating = f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new'), 70)
  if (mode === 'shutdown-slow') {
    const pending = await Promise.race([migrating.then(() => false), new Promise(done => setTimeout(() => done(true), 150))])
    assert.equal(pending, true)
    assert.equal((await f.log()).match(/spawn/g).length, 1)
    await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'other')), /正在迁移/)
    assert.match((await getDefaultSessionDirectoryStatus(f.home)).error, /超时|退出/)
  }
  const restored = await migrating
  assert.notEqual(restored.authenticatedUrl, first)
  assert.equal((await f.log()).match(/spawn/g).length, 2)
  assert.doesNotMatch(await f.log(), /migration-started|default-directory-cancel/)
  assert.match(await f.log(), /serviceAfterTeardown=false\nexit\nspawn\n/)
  const status = await getDefaultSessionDirectoryStatus(f.home)
  assert.equal(status.root, join(f.home, 'old'))
  assert.match(status.error, mode === 'shutdown-slow' ? /超时|timeout|退出/ : /disposer failed/)
  assert.equal(status.migration, null)
  assert.equal((await f.bridge.sessionOp({ type: 'probe-service' })).ok, true)
  const retried = await f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new'))
  assert.notEqual(retried.authenticatedUrl, restored.authenticatedUrl)
  assert.equal((await getDefaultSessionDirectoryStatus(f.home)).root, join(f.home, 'new'))
})

test('新 Host 启动失败及时返回，持久错误仍能离线读取', async t => {
  const f = await fixture(t, 'startup-fail')
  await assert.rejects(f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new')), /code 7/)
  const offline = await getDefaultSessionDirectoryStatus(f.home)
  assert.match(offline.error, /code 7/)
  assert.equal(offline.root, join(f.home, 'old'))
})

test('旧 child exit 后恢复 guard busy 时不删除 requested，也不启动正常业务 Host', async t => {
  const f = await fixture(t, 'shutdown-slow')
  const migrating = f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new'), 70)
  await new Promise(done => setTimeout(done, 150))
  const release = await acquireDefaultSessionDirectoryGuard(f.home)
  const path = join(f.home, 'default-session-directory-migration.json')
  const pending = await readFile(path, 'utf8')
  try {
    await assert.rejects(migrating, /另一进程/)
    assert.equal(await readFile(path, 'utf8'), pending)
    assert.equal((await f.log()).match(/spawn/g).length, 1)
    assert.doesNotMatch(await f.log(), /migration-started/)
  } finally { await release() }
})

test('旧 child exit 前迁移 ID 改变，恢复不能取消新请求或报告业务 ready', async t => {
  const f = await fixture(t, 'shutdown-slow')
  const migrating = f.bridge.migrateDefaultSessionDirectory(join(f.home, 'new'), 70)
  await new Promise(done => setTimeout(done, 150))
  const release = await acquireDefaultSessionDirectoryGuard(f.home)
  const path = join(f.home, 'default-session-directory-migration.json')
  try {
    const pending = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...pending, id: 'replacement-migration' }))
  } finally { await release() }
  await assert.rejects(migrating, /迁移标识 ID 已改变/)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).id, 'replacement-migration')
  assert.equal(f.bridge.readyPayload, undefined)
  assert.equal((await f.log()).match(/spawn/g).length, 1)
})

test('真实 Host bridge 的恢复 env 在 boot 前处理，guard busy 不报 ready', async t => {
  const home = await mkdtemp(join(tmpdir(), 'corum-real-recovery-'))
  const path = join(home, 'default-session-directory-migration.json')
  const pending = JSON.stringify({ id: 'expected', phase: 'requested' })
  await writeFile(path, pending)
  const release = await acquireDefaultSessionDirectoryGuard(home)
  const bridge = new HostBridgeClient(process.execPath, fileURLToPath(new URL('../lib/types/host/bridge.js', import.meta.url)), {
    ...process.env, CORUM_HOME: home,
    CORUM_DEFAULT_SESSION_DIRECTORY_RECOVERY: JSON.stringify({ migrationId: 'expected', error: 'retry recovery' }),
  })
  let protocol = ''
  bridge.child.stdout.on('data', data => { protocol += data })
  t.after(async () => { bridge.dispose(); await new Promise(done => setTimeout(done, 50)); await release(); await rm(home, { recursive: true, force: true }) })
  await assert.rejects(bridge.ready(), /另一进程/)
  assert.equal(bridge.readyPayload, undefined)
  assert.equal(await readFile(path, 'utf8'), pending)
  assert.match(protocol, /"type":"default-directory-migration","active":true/)
})
