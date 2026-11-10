import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { extractInsertBlocks } from '../lib/types/host/runtime-bundle.js'
import { pickOverrideRows } from '../lib/types/host/desktop-overlays.js'

/**
 * fork #18（@corum/corum-ui-renderer）装载结构的**行为回归**（不是静态 YAML 计数）。
 *
 * ## 为什么必须有这个测试（2026-11-07 rc3 实机事故）
 *
 * 原先的写法是「按 id 覆盖官方行的 name」：
 *
 *   - id: ui-renderer
 *     name: '@corum/corum-ui-renderer'
 *
 * 静态读 YAML 会以为行名改成 fork 名了 —— 但 `cordis-plugin-include` 的
 * `applyEntryPatches()` 把补丁行的 `name:` 当**校验守卫**：
 * `name !== target.name` 时**整行** `patch: name mismatch … skipping` 丢弃。
 * 于是行名仍是官方名，而 pnpm override 让官方名解析到 fork 包
 * （`package.json.name = @corum/corum-ui-renderer`），client-modules 的
 * `nearestPackage(moduleUrl, expectedPackageName)` 要求两者相等，不等就**静默**
 * 不算 client 包 ⇒ `ctx.uiRenderer` 永不 provide ⇒ `ctx.slots` 不装 ⇒ 58 个客户端
 * 插件全 pending ⇒ 主窗只剩 `Failed to load plugins`（实机证据见
 * corum-dev-preset/docs/evidence/rc3-defensive-build-and-restart-2026-11-07.md §5.4）。
 *
 * ## 这个测试怎么做到「真」
 *
 * - base 层 = **官方** `@deepseek-ai/dsh-web-app/cordis.patch.yml`，用 app-boot 自己的
 *   `loadOverlayPatches()` 解析（`!!js` 标签按官方 dialect 处理，不 mock）；
 * - 行定义层 = 用**真实** `extractInsertBlocks()` 从本仓 `cordis.patch.yml` 抽出顶层
 *   insert 块原文（与 `publishRuntimeBundle` 写进运行期 bundle 的是同一份文本），落到
 *   临时文件后**同样**走 `loadOverlayPatches()`（与 loader 读那份文件是同一条路径）；
 * - 覆盖层 = 用**真实** `pickOverrideRows()` 从本仓 patch 里筛（`disabled` 行留 overlay）；
 * - 合成用 **app-boot 自己的 `composeEntries()`**（真实 `applyEntryPatches` 的薄包装），
 *   并把 warn sink 接出来断言「没有任何 patch 被跳过」。
 *
 * 断言三件事：
 *  ① 现行结构：官方 `ui-renderer` **被禁用**、`corum-ui-renderer` **恰好 1 行**且 name 是 fork；
 *  ② 行名 == fork 包 `package.json.name`（client bundle 能被登记的前提）；
 *  ③ 旧写法（按 id 改 name）**必须**产生 `name mismatch … skipping` 且**不**产生新行 ——
 *     这条是防「再靠静态 YAML 自欺欺人」的守卫。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = join(HERE, '..')
const DESKTOP_PATCH = join(DESKTOP_ROOT, 'cordis.patch.yml')
const require = createRequire(join(DESKTOP_ROOT, 'package.json'))

const BIN = 'renderer-row-test'
const RENDERER_ROW_ID = 'ui-renderer'
const RENDERER_FORK_ROW_ID = 'corum-ui-renderer'
const RENDERER_FORK_NAME = '@corum/corum-ui-renderer'
const OFFICIAL_RENDERER_NAME = '@deepseek-ai/dsh-client-ui-renderer'

/**
 * 官方 bundle 层（按 profile 的 bundle 顺序）：`dsh-base` 定义 host 服务/工具行，
 * `dsh-web-app` 定义并启用官方 `ui-renderer` 行。两层都要带上，否则本仓指向 base
 * 行的覆盖补丁会全部报 `entry … not found`（那是另一个测试面，不属于本文件）。
 */
function officialBundlePatchFiles() {
  return ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].map(
    name => join(dirname(require.resolve(`${name}/package.json`)), 'cordis.patch.yml'),
  )
}

/**
 * 本仓 patch 的顶层 insert 块 → 运行期 bundle 文本（与 `publishRuntimeBundle` 同形：
 * 块之间空行、末尾换行；没有块时是 `[]`）。
 */
function runtimeBundleText(text) {
  const blocks = extractInsertBlocks(text)
  return blocks.length === 0 ? '[]\n' : `${blocks.join('\n\n')}\n`
}

