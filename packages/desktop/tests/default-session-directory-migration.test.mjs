import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink, realpath } from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import * as migration from '../lib/types/host/default-session-directory-migration.js'
import { planDirectoryMetadata } from '../lib/types/host/default-session-directory-metadata.js'
import { readDirectoryStorage, writeDirectoryStorage } from '@corum/corum-agent'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { ReviewRecoveryStore } from '../lib/types/host/corum-review-recovery.js'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const journalPath = home => join(home, 'default-session-directory-migration.json')

async function recoveryFixture(f, sessions = ['parent', 'shared', 'child', 'external']) {
  const recoveryRoot = join(f.home, 'review-recovery')
  const store = new ReviewRecoveryStore(recoveryRoot)
  const records = []
  for (const id of sessions) {
    const workspace = id === 'child' ? join(f.cwd, 'child') : id === 'external' ? join(f.home, 'external') : f.cwd
    await mkdir(workspace, { recursive: true })
    const file = `${id}.txt`, original = Buffer.from(`agent\r\n${f.cwd}\r\n中文\u0000`)
    await writeFile(join(workspace, file), original)
    const result = store.rollback(id, workspace, [{ path: file, content: Buffer.from('baseline') }], 'group-unchanged')
    assert.equal(result.restored.length, 1)
    const path = join(recoveryRoot, createHash('sha256').update(id).digest('hex'), result.recoveryId + '.json')
    records.push({ id, path, file, original, workspace, batch: JSON.parse(await readFile(path, 'utf8')), bytes: await readFile(path) })
  }
  return { recoveryRoot, records }
}

test('真实 RecoveryStore 的 shared/child/旧会话 batch 迁移后可恢复，外部与 image 字节保持', async t => {
  const f = await fixture(t)
  const { recoveryRoot, records } = await recoveryFixture(f)
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  const activity = []
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home, active => activity.push(active))
  assert.deepEqual(activity, [true, false])
  await rm(f.root, { recursive: true, force: true })
  const restarted = new ReviewRecoveryStore(recoveryRoot)
  for (const record of records) {
    const next = record.id === 'external' ? record.workspace : join(f.target, 'parent', ...(record.id === 'child' ? ['child'] : []))
    assert.deepEqual(JSON.parse(await readFile(record.path, 'utf8')), { ...record.batch, workspace: next })
    if (record.id === 'external') assert.deepEqual(await readFile(record.path), record.bytes)
    assert.equal(restarted.list(record.id)[0].workspace, next)
    const restored = restarted.restore(record.id, record.batch.id)
    assert.deepEqual(restored.failed, [])
    assert.equal(restored.restored.length, 1)
    assert.deepEqual(await readFile(join(next, record.file)), record.original)
  }
})

test('Recovery metadata 部分提交失败恢复原始 batch 字节；重试可迁移并恢复', async t => {
  const f = await fixture(t)
  const { recoveryRoot, records } = await recoveryFixture(f, ['parent', 'shared'])
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  const original = fsPromises.rename
  let writes = 0
  fsPromises.rename = async (from, to) => {
    if (String(to).startsWith(recoveryRoot) && ++writes === 2) throw new Error('recovery metadata disk failed')
    return original(from, to)
  }
  syncBuiltinESMExports()
  try { await migration.migrateDefaultSessionDirectoriesAtBoot(f.home) }
  finally { fsPromises.rename = original; syncBuiltinESMExports() }
  const status = await migration.getDefaultSessionDirectoryStatus(f.home)
  assert.equal(status.root, f.root)
  assert.match(status.error, /recovery metadata disk failed/)
  for (const record of records) assert.deepEqual(await readFile(record.path), record.bytes)
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  for (const record of records) assert.equal(new ReviewRecoveryStore(recoveryRoot).restore(record.id, record.batch.id).restored.length, 1)
})

