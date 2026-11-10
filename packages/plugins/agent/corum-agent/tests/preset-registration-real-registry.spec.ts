/**
 * preset 自愈 × **真** @deepseek-ai/dsh-agent-preset-registry（2026-11-01 验收纠正）。
 *
 * ## 为什么必须有这一条（mock 证明不了的事）
 *
 * 上一轮的「同 stamp mount 失败自动重试 1 次」只在 mock `register` **reject** 时成立。
 * 上游真实语义不是 reject：
 *
 * ```js
 * // @deepseek-ai/dsh-agent-preset-registry/lib/index.js  activate()
 * } catch (error) {
 *   record.broken = error.message
 *   this.owner.logger.warn(...)
 *   await scope.dispose()
 * }
 * // register(): this.definitions.set(id, record); record.ready = this.activate(record)
 * //             await record.ready;  return unregister      ← 照常 resolve
 * ```
 *
 * 也就是说 mount 失败的 preset **register 是 resolve 的**，定义留在 registry 里，
 * `list()` 返回它并带 `broken`。只看 resolve 就把坏 preset 记成「已挂载」⇒ 自动重试
 * 对真实 broken 永不触发。本用例用**真 registry + 真 loader + 真 boot** 固定这条语义：
 *
 *   ① 坏内容 → `registerAllUserPresets` → `list()` 有 broken，且**不算挂上**
 *      （`registerUserPreset` 返回 false / status 是 `mount-broken`）；
 *   ② 修盘为合法内容 → `refreshChanged()` → `list()` 的 broken 消失、
 *      `resolve()` 可用（真的能 retain/创建，不是「记录上好看」）；
 *   ③ 再改回坏内容 → `refreshChanged()` → broken 回来（**不伪装 pass**）。
 *
 * 这台 boot 的 loader 只注册了 5 个 builtin（settings/editor/session/…），所以
 * 「合法内容」用一行**结构性 group**（`cordis:group` + 空 config）——它真的能被
 * EntryTree 挂上、且不依赖任何宿主服务；「坏内容」用不存在的模块名（loader 装载
 * 失败 ⇒ activate throw ⇒ record.broken）。两者都走**真实** mount 路径。
 *
 * @module @corum/corum-agent/tests/preset-registration-real-registry
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { PresetRegistrationState } from '../src/preset-registration.ts'

/** 合法组合：一个空的结构性 group（真能挂上、不需要任何宿主服务）。 */
const GOOD_CORDIS_YML = '- name: cordis:group\n  group: true\n  config: []\n'

/** 坏组合：装载点不存在 ⇒ activate throw ⇒ record.broken（上游不 reject）。 */
const BAD_CORDIS_YML = '- name: corum-agent-definitely-not-a-module\n'

/**
 * 造一台**真上游**宿主：官方 boot + config-editor + settings + agent-preset-registry。
 * 与 default-preset.spec.ts 的「真实穿越」用例同一套装配（同版本上游包）。
 */
