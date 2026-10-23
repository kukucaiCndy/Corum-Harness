import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { CorumSessionArchive } from '../lib/types/host/session-archive.js'

/**
 * 「删除归档会话失败」的回归网（2026-10-22）。
 *
 * 真因：`resolveArtifactCwd` 的 fallback 与 `importZip` 的落盘路径都把 artifact
 * 文件名硬编码成 `session.jsonl.zstd`——那是 **format v0** 时代的名字。当前基座
 * （dsh 0.1.5-rc.3）写 **format v3**，磁盘上实际是 `session.v3.jsonl.zstd`
 * （`sessionFormatLogFilename(3)`），于是 lookup ENOENT → `cwd === undefined` →
 * `removeArtifact` 静默返回 false → `{ deleted: false }` → UI 报「删除失败」，
 * 而 host 零报错、artifact 完好。会话名是版本化的，禁止在代码里钉死单一名字。
 *
 * 这里钉三件事：
 *   1. fallback 能解析出真实 v3 归档会话的 cwd（此前必失败）；
 *   2. fallback 对 v0 名字同样有效（向后兼容旧归档），且对
 *      `session.lock` / `.bak-*` / `.tmp` 等非 canonical 条目不误读；
 *   3. `removeArtifact` 删的是整个 session 目录，不依赖任何具体文件名。
 */

/** 造一个 sessions root，按 backend 的真实目录布局写一条会话 log。 */
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'corum-session-archive-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionsRoot = join(root, 'sessions')
  const storagesRoot = join(root, 'storages')
  await mkdir(sessionsRoot, { recursive: true })
  await mkdir(storagesRoot, { recursive: true })
  return { root, sessionsRoot, storagesRoot }
}

function newArchive(sessionsRoot, storagesRoot) {
  return new CorumSessionArchive(new Context(), { sessionsRoot, storagesRoot })
}

/** 把一个会话 log 写进 `<projectKey>/<encoded-id>/`，文件名与编码由调用方决定。 */
async function writeArtifact(sessionsRoot, projectKey, id, filename, header, { compress }) {
  const dir = join(sessionsRoot, projectKey, id)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const text = `${JSON.stringify(header)}\n`
  const bytes = compress ? zstdCompressSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8')
  await writeFile(join(dir, filename), bytes)
  return dir
}

