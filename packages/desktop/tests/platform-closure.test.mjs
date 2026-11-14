/**
 * 闭包平台校正的**回归网**（2026-11-14 Windows koffi 事故）。
 *
 * ## 钉住的两件事
 *
 * ① **嵌套副本各补各的版本**：闭包里同一个包可能有多个版本共存（实测 koffi 三份：
 *    顶层 3.1.1 / `@corum/corum-fs-local` 下 3.3.8 / `@deepseek-ai/dsh-fs-local` 下 3.3.3）。
 *    旧实现只扫顶层、按**包名**去重，于是只补了顶层那个版本的绑定；嵌套副本用裸别名
 *    `require('@koromix/koffi-win32-x64')` 向上查找，命中顶层那份**别的版本**的绑定 ⇒
 *    koffi 抛 `Mismatched native Koffi modules` ⇒ Windows 上 edit/原子覆写全挂（新建不经
 *    koffi 故表现为「新建 OK」）。判据因此是「**每份副本都解析到自己那个版本的绑定**」。
 * ② **错的版本在那儿也要换掉**：那个位置「已经有一个包」不等于对 —— 正是故障形态本身。
 *
 * 夹具是临时目录里一棵最小闭包（顶层 koffi + 两个嵌套 koffi + sharp/ripgrep/两个
 * 「名字像平台包」的包），安装器是注入的假实现（只写 manifest 与一个 `.node` 占位），
 * 所以整条链路（枚举 → 规划 → 删除 → 补齐 → 断言）都能在无网络、无真打包的情况下跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  enumeratePlatformClosure,
  normalizeVersionSpec,
  parsePlatformPackageName,
  planPlatformClosure,
  resolvePlatformBinding,
  topUpPlatformClosure,
  unresolvedPlatformBindings,
} = await import('../scripts/platform-closure.mjs')

/** 写一个包目录（`package.json` + 可选附加文件）。 */
function writePackage(dir, manifest, extraFiles = []) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const file of extraFiles) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), 'stub')
  }
}

/** koffi 各版本声明的 optionalDependencies（只列判定要用的两项）。 */
function koffiManifest(version) {
  return {
    name: 'koffi',
    version,
    optionalDependencies: {
      '@koromix/koffi-win32-x64': version,
      '@koromix/koffi-darwin-arm64': version,
    },
  }
}

/**
 * 造一棵**与真实闭包同形**的最小夹具：
 *   - 顶层 koffi 3.1.1（它的 darwin 绑定按 pnpm 布局落在 `koffi/node_modules/@koromix/`）
 *   - `@corum/corum-fs-local` 下的嵌套 koffi 3.3.8（隐患所在：旁无任何绑定）
 *   - `@deepseek-ai/dsh-fs-local` 下的嵌套 koffi 3.3.3（另一份隐患）
 *   - 顶层 sharp / @vscode/ripgrep / node-addon-require-builtin（2026-10-12 白屏事故那三个）
 */
