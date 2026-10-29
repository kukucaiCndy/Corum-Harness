/**
 * plugin-manager 的 pnpm PATH 补齐契约。
 *
 * ## 这一组测试挡的是什么
 *
 * 2026-10-29 实测阻塞：macOS 从 Finder / Dock 启动的应用**不读 shell 配置**，
 * 宿主进程的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`。而 pnpm 装在
 * `/opt/homebrew/bin`，于是用户点「导入本地扩展包」必然失败：
 *
 *     corum-extension-pack: 插件 "corum-test-suite" 安装失败：
 *     pnpm not found on PATH — install pnpm to manage profile plugins
 *
 * 用户终端里 `pnpm -v` 明明正常 —— 坏的只是 GUI 进程看不见它。
 *
 * ## 为什么只测 `pnpmEnv` 而不测 `spawnPnpm`
 *
 * `spawnPnpm` 要真起进程、真装包，不适合单测。真正会写错的逻辑是「往 PATH 里
 * 补哪些目录、要不要动原有顺序」，那部分抽成了纯函数 `pnpmEnv`，可以逐条断言。
 *
 * ⚠️ 注意：只找到 pnpm 的**绝对路径**是不够的 —— pnpm 是 `#!/usr/bin/env node`
 * 脚本，它自己还要在 PATH 里找 `node`。所以契约是「补目录进 PATH」而不是
 * 「拼一个可执行文件路径」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

const mod = await import('../lib/types/host/plugin-manager.js')
const pnpmEnv = mod.pnpmEnv

test('pnpmEnv 是导出的纯函数（可单测）', () => {
  assert.equal(typeof pnpmEnv, 'function', 'pnpmEnv 必须导出，否则 PATH 逻辑无法单测')
})

test('darwin 补上 Homebrew 与官方脚本目录，且保留原有 PATH 顺序', (t) => {
  if (typeof pnpmEnv !== 'function') return t.skip('pnpmEnv 未导出')
  const env = pnpmEnv('darwin')
  const parts = String(env.PATH ?? '').split(delimiter)
  // 原有 PATH 必须在最前面（用户自己的版本优先级不变）
  const original = String(process.env.PATH ?? '').split(delimiter).filter(Boolean)
  assert.deepEqual(parts.slice(0, original.length), original, '原 PATH 顺序不得被打乱')
  // Apple Silicon 与 Intel 两条 Homebrew 路径都要考虑（目录存在才会被加）
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'share', 'pnpm')]) {
    if (existsSync(dir)) {
      assert.ok(parts.includes(dir), `darwin 应补上 ${dir}`)
    }
  }
})

test('win32 补上 %LOCALAPPDATA%\\pnpm 与 %APPDATA%\\npm（.cmd shim 在那）', (t) => {
  if (typeof pnpmEnv !== 'function') return t.skip('pnpmEnv 未导出')
  const env = pnpmEnv('win32')
  const parts = String(env.PATH ?? '').split(delimiter)
  const localAppData = process.env.LOCALAPPDATA
  const appData = process.env.APPDATA
  // 在 mac 上跑这条测试时这两个环境变量通常不存在，此时该分支本就不该加目录
  if (localAppData !== undefined && localAppData !== '' && existsSync(join(localAppData, 'pnpm'))) {
    assert.ok(parts.includes(join(localAppData, 'pnpm')))
  }
  if (appData !== undefined && appData !== '' && existsSync(join(appData, 'npm'))) {
    assert.ok(parts.includes(join(appData, 'npm')))
  }
  // 反向：只看「win32 分支主动加了什么」，别把原 PATH 里的条目算它头上
  // （同 linux 那条的理由：本机 PATH 可能有 /opt/homebrew/bin，契约是保留原 PATH）
  const before = new Set(String(process.env.PATH ?? '').split(delimiter).filter(Boolean))
  const added = parts.filter(dir => !before.has(dir))
  assert.ok(!added.includes('/opt/homebrew/bin'), 'win32 分支不该主动加 POSIX Homebrew 目录')
  for (const dir of added) {
    assert.ok(!dir.startsWith('/'), `win32 分支不该主动加 POSIX 绝对路径：${dir}`)
  }
})

test('linux 分支不主动添加 macOS 专属目录（原 PATH 里的条目不算它加的）', (t) => {
  if (typeof pnpmEnv !== 'function') return t.skip('pnpmEnv 未导出')
  /**
   * 判据要分清「pnpmEnv 主动加的」与「process.env.PATH 本来就有的」。
   *
   * 首版判据写成「linux 结果里不得包含 /opt/homebrew/bin」，在本机（Apple Silicon）
   * 必然失败 —— 因为该机 PATH 本来就有它，而 `pnpmEnv` 按契约**保留原 PATH 顺序**，
   * 于是它照样出现在结果里。那是正确行为，是断言写错了。
   *
   * 正确判据 = 用「剥离原 PATH 后的增量」来看它加了什么。
   */
  const before = new Set(String(process.env.PATH ?? '').split(delimiter).filter(Boolean))
  const parts = String(pnpmEnv('linux').PATH ?? '').split(delimiter).filter(Boolean)
  const added = parts.filter(dir => !before.has(dir))
  assert.ok(!added.includes('/opt/homebrew/bin'), 'linux 分支不该主动加 Apple Silicon Homebrew 目录')
  const linuxSpecific = ['/usr/local/bin', join(homedir(), '.local', 'share', 'pnpm'), join(homedir(), '.pnpm')]
    .filter(dir => existsSync(dir))
  for (const dir of linuxSpecific) {
    assert.ok(parts.includes(dir), `linux 应补上 ${dir}（无论原 PATH 有没有）`)
  }
})

test('不修改 process.env（跨模块共享状态，红线 1）', (t) => {
  if (typeof pnpmEnv !== 'function') return t.skip('pnpmEnv 未导出')
  const before = process.env.PATH
  const env = pnpmEnv('darwin')
  assert.equal(process.env.PATH, before, 'pnpmEnv 必须返回新 env，不能就地改 process.env')
  assert.notEqual(env, process.env, '返回的应是新对象')
})

test('幂等：重复调用不会把同一目录加两遍', (t) => {
  if (typeof pnpmEnv !== 'function') return t.skip('pnpmEnv 未导出')
  const once = String(pnpmEnv('darwin').PATH ?? '').split(delimiter)
  const twice = String(pnpmEnv('darwin').PATH ?? '').split(delimiter)
  assert.deepEqual(twice, once, '同样的输入应产出同样的 PATH')
  assert.equal(new Set(once).size, once.length, 'PATH 里不应有重复项')
})

test('继承 process.env 的其余字段（不能只返回 PATH）', (t) => {
  if (typeof pnpmEnv !== 'function') return t.skip('pnpmEnv 未导出')
  const env = pnpmEnv('darwin')
  // HOME 在多数环境里有；用它验证「非 PATH 字段被原样带过去」
  if (process.env.HOME !== undefined) {
    assert.equal(env.HOME, process.env.HOME, 'pnpmEnv 必须继承 HOME 等其余环境变量')
  }
  assert.equal(typeof env.PATH, 'string')
})
