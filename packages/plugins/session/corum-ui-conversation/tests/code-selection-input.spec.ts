import { expect, it, vi } from 'vitest'
import { $nodesOfType } from 'lexical'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { ReferenceChipNode } from '../src/client/input/editor/chip-node.tsx'
import type { Context } from '@deepseek-ai/cordis'

// 上游图标包静态 import CSS；本测试只验证输入机器，不渲染图标。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ ReferenceIcon: () => null }))

function input(sent: string[]) {
  return new SessionInputShell({ actx: {} as Context,
    defaultSink: async text => { sent.push(text); return { kind: 'success' } },
    commandAttachments: { serialize: async () => [], release() {}, unsupportedNotice: () => '' },
  })
}

it('代码引用保留原草稿，只在手动提交时发送插入时的快照', async () => {
  const sent: string[] = []
  const shell = input(sent)
  try {
    shell.setDraft('请解释 ')
    const selection = { path: 'E:/A/main.py', startLine: 6, endLine: 11, text: 'original code' }
    expect(shell.appendCodeSelection(selection)).toBe(true)
    expect(shell.state.getSnapshot().draft).toMatch(/^请解释 /)
    expect(shell.state.getSnapshot().occurrences).toHaveLength(1)
    expect(sent).toEqual([])
    shell.restoreDraft([{ type: 'text', text: '@another.py' }])
    expect(shell.state.getSnapshot().occurrences).toHaveLength(1)
    selection.text = 'changed later'
    shell.submit()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sent).toEqual(['请解释 文件 "E:/A/main.py" 第 6–11 行（选区快照）：\noriginal code \n@another.py'])
  } finally { shell.dispose() }
})

it('移除引用不影响原草稿，也不修改另一对话', () => {
  const shell = input([])
  const other = input([])
  try {
    shell.setDraft('保留说明 ')
    other.setDraft('另一对话')
    shell.appendCodeSelection({ path: '/a.py', startLine: 1, endLine: 2, text: 'x\ny' })
    shell.editor.update(() => { $nodesOfType(ReferenceChipNode)[0]?.remove() }, { discrete: true })
    expect(shell.state.getSnapshot().occurrences).toEqual([])
    expect(shell.state.getSnapshot().draft.trim()).toBe('保留说明')
    expect(other.state.getSnapshot().draft).toBe('另一对话')
  } finally { shell.dispose(); other.dispose() }
})

it('发送失败恢复引用后，仍可打开原代码位置', async () => {
  const open = vi.fn()
  const shell = new SessionInputShell({ actx: {} as Context,
    defaultSink: async () => { throw new Error('offline') },
    commandAttachments: { serialize: async () => [], release() {}, unsupportedNotice: () => '' },
  })
  try {
    shell.appendCodeSelection({ path: '/a.py', startLine: 2, endLine: 3, text: 'saved code' }, open)
    shell.submit()
    await new Promise(resolve => setTimeout(resolve, 0))
    shell.editor.getEditorState().read(() => {
      const chip = $nodesOfType(ReferenceChipNode)[0]!
      const props = chip.decorate(shell.editor).props
      expect(props.selection.text).toBe('saved code')
      expect(props.onOpen).toBeTypeOf('function')
      props.onOpen()
    })
    expect(open).toHaveBeenCalledOnce()
  } finally { shell.dispose() }
})
