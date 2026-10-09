#!/usr/bin/env node
/**
 * verify-electron-pin.mjs —— **Electron 版本锁守卫**（单一事实源 = scripts/electron-pin.json）。
 *
 * ## 为什么需要它（不是"多加一道检查"，而是本次事故的直接对策）
 *
 * 2026-10-09：应用启动弹「输入钥匙串密码」，取消后**应用起不来**。根因是本仓用
 * `safeStorage`（macOS 钥匙串）封装凭据主密钥，而钥匙串条目的访问权**绑定请求方的
 * 二进制代码身份**；本仓是 ad-hoc 签名（无 Team ID ⇒ 无稳定身份），
 * `pnpm-lock.yaml` 一旦被重建（当时是为了修别的依赖，清了旧锁），浮动的
 * `electron: ^43.4.0` 就取到了新发布的 43.7.9 ⇒ cdhash 改变 ⇒ ACL 失配 ⇒
 * 主密钥拿不到 ⇒ 整棵插件树拒绝加载。（台账
 * `bug.credentials-keychain-acl-tied-to-electron-cdhash`）
 *
 * ## 为什么钉版本号还不够（本脚本的存在理由）
 *
 * 事后我把 electron 钉成精确版本 `43.4.1`，但**版本号相同不代表二进制相同**：
 * 镜像/缓存/重打包都可能给出不同字节的同版本二进制，而钥匙串认的是**字节身份**。
 * ⇒ 所以本守卫断言的是**二进制身份**（sha256 + macOS 的 cdhash），版本号只是索引。
 *
 * ## 判据（任一不满足 ⇒ 退出码 1）
 * 1. `packages/desktop/package.json` 的 electron 是**精确版本**（不得含 `^` / `~` / range）；
 * 2. 它与 `scripts/electron-pin.json` 的 `version` 一致；
 * 3. `pnpm-workspace.yaml` 的 `overrides.electron` 与之一致（防"只改了包声明忘了 override"）；
 * 4. `pnpm-lock.yaml` 解析到的 electron 版本与之一致（防"锁里还是旧版本"）；
 * 5. 已安装的 electron 二进制身份与 pin 中对应 platform-arch 的记录一致
 *    （sha256 全平台；cdhash 仅 macOS）。该平台未记录身份 ⇒ 失败（不允许发布未记录的产物）。
 *
 * ## 用法
 *   node scripts/verify-electron-pin.mjs              # 校验（CI / 打包前 / 发布前）
 *   node scripts/verify-electron-pin.mjs --record     # 采集当前身份写入 pin（升级流程第 ④ 步）
 *   node scripts/verify-electron-pin.mjs --json       # 机器可读
 *   node scripts/verify-electron-pin.mjs --platform=darwin --arch=arm64   # 显式指定目标
 *
 * 退出码：0 = 通过；1 = 不一致（**打包/发布链必须视作硬失败**）；2 = 用法/环境错误。
 * @module verify-electron-pin
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PIN_PATH = join(ROOT, 'scripts/electron-pin.json')
const DESKTOP_PKG = join(ROOT, 'packages/desktop/package.json')
const WORKSPACE_YAML = join(ROOT, 'pnpm-workspace.yaml')
const LOCKFILE = join(ROOT, 'pnpm-lock.yaml')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const argOf = (prefix) => argv.find((a) => a.startsWith(prefix))?.slice(prefix.length)
const AS_JSON = has('--json')
const RECORD = has('--record')

const failures = []
const notes = []
function fail(message) {
  failures.push(message)
}
function note(message) {
  notes.push(message)
}

/** 目标平台/架构：显式 flag 优先，否则取构建机（与 corum 的 pack 链同一默认口径）。 */
const targetPlatform = argOf('--platform=') ?? process.platform
const targetArch = argOf('--arch=') ?? process.arch
const key = `${targetPlatform}-${targetArch}`

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * electron 包内 `path.txt` 声明的可执行文件相对 `dist/` 的路径。
 *
 * ⚠️ 三平台不同（红线 7）：macOS 是 `Electron.app/Contents/MacOS/Electron`，
 * Linux 是 `electron`，Windows 是 `electron.exe`。**不要**按平台硬编码——该文件
 * 正是 electron 包自己写的权威值，读它即天然三平台正确。
 * @param pkgDir - electron 包目录。
 * @returns 相对 dist 的路径。
 */
function electronRelativeBinary(pkgDir) {
  const pathTxt = join(pkgDir, 'path.txt')
  if (!existsSync(pathTxt)) return null
  return readFileSync(pathTxt, 'utf8').trim()
}

