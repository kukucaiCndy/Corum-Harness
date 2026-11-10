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
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
      // agent.json 是 profile-store.listProfiles 的发现入口（扫描子目录里的
      // agent.json），registerAllUserPresets 经 listProfiles 取有效 profile id 列表。
      writeFileSync(join(dir, 'agent.json'), JSON.stringify(prof, null, 2))
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
      // agent.json 是 listProfiles 的发现入口（见上 test ① 注释）。
      writeFileSync(join(dir, 'agent.json'), JSON.stringify(prof, null, 2))
      const compiled = compilePreset(prof)
      writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
      writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
    }
    // 坏 preset：agent.json 有效（让 listProfiles 发现它），但 agent.cordis.yml
    // 是非法 YAML（非数组），registerUserPreset 解析后 warn 跳过——验证坏 preset
    // 不拖垮全部。
    const badProf = profile('bad-one')
    const badDir = join(home, '.agent-presets', 'bad-one')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'agent.json'), JSON.stringify(badProf, null, 2))
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

describe('PresetRegistrationState disposer warn + register failure message', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-preset-warn-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① unregisterUserPreset disposer 失败 → warn 带 preset id', async () => {
    const prof = profile('disposer-fail-unreg')
    const dir = join(home, '.agent-presets', 'disposer-fail-unreg')
    mkdirSync(dir, { recursive: true })
    const compiled = compilePreset(prof)
    writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)

    // mock registry: register 返回一个抛错的 disposer（但先移除定义，模拟 registry 内部清理）。
    const definitions = new Map<string, { id: string; plugins: readonly unknown[] }>()
    const registry = {
      defaultId: 'standard' as string,
      register: async (def: { id: string; plugins: readonly unknown[] }): Promise<() => Promise<void>> => {
        definitions.set(def.id, def)
        const failingDisposer = async (): Promise<void> => {
          definitions.delete(def.id)
          throw new Error('disposer boom')
        }
        return failingDisposer
      },
      list: (): { id: string; broken?: string }[] => Array.from(definitions.values()).map(d => ({ id: d.id })),
    }
    const ctx = makeMockCtx(registry as unknown as AgentPresetRegistryFace)
    const state = new PresetRegistrationState(ctx as never)
    await state.registerUserPreset('disposer-fail-unreg')
    expect(registry.list()).toHaveLength(1)

    // unregister → disposer 抛错 → warn 带 preset id 和原因。
    await state.unregisterUserPreset('disposer-fail-unreg')
    expect(registry.list()).toHaveLength(0)
    // warn 包含 disposer failed + preset id。
    const warnCalls = ctx.logger.warn.mock.calls as unknown[][]
    const found = warnCalls.some(c => typeof c[0] === 'string' && (c[0] as string).includes('disposer-fail-unreg'))
    expect(found).toBe(true)
  })

  it('② registerUserPreset 更新场景 register 失败 → warn 显式说明旧定义已移除', async () => {
    const prof = profile('update-register-fail')
    const dir = join(home, '.agent-presets', 'update-register-fail')
    mkdirSync(dir, { recursive: true })
    const compiled = compilePreset(prof)
    writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)

    // mock registry: 第一次 register 成功；第二次（更新场景）register 抛 Duplicate 错。
    let callCount = 0
    const definitions = new Map<string, { id: string; plugins: readonly unknown[] }>()
    const disposers = new Map<string, () => Promise<void>>()
    const registry = {
      defaultId: 'standard' as string,
      register: async (def: { id: string; plugins: readonly unknown[] }): Promise<() => Promise<void>> => {
        callCount++
        if (callCount === 1) {
          definitions.set(def.id, def)
          const disposer = async (): Promise<void> => { definitions.delete(def.id) }
          disposers.set(def.id, disposer)
          return disposer
        }
        // 第二次抛 Duplicate（模拟更新场景 register 失败）。
        throw new Error('Duplicate agent preset')
      },
      list: (): { id: string; broken?: string }[] => Array.from(definitions.values()).map(d => ({ id: d.id })),
    }
    const ctx = makeMockCtx(registry as unknown as AgentPresetRegistryFace)
    const state = new PresetRegistrationState(ctx as never)

    // 第一次注册成功。
    const ok1 = await state.registerUserPreset('update-register-fail')
    expect(ok1).toBe(true)
    expect(registry.list()).toHaveLength(1)

    // 第二次注册（更新场景）：**内容必须先变化**（P1 起「内容未变 ⇒ 0 次注册」），
    // 否则走不到 dispose+register 这条路径。
    writeFileSync(join(dir, 'agent.cordis.yml'), `${compiled.cordisYml}\n- name: corum-agent-update-probe\n`)
    const ok2 = await state.registerUserPreset('update-register-fail')
    expect(ok2).toBe(false)
    // registry 不含该 preset（旧定义已 dispose、新定义未注册）。
    expect(registry.list()).toHaveLength(0)
    // warn 显式说明旧定义已移除。
    const warnCalls = ctx.logger.warn.mock.calls as unknown[][]
    const found = warnCalls.some(c =>
      typeof c[0] === 'string'
      && (c[0] as string).includes('update-register-fail')
      && (c[0] as string).includes('old definition was removed')
    )
    expect(found).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * P1（2026-11-01）preset registry **自愈**：内容指纹 / 变化才重挂 / 重试预算 /
 * 并发串行 / 失败不删旧注册。
 *
 * 这一组用**严格 mock registry**（像真 registry 一样拒绝重复 id），因为旧实现的
 * 缺陷恰恰是「重复注册」和「无条件先 dispose」——宽松 mock 会把它们一起吃掉。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 造一份合法 preset 目录（agent.json 供 listProfiles 发现 + 编译后的两份 yml）。 */
function seedPresetDir(home: string, id: string, prompt = `Test agent ${id}`): void {
  const dir = join(home, '.agent-presets', id)
  mkdirSync(dir, { recursive: true })
  const prof = profile(id)
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(prof, null, 2))
  const compiled = compilePreset({ ...prof, prompt })
  writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
  writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
}