test('损坏 canonical RecoveryBatch 拒绝迁移并保留原位置；新 store 根受保护', async t => {
  const f = await fixture(t)
  const { records } = await recoveryFixture(f, ['parent'])
  await writeFile(records[0].path, '{broken')
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).root, f.root)
  assert.ok((await migration.getDefaultSessionDirectoryStatus(f.home)).error)
  assert.equal(await readFile(records[0].path, 'utf8'), '{broken')
  await assert.rejects(migration.requestDefaultSessionDirectoryMigration(f.home, join(f.home, 'review-recovery', 'nested'), 'json'), /重叠|数据目录/)
})

test('Review recovery 数据根及其内部不能成为默认根，恢复 journal 也不能绕过保护', async t => {
  const f = await fixture(t)
  for (const target of [join(f.home, 'review-recovery'), join(f.home, 'review-recovery', 'nested')]) {
    await assert.rejects(migration.requestDefaultSessionDirectoryMigration(f.home, target, 'json'), /重叠|数据目录/)
  }
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  const pending = JSON.parse(await readFile(journalPath(f.home), 'utf8'))
  pending.after.root = join(f.home, 'review-recovery')
  pending.after.sessions.parent = join(pending.after.root, 'parent')
  pending.moves[0].to = pending.after.sessions.parent
  await writeFile(journalPath(f.home), JSON.stringify(pending))
  await assert.rejects(migration.migrateDefaultSessionDirectoriesAtBoot(f.home), /journal|归属/)
})

test('恢复 journal 的 Recovery metadata 越界路径不能覆盖无关文件', async t => {
  const f = await fixture(t)
  const unrelated = join(f.home, 'unrelated.json')
  await writeFile(unrelated, 'keep')
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  const pending = JSON.parse(await readFile(journalPath(f.home), 'utf8'))
  pending.prepared = await planDirectoryMetadata(f.home, pending.moves, 'json')
  pending.prepared.recoveries = [{ path: unrelated, before: '{}', after: '{}' }]
  await writeFile(journalPath(f.home), JSON.stringify(pending))
  await assert.rejects(migration.migrateDefaultSessionDirectoriesAtBoot(f.home), /journal|归属|Recovery/)
  assert.equal(await readFile(unrelated, 'utf8'), 'keep')
})

test('迁移只接受实际已装配的同一 JSON/SQLite backend，未知或分流配置提前拒绝', () => {
  assert.equal(migration.defaultSessionDirectoryBackend({ backend: 'json' }), 'json')
  assert.equal(migration.defaultSessionDirectoryBackend({ backend: 'sqlite', routes: { workspace: 'sqlite' } }), 'sqlite')
  assert.throws(() => migration.defaultSessionDirectoryBackend({ backend: 'remote' }), /backend|后端/)
  assert.throws(() => migration.defaultSessionDirectoryBackend({ backend: 'sqlite', routes: { workspace: 'json' } }), /backend|后端/)
})

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'corum-move-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'old'), cwd = join(root, 'parent'), target = join(home, 'new')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, '.hidden'), 'preserved')
  await writeFile(join(home, 'default-session-directories.json'), JSON.stringify({ version: 1, root, sessions: { parent: cwd } }))
  return { home, root, cwd, target }
}
async function artifact(home, id, cwd, compressed = false) {
  const path = join(home, 'sessions', '--fixture--', id)
  await mkdir(path, { recursive: true })
  const events = `{"type":"message","data":{"text":${JSON.stringify(cwd)}}}\n`
  const text = JSON.stringify({ type: 'session', version: 3, id, cwd, createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n' + events
  await writeFile(join(path, 'session.v3.jsonl' + (compressed ? '.zstd' : '')), compressed ? zstdCompressSync(Buffer.from(text)) : text)
  return { path, events }
}

test('迁移文件与共享、归档和后代会话，事件正文保持原始字节', async t => {
  const f = await fixture(t)
  await mkdir(join(f.cwd, 'child'))
  const a = await artifact(f.home, 'parent', f.cwd)
  const b = await artifact(f.home, 'shared', f.cwd, true)
  const c = await artifact(f.home, 'child', join(f.cwd, 'child'))
  await writeFile(join(f.home, 'sessions.json'), JSON.stringify({ version: 2, sessions: { parent: { cwd: f.cwd, profileId: 'task', type: 'task' } } }))
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).sessionCount, 3)
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  const status = await migration.getDefaultSessionDirectoryStatus(f.home)
  assert.equal(status.root, f.target)
  assert.equal(status.migration, null)
  assert.equal(status.error, undefined)
  assert.equal(await readFile(join(f.target, 'parent', '.hidden'), 'utf8'), 'preserved')
  await assert.rejects(access(f.cwd))
  for (const [id, original, compressed] of [['parent', a, false], ['shared', b, true], ['child', c, false]]) {
    const newCwd = id === 'child' ? join(f.target, 'parent', 'child') : join(f.target, 'parent')
    const file = migration.migratedSessionArtifactPath(f.home, newCwd, id, 'session.v3.jsonl' + (compressed ? '.zstd' : ''))
    const raw = await readFile(file)
    const secondFrame = compressed ? raw.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4) : -1
    if (compressed) assert.ok(secondFrame > 0)
    const text = (compressed
      ? Buffer.concat([zstdDecompressSync(raw.subarray(0, secondFrame)), zstdDecompressSync(raw.subarray(secondFrame))])
      : raw).toString()
    assert.equal(JSON.parse(text.slice(0, text.indexOf('\n'))).cwd, newCwd)
    assert.equal(text.slice(text.indexOf('\n') + 1), original.events)
  }
})

