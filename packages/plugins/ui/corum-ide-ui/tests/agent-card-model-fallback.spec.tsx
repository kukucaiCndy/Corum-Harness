/**
 * Agent 名片卡 —— 模型投影缺失时必须**安全渲染**（防御修复）。
 *
 * ## 缺陷形态（源码可判定，实机未复现）
 *
 * 名片此前直读 `profile.model.model`。host 的 `listProfilesRemote` 是 `model: p.model`
 * 直读（`agent-service.ts:1188`），而 `p` 来自 `profile-store.ts:64` 的
 * `JSON.parse(...) as AgentProfile` —— **零校验**。于是盘上任何一份缺 `model` 的
 * `agent.json`（装进来的模块预设已经实测缺过 `terminal` / `memoryPolicy`，同一形态）
 * 会让 `profile.model` 为 `undefined`，直读即 `TypeError: Cannot read properties of
 * undefined (reading 'model')` —— 一张坏卡把设置页「Agent 预设」**整页打白屏**。
 *
 * ## 这里钉住什么
 *
 *   ① 真实静态渲染（`renderToStaticMarkup`，不挂 DOM）：`model` 缺失三种形态
 *      （整份 undefined / null / 只有 provider 没有 model）都**不抛**，且显示兜底文案
 *      `未记录`（与 `session-bar.tsx:517` 的既有说法一致，不新造术语）；
 *   ② 正常模型**原样**显示（兜底不吞真实值）；
 *   ③ 源码不变式：组件不再直读 `.model.model`，且兜底只经 `agent-model.ts` 的
 *      `agentModelLabel` 这一个点（两处兜底文案不可能分叉）。
 *
 * ⚠️ 这是**防御修复**：它证明坏数据不再炸页面，**不等于**那条实机 BUG 已复现/已关闭。
 * 根因（host 侧直读未校验）仍在 host，本轮不动它。
 * @module @corum/corum-ide-ui/tests/agent-card-model-fallback
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentCard } from '../src/client/settings/sections/SettingsAgentPresetsSection.tsx'
import { MISSING_MODEL_LABEL, agentModelLabel, agentModelRoute } from '../src/client/settings/sections/agent-model.ts'

type CardProfile = Parameters<typeof AgentCard>[0]['profile']

/** 造一份最小 profile；`model` 故意走 `unknown`，以便传入真实运行时可能出现的不完整形状。 */
function profileWith(model: unknown): CardProfile {
  return {
    id: 'demo-agent',
    nickname: '演示 Agent',
    prompt: '一个安静的助手',
    model,
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    version: 1,
    trust: 'user',
    source: 'corum',
  } as unknown as CardProfile
}

function render(model: unknown): string {
  return renderToStaticMarkup(<AgentCard profile={profileWith(model)} onClick={() => {}} />)
}

const SECTION = readFileSync(
  join(import.meta.dirname, '../src/client/settings/sections/SettingsAgentPresetsSection.tsx'),
  'utf8',
)

/** 剥掉注释（`/* … *​/` 与行内 `//`），判据只看代码，说明性文字里提到字段是正当的。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const CODE = stripComments(SECTION)

describe('Agent 名片卡 — 模型缺失时安全渲染', () => {
  it('model 整份 undefined ⇒ 不抛，显示兜底文案', () => {
    const html = render(undefined)
    expect(html).toContain(MISSING_MODEL_LABEL)
    // 名片其余部分照常渲染（一张坏卡不连坐整页、也不把自己渲染成空壳）。
    expect(html).toContain('data-agent-preset-id="demo-agent"')
  })

  it('model 为 null ⇒ 不抛，显示兜底文案', () => {
    expect(render(null)).toContain(MISSING_MODEL_LABEL)
  })

  it('有 model 但缺 model.model ⇒ 不抛，显示兜底文案', () => {
    expect(render({ provider: 'deepseek-official' })).toContain(MISSING_MODEL_LABEL)
  })

  it('model.model 为空串 ⇒ 视为未配（不显示空白格）', () => {
    expect(render({ provider: 'deepseek-official', model: '' })).toContain(MISSING_MODEL_LABEL)
  })

  it('正常 model ⇒ 原样显示模型 id（兜底不吞真实值）', () => {
    const html = render({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(html).toContain('deepseek-v4-flash')
    expect(html).not.toContain(MISSING_MODEL_LABEL)
  })
})

describe('兜底逻辑本身（agent-model.ts）', () => {
  it('agentModelLabel：缺失回落「未记录」，正常值逐字返回', () => {
    expect(agentModelLabel(undefined)).toBe(MISSING_MODEL_LABEL)
    expect(agentModelLabel(null)).toBe(MISSING_MODEL_LABEL)
    expect(agentModelLabel({ provider: 'p' } as unknown as { provider: string; model: string })).toBe(MISSING_MODEL_LABEL)
    expect(agentModelLabel({ provider: 'p', model: 'm' })).toBe('m')
    // 空白串不算「有模型」，但非空值一律原样（不做 trim 改写）。
    expect(agentModelLabel({ provider: 'p', model: ' m ' })).toBe(' m ')
  })

  it('agentModelRoute：provider/model 任一缺失即 undefined（编辑页保持「未选」而不是伪造路由）', () => {
    expect(agentModelRoute(undefined)).toBeUndefined()
    expect(agentModelRoute(null)).toBeUndefined()
    expect(agentModelRoute({ provider: 'p' } as unknown as { provider: string; model: string })).toBeUndefined()
    expect(agentModelRoute({ model: 'm' } as unknown as { provider: string; model: string })).toBeUndefined()
    expect(agentModelRoute({ provider: '', model: 'm' })).toBeUndefined()
    const route = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
    expect(agentModelRoute(route)).toBe(route)
  })
})

describe('源码不变式 — 名片与编辑页都不再直读 `.model.model`', () => {
  it('名片渲染走 agentModelLabel(profile.model)', () => {
    expect(CODE).toContain('agentModelLabel(profile.model)')
  })

  it('文件里没有裸读 profile.model.model / p.model.model', () => {
    expect(CODE).not.toMatch(/profile\.model\.model/)
    expect(CODE).not.toMatch(/\bp\.model\.(model|provider|reasoningEffort)\b/)
  })
})
