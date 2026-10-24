import { expect, it } from 'vitest'
const impl = await import('../src/client/file-reference.ts').catch(() => ({} as Record<string, any>))

it('文件引用解析保留 Windows 盘符，分离行号和列号', () => {
  expect(typeof impl.parseFileReference).toBe('function')
  expect(impl.parseFileReference('E:\\My Project\\main.py:15:3')).toEqual({ path: 'E:\\My Project\\main.py', line: 15 })
  expect(impl.parseFileReference('src/App.tsx#L8-L12')).toEqual({ path: 'src/App.tsx', line: 8 })
  expect(impl.parseFileReference('README.md')).toEqual({ path: 'README.md' })
})

it('网页链接、命令和代码表达式不作为项目文件', () => {
  expect(typeof impl.parseFileReference).toBe('function')
  for (const value of ['https://example.com/a.py', 'npm install', 'fn(main.py)', 'a = "main.py"', 'v0.6.0', '', 'src/main.py:0']) {
    expect(impl.parseFileReference(value)).toBeNull()
  }
})