/** 计算文件 sha256。 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 取 macOS 二进制的 cdhash（钥匙串 ACL 实际绑定的身份）。
 * 非 darwin 平台返回 `null`——cdhash 是 Apple 代码签名概念，别的平台没有。
 *
 * ⚠️ `codesign -dvvv` 把详情写在 **stderr**（stdout 为空），所以不能用
 * `execFileSync` 的返回值——即使命令成功也拿不到内容。实测踩过：只读 stdout
 * 得到 `null`，把「读取方式不对」误报成「身份不符」。故用 `spawnSync` 直接
 * 同时取两个流。
 * @param file - 可执行文件路径。
 * @param platform - 目标平台。
 * @returns cdhash 或 null。
 */
function cdhashOf(file, platform) {
  if (platform !== 'darwin') return null
  const r = spawnSync('codesign', ['-dvvv', file], { encoding: 'utf8' })
  // ad-hoc 签名下 codesign 常返回非 0，但内容仍有效 ⇒ 不看退出码，只看输出。
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return /CDHash=([0-9a-f]+)/.exec(text)?.[1] ?? null
}

/** 定位已安装的 electron 包目录（以 packages/desktop 为解析根，与运行时一致）。 */
function electronPkgDir() {
  const candidate = join(ROOT, 'node_modules/.pnpm')
  const fromDesktop = join(ROOT, 'packages/desktop/node_modules/electron')
  if (existsSync(join(fromDesktop, 'package.json'))) {
    // 软链接：解析真实路径，避免 pnpm 布局变化影响。
    try {
      return dirname(execFileSync('node', ['-e', `process.stdout.write(require.resolve('electron/package.json'))`], {
        cwd: join(ROOT, 'packages/desktop'),
        encoding: 'utf8',
      }).trim())
    } catch {
      return fromDesktop
    }
  }
  return candidate
}

// ── 采集当前身份 ────────────────────────────────────────────────────────────
const pin = readJson(PIN_PATH)
const pkg = readJson(DESKTOP_PKG)
const declared = pkg.devDependencies?.electron ?? pkg.dependencies?.electron

function currentIdentity() {
  const dir = electronPkgDir()
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    return { error: `找不到已安装的 electron 包（解析根 ${dir}）——先跑 CI=true pnpm install --no-frozen-lockfile` }
  }
  const manifest = readJson(manifestPath)
  const rel = electronRelativeBinary(dir)
  if (rel === null) return { error: `electron 包内缺 path.txt：${dir}` }
  const bin = join(dir, 'dist', rel)
  if (!existsSync(bin)) {
    return {
      error: `electron 二进制未物化：${bin}\n`
        + '          （pnpm 11 默认不跑依赖的构建脚本；跑 `node node_modules/.pnpm/electron@<v>/node_modules/electron/install.js`，'
        + '或给 electron 加 allowBuilds）',
    }
  }
  return {
    version: manifest.version,
    sha256: sha256(bin),
    cdhash: cdhashOf(bin, targetPlatform),
    binary: bin,
  }
}

