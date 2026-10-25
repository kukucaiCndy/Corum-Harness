import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as module from '../lib/types/host/default-session-directory-gate.js'
import { CorumFsService } from '../lib/types/host/corum-fs.js'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('真实 corumFs Remote exportName 映射到实现方法后仍受门禁约束', async () => {
  const ctx = new Context()
  const gate = new module.DefaultSessionDirectoryGate(ctx)
  const fs = new CorumFsService(ctx)
  await new Promise(done => setImmediate(done))
  const markers = remoteMethods(fs)
  const mapped = Object.fromEntries(markers.map(marker => [marker.exportName ?? marker.method, marker.method]))
  assert.deepEqual({ mkdir: mapped.mkdir, delete: mapped.delete, rename: mapped.rename }, { mkdir: 'mkdirp', delete: 'remove', rename: 'renamePath' })
  await gate.prepare()
  for (const name of ['write', 'mkdir', 'delete', 'rename', 'revertWrites']) {
    assert.throws(() => Reflect.apply(fs[mapped[name]], fs, ['blocked', 'blocked']), /迁移/, name)
  }
  await ctx.fiber.dispose()
})
test('门禁保留同步 throw / this，迁移拒绝后可继续执行', async () => {
  const gate = new module.DefaultSessionDirectoryGate(new Context())
  const target = { value: 3, send() { return this.value } }
  gate.guard(target, ['send'])
  assert.equal(target.send(), 3)
  await gate.prepare()
  assert.throws(() => target.send(), /迁移/)
  gate.release()
  assert.equal(target.send(), 3)
})
test('create/resume 未发布或异步文件写入未完成时拒绝并释放门禁', async () => {
  const gate = new module.DefaultSessionDirectoryGate(new Context())
  const pending = deferred()
  const target = { create() { return pending.promise } }
  gate.guard(target, ['create'])
  const operation = target.create()
  await assert.rejects(gate.prepare(), /操作|执行/)
  pending.resolve()
  await operation
  await gate.prepare()
  assert.throws(() => target.create(), /迁移/)
})
test('maintenance 虽显示 idle，迁移仍必须拒绝', async () => {
  const ctx = new Context()
  const gate = new module.DefaultSessionDirectoryGate(ctx)
  const pending = deferred()
  const agent = { status: 'idle', send() {}, runMaintenance() { return pending.promise } }
  gate.watchAgent(agent)
  const task = agent.runMaintenance()
  await assert.rejects(gate.prepare(), /操作|执行/)
  pending.resolve(); await task
})

test('同步 Shell.start 保留原 handle，并等待后台 done 后才允许迁移', async () => {
  const gate = new module.DefaultSessionDirectoryGate(new Context())
  const pending = deferred()
  const handle = { done: pending.promise }
  const shell = { start() { return handle } }
  gate.guard(shell, ['start'])
  assert.equal(shell.start(), handle)
  await assert.rejects(gate.prepare(), /操作|执行/)
  pending.resolve()
  await pending.promise
  await gate.prepare()
  assert.throws(() => shell.start(), /迁移/)
})
