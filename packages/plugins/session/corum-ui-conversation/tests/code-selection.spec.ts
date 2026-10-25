import { describe, expect, it } from 'vitest'
const implementation = await import('../src/client/input/code-selection.ts').catch(() => ({} as Record<string, any>))

describe('代码选区快照', () => {
  it('发送选中时的内容，并携带原始路径和行号', () => {
    expect(typeof implementation.serializeCodeSelection).toBe('function')
    const ref = JSON.stringify({ path: 'E:\\项目 A\\main.py', startLine: 6, endLine: 11, text: 'print("original")' })
    expect(implementation.serializeCodeSelection(ref)).toBe('文件 "E:\\\\项目 A\\\\main.py" 第 6–11 行（选区快照）：\nprint("original")')
  })
  it('拒绝损坏引用和非法范围，不能静默丢失代码', () => {
    expect(typeof implementation.parseCodeSelection).toBe('function')
    expect(implementation.parseCodeSelection('not-json')).toBeNull()
    expect(implementation.parseCodeSelection(JSON.stringify({ path: '/a.py', startLine: 3, endLine: 2, text: 'x' }))).toBeNull()
    expect(() => implementation.serializeCodeSelection('{}')).toThrow()
  })
})
