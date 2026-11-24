/**
 * Test for the ACP path resolution helpers (acp-paths.ts).
 *
 * Verifies that the packaged and dev paths resolve to the correct locations
 * on all three platforms (darwin/linux/win32).
 *
 * Run: node --test tests/acp-paths.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolveAcpCliPath, resolveHostNode } from '../src/electron/acp-paths.ts'

/**
 * 这些用例描述的是「**目标平台**的产物布局」，但它们跑在**当前宿主**上。
 *
 * ⚠️ 两个 helper 用的是宿主 `node:path` 的 `join`，这**是正确行为**：真实调用点传进来的
 * `process.resourcesPath` / `import.meta.url` 本来就是本机路径，跨平台拼接没有意义
 *（一个 Windows 进程不会去拼 macOS 的 .app 布局）。所以错的不是产品，而是测试：
 * 它曾把 `/app/Corum.app/...`（POSIX 字面量）喂进去、再断言 POSIX 结果 ——
 * 在 Windows runner 上 `join` 产出 `\`，断言必然不等（2026-11-23 实测）。
 *
 * 做法：期望值一律用 `join()` 拼，让分隔符跟随宿主；手写的资源根也按宿主形态给。
 * 这样三平台的断言都表达「同样的相对结构」，而分隔符交给平台。
 */
const WIN = process.platform === 'win32'
/** 造一个符合宿主形态的资源根（用于「packaged」类断言）。 */
const resRoot = WIN ? 'C:\\Program Files\\Corum\\resources' : '/opt/corum/resources'

describe('resolveAcpCliPath', () => {
  it('packaged: Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js', () => {
    const path = resolveAcpCliPath(true, resRoot, 'file:///app/main.js')
    assert.equal(path, join(resRoot, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  })

  it('packaged linux: same relative layout', () => {
    const path = resolveAcpCliPath(true, resRoot, 'file:///opt/main.js')
    assert.equal(path, join(resRoot, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  })

  it('packaged win32: same relative layout (分隔符跟随宿主)', () => {
    const winRoot = 'C:\\Program Files\\Corum\\resources'
    const path = resolveAcpCliPath(true, winRoot, 'file:///C:/main.js')
    // 结构判据（逐段），不押分隔符：这样在 POSIX 宿主上跑也不会误报。
    assert.deepEqual(path.split(/[\\/]/), [
      'C:', 'Program Files', 'Corum', 'resources',
      'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
    ])
  })

  it('dev: dirname(main.js)/../node_modules/@deepseek-ai/dsh/lib/bin.js', () => {
    const mainUrl = new URL('file:///repo/packages/desktop/lib/main.js')
    const path = resolveAcpCliPath(false, '/unused', mainUrl.href)
    assert.equal(path, join('/repo/packages/desktop', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  })
})

describe('resolveHostNode', () => {
  it('packaged darwin: Resources/node/bin/node', () => {
    const path = resolveHostNode(true, resRoot, 'darwin')
    // `platform` 只决定 win32 与非 win32 两种形态；分隔符仍跟随宿主。
    assert.equal(path, join(resRoot, 'node', 'bin', 'node'))
  })

  it('packaged linux: same relative layout', () => {
    const path = resolveHostNode(true, resRoot, 'linux')
    assert.equal(path, join(resRoot, 'node', 'bin', 'node'))
  })

  it('packaged win32: Resources/node/node.exe (no bin/ directory)', () => {
    const path = resolveHostNode(true, 'C:\\Program Files\\Corum\\resources', 'win32')
    assert.deepEqual(path.split(/[\\/]/), ['C:', 'Program Files', 'Corum', 'resources', 'node', 'node.exe'])
  })

  it('dev: process.execPath', () => {
    const path = resolveHostNode(false, '/unused', 'darwin')
    assert.equal(path, process.execPath)
  })
})
