/**
 * 静态合成测试：官方 rc3 bundle patches + corum presets.patch.yml 按 boot 同顺序
 * composeEntries → 验证 list 含 standard/ptc/cordis/minimal/conductor + default bind 不抛
 * （rc3 preset 专项 M4）。
 *
 * 按 boot.ts 同顺序：
 *   bundlePatches → profile.patches → homePatches → overlays(DesktopPatch)
 *   → presetOverlays(presets.patch.yml) → modeOverlays → ...
 *
 * 本测试只验 preset 层：bundle patches（官方 4 份 preset insert + registry row）
 * + presetOverlays（corum 覆盖行 + conductor insert）→ composeEntries。
 *
 * 不启动 cordis/registry——纯静态 compose（与 boot.ts 的 composeEntries 调用同路径）。
 * 验证：
 *   ① 合成结果含五个 preset id：standard/ptc/minimal/cordis/conductor；
 *   ② registry 行 agent-preset-registry 存在且 config.default = 'standard'（官方 bundle 默认）；
 *   ③ default bind 不抛（registry 行 default 字段合法）；
 *   ④ standard/conductor 的 delegation 行含 @corum/corum-tool-subagent（3 实例）；
 *   ⑤ standard/conductor 不含旧 config 键（如 `provider: spawn` 官方行被覆盖）；
 *   ⑥ minimal 官方 insert 合法保留（corum minimal 无增量，官方 rc3 insert 即迁移落点）。
 *
 * @module @corum/corum-agent/tests/preset-composition
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/**
 * 解析一个 npm 包的根目录：从 createRequire 解析包名。
 * 测试环境里 node_modules 已安装，可直接 require.resolve。
 */
function resolvePackageDir(packageName: string): string {
  const req = createRequire(import.meta.url)
  const resolved = req.resolve(`${packageName}/package.json`)
  return dirname(resolved)
}

/** 读取官方 web-app 的 4 份 preset patch + cordis.patch.yml（含 registry row）。 */
function loadOfficialBundlePatches(): PatchOptions[] {
  const webAppDir = resolvePackageDir('@deepseek-ai/dsh-web-app')
  const patches: PatchOptions[] = []
  // cordis.patch.yml（含 agent-preset-registry 行 + preset insert 行）
  const cordisPatch = join(webAppDir, 'cordis.patch.yml')
  if (existsSync(cordisPatch)) patches.push(...loadOverlayPatches('test', cordisPatch))
  // 4 份 preset patches
  for (const name of ['standard', 'ptc', 'minimal', 'cordis']) {
    const presetPatch = join(webAppDir, 'presets', `${name}.patch.yml`)
    if (existsSync(presetPatch)) patches.push(...loadOverlayPatches('test', presetPatch))
  }
  return patches
}

/** 读取 corum desktop 的 presets.patch.yml（覆盖行 + conductor insert）。 */
function loadCorumPresetOverlays(): PatchOptions[] {
  // corum-desktop 包根 → presets.patch.yml
  const desktopDir = resolvePackageDir('corum-desktop')
  // corum-desktop 是 private 包，可能没有 exports；直接读文件
  const presetsPatch = join(desktopDir, 'presets.patch.yml')
  if (!existsSync(presetsPatch)) {
    // fallback: 从 packages/desktop 源目录读（开发环境）
    const srcPath = join(process.cwd(), 'packages', 'desktop', 'presets.patch.yml')
    if (existsSync(srcPath)) return loadOverlayPatches('test', srcPath)
    return []
  }
  return loadOverlayPatches('test', presetsPatch)
}

/** 从合成结果中取一个 preset 行的 config.plugins（扁平化为 plugin id 列表）。 */
function pluginIdsOfRow(rows: ReturnType<typeof composeEntries>, presetConfigId: string): string[] {
  // preset 行的 config.id = preset 的短名（standard/ptc/cordis/conductor/minimal）
  // 行 id 是 preset-standard 等，但 config.id 是 standard 等
  const row = rows.find(r => {
    const config = r.config as { id?: string } | undefined
    return config?.id === presetConfigId
  })
  if (row === undefined) return []
  const plugins = (row.config as { plugins?: Array<{ id?: string }> }).plugins ?? []
  return plugins.map(p => p.id ?? '').filter(id => id !== '')
}

/** 取 delegation group 的 plugins（嵌套在 group 行内）。 */
function delegationPlugins(rows: ReturnType<typeof composeEntries>, presetConfigId: string): Array<{ id?: string; name?: string }> {
  const row = rows.find(r => {
    const config = r.config as { id?: string } | undefined
    return config?.id === presetConfigId
  })
  if (row === undefined) return []
  const plugins = (row.config as { plugins?: Array<{ id?: string; name?: string; config?: unknown }> }).plugins ?? []
  const delegation = plugins.find(p => p.id === 'delegation')
  if (delegation === undefined) return []
  // delegation 是 group 行，其 config 是子行数组
  const subRows = (delegation as { config?: Array<{ id?: string; name?: string }> }).config ?? []
  return subRows
}

