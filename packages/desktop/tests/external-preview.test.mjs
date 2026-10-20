import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CorumFsService } from '../lib/types/host/corum-fs.js'
import { createCorumEditor } from '../lib/types/client/editor/corum-editor.js'
import { workspaceRelativePath } from '../lib/types/shared/preview-path.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'corum-external-preview-'))
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    await rm(dir, { recursive: true, force: true })
  })
  const root = join(dir, 'workspace')
  await mkdir(root)
  const file = join(dir, 'outside.md')
  await writeFile(file, '# External preview\n')
  await writeFile(join(root, 'inside.txt'), 'workspace file')
  const fs = new CorumFsService(new Context())
  await fs.setRoot(root)
  return { dir, root, file, fs }
}

test('外部文档按文件注册后可读，当前工作区与普通文件读写不变', async t => {
  const { root, file, fs } = await fixture(t)
  const preview = await fs.openExternalPreview(file)
  assert.equal((await fs.read(preview.path)).content, '# External preview\n')
  assert.equal((await fs.openExternalPreview(file)).path, preview.path)
  assert.equal((await fs.absolutePath(preview.path)).absolutePath, file)
  assert.equal(fs.currentRoot(), root)
  await fs.write('/inside.txt', 'still editable')
  assert.equal((await fs.read('/inside.txt')).content, 'still editable')
  await assert.rejects(fs.read('../outside.md'), /escapes/)
  await assert.rejects(fs.openExternalPreview(root), /file/)
})

test('外部预览令牌不允许写入、删除、改名，也不授权相邻文件', async t => {
  const { file, fs } = await fixture(t)
  const { path } = await fs.openExternalPreview(file)
  await assert.rejects(fs.write(path, 'overwrite'), /read.only/)
  await assert.rejects(fs.remove(path), /read.only/)
  await assert.rejects(fs.renamePath(path, '/renamed.md'), /read.only/)
  await assert.rejects(fs.renamePath('/inside.txt', path), /read.only/)
  await assert.rejects(fs.mkdirp(path), /read.only/)
  await assert.rejects(fs.read(path + '/../../another.md'))
  assert.equal(await readFile(file, 'utf8'), '# External preview\n')
})

test('外部图片与视频沿用已注册的文件路径，媒体读取不能越过授权文件', async t => {
  const { dir, fs } = await fixture(t)
  const image = join(dir, 'outside.png')
  const video = join(dir, 'outside.mp4')
  await writeFile(image, Buffer.from([1, 2, 3]))
  await writeFile(video, Buffer.from([4, 5, 6]))
  const imagePreview = await fs.openExternalPreview(image)
  assert.equal((await fs.readBinary(imagePreview.path)).base64, 'AQID')
  const videoPreview = await fs.openExternalPreview(video)
  assert.equal(await fs.resolveReadablePath(videoPreview.path), video)
  await assert.rejects(fs.resolveReadablePath(videoPreview.path.replace('outside.mp4', 'other.mp4')))
})

test('编辑器服务将工作区外点击送到预览入口，内部文件仍沿用原路径', async t => {
  const { root, file, fs } = await fixture(t)
  const opened = []
  const editor = createCorumEditor(
    { openFile: async path => { opened.push((await fs.read(path)).content) }, openContentDiff: null },
    { subscribe: () => () => {} },
    { toRelativePath: path => workspaceRelativePath(root, path), currentRoot: () => root,
      showEditorRegion: () => {}, openExternalPreview: path => fs.openExternalPreview(path) },
  )
  assert.equal((await editor.openFile(file)).ok, true)
  assert.equal((await editor.openFile(join(root, 'inside.txt'))).ok, true)
  assert.deepEqual(opened, ['# External preview\n', 'workspace file'])
  const missing = await editor.openFile(join(root, '..', 'missing.md'))
  assert.equal(missing.ok, false)
  assert.equal(fs.currentRoot(), root)
})

test('路径换算区分同名前缀目录，并兼容 Windows 和 POSIX 路径', () => {
  assert.equal(workspaceRelativePath('/work/project', '/work/project-old/file.md'), null)
  assert.equal(workspaceRelativePath('/work/project/', '/work/project/file.md'), '/file.md')
  assert.equal(workspaceRelativePath('E:\\Project', 'e:/project/file.md'), '/file.md')
  assert.equal(workspaceRelativePath('E:\\Project', 'E:\\Project-old\\file.md'), null)
  assert.equal(workspaceRelativePath('E:\\', 'e:/notes.md'), '/notes.md')
  assert.equal(workspaceRelativePath('/', '/notes.md'), '/notes.md')
})
