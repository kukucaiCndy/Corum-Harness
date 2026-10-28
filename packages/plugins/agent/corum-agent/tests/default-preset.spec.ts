/**
 * setDefaultPresetRemote — 默认 Agent 预设持久化的机器验证（rc3 settings 通道）。
 *
 * 0.2.1-rc.3 起：`setDefaultPresetRemote` 走官方 `ctx.settings.update('agent-preset-registry',
 * { selectedDefault })` 通道。`SettingsForms.write()` 把 volatile 值持久化进 profile patch
 * （`mergeLayers(strip(raw, form), next)`），同时 `configEditor.edit` 触发 loader
 * `_commitVolatile` + `loader/volatile-update` 实现运行期即时生效。重启后 schemastery
 * 从 patch raw 解析 volatile `selectedDefault`，`defaultId` getter 直接返回持久值。
 *
 * 覆盖：
 *   ① settings.update 被以 `('agent-preset-registry', { selectedDefault })` 调用；
 *   ② 写失败必须抛错（不 catch 后伪 { ok: true }）；
 *   ③ defaultId 在下一次任务生效（resolveDefaultTaskProfileId 读 defaultId getter）；
 *   ④ 无效 id 回退 standard；
 *   ⑤ undefined 清除 selectedDefault（回落 config.default）；
 *   ⑥ **真实持久化穿越**：volatile 写 → dispose → 重建 → defaultId 保留（非 mock）。
 *
 * @module @corum/corum-agent/tests/default-preset
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeHarness, type Harness } from './harness.ts'
import type { AgentProfile } from '../src/profile.ts'
import { CorumAgentService } from '../src/agent-service.ts'
import { TASK_PROFILE_ID } from '../src/builtin-profiles.ts'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { Context as CordisContext } from '@deepseek-ai/cordis'

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

/** mock agentPresets registry：返回含 defaultId getter + list() 的窄面。 */
function mockRegistry(opts: {
  defaultId?: string | undefined
  list?: () => Promise<{ id: string; broken?: string }[]>
}): unknown {
  const presets = [
    { id: 'standard' },
    { id: 'corum-dev' },
  ]
  return {
    defaultId: opts.defaultId,
    list: opts.list ?? (async () => presets),
  }
}

/** mock settings：记录 update 调用，可控制成功/失败。 */
function makeMockSettings(opts: { fail?: boolean; updateImpl?: (ns: string, value: Record<string, unknown>) => Promise<void> } = {}) {
  const calls: Array<{ ns: string; value: Record<string, unknown> }> = []
  const settings = {
    update: opts.updateImpl ?? (async (ns: string, value: Record<string, unknown>) => {
      calls.push({ ns, value })
      if (opts.fail) throw new Error('settings.update failed (mock)')
    }),
    describe: () => [],
    configure: () => () => {},
  }
  return { settings, calls }
}

describe('setDefaultPresetRemote (rc3: ctx.settings.update channel)', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it('① 有效 preset id → settings.update 被以 ("agent-preset-registry", { selectedDefault: id }) 调用', async () => {
    const { settings, calls } = makeMockSettings()
    h.provide('settings', settings)
    h.provide('agentPresets', mockRegistry({ defaultId: 'standard' }))

    const result = await h.service.setDefaultPresetRemote('corum-dev')
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].ns).toBe('agent-preset-registry')
    expect(calls[0].value).toEqual({ selectedDefault: 'corum-dev' })
  })

  it('② settings.update 失败 → 抛错（不 catch 后伪 { ok: true }）', async () => {
    const { settings } = makeMockSettings({ fail: true })
    h.provide('settings', settings)
    h.provide('agentPresets', mockRegistry({ defaultId: 'standard' }))

    await expect(h.service.setDefaultPresetRemote('corum-dev')).rejects.toThrow('settings.update failed')
  })

  it('③ 无效 id（不在 registry）→ 回退 standard + settings.update 写 standard', async () => {
    const { settings, calls } = makeMockSettings()
    h.provide('settings', settings)
    // list 不含 ghost-agent
    h.provide('agentPresets', mockRegistry({ defaultId: 'standard', list: async () => [{ id: 'standard' }, { id: 'corum-dev' }] }))

    const result = await h.service.setDefaultPresetRemote('ghost-agent')
    expect(result).toEqual({ ok: true })
    expect(calls[0].value).toEqual({ selectedDefault: 'standard' })
  })

  it('④ undefined → settings.update 写 { selectedDefault: undefined }（清除回退 config.default）', async () => {
    const { settings, calls } = makeMockSettings()
    h.provide('settings', settings)
    h.provide('agentPresets', mockRegistry({ defaultId: 'corum-dev' }))

    const result = await h.service.setDefaultPresetRemote(undefined)
    expect(result).toEqual({ ok: true })
    expect(calls[0].value).toEqual({ selectedDefault: undefined })
  })

  it('⑤ 空字符串 → 同 undefined（清除）', async () => {
    const { settings, calls } = makeMockSettings()
    h.provide('settings', settings)
    h.provide('agentPresets', mockRegistry({ defaultId: 'corum-dev' }))

    const result = await h.service.setDefaultPresetRemote('')
    expect(result).toEqual({ ok: true })
    expect(calls[0].value).toEqual({ selectedDefault: undefined })
  })
})

