#!/usr/bin/env node
/**
 * 一次性验证脚本：**产物级**验证「扩展包插件从实体副本迁到符号链接」。
 *
 * ## 为什么要单独写这一条
 *
 * 单测验的是 `plugin-link-install.ts` 的函数契约，`assert:boot` 验的是空 home 能启动。
 * 两者都不覆盖「**老用户**（实体副本 + file: 依赖）升级到新包之后，启动时真的会自动迁成
 * 符号链接」——而这恰恰是本改动的核心交付。这里用**产物自带的 Node** 跑**产物里的**
 * 宿主桥，把这条端到端路径走一遍。
 *
 * ## 判据
 *
 *  1. 第一次 boot（空 home）exit 0 —— 基线可启动
 *  2. 注入「老用户形态」：实体副本 + `file:` 依赖
 *  3. 第二次 boot exit 0，且：
 *     - `profiles/web/node_modules/@corum/<name>` 变成 **symlink**
 *     - 宿营地 `<name>/node_modules` 变成 **symlink** → `profiles/node_modules`
 *     - `profiles/web/package.json` 的依赖记成 **`link:`**
 *     - 宿营地内容未被删除（包归扩展包所有）
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const APP = '/Users/kukucai/work/kkc-desktop/packages/desktop/dist/mac-arm64/Corum.app/Contents/Resources'
const NODE = join(APP, 'node', 'bin', 'node')
const BRIDGE = join(APP, 'host', 'lib', 'bridge.js')
const SRC_PACK = '/Users/kukucai/.corum/extension-packs/corum-dev'
const PLUGINS = ['corum-test-suite', 'corum-test-suite-ui']

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
// ⚠️ 别用 `process.exitCode === 0` 判成功：它初始是 `undefined` 不是 `0`，
// 那样写会在全绿时也打印失败（首版就是这么误导的）。用显式计数器。
const bad = (m) => { console.log(`  ✗ ${m}`); failures += 1; process.exitCode = 1 }

function boot(home, label) {
  const r = spawnSync(NODE, [BRIDGE], {
    cwd: join(APP, 'host'),
    env: { ...process.env, CORUM_HOME: home, DSH_HOME: home, CORUM_DESKTOP_MODE: 'ide' },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const ready = (r.stdout ?? '').includes('"type":"ready"')
  const fatal = /plugin tree failed to load|safeStorage unavailable|master key is unavailable/.test(r.stderr ?? '')
  console.log(`[${label}] exit=${r.status} ready=${ready} fatal=${fatal}`)
  if (r.status !== 0 || !ready || fatal) {
    console.log('--- stderr tail ---\n' + (r.stderr ?? '').split('\n').slice(-15).join('\n'))
    bad(`${label}：宿主桥未正常启动`)
    return false
  }
  ok(`${label}：exit 0 且拿到 ready 信号`)
  return true
}

const home = mkdtempSync(join(tmpdir(), 'corum-migrate-e2e-'))
console.log(`隔离 home: ${home}`)

// 1) 空 home 先 boot 一次，让宿主自己铺骨架（profiles/ 等）
if (!boot(home, '首次 boot（空 home）')) { rmSync(home, { recursive: true, force: true }); process.exit(1) }

// 2) 注入「老用户形态」
const packsDir = join(home, 'extension-packs')
mkdirSync(packsDir, { recursive: true })
cpSync(SRC_PACK, join(packsDir, 'corum-dev'), { recursive: true })
// 去掉新形态才有的依赖面链接，还原成老形态
for (const name of PLUGINS) {
  const depLink = join(packsDir, 'corum-dev', 'plugins-src', name, 'node_modules')
  if (existsSync(depLink)) rmSync(depLink, { recursive: true, force: true })
}

const webModules = join(home, 'profiles', 'web', 'node_modules', '@corum')
mkdirSync(webModules, { recursive: true })
for (const name of PLUGINS) {
  const dest = join(webModules, `${name}-dev`)
  cpSync(join(packsDir, 'corum-dev', 'plugins-src', name), dest, { recursive: true })
}
const manifestPath = join(home, 'profiles', 'web', 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
for (const name of PLUGINS) {
  manifest.dependencies[`@corum/${name}-dev`] = `file:${join(packsDir, 'corum-dev', 'plugins-src', name)}`
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const isReal = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink() } catch { return false } }
let legacyOk = true
for (const name of PLUGINS) {
  if (!isReal(join(webModules, `${name}-dev`))) legacyOk = false
}
legacyOk ? ok('已注入老用户形态：实体副本 + file: 依赖') : bad('注入老用户形态失败')

// 3) 第二次 boot：迁移应在此发生
if (boot(home, '二次 boot（老用户升级）')) {
  for (const name of PLUGINS) {
    const link = join(webModules, `${name}-dev`)
    if (lstatSync(link).isSymbolicLink()) {
      ok(`① 包本体已迁成 symlink：${name}-dev → ${resolve(readlinkSync(link)).replace(home, '$HOME')}`)
    } else bad(`① ${name}-dev 仍是实体目录，迁移未生效`)

    const depLink = join(packsDir, 'corum-dev', 'plugins-src', name, 'node_modules')
    if (existsSync(depLink) && lstatSync(depLink).isSymbolicLink()) {
      ok(`② 依赖面已链接：${name}/node_modules → ${resolve(readlinkSync(depLink)).replace(home, '$HOME')}`)
    } else bad(`② ${name}/node_modules 未建立链接`)

    if (!existsSync(join(packsDir, 'corum-dev', 'plugins-src', name, 'package.json'))) {
      bad(`③ ${name} 宿营地内容被删了（不应发生：包归扩展包所有）`)
    }
  }

  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const name of PLUGINS) {
    const spec = after.dependencies[`@corum/${name}-dev`]
    if (typeof spec === 'string' && spec.startsWith('link:')) ok(`③ 依赖已记账为 link:（${name}-dev）`)
    else bad(`③ ${name}-dev 的依赖仍是 ${String(spec)}，pnpm install 会把链接冲掉`)
  }
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 处失败`)