if (RECORD) {
  const cur = currentIdentity()
  if (cur.error) {
    process.stderr.write(`[electron-pin] 采集失败：${cur.error}\n`)
    process.exit(2)
  }
  pin.identities[key] = {
    sha256: cur.sha256,
    ...(cur.cdhash === null ? {} : { cdhash: cur.cdhash }),
    note: `${new Date().toISOString().slice(0, 10)} 采集（--record）。`,
  }
  writeFileSync(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`)
  process.stdout.write(
    `[electron-pin] 已记录 ${key}: electron ${cur.version}\n`
    + `  sha256=${cur.sha256}\n`
    + (cur.cdhash === null ? '' : `  cdhash=${cur.cdhash}\n`)
    + '  ⚠️ 采集只说明「字节是这个」。请再跑 `pnpm smoke:packaged` 证明**钥匙串真的认得它**。\n',
  )
  process.exit(0)
}

// ── 校验：① 声明必须是精确版本 ──────────────────────────────────────────────
if (typeof declared !== 'string') {
  fail(`packages/desktop/package.json 未声明 electron`)
} else if (!/^\d+\.\d+\.\d+/.test(declared) || /[\^~]|\|\||-|\*|x/.test(declared.replace(/^\d+\.\d+\.\d+/, ''))) {
  fail(
    `packages/desktop/package.json 的 electron 必须是**精确版本**，当前为 "${declared}"。`
    + ' 浮动 range（^ / ~）会在锁文件重建时漂到新版 ⇒ cdhash 改变 ⇒ 钥匙串 ACL 失配（2026-10-09 事故）。',
  )
}
// ── ② 与 pin 一致 ───────────────────────────────────────────────────────────
if (declared !== pin.version) {
  fail(`packages/desktop/package.json 的 electron="${declared}" 与 scripts/electron-pin.json 的 version="${pin.version}" 不一致`)
}
// ── ③ 与 workspace override 一致 ────────────────────────────────────────────
const workspaceText = readFileSync(WORKSPACE_YAML, 'utf8')
const overrideMatch = /^\s*'electron':\s*'([^']+)'/m.exec(workspaceText)
if (overrideMatch === null) {
  fail(`pnpm-workspace.yaml 的 overrides 里缺 'electron' 钉版（锁重建时会漂）`)
} else if (overrideMatch[1] !== pin.version) {
  fail(`pnpm-workspace.yaml overrides 的 electron='${overrideMatch[1]}' 与 pin 的 "${pin.version}" 不一致`)
}
// ── ④ 与 lockfile 一致 ──────────────────────────────────────────────────────
if (existsSync(LOCKFILE)) {
  const lockText = readFileSync(LOCKFILE, 'utf8')
  const resolved = [...lockText.matchAll(/^ {2}electron@(\d+\.\d+\.\d+[^:]*):$/gm)].map((m) => m[1])
  const uniq = [...new Set(resolved)]
  if (uniq.length === 0) {
    fail(`pnpm-lock.yaml 里找不到 electron 解析条目（锁可能被重建过，需重新 install）`)
  } else if (uniq.length > 1) {
    fail(`pnpm-lock.yaml 里 electron 有多个版本：${uniq.join(', ')}（版本混装）`)
  } else if (uniq[0] !== pin.version) {
    fail(`pnpm-lock.yaml 解析到 electron ${uniq[0]}，与 pin 的 ${pin.version} 不一致`)
  }
}
// ── ⑤ 已安装二进制的身份 ────────────────────────────────────────────────────
const cur = currentIdentity()
const recorded = pin.identities?.[key]
const crossTarget = targetPlatform !== process.platform
if (cur.error) {
  note(`跳过二进制身份校验：${cur.error}`)
} else if (crossTarget) {
  // 交叉定向：本机装的是**宿主平台**的 Electron，拿它的字节去比目标平台的身份
  // 是错的（必然不符）⇒ 只报告，不判失败。真正的身份校验必须在目标平台上做
  // （与本仓「原生依赖必须在目标平台 install」的既有纪律一致）。
  note(
    `交叉定向 ${key}：本机装的是 ${process.platform}/${process.arch} 的 Electron，`
    + '无法在本机校验目标平台的二进制身份 ⇒ 已跳过（该平台的打包必须在其本机跑本守卫）',
  )
} else if (recorded === undefined) {
  fail(
    `${key} 的二进制身份尚未记录（scripts/electron-pin.json 的 identities 缺该键）。`
    + ' 打包该平台前必须先在**该平台**采集：node scripts/verify-electron-pin.mjs --record',
  )
} else {
  if (cur.sha256 !== recorded.sha256) {
    fail(
      `${key} 的二进制 sha256 与 pin 不符：\n`
      + `          期望 ${recorded.sha256}\n          实际 ${cur.sha256}\n`
      + '          同版本号但字节不同 ⇒ 钥匙串 ACL 大概率失配。'
      + ' 若这是有意的升级，请按 scripts/electron-pin.json 的 upgrade 步骤走一遍。',
    )
  }
  if (targetPlatform === 'darwin' && recorded.cdhash !== undefined && cur.cdhash !== recorded.cdhash) {
    fail(
      `${key} 的 cdhash 与 pin 不符（**这才是钥匙串真正绑定的身份**）：\n`
      + `          期望 ${recorded.cdhash}\n          实际 ${cur.cdhash}`,
    )
  }
  if (recorded.cdhash !== undefined && cur.cdhash === null) {
    note(`记录里有 cdhash，但本次读不到（codesign 不可用？）——已跳过该项`)
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const summary = {
  key,
  pinVersion: pin.version,
  declared,
  override: overrideMatch?.[1] ?? null,
  installed: cur.error ? null : { version: cur.version, sha256: cur.sha256, cdhash: cur.cdhash },
  ok: failures.length === 0,
  failures,
  notes,
}
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
} else {
  process.stdout.write(`[electron-pin] 目标 ${key}｜钉住 electron ${pin.version}\n`)
  for (const n of notes) process.stdout.write(`  – ${n}\n`)
  if (failures.length === 0) {
    // 交叉定向时身份未校验，措辞不能声称"四者一致"（避免报告说谎）。
    process.stdout.write(
      crossTarget
        ? '  ✓ 版本声明 / workspace override / lockfile 三者一致（二进制身份见上，本机不可判）\n'
        : '  ✓ 版本声明 / workspace override / lockfile / 二进制身份 四者一致\n',
    )
  } else {
    for (const f of failures) process.stdout.write(`  ✗ ${f}\n`)
  }
}
process.exit(failures.length === 0 ? 0 : 1)
