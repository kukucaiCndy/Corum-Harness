/**
 * 运行期 bundle 登记的两条**数据安全**契约（2026-11-10 撤回 `~/.corum-rc3` 时补的）。
 *
 * ## 为什么需要
 *
 * `publishRuntimeBundle()` 每次 boot 都会把 `corum-desktop-runtime` 登记进
 * `profiles/web/package.json` 的 `dsh.profile.bundles`，并把生成包按当前构建版本重写。
 * 两个失败形态都是**静默**的：
 *
 *  ① **重复登记**：同一行定义被登记两遍 ⇒ `composeEntries()` 的 insert 是 append 语义、
 *     不按 id 去重 ⇒ loader 报 `duplicate loader entry id`。旧实现的 `includes()` 判据只管
 *     「没登记过就追加」，对已经写坏的清单（比如被手工改过、或被另一条构建写过）不收敛。
 *  ② **跨构建共用 home**：本线写的登记+生成包会被**另一条构建**读到，与它自己的 overlay
 *     叠出同一批 insert 行 ⇒ 它 boot 时 exit 1（2026-10-31 事故：症状在旧构建、真凶在本线，
 *     而且删掉会被本线下一次启动写回）。本构建无法替它修，只能**说清楚**：生成包 manifest
 *     里记着别的版本 ⇒ 直接告警并给出隔离办法。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { publishRuntimeBundle, RUNTIME_BUNDLE_NAME } = await import('../lib/types/host/runtime-bundle.js')

/** 造一个最小可用的 home + profile + 一份带顶层 insert 块的 patch。 */
function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'corum-runtime-bundle-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2)}\n`,
  )
  const patchDir = join(home, 'patches')
  mkdirSync(patchDir, { recursive: true })
  const patchFile = join(patchDir, 'cordis.patch.yml')
  writeFileSync(patchFile, '- insert:\n    - id: demo-row\n      name: demo-plugin\n')
  return { home, profileDir, patchFile, layers: { patchFiles: [patchFile] } }
}

/** 读 profile manifest 里登记的 bundle 列表。 */
function registeredBundles(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles
}

/** 把 stderr 接出来跑一段（校验告警文案，不改真实输出）。 */
function captureStderr(fn) {
  const original = process.stderr.write
  const chunks = []
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    const result = fn()
    return { result, stderr: chunks.join('') }
  } finally {
    process.stderr.write = original
  }
}

test('首次 boot 登记一次；同版本再 boot 幂等（changed=false，不重复登记）', () => {
  const { home, profileDir, layers } = makeFixture()
  try {
    const first = publishRuntimeBundle({ home, profileDir, version: '1.0.0', layers })
    assert.equal(first.changed, true)
    assert.deepEqual(registeredBundles(profileDir), ['@deepseek-ai/dsh-base', RUNTIME_BUNDLE_NAME])

    const second = publishRuntimeBundle({ home, profileDir, version: '1.0.0', layers })
    assert.equal(second.changed, false)
    assert.deepEqual(registeredBundles(profileDir), ['@deepseek-ai/dsh-base', RUNTIME_BUNDLE_NAME])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('★ 清单里已有重复登记 ⇒ 收敛成一份（否则 loader 报 duplicate loader entry id）', () => {
  const { home, profileDir, layers } = makeFixture()
  try {
    writeFileSync(
      join(profileDir, 'package.json'),
      `${JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', RUNTIME_BUNDLE_NAME, RUNTIME_BUNDLE_NAME] } },
      }, null, 2)}\n`,
    )
    const result = publishRuntimeBundle({ home, profileDir, version: '1.0.0', layers })
    assert.equal(result.changed, true)
    assert.deepEqual(registeredBundles(profileDir), ['@deepseek-ai/dsh-base', RUNTIME_BUNDLE_NAME])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('★ 生成包由另一个版本构建过 ⇒ 告警说明「别共用 home」，并如实重写成本构建版本', () => {
  const { home, profileDir, layers } = makeFixture()
  try {
    publishRuntimeBundle({ home, profileDir, version: '1.0.0', layers })
    const { result, stderr } = captureStderr(() =>
      publishRuntimeBundle({ home, profileDir, version: '2.0.0', layers }),
    )
    assert.equal(result.changed, true)
    assert.match(stderr, /另一个构建/)
    assert.match(stderr, /v1\.0\.0/)
    assert.match(stderr, /v2\.0\.0/)
    assert.match(stderr, /CORUM_HOME/, '告警必须给出隔离办法')
    assert.match(stderr, /duplicate loader entry id/, '告警必须点名真实症状，别让用户只看到启动超时')
    const generated = JSON.parse(readFileSync(join(home, 'desktop-runtime-bundle', 'package.json'), 'utf8'))
    assert.equal(generated.version, '2.0.0')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('同版本重复 boot 不告警（正常路径不许刷噪音）', () => {
  const { home, profileDir, layers } = makeFixture()
  try {
    publishRuntimeBundle({ home, profileDir, version: '1.0.0', layers })
    const { stderr } = captureStderr(() => publishRuntimeBundle({ home, profileDir, version: '1.0.0', layers }))
    assert.equal(stderr, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