describe('resolveDefaultTaskProfileId (reads ctx.agentPresets.defaultId)', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it('① registry 未提供 defaultId ⇒ TASK_PROFILE_ID', () => {
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe(TASK_PROFILE_ID)
  })

  it('①b registry 挂载但 defaultId 为 undefined ⇒ TASK_PROFILE_ID', () => {
    h.provide('agentPresets', mockRegistry({ defaultId: undefined }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe(TASK_PROFILE_ID)
  })

  it('② defaultId 指向存在的 corum profile ⇒ 用它', () => {
    h.writeProfile(profile('corum-dev'))
    h.provide('agentPresets', mockRegistry({ defaultId: 'corum-dev' }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('corum-dev')
  })

  it('③ defaultId 是官方 preset id（不在 corum 目录）⇒ 放行', () => {
    h.provide('agentPresets', mockRegistry({ defaultId: 'standard' }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('standard')
  })

  it('④b defaultId 为空白字符串 ⇒ 回落 TASK_PROFILE_ID', () => {
    h.provide('agentPresets', mockRegistry({ defaultId: '   ' }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe(TASK_PROFILE_ID)
  })

  it('④c defaultId 前后有空白 ⇒ trim 后解析', () => {
    h.writeProfile(profile('corum-dev'))
    h.provide('agentPresets', mockRegistry({ defaultId: '  corum-dev  ' }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('corum-dev')
  })
})

describe('readConfiguredDefaultPreset（UI 透传面：不做 TASK_PROFILE_ID 回落）', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it('registry 未提供 ⇒ undefined', () => {
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBeUndefined()
  })

  it('registry 挂载但 defaultId 为 undefined ⇒ undefined', () => {
    h.provide('agentPresets', mockRegistry({ defaultId: undefined }))
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBeUndefined()
  })

  it('defaultId 指向存在 corum profile ⇒ 返回该 id', () => {
    h.writeProfile(profile('corum-dev'))
    h.provide('agentPresets', mockRegistry({ defaultId: 'corum-dev' }))
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBe('corum-dev')
  })
})

// ─── 真实持久化穿越测试（非 mock：SettingsForms + ConfigEditor + AgentPresetRegistry） ───

/**
 * 用官方 configuration fixture 模式验证 volatile `selectedDefault` 写入后穿越
 * `fiber.dispose()` + 重建存活。与官方 `configuration.spec.ts:65-79` 同款手法。
 *
 * ① 写 `selectedDefault: 'custom-agent'` → profile patch 落盘；
 * ② dispose context；
 * ③ 重建 context（从同一 profile patch 启动）；
 * ④ `agentPresets.defaultId` 返回 'custom-agent'（volatile 值从 patch raw 恢复）。
 */
describe('selectedDefault volatile persistence across dispose→rebuild (real SettingsForms + ConfigEditor)', () => {
  let home: string
  let profileDir: string
  let oldDshHome: string | undefined

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'corum-preset-persist-')))
    profileDir = join(home, 'profiles', 'test')
    oldDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (oldDshHome !== undefined) process.env.DSH_HOME = oldDshHome
    else delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('volatile selectedDefault 写入 → dispose → 重建 → defaultId 保留', async () => {
    // 动态导入（测试专用包，不进 src 依赖图）。
    const { boot, initProfile, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')
    const ConfigEditor = (await import('@deepseek-ai/dsh-config-editor')).default
    const Settings = (await import('@deepseek-ai/dsh-settings')).default
    const AgentPresets = (await import('@deepseek-ai/dsh-agent-preset-registry')).default
    const SessionProjectionRegistry = (await import('@deepseek-ai/dsh-session-projection')).default
    const SessionStore = (await import('@deepseek-ai/dsh-session')).default

    initProfile(profileDir, ['test-bundle'])
    const bundle = join(profileDir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      name: 'test-bundle', version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    // bundle patch 注入 settings + config-editor + agent-preset-registry + session 依赖行。
    writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'session-projection', name: 'cordis:session-projection-registry' },
      { id: 'session-store', name: 'cordis:session' },
      { id: 'agent-preset-registry', name: 'cordis:agent-presets', config: { default: 'standard' } },
    ] }]))
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')

    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'),
      cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }

    const start = async (): Promise<CordisContext> => {
      const ctx = await boot('test', join(profileDir, 'cordis.yml'), readProfilePatches('test', profile), (ctx: CordisContext) => {
        ctx.provide('profileContext', profile)
        ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
        Object.assign(ctx.loader.builtins, {
          editor: ConfigEditor,
          settings: Settings,
          'session-projection-registry': SessionProjectionRegistry,
          session: SessionStore,
          'agent-presets': AgentPresets,
        })
      })
      return ctx
    }

    // 第一次启动：写 volatile selectedDefault。
    const ctx1 = await start()
    // 等待所有 loader 条目完成激活（fiber.state === 2，settings describe 需要）。
    await new Promise(resolve => setTimeout(resolve, 200))
    let attempts = 0
    while (ctx1.get('settings') === undefined && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 10))
      attempts++
    }
    const settings1 = ctx1.settings
    expect(settings1).toBeDefined()

    // 写 volatile selectedDefault = 'custom-agent'。
    await settings1.update('agent-preset-registry', { selectedDefault: 'custom-agent' })

    // 验证 defaultId 已即时更新（运行期热生效）。
    const registry1 = ctx1.agentPresets
    expect(registry1.defaultId).toBe('custom-agent')

    // 验证 profile patch 已落盘 volatile 值。
    const { readFileSync } = await import('node:fs')
    const { parse } = await import('yaml')
    const patchRaw = parse(readFileSync(profile.patchPath, 'utf8')) as Array<{ id: string; config?: Record<string, unknown> }>
    const registryRow = patchRaw.find(r => r.id === 'agent-preset-registry')
    expect(registryRow).toBeDefined()
    // volatile 值进 patch（mergeLayers 后的 next 含 volatile）。
    expect(registryRow?.config?.selectedDefault).toBe('custom-agent')

    // dispose → 重建 → defaultId 保留。
    await ctx1.fiber.dispose()
    const ctx2 = await start()
    let attempts2 = 0
    while (ctx2.get('agentPresets') === undefined && attempts2 < 50) {
      await new Promise(resolve => setTimeout(resolve, 10))
      attempts2++
    }
    const registry2 = ctx2.agentPresets
    // volatile 值从 patch raw 恢复（schemastery createVolatile）。
    expect(registry2.defaultId).toBe('custom-agent')

    await ctx2.fiber.dispose()
  }, 30_000)

  it('未写 selectedDefault → defaultId 回落 config.default（standard）', async () => {
    const { boot, initProfile, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')
    const ConfigEditor = (await import('@deepseek-ai/dsh-config-editor')).default
    const Settings = (await import('@deepseek-ai/dsh-settings')).default
    const AgentPresets = (await import('@deepseek-ai/dsh-agent-preset-registry')).default
    const SessionProjectionRegistry = (await import('@deepseek-ai/dsh-session-projection')).default
    const SessionStore = (await import('@deepseek-ai/dsh-session')).default

    initProfile(profileDir, ['test-bundle'])
    const bundle = join(profileDir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      name: 'test-bundle', version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'session-projection', name: 'cordis:session-projection-registry' },
      { id: 'session-store', name: 'cordis:session' },
      { id: 'agent-preset-registry', name: 'cordis:agent-presets', config: { default: 'standard' } },
    ] }]))
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')

    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'),
      cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }

    const ctx = await boot('test', join(profileDir, 'cordis.yml'), readProfilePatches('test', profile), (ctx: CordisContext) => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      Object.assign(ctx.loader.builtins, {
        editor: ConfigEditor,
        settings: Settings,
        'session-projection-registry': SessionProjectionRegistry,
        session: SessionStore,
        'agent-presets': AgentPresets,
      })
    })

    let attempts = 0
    while (ctx.get('agentPresets') === undefined && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 10))
      attempts++
    }
    const registry = ctx.agentPresets
    expect(registry.defaultId).toBe('standard')

    await ctx.fiber.dispose()
  }, 15_000)

  /**
   * **RPC 方法的真实穿越**（不是静态文本断言，也不是 mock settings）：
   * `setDefaultPresetRemote` 直接跑在**真宿主装配**（官方 settings + config-editor +
   * agent-preset-registry）的 ctx 上 —— 与生产 RPC 调用同一 `this.ctx.settings.update`
   * 通道 —— 证明三件事：
   *   ① 写成功（`{ ok: true }`）；
   *   ② volatile 值真的落进 profile patch（`selectedDefault` 键出现）；
   *   ③ dispose → 用同一 patch 重建 → 值仍在（重启保留）。
   *
   * 这是 P4「默认预设写」的机器侧证据；端到端 RPC 证据是隔离实机验收 P4 + persist。
   */
  it('setDefaultPresetRemote 真实穿越：写官方 settings → 落盘 → 重建仍在', async () => {
    const { boot, initProfile, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')
    const ConfigEditor = (await import('@deepseek-ai/dsh-config-editor')).default
    const Settings = (await import('@deepseek-ai/dsh-settings')).default
    const AgentPresets = (await import('@deepseek-ai/dsh-agent-preset-registry')).default
    const SessionProjectionRegistry = (await import('@deepseek-ai/dsh-session-projection')).default
    const SessionStore = (await import('@deepseek-ai/dsh-session')).default
    const { parse } = await import('yaml')

    initProfile(profileDir, ['test-bundle'])
    const bundle = join(profileDir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      name: 'test-bundle', version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'session-projection', name: 'cordis:session-projection-registry' },
      { id: 'session-store', name: 'cordis:session' },
      { id: 'agent-preset-registry', name: 'cordis:agent-presets', config: { default: 'standard' } },
    ] }]))
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')

    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'),
      cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }

    const start = async (): Promise<CordisContext> => boot(
      'test', join(profileDir, 'cordis.yml'), readProfilePatches('test', profile),
      (ctx: CordisContext) => {
        ctx.provide('profileContext', profile)
        ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
        Object.assign(ctx.loader.builtins, {
          editor: ConfigEditor,
          settings: Settings,
          'session-projection-registry': SessionProjectionRegistry,
          session: SessionStore,
          'agent-presets': AgentPresets,
        })
      },
    )
    const awaitRows = async (ctx: CordisContext): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        if (ctx.get('settings') !== undefined && ctx.get('agentPresets') !== undefined) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('boot 后 settings/agentPresets 未就绪')
    }
    /** 与 apply() 同款装配：服务持有的就是插件作用域 ctx（模块 inject 决定其依赖面）。 */
    const serviceOn = (ctx: CordisContext): CorumAgentService => {
      const service = Object.create(CorumAgentService.prototype) as CorumAgentService
      Object.defineProperty(service, 'ctx', { value: ctx, writable: true })
      // 本用例不测用户 preset 注册；`ready === undefined` ⇒ ready 等待直接跳过。
      Object.defineProperty(service, 'presetRegistration', { value: { ready: undefined } })
      return service
    }

    const ctx1 = await start()
    await awaitRows(ctx1)
    const result = await serviceOn(ctx1).setDefaultPresetRemote('standard')
    expect(result).toEqual({ ok: true })

    const patch1 = parse(readFileSync(profile.patchPath, 'utf8')) as Array<{ id: string; config?: Record<string, unknown> }>
    const row1 = patch1.find(row => row.id === 'agent-preset-registry')
    expect(row1?.config?.selectedDefault).toBe('standard')

    await ctx1.fiber.dispose()

    const ctx2 = await start()
    await awaitRows(ctx2)
    expect(ctx2.agentPresets.defaultId).toBe('standard')
    const patch2 = parse(readFileSync(profile.patchPath, 'utf8')) as Array<{ id: string; config?: Record<string, unknown> }>
    expect(patch2.find(row => row.id === 'agent-preset-registry')?.config?.selectedDefault).toBe('standard')
    await ctx2.fiber.dispose()
  }, 30_000)
})