function makeClosureFixture() {
  const hostDir = mkdtempSync(join(tmpdir(), 'corum-platform-closure-'))
  const top = join(hostDir, 'node_modules')
  writePackage(join(top, 'koffi'), koffiManifest('3.1.1'))
  writePackage(join(top, 'koffi', 'node_modules', '@koromix', 'koffi-darwin-arm64'), {
    name: '@koromix/koffi-darwin-arm64', version: '3.1.1', os: ['darwin'], cpu: ['arm64'],
  })
  writePackage(join(top, '@corum', 'corum-fs-local'), {
    name: '@corum/corum-fs-local', version: '1.0.0', dependencies: { koffi: '3.3.8' },
  })
  writePackage(join(top, '@corum', 'corum-fs-local', 'node_modules', 'koffi'), koffiManifest('3.3.8'))
  writePackage(join(top, '@deepseek-ai', 'dsh-fs-local'), {
    name: '@deepseek-ai/dsh-fs-local', version: '0.2.1', dependencies: { koffi: '3.3.3' },
  })
  writePackage(join(top, '@deepseek-ai', 'dsh-fs-local', 'node_modules', 'koffi'), koffiManifest('3.3.3'))
  // 那个 hoisted 的 darwin 绑定（被嵌套副本借走的正是它那一类）
  writePackage(join(top, '@koromix', 'koffi-darwin-arm64'), {
    name: '@koromix/koffi-darwin-arm64', version: '3.3.8', os: ['darwin'], cpu: ['arm64'],
  })
  writePackage(join(top, 'sharp'), {
    name: 'sharp', version: '0.35.5',
    optionalDependencies: { '@img/sharp-win32-x64': '0.35.5', '@img/sharp-darwin-arm64': '0.35.5' },
  })
  writePackage(join(top, '@img', 'sharp-darwin-arm64'), {
    name: '@img/sharp-darwin-arm64', version: '0.35.5', os: ['darwin'], cpu: ['arm64'],
  })
  writePackage(join(top, '@vscode', 'ripgrep'), {
    name: '@vscode/ripgrep', version: '1.18.0',
    optionalDependencies: { '@vscode/ripgrep-win32-x64': '1.18.0' },
  })
  writePackage(join(top, '@vscode', 'ripgrep-darwin-arm64'), {
    name: '@vscode/ripgrep-darwin-arm64', version: '1.18.0', os: ['darwin'], cpu: ['arm64'],
  })
  writePackage(join(top, 'node-addon-require-builtin'), {
    name: 'node-addon-require-builtin', version: '0.1.9',
    optionalDependencies: { 'node-addon-require-builtin-win32-x64-msvc': '0.1.9' },
  })
  // 「名字像平台包、其实是纯 JS」的豁免项：不该被删、也不该被当成绑定。
  writePackage(join(top, '@deepseek-ai', 'dsh-win32-process'), {
    name: '@deepseek-ai/dsh-win32-process', version: '0.2.1',
  })
  return hostDir
}

/** 假安装器：只写 manifest + 一个 `.node` 占位，并记下每次落盘调用。 */
function makeFakeInstaller(calls) {
  return async (name, version, destDir) => {
    calls.push({ name, version, destDir })
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'package.json'), JSON.stringify({ name, version, os: ['win32'], cpu: ['x64'] }, null, 2))
    writeFileSync(join(destDir, 'win32_x64'), 'stub-binding')
    return true
  }
}

const versionOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version

test('嵌套的多版本 koffi 各补各的绑定，且每份副本都解析到自己那个版本', async () => {
  const hostDir = makeClosureFixture()
  try {
    const top = join(hostDir, 'node_modules')
    const nestedFork = join(top, '@corum', 'corum-fs-local', 'node_modules', 'koffi')
    const nestedOfficial = join(top, '@deepseek-ai', 'dsh-fs-local', 'node_modules', 'koffi')
    // 事故现场：三份副本旁都没有 win32 绑定，只有两份 darwin 的。
    const calls = []
    const result = await topUpPlatformClosure({
      hostDir, platform: 'win32', arch: 'x64', install: makeFakeInstaller(calls),
    })

    // ① 嵌套副本拿到**自己那个版本**的绑定（旧实现根本不会补这两份）
    assert.equal(versionOf(join(nestedFork, 'node_modules', '@koromix', 'koffi-win32-x64')), '3.3.8')
    assert.equal(versionOf(join(nestedOfficial, 'node_modules', '@koromix', 'koffi-win32-x64')), '3.3.3')
    // ② 顶层副本按既有布局补 hoisted 槽位
    assert.equal(versionOf(join(top, '@koromix', 'koffi-win32-x64')), '3.1.1')
    assert.ok(existsSync(join(top, '@koromix', 'koffi-win32-x64', 'win32_x64')))
    // ③ 三个白屏事故包也一并对齐（既有补齐不能被改坏）
    assert.equal(versionOf(join(top, '@img', 'sharp-win32-x64')), '0.35.5')
    assert.equal(versionOf(join(top, '@vscode', 'ripgrep-win32-x64')), '1.18.0')
    assert.equal(versionOf(join(top, 'node-addon-require-builtin-win32-x64-msvc')), '0.1.9')
    // ④ 同一个包名不同版本必须**各落一份**（按名字去重就会退化成只装 3.1.1）
    const koffiInstalls = calls.filter((c) => c.name === '@koromix/koffi-win32-x64')
    assert.deepEqual(koffiInstalls.map((c) => c.version).sort(), ['3.1.1', '3.3.3', '3.3.8'])
    assert.equal(new Set(koffiInstalls.map((c) => c.destDir)).size, 3)

    // ⑤ 宿主平台的绑定是死重，交叉出包时该清掉（含嵌套那份）
    assert.equal(existsSync(join(top, '@koromix', 'koffi-darwin-arm64')), false)
    assert.equal(existsSync(join(top, 'koffi', 'node_modules', '@koromix', 'koffi-darwin-arm64')), false)
    assert.equal(existsSync(join(top, '@img', 'sharp-darwin-arm64')), false)
    // ⑥ 「名字像平台包」的纯 JS 包不许被删
    assert.ok(existsSync(join(top, '@deepseek-ai', 'dsh-win32-process', 'package.json')))

    // ⑦ 唯一判据：没有任何副本缺自己那个版本的绑定
    const { dependents } = await enumeratePlatformClosure(hostDir)
    assert.deepEqual(unresolvedPlatformBindings({ dependents, platform: 'win32', arch: 'x64' }), [])
    assert.equal(result.added, calls.length)
    assert.ok(result.removed >= 3, `expected host-only bindings pruned, got ${result.removed}`)
  } finally {
    rmSync(hostDir, { recursive: true, force: true })
  }
})

