import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMinimapViewport } from '../lib/types/client/editor/minimap-viewport.js'

test('透明小地图独占右侧区域，水平滚动和缩放后仍隔开正文，关闭后释放空间', () => {
  const content = { style: { clipPath: '' } }
  const listeners = new Map()
  let scroll = 0
  let mounted = false
  let minimap = { renderMinimap: 2, minimapLeft: 350 }
  const on = key => fn => { listeners.set(key, fn); return { dispose() { listeners.delete(key) } } }
  const dispose = installMinimapViewport({
    getDomNode: () => ({ querySelector: () => mounted ? content : null }),
    getLayoutInfo: () => ({ contentLeft: 44, minimap }),
    getScrollLeft: () => scroll,
    onDidLayoutChange: on('layout'), onDidScrollChange: on('scroll'),
    onDidChangeModel: on('model'),
  })
  assert.equal(content.style.clipPath, '')
  mounted = true
  listeners.get('model')()
  assert.equal(content.style.clipPath, 'inset(0 calc(100% - 298px) 0 0px)')
  scroll = 500
  listeners.get('scroll')()
  assert.equal(content.style.clipPath, 'inset(0 calc(100% - 798px) 0 500px)')
  minimap = { renderMinimap: 2, minimapLeft: 250 }
  listeners.get('layout')()
  assert.equal(content.style.clipPath, 'inset(0 calc(100% - 698px) 0 500px)')
  minimap = { renderMinimap: 0, minimapLeft: 0 }
  listeners.get('layout')()
  assert.equal(content.style.clipPath, '')
  dispose()
  assert.equal(listeners.size, 0)
})
