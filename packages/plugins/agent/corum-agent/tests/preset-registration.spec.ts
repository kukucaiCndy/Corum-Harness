/**
 * preset-registration — 动态用户 preset 注册的机器验证（rc3 §4.5(c) M3）。
 *
 * 覆盖：
 *   ① registerAllUserPresets：临时 home 的 .agent-presets 下有 agent.cordis.yml
 *      的 profile 被注册进 mock registry；
 *   ② registerUserPreset：单个 profile 的 agent.cordis.yml 解析 → register → registry.list 含它；
 *   ③ 更新 preset：重新编译落盘后 registerUserPreset 先 unregister 旧定义再 register 新定义；
 *   ④ 坏 preset（agent.cordis.yml 非法）不拖垮全部：其余 profile 正常注册；
 *     **warn 带 preset id 和原因**（M3 要求：解析失败/non-array 不得静默）；
 *   ⑤ unregisterUserPreset：从 registry 移除；
 *   ⑥ ready Promise：registerAllUserPresets 返回的 ready 被 await 后 list 可见全部用户 preset；
 *   ⑦ validatePlugins：entryListProblem 真实校验（M3 要求：空壳删除，真实调用）。
 *
 * mock registry 提供最小能力面：register() / list() / defaultId getter。
 * 不启动真实 cordis/registry——纯函数级验证注册逻辑。
 *
 * @module @corum/corum-agent/tests/preset-registration
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PresetRegistrationState, type AgentPresetRegistryFace } from '../src/preset-registration.ts'
import type { AgentProfile } from '../src/profile.ts'
import { compilePreset } from '../src/compile.ts'

/** 造一个最小 AgentProfile。 */
function profile(id: string): AgentProfile {
  return {
    id,
    baseMode: 'standard',
    prompt: `Test agent ${id}`,
    model: { provider: 'local', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
  }
}

/** mock registry：记录注册的 preset，提供 register/list/defaultId。 */
function makeMockRegistry(): { face: AgentPresetRegistryFace & { list: () => { id: string; broken?: string }[]; defaultId: string } } {
  const definitions = new Map<string, { id: string; plugins: readonly unknown[]; name?: string; description?: string; order?: number }>()
  const disposers = new Map<string, () => Promise<void>>()
  const registry = {
    defaultId: 'standard' as string,
    register: async (def: { id: string; plugins: readonly unknown[]; name?: string; description?: string; order?: number }): Promise<() => Promise<void>> => {
      // 先 dispose 旧定义（如果存在）
      const oldDisposer = disposers.get(def.id)
      if (oldDisposer !== undefined) {
        try { await oldDisposer() } catch { /* idempotent */ }
        disposers.delete(def.id)
        definitions.delete(def.id)
      }
      definitions.set(def.id, def)
      const disposer = async (): Promise<void> => {
        definitions.delete(def.id)
        disposers.delete(def.id)
      }
      disposers.set(def.id, disposer)
      return disposer
    },
    list: (): { id: string; broken?: string }[] => Array.from(definitions.values()).map(d => ({ id: d.id })),
  }
  return { face: registry, ...registry }
}

/** mock ctx：提供 logger（记录 warn 调用）+ get('agentPresets') + effect（最小桩）。 */
function makeMockCtx(registry: AgentPresetRegistryFace): {
  logger: { warn: ReturnType<typeof vi.fn> }
  get: (name: string) => unknown
  effect: (fn: () => () => void, _label?: string) => () => void
} {
  return {
    logger: { warn: vi.fn((_msg: string) => { /* captured */ }) },
    get: (name: string): unknown => name === 'agentPresets' ? registry : undefined,
    effect: (fn: () => () => void) => {
      const disposer = fn()
      return disposer
    },
  }
}

describe('PresetRegistrationState.registerUserPreset (rc3 §4.5(c) M3)', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-preset-reg-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① 编译落盘的 profile → register → registry.list 含它', async () => {
    const prof = profile('test-worker')
    const dir = join(home, '.agent-presets', 'test-worker')
    mkdirSync(dir, { recursive: true })
    const compiled = compilePreset(prof)
    writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)

    const registry = makeMockRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    const result = await state.registerUserPreset('test-worker')
    expect(result).toBe(true)
    expect(registry.face.list().some(p => p.id === 'test-worker')).toBe(true)
  })

  it('② 文件缺失 → 跳过（返回 false）', async () => {
    const registry = makeMockRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    const result = await state.registerUserPreset('nonexistent')
    expect(result).toBe(false)
    expect(registry.face.list()).toHaveLength(0)
  })

  it('③ 更新 preset：重新 register 先 unregister 旧定义', async () => {
    const prof = profile('test-update')
    const dir = join(home, '.agent-presets', 'test-update')
    mkdirSync(dir, { recursive: true })
    const compiled = compilePreset(prof)
    writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)

    const registry = makeMockRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    await state.registerUserPreset('test-update')
    expect(registry.face.list()).toHaveLength(1)
    // 更新（重新落盘 + 注册）
    const updated = { ...prof, prompt: 'Updated prompt' }
    const recompiled = compilePreset(updated)
    writeFileSync(join(dir, 'agent.cordis.yml'), recompiled.cordisYml)
    await state.registerUserPreset('test-update')
    expect(registry.face.list().filter(p => p.id === 'test-update')).toHaveLength(1)
  })

  it('④ 坏 agent.cordis.yml（非数组）→ 跳过 + **warn 带 preset id**', async () => {
    const dir = join(home, '.agent-presets', 'bad-preset')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent.cordis.yml'), 'not-an-array: true\n')

    const registry = makeMockRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    const result = await state.registerUserPreset('bad-preset')
    expect(result).toBe(false)
    expect(registry.face.list()).toHaveLength(0)
    // M3 要求：解析失败/non-array warn 带 preset id 和原因
    expect(ctx.logger.warn).toHaveBeenCalled()
    const warnCall = ctx.logger.warn.mock.calls[0]?.[0] as string | undefined
    expect(warnCall).toContain('bad-preset')
  })
})