test('规划能把「旧实现只看顶层」的漏项显式列出来（回归锚点）', async () => {
  const hostDir = makeClosureFixture()
  try {
    const top = join(hostDir, 'node_modules')
    const { dependents, present } = await enumeratePlatformClosure(hostDir)
    const plan = planPlatformClosure({ dependents, present, platform: 'win32', arch: 'x64', topNodeModulesDir: top })
    // 依赖方是递归枚举的：顶层 4 个 + 两个嵌套 koffi（旧实现只看得见顶层）
    assert.equal(dependents.length, 6)
    assert.equal(dependents.filter((d) => d.isTopLevel).length, 4)
    // 三份 koffi 各有一笔补齐，落点各不相同
    const koffiDests = plan.installs.filter((i) => i.name === '@koromix/koffi-win32-x64').map((i) => i.destDir)
    assert.equal(new Set(koffiDests).size, 3)
    assert.ok(koffiDests.includes(join(top, '@corum', 'corum-fs-local', 'node_modules', 'koffi', 'node_modules', '@koromix', 'koffi-win32-x64')))
    assert.deepEqual(plan.warnings, [])
  } finally {
    rmSync(hostDir, { recursive: true, force: true })
  }
})

test('那个位置已有一个**错的版本**时要替换，不能当作「已就位」跳过', async () => {
  const hostDir = makeClosureFixture()
  try {
    const top = join(hostDir, 'node_modules')
    const nestedFork = join(top, '@corum', 'corum-fs-local', 'node_modules', 'koffi')
    const stale = join(nestedFork, 'node_modules', '@koromix', 'koffi-win32-x64')
    // 复刻远程机器上的形态：位置对、版本错（3.1.1 的二进制摆在 3.3.8 的副本旁）
    writePackage(stale, { name: '@koromix/koffi-win32-x64', version: '3.1.1', os: ['win32'], cpu: ['x64'] })
    const calls = []
    await topUpPlatformClosure({ hostDir, platform: 'win32', arch: 'x64', install: makeFakeInstaller(calls) })
    assert.equal(versionOf(stale), '3.3.8')
    assert.ok(calls.some((c) => c.destDir === stale && c.version === '3.3.8'))
    const { dependents } = await enumeratePlatformClosure(hostDir)
    assert.deepEqual(unresolvedPlatformBindings({ dependents, platform: 'win32', arch: 'x64' }), [])
  } finally {
    rmSync(hostDir, { recursive: true, force: true })
  }
})

