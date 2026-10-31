import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as editor from '../src/client/editor/unsaved-changes.ts'
test('全部非活动可编辑tab也检查dirty，diff tab排除，已保存和空列表不拦截', () => {
  const clean = { content: 'saved', savedContent: 'saved' }
  const dirty = { content: 'new', savedContent: 'old' }
  assert.equal(editor.hasUnsavedEditorTabs([clean, dirty]), true)
  assert.equal(editor.hasUnsavedEditorTabs([clean, { ...dirty, diff: {} }]), false)
  assert.equal(editor.hasUnsavedEditorTabs([]), false)
})
