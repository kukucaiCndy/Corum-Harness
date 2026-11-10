/**
 * `script-model-resolution.ts` 单测（2026-10-19）。
 *
 * 背景：用户报障「编排工作流的子 Agent 模型不是全局设置的 glm-5.3-flash 而是
 * DeepSeek-v4-flash」。根因是 SCRIPT 模式经引擎的 `agent()` 不经过 corum 工具层，
 * 子 Agent 模型分档解析只写在 `spawnOne` 里。
 *
 * 本 spec 锁定本模块的**四档**解析行为（会话覆盖 → 预设锁 → 全局兜底 → 跟随主 Agent，
 * 与 `corum-tool-subagent` 的 `resolveChildModel` 逐档一致）+ 路由注入（走
 * `mechanismRoute` 独立通道，保留 driver 的「剥离 + 告知」）。
 */
import { describe, expect, it } from 'vitest'
import type { ResolvedSubagentStartRequest } from '../src/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  applyMechanismRoute,
  FOLLOW_MAIN,
  readGlobalChildModel,
  readPresetChildModel,
  resolveScriptChildModel,
  type AgentPresetsFace,
  type CorumProfilesFace,
  type OrchestrationModelOverrideFace,
  type SettingsGetFace,
} from '../src/isolated/script-model-resolution.ts'

/** 造一个最小 orchestration face（只实现 modelOverrideOf）。 */
function orchestrationWith(
  overrideOf: OrchestrationModelOverrideFace['modelOverrideOf'],
): OrchestrationModelOverrideFace {
  return { modelOverrideOf: overrideOf }
}

/** 造一个最小 settings face（`get(ns)` 只对指定 ns 返回值）。 */
function settingsWith(ns: string, value: unknown): SettingsGetFace {
  return { get: (asked: string) => (asked === ns ? value : undefined) }
}

/** 造一个最小 start request（只带 sessionId）。 */
function request(sessionId: string): ResolvedSubagentStartRequest {
  return {
    parent: { session: { id: sessionId } } as unknown as Agent,
    prompt: [{ type: 'text', text: 'do the thing' }],
    signal: new AbortController().signal,
  } as unknown as ResolvedSubagentStartRequest
}

const GLOBAL = settingsWith('corum-subagent-settings', { defaultModel: { provider: 'zai', model: 'glm-5.3-flash' } })
const PRESET_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }

