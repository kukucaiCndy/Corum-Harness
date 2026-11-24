import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { darwinInstallScript } from '../src/electron/darwin-install-script.ts'

/**
 * macOS 自动更新安装脚本的回归网（2026-11-24 紧急发布）。
 *
 * 为什么必须纯函数级：这段脚本**只有装一遍才暴露问题**，而它的两种失败形态都是
 * 用户级灾难 ——
 *
 * 1. 不清 quarantine ⇒ 用户升级后看到「Corum 已损坏，无法打开。你应该将它移到
 *    废纸篓。」（实测：带该属性的 .app 用 `open` 起不来，清掉立刻正常）；
 * 2. 先删后拷（而不是先备份）⇒ `cp` 失败时旧 .app 已经没了，用户失去应用。
 *
 * 所以断言点是「脚本里**有**这一步、且**在重启之前**」。
 */

const BASE = {
  execPath: '/Applications/Corum.app/Contents/MacOS/Corum',
  workDir: '/tmp/corum-update-abc',
  downloadedPath: '/Users/u/Downloads/Corum-0.8.3.zip',
  currentAppBundle: '/Applications/Corum.app',
  parentDir: '/Applications',
  appName: 'Corum.app',
}

test('★ 必须清 quarantine，且发生在 open 重启之前（事故直接判据）', () => {
  const script = darwinInstallScript(BASE)
  const clearAt = script.indexOf('xattr -cr')
  assert.ok(clearAt > 0, '脚本必须包含 xattr -cr —— 否则升级后会提示「已损坏」')
  const restartAt = script.indexOf('open "')
  assert.ok(restartAt > clearAt, 'xattr -cr 必须在重启之前，否则新版本仍带着隔离属性启动')
})

test('清 quarantine 的目标是安装后的 .app（不是下载的 zip）', () => {
  const script = darwinInstallScript(BASE)
  // 路径在生成时就已插值成具体字符串（不是留 shell 变量给运行期展开）。
  assert.ok(script.includes(`xattr -cr "${BASE.currentAppBundle}"`))
  assert.ok(!script.includes(`xattr -cr "${BASE.downloadedPath}"`), '清错对象 = 清了个没用的 zip')
})

test('清 quarantine 失败不得回滚已成功的安装（|| true）', () => {
  const script = darwinInstallScript(BASE)
  const line = script.split('\n').find(l => l.includes('xattr -cr'))
  assert.ok(line !== undefined)
  assert.match(line, /\|\| true/, '权限异常不该让用户失去刚装好的新版本')
})

test('先备份再替换：mv 到 .old-$$ 早于 cp -R（否则 cp 失败会丢应用）', () => {
  const script = darwinInstallScript(BASE)
  const mvAt = script.indexOf(`mv "${BASE.currentAppBundle}" "$BACKUP"`)
  const cpAt = script.indexOf('cp -R "$NEW_APP"')
  assert.ok(mvAt > 0 && cpAt > mvAt, '必须先 mv 旧 .app 到备份，再 cp 新的到位')
})

test('cp 失败时回滚：把备份移回来', () => {
  const script = darwinInstallScript(BASE)
  assert.match(script, /copy failed, rolling back/)
  const rollback = script.slice(script.indexOf('copy failed, rolling back'))
  assert.ok(rollback.includes(`mv "$BACKUP" "${BASE.currentAppBundle}"`), '回滚必须把备份移回原位')
})

test('找 .app 不限定深度（中间层目录会多一层）', () => {
  const script = darwinInstallScript(BASE)
  // 只看**命令**行，不看注释：注释里提到 `-maxdepth 1` 是在说明历史缺陷。
  const findLine = script.split('\n').find(l => l.startsWith('NEW_APP='))
  assert.ok(findLine !== undefined)
  assert.doesNotMatch(findLine, /-maxdepth 1/, '-maxdepth 1 遇到多一层目录会静默失败')
  assert.match(findLine, /find "\$UNZIP_DIR" -name "\*\.app" -type d/)
})

test('所有路径参数都真实插值（不留未替换的占位）', () => {
  const script = darwinInstallScript(BASE)
  assert.doesNotMatch(script, /undefined/)
  for (const value of [BASE.workDir, BASE.downloadedPath, BASE.currentAppBundle, BASE.appName]) {
    assert.ok(script.includes(value), `脚本文本里应出现 ${value}`)
  }
})

test('生成的脚本是合法 bash（bash -n 语法检查）', () => {
  const script = darwinInstallScript(BASE)
  // `bash -n` 只做语法解析、不执行 —— 因此不会真的去解压/替换任何东西。
  execFileSync('bash', ['-n'], { input: script })
})
