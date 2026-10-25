import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewRecoveryStore } from '../lib/types/host/corum-review-recovery.js'
import { CorumReviewService } from '../lib/types/host/corum-review.js'
import { execFileSync } from 'node:child_process'

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'corum-recovery-')))
  const workspace = join(home, 'project'); mkdirSync(workspace)
  const storePath = join(home, 'snapshots')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return { home, workspace, storePath, store: new ReviewRecoveryStore(storePath) }
}

test('Host 撤销后的文件不被并集扫描重新捕获，恢复后可以再次撤销', async t => {
  const { home, workspace, store } = fixture(t)
  const priorHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome })
  execFileSync('git', ['init', '--quiet', workspace])
  writeFileSync(join(workspace, 'edit.txt'), 'agent\n')
  // 跳过与本用例无关的服务注册；RPC 方法、并集扫描、影子仓库与文件操作均使用实际实现。
  const service = Object.create(CorumReviewService.prototype)
  Object.assign(service, {
    recovery: store, rounds: new Map(), frozen: new Map(), repos: new Map(), computeCaches: new Map(),
    sessionCwds: new Map([['session', workspace]]), sessionParents: new Map(), sessionOwners: new Set(['session']),
    warnedOnce: new Set(), ctx: { logger: { warn() {}, info() {} } },
  })
  const round = { sessionId: 'session', workspace, index: 1, startedAt: 0, touched: new Map([['edit.txt', { kind: 'content', text: 'original\n' }]]) }
  service.rounds.set('session', round)
  assert.equal((await service.rollback('session', 'edit.txt')).ok, true)
  assert.equal(await service.applyWorktreeChanges(round, round.touched), 0)
  assert.equal((await service.snapshot('session')).files.length, 0)
  const saved = (await service.recoveries('session'))[0]
  assert.equal((await service.restoreRollback('session', saved.id)).ok, true)
  const restored = await service.fileBefore('session', 'edit.txt')
  assert.equal(restored.content, 'original\n')
  assert.equal((await service.rollback('session', 'edit.txt')).ok, true)
  assert.equal(readFileSync(join(workspace, 'edit.txt'), 'utf8'), 'original\n')
  // 等待恢复触发的 journal 写入和快照扫描完成，临时目录才可清理。
  while (round.unionScanInFlight) await new Promise(resolve => setTimeout(resolve, 10))
})

test('修改、新建及删除文件撤销后，重建 store 仍能逐字节恢复', t => {
  const { workspace, store, storePath } = fixture(t)
  const edited = Buffer.from('new\r\n中文\r\n')
  writeFileSync(join(workspace, 'edit.txt'), edited)
  writeFileSync(join(workspace, 'new.txt'), 'created')
  const result = store.rollback('session-a', workspace, [
    { path: 'edit.txt', content: Buffer.from('old\r\n') },
    { path: 'new.txt', content: null },
    { path: 'deleted.txt', content: Buffer.from('original') },
  ])
  assert.equal(result.restored.length, 3)
  assert.equal(existsSync(join(workspace, 'new.txt')), false)
  assert.equal(readFileSync(join(workspace, 'edit.txt'), 'utf8'), 'old\r\n')
  const restarted = new ReviewRecoveryStore(storePath)
  assert.equal(restarted.list('session-a')[0].paths.length, 3)
  assert.equal(restarted.list('session-b').length, 0)
  const restored = restarted.restore('session-a', result.recoveryId)
  assert.equal(restored.restored.length, 3)
  assert.deepEqual(readFileSync(join(workspace, 'edit.txt')), edited)
  assert.equal(readFileSync(join(workspace, 'new.txt'), 'utf8'), 'created')
  assert.equal(existsSync(join(workspace, 'deleted.txt')), false)
  assert.equal(restarted.list('session-a').length, 0)
  writeFileSync(join(workspace, 'edit.txt'), 'later')
  assert.equal(restarted.restore('session-a', result.recoveryId).restored.length, 0)
  assert.equal(readFileSync(join(workspace, 'edit.txt'), 'utf8'), 'later')
})

