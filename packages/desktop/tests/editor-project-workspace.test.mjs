import { test } from 'node:test'
import assert from 'node:assert/strict'

const impl = await import('../lib/types/client/editor/project-workspace.js').catch(() => ({}))

test('Windows 项目身份兼容分隔符和大小写，POSIX 保留大小写', () => {
  assert.equal(typeof impl.projectKey, 'function')
  assert.equal(impl.projectKey('E:\\Code\\A\\'), 'e:/code/a')
  assert.equal(impl.projectKey('e:/code/A'), 'e:/code/a')
  assert.notEqual(impl.projectKey('/code/A'), impl.projectKey('/code/a'))
})

test('根切换确认前不发布可操作项目，同项目不重复切换', async () => {
  assert.equal(typeof impl.createWorkspaceSource, 'function')
  let finish
  const calls = []
  const source = impl.createWorkspaceSource(root => { calls.push(root); return new Promise(r => { finish = r }) })
  source.select('E:/A')
  await Promise.resolve()
  assert.equal(source.get().status, 'loading')
  finish({ ok: true })
  await source.whenReady()
  assert.equal(source.get().root, 'E:/A')
  assert.equal(source.get().status, 'ready')
  source.select('e:\\A\\')
  assert.deepEqual(calls, ['E:/A'])
})

test('快速 A/B/A 切换串行且只发布最终根，旧请求不反向覆盖', async () => {
  assert.equal(typeof impl.createWorkspaceSource, 'function')
  const calls = []
  const finishes = []
  const source = impl.createWorkspaceSource(root => { calls.push(root); return new Promise(r => finishes.push(r)) })
  source.select('/a')
  await Promise.resolve()
  source.select('/b')
  source.select('/a')
  finishes.shift()({ ok: true })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  if (finishes.length) finishes.shift()({ ok: true })
  await source.whenReady()
  assert.equal(source.get().root, '/a')
  assert.equal(source.get().status, 'ready')
  assert.ok(!calls.includes('/b'))
})

test('RPC 返回 ok=false 仍是失败，不能在旧项目下继续操作', async () => {
  assert.equal(typeof impl.createWorkspaceSource, 'function')
  const source = impl.createWorkspaceSource(async () => ({ ok: false, error: { message: 'denied' } }))
  source.select('/private')
  await assert.rejects(source.whenReady(), /denied/)
  assert.equal(source.get().status, 'error')
  source.select(null)
  assert.equal(source.get().root, null)
  assert.equal(source.get().status, 'empty')
})
