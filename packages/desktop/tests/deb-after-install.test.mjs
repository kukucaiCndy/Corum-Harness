import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * deb 安装后钩子的回归网（issue #151 缺陷二）。
 *
 * ## 事故形态
 *
 * `dpkg -i` 报安装成功，打开应用**立刻退出**、无窗口、无报错；每次升级都复现，
 * 手动 `sudo chmod 4755 /opt/Corum/chrome-sandbox` 只能救一次。
 *
 * 根因在 electron-builder 的默认 `postinst`：它用「**root** 能不能建用户命名空间」
 * 决定 `chrome-sandbox` 给 4755 还是 0755，而 root 在任何策略下都能建 ⇒ 恒落到 0755。
 * Ubuntu 23.10+ 默认 `kernel.apparmor_restrict_unprivileged_userns=1`，**普通用户**
 * 用不了 namespace 沙箱 ⇒ Electron 必须靠 setuid，于是启动即退。
 *
 * ## 本文件钉住
 *
 * 1. `packages/desktop/package.json` 的 `build.linux.deb.afterInstall` 指向真实存在的
 *    可执行脚本（漏挂 = 缺陷原样复发）；
 * 2. 脚本按**普通用户视角**的内核策略判（apparmor 限 userns / unprivileged_userns_clone=0
 *    ⇒ 4755），而不是无条件 4755；
 * 3. 脚本自身永不把安装搞失败（每步 `|| true`、末尾 `exit 0`）。
 */

const DESKTOP = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'))
const hookRel = pkg.build?.deb?.afterInstall
const hookPath = typeof hookRel === 'string' ? join(DESKTOP, hookRel) : undefined
const hook = hookPath === undefined ? '' : readFileSync(hookPath, 'utf8')

test('electron-builder 的 deb 段挂了 afterInstall', () => {
  assert.equal(typeof hookRel, 'string', 'build.deb.afterInstall 必须存在（electron-builder 25 的 linux schema 不收 deb 键）')
  assert.ok(hookRel.endsWith('.sh'), 'afterInstall 应指向 shell 脚本')
})

test('afterInstall 指向的脚本存在且可执行', () => {
  assert.ok(hookPath !== undefined)
  const mode = statSync(hookPath).mode
  assert.ok((mode & 0o111) !== 0, '脚本必须可执行（dpkg 直接执行它）')
})

test('钩子按内核策略决定 setuid，而不是无条件 4755', () => {
  assert.match(hook, /kernel\.apparmor_restrict_unprivileged_userns/)
  assert.match(hook, /kernel\.unprivileged_userns_clone/)
  assert.match(hook, /chmod 4755/)
  assert.match(hook, /chmod 0755/)
})

test('钩子失败不让安装失败（每步容错 + exit 0）', () => {
  assert.match(hook, /chmod 4755 "\$SANDBOX" \|\| true/)
  assert.match(hook, /chmod 0755 "\$SANDBOX" \|\| true/)
  assert.match(hook, /^exit 0$/m)
})
