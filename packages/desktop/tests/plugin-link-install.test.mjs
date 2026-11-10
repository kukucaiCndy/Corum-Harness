/**
 * 扩展包插件的「符号链接安装」契约。
 *
 * ## 这一组挡的是什么
 *
 * 旧版用 `pnpm add file:<dir>` 装扩展包插件。`file:` 是**复制**语义 ⇒ 同一个包在
 * 磁盘上出现两份互不同步的副本（宿营地 + `profiles/web/node_modules`），
 * 升级只更新一份 ⇒ **装了但没生效，且不报错**。实测排查花了四次重启。
 *
 * 新方案是**两条符号链接、零复制**：
 *
 * ```
 * ① profiles/web/node_modules/<name>        → extension-packs/<packId>/plugins-src/<name>
 * ② extension-packs/.../<name>/node_modules → profiles/node_modules
 * ```
 *
 * ## 两条链接**指向不同目录**（最容易理解错的一点）
 *
 * - ① 让宿主**找到这个包**
 * - ② 让这个包**找到它的依赖**（Node 沿真实路径上溯找 node_modules，
 *   而 `extension-packs/` 那条路径上没有任何 node_modules）
 *
 * 所以断言里专门钉住「两条链接目标不同」以及「② 指向依赖库而非包目录」——
 * 若有人把它们统一成一条，测试必须红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULE = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'types', 'host', 'plugin-link-install.js')).href

/** 造一个最小的 home 布局：profiles/node_modules 与 extension-packs 宿营地。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'corum-link-home-'))
  mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'web', 'node_modules'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'p', dependencies: {} }), 'utf8')
  const pkgDir = join(home, 'extension-packs', 'demo-pack', 'plugins-src', 'demo-plugin')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@demo/plugin', version: '1.0.0' }), 'utf8')
  writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export const x = 1\n', 'utf8')
  return { home, pkgDir }
}

test('localDirFromSpec：file: / link: 都识别，其它返回 undefined', async () => {
  const { localDirFromSpec } = await import(MODULE)
  assert.equal(localDirFromSpec('file:/tmp/a'), '/tmp/a')
  assert.equal(localDirFromSpec('link:/tmp/a'), '/tmp/a')
  assert.equal(localDirFromSpec('@scope/pkg@1.0.0'), undefined)
  assert.equal(localDirFromSpec('file:'), undefined, '空路径不算')
})

test('安装后：两条链接存在，且**指向不同目录**', async () => {
  const { linkInstallLocalPlugin } = await import(MODULE)
  const { home, pkgDir } = makeHome()

  const r = linkInstallLocalPlugin({ home, dir: pkgDir })
  assert.equal(r.ok, true, r.log)

  const packageLink = join(home, 'profiles', 'web', 'node_modules', '@demo', 'plugin')
  const depLink = join(pkgDir, 'node_modules')

  assert.ok(lstatSync(packageLink).isSymbolicLink(), '① 包本体必须是符号链接')
  assert.ok(lstatSync(depLink).isSymbolicLink(), '② 依赖面必须是符号链接')

  assert.equal(resolve(readlinkSync(packageLink)), resolve(pkgDir), '① 指向包目录')
  assert.equal(
    resolve(readlinkSync(depLink)),
    resolve(home, 'profiles', 'node_modules'),
    '② 指向依赖库（不是包目录）',
  )
  assert.notEqual(
    resolve(readlinkSync(packageLink)),
    resolve(readlinkSync(depLink)),
    '两条链接**不能**指向同一个目录 —— 职责不同，合并成一条必失效',
  )
})

test('幂等：重复安装不重建链接（目标不变时保持原样）', async () => {
  const { linkInstallLocalPlugin } = await import(MODULE)
  const { home, pkgDir } = makeHome()

  linkInstallLocalPlugin({ home, dir: pkgDir })
  const packageLink = join(home, 'profiles', 'web', 'node_modules', '@demo', 'plugin')
  const before = lstatSync(packageLink).ino

  const again = linkInstallLocalPlugin({ home, dir: pkgDir })
  assert.equal(again.ok, true)
  assert.equal(lstatSync(packageLink).ino, before, '目标未变时不应删了重建（inode 应保持）')
})

test('实体副本会被换成链接（老用户迁移路径）', async () => {
  const { linkInstallLocalPlugin } = await import(MODULE)
  const { home, pkgDir } = makeHome()

  // 造出旧版 pnpm 的产物：实体目录副本
  const packageLink = join(home, 'profiles', 'web', 'node_modules', '@demo', 'plugin')
  mkdirSync(join(packageLink, 'lib'), { recursive: true })
  writeFileSync(join(packageLink, 'lib', 'index.js'), '// stale copy\n', 'utf8')
  assert.equal(lstatSync(packageLink).isSymbolicLink(), false)

  const r = linkInstallLocalPlugin({ home, dir: pkgDir })
  assert.equal(r.ok, true, r.log)
  assert.ok(lstatSync(packageLink).isSymbolicLink(), '实体副本必须被替换成链接')
})

test('记账：profile dependencies 记为 link: 语义（防 pnpm install 覆盖）', async () => {
  const { linkInstallLocalPlugin } = await import(MODULE)
  const { home, pkgDir } = makeHome()

  linkInstallLocalPlugin({ home, dir: pkgDir })
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.equal(
    manifest.dependencies['@demo/plugin'],
    `link:${resolve(pkgDir)}`,
    '必须是 link: 而不是 file: —— file: 会让 pnpm 复制，一次 install 就把链接冲掉',
  )
})

test('卸载：只删链接，不动包目录', async () => {
  const { linkInstallLocalPlugin, linkUninstallLocalPlugin } = await import(MODULE)
  const { home, pkgDir } = makeHome()
  linkInstallLocalPlugin({ home, dir: pkgDir })

  const r = linkUninstallLocalPlugin({ home, packageName: '@demo/plugin' })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)

  const packageLink = join(home, 'profiles', 'web', 'node_modules', '@demo', 'plugin')
  assert.throws(() => lstatSync(packageLink), '链接应已删除')
  assert.equal(
    lstatSync(join(pkgDir, 'package.json')).isFile(),
    true,
    '包目录归扩展包所有，卸载链接时**不能**删它',
  )
})

test('迁移：把已有实体副本批量换成链接', async () => {
  const { migrateToLinks } = await import(MODULE)
  const { home, pkgDir } = makeHome()

  const packageLink = join(home, 'profiles', 'web', 'node_modules', '@demo', 'plugin')
  mkdirSync(packageLink, { recursive: true })
  writeFileSync(join(packageLink, 'package.json'), JSON.stringify({ name: '@demo/plugin' }), 'utf8')

  const migrated = migrateToLinks(home)
  assert.equal(migrated.length, 1)
  assert.equal(migrated[0].name, '@demo/plugin')
  assert.ok(lstatSync(packageLink).isSymbolicLink())

  // 幂等：再跑一次没有可迁移项
  assert.equal(migrateToLinks(home).length, 0)
})

test('目录缺 package.json 时明确失败（不静默成功）', async () => {
  const { linkInstallLocalPlugin } = await import(MODULE)
  const { home } = makeHome()
  const bogus = join(home, 'nope')
  mkdirSync(bogus, { recursive: true })
  const r = linkInstallLocalPlugin({ home, dir: bogus })
  assert.equal(r.ok, false)
  assert.match(r.log, /package\.json/)
})