describe('resolveScriptChildModel — 四档解析（worker 单角色）', () => {
  it('① 会话级覆盖（具体路由）优先', () => {
    const orch = orchestrationWith(() => ({ provider: 'pi-ai', model: 'glm-5.3' }))
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'sess-1', PRESET_ROUTE)
    expect(resolved.tier).toBe('session-override')
    expect(resolved.route).toEqual({ provider: 'pi-ai', model: 'glm-5.3' })
  })

  it('① 会话级覆盖带 reasoningEffort 保留', () => {
    const orch = orchestrationWith(() => ({ provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' }))
    const resolved = resolveScriptChildModel(orch, undefined, 'sess-1')
    expect(resolved.route).toEqual({ provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
  })

  it("① 会话级覆盖 = 'follow-main' 哨兵 ⇒ 直接到 ④（跳过预设锁与全局档）", () => {
    const orch = orchestrationWith(() => FOLLOW_MAIN)
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'sess-1', PRESET_ROUTE)
    expect(resolved.tier).toBe('follow-main')
    expect(resolved.route).toBeUndefined()
  })

  it('① 会话覆盖压过预设锁（两档都有值 ⇒ 会话档胜出）', () => {
    const orch = orchestrationWith(() => ({ provider: 'pi-ai', model: 'session-model' }))
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'sess-1', PRESET_ROUTE)
    expect(resolved.tier).toBe('session-override')
    expect(resolved.route).toEqual({ provider: 'pi-ai', model: 'session-model' })
  })

  it('② 预设锁（具体路由）⇒ 用预设锁，且压过全局档', () => {
    const orch = orchestrationWith(() => undefined)
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'sess-1', PRESET_ROUTE)
    expect(resolved.tier).toBe('preset')
    expect(resolved.route).toEqual(PRESET_ROUTE)
  })

  it('② 预设锁带 reasoningEffort 保留', () => {
    const orch = orchestrationWith(() => undefined)
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'sess-1', { ...PRESET_ROUTE, reasoningEffort: 'high' })
    expect(resolved.tier).toBe('preset')
    expect(resolved.route).toEqual({ ...PRESET_ROUTE, reasoningEffort: 'high' })
  })

  it("② 预设锁 = 'follow-main' ⇒ 跳过全局档，落到 ④（跟随主 Agent）", () => {
    const orch = orchestrationWith(() => undefined)
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'sess-1', FOLLOW_MAIN)
    expect(resolved.tier).toBe('follow-main')
    expect(resolved.route).toBeUndefined()
  })

  it('② 预设没配（undefined）⇒ 走全局档（与「显式跟随」是不同状态）', () => {
    const orch = orchestrationWith(() => undefined)
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'sess-1', undefined)
    expect(resolved.tier).toBe('global')
    expect(resolved.route).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
  })

  it('② 预设锁为空串路由 ⇒ 视为没配，走全局档', () => {
    const orch = orchestrationWith(() => undefined)
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'sess-1', { provider: '', model: '' })
    expect(resolved.tier).toBe('global')
  })

  it('③ 全局兜底（corum-subagent 的 defaultModel）次之', () => {
    const orch = orchestrationWith(() => undefined)
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'sess-1')
    expect(resolved.tier).toBe('global')
    expect(resolved.route).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
  })

  it('④ 会话覆盖缺失 + 预设没配 + 全局未配 ⇒ 跟随主 Agent', () => {
    const orch = orchestrationWith(() => undefined)
    const resolved = resolveScriptChildModel(orch, undefined, 'sess-1')
    expect(resolved.tier).toBe('follow-main')
    expect(resolved.route).toBeUndefined()
  })

  it('orchestration 服务缺席 + 全局未配 ⇒ 跟随主 Agent（不阻断委派）', () => {
    const resolved = resolveScriptChildModel(undefined, undefined, 'sess-1')
    expect(resolved.tier).toBe('follow-main')
    expect(resolved.route).toBeUndefined()
  })

  it('orchestration 服务缺席 + 全局已配 ⇒ 用全局', () => {
    const resolved = resolveScriptChildModel(undefined, GLOBAL, 'sess-1')
    expect(resolved.tier).toBe('global')
    expect(resolved.route).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
  })

  it('orchestration 服务缺席 + 预设锁已配 ⇒ 用预设锁', () => {
    const resolved = resolveScriptChildModel(undefined, GLOBAL, 'sess-1', PRESET_ROUTE)
    expect(resolved.tier).toBe('preset')
    expect(resolved.route).toEqual(PRESET_ROUTE)
  })
})