async function bootRealRegistry(home: string, profileDir: string): Promise<CordisContext> {
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

  const ctx = await boot('test', join(profileDir, 'cordis.yml'), readProfilePatches('test', profile), (inner: CordisContext) => {
    inner.provide('profileContext', profile)
    inner.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(inner.loader.builtins, {
      editor: ConfigEditor,
      settings: Settings,
      'session-projection-registry': SessionProjectionRegistry,
      session: SessionStore,
      'agent-presets': AgentPresets,
    })
  })
  // 等 registry 行激活（与 default-preset.spec 同款轮询）。
  for (let i = 0; i < 50; i++) {
    if (ctx.get('agentPresets') !== undefined) return ctx
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('boot 后 agentPresets 未就绪')
}

describe('PresetRegistrationState × 真上游 registry：broken 语义（resolve 成功 ≠ 挂上）', () => {
  let home: string
  let profileDir: string
  let corumHome: string
  let oldDshHome: string | undefined
  let oldCorumHome: string | undefined

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'corum-preset-real-')))
    profileDir = join(home, 'profiles', 'test')
    corumHome = join(home, 'corum')
    oldDshHome = process.env.DSH_HOME
    oldCorumHome = process.env.CORUM_HOME
    process.env.DSH_HOME = home
    process.env.CORUM_HOME = corumHome
  })

  afterEach(() => {
    if (oldDshHome !== undefined) process.env.DSH_HOME = oldDshHome
    else delete process.env.DSH_HOME
    if (oldCorumHome !== undefined) process.env.CORUM_HOME = oldCorumHome
    else delete process.env.CORUM_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('坏 → 修 → broken 消失且可 retain；再改坏 → 保持 broken（不伪装 pass）', async () => {
    const ctx = await bootRealRegistry(home, profileDir)
    const registry = ctx.agentPresets as unknown as {
      list: () => Promise<{ id: string; broken?: string }[]>
      resolve: (id?: string) => Promise<{ id: string; broken?: string }>
      register: (definition: unknown) => Promise<() => Promise<void>>
    }

    // ── 落盘一份**坏** preset（agent.json 供 listProfiles 发现 + 坏组合）──────────
    const dir = join(corumHome, '.agent-presets', 'real-broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({
      id: 'real-broken', baseMode: 'standard', prompt: 'probe',
      model: { provider: 'local', model: 'deepseek-v4-flash' },
      skills: [], mcpServers: [], terminal: { mode: 'sandbox' },
      memoryPolicy: { scope: 'agent' }, version: 1, trust: 'user',
    }, null, 2))
    writeFileSync(join(dir, 'agent.cordis.yml'), BAD_CORDIS_YML)

    const state = new PresetRegistrationState(ctx as never)

    // ── ① 初次注册：register **resolve** 了，但上游把 mount 失败写进 broken ─────────
    await state.registerAllUserPresets()
    // 定义真的进了 registry（这是「resolve 成功」的那一半事实）。
    const first = (await registry.list()).find(row => row.id === 'real-broken')
    expect(first, 'registry.list() 应含该定义（register 是 resolve 的）').toBeDefined()
    expect(first?.broken, '上游应把 mount 失败写成 broken').toBeTruthy()
    // 但**不算挂上**：自愈记账不写成功假象。
    expect(await state.registerUserPreset('real-broken')).toBe(false)
    // 定义仍在（keep broken 的定义不删），disposer 留着以便重挂前撤掉。
    expect((await registry.list()).some(row => row.id === 'real-broken')).toBe(true)

    // ── ② 修盘为合法内容 → refreshChanged → broken 消失、可 retain ────────────────
    writeFileSync(join(dir, 'agent.cordis.yml'), GOOD_CORDIS_YML)
    await state.refreshChanged()
    const healed = (await registry.list()).find(row => row.id === 'real-broken')
    expect(healed, '修好后定义应仍在').toBeDefined()
    expect(healed?.broken, '修好内容后 broken 必须消失').toBeUndefined()
    // 真的可用：resolve（RPC 侧 retain/创建用的就是这条）无 broken。
    expect((await registry.resolve('real-broken')).broken).toBeUndefined()
    // 记账也认这次成功（再来一轮 refresh 是 0 次注册）。
    expect(await state.registerUserPreset('real-broken')).toBe(true)

    // ── ③ 再改回坏内容 → refreshChanged → broken 回来（不伪装 pass）───────────────
    writeFileSync(join(dir, 'agent.cordis.yml'), BAD_CORDIS_YML)
    await state.refreshChanged()
    const again = (await registry.list()).find(row => row.id === 'real-broken')
    expect(again, '改坏后定义应仍在（保留 broken 定义而不是删掉）').toBeDefined()
    expect(again?.broken, '改回坏内容后必须重新 broken').toBeTruthy()
    expect(await state.registerUserPreset('real-broken')).toBe(false)
    // region：坏的定义没人删（keep broken），且没有「假成功」的挂载记账。
    expect(state.registeredIds).toContain('real-broken')

    await ctx.fiber.dispose()
  }, 60_000)
})