/** 在组合末尾追加一行插件：内容变了**且仍然合法**（条目 list 校验过得去）。 */
function appendPluginRow(file: string, pluginName: string): void {
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n- name: ${pluginName}\n`)
}

interface StrictRegistry {
  readonly face: AgentPresetRegistryFace
  readonly definitions: Map<string, { readonly id: string; readonly plugins: readonly unknown[] }>
  /** 每次 `register()` 尝试的 preset id（含失败的那几次）。 */
  readonly registerCalls: string[]
  /** 每次 disposer 被调用时的 preset id。 */
  readonly disposeCalls: string[]
  /** 让接下来的 n 次 `register()` 抛错（模拟瞬时 mount 失败）。 */
  failRegisters(n: number, message?: string): void
  list(): { id: string; broken?: string }[]
}

/**
 * 严格 mock registry：**重复 id 直接抛错**（真 registry 的 `Duplicate agent preset`），
 * 并记录 register/dispose 次数——「无重复 / 无 generation 泄漏」就是靠这两条验的。
 */
function makeStrictRegistry(): StrictRegistry {
  const definitions = new Map<string, { id: string; plugins: readonly unknown[] }>()
  const disposers = new Map<string, () => Promise<void>>()
  const registerCalls: string[] = []
  const disposeCalls: string[] = []
  let failRemaining = 0
  let failMessage = 'mount boom (transient)'
  const registry = {
    defaultId: 'standard' as string,
    register: async (def: { id: string; plugins: readonly unknown[] }): Promise<() => Promise<void>> => {
      registerCalls.push(def.id)
      if (failRemaining > 0) {
        failRemaining -= 1
        throw new Error(failMessage)
      }
      if (definitions.has(def.id) || disposers.has(def.id)) {
        throw new Error(`Duplicate agent preset: ${def.id}`)
      }
      definitions.set(def.id, { id: def.id, plugins: def.plugins })
      const disposer = async (): Promise<void> => {
        disposeCalls.push(def.id)
        definitions.delete(def.id)
        disposers.delete(def.id)
      }
      disposers.set(def.id, disposer)
      return disposer
    },
    list: (): { id: string; broken?: string }[] => [...definitions.values()].map(d => ({ id: d.id })),
  }
  return {
    face: registry as unknown as AgentPresetRegistryFace,
    definitions,
    registerCalls,
    disposeCalls,
    list: registry.list,
    failRegisters: (n: number, message?: string) => {
      failRemaining = n
      if (message !== undefined) failMessage = message
    },
  }
}

describe('PresetRegistrationState 自愈：内容指纹（变化才重挂）', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-preset-heal-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① 好 preset：启动注册后首次 refresh + 连续多次 refresh → **0 次追加注册**', async () => {
    for (const id of ['good-a', 'good-b', 'good-c']) seedPresetDir(home, id)
    const registry = makeStrictRegistry()
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)

    await state.registerAllUserPresets()
    // 初始 stamp 正确：启动注册 3 次。
    expect(registry.registerCalls).toHaveLength(3)

    // **首次** list 不得全量重挂（初始 stamp 必须与盘上内容一致）。
    await state.refreshChanged()
    expect(registry.registerCalls).toHaveLength(3)
    // 连续多次同样不重挂、不 dispose。
    await state.refreshChanged()
    await state.refreshChanged()
    expect(registry.registerCalls).toHaveLength(3)
    expect(registry.disposeCalls).toHaveLength(0)
    expect(registry.definitions.size).toBe(3)
    expect(state.registeredIds.sort()).toEqual(['good-a', 'good-b', 'good-c'])
  })

  it('② 内容变化 → 只重挂该 preset（dispose 旧 + register 新），定义数恒 1', async () => {
    seedPresetDir(home, 'changed-one')
    const registry = makeStrictRegistry()
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)
    await state.registerAllUserPresets()
    const before = registry.definitions.get('changed-one')?.plugins.length ?? 0
    expect(before).toBeGreaterThan(0)

    appendPluginRow(join(home, '.agent-presets', 'changed-one', 'agent.cordis.yml'), 'corum-agent-probe-a')
    await state.refreshChanged()

    expect(registry.registerCalls).toEqual(['changed-one', 'changed-one'])
    expect(registry.disposeCalls).toEqual(['changed-one'])
    expect(registry.definitions.size).toBe(1)
    // 新定义真的带上了新插件行（不是空重挂）。
    expect(registry.definitions.get('changed-one')?.plugins).toHaveLength(before + 1)

    // 内容不再变 ⇒ 再 refresh 也不动（指纹缓存生效）。
    await state.refreshChanged()
    expect(registry.registerCalls).toHaveLength(2)
  })

  it('③ 反复内容变化：无重复定义、无 generation 泄漏（disposer 表恒 1 条）', async () => {
    seedPresetDir(home, 'gen-leak')
    const registry = makeStrictRegistry()
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)
    await state.registerAllUserPresets()

    for (const tag of ['p1', 'p2', 'p3']) {
      appendPluginRow(join(home, '.agent-presets', 'gen-leak', 'agent.cordis.yml'), `corum-agent-${tag}`)
      await state.refreshChanged()
      // 每一代都只剩 1 条定义、1 条 disposer。
      expect(registry.definitions.size).toBe(1)
      expect(state.registeredIds).toHaveLength(1)
    }
    // 3 次变化 = 3 次重挂，每次都先 dispose 旧代（无泄漏、无堆积）。
    expect(registry.registerCalls).toHaveLength(4)
    expect(registry.disposeCalls).toEqual(['gen-leak', 'gen-leak', 'gen-leak'])
  })

  it('④ mtime 不算内容：写回**完全相同**的字节 → 不重挂', async () => {
    seedPresetDir(home, 'same-bytes')
    const file = join(home, '.agent-presets', 'same-bytes', 'agent.cordis.yml')
    const registry = makeStrictRegistry()
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)
    await state.registerAllUserPresets()
    expect(registry.registerCalls).toHaveLength(1)

    // 原样写回（只翻 mtime）：指纹不变 ⇒ 0 次注册。
    writeFileSync(file, readFileSync(file))
    await state.refreshChanged()
    expect(registry.registerCalls).toHaveLength(1)
    expect(registry.disposeCalls).toHaveLength(0)
  })
})

describe('PresetRegistrationState 自愈：坏 → 修 → 恢复 / 重试预算', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-preset-broken-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① 解析坏 → 修好 → refresh 后恢复注册，registry 里没有 broken 项', async () => {
    const dir = join(home, '.agent-presets', 'heal-me')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent.json'), JSON.stringify(profile('heal-me'), null, 2))
    writeFileSync(join(dir, 'agent.cordis.yml'), 'not-a-list: true\n')

    const registry = makeStrictRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)

    await state.registerAllUserPresets()
    expect(registry.registerCalls).toHaveLength(0)
    await state.refreshChanged()
    expect(registry.registerCalls).toHaveLength(0)

    // 修好（落盘一份合法组合）→ 下一次 refresh 自愈。
    const compiled = compilePreset(profile('heal-me'))
    writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
    await state.refreshChanged()

    expect(registry.registerCalls).toEqual(['heal-me'])
    const listed = registry.list()
    expect(listed.map(p => p.id)).toEqual(['heal-me'])
    // 没有任何 broken 诊断（真 registry 里 broken 才带这个字段）。
    expect(listed.every(p => p.broken === undefined)).toBe(true)
    expect(state.registeredIds).toEqual(['heal-me'])
  })

  it('② 同一指纹 mount 持续失败 → **最多自动重试 1 次**（共 2 次尝试）', async () => {
    seedPresetDir(home, 'still-broken')
    const registry = makeStrictRegistry()
    registry.failRegisters(99)
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)

    await state.registerAllUserPresets() // 尝试 1
    expect(registry.registerCalls).toHaveLength(1)
    await state.refreshChanged() // 自动重试（尝试 2）
    expect(registry.registerCalls).toHaveLength(2)
    await state.refreshChanged() // 预算用尽 → 不再尝试
    await state.refreshChanged()
    expect(registry.registerCalls).toHaveLength(2)

    // 仍坏：不在 registry 里，disposer 表也没有它（不伪成功）。
    expect(registry.definitions.size).toBe(0)
    expect(state.registeredIds).toEqual([])
    // 失败原因进日志（带 preset id）。
    const warnCalls = ctx.logger.warn.mock.calls as unknown[][]
    expect(warnCalls.some(c => typeof c[0] === 'string'
      && (c[0] as string).includes('still-broken')
      && (c[0] as string).includes('old definition was removed'))).toBe(true)
  })

  it('③ 内容变化重置重试预算：修好内容后即使预算用尽也能挂上', async () => {
    seedPresetDir(home, 'budget-reset')
    const registry = makeStrictRegistry()
    registry.failRegisters(99)
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)

    await state.registerAllUserPresets()
    await state.refreshChanged()
    await state.refreshChanged() // 预算用尽
    expect(registry.registerCalls).toHaveLength(2)

    // 内容变化（追加一行）⇒ 指纹变 ⇒ 预算重置 ⇒ 这一次真的再试并且成功。
    registry.failRegisters(0)
    appendPluginRow(join(home, '.agent-presets', 'budget-reset', 'agent.cordis.yml'), 'corum-agent-after-fix')
    await state.refreshChanged()

    expect(registry.registerCalls).toHaveLength(3)
    expect(registry.definitions.size).toBe(1)
    expect(state.registeredIds).toEqual(['budget-reset'])
  })

  it('④ 解析坏 → 旧注册**原样保留**（非原子写不删旧定义）', async () => {
    seedPresetDir(home, 'half-written')
    const registry = makeStrictRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    await state.registerAllUserPresets()
    const before = registry.definitions.get('half-written')?.plugins
    expect(before).toBeDefined()

    // 模拟非原子写落在半份 YAML 上（解析不了）。
    writeFileSync(join(home, '.agent-presets', 'half-written', 'agent.cordis.yml'), '- name: corum-agent\n  config: {unclosed\n')
    await state.refreshChanged()

    // 旧 disposer 一次都没动，旧定义还在，plugin 表仍是旧的那份。
    expect(registry.disposeCalls).toHaveLength(0)
    expect(registry.definitions.get('half-written')?.plugins).toBe(before)
    expect(state.registeredIds).toEqual(['half-written'])
    // 坏内容进日志（带 id + 原因）。
    const warnCalls = ctx.logger.warn.mock.calls as unknown[][]
    expect(warnCalls.some(c => typeof c[0] === 'string'
      && (c[0] as string).includes('half-written')
      && (c[0] as string).includes('keeping previous registration'))).toBe(true)
  })

  it('⑤ ENOENT（文件被删/还没写）→ 旧注册保留', async () => {
    seedPresetDir(home, 'gone-file')
    const registry = makeStrictRegistry()
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)
    await state.registerAllUserPresets()

    rmSync(join(home, '.agent-presets', 'gone-file', 'agent.cordis.yml'))
    await state.refreshChanged()

    expect(registry.disposeCalls).toHaveLength(0)
    expect(registry.definitions.size).toBe(1)
    expect(state.registeredIds).toEqual(['gone-file'])
  })

  it('⑥ 读错误（EISDIR）→ 旧注册保留 + 日志带 error.code 分类', async () => {
    seedPresetDir(home, 'unreadable')
    const registry = makeStrictRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)
    await state.registerAllUserPresets()

    // 把组合文件换成目录：readFileSync 抛 EISDIR（= 一个确凿的「读不动」）。
    const file = join(home, '.agent-presets', 'unreadable', 'agent.cordis.yml')
    rmSync(file)
    mkdirSync(file)

    await state.refreshChanged()
    expect(registry.disposeCalls).toHaveLength(0)
    expect(registry.definitions.size).toBe(1)

    const warnCalls = ctx.logger.warn.mock.calls as unknown[][]
    const hit = warnCalls.find(c => typeof c[0] === 'string'
      && (c[0] as string).includes('unreadable')
      && (c[0] as string).includes('read failed'))
    expect(hit).toBeDefined()
    // error.code 分类保留在日志里（`（code EISDIR）`，不吞成 "Error: ..."）。
    expect(String(hit?.[0])).toMatch(/read failed \(code [A-Z]+\)/)
  })
})

describe('PresetRegistrationState 显式 retryPreset（磁盘未变的瞬时失败兜底）', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-preset-retry-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① 自动预算用尽后，显式 retry 用**同一份磁盘内容**重挂成功', async () => {
    seedPresetDir(home, 'transient-fail')
    const registry = makeStrictRegistry()
    registry.failRegisters(2) // 启动那枪 + 自动重试那枪都失败
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)

    await state.registerAllUserPresets()
    await state.refreshChanged()
    await state.refreshChanged()
    expect(state.registeredIds).toEqual([])

    // 磁盘内容一点没变，只是「这一次能挂上了」。
    const status = await state.retryPreset('transient-fail')
    expect(status).toBe('registered')
    expect(registry.registerCalls).toHaveLength(3)
    expect(registry.definitions.size).toBe(1)
    expect(state.registeredIds).toEqual(['transient-fail'])
  })

  it('② 已挂载且内容未变时，显式 retry 仍**真的重挂一次**（同 stamp 也重试）', async () => {
    seedPresetDir(home, 'force-remount')
    const registry = makeStrictRegistry()
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)
    await state.registerAllUserPresets()
    expect(registry.registerCalls).toHaveLength(1)

    const status = await state.retryPreset('force-remount')
    expect(status).toBe('registered')
    expect(registry.registerCalls).toHaveLength(2)
    expect(registry.disposeCalls).toEqual(['force-remount'])
    expect(registry.definitions.size).toBe(1)
  })

  it('③ 非法 id（路径穿越）→ invalid-id，registry 一次都不碰', async () => {
    const registry = makeStrictRegistry()
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)

    expect(await state.retryPreset('../escape')).toBe('invalid-id')
    expect(await state.registerUserPreset('../../etc/passwd')).toBe(false)
    expect(await state.registerUserPreset('Upper/Case')).toBe(false)
    expect(registry.registerCalls).toHaveLength(0)
    expect(registry.disposeCalls).toHaveLength(0)
    // 拒绝原因进日志（不静默）。
    expect((ctx.logger.warn.mock.calls as unknown[][]).some(c => typeof c[0] === 'string'
      && (c[0] as string).includes('not a valid profile slug'))).toBe(true)
  })
})

describe('PresetRegistrationState 并发：单 id 串行队列', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-preset-async-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① Promise.all × 5（内容已变）→ 无 Duplicate、只重挂 1 次', async () => {
    seedPresetDir(home, 'racing')
    const registry = makeStrictRegistry()
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)
    await state.registerAllUserPresets()
    appendPluginRow(join(home, '.agent-presets', 'racing', 'agent.cordis.yml'), 'corum-agent-race-probe')

    // 五个并发调用都会看到「内容变了」——没有单 id 队列就会有两个都 dispose+register，
    // 第二个撞 mock registry 的 `Duplicate agent preset` 而抛错。
    const results = await Promise.all(
      Array.from({ length: 5 }, () => state.registerUserPreset('racing')),
    )
    expect(results.every(r => r === true)).toBe(true)
    expect(registry.registerCalls).toHaveLength(2)
    expect(registry.disposeCalls).toHaveLength(1)
    expect(registry.definitions.size).toBe(1)
  })

  it('② 并发的 register 与 unregister 交错 → 最终状态确定（无残留 disposer）', async () => {    seedPresetDir(home, 'churn')
    const registry = makeStrictRegistry()
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)
    await state.registerAllUserPresets()
    expect(state.registeredIds).toEqual(['churn'])

    await Promise.all([
      state.unregisterUserPreset('churn'),
      state.registerUserPreset('churn'),
      state.unregisterUserPreset('churn'),
    ])
    // 队列把三步串起来：无论谁先，最终 disposer 表与 registry 要么都空、要么都 1 条。
    expect(state.registeredIds.length).toBe(registry.definitions.size)
    expect(registry.definitions.size <= 1).toBe(true)
  })

  it('③ ctx.effect dispose → disposer 表 / 指纹簿 / 队列全部清空（不跨代泄漏）', async () => {
    seedPresetDir(home, 'teardown')
    const registry = makeStrictRegistry()
    let teardown: (() => void) | undefined
    const ctx = {
      ...makeMockCtx(registry.face),
      effect: (fn: () => () => void, _label?: string): (() => void) => {
        teardown = fn()
        return teardown
      },
    }
    const state = new PresetRegistrationState(ctx as never)
    await state.registerAllUserPresets()
    expect(state.registeredIds).toEqual(['teardown'])
    expect(registry.definitions.size).toBe(1)

    expect(teardown).toBeDefined()
    teardown!()

    // 三张表清空 + registry 端 disposer 真被调用（不是只清本地表）。
    expect(state.registeredIds).toEqual([])
    expect(registry.disposeCalls).toEqual(['teardown'])
    expect(registry.definitions.size).toBe(0)
    // 队列也清空了：dispose 之后再同步同一个 preset 仍然可用（不卡在旧队列上）。
    expect(await state.registerUserPreset('teardown')).toBe(true)
    expect(registry.definitions.size).toBe(1)
  })
})

describe('agent-service 接线：自愈入口在 presetRegistrationReady 之后', () => {
  /** 取某方法从签名到下一个 `\n  }` 的源码切片（够覆盖方法体，避免跨方法误判）。 */
  function methodSlice(source: string, marker: string): string {
    const start = source.indexOf(marker)
    expect(start, `method marker not found: ${marker}`).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('\n  }\n', start)
    return source.slice(start, end === -1 ? source.length : end)
  }

  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent-service.ts'),
    'utf8',
  )

  it('① listProfiles / createAgent / createAgentForTask 三个入口都先 await ready 再 refreshChanged', () => {
    for (const marker of ['async listProfilesRemote', 'async createAgentRemote', 'async createAgentForTask(']) {
      const body = methodSlice(source, marker)
      const readyAt = body.indexOf('await this.presetRegistrationReady()')
      const refreshAt = body.indexOf('await this.presetRegistration.refreshChanged()')
      expect(readyAt, `missing presetRegistrationReady in ${marker}`).toBeGreaterThanOrEqual(0)
      expect(refreshAt, `missing refreshChanged in ${marker}`).toBeGreaterThanOrEqual(0)
      // 顺序：ready 先、refresh 后（ready 未完成时 registry 可能还没有服务）。
      expect(refreshAt).toBeGreaterThan(readyAt)
    }
  })

  it('② retryPreset 是 @Remote 端点，且先校验 id 再重挂', () => {
    // 装饰器在方法签名**之前**，故整体源码查一次；方法体内查校验顺序。
    expect(source).toContain("@Remote('retryPreset')")
    const body = methodSlice(source, 'async retryPresetRemote(')
    expect(body).toContain('isValidProfileId')
    expect(body.indexOf('isValidProfileId')).toBeLessThan(body.indexOf('retryPreset(id)'))
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * 上游**真实语义**：`register()` 对 mount 失败**不 reject**（把 message 写进
 * `record.broken` 后正常返回 disposer）。这一组用一个**模仿上游语义**的 registry
 * （register 永远 resolve + `resolve(id)` 报 broken）钉住三件事：
 *   ① resolve ≠ 挂上（不写 mounted 成功假象）；
 *   ② 真实 broken 也吃自动重试预算（同一内容最多 1 次）；
 *   ③ 坏的定义保留在 registry 里（list 带 broken），内容变化/显式 retry 才恢复。
 *
 * 真上游的端到端证据见 `preset-registration-real-registry.spec.ts`（真 boot + 真
 * @deepseek-ai/dsh-agent-preset-registry）。
 * ══════════════════════════════════════════════════════════════════════════ */

interface UpstreamLikeRegistry {
  readonly face: AgentPresetRegistryFace
  readonly definitions: Map<string, { readonly id: string; readonly plugins: readonly unknown[] }>
  readonly registerCalls: string[]
  readonly disposeCalls: string[]
  /** 让接下来的 register 走「mount 失败」分支（resolve 但 broken）。 */
  setMountFails(fails: boolean): void
  list(): { id: string; broken?: string }[]
}

/**
 * 模仿上游 `AgentPresetRegistry` 的失败语义：`register()` **不 reject**，而是把
 * mount 失败记在 broken 表里，`resolve(id)` 读出来（真上游里是 `record.broken`）。
 */
function makeUpstreamLikeRegistry(): UpstreamLikeRegistry {
  const definitions = new Map<string, { id: string; plugins: readonly unknown[] }>()
  const disposers = new Map<string, () => Promise<void>>()
  const brokenById = new Map<string, string>()
  const registerCalls: string[] = []
  const disposeCalls: string[] = []
  let mountFails = false
  const registry = {
    defaultId: 'standard' as string,
    register: async (def: { id: string; plugins: readonly unknown[] }): Promise<() => Promise<void>> => {
      registerCalls.push(def.id)
      if (definitions.has(def.id)) throw new Error(`Duplicate agent preset: ${def.id}`)
      // 上游顺序：先入 definitions，再 activate（失败只写 broken）。
      definitions.set(def.id, { id: def.id, plugins: def.plugins })
      if (mountFails) brokenById.set(def.id, 'mount failed: row 1 cannot be loaded')
      else brokenById.delete(def.id)
      const disposer = async (): Promise<void> => {
        disposeCalls.push(def.id)
        definitions.delete(def.id)
        brokenById.delete(def.id)
        disposers.delete(def.id)
      }
      disposers.set(def.id, disposer)
      return disposer
    },
    resolve: async (id: string): Promise<{ id: string; broken?: string }> => {
      if (!definitions.has(id)) throw new Error(`Unknown agent preset: ${id}`)
      const message = brokenById.get(id)
      return { id, ...(message === undefined ? {} : { broken: message }) }
    },
    list: (): { id: string; broken?: string }[] => [...definitions.keys()].map((id) => {
      const message = brokenById.get(id)
      return { id, ...(message === undefined ? {} : { broken: message }) }
    }),
  }
  return {
    face: registry as unknown as AgentPresetRegistryFace,
    definitions,
    registerCalls,
    disposeCalls,
    list: registry.list,
    setMountFails: (fails: boolean) => { mountFails = fails },
  }
}

describe('PresetRegistrationState × 上游 broken 语义（register resolve ≠ 挂上）', () => {
  let home: string
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'corum-preset-upstream-'))
    oldCorumHome = process.env.CORUM_HOME
    process.env.CORUM_HOME = home
  })

  afterEach(() => {
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  })

  it('① mount 失败但 register resolve → **不算挂上**（mount-broken）+ 定义保留', async () => {
    seedPresetDir(home, 'upstream-broken')
    const registry = makeUpstreamLikeRegistry()
    registry.setMountFails(true)
    const ctx = makeMockCtx(registry.face)
    const state = new PresetRegistrationState(ctx as never)

    await state.registerAllUserPresets()

    // 关键断言：register 明明 resolve 了，但记账不写「已挂载」。
    expect(registry.registerCalls).toEqual(['upstream-broken'])
    expect(await state.registerUserPreset('upstream-broken')).toBe(false)
    expect(await state.retryPreset('upstream-broken')).toBe('mount-broken')
    // 定义留在 registry（list 带 broken，UI 看得见）——不删坏定义。
    const row = registry.list().find(r => r.id === 'upstream-broken')
    expect(row).toBeDefined()
    expect(row?.broken).toBeTruthy()
    // disposer 留着（重挂前得先撤掉，否则撞 Duplicate）。
    expect(state.registeredIds).toContain('upstream-broken')
    // 日志带 id + 原因（不静默）。
    const warnCalls = ctx.logger.warn.mock.calls as unknown[][]
    expect(warnCalls.some(c => typeof c[0] === 'string'
      && (c[0] as string).includes('upstream-broken')
      && (c[0] as string).includes('registered but broken'))).toBe(true)
  })

  it('② 真实 broken 也吃自动重试预算：同一内容最多再自动重试 1 次', async () => {
    seedPresetDir(home, 'upstream-retry')
    const registry = makeUpstreamLikeRegistry()
    registry.setMountFails(true)
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)

    await state.registerAllUserPresets() // 尝试 1（broken）
    expect(registry.registerCalls).toHaveLength(1)
    await state.refreshChanged() // 自动重试（尝试 2，仍 broken）
    expect(registry.registerCalls).toHaveLength(2)
    await state.refreshChanged() // 预算用尽
    await state.refreshChanged()
    await state.refreshChanged()
    expect(registry.registerCalls).toHaveLength(2)
    // 每次重试都先撤掉旧定义（否则 Duplicate）：重试那次有 1 次 dispose。
    expect(registry.disposeCalls).toEqual(['upstream-retry'])
    expect(state.registeredIds).toEqual(['upstream-retry'])
  })

  it('③ 内容变化 → 预算重置 + 真挂上（broken 消失）', async () => {
    seedPresetDir(home, 'upstream-heal')
    const registry = makeUpstreamLikeRegistry()
    registry.setMountFails(true)
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)

    await state.registerAllUserPresets()
    await state.refreshChanged()
    await state.refreshChanged() // 预算用尽，仍 broken
    expect(registry.registerCalls).toHaveLength(2)
    expect(registry.list()[0]?.broken).toBeTruthy()

    // 内容变了（追加一行）且这次能挂上 ⇒ 新指纹、新预算、真成功。
    registry.setMountFails(false)
    appendPluginRow(join(home, '.agent-presets', 'upstream-heal', 'agent.cordis.yml'), 'corum-agent-heal-probe')
    await state.refreshChanged()

    expect(registry.registerCalls).toHaveLength(3)
    expect(registry.list()[0]?.broken).toBeUndefined()
    expect(await state.registerUserPreset('upstream-heal')).toBe(true)
    // 再 refresh 是 0 次注册（已挂载且内容未变）。
    await state.refreshChanged()
    expect(registry.registerCalls).toHaveLength(3)
  })

  it('④ 磁盘未变的瞬时恢复：显式 retryPreset 重挂成功（不受预算限制）', async () => {
    seedPresetDir(home, 'upstream-transient')
    const registry = makeUpstreamLikeRegistry()
    registry.setMountFails(true)
    const state = new PresetRegistrationState(makeMockCtx(registry.face) as never)

    await state.registerAllUserPresets()
    await state.refreshChanged()
    await state.refreshChanged() // 预算用尽
    expect(registry.registerCalls).toHaveLength(2)

    // 内容与磁盘一点没变，只是这枪能挂上了。
    registry.setMountFails(false)
    const status = await state.retryPreset('upstream-transient')
    expect(status).toBe('registered')
    expect(registry.registerCalls).toHaveLength(3)
    expect(registry.list()[0]?.broken).toBeUndefined()
    expect(state.registeredIds).toEqual(['upstream-transient'])
  })

  it('⑤ 诊断面自己抛错 → 不误判 broken（按 register resolve 处理，只 warn）', async () => {
    seedPresetDir(home, 'diag-throws')
    const registry = makeUpstreamLikeRegistry()
    const face: AgentPresetRegistryFace = {
      register: registry.face.register,
      resolve: async () => { throw new Error('diagnostic exploded') },
    }
    const ctx = makeMockCtx(face)
    const state = new PresetRegistrationState(ctx as never)

    await state.registerAllUserPresets()
    // 复核失败不能把健康 preset 标成坏（否则会反复重挂、白烧预算）。
    expect(await state.registerUserPreset('diag-throws')).toBe(true)
    expect(registry.registerCalls).toHaveLength(1)
    const warnCalls = ctx.logger.warn.mock.calls as unknown[][]
    expect(warnCalls.some(c => typeof c[0] === 'string'
      && (c[0] as string).includes('diagnostic could not be read'))).toBe(true)
  })

  it('⑥ 服务没有 resolve 面（老版本/窄 mock）→ 复核降级为「无法判断」，行为不变', async () => {
    seedPresetDir(home, 'no-diagnostic')
    const registry = makeUpstreamLikeRegistry()
    const face: AgentPresetRegistryFace = { register: registry.face.register }
    const state = new PresetRegistrationState(makeMockCtx(face) as never)

    await state.registerAllUserPresets()
    expect(await state.registerUserPreset('no-diagnostic')).toBe(true)
    expect(registry.registerCalls).toHaveLength(1)
  })
})