test('fallback 解析真实 v3 归档会话的 cwd（删除归档会话的真因回归）', async t => {
  const { sessionsRoot, storagesRoot } = await fixture(t)
  const sessionId = 'a93fa11d-4ca3-48db-a3e7-f287eff8fc98'
  // 磁盘实况：`--Users-kukucai-work-corum-test--/<id>/session.v3.jsonl.zstd`
  await writeArtifact(
    sessionsRoot,
    '--Users-kukucai-work-corum-test--',
    sessionId,
    'session.v3.jsonl.zstd',
    { type: 'session', version: 3, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/Users/kukucai/work/corum-test' },
    { compress: true },
  )
  const archive = newArchive(sessionsRoot, storagesRoot)
  assert.equal(await archive.resolveArtifactCwd(sessionId, undefined), '/Users/kukucai/work/corum-test')
})

test('fallback 同时接受 v0 的未压缩 / 已压缩 log（向后兼容旧归档）', async t => {
  const { sessionsRoot, storagesRoot } = await fixture(t)
  const archive = newArchive(sessionsRoot, storagesRoot)
  const plain = '5d6ad401-de6b-443f-bb92-1fc4c73989df'
  const zstd = '56cfc0f8-ec3e-4fba-9e47-649f1c0e6abc'
  await writeArtifact(sessionsRoot, '--Users-kukucai-work-corum-test--', plain, 'session.jsonl',
    { type: 'session', version: 0, id: plain, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/Users/kukucai/work/corum-test' },
    { compress: false })
  await writeArtifact(sessionsRoot, '--Users-kukucai-work-corum-test--', zstd, 'session.jsonl.zstd',
    { type: 'session', version: 0, id: zstd, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/Users/kukucai/work/corum-test' },
    { compress: true })
  assert.equal(await archive.resolveArtifactCwd(plain, undefined), '/Users/kukucai/work/corum-test')
  assert.equal(await archive.resolveArtifactCwd(zstd, undefined), '/Users/kukucai/work/corum-test')
})

test('fallback 不误读 lock / .bak-* / .tmp 等非 canonical 条目', async t => {
  const { sessionsRoot, storagesRoot } = await fixture(t)
  const sessionId = 'corum-task-374c2d44'
  const dir = join(sessionsRoot, '--Users-kukucai-work-corum-test--', sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'session.lock'), '')
  // 同目录里的历史备份与迁移中间物：内容指向别的 cwd，绝不能被当成权威头行。
  await writeFile(join(dir, 'session.v3.jsonl.zstd.bak-20261021-181158'),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: sessionId, cwd: '/wrong/bak' })}\n`, 'utf8')))
  await writeFile(join(dir, 'session.v3.jsonl.zstd.tmp'), zstdCompressSync(Buffer.from('garbage', 'utf8')))
  await writeArtifact(sessionsRoot, '--Users-kukucai-work-corum-test--', sessionId, 'session.v3.jsonl.zstd',
    { type: 'session', version: 3, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/Users/kukucai/work/corum-test' },
    { compress: true })
  const archive = newArchive(sessionsRoot, storagesRoot)
  assert.equal(await archive.resolveArtifactCwd(sessionId, undefined), '/Users/kukucai/work/corum-test')
})

test('header 与请求 id 不一致时不冒认（跨项目扫描的安全性）', async t => {
  const { sessionsRoot, storagesRoot } = await fixture(t)
  const wanted = '2bbc08e6-3d22-445a-a51b-08fab436c895'
  await writeArtifact(sessionsRoot, '--Users-kukucai-work-other--', wanted, 'session.v3.jsonl.zstd',
    { type: 'session', version: 3, id: 'someone-else', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/Users/kukucai/work/other' },
    { compress: true })
  const archive = newArchive(sessionsRoot, storagesRoot)
  assert.equal(await archive.resolveArtifactCwd(wanted, undefined), undefined)
})

test('removeArtifact 删整个 session 目录，不依赖任何具体 log 文件名', async t => {
  const { root, sessionsRoot, storagesRoot } = await fixture(t)
  const sessionId = 'corum-task-6180f00e'
  const dir = await writeArtifact(sessionsRoot, '--Users-kukucai-work-corum-test--', sessionId, 'session.v3.jsonl.zstd',
    { type: 'session', version: 3, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/Users/kukucai/work/corum-test' },
    { compress: true })
  const archive = newArchive(sessionsRoot, storagesRoot)
  assert.equal(await archive.removeArtifact(sessionId, '/Users/kukucai/work/corum-test'), true)
  await assert.rejects(readFile(join(dir, 'session.v3.jsonl.zstd')))
  // 幂等：第二次删除只是「不在」，不是抛错。
  assert.equal(await archive.removeArtifact(sessionId, '/Users/kukucai/work/corum-test'), false)
  // 空 cwd 落到 `_no-cwd`（backend 的 projectDir 约定）。
  const noCwdDir = join(sessionsRoot, '_no-cwd', sessionId)
  await mkdir(noCwdDir, { recursive: true })
  await writeFile(join(noCwdDir, 'session.jsonl'), 'x')
  assert.equal(await archive.removeArtifact(sessionId, ''), true)
  assert.equal(root, await realpath(root))
})

test('任何 cwd 形态都落在 sessionsRoot 之下（安全校验的实质不变式）', async t => {
  const { sessionsRoot, storagesRoot } = await fixture(t)
  const archive = newArchive(sessionsRoot, storagesRoot)
  // projectKey 把 `/ \ :` 折叠成 `-`、其余不安全字符转义，所以 traversal 型 cwd
  // 也只会得到一个更长的**单段**项目目录名 —— resolve 后必然仍在 root 之下。
  // 这是 `removeArtifact` 里那道「必须在 sessionsRoot 之下」校验的实质前提。
  for (const cwd of ['/etc', '/../../etc', 'C:\\Windows', '..', '/Users/kukucai/work/corum-test']) {
    const sessionId = 'session-3d5af3c4-b15f-467f-8925-940ace7fdd71'
    const dir = await writeArtifact(sessionsRoot, projectKeyOf(cwd), sessionId, 'session.v3.jsonl.zstd',
      { type: 'session', version: 3, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd },
      { compress: true })
    // ⚠️ 不能用 `sessionsRoot + '/'` 判前缀（红线 7 三平台）：Windows 上路径分隔符是
    // `\\`，硬编码 `/` 会让**正确**的实现被判成「逃出了 root」——2026-10-23 实测
    // platform-tests (windows-latest) 因此红。判据必须是平台无关的：
    // 把两者都规范化，再用 `path.sep` 拼比较基准。
    const normalizedRoot = resolve(sessionsRoot)
    assert.ok(
      resolve(dir) !== normalizedRoot && resolve(dir).startsWith(normalizedRoot + sep),
      `cwd ${cwd} escaped the sessions root`,
    )
    // 删得掉（说明它被当成 root 内的普通目录），且没有删到 root 之外的东西。
    assert.equal(await archive.removeArtifact(sessionId, cwd), true)
  }
  // cwd 为 undefined = 「没有可删的东西」，保持静默 false（不是安全失败）。
  assert.equal(await archive.removeArtifact('any-id', undefined), false)
})

/** 与 host 侧 projectKey 同形的目录名（只用于在本测试里定位夹具落点）。 */
function projectKeyOf(cwd) {
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
