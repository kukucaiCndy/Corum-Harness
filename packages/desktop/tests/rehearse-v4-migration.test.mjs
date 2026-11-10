import { describe, it } from 'node:test'
import { strictEqual, ok } from 'node:assert'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * rehearse-v4-migration.mjs 的 fixture 测试。
 *
 * 测试统计逻辑（版本分布计数）和源 hash 确定性。
 * 不依赖完整闭包——只测纯函数逻辑。
 */

// ── 从 rehearse-v4-migration.mjs 导入纯函数 ──
// 脚本是 ESM 且有副作用（await main），不能直接 import。
// 这里复制被测函数的等价实现（与脚本保持同步）。

/** 解析 session 文件名的版本号。 */
function parseSessionVersion(filename) {
  const match = filename.match(/^session\.v(\d+)\.jsonl/)
  return match ? parseInt(match[1], 10) : undefined
}

/** 计算 sha256 of a string. */
function sha256String(text) {
  return createHash('sha256').update(text).digest('hex')
}

describe('parseSessionVersion', () => {
  it('解析 v2 文件名', () => {
    strictEqual(parseSessionVersion('session.v2.jsonl.zstd'), 2)
  })

  it('解析 v3 文件名', () => {
    strictEqual(parseSessionVersion('session.v3.jsonl.zstd'), 3)
  })

  it('解析 v4 文件名', () => {
    strictEqual(parseSessionVersion('session.v4.jsonl.zstd'), 4)
  })

  it('解析无压缩文件名', () => {
    strictEqual(parseSessionVersion('session.v2.jsonl'), 2)
  })

  it('无版本号文件返回 undefined', () => {
    strictEqual(parseSessionVersion('session.jsonl.zstd'), undefined)
  })

  it('非 session 文件返回 undefined', () => {
    strictEqual(parseSessionVersion('session.lock'), undefined)
    strictEqual(parseSessionVersion('random.txt'), undefined)
  })
})

describe('版本统计', () => {
  it('从文件名列表统计版本分布', () => {
    const filenames = [
      'session.v2.jsonl.zstd',
      'session.v2.jsonl.zstd',
      'session.v3.jsonl.zstd',
      'session.v3.jsonl.zstd',
      'session.v3.jsonl.zstd',
      'session.v4.jsonl.zstd',
      'session.jsonl.zstd', // v0, no version
      'session.lock', // not a session file
    ]
    const versionFromFilename = {}
    for (const f of filenames) {
      const v = parseSessionVersion(f)
      if (v !== undefined) {
        versionFromFilename[v] = (versionFromFilename[v] ?? 0) + 1
      }
    }
    strictEqual(versionFromFilename[2], 2)
    strictEqual(versionFromFilename[3], 3)
    strictEqual(versionFromFilename[4], 1)
    strictEqual(versionFromFilename[0], undefined) // v0 not counted
  })
})

describe('源 hash 确定性', () => {
  it('相同内容产生相同 hash', () => {
    const files = [
      { relPath: 'proj1/sess1/session.v2.jsonl.zstd', sha256: 'aaa', size: 100 },
      { relPath: 'proj1/sess2/session.v3.jsonl.zstd', sha256: 'bbb', size: 200 },
    ]
    const combined = createHash('sha256')
    for (const f of files) {
      combined.update(`${f.relPath}\0${f.sha256}\0${f.size}\n`)
    }
    const hash1 = combined.digest('hex')

    // 重新计算，顺序相同
    const combined2 = createHash('sha256')
    for (const f of files) {
      combined2.update(`${f.relPath}\0${f.sha256}\0${f.size}\n`)
    }
    const hash2 = combined2.digest('hex')
    strictEqual(hash1, hash2)
  })

  it('不同顺序产生不同 hash（验证排序必要性）', () => {
    const filesA = [
      { relPath: 'a', sha256: 'aaa', size: 100 },
      { relPath: 'b', sha256: 'bbb', size: 200 },
    ]
    const filesB = [
      { relPath: 'b', sha256: 'bbb', size: 200 },
      { relPath: 'a', sha256: 'aaa', size: 100 },
    ]
    const hashA = createHash('sha256')
    for (const f of filesA) hashA.update(`${f.relPath}\0${f.sha256}\0${f.size}\n`)
    const hashB = createHash('sha256')
    for (const f of filesB) hashB.update(`${f.relPath}\0${f.sha256}\0${f.size}\n`)
    ok(hashA.digest('hex') !== hashB.digest('hex'), 'different order should produce different hash')
  })

  it('排序后不同初始顺序产生相同 hash', () => {
    const filesA = [
      { relPath: 'a', sha256: 'aaa', size: 100 },
      { relPath: 'b', sha256: 'bbb', size: 200 },
    ]
    const filesB = [
      { relPath: 'b', sha256: 'bbb', size: 200 },
      { relPath: 'a', sha256: 'aaa', size: 100 },
    ]
    // 排序后比较
    filesA.sort((a, b) => a.relPath < b.relPath ? -1 : 1)
    filesB.sort((a, b) => a.relPath < b.relPath ? -1 : 1)
    const hashA = createHash('sha256')
    for (const f of filesA) hashA.update(`${f.relPath}\0${f.sha256}\0${f.size}\n`)
    const hashB = createHash('sha256')
    for (const f of filesB) hashB.update(`${f.relPath}\0${f.sha256}\0${f.size}\n`)
    strictEqual(hashA.digest('hex'), hashB.digest('hex'))
  })
})

describe('临时目录 fixture', () => {
  it('创建临时 sessions 目录并验证结构', () => {
    const tempDir = join(tmpdir(), `corum-rehearse-fixture-${process.pid}`)
    rmSync(tempDir, { recursive: true, force: true })
    mkdirSync(join(tempDir, 'sessions', 'proj1', 'sess1'), { recursive: true })
    writeFileSync(join(tempDir, 'sessions', 'proj1', 'sess1', 'session.v2.jsonl.zstd'), 'fake-content')
    writeFileSync(join(tempDir, 'sessions', 'proj1', 'sess1', 'session.lock'), 'lock')

    // 验证文件存在
    ok(existsSync(join(tempDir, 'sessions', 'proj1', 'sess1', 'session.v2.jsonl.zstd')))
    ok(existsSync(join(tempDir, 'sessions', 'proj1', 'sess1', 'session.lock')))

    // 验证版本解析
    strictEqual(parseSessionVersion('session.v2.jsonl.zstd'), 2)

    rmSync(tempDir, { recursive: true, force: true })
  })
})
