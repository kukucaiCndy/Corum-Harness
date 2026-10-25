import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as migration from '../lib/types/host/default-session-directory-migration.js'
import { acquireDefaultSessionDirectoryGuard } from '../lib/types/host/default-session-directory-lock.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'corum-os-guard-'))
  const root = join(home, 'old'), cwd = join(root, 'parent'), target = join(home, 'new')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'keep'), 'safe')
  await writeFile(join(home, 'default-session-directories.json'), JSON.stringify({ version: 1, root, sessions: { parent: cwd } }))
  await migration.requestDefaultSessionDirectoryMigration(home, target, 'json')
  const lock = join(home, 'default-session-directory-migration.lock')
  await writeFile(lock, '')
  const entry = join(home, 'worker.mjs')
  await writeFile(entry, `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import * as migration from ${JSON.stringify(new URL('../lib/types/host/default-session-directory-migration.js', import.meta.url).href)}
const [home, stage, operation] = process.argv.slice(2)
const originalRm = fs.rm, originalLink = fs.link, originalWrite = fs.writeFile
const pause = async () => { process.send({ held: true }); await new Promise(done => process.once('message', done)) }
fs.rm = async (path, ...args) => { if (stage === 'before-unlink' && String(path).endsWith('migration.lock')) await pause(); return originalRm(path, ...args) }
fs.link = async (...args) => { const result = await originalLink(...args); if (stage === 'after-publish') await pause(); return result }
fs.writeFile = async (path, ...args) => { if (stage === 'initializing' && String(path).endsWith('.tmp')) await pause(); return originalWrite(path, ...args) }
syncBuiltinESMExports()
try {
  if (operation === 'request') await migration.requestDefaultSessionDirectoryMigration(home, home + '/other', 'json')
  else await migration.migrateDefaultSessionDirectoriesAtBoot(home)
  process.send({ ok: true })
} catch (error) { process.send({ ok: false, error: String(error) }) }
process.disconnect()
`)
  const children = []
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit') }
    await rm(home, { recursive: true, force: true })
  })
  const worker = (stage = '', operation = 'boot') => {
    const child = spawn(process.execPath, [entry, home, stage, operation], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true })
    children.push(child)
    return child
  }
  return { home, root, target, lock, worker }
}

test('同进程 Promise 竞争不能重入 Windows guard', async t => {
  const f = await fixture(t)
  const release = await acquireDefaultSessionDirectoryGuard(f.home)
  try { await assert.rejects(acquireDefaultSessionDirectoryGuard(f.home), /另一进程/) }
  finally { await release() }
})

test('两个进程回收旧空锁，等待者不能删除先获得者已发布的新 PID', async t => {
  const f = await fixture(t)
  const first = f.worker('after-publish')
  assert.equal((await once(first, 'message'))[0].held, true)
  const pid = await readFile(f.lock, 'utf8')
  const second = f.worker()
  assert.equal((await once(second, 'message'))[0].ok, false)
  assert.equal(await readFile(f.lock, 'utf8'), pid)
  const completed = once(first, 'message')
  first.send('continue')
  assert.equal((await completed)[0].ok, true)
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).root, f.target)
})

test('新 writer 初始化 temp 时，另一个恢复进程不能进入或删除诊断文件', async t => {
  const f = await fixture(t)
  const first = f.worker('initializing', 'request')
  assert.equal((await once(first, 'message'))[0].held, true)
  await assert.rejects(access(f.lock))
  const second = f.worker()
  assert.equal((await once(second, 'message'))[0].ok, false)
  const completed = once(first, 'message')
  first.send('continue')
  // 请求发现已有 requested journal 而拒绝，但不能与恢复 writer 并发写入。
  assert.equal((await completed)[0].ok, false)
  const retry = f.worker()
  assert.equal((await once(retry, 'message'))[0].ok, true)
})

for (const stage of ['before-unlink', 'after-publish']) test(`${stage} fixture 被终止后 OS 自动放锁，requested boot 可恢复`, async t => {
  const f = await fixture(t)
  const holder = f.worker(stage)
  assert.equal((await once(holder, 'message'))[0].held, true)
  holder.kill()
  await once(holder, 'exit')
  const recovered = f.worker()
  assert.equal((await once(recovered, 'message'))[0].ok, true)
  assert.equal((await migration.getDefaultSessionDirectoryStatus(f.home)).root, f.target)
  assert.equal(await readFile(join(f.target, 'parent', 'keep'), 'utf8'), 'safe')
})
