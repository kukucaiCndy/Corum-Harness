/**
 * resolveDefaultTaskProfileId — task 模式默认 Agent 预设解析的机器验证。
 *
 * 0.2.1-rc.3 起：默认预设从 `ctx.agentPresets.defaultId` 读取（registry 公开 getter，
 * `selectedDefault ?? default`）。boot overlay 把用户持久化在 `$DSH_HOME/.default-preset`
 * 的值写入 registry 行的 `config.default`（覆盖 web-app bundle 的 `default: standard`）。
 * settings 命名空间 `agent-presets` 不再作为默认值的运行时来源。
 *
 * 覆盖四条（对应任务规格）：
 *   ① registry 未提供/无 defaultId ⇒ TASK_PROFILE_ID；
 *   ② defaultId 指向存在的 corum profile ⇒ 用它；
 *   ③ defaultId 是官方 preset id（不在 corum 目录）⇒ 放行（mount 时校验）；
 *   ④ defaultId 是不存在的 id ⇒ 放行（warn，mount 处校验，不回落 TASK_PROFILE_ID）。
 *
 * 通路：`resolveDefaultTaskProfileId` 是 private 方法，但 harness 经
 * `Object.create(CorumAgentService.prototype)` 创建被测服务 ⇒ 原型方法可直调。
 * registry 走 `h.provide('agentPresets', { defaultId })` 模拟（与生产 `ctx.get('agentPresets')`
 * 同形，`static inject` 的服务经 `provide` 双向可读）。
 *
 * 真实落盘验证：CORUM_HOME 指向 tmpdir，profile 写在 harness home 里、
 * `loadProfile` 走真实 profile-store 路径（不做 mock）。
 *
 * @module @corum/corum-agent/tests/default-preset
 */
import { describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from './harness.ts'
import type { AgentProfile } from '../src/profile.ts'
import { TASK_PROFILE_ID } from '../src/builtin-profiles.ts'

/** 模拟 agentPresets registry：返回一个含 defaultId getter 的窄面。 */
function mockRegistry(defaultId: string | undefined): unknown {
  return { defaultId }
}

/** 造一个最小 AgentProfile（与既有 spec 同口径）。 */
function profile(id: string): AgentProfile {
  return {
    id,
    baseMode: 'standard',
    prompt: '测试 Agent',
    model: { provider: 'local', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
  }
}

describe('resolveDefaultTaskProfileId (rc3: reads ctx.agentPresets.defaultId)', () => {
  it('① registry 未提供 defaultId ⇒ TASK_PROFILE_ID', () => {
    const h = makeHarness()
    // agentPresets 服务未挂载（ctx.get('agentPresets') 返回 undefined）—— boot 早期容忍。
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe(TASK_PROFILE_ID)
    h.cleanup()
  })

  it('①b registry 挂载但 defaultId 为 undefined ⇒ TASK_PROFILE_ID', () => {
    const h = makeHarness()
    h.provide('agentPresets', mockRegistry(undefined))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe(TASK_PROFILE_ID)
    h.cleanup()
  })

  it('② defaultId 指向存在的 corum profile ⇒ 用它', () => {
    const h = makeHarness()
    h.writeProfile(profile('corum-dev'))
    h.provide('agentPresets', mockRegistry('corum-dev'))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('corum-dev')
    h.cleanup()
  })

  it('③ defaultId 是官方 preset id（不在 corum 目录）⇒ 放行（走 isOfficialPreset 分支）', () => {
    const h = makeHarness()
    // 'standard' 是官方 preset id，loadProfile 查不到 ⇒ resolveDefaultTaskProfileId
    // 放行它（不在 corum 目录、但存在于 agentPresets registry，mount 时再校验）。
    h.provide('agentPresets', mockRegistry('standard'))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('standard')
    h.cleanup()
  })

  it('④ defaultId 是不存在的 id（非官方 preset）⇒ 放行 id（warn，mount 处校验）', () => {
    const h = makeHarness()
    // 'ghost-agent' 既不是 corum profile（未落盘）也不像官方 preset id。
    // resolveDefaultTaskProfileId 无法同步区分「无效 id」与「官方 preset id」
    // ⇒ 放行（同 isOfficialPreset 分支），失效的官方 id 会在 mount 处抛
    // agent-preset/not-found。这是设计取舍：建任务链路不该被一条可能有效的
    // 官方 preset id 卡死。
    h.provide('agentPresets', mockRegistry('ghost-agent'))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('ghost-agent')
    h.cleanup()
  })

  it('④b defaultId 为空白字符串 ⇒ 回落 TASK_PROFILE_ID', () => {
    const h = makeHarness()
    h.provide('agentPresets', mockRegistry('   '))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe(TASK_PROFILE_ID)
    h.cleanup()
  })

  it('④c defaultId 前后有空白 ⇒ trim 后解析', () => {
    const h = makeHarness()
    h.writeProfile(profile('corum-dev'))
    h.provide('agentPresets', mockRegistry('  corum-dev  '))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('corum-dev')
    h.cleanup()
  })
})

describe('readConfiguredDefaultPreset（UI 透传面：不做 TASK_PROFILE_ID 回落）', () => {
  it('registry 未提供 ⇒ undefined（UI 侧回落列表第一项）', () => {
    const h = makeHarness()
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBeUndefined()
    h.cleanup()
  })

  it('registry 挂载但 defaultId 为 undefined ⇒ undefined', () => {
    const h = makeHarness()
    h.provide('agentPresets', mockRegistry(undefined))
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBeUndefined()
    h.cleanup()
  })

  it('defaultId 指向存在 corum profile ⇒ 返回该 id（不回落 TASK_PROFILE_ID）', () => {
    const h = makeHarness()
    h.writeProfile(profile('corum-dev'))
    h.provide('agentPresets', mockRegistry('corum-dev'))
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBe('corum-dev')
    h.cleanup()
  })

  it('defaultId 是官方 preset id ⇒ 仍返回该 id（UI 侧 list.some 判定）', () => {
    const h = makeHarness()
    h.provide('agentPresets', mockRegistry('standard'))
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBe('standard')
    h.cleanup()
  })
})
