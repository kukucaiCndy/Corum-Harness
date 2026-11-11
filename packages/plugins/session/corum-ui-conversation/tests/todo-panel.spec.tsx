import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 图标族 mock：本包既有测试统一 mock `@deepseek-ai/dsh-client-ui-primitives`
 * （`permission-select.spec.tsx` / `code-selection-input.spec.ts` 同款）——该包的
 * 运行时产物在本 checkout 里缺 `simple-icons` 依赖，直接 import 会整文件 fail。
 * mock 成可辨识的 marker，从而断言的是「折叠时到底渲染了哪个方向的箭头」。
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChecklistOutlineMedium: () => <span data-icon="checklist" />,
  IconChevronDownOutlineMedium: () => <span data-icon="chevron-down" />,
  IconChevronUpOutlineMedium: () => <span data-icon="chevron-up" />,
}))

const { TodoPanel } = await import('../src/client/skeleton/TodoPanel.tsx')
const { zh } = await import('../src/client/locales.ts')

/**
 * issue #125：TODO 卡片的箭头方向要跟随展开语义——折叠时朝**下**（提示列表在下方展开），
 * 展开时朝**上**（提示可收起）。与仓库其它卡片（FileToolCard / SubagentCard）一致。
 */
describe('TODO 卡片的展开方向（issue #125）', () => {
  const collapsed = renderToStaticMarkup(
    <TodoPanel
      todos={[{ content: '检查归档会话', status: 'in_progress' }] as never}
      t={(key) => zh[key as keyof typeof zh] ?? key}
    />,
  )
  const trigger = collapsed.match(/<button\b[^>]*aria-expanded="false"[^>]*>([\s\S]*?)<\/button>/)?.[1]

  it('折叠时列表不展开', () => {
    expect(trigger).toBeDefined()
    expect(collapsed).not.toContain('<ul')
  })

  it('折叠时渲染向下箭头（而不是向上）', () => {
    expect(trigger).toContain('data-icon="chevron-down"')
    expect(trigger).not.toContain('data-icon="chevron-up"')
  })
})