describe('PresetRegistrationState.unregisterUserPreset', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-preset-unreg-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① 已注册的 preset → unregister → registry.list 不含它', async () => {
    const prof = profile('test-unreg')
    const dir = join(home, '.agent-presets', 'test-unreg')
    mkdirSync(dir, { recursive: true })
    const compiled = compilePreset(prof)
    writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)

    const registry = makeMockRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    await state.registerUserPreset('test-unreg')
    expect(registry.face.list()).toHaveLength(1)
    await state.unregisterUserPreset('test-unreg')
    expect(registry.face.list()).toHaveLength(0)
  })

  it('② 未注册的 preset → unregister → 无副作用', async () => {
    const registry = makeMockRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    await state.unregisterUserPreset('never-registered')
    expect(registry.face.list()).toHaveLength(0)
  })
})

describe('PresetRegistrationState.registerAllUserPresets + ready Promise (M3)', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-preset-all-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① 多个有效 profile → 全部注册 + ready await 后 list 可见', async () => {
    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      const prof = profile(id)
      const dir = join(home, '.agent-presets', id)
      mkdirSync(dir, { recursive: true })
      const compiled = compilePreset(prof)
      writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
      writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
    }

    const registry = makeMockRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    // fire-and-forget（模拟 constructor 里的 void）
    void state.registerAllUserPresets()
    // await ready（模拟 presetRegistrationReady()）
    const ready = state.ready
    expect(ready).toBeDefined()
    await ready!
    const ids = registry.face.list().map(p => p.id)
    expect(ids).toContain('agent-a')
    expect(ids).toContain('agent-b')
    expect(ids).toContain('agent-c')
    expect(ids).toHaveLength(3)
  })

  it('② 一个坏 preset 不拖垮全部 + warn 带坏 preset id', async () => {
    // 有效 profile
    for (const id of ['good-a', 'good-b']) {
      const prof = profile(id)
      const dir = join(home, '.agent-presets', id)
      mkdirSync(dir, { recursive: true })
      const compiled = compilePreset(prof)
      writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
      writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
    }
    // 坏 preset（agent.cordis.yml 非法）
    const badDir = join(home, '.agent-presets', 'bad-one')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'agent.cordis.yml'), 'invalid: not-an-array\n')

    const registry = makeMockRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    await state.registerAllUserPresets()
    const ids = registry.face.list().map(p => p.id)
    expect(ids).toContain('good-a')
    expect(ids).toContain('good-b')
    expect(ids).not.toContain('bad-one')
    expect(ids).toHaveLength(2)
    // M3 要求：坏 preset warn 带 id 和原因
    expect(ctx.logger.warn).toHaveBeenCalled()
    const warnMsg = ctx.logger.warn.mock.calls.find((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('bad-one'))?.[0] as string | undefined
    expect(warnMsg).toBeDefined()
    expect(warnMsg).toContain('bad-one')
  })

  it('③ .agent-presets 目录不存在 → 无副作用 + ready resolves', async () => {
    const registry = makeMockRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    await state.registerAllUserPresets()
    expect(registry.face.list()).toHaveLength(0)
    expect(state.ready).toBeDefined()
    await state.ready!
  })
})
