/**
 * 启动期自愈 `pruneShadowingProfileModules` 的行为契约（2026-11-11 事故）。
 *
 * ## 事故现场（同一份 0.8.0 构建、同一台机，只差 home）
 *
 * | home | 渲染结果 |
 * | --- | --- |
 * | `~/.corum-rc3`（健康） | 正常 IDE 壳 |
 * | `~/.corum`（老 0.7.0 用户） | 整页 `Failed to load plugins / 51 entries did not activate`，3 个**官方**客户端入口 failed |
 *
 * 把 `~/.corum/profiles/` 换成健康 home 的那份即恢复正常 ⇒ 毒在 profile 里。差异只有一处：
 * 老 profile 的 `profiles/web/node_modules` 是 0.7.0 时代 `pnpm add file:` 留下的 **实体副本树**
 * （`@deepseek-ai/{cordis,dsh-typert-protocol,dsh-client-connection,…}`、`react`、`zod`…），
 * 健康 home 里这个目录根本不存在。渲染端从老树解析出**第二份 cordis / 协议包** ⇒ 客户端模块
 * 登记按「最近 package.json 是否就是期望的包」判定 ⇒ 对不上 ⇒ failed ⇒ 依赖它的 51 项永远 pending。
 *
 * ## 这里钉住什么
 *
 * ① 实体副本 + 闭包同名 ⇒ 删除（闭包才是权威）；
 * ② **符号链接一律保留**（扩展包安装的正当形态，删了已装插件会消失）；
 * ③ 断链 ⇒ 删除（指向不存在的目标，留着只会让解析报错）；
 * ④ 闭包里**没有**的同名包（真正只属于这份 profile 的东西）⇒ 保留；
 * ⑤ 幂等：连跑两次，第二次返回空数组；
 * ⑥ 端到端：把「老 profile 的实体副本 + 正常符号链接 + 断链」摆好后，
 *    跑一次只清该清的两个，`web/node_modules/...` 其余原样。
 * @module corum-desktop/tests/profile-module-prune
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { pruneShadowingProfileModules } = await import('../lib/types/host/boot.js')

/** 造一个 home，内含 `profiles/<profile>/node_modules` 的一棵给定树。 */
function makeHome(entries) {
  const home = mkdtempSync(join(tmpdir(), 'corum-prune-'))
  const modules = join(home, 'profiles', 'web', 'node_modules')
  mkdirSync(modules, { recursive: true })
  for (const entry of entries) {
    const full = join(modules, entry.path)
    mkdirSync(join(full, '..'), { recursive: true })
    if (entry.kind === 'dir') {
      mkdirSync(full, { recursive: true })
      writeFileSync(join(full, 'package.json'), JSON.stringify({ name: entry.name ?? entry.path }))
    } else if (entry.kind === 'link') {
      symlinkSync(entry.target, full)
    }
  }
  return { home, modules }
}

/** 闭包表：这些包名视作「安装闭包里有」。 */
function closure(...names) {
  return new Map(names.map(name => [name, `/closure/${name}`]))
}

test('① 实体副本 + 闭包同名 ⇒ 删除（第二份 cordis 是事故本体）', () => {
  const { home, modules } = makeHome([
    { path: '@deepseek-ai/cordis', kind: 'dir' },
    { path: '@deepseek-ai/dsh-typert-protocol', kind: 'dir' },
    { path: 'react', kind: 'dir' },
  ])
  try {
    const removed = pruneShadowingProfileModules(home, closure('@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', 'react'))
    assert.equal(removed.length, 3)
    assert.deepEqual(readdirSync(join(modules, '@deepseek-ai')), [])
    assert.equal(existsSync(join(modules, 'react')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('② 符号链接一律保留（扩展包安装的正当形态）', () => {
  const { home, modules } = makeHome([
    { path: '@corum/corum-plugin-x', kind: 'dir' }, // 目标存在
  ])
  try {
    // 目标目录的真实位置（模拟 extension-packs/...）
    const target = join(home, 'extension-packs', 'pack', 'plugins-src', 'corum-plugin-x')
    mkdirSync(target, { recursive: true })
    symlinkSync(target, join(modules, '@corum', 'corum-plugin-x-link'))
    const removed = pruneShadowingProfileModules(home, closure('@corum/corum-plugin-x', '@corum/corum-plugin-x-link'))
    // 实体副本被删、链接保留
    assert.deepEqual(removed, [join(modules, '@corum', 'corum-plugin-x')])
    assert.equal(existsSync(join(modules, '@corum', 'corum-plugin-x-link')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('③ 断链 ⇒ 删除（指向不存在的目标）', () => {
  const { home, modules } = makeHome([
    { path: '@corum/gone', kind: 'link', target: join(tmpdir(), 'corum-prune-does-not-exist-xyz') },
  ])
  try {
    const removed = pruneShadowingProfileModules(home, closure())
    assert.deepEqual(removed, [join(modules, '@corum', 'gone')])
    assert.equal(existsSync(join(modules, '@corum', 'gone')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('④ 闭包里没有的同名包 ⇒ 保留（只属于这份 profile 的东西不许动）', () => {
  const { home, modules } = makeHome([{ path: '@corum/corum-only-here', kind: 'dir' }])
  try {
    const removed = pruneShadowingProfileModules(home, closure('@deepseek-ai/cordis'))
    assert.deepEqual(removed, [])
    assert.equal(existsSync(join(modules, '@corum', 'corum-only-here')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('⑤ 幂等：第二次跑返回空数组', () => {
  const { home } = makeHome([{ path: '@deepseek-ai/cordis', kind: 'dir' }])
  try {
    assert.equal(pruneShadowingProfileModules(home, closure('@deepseek-ai/cordis')).length, 1)
    assert.equal(pruneShadowingProfileModules(home, closure('@deepseek-ai/cordis')).length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('⑥ 没有 profiles/ 的 home ⇒ 安静返回空（不许抛）', () => {
  const home = mkdtempSync(join(tmpdir(), 'corum-prune-empty-'))
  try {
    assert.deepEqual(pruneShadowingProfileModules(home, closure('x')), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
