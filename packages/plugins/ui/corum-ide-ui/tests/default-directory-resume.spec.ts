import { expect, it } from 'vitest'
import { consumeDefaultDirectoryResume } from '../src/client/settings/default-directory-resume.ts'
it('消费一次有限恢复标记，保留其它URL内容，返回notice供React继续传给延后挂载的section', () => {
  for (const notice of ['migrated', 'restored']) {
    const location = new URL(`http://127.0.0.1:4567/?other=1#corum-default-directory=${notice}`)
    const history = { state: { example: 1 }, replaceState: (data: unknown, _title: string, url?: string | URL | null) => { expect(data).toEqual({ example: 1 }); location.href = String(url) } }
    expect(consumeDefaultDirectoryResume(location, history)).toBe(notice)
    expect(location.search).toBe('?other=1'); expect(location.hash).toBe('')
    expect(consumeDefaultDirectoryResume(location, history)).toBe(null)
  }
  const location = new URL('http://localhost/#corum-default-directory=E:/private')
  expect(consumeDefaultDirectoryResume(location, { state: null, replaceState: () => { throw new Error('未知fragment不应消费') } })).toBe(null)
})
