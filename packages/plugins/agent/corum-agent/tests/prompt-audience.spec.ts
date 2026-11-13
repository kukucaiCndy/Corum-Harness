/**
 * 提示词段的读者判定（2026-11-12 必要性审计 §1.2「条件注入」）。
 *
 * 为什么把这些断言落成单测：条件是「哪些会话付哪几百字节」，一旦判据悄悄变成「谁都判不出来
 * ⇒ 谁都注入」，功能上没人会报障，节省会静默归零；反过来若判据把开发类角色判错，开发会话会
 * 丢掉它真正需要的 harness 事实（2026-09-12 的实例误判事故就是事实缺失造成的）。
 *
 * 覆盖三层：
 *   ① 纯函数语义（开发类 / 普通 / 判不出来 fail-open）；
 *   ② 两个包的清单常量**逐字对账**（desktop 为了不把 @corum/* 拉进 shell bundle，留了一份
 *      同口径孪生常量 —— 漂移必须在这里红，而不是实机才发现）；
 *   ③ 两个注册点真的按判据分流（源码扫描：段文本是 `text(context)` 函数且走判据）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEVELOPMENT_AGENT_PRESETS,
  agentPresetOfAssembly,
  isDevelopmentAgentPreset,
  isDevelopmentAssembly,
} from '../src/prompt-audience.ts'

const AGENT_SERVICE_SRC = readFileSync(join(import.meta.dirname, '../src/agent-service.ts'), 'utf8')
const DESKTOP_SRC = readFileSync(join(import.meta.dirname, '../../../../desktop/src/index.ts'), 'utf8')

/** 组装上下文的形状：`AssembleContext.agent.session.header.agentPreset`。 */
function assemblyOf(preset: string | undefined): unknown {
  return { agent: { session: { header: preset === undefined ? {} : { agentPreset: preset } } } }
}

/** 从一个源码文件里抽出 preset 清单常量（字面量数组）。 */
function presetListOf(source: string, label: string): string[] {
  const match = /const DEVELOPMENT_AGENT_PRESETS: readonly string\[\] = \[([^\]]*)\]/.exec(source)
  expect(match, `${label} 里找不到 DEVELOPMENT_AGENT_PRESETS 字面量`).not.toBeNull()
  return [...(match?.[1] ?? '').matchAll(/'([^']*)'/g)].map(m => m[1] as string)
}

describe('读者判定 — 开发类 preset', () => {
  it('开发类清单至少含 corum-dev（扩展包 `contents.presets` 即此 id）', () => {
    expect(DEVELOPMENT_AGENT_PRESETS).toContain('corum-dev')
  })

  it('开发类 ⇒ true；已知的普通 preset ⇒ false', () => {
    expect(isDevelopmentAgentPreset('corum-dev')).toBe(true)
    for (const ordinary of ['standard-mode', 'general-assistant', 'conductor-lead', 'frontend-engineer']) {
      expect(isDevelopmentAgentPreset(ordinary)).toBe(false)
    }
    expect(isDevelopmentAgentPreset(undefined)).toBe(false)
  })

  it('从组装上下文读 preset：有 agent 面就按 header 判，没有则 undefined', () => {
    expect(agentPresetOfAssembly(assemblyOf('corum-dev'))).toBe('corum-dev')
    expect(agentPresetOfAssembly(assemblyOf('standard-mode'))).toBe('standard-mode')
    expect(agentPresetOfAssembly(assemblyOf(undefined))).toBeUndefined()
    expect(agentPresetOfAssembly({})).toBeUndefined()
    expect(agentPresetOfAssembly(undefined)).toBeUndefined()
  })

  it('★ 判不出来 ⇒ fail-open（维持 2026-11-12 之前的全局注入行为）', () => {
    // 无 agent 面（诊断性组装）/ 无 header / rosterless 部署：都当作开发类。
    expect(isDevelopmentAssembly({})).toBe(true)
    expect(isDevelopmentAssembly(undefined)).toBe(true)
    expect(isDevelopmentAssembly(assemblyOf(undefined))).toBe(true)
    // 判得出来时严格按 preset。
    expect(isDevelopmentAssembly(assemblyOf('corum-dev'))).toBe(true)
    expect(isDevelopmentAssembly(assemblyOf('standard-mode'))).toBe(false)
  })
})

describe('★ 孪生清单对账 — corum-agent ↔ packages/desktop/src/index.ts', () => {
  it('两个文件的 DEVELOPMENT_AGENT_PRESETS 逐字一致（顺序也一致）', () => {
    // 为什么是两份：`packages/desktop/src/index.ts` 是桌面壳的 glue 插件，刻意零 `@corum/*`
    // 运行时依赖（否则整个 agent 插件会被拉进 shell bundle），所以它保留同口径常量。
    expect(presetListOf(DESKTOP_SRC, 'desktop/src/index.ts')).toEqual([...DEVELOPMENT_AGENT_PRESETS])
  })

  it('两处都按同一个 header 字段判（agentPreset），不引入第二套口径', () => {
    const AGENT_AUDIENCE_SRC = readFileSync(join(import.meta.dirname, '../src/prompt-audience.ts'), 'utf8')
    for (const [label, source] of [['desktop', DESKTOP_SRC], ['corum-agent', AGENT_AUDIENCE_SRC]] as const) {
      expect(source, label).toContain('header?.agentPreset')
    }
    // anchor 顺序在两侧同款：agent → session → header → agentPreset。
    expect(AGENT_AUDIENCE_SRC).toContain('agent?.session?.header?.agentPreset')
    expect(DESKTOP_SRC).toContain('agent?.session?.header?.agentPreset')
  })
})

describe('★ 两个注册点真的分流（源码扫描）', () => {
  it('host-identity：段文本是 text(context) 函数且走 isDevelopmentAssembly', () => {
    const at = AGENT_SERVICE_SRC.indexOf('name: HOST_IDENTITY_SECTION,')
    expect(at).toBeGreaterThan(-1)
    const body = AGENT_SERVICE_SRC.slice(at, at + 600)
    expect(body).toContain('text: context => hostIdentityText(')
    expect(body).toContain('development: isDevelopmentAssembly(context)')
  })

  it('harness-source：开发类才注入 checkout 位置，否则空串（空段被框架丢弃）', () => {
    const at = DESKTOP_SRC.indexOf("name: 'harness-source',")
    expect(at).toBeGreaterThan(-1)
    const body = DESKTOP_SRC.slice(at, at + 900)
    expect(body).toContain('text: context => isDevelopmentAssembly(context)')
    expect(body).toContain(': \'\',')
    // desktop 侧必须有本地判据函数（说明为何不 import @corum/*：bundle 边界）。
    expect(DESKTOP_SRC).toContain('function isDevelopmentAssembly(context: unknown): boolean')
    expect(DESKTOP_SRC).not.toContain("from '@corum/corum-agent'")
  })
})
