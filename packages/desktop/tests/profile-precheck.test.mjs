import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  precheckProfileBundles,
  loadProfileWithSkip,
  writeBootDiagnostics,
  removeBundleFromManifest,
  checkCompat,
  BOOT_DIAGNOSTICS_FILENAME,
} from '../lib/types/host/profile-precheck.js'

/**
 * 预检层是「第三方装错插件不该整机起不来」的唯一保障。它的失败形态是
 * **静默放行坏 bundle**（然后 boot 内部 fail-hard，用户看到卡住的启动页），
 * 所以四关必须逐个钉死，而不是只测「能跑」。
 */

const HOST_VERSION = '0.6.0'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'corum-precheck-'))
  const anchorDir = join(root, 'anchor')
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(anchorDir, { recursive: true })
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(anchorDir, 'package.json'), JSON.stringify({ name: 'anchor', version: HOST_VERSION }))
  return { root, anchorDir, anchor: join(anchorDir, 'package.json'), profileDir }
}

function writeBundle(ctx, name, { patch = 'cordis.patch.yml', patchBody = '[]\n', compat } = {}) {
  const dir = join(ctx.anchorDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  // `patch: null` = 刻意「不声明 dsh.bundle」（`undefined` 会落回默认值，测不出关 2）
  const manifest = { name, version: '0.1.0', ...(patch === null ? {} : { dsh: { bundle: { patch } } }) }
  if (compat !== undefined) manifest.corum = { plugin: compat }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  if (patch !== null && patchBody !== null) writeFileSync(join(dir, patch), patchBody)
  return dir
}

function writeProfile(ctx, bundles) {
  writeFileSync(
    join(ctx.profileDir, 'package.json'),
    JSON.stringify({ name: 'web', dsh: { profile: { bundles } }, corum: { marker: 'keep-me' } }),
  )
}

test('关 1：包解析不到 ⇒ skipped[unresolved]，其余照常', () => {
  const ctx = fixture()
  writeBundle(ctx, '@fixture/good', { compat: { api: 1, host: '>=0.6.0 <0.7.0', kind: 'bundle' } })
  writeProfile(ctx, ['@fixture/good', '@fixture/ghost'])
  const result = precheckProfileBundles({
    binName: 'test',
    profileDir: ctx.profileDir,
    installAnchor: ctx.anchor,
    hostVersion: HOST_VERSION,
  })
  assert.deepEqual(result.accepted.map(b => b.packageName), ['@fixture/good'])
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].packageName, '@fixture/ghost')
  assert.equal(result.skipped[0].reason, 'unresolved')
  rmSync(ctx.root, { recursive: true, force: true })
})

test('关 2：包在但没声明 dsh.bundle.patch ⇒ skipped[not-a-bundle]', () => {
  const ctx = fixture()
  writeBundle(ctx, '@fixture/lib', { patch: null })
  writeProfile(ctx, ['@fixture/lib'])
  const result = precheckProfileBundles({
    binName: 'test', profileDir: ctx.profileDir, installAnchor: ctx.anchor, hostVersion: HOST_VERSION,
  })
  assert.equal(result.accepted.length, 0)
  assert.equal(result.skipped[0].reason, 'not-a-bundle')
  rmSync(ctx.root, { recursive: true, force: true })
})

test('关 3：patch 文件不存在 / 解析失败 ⇒ skipped[bad-patch]', () => {
  const ctxMissing = fixture()
  writeBundle(ctxMissing, '@fixture/broken', { patch: 'nope.yml', patchBody: null, compat: { api: 1, host: '>=0.6.0 <0.7.0' } })
  writeProfile(ctxMissing, ['@fixture/broken'])
  const missing = precheckProfileBundles({
    binName: 'test', profileDir: ctxMissing.profileDir, installAnchor: ctxMissing.anchor, hostVersion: HOST_VERSION,
  })
  assert.equal(missing.skipped[0].reason, 'bad-patch')
  assert.match(missing.skipped[0].detail, /不存在/)
  rmSync(ctxMissing.root, { recursive: true, force: true })

  const ctxBad = fixture()
  // YAML 结构非法（顶层必须是数组）——loadOverlayPatches 会抛。
  writeBundle(ctxBad, '@fixture/bad-yaml', { patchBody: 'just a scalar\n', compat: { api: 1, host: '>=0.6.0 <0.7.0' } })
  writeProfile(ctxBad, ['@fixture/bad-yaml'])
  const bad = precheckProfileBundles({
    binName: 'test', profileDir: ctxBad.profileDir, installAnchor: ctxBad.anchor, hostVersion: HOST_VERSION,
  })
  assert.equal(bad.accepted.length, 0)
  assert.equal(bad.skipped[0].reason, 'bad-patch')
  rmSync(ctxBad.root, { recursive: true, force: true })
})

test('关 4：api 不在支持集 / host 不满足 ⇒ skipped[incompatible]', () => {
  const ctx = fixture()
  writeBundle(ctx, '@fixture/newer', { compat: { api: 2, host: '>=0.6.0 <0.7.0', kind: 'bundle' } })
  writeBundle(ctx, '@fixture/future', { compat: { api: 1, host: '>=0.7.0 <0.8.0', kind: 'bundle' } })
  writeProfile(ctx, ['@fixture/newer', '@fixture/future'])
  const result = precheckProfileBundles({
    binName: 'test', profileDir: ctx.profileDir, installAnchor: ctx.anchor, hostVersion: HOST_VERSION,
  })
  assert.equal(result.accepted.length, 0)
  assert.deepEqual(result.skipped.map(s => s.reason), ['incompatible', 'incompatible'])
  assert.match(result.skipped[0].detail, /api 2/)
  assert.match(result.skipped[1].detail, /0\.7\.0/)
  rmSync(ctx.root, { recursive: true, force: true })
})

