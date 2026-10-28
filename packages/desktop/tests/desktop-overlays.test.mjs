import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  composeDesktopOverlays,
  pickOverrideRows,
  countInsertRows,
} from '../lib/types/host/desktop-overlays.js'
import { extractInsertBlocks } from '../lib/types/host/runtime-bundle.js'
import { readProfilePatches, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

/**
 * 桌面层栈的回归网（rc3 根因）。
 *
 * 官方 `readProfilePatches()` 只组合
 * `bundle → profile patch → home patch → context.overlays (+ telemetry)`；
 * `dsh-config-editor.edit()`（设置中心写盘）与 `dsh-hmr.reconcileProfile()`
 * 都经它 recompose 整棵 profile 树。因此：
 *
 *  · **覆盖行**（`disabled` / `config`）必须在 `profileContext.overlays` 里完整出现
 *    —— 否则任何一次热重组都把 desktop/IDE 覆盖层还原成基座默认（webserver 回落
 *    3080、官方 plugin-manager/credentials 复活撞服务名）；
 *  · **insert 行**（行定义）必须**不在** overlays 里，而在 profile patch **之前**的
 *    bundle 层（见 `runtime-bundle.ts`）—— 否则设置中心写 corum 的任何 ns 都会被
 *    官方守卫拒成 `Configuration for "…" is overridden by a home patch or
 *    command-line overlay`（composeEntries：覆盖行无法创建行、目标行不存在即丢弃）。
 *
 * 真宿主证据：`tests/profile-context-recompose.test.mjs`（子进程 boot + 真写盘）。
 */

/** 用带标记 id 覆盖行造一层，便于按 id 断言顺序。 */
const layer = (id) => [{ id, config: { marker: id } }]

/** 一条基准输入：各层 id 都不同，顺序即断言目标（输入只含覆盖行）。 */
function fixtureLayers() {
  return {
    overlays: layer('desktop-overlay'),
    presetOverlays: layer('preset-overlay'),
    modeOverlays: layer('ide-overlay'),
    comboOverlays: {
      patches: layer('combo-patch'),
      rows: [],
    },
    extensionPackPatches: [{ insert: [{ id: 'extension-row', name: '@corum/extension-row' }] }],
    disabledPatches: [{ id: 'user-disabled', disabled: true }],
  }
}

const ids = rows => rows.map(row => (typeof row.id === 'string' ? row.id : `insert:${row.insert?.map(r => r.id).join(',')}`))

test('固定层按层栈顺序只含启动固定层的覆盖行', () => {
  const { fixedOverlays } = composeDesktopOverlays(fixtureLayers())
  assert.deepEqual(ids(fixedOverlays), [
    'desktop-overlay',
    'preset-overlay',
    'ide-overlay',
    'combo-patch',
  ])
})

test('固定层不含扩展包行 / 插件中心禁用行 / telemetry patch', () => {
  const layers = { ...fixtureLayers(), telemetryPatch: { id: 'session-telemetry-otel', disabled: true } }
  const { fixedOverlays, bootOverlays } = composeDesktopOverlays(layers)
  const fixedIds = ids(fixedOverlays)
  assert.ok(!fixedIds.includes('insert:extension-row'), '扩展包 insert 行必须走 extensionManager 热应用通道')
  assert.ok(!fixedIds.includes('user-disabled'), '插件中心禁用行必须走 extensionManager 现读通道')
  assert.ok(!fixedIds.includes('session-telemetry-otel'), 'telemetry patch 由官方 readProfilePatches 现算')
  // 而冷启动层栈必须仍然包含它们（否则扩展包插件与用户禁用根本不生效）。
  assert.deepEqual(ids(bootOverlays), [
    'desktop-overlay',
    'preset-overlay',
    'ide-overlay',
    'combo-patch',
    'insert:extension-row',
    'user-disabled',
    'session-telemetry-otel',
  ])
})

test('未启用 telemetry 开关时冷启动层栈不追加 telemetry 行', () => {
  const { bootOverlays } = composeDesktopOverlays(fixtureLayers())
  assert.ok(!ids(bootOverlays).includes('session-telemetry-otel'))
})

test('pickOverrideRows 只剔 insert 行，disabled 行逐一保留', () => {
  const parsed = [
    { id: 'webserver', config: { port: 0 } },
    { id: 'plugin-manager', disabled: true },
    { insert: [{ id: 'corum-review', name: '@corum/corum-agent/review-settings' }] },
    { id: 'credentials', disabled: true },
  ]
  assert.deepEqual(ids(pickOverrideRows(parsed)), ['webserver', 'plugin-manager', 'credentials'])
  assert.equal(countInsertRows(parsed), 1)
})

/** 造一份最小 ProfileContext（home 指向空临时目录，patchPath 不存在）。 */
function fixtureContext(home, overlays, telemetryDisabledEnv) {
  return {
    name: 'web',
    dir: join(home, 'profiles', 'web'),
    patchPath: join(home, 'profiles', 'web', 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    cwd: home,
    home,
    startedBundles: ['@deepseek-ai/dsh-base'],
    overlays,
    telemetryDisabledEnv,
  }
}

const PROFILE_PATCH = [{ insert: [{ id: 'session-telemetry-otel', name: '@deepseek-ai/dsh-session-telemetry-otel' }] }]

/** 跑一次官方 readProfilePatches（profile 层用固定 patch 文档，home 层为空）。 */
function readWith(home, overlays, telemetryDisabledEnv) {
  return readProfilePatches('test', fixtureContext(home, overlays, telemetryDisabledEnv), {
    name: 'web',
    dir: join(home, 'profiles', 'web'),
    layers: [{ packageName: '@deepseek-ai/dsh-base', packageDir: home, patchPaths: [], patches: [] }],
    patchPath: join(home, 'profiles', 'web', 'cordis.patch.yml'),
    patches: PROFILE_PATCH,
    skippedBundles: [],
  })
}

test('readProfilePatches 用 profileContext.overlays 完整重放固定层（含 disabled 行）', () => {
  const home = mkdtempSync(join(tmpdir(), 'corum-overlays-'))
  try {
    const layers = fixtureLayers()
    // disabled 行是「抑制官方包、让 fork 独占 cordis service 名」的唯一手段，
    // 必须在热重组里仍然生效 ⇒ 不能被任何 filter 丢掉。真实 desktop 层就用同一形态
    // 抑制官方 plugin-manager / credentials。
    layers.overlays = [...layer('desktop-overlay'), { id: 'plugin-manager', disabled: true }]
    const { fixedOverlays } = composeDesktopOverlays(layers)
    const patches = readWith(home, fixedOverlays, undefined)
    // 官方组合 = bundle + profile patch + home patch + overlays (+ telemetry)。
    // home patch 文件不存在 ⇒ 空；这里断言「profile patch 之后」整段与固定层逐一相同、
    // 顺序相同 —— 热重组的输入与冷启动 boot() 的输入在固定层上一致。
    assert.deepEqual(ids(patches), ['insert:session-telemetry-otel', ...ids(fixedOverlays)])
    const pluginManagerRow = patches.find(row => row.id === 'plugin-manager')
    assert.equal(pluginManagerRow?.disabled, true, '官方 plugin-manager 的禁用行必须在热重组输入里存活')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('telemetry patch 由官方生成且只出现在尾部（profileContext 不重复携带）', () => {
  const home = mkdtempSync(join(tmpdir(), 'corum-overlays-'))
  try {
    const { fixedOverlays } = composeDesktopOverlays(fixtureLayers())
    const patches = readWith(home, fixedOverlays, '1')
    // 官方 resolveTelemetryPatch 生成的禁用行必须**恰好一条**，且在末尾。
    const generated = patches.filter(row => row.id === 'session-telemetry-otel' && row.disabled === true)
    assert.equal(generated.length, 1)
    assert.deepEqual(patches.at(-1), { id: 'session-telemetry-otel', disabled: true })
    assert.deepEqual(ids(patches), ['insert:session-telemetry-otel', ...ids(fixedOverlays), 'session-telemetry-otel'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('真实 patch 文件：desktop 层恒禁官方 plugin-manager（minimal 模式也生效）', () => {
  const desktop = loadOverlayPatches('test', new URL('../cordis.patch.yml', import.meta.url).pathname)
  const row = desktop.find(row => row.id === 'plugin-manager')
  assert.equal(row?.disabled, true, 'cordis.patch.yml 必须禁用官方 plugin-manager：desktop 恒 provide profileContext，官方行会激活并与 CorumPluginManager 撞服务名')

  const ide = loadOverlayPatches('test', new URL('../cordis.ide.patch.yml', import.meta.url).pathname)
  // IDE 层不再重复该行（已上移到 desktop 传输层）；若将来又加回来也必须仍是 disabled。
  const ideRow = ide.find(row => row.id === 'plugin-manager')
  assert.ok(ideRow === undefined || ideRow.disabled === true)
})

test('真实 patch 文件：固定层里没有任何 disabled 行被过滤', () => {
  const desktop = loadOverlayPatches('test', new URL('../cordis.patch.yml', import.meta.url).pathname)
  const overrides = pickOverrideRows(desktop)
  const { fixedOverlays } = composeDesktopOverlays({
    overlays: overrides,
    presetOverlays: [],
    modeOverlays: [],
    comboOverlays: { patches: [], rows: [] },
    extensionPackPatches: [],
    disabledPatches: [],
  })
  const disabledIds = fixedOverlays.filter(row => row.disabled === true).map(row => row.id)
  assert.ok(disabledIds.length > 0)
  // 关键两条：官方 plugin-manager / credentials 的抑制行。
  for (const id of ['plugin-manager', 'credentials']) {
    assert.ok(disabledIds.includes(id), `official ${id} row must stay disabled in the fixed layer`)
  }
  assert.equal(fixedOverlays.length, overrides.length, '覆盖行必须逐行完整（一条都不能少）')
})

test('真实 patch 文件：insert 行按原文抽出（!!js 表达式不丢标签）', () => {
  for (const file of ['../cordis.patch.yml', '../presets.patch.yml', '../cordis.ide.patch.yml']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    const blocks = extractInsertBlocks(text)
    assert.ok(blocks.length > 0, `${file} 应含顶层 insert 块`)
    for (const block of blocks) {
      assert.match(block, /^- insert:\n/, `${file} 的 insert 块必须从列 0 开始`)
      assert.match(block, /^ {4}- id: /m, `${file} 的 insert 行必须 4 空格缩进`)
      // 块内不得混进下一条顶层行（切分边界必须干净）。
      assert.doesNotMatch(block.split('\n').slice(1).join('\n'), /^- (id|insert|group):/m)
    }
    // 原文切片：每个块必须是源文件的**逐字子串**（`!!js` 表达式因此不可能被改写）。
    for (const block of blocks) assert.ok(text.includes(block), `${file} 的 insert 块必须是原文子串`)
  }
})
