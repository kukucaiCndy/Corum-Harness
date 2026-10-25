import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultDirectoryReloadUrl } from '../src/electron/default-directory-reload-url.ts'
test('重连只携带有限fragment，不更改token query或发送真实目录路径', () => {
  const url = 'http://127.0.0.1:1234/?token=example'
  assert.equal(defaultDirectoryReloadUrl(url), url)
  for (const notice of ['migrated', 'restored']) {
    const result = new URL(defaultDirectoryReloadUrl(url, { notice }))
    assert.equal(result.search, '?token=example'); assert.equal(result.hash, `#corum-default-directory=${notice}`)
  }
  assert.equal(defaultDirectoryReloadUrl(url, { notice: 'E:/private' }), url)
})
