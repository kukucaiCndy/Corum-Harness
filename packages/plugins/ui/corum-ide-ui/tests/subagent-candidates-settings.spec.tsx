import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CorumSettingsContext, type CorumSettingsFace } from '../src/client/settings/shared.tsx'
import { AgentSettingsSection } from '../src/client/settings/sections/SettingsAgentSettingsSection.tsx'

// 本用例只验证候选设置组，排除既有 SelectField 的浏览器布局 effect。
vi.mock('../src/client/settings/SelectField.tsx', () => ({ SelectField: () => null }))

describe('智能体设置候选模型入口', () => {
  it('展示已保存候选路由与用户说明，目录缺席时仍可编辑原选择', () => {
    const settings: CorumSettingsFace = {
      describe: {
        getSnapshot: () => ({ status: 'ready', error: null, view: { writable: true, namespaces: [
          { ns: 'subagent-model-selection', revision: 3, value: { enabled: true, allowedModels: [{ provider: 'local', model: 'vision', description: '多模态与长上下文' }] } },
        ] } }),
        subscribe: () => () => {}, ensure: async () => {}, acceptView: () => {},
      },
      mutate: async () => ({ ok: true }),
    }
    const html = renderToStaticMarkup(<CorumSettingsContext.Provider value={settings}><AgentSettingsSection /></CorumSettingsContext.Provider>)
    expect(html).toContain('子 Agent 候选模型')
    expect(html).toContain('local/vision')
    expect(html).toContain('多模态与长上下文')
    expect(html).toContain('保存候选模型')
  })
})