test('恢复遇到后续修改只报告该文件冲突，其余成功，冲突记录保留供重试', t => {
  const { workspace, store } = fixture(t)
  for (const path of ['a.txt', 'b.txt']) writeFileSync(join(workspace, path), 'agent')
  const rollback = store.rollback('s', workspace, ['a.txt', 'b.txt'].map(path => ({ path, content: Buffer.from('old') })))
  writeFileSync(join(workspace, 'a.txt'), 'manual edit')
  const result = store.restore('s', rollback.recoveryId)
  assert.deepEqual(result.restored.map(f => f.path), ['b.txt'])
  assert.match(result.failed[0].message, /已修改|冲突/)
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'manual edit')
  assert.equal(readFileSync(join(workspace, 'b.txt'), 'utf8'), 'agent')
  assert.deepEqual(store.list('s')[0].paths, ['a.txt'])
})

test('新建文件撤销后同名文件被重新创建时，恢复不能覆盖', t => {
  const { workspace, store } = fixture(t)
  writeFileSync(join(workspace, 'new.txt'), 'agent')
  const result = store.rollback('s', workspace, [{ path: 'new.txt', content: null }])
  writeFileSync(join(workspace, 'new.txt'), 'user')
  assert.equal(store.restore('s', result.recoveryId).failed.length, 1)
  assert.equal(readFileSync(join(workspace, 'new.txt'), 'utf8'), 'user')
})

test('快照目录无法写入时阻止撤销，不丢失工作区文件', t => {
  const { workspace, home } = fixture(t)
  const blocked = join(home, 'blocked'); writeFileSync(blocked, 'file')
  writeFileSync(join(workspace, 'a.txt'), 'agent')
  const store = new ReviewRecoveryStore(join(blocked, 'snapshots'))
  const result = store.rollback('s', workspace, [{ path: 'a.txt', content: null }])
  assert.equal(result.failed.length, 1)
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'agent')
})

test('部分失败仅把成功撤销的文件纳入恢复记录，拒绝越界路径', t => {
  const { workspace, home, store } = fixture(t)
  writeFileSync(join(workspace, 'a.txt'), 'agent')
  writeFileSync(join(home, 'outside.txt'), 'outside')
  const result = store.rollback('s', workspace, [
    { path: 'a.txt', content: Buffer.from('old') },
    { path: '../outside.txt', content: null },
  ])
  assert.equal(result.restored.length, 1)
  assert.equal(result.failed.length, 1)
  assert.deepEqual(store.list('s')[0].paths, ['a.txt'])
  assert.equal(readFileSync(join(home, 'outside.txt'), 'utf8'), 'outside')
  assert.equal(store.restore('other-session', result.recoveryId).restored.length, 0)
  assert.equal(store.restore('s', '../../outside.txt').restored.length, 0)
})

test('恢复时文件被换成指向工作区外部的 symlink，不得跟随写入', t => {
  const { workspace, home, store } = fixture(t)
  writeFileSync(join(workspace, 'a.txt'), 'agent')
  const rollback = store.rollback('s', workspace, [{ path: 'a.txt', content: null }])
  const outside = join(home, 'outside.txt'); writeFileSync(outside, 'outside')
  try { symlinkSync(outside, join(workspace, 'a.txt'), 'file') } catch (error) {
    if (error.code === 'EPERM') { t.skip('Windows 当前权限不能创建文件 symlink'); return }
    throw error
  }
  assert.equal(store.restore('s', rollback.recoveryId).failed.length, 1)
  assert.equal(readFileSync(outside, 'utf8'), 'outside')
})

test('恢复文件后记录保存失败，保留入口且重试不重复覆盖', t => {
  const { workspace, store } = fixture(t)
  writeFileSync(join(workspace, 'a.txt'), 'agent')
  const rollback = store.rollback('s', workspace, [{ path: 'a.txt', content: Buffer.from('old') }])
  const save = store.save.bind(store)
  store.save = () => { throw new Error('disk unavailable') }
  assert.equal(store.restore('s', rollback.recoveryId).failed.length, 1)
  assert.equal(store.list('s').length, 1)
  store.save = save
  assert.equal(store.restore('s', rollback.recoveryId).failed.length, 0)
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'agent')
  assert.equal(store.list('s').length, 0)
})