test('幂等：第二次跑不再落盘', async () => {
  const hostDir = makeClosureFixture()
  try {
    const first = []
    await topUpPlatformClosure({ hostDir, platform: 'win32', arch: 'x64', install: makeFakeInstaller(first) })
    const second = []
    const result = await topUpPlatformClosure({ hostDir, platform: 'win32', arch: 'x64', install: makeFakeInstaller(second) })
    assert.equal(second.length, 0)
    assert.equal(result.added, 0)
    assert.equal(result.removed, 0)
  } finally {
    rmSync(hostDir, { recursive: true, force: true })
  }
})

test('解析判据：宿主平台的绑定借给别的版本会被判为未解析', () => {
  const hostDir = makeClosureFixture()
  try {
    const top = join(hostDir, 'node_modules')
    // 官方 dsh-fs-local 的嵌套 koffi 是 3.3.3，而 hoisted 的 darwin 绑定是 3.3.8
    // —— 正是「向上查找借到别的版本」那种故障形态（真实闭包里它就长这样）。
    const nestedOfficial = join(top, '@deepseek-ai', 'dsh-fs-local', 'node_modules', 'koffi')
    const missing = unresolvedPlatformBindings({
      dependents: [{ name: '@deepseek-ai/dsh-fs-local/node_modules/koffi', dir: nestedOfficial, isTopLevel: false, optionalDependencies: koffiManifest('3.3.3').optionalDependencies }],
      platform: 'darwin', arch: 'arm64',
    })
    assert.equal(missing.length, 1)
    assert.equal(missing[0].name, '@koromix/koffi-darwin-arm64')
    assert.equal(missing[0].reason, '版本不符')
    assert.equal(missing[0].want, '3.3.3')
    assert.equal(missing[0].found, '3.3.8')
    // 报错必须指到**哪一份副本**：三份 koffi 同名，只报包名定位不了
    assert.equal(missing[0].dir, nestedOfficial)
    // 解析位置就是 Node 会命中的那个上层目录（不是自己那层）
    assert.equal(
      resolvePlatformBinding(nestedOfficial, '@koromix/koffi-darwin-arm64').dir,
      join(top, '@koromix', 'koffi-darwin-arm64'),
    )
    // 顶层 3.1.1 那份有自己的绑定，不该被判为未解析
    assert.deepEqual(unresolvedPlatformBindings({
      dependents: [{ name: 'koffi', dir: join(top, 'koffi'), isTopLevel: true, optionalDependencies: koffiManifest('3.1.1').optionalDependencies }],
      platform: 'darwin', arch: 'arm64',
    }), [])
  } finally {
    rmSync(hostDir, { recursive: true, force: true })
  }
})

test('包名解析口径不变（解析法，不是白名单）', () => {
  assert.deepEqual(parsePlatformPackageName('@koromix/koffi-win32-x64'), { os: 'win32', arch: 'x64', abi: '', prefix: 'koffi', scoped: true })
  assert.deepEqual(parsePlatformPackageName('node-addon-require-builtin-win32-x64-msvc'), { os: 'win32', arch: 'x64', abi: 'msvc', prefix: 'node-addon-require-builtin', scoped: false })
  assert.deepEqual(parsePlatformPackageName('@img/sharp-libvips-darwin-arm64'), { os: 'darwin', arch: 'arm64', abi: '', prefix: 'sharp-libvips', scoped: true })
  // 豁免项与普通包都不该被当成平台专属包
  assert.equal(parsePlatformPackageName('@deepseek-ai/dsh-win32-process'), undefined)
  assert.equal(parsePlatformPackageName('koffi'), undefined)
  assert.equal(parsePlatformPackageName('node-pty'), undefined)
  // 版本提取：精确/范围都能取到具体版本，取不到就不猜
  assert.equal(normalizeVersionSpec('3.3.8'), '3.3.8')
  assert.equal(normalizeVersionSpec('^3.3.8'), '3.3.8')
  assert.equal(normalizeVersionSpec('>=0.35.5'), '0.35.5')
  assert.equal(normalizeVersionSpec('*'), undefined)
  assert.equal(normalizeVersionSpec('workspace:*'), undefined)
})
