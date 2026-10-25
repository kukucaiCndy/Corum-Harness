import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCorumEditor, createEditorReadySource } from '../lib/types/client/editor/corum-editor.js'

test('资源管理器未挂载时先显示编辑器，挂载后只展开一次；已挂载时正常切换', () => {
  const api = { openFile: null, openContentDiff: null, toggleExplorer: null }
  const ready = createEditorReadySource()
  let shown = 0
  const calls = []
  const editor = createCorumEditor(api, ready, { currentRoot: () => '/project', toRelativePath: () => null, showEditorRegion() { shown++ } })
  editor.toggleExplorer()
  assert.equal(shown, 1)
  api.toggleExplorer = force => { calls.push(force) }
  ready.notify()
  ready.notify()
  editor.toggleExplorer()
  assert.deepEqual(calls, [true, undefined])
})

test('外部文件注册期间切换项目，不能把旧预览加入新项目', async () => {
  let root = '/project-a'
  let resolvePreview
  const calls = []
  const editor = createCorumEditor({ openFile: async p => { calls.push(p) }, openContentDiff: null }, createEditorReadySource(), {
    currentRoot: () => root, toRelativePath: () => null, showEditorRegion() {},
    openExternalPreview: () => new Promise(resolve => { resolvePreview = resolve }),
  })
  const result = editor.openFile('/outside.md')
  await Promise.resolve()
  root = '/project-b'
  resolvePreview({ path: '/@external/old-token' })
  assert.equal((await result).ok, false)
  assert.deepEqual(calls, [])
})

test('读取期间离开又返回同项目，旧请求也不能报告成功并触发行号定位', async () => {
  let version = {}
  let finish
  const editor = createCorumEditor({ openFile: () => new Promise(resolve => { finish = resolve }), openContentDiff: null }, createEditorReadySource(), {
    currentRoot: () => '/project-a', workspaceVersion: () => version,
    toRelativePath: () => '/main.py', showEditorRegion() {},
  })
  const result = editor.openFile('/project-a/main.py')
  await Promise.resolve()
  version = {}
  finish()
  assert.equal((await result).ok, false)
})

test('等待编辑器挂载时切换项目，不能在新项目打开旧相对路径', async () => {
  let root = '/project-a'
  const calls = []
  const api = { openFile: null, openContentDiff: null }
  const ready = createEditorReadySource()
  const editor = createCorumEditor(api, ready, { toRelativePath: () => '/main.py', currentRoot: () => root, showEditorRegion() {} })
  const request = editor.openFile('/project-a/main.py')
  await Promise.resolve()
  root = '/project-b'
  api.openFile = async path => { calls.push(path) }
  ready.notify()
  assert.equal((await request).ok, false)
  assert.deepEqual(calls, [])
})

test('新打开请求替换挂起请求时，旧请求必须结束并明确告知已替换', async () => {
  const api = { openFile: null, openContentDiff: null }
  const ready = createEditorReadySource()
  const editor = createCorumEditor(api, ready, { toRelativePath: p => p, currentRoot: () => '/project', showEditorRegion() {} })
  const first = editor.openFile('/a.py')
  await Promise.resolve()
  const second = editor.openFile('/b.py')
  await Promise.resolve()
  api.openFile = async () => {}
  ready.notify()
  assert.equal((await second).ok, true)
  const result = await Promise.race([first, new Promise(resolve => setTimeout(() => resolve({ ok: 'still pending' }), 20))])
  assert.equal(result.ok, false)
})
