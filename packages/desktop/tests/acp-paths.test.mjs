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
import { resolveAcpCliPath, resolveHostNode } from '../src/electron/acp-paths.ts'

describe('resolveAcpCliPath', () => {
  it('packaged: Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js', () => {
    const path = resolveAcpCliPath(true, '/app/Corum.app/Contents/Resources', 'file:///app/main.js')
    assert.equal(
      path,
      '/app/Corum.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js',
    )
  })

  it('packaged linux: same POSIX layout', () => {
    const path = resolveAcpCliPath(true, '/opt/corum/resources', 'file:///opt/main.js')
    assert.equal(
      path,
      '/opt/corum/resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js',
    )
  })

  it('packaged win32: uses backslash-joined path', () => {
    const path = resolveAcpCliPath(true, 'C:\\Program Files\\Corum\\resources', 'file:///C:/main.js')
    assert.ok(path.includes('host'), `path should contain 'host': ${path}`)
    assert.ok(path.includes('node_modules'), `path should contain 'node_modules': ${path}`)
    assert.ok(path.includes('bin.js'), `path should contain 'bin.js': ${path}`)
    assert.ok(path.includes('@deepseek-ai'), `path should contain '@deepseek-ai': ${path}`)
  })

  it('dev: dirname(main.js)/../node_modules/@deepseek-ai/dsh/lib/bin.js', () => {
    const path = resolveAcpCliPath(false, '/unused', 'file:///repo/packages/desktop/lib/main.js')
    assert.equal(
      path,
      '/repo/packages/desktop/node_modules/@deepseek-ai/dsh/lib/bin.js',
    )
  })
})

describe('resolveHostNode', () => {
  it('packaged darwin: Resources/node/bin/node', () => {
    const path = resolveHostNode(true, '/app/Corum.app/Contents/Resources', 'darwin')
    assert.equal(path, '/app/Corum.app/Contents/Resources/node/bin/node')
  })

  it('packaged linux: same POSIX layout', () => {
    const path = resolveHostNode(true, '/opt/corum/resources', 'linux')
    assert.equal(path, '/opt/corum/resources/node/bin/node')
  })

  it('packaged win32: Resources/node/node.exe (no bin/ directory)', () => {
    const path = resolveHostNode(true, 'C:\\Program Files\\Corum\\resources', 'win32')
    assert.ok(path.includes('node.exe'), `path should contain 'node.exe': ${path}`)
    assert.ok(!path.includes('bin'), `path should NOT contain 'bin': ${path}`)
  })

  it('dev: process.execPath', () => {
    const path = resolveHostNode(false, '/unused', 'darwin')
    assert.equal(path, process.execPath)
  })
})