describe('静态合成：官方 rc3 bundle patches × corum presets.patch.yml (M4)', () => {
  let composed: ReturnType<typeof composeEntries> | undefined

  it('合成不抛（官方 4 preset + registry row + corum 覆盖 + conductor insert）', () => {
    const bundlePatches = loadOfficialBundlePatches()
    const corumOverlays = loadCorumPresetOverlays()
    expect(bundlePatches.length).toBeGreaterThan(0)
    expect(corumOverlays.length).toBeGreaterThan(0)
    // boot.ts 同顺序：bundle → overlays(preset)
    composed = composeEntries([bundlePatches, corumOverlays])
    expect(composed.length).toBeGreaterThan(0)
  })

  it('① 合成结果含五个 preset id：standard/ptc/minimal/cordis/conductor', () => {
    if (composed === undefined) composed = composeEntries([loadOfficialBundlePatches(), loadCorumPresetOverlays()])
    // preset 行的 config.id 是短名
    const configIds = composed.map(r => (r.config as { id?: string } | undefined)?.id).filter(id => typeof id === 'string')
    expect(configIds).toContain('standard')
    expect(configIds).toContain('ptc')
    expect(configIds).toContain('minimal')
    expect(configIds).toContain('cordis')
    expect(configIds).toContain('conductor')
  })

  it('② registry 行 agent-preset-registry 存在且 config.default = standard', () => {
    if (composed === undefined) composed = composeEntries([loadOfficialBundlePatches(), loadCorumPresetOverlays()])
    const registryRow = composed.find(r => r.id === 'agent-preset-registry')
    expect(registryRow).toBeDefined()
    const config = registryRow?.config as { default?: string } | undefined
    expect(config?.default).toBe('standard')
  })

  it('③ default bind 不抛（registry 行 default 字段合法）', () => {
    if (composed === undefined) composed = composeEntries([loadOfficialBundlePatches(), loadCorumPresetOverlays()])
    const registryRow = composed.find(r => r.id === 'agent-preset-registry')
    const config = registryRow?.config as { default?: string } | undefined
    // default bind = registry.list 时按 defaultId 选行，不抛即通过
    expect(() => {
      const defaultId = config?.default ?? 'standard'
      const presetRow = composed!.find(r => (r.config as { id?: string } | undefined)?.id === defaultId)
      expect(presetRow).toBeDefined()
    }).not.toThrow()
  })

  it('④ standard/conductor 的 delegation 含 @corum/corum-tool-subagent（3 实例）', () => {
    if (composed === undefined) composed = composeEntries([loadOfficialBundlePatches(), loadCorumPresetOverlays()])
    for (const presetId of ['standard', 'conductor']) {
      const delegation = delegationPlugins(composed, presetId)
      const corumSubagents = delegation.filter(p => p.name === '@corum/corum-tool-subagent')
      expect(corumSubagents.length).toBe(3)
      // 三实例：worker + research + fork
      const toolNames = delegation.map(p => p.id ?? '')
      expect(toolNames).toContain('tool-subagent')
      expect(toolNames).toContain('tool-subagent-research')
      expect(toolNames).toContain('tool-subagent-fork')
    }
  })

  it('⑤ standard/conductor 不含旧 config 键（provider:spawn 官方行被覆盖）', () => {
    if (composed === undefined) composed = composeEntries([loadOfficialBundlePatches(), loadCorumPresetOverlays()])
    for (const presetId of ['standard', 'conductor']) {
      const delegation = delegationPlugins(composed, presetId)
      // corum 覆盖后，tool-subagent 行的 config.provider 应是 'corum-spawn'（不是官方 'spawn'）
      const subagentRow = delegation.find(p => p.id === 'tool-subagent') as { config?: { provider?: string } } | undefined
      expect(subagentRow?.config?.provider).toBe('corum-spawn')
      // 官方 workflow-ptc 行不应存在（corum 换成了 workflow-worker-thread）
      const ids = delegation.map(p => p.id ?? '')
      expect(ids).not.toContain('workflow-ptc')
    }
  })

  it('⑥ minimal 官方 insert 合法保留（corum minimal 无增量）', () => {
    if (composed === undefined) composed = composeEntries([loadOfficialBundlePatches(), loadCorumPresetOverlays()])
    const minimalPlugins = pluginIdsOfRow(composed, 'minimal')
    // minimal 的官方插件：persona + tool-fs + compaction + persistent-shell
    expect(minimalPlugins).toContain('persona')
    expect(minimalPlugins).toContain('tool-fs')
    expect(minimalPlugins).toContain('compaction')
    expect(minimalPlugins).toContain('persistent-shell')
    // corum minimal 没有覆盖行 ⇒ 不应含 corum delegation（tool-subagent）
    expect(minimalPlugins).not.toContain('delegation')
  })
})

describe('presets.patch.yml 文档矛盾解决：minimal 注明（05 册）', () => {
  it('corum minimal 无增量，官方 rc3 insert 即迁移落点', () => {
    // 读 presets.patch.yml 注释，确认 minimal 段有「官方 insert 保留」说明
    const desktopDir = resolvePackageDir('corum-desktop')
    const presetsPatchPath = join(desktopDir, 'presets.patch.yml')
    let content: string
    if (existsSync(presetsPatchPath)) {
      content = readFileSync(presetsPatchPath, 'utf8')
    } else {
      // fallback: 源目录
      const srcPath = join(process.cwd(), 'packages', 'desktop', 'presets.patch.yml')
      content = readFileSync(srcPath, 'utf8')
    }
    // presets.patch.yml 应有 minimal 段注释说明「corum 不覆盖」「官方 insert 即迁移落点」
    expect(content).toContain('preset-minimal')
    expect(content.toLowerCase()).toMatch(/official.*insert|insert.*official|corum.*no.*increment|无.*覆盖|no.*override/)
  })
})