test('真实 JSONL writer 多次 append 后迁移保留所有事件 frame，重复迁移仍可独立重载', async t => {
  const f = await fixture(t)
  const id = 'multi-frame'
  const store = new JsonlSessionPersistence(new Context(), { root: join(f.home, 'sessions'), compression: 'zstd' })
  const writer = await store.create({ version: 3, id, cwd: f.cwd, createdAt: 1, isSeeded: false, delegationDepth: 0 })
  for (const [seq, text] of ['第一条消息', '第二条消息', '第三条消息'].entries()) {
    await writer.append([{ type: 'user/message', seq, time: seq + 1, data: { id: `message-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, surfaceOp: 'append' }])
    await writer.flush()
  }
  await writer.close()
  const originalPath = migration.migratedSessionArtifactPath(f.home, f.cwd, id, 'session.v3.jsonl.zstd')
  const original = await readFile(originalPath)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const secondFrame = original.indexOf(magic, 4)
  assert.ok(secondFrame > 0)
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  const newCwd = join(f.target, 'parent')
  const migratedPath = migration.migratedSessionArtifactPath(f.home, newCwd, id, 'session.v3.jsonl.zstd')
  const migrated = await readFile(migratedPath)
  assert.deepEqual(migrated.subarray(migrated.indexOf(magic, 4)), original.subarray(secondFrame))
  const reader = new JsonlSessionPersistence(new Context(), { root: join(f.home, 'sessions'), compression: 'zstd' })
  const handle = await reader.open(id, 'read')
  assert.equal(handle.header.cwd, newCwd)
  const events = (await handle.read()).events
  assert.deepEqual(events.map(event => event.data.content[0].text), ['第一条消息', '第二条消息', '第三条消息'])
  await handle.close()
})

test('截断的最后一个 zstd frame 拒绝迁移，原 artifact 字节不变', async t => {
  const f = await fixture(t)
  const id = 'torn-frame'
  const store = new JsonlSessionPersistence(new Context(), { root: join(f.home, 'sessions'), compression: 'zstd' })
  const writer = await store.create({ version: 3, id, cwd: f.cwd, createdAt: 1, isSeeded: false, delegationDepth: 0 })
  await writer.append([{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])
  await writer.flush()
  await writer.append([{ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: 'completed' } }])
  await writer.flush()
  await writer.close()
  const path = migration.migratedSessionArtifactPath(f.home, f.cwd, id, 'session.v3.jsonl.zstd')
  const original = (await readFile(path)).subarray(0, -2)
  await writeFile(path, original)
  await assert.rejects(migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json'), /zstd|frame/)
  const status = await migration.getDefaultSessionDirectoryStatus(f.home)
  assert.equal(status.root, f.root)
  assert.deepEqual(await readFile(path), original)
})

test('目标冲突及父子根在提交前拒绝，源数据保留', async t => {
  const f = await fixture(t)
  await assert.rejects(migration.requestDefaultSessionDirectoryMigration(f.home, join(f.root, 'nested'), 'json'), /父子|重叠/)
  await mkdir(join(f.target, 'parent'), { recursive: true })
  await assert.rejects(migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json'), /存在|冲突/)
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).root, f.root)
  assert.equal(await readFile(join(f.cwd, '.hidden'), 'utf8'), 'preserved')
})

test('同路径迁移不生成待迁移请求', async t => {
  const f = await fixture(t)
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.root, 'json')
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).migration, null)
})

test('同一 home 的并发迁移请求只有一个 writer，不能覆盖 journal', async t => {
  const f = await fixture(t)
  const attempts = await Promise.allSettled([
    migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json'),
    migration.requestDefaultSessionDirectoryMigration(f.home, join(f.home, 'other'), 'json'),
  ])
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(item => item.status === 'rejected').length, 1)
})

test('requested journal 遗留空 lock 后能在下次 boot 恢复', async t => {
  const f = await fixture(t)
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  await writeFile(join(f.home, 'default-session-directory-migration.lock'), '')
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).root, f.target)
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
})

test('初始化完整 PID 前不发布 lock；另一 writer 不能回收初始化占位', async t => {
  const f = await fixture(t)
  const originalWrite = fsPromises.writeFile
  const originalOpen = fsPromises.open
  let release, started
  const pause = new Promise(done => { release = done })
  const initializing = new Promise(done => { started = done })
  // 新实现必须先写同目录 temp 再原子发布；暂停写入验证主 lock 尚未出现。
  fsPromises.writeFile = async (path, ...args) => {
    if (String(path).includes('default-session-directory-migration.lock.') && String(path).endsWith('.tmp')) { started(); await pause }
    return originalWrite(path, ...args)
  }
  fsPromises.open = async (path, ...args) => {
    if (String(path).endsWith('default-session-directory-migration.lock')) {
      const handle = await originalOpen(path, ...args)
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async (...values) => { started(); await pause; return write(...values) }
      return handle
    }
    return originalOpen(path, ...args)
  }
  syncBuiltinESMExports()
  const first = migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  await initializing
  try {
    await assert.rejects(access(join(f.home, 'default-session-directory-migration.lock')))
    await assert.rejects(migration.requestDefaultSessionDirectoryMigration(f.home, join(f.home, 'other'), 'json'), /另一进程/)
  } finally {
    release(); await first
    fsPromises.writeFile = originalWrite; fsPromises.open = originalOpen; syncBuiltinESMExports()
  }
})

test('损坏 canonical artifact 拒绝迁移且不能丢失旧目录', async t => {
  const f = await fixture(t)
  const a = await artifact(f.home, 'parent', f.cwd)
  await writeFile(join(a.path, 'session.v3.jsonl'), 'broken\n')
  await assert.rejects(migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json'))
  assert.equal(await readFile(join(f.cwd, '.hidden'), 'utf8'), 'preserved')
})

test('恢复 journal 中的越界 owned 不能删除无关目录', async t => {
  const f = await fixture(t)
  const unrelated = join(f.home, 'unrelated')
  await mkdir(unrelated); await writeFile(join(unrelated, 'keep'), 'safe')
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  const pending = JSON.parse(await readFile(journalPath(f.home), 'utf8'))
  pending.owned = [unrelated]
  pending.phase = 'metadata'
  await writeFile(journalPath(f.home), JSON.stringify(pending))
  await assert.rejects(migration.migrateDefaultSessionDirectoriesAtBoot(f.home), /journal|归属|范围/)
  assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'safe')
})

for (const backend of ['json', 'sqlite']) test(`${backend} workspace 保留 ID/归档集合，metadata 半提交后 boot 幂等恢复`, async t => {
  const f = await fixture(t)
  const { recoveryRoot, records } = await recoveryFixture(f, ['parent', 'shared'])
  const snapshots = await readDirectoryStorage(f.home, backend)
  const workspace = snapshots.find(item => item.descriptor.name === 'workspace')
  workspace.tables.workspaces.w1 = { id: 'w1', title: 'unchanged', path: f.cwd, sessionIds: ['parent', 'archived'] }
  workspace.global = { archivedSessionIds: ['archived'] }
  snapshots.find(item => item.descriptor.name === 'session_projcache').tables.sessions.parent = { cwd: f.cwd }
  await writeDirectoryStorage(f.home, backend, snapshots)
  await artifact(f.home, 'parent', f.cwd)
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, backend)
  const pending = JSON.parse(await readFile(journalPath(f.home), 'utf8'))
  pending.prepared = await planDirectoryMetadata(f.home, pending.moves, backend)
  // 模拟目录/新 artifact 已复制，首个 workspace unit 已提交，其余 metadata 尚未提交。
  const { copyDirectoryChecked } = await import('../lib/types/host/default-session-directory-files.js')
  for (const copy of [...pending.moves, ...pending.prepared.artifacts]) {
    await mkdir(join(copy.to, '..'), { recursive: true })
    await copyDirectoryChecked(copy.from, copy.to, pending.moves)
    pending.owned.push(copy.to)
  }
  const { writePreparedArtifact } = await import('../lib/types/host/default-session-directory-metadata.js')
  for (const item of pending.prepared.artifacts) await writePreparedArtifact(item)
  await writeDirectoryStorage(f.home, backend, [pending.prepared.storage.after[0]])
  const { writeRecoveryMetadata } = await import('../lib/types/host/default-session-directory-metadata.js')
  await writeRecoveryMetadata(pending.prepared.recoveries.slice(0, 1), 'after')
  pending.phase = 'metadata'
  await writeFile(journalPath(f.home), JSON.stringify(pending))
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  const after = await readDirectoryStorage(f.home, backend)
  const changed = after.find(item => item.descriptor.name === 'workspace')
  assert.deepEqual(changed.tables.workspaces.w1, { ...workspace.tables.workspaces.w1, path: join(f.target, 'parent') })
  assert.deepEqual(changed.global, workspace.global)
  assert.equal(Object.keys(after.find(item => item.descriptor.name === 'session_projcache').tables.sessions).length, 0)
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).root, f.target)
  for (const record of records) {
    assert.equal(new ReviewRecoveryStore(recoveryRoot).list(record.id)[0].workspace, join(f.target, 'parent'))
    assert.equal(new ReviewRecoveryStore(recoveryRoot).restore(record.id, record.batch.id).restored.length, 1)
  }
})

test('Review shadow repo 与 frozen/journal 的结构路径随迁移，blob 与 refs 保留', async t => {
  const f = await fixture(t)
  const reviewKey = path => createHash('sha1').update(path).digest('hex').slice(0, 16)
  const source = join(f.home, 'review', reviewKey(f.cwd))
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'round-journal.jsonl'), JSON.stringify({ workspace: f.cwd, parentCwd: f.cwd, path: 'relative.txt' }) + '\n')
  await writeFile(join(source, 'frozen.jsonl'), JSON.stringify({ sessionId: 'parent', workspace: f.cwd }) + '\n')
  await writeFile(join(source, 'blob'), 'unchanged')
  const gitDir = join(source, 'repo.git')
  execFileSync('git', ['init', '--bare', '--quiet', gitDir], { windowsHide: true })
  const shadowGit = args => execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', windowsHide: true, input: 'review preimage' })
  const blob = shadowGit(['hash-object', '-w', '--stdin']).trim()
  shadowGit(['update-ref', 'refs/corum/fixture', blob])
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  const destination = join(f.home, 'review', reviewKey(join(f.target, 'parent')))
  assert.equal(await readFile(join(destination, 'blob'), 'utf8'), 'unchanged')
  const row = JSON.parse(await readFile(join(destination, 'round-journal.jsonl'), 'utf8'))
  assert.equal(row.workspace, join(f.target, 'parent')); assert.equal(row.parentCwd, row.workspace)
  assert.equal(row.path, 'relative.txt')
  const newGitDir = join(destination, 'repo.git')
  assert.equal(execFileSync('git', ['--git-dir', newGitDir, 'rev-parse', 'refs/corum/fixture'], { encoding: 'utf8', windowsHide: true }).trim(), blob)
  assert.equal(execFileSync('git', ['--git-dir', newGitDir, 'cat-file', '-p', blob], { encoding: 'utf8', windowsHide: true }), 'review preimage')
  await assert.rejects(access(source))
})

test('Git 子 worktree 修复双向绝对指针，源根移除后仍可执行', async t => {
  const f = await fixture(t)
  const git = (cwd, args) => execFileSync('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  git(f.cwd, ['init'])
  git(f.cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-m', 'fixture'])
  git(f.cwd, ['worktree', 'add', '-b', 'child', join(f.cwd, 'child')])
  await artifact(f.home, 'parent', f.cwd)
  await artifact(f.home, 'child', join(f.cwd, 'child'))
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).error, undefined)
  await rm(f.root, { recursive: true, force: true })
  const moved = join(f.target, 'parent'), child = join(moved, 'child')
  assert.equal(git(child, ['rev-parse', '--show-toplevel']).trim().replaceAll('\\', '/'), child.replaceAll('\\', '/'))
  assert.match(git(moved, ['worktree', 'list', '--porcelain']), /child/)
  assert.doesNotMatch(git(moved, ['worktree', 'list', '--porcelain']), new RegExp(f.root.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('外部目录链接保留指向且不跟随复制外部工作区', async t => {
  const f = await fixture(t)
  const external = join(f.home, 'external')
  await mkdir(external); await writeFile(join(external, 'keep'), 'external')
  await symlink(external, join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).error, undefined)
  assert.equal(await realpath(join(f.target, 'parent', 'linked')), await realpath(external))
  assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'external')
})

test('复制失败回退原位置；cleanup 失败保持新位置并可在下次 boot 清理', async t => {
  const f = await fixture(t)
  await artifact(f.home, 'parent', f.cwd)
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  const originalCopy = fsPromises.copyFile
  fsPromises.copyFile = async () => { throw new Error('copy failed') }
  syncBuiltinESMExports()
  try { await migration.migrateDefaultSessionDirectoriesAtBoot(f.home) }
  finally { fsPromises.copyFile = originalCopy; syncBuiltinESMExports() }
  const failed = await migration.getDefaultSessionDirectoryStatus(f.home)
  assert.equal(failed.root, f.root); assert.match(failed.error, /copy failed/)
  assert.equal(await readFile(join(f.cwd, '.hidden'), 'utf8'), 'preserved')
  await migration.requestDefaultSessionDirectoryMigration(f.home, f.target, 'json')
  const originalRm = fsPromises.rm
  fsPromises.rm = async (path, ...args) => { if (path === f.cwd) throw new Error('cleanup failed'); return originalRm(path, ...args) }
  syncBuiltinESMExports()
  try { await migration.migrateDefaultSessionDirectoriesAtBoot(f.home) }
  finally { fsPromises.rm = originalRm; syncBuiltinESMExports() }
  const active = await migration.getDefaultSessionDirectoryStatus(f.home)
  assert.equal(active.root, f.target); assert.match(active.warning, /cleanup failed/)
  assert.equal(active.error, undefined); assert.equal(active.migration.phase, 'cleanup')
  await migration.migrateDefaultSessionDirectoriesAtBoot(f.home)
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).warning, undefined)
  await assert.rejects(access(f.cwd))
})
