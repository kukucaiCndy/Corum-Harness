/**
 * 保存结果弹窗**宿主的选取语义**单测（2026-09-16）。
 *
 * 宿主挂在根级 `shell.overlay`（root 作用域，拿不到 framework 的 sessionId），
 * 故要自己从控制器快照里挑「该显示哪一条」。
 *
 * ⚠️ 两条容易写错的点，本文件把它们钉住：
 *   ① **只返回 string | undefined，不能返回元组/对象**：绑定 Hook 是
 *      `useSyncExternalStoreWithSelector` 且不传 eq（= `Object.is`），选择器每次
 *      返回新引用会让快照永不相等 ⇒ **无限重渲染**。
 *   ② 可能同时存在多条 open（保存 A 不关窗又保存 B）⇒ 显示**最新**那条，
 *      关掉后下一条浮出（逐条消解，不丢结论）。
 */
import { describe, expect, it } from 'vitest'
import { selectOpenSaveSessionId } from '../src/client/save-dialog-select.ts'
import type { SessionArchiveSaveEntry, SessionArchiveState } from '../src/client/controller.ts'

function stateWith(bySession: Record<string, SessionArchiveSaveEntry | undefined>): SessionArchiveState {
  return {
    bySession,
    deleteBySession: {},
    importEntry: { status: 'idle', imported: [], skipped: [], error: null },
    manageEntry: { status: 'idle', rows: [], total: 0, done: [], outcome: null, exportFailed: [] },
  }
}

const open = (path: string | null = '/tmp/a.zip'): SessionArchiveSaveEntry =>
  ({ open: true, status: 'success', path, error: null })
const closed = (path: string | null = '/tmp/a.zip'): SessionArchiveSaveEntry =>
  ({ open: false, status: 'success', path, error: null })

describe('selectOpenSaveSessionId', () => {
  it('没有 open 条目 ⇒ undefined（未保存时宿主渲染 null，不留空浮层）', () => {
    expect(selectOpenSaveSessionId(stateWith({}))).toBeUndefined()
    expect(selectOpenSaveSessionId(stateWith({ s1: closed() }))).toBeUndefined()
    expect(selectOpenSaveSessionId(stateWith({ s1: undefined }))).toBeUndefined()
  })

  it('唯一 open 条目 ⇒ 返回它的 id', () => {
    expect(selectOpenSaveSessionId(stateWith({ 'corum-task-a': open() }))).toBe('corum-task-a')
  })

  it('多条 open ⇒ 返回**最新**那条（用户刚做的动作最相关），不返回最早的', () => {
    // 插入序 = publishSave 的写入序（{...state, [id]: entry} 后写者靠后）
    const state = stateWith({
      'corum-task-old': open('/tmp/old.zip'),
      'corum-task-new': open('/tmp/new.zip'),
    })
    expect(selectOpenSaveSessionId(state)).toBe('corum-task-new')
  })

  it('关掉最新那条后，次新的一条浮出（逐条消解，不丢结论）', () => {
    const state = stateWith({
      'corum-task-old': open('/tmp/old.zip'),
      'corum-task-new': closed('/tmp/new.zip'),
    })
    expect(selectOpenSaveSessionId(state)).toBe('corum-task-old')
  })

  it('返回**原始值**：同一快照重复调用必须 === 相等（防 `Object.is` 失效导致无限重渲染）', () => {
    const state = stateWith({ 'corum-task-a': open() })
    const first = selectOpenSaveSessionId(state)
    const second = selectOpenSaveSessionId(state)
    // 字符串原始值天然相等；这条断言存在的意义是「别把它改成返回对象/元组」。
    expect(first).toBe(second)
    expect(typeof first).toBe('string')
  })

  it('error 结论的条目同样被选中（错误不能被静默吞掉）', () => {
    const state = stateWith({
      'corum-task-fail': { open: true, status: 'error', path: null, error: 'disk full' },
    })
    expect(selectOpenSaveSessionId(state)).toBe('corum-task-fail')
  })
})
