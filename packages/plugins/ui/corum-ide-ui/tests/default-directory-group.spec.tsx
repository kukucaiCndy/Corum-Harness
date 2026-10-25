import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
const view = vi.hoisted(() => ({ state: {} as any, effects: [] as (() => unknown)[] }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: (effect: () => unknown) => { view.effects.push(effect) } }))
vi.mock('react-dom', async original => ({ ...await original<typeof import('react-dom')>(), createPortal: (node: unknown) => node }))
vi.mock('../src/client/settings/sections/default-session-directory-controller.ts', () => ({ createDefaultDirectoryController: () => ({ subscribe: () => () => {}, getSnapshot: () => view.state, load: async () => {}, pick: async () => {}, migrate: async () => {}, cancel: () => {} }) }))
import { DefaultSessionDirectoryGroup } from '../src/client/settings/sections/DefaultSessionDirectoryGroup.tsx'
import { DefaultDirectoryNoticeContext, type DefaultDirectoryNotice } from '../src/client/settings/default-directory-resume.ts'
const api = { getDefaultSessionDirectory() {}, pickDefaultSessionDirectory() {}, migrateDefaultSessionDirectory() {}, reloadDefaultSessionDirectory() {} }
function render(notice: DefaultDirectoryNotice | null = null) {
  const events = new EventTarget()
  // 无 DOM 树的测试装置：统一 capture 参数，避免 Node EventTarget 的 boolean 移除差异。
  vi.stubGlobal('window', { corumDesktop: api }); vi.stubGlobal('document', {
    body: {}, addEventListener: (name: string, listener: EventListener) => events.addEventListener(name, listener),
    removeEventListener: (name: string, listener: EventListener) => events.removeEventListener(name, listener),
    dispatchEvent: (event: Event) => events.dispatchEvent(event),
  })
  view.effects = []
  return renderToStaticMarkup(<DefaultDirectoryNoticeContext.Provider value={notice}><DefaultSessionDirectoryGroup hasUnsavedChanges={() => false} /></DefaultDirectoryNoticeContext.Provider>)
}
afterEach(() => { vi.unstubAllGlobals() })
it('显示完整路径、会话数量和明确确认操作；首次访问不冒充迁移成功', () => {
  view.state = { status: { root: 'E:/完整/默认目录', sessionCount: 8, migration: null }, target: 'C:/完整/新目录', busy: false, picking: false, error: '' }
  const html = render()
  for (const text of ['E:/完整/默认目录', 'C:/完整/新目录', '8 个会话', '迁移并重启', '取消']) expect(html).toContain(text)
  expect(html).not.toContain('迁移完成')
  expect(render('migrated')).toContain('迁移完成')
  view.state.status.error = '目标冲突，已恢复原位置'; expect(render('migrated')).not.toContain('迁移完成'); expect(render('migrated')).toContain('目标冲突，已恢复原位置')
})
it('迁移时遮罩锁定页面，禁用按钮，阻止 Escape/返回快捷键；完成卸载后恢复键盘', () => {
  view.state = { status: { root: 'E:/old', sessionCount: 3, migration: { phase: 'files', completed: 1, total: 3 } }, target: 'C:/new', busy: true, picking: false, error: '' }
  const html = render()
  expect(html).toContain('aria-modal="true"'); expect(html).toContain('复制并校验文件 · 1 / 3')
  expect(html.match(/disabled=""/g)).toHaveLength(3)
  const cleanup = view.effects.map(effect => effect()).filter((value): value is () => void => typeof value === 'function')
  const event = new Event('keydown', { cancelable: true }); document.dispatchEvent(event); expect(event.defaultPrevented).toBe(true)
  cleanup.forEach(dispose => dispose())
  const after = new Event('keydown', { cancelable: true }); document.dispatchEvent(after); expect(after.defaultPrevented).toBe(false)
})
