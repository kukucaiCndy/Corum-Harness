import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { TodoPanel } from '../src/client/skeleton/TodoPanel.tsx'
import { zh } from '../src/client/locales.ts'

describe('TODO 卡片的展开方向', () => {
  it('折叠时箭头朝向将展开在按钮下方的任务列表', () => {
    const html = renderToStaticMarkup(<TodoPanel
      todos={[{ content: '检查归档会话', status: 'in_progress' }]}
      t={(key) => zh[key as keyof typeof zh] ?? key}
    />)
    const trigger = html.match(/<button\b[^>]*aria-expanded="false"[^>]*>([\s\S]*?)<\/button>/)?.[1]
    expect(trigger).toBeDefined()
    expect(html).not.toContain('<ul')
    expect(trigger).toContain(renderToStaticMarkup(<IconChevronDownOutline14 size={10} />))
  })
})
