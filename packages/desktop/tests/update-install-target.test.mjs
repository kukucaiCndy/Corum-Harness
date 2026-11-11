import { test } from 'node:test'
import assert from 'node:assert/strict'

import { linuxInstallBlocker } from '../src/electron/update-install-target.ts'

/**
 * Linux 自动更新的**安装前判定**回归网（issue #151 缺陷一）。
 *
 * 为什么必须纯函数级：这段判定的价值在于「在起替换脚本之前就说不」—— 脚本一旦跑起来，
 * `runDetachedScript` 已经排了 `app.quit()`，失败路径的结果就是「应用消失了、版本没变、
 * 用户没有任何提示」（deb 形态 `/opt/Corum` 属主 root，`cp` 必撞 EACCES）。
 * 所以断言点是：**该拒的四种形态都必须拒，且拒绝原因可读、指向可执行的下一步**。
 */

const APPIMAGE = '/home/u/Applications/Corum-0.8.0.AppImage'
const DEB_BINARY = '/opt/Corum/corum-desktop'
const NEW_APPIMAGE = '/home/u/Downloads/Corum-0.9.0.AppImage'
const NEW_DEB = '/home/u/Downloads/corum-desktop_0.9.0_amd64.deb'

test('AppImage 形态 + 目录可写 ⇒ 放行（不返回原因）', () => {
  assert.equal(linuxInstallBlocker({
    downloadedPath: NEW_APPIMAGE,
    execPath: APPIMAGE,
    dirWritable: true,
    appImageEnv: APPIMAGE,
  }), undefined)
})

test('下载到的是 .deb 资产 ⇒ 拒绝，并指向包管理器（而不是硬塞 AppImage）', () => {
  const reason = linuxInstallBlocker({
    downloadedPath: NEW_DEB,
    execPath: APPIMAGE,
    dirWritable: true,
    appImageEnv: APPIMAGE,
  })
  assert.ok(reason !== undefined)
  assert.match(reason, /deb/)
  assert.match(reason, /包管理器|dpkg|apt/)
  // 必须明确告知「没有改动任何文件」——否则用户会怀疑应用被弄坏了
  assert.match(reason, /没有改动任何文件/)
})

test('当前是系统包安装形态（/opt）⇒ 拒绝，即使下载到的是 AppImage', () => {
  const reason = linuxInstallBlocker({
    downloadedPath: NEW_APPIMAGE,
    execPath: DEB_BINARY,
    dirWritable: false,
  })
  assert.ok(reason !== undefined)
  assert.match(reason, /系统包|deb/)
  assert.match(reason, /没有改动任何文件/)
})

test('可执行文件目录不可写（root 属主）⇒ 拒绝，并点名目录', () => {
  const reason = linuxInstallBlocker({
    downloadedPath: NEW_APPIMAGE,
    execPath: '/usr/local/bin/Corum.AppImage',
    dirWritable: false,
    appImageEnv: '/usr/local/bin/Corum.AppImage',
  })
  assert.ok(reason !== undefined)
  assert.match(reason, /\/usr\/local\/bin/)
  assert.match(reason, /权限/)
})

test('APPIMAGE 环境变量为空串时按「不是 AppImage」处理（不放行）', () => {
  const reason = linuxInstallBlocker({
    downloadedPath: NEW_APPIMAGE,
    execPath: '/tmp/whatever',
    dirWritable: true,
    appImageEnv: '',
  })
  assert.ok(reason !== undefined)
  assert.match(reason, /AppImage/)
})

test('拒绝原因一律不含英文内部术语（面向用户）', () => {
  for (const input of [
    { downloadedPath: NEW_DEB, execPath: APPIMAGE, dirWritable: true, appImageEnv: APPIMAGE },
    { downloadedPath: NEW_APPIMAGE, execPath: DEB_BINARY, dirWritable: false },
    { downloadedPath: NEW_APPIMAGE, execPath: '/usr/local/bin/x.AppImage', dirWritable: false },
  ]) {
    const reason = linuxInstallBlocker(input)
    assert.ok(reason !== undefined)
    assert.doesNotMatch(reason, /EACCES|ENOENT|spawn|execPath/)
  }
})