test('无 corum.plugin 声明 ⇒ 放行 + 记入 undeclared（legacy 兼容）', () => {
  const ctx = fixture()
  writeBundle(ctx, '@fixture/legacy')
  writeProfile(ctx, ['@fixture/legacy'])
  const result = precheckProfileBundles({
    binName: 'test', profileDir: ctx.profileDir, installAnchor: ctx.anchor, hostVersion: HOST_VERSION,
  })
  assert.deepEqual(result.accepted.map(b => b.packageName), ['@fixture/legacy'])
  assert.deepEqual(result.undeclared, ['@fixture/legacy'])
  assert.equal(result.skipped.length, 0)
  rmSync(ctx.root, { recursive: true, force: true })
})

test('checkCompat：语义化范围与非法声明逐条判', () => {
  const ctx = { hostVersion: HOST_VERSION, supportedApis: [1] }
  assert.equal(checkCompat({ api: 1, host: '>=0.6.0 <0.7.0', kind: 'bundle' }, ctx), undefined)
  assert.match(checkCompat(undefined, ctx), /不是对象/)
  assert.match(checkCompat({ host: '>=0.6.0' }, ctx), /api 缺失/)
  assert.match(checkCompat({ api: 1 }, ctx), /host 缺失/)
  assert.match(checkCompat({ api: 1, host: 'not-a-range' }, ctx), /不是合法 semver range/)
  assert.match(checkCompat({ api: 1, host: '*', kind: 'weird' }, ctx), /kind/)
})

test('loadProfileWithSkip：有坏 bundle 时 filtered=true 且 layer 栈里没有它', () => {
  const ctx = fixture()
  writeBundle(ctx, '@fixture/good', { compat: { api: 1, host: '>=0.6.0 <0.7.0', kind: 'bundle' } })
  writeProfile(ctx, ['@fixture/ghost', '@fixture/good'])
  const loaded = loadProfileWithSkip({
    binName: 'test',
    profileName: 'web',
    installAnchor: ctx.anchor,
    hostVersion: HOST_VERSION,
    home: ctx.root,
  })
  assert.equal(loaded.filtered, true)
  assert.deepEqual(loaded.profile.layers.map(l => l.packageName), ['@fixture/good'])
  assert.equal(loaded.skipped.length, 1)
  assert.equal(loaded.profile.name, 'web')
  rmSync(ctx.root, { recursive: true, force: true })
})

test('loadProfileWithSkip：全绿时走官方路径（filtered=false）', () => {
  const ctx = fixture()
  writeBundle(ctx, '@fixture/good', { compat: { api: 1, host: '>=0.6.0 <0.7.0', kind: 'bundle' } })
  writeProfile(ctx, ['@fixture/good'])
  const loaded = loadProfileWithSkip({
    binName: 'test',
    profileName: 'web',
    installAnchor: ctx.anchor,
    hostVersion: HOST_VERSION,
    home: ctx.root,
  })
  assert.equal(loaded.filtered, false)
  assert.deepEqual(loaded.profile.layers.map(l => l.packageName), ['@fixture/good'])
  rmSync(ctx.root, { recursive: true, force: true })
})

test('诊断文件：写入可读、内容含 skipped 明细', () => {
  const ctx = fixture()
  const path = writeBootDiagnostics(ctx.root, {
    generatedAt: '2026-10-21T00:00:00.000Z',
    hostVersion: HOST_VERSION,
    profileName: 'web',
    supportedApis: [1],
    skipped: [{ packageName: '@fixture/ghost', reason: 'unresolved', detail: 'cannot resolve' }],
    undeclared: [],
  })
  assert.equal(path, join(ctx.root, BOOT_DIAGNOSTICS_FILENAME))
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(parsed.skipped[0].packageName, '@fixture/ghost')
  assert.equal(parsed.hostVersion, HOST_VERSION)
  rmSync(ctx.root, { recursive: true, force: true })
})

test('removeBundleFromManifest：摘掉目标包、保留其余、不改入参', () => {
  const manifest = { name: 'web', dsh: { profile: { bundles: ['a', 'bad', 'b'] } }, corum: { marker: 'keep-me' } }
  const result = removeBundleFromManifest(manifest, 'bad')
  assert.equal(result.removed, true)
  assert.deepEqual(result.manifest.dsh.profile.bundles, ['a', 'b'])
  // 无关字段必须原样保留（旧夹具用的是已废弃的 patchReload，见 issue #244 缺陷 3）
  assert.equal(result.manifest.corum.marker, 'keep-me')
  // 入参一字未动（纯函数）
  assert.deepEqual(manifest.dsh.profile.bundles, ['a', 'bad', 'b'])
})

test('removeBundleFromManifest：目标不在列表 ⇒ removed=false 且原样返回', () => {
  const manifest = { dsh: { profile: { bundles: ['a'] } } }
  const result = removeBundleFromManifest(manifest, 'ghost')
  assert.equal(result.removed, false)
  assert.equal(result.manifest, manifest)
})

test('removeBundleFromManifest：没有 bundles 字段 ⇒ 安全返回', () => {
  assert.equal(removeBundleFromManifest({}, 'a').removed, false)
  assert.equal(removeBundleFromManifest({ dsh: {} }, 'a').removed, false)
})