describe('readGlobalChildModel — corum-subagent namespace 读取（settings.get）', () => {
  it('settings 缺席 ⇒ undefined', () => {
    expect(readGlobalChildModel(undefined)).toBeUndefined()
  })

  it('get 缺席 ⇒ undefined', () => {
    expect(readGlobalChildModel({})).toBeUndefined()
  })

  it('namespace 未注册（get 返回 undefined）⇒ undefined', () => {
    expect(readGlobalChildModel(settingsWith('other-ns', { defaultModel: { provider: 'zai', model: 'glm-5.3-flash' } }))).toBeUndefined()
  })

  it('defaultModel 空 provider/model ⇒ undefined（空串不算配置）', () => {
    const settings = settingsWith('corum-subagent-settings', { defaultModel: { provider: '', model: '' } })
    expect(readGlobalChildModel(settings)).toBeUndefined()
  })

  it('defaultModel 缺席（只有其它键）⇒ undefined', () => {
    expect(readGlobalChildModel(settingsWith('corum-subagent-settings', { maxParallelChildren: 4 }))).toBeUndefined()
  })

  it('get 抛错 ⇒ undefined（不阻断）', () => {
    const settings: SettingsGetFace = { get: () => { throw new Error('boom') } }
    expect(readGlobalChildModel(settings)).toBeUndefined()
  })

  it('正常值 ⇒ 返回路由', () => {
    const settings = settingsWith('corum-subagent-settings', { defaultModel: { provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' } })
    expect(readGlobalChildModel(settings)).toEqual({ provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' })
  })

  it('★ 只调用 get（不再走 describe 的全量克隆）', () => {
    let described = 0
    const settings = {
      get: () => ({ defaultModel: { provider: 'zai', model: 'glm-5.3-flash' } }),
      describe: () => { described += 1; return [] },
    } as unknown as SettingsGetFace
    expect(readGlobalChildModel(settings)).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
    expect(described).toBe(0)
  })
})

describe('readPresetChildModel — 预设锁取数（agentPresets + corumAgent）', () => {
  /** 造一个最小 presets face（composedPreset 返回指定 id 或抛错）。 */
  function presetsOf(id: string | undefined | (() => never)): AgentPresetsFace {
    return { composedPreset: () => (typeof id === 'function' ? id() : id) }
  }

  /** 造一个最小 corumAgent face（listProfiles 返回指定 roster）。 */
  function profilesOf(
    roster: { id: string; subagentModel?: unknown }[] | (() => Promise<never>),
  ): CorumProfilesFace {
    return {
      listProfiles: () => (typeof roster === 'function'
        ? roster()
        : Promise.resolve({ profiles: roster })) as Promise<{ profiles: readonly { id: string; subagentModel?: never }[] }>,
    }
  }

  it('preset id + 具体路由 ⇒ 返回该路由', async () => {
    const value = await readPresetChildModel(
      presetsOf('conductor-lead'),
      profilesOf([{ id: 'conductor-lead', subagentModel: PRESET_ROUTE }]),
      {},
    )
    expect(value).toEqual(PRESET_ROUTE)
  })

  it("★ 预设锁 = 'follow-main' ⇒ 原样返回哨兵（不能在取数层折叠成 undefined）", async () => {
    const value = await readPresetChildModel(
      presetsOf('conductor-lead'),
      profilesOf([{ id: 'conductor-lead', subagentModel: FOLLOW_MAIN }]),
      {},
    )
    expect(value).toBe(FOLLOW_MAIN)
  })

  it('预设没配 subagentModel ⇒ undefined（= 无预设锁）', async () => {
    const value = await readPresetChildModel(
      presetsOf('conductor-lead'),
      profilesOf([{ id: 'conductor-lead' }]),
      {},
    )
    expect(value).toBeUndefined()
  })

  it('preset id 查不到 profile ⇒ undefined', async () => {
    const value = await readPresetChildModel(
      presetsOf('conductor-lead'),
      profilesOf([{ id: 'general-assistant', subagentModel: PRESET_ROUTE }]),
      {},
    )
    expect(value).toBeUndefined()
  })

  it('presets 服务缺席 ⇒ undefined（不阻断）', async () => {
    expect(await readPresetChildModel(undefined, profilesOf([]), {})).toBeUndefined()
  })

  it('preset id 为空（未组合出 preset）⇒ undefined', async () => {
    expect(await readPresetChildModel(presetsOf(undefined), profilesOf([]), {})).toBeUndefined()
    expect(await readPresetChildModel(presetsOf(''), profilesOf([]), {})).toBeUndefined()
  })

  it('corumAgent 服务缺席 ⇒ undefined（不阻断）', async () => {
    expect(await readPresetChildModel(presetsOf('conductor-lead'), undefined, {})).toBeUndefined()
  })

  it('composedPreset 抛错 ⇒ undefined（不阻断）', async () => {
    const value = await readPresetChildModel(presetsOf(() => { throw new Error('boom') }), profilesOf([]), {})
    expect(value).toBeUndefined()
  })

  it('listProfiles 抛错 ⇒ undefined（不阻断）', async () => {
    const value = await readPresetChildModel(
      presetsOf('conductor-lead'),
      profilesOf(() => Promise.reject(new Error('boom')) as Promise<never>),
      {},
    )
    expect(value).toBeUndefined()
  })

  it('★ 只实现 listProfilesRemote（服务实例的真实方法名）⇒ 仍能取到预设锁', async () => {
    // 实机证据（2026-10-19 :9333 探针）：`CorumAgentService` 的原型上只有
    // `listProfilesRemote`——`@Remote('listProfiles')` 只改线上导出名，不改方法名。
    // 旧实现按 `listProfiles` 取 ⇒ `typeof !== 'function'` ⇒ 预设锁**静默**降级。
    const face: CorumProfilesFace = {
      listProfilesRemote: () => Promise.resolve({ profiles: [{ id: 'conductor-lead', subagentModel: PRESET_ROUTE }] }),
    }
    expect(await readPresetChildModel(presetsOf('conductor-lead'), face, {})).toEqual(PRESET_ROUTE)
  })

  it('两个方法名都在时优先 listProfilesRemote（真实方法名）', async () => {
    const face: CorumProfilesFace = {
      listProfilesRemote: () => Promise.resolve({ profiles: [{ id: 'conductor-lead', subagentModel: PRESET_ROUTE }] }),
      listProfiles: () => Promise.resolve({ profiles: [{ id: 'conductor-lead', subagentModel: FOLLOW_MAIN }] }),
    }
    expect(await readPresetChildModel(presetsOf('conductor-lead'), face, {})).toEqual(PRESET_ROUTE)
  })

  it('把父 Agent 的 ctx 原样传给 composedPreset（preset 从活的 scope 链读）', async () => {
    let received: unknown
    const presets: AgentPresetsFace = { composedPreset: (agentCtx) => { received = agentCtx; return 'conductor-lead' } }
    const parentCtx = { marker: 'parent-scope' }
    await readPresetChildModel(presets, profilesOf([{ id: 'conductor-lead' }]), parentCtx)
    expect(received).toBe(parentCtx)
  })
})

describe('applyMechanismRoute — 机制路由走独立通道（保留剥离 + 告知）', () => {
  it('route = undefined ⇒ 原样返回请求（跟随主 Agent）', () => {
    const req = request('sess-1')
    const result = applyMechanismRoute(req, undefined)
    expect(result).toBe(req)
  })

  it('★ route = 具体路由 ⇒ 写 mechanismRoute，**不碰** agentOptions / 不打机制标记', () => {
    const req = request('sess-1')
    const result = applyMechanismRoute(req, { provider: 'zai', model: 'glm-5.3-flash' })
    expect(result).not.toBe(req)
    expect(result.mechanismRoute).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
    // 关键：agentOptions 不被替换、不打标记 ⇒ driver 仍会剥离脚本路由并告知。
    expect(result.agentOptions).toBeUndefined()
    expect(result.agentOptionsOwnedByMechanism).toBeUndefined()
  })

  it('脚本原传的 agentOptions 原样保留（供 driver 剥离 + 告知）', () => {
    const req = {
      ...request('sess-1'),
      agentOptions: { provider: 'script-provider', model: 'script-model', maxTokens: 4096 },
    } as unknown as ResolvedSubagentStartRequest
    const result = applyMechanismRoute(req, { provider: 'zai', model: 'glm-5.3-flash' })
    expect(result.agentOptions).toEqual({ provider: 'script-provider', model: 'script-model', maxTokens: 4096 })
    expect(result.mechanismRoute).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
  })

  it('route 带 reasoningEffort ⇒ mechanismRoute 含 reasoningEffort', () => {
    const result = applyMechanismRoute(request('sess-1'), { provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' })
    expect(result.mechanismRoute).toMatchObject({ provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' })
  })

  it('route reasoningEffort 空串 ⇒ 不写 reasoningEffort', () => {
    const result = applyMechanismRoute(request('sess-1'), { provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: '' })
    expect(result.mechanismRoute).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
  })
})

describe('用户报障场景：全局设 glm-5.3-flash，主 Agent 跑 deepseek-v4-flash', () => {
  it('全局 defaultModel=glm-5.3-flash ⇒ 脚本子 Agent 解析到 global 档（非父路由）', () => {
    // 主 Agent（general-assistant）跑 deepseek-official/deepseek-v4-flash；
    // 用户在全局设置把子 Agent 默认模型设成 zai/glm-5.3-flash。
    const orch = orchestrationWith(() => undefined) // 无会话级覆盖
    const resolved = resolveScriptChildModel(orch, GLOBAL, 'corum-task-xyz')
    expect(resolved.tier).toBe('global')
    expect(resolved.route).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
    // 注入后子 Agent 跑 glm-5.3-flash（不是父的 deepseek-v4-flash）
    const routed = applyMechanismRoute(request('corum-task-xyz'), resolved.route)
    expect(routed.mechanismRoute).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
  })
})

describe('两条委派路径同口径（本轮修的核心缺陷）', () => {
  it('★ 预设锁了 subagentModel ⇒ 脚本路径与 subagent 工具路径跑同一个模型', () => {
    // 同一会话：预设 conductor-lead 锁了 deepseek-v4.1-flash，全局默认是 glm-5.3-flash。
    // 工具路径（spawnOne → resolveChildModel）走「预设锁」档；
    // 脚本路径（本模块）必须同样走「预设锁」档，而不是全局档。
    const resolved = resolveScriptChildModel(
      orchestrationWith(() => undefined),
      GLOBAL,
      'corum-task-xyz',
      PRESET_ROUTE,
    )
    expect(resolved.tier).toBe('preset')
    expect(resolved.route).toEqual(PRESET_ROUTE)
    // 旧三档实现在这里会返回 tier='global' + glm-5.3-flash（模型不一致）。
    expect(resolved.route).not.toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
  })
})