/** 在临时目录里落一份 patch 并用官方解析器读回来（与 loader 读 patch 文件同一条路径）。 */
function loadPatchText(text) {
  const dir = mkdtempSync(join(tmpdir(), 'corum-renderer-row-'))
  const file = join(dir, 'cordis.patch.yml')
  try {
    writeFileSync(file, text)
    return loadOverlayPatches(BIN, file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 组合一次真实层栈，返回 rows + 被跳过的 patch 警告。 */
function composeRealLayers() {
  const desktopText = readFileSync(DESKTOP_PATCH, 'utf8')
  const basePatches = officialBundlePatchFiles().flatMap(file => loadOverlayPatches(BIN, file))
  const desktopPatches = loadPatchText(desktopText)
  // 运行期 bundle：只带本仓 patch 的顶层 insert 块（`config:` 行另有去处，与本测试无关）。
  const runtimePatches = loadPatchText(runtimeBundleText(desktopText))
  const overlayRows = pickOverrideRows(desktopPatches)
  const warnings = []
  const rows = composeEntries(
    [basePatches, runtimePatches, overlayRows],
    message => warnings.push(message),
  )
  return { rows, warnings, overlayRows, desktopPatches, runtimePatches }
}

const byId = (rows, id) => rows.filter(row => row && row.id === id)
const isEnabled = row => row.disabled !== true

test('现行结构：官方 ui-renderer 行被禁用，corum-ui-renderer 恰好 1 行且挂 fork', () => {
  const { rows, warnings } = composeRealLayers()

  // 任何 patch 都不许被跳过：跳过就意味着「写的行没生效」。
  assert.deepEqual(warnings, [], `composeEntries 报告了被跳过的 patch：\n${warnings.join('\n')}`)

  const officialRows = byId(rows, RENDERER_ROW_ID)
  assert.equal(officialRows.length, 1, `官方 ${RENDERER_ROW_ID} 行应恰好 1 条，实际 ${officialRows.length}`)
  assert.equal(
    isEnabled(officialRows[0]),
    false,
    `官方 ${RENDERER_ROW_ID} 行必须被禁用（否则与 fork 行争同一个 slots provider 地址），实际 ${JSON.stringify(officialRows[0])}`,
  )

  const forkRows = byId(rows, RENDERER_FORK_ROW_ID)
  assert.equal(forkRows.length, 1, `${RENDERER_FORK_ROW_ID} 行应恰好 1 条，实际 ${forkRows.length}`)
  assert.equal(forkRows[0].name, RENDERER_FORK_NAME, `${RENDERER_FORK_ROW_ID} 的 name 必须是 fork 包名`)
  assert.equal(isEnabled(forkRows[0]), true, `${RENDERER_FORK_ROW_ID} 必须是启用状态`)

  // 不能有第二条「挂着 fork 包名」的行（重复行会让 client-modules 报多源）。
  const forkNamed = rows.filter(row => row && row.name === RENDERER_FORK_NAME)
  assert.equal(forkNamed.length, 1, `挂 ${RENDERER_FORK_NAME} 的行应恰好 1 条，实际 ${forkNamed.length}`)
})

test('行定义确实来自运行期 bundle 的 insert 块（不是覆盖行）', () => {
  const { runtimePatches, desktopPatches } = composeRealLayers()

  const inserted = runtimePatches.flatMap(patch => patch.insert ?? [])
  const insertedForkRows = inserted.filter(row => row && row.id === RENDERER_FORK_ROW_ID)
  assert.equal(insertedForkRows.length, 1, `运行期 bundle 的 insert 里应恰好 1 条 ${RENDERER_FORK_ROW_ID}`)
  assert.equal(insertedForkRows[0].name, RENDERER_FORK_NAME, 'insert 行的 name 必须是 fork 包名')

  // 覆盖层里不许再出现「靠 name 改名」的渲染器行（那正是旧写法的形态）。
  const overrides = desktopPatches.filter(row => row && row.id === RENDERER_ROW_ID)
  assert.equal(overrides.length, 1, `本仓应有且仅有 1 条 id: ${RENDERER_ROW_ID} 的覆盖行`)
  assert.equal('name' in overrides[0], false, `覆盖行不许再写 name（补丁行的 name 是校验守卫，不是改名）：${JSON.stringify(overrides[0])}`)
})

test('行名 == fork 包 package.json.name（client bundle 能被登记的前提）', () => {
  const { rows } = composeRealLayers()
  const forkRow = byId(rows, RENDERER_FORK_ROW_ID)[0]
  const forkManifest = JSON.parse(
    readFileSync(join(dirname(require.resolve(`${RENDERER_FORK_NAME}/package.json`)), 'package.json'), 'utf8'),
  )

  assert.equal(forkManifest.name, RENDERER_FORK_NAME, `fork 包的 package.json.name 必须是 ${RENDERER_FORK_NAME}`)
  // client-modules 的 nearestPackage(moduleUrl, expectedPackageName) 判等就是这一条。
  assert.equal(
    forkRow.name,
    forkManifest.name,
    'Loader 行名必须与解析到的 package.json.name 相等，否则该行的 client 半会被静默丢弃（白屏）',
  )
  // 官方名解析到 fork —— 这正是「行名仍写官方名」必然失败的原因，钉成断言。
  const resolvedOfficialName = JSON.parse(
    readFileSync(join(dirname(require.resolve(`${OFFICIAL_RENDERER_NAME}/package.json`)), 'package.json'), 'utf8'),
  ).name
  assert.equal(resolvedOfficialName, RENDERER_FORK_NAME, '本仓 override 让官方名解析到 fork 包')
})

test('旧写法（按 id 改 name）必须被 applyEntryPatches 跳过，且建不出新行', () => {
  const basePatches = officialBundlePatchFiles().flatMap(file => loadOverlayPatches(BIN, file))
  // 2026-11-07 之前的写法：只给 name、没有 insert。
  const legacyOverlay = [{ id: RENDERER_ROW_ID, name: RENDERER_FORK_NAME }]
  const warnings = []
  const rows = composeEntries([basePatches, legacyOverlay], message => warnings.push(message))

  assert.equal(warnings.length, 1, `旧写法必须产生 1 条 patch 警告，实际 ${JSON.stringify(warnings)}`)
  assert.match(warnings[0], /name mismatch/, `旧写法的警告应是 name mismatch，实际：${warnings[0]}`)
  assert.match(warnings[0], /skipping/, '旧写法的整行必须被 skipping（不是改名）')

  const officialRow = byId(rows, RENDERER_ROW_ID)[0]
  assert.equal(officialRow.name, OFFICIAL_RENDERER_NAME, '旧写法不会改掉行名（这就是 rc3 白屏的根因）')
  assert.equal(isEnabled(officialRow), true, '旧写法还会让官方行保持启用')
  assert.equal(byId(rows, RENDERER_FORK_ROW_ID).length, 0, '旧写法永远不会建出 fork 行')
})
