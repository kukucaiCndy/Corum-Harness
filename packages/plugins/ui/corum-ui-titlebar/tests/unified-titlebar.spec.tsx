import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TitleBar, type TitleBarProps } from '../src/client/TitleBar.tsx'

afterEach(() => { vi.unstubAllGlobals() })

it('折叠侧栏后仍可切换编辑器和终端，窗口按钮不依赖当前会话', () => {
  vi.stubGlobal('window', { corumDesktop: { getPlatform: () => 'win32' } })
  const props = {
    variant: 'main', bandWidth: 1200, controlsWidth: 300,
    useChrome: (select: (s: unknown) => unknown) => select({ sidebarCollapsed: true }),
    useSessionBand: (select: (s: unknown) => unknown) => select({ key: undefined }),
    useSessions: (select: (s: unknown) => unknown) => select({ current: undefined, byId: {} }),
    toggleSidebarCollapsed() {}, toggleRegion() {}, toggleExplorer() {}, closeSession() {},
    renderSlot() { throw new Error('全局标题栏不应占用会话统计槽') },
  } as unknown as TitleBarProps
  const html = renderToStaticMarkup(<TitleBar {...props} />)
  expect(html).toContain('显示/隐藏 编辑器')
  expect(html).toContain('显示/隐藏 资源管理器')
  expect(html).toContain('显示/隐藏 终端')
  expect(html).toContain('最小化')
  expect(html).toContain('最大化')
  // Electron 启动页沿用此挂载标记，布局调整后也必须能结束等待。
  expect(html).toContain('data-session-band=')
  // 撤回左侧首页大按钮后，品牌入口仍可返回首页并保留历史。
  expect(html).toContain('aria-label="返回首页"')
})
