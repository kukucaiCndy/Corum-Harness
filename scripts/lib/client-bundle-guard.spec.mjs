/**
 * client-bundle-guard.spec.mjs —— client bundle 运行期可解析性守卫的回归网。
 *
 * 覆盖：
 *   1. seed 词 / 声明的 external / 跨 client 包 / Node 内置 —— 全部合法
 *   2. host 包子路径（`@corum/corum-agent/contract`）—— **必须**报漂移（0.8.2 事故形态）
 *   3. 相对路径与 chunk 引用不误报
 *   4. 去重保序、描述文案含处置命令
 *   5. seed 清单与官方 `PLATFORM_MODULES` 同形（改动会被看见）
 *
 * 运行：node --test scripts/lib/client-bundle-guard.spec.mjs
 *
 * 为什么这些断言必须存在：0.8.2 的坏产物**通过了原有全部就绪判据**（文件在、大小正常、
 * 样式已内联），只在「装上去真跑」时才炸。判据若不进单测，就等于把这条防线
 * 交给下一次手工验证的运气。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  NODE_BUILTINS,
  PLATFORM_SEED,
  describeForeignRequires,
  foreignRequires,
  isUnresolvableRequire,
  stripClientSuffix,
} from './client-bundle-guard.mjs'

/** 造一份「正常」判定输入。 */
function options({ declared = [], clientPackages = [] } = {}) {
  return { declared: new Set(declared), clientPackages: new Set(clientPackages) }
}

/** 把 specifier 列表拼成产物里的 require 形态。 */
function bundle(...specs) {
  return `window.__ModuleLoader__.load({ id: "x", factory: (require) => {\n${
    specs.map(s => `  let m = require(${JSON.stringify(s)});`).join('\n')
  }\nreturn module.exports; } });`
}

// ─────────────────────────────────────────────────────────────────────────────
// 合法来源：不该报
// ─────────────────────────────────────────────────────────────────────────────

test('平台 seed 词合法（react / cordis / ui-slots …）', () => {
  for (const spec of ['react', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots']) {
    assert.equal(isUnresolvableRequire(spec, options()), false, spec)
  }
})

test('本包 dsh.client.external 声明过的 specifier 合法', () => {
  const opts = options({ declared: ['@deepseek-ai/dsh-api-session-controller/client', '@deepseek-ai/dsh-settings'] })
  assert.equal(isUnresolvableRequire('@deepseek-ai/dsh-api-session-controller/client', opts), false)
  assert.equal(isUnresolvableRequire('@deepseek-ai/dsh-settings', opts), false)
})

test('声明没覆盖到的 specifier 仍然报（external 不是万能的）', () => {
  const opts = options({ declared: ['@deepseek-ai/dsh-settings'] })
  assert.equal(isUnresolvableRequire('@deepseek-ai/dsh-other-thing', opts), true)
})

test('另一个 client bundle 的 /client 子路径合法（由对方 bundle 注册）', () => {
  const opts = options({ clientPackages: ['@corum/corum-ui-conversation'] })
  assert.equal(isUnresolvableRequire('@corum/corum-ui-conversation/client', opts), false)
})

test('Node 内置模块不误报（桌面壳的 monaco worker 用到 url）', () => {
  assert.equal(isUnresolvableRequire('url', options()), false)
  for (const name of ['path', 'fs', 'crypto']) assert.ok(NODE_BUILTINS.includes(name), name)
})

test('相对路径与 chunk 引用交给 loader，不在本判据范围', () => {
  const opts = options()
  assert.equal(isUnresolvableRequire('./client.chunk.js', opts), false)
  assert.equal(isUnresolvableRequire('/abs/path.js', opts), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 事故形态：必须报
// ─────────────────────────────────────────────────────────────────────────────

test('★ 0.8.2 事故形态：host 包子路径被降级成裸 require ⇒ 必须报', () => {
  // `@corum/corum-agent` 是 host 包（无 dsh.client），其 `/contract` 子路径既不是
  // seed 词、也不是 client bundle ⇒ 运行期必然 `missed the module table`。
  const source = bundle('react', '@corum/corum-agent/contract')
  const got = foreignRequires(source, options())
  assert.deepEqual(got, ['@corum/corum-agent/contract'])
})

test('完全没见过的第三方 specifier ⇒ 报', () => {
  assert.deepEqual(foreignRequires(bundle('lodash'), options()), ['lodash'])
})

test('裸子路径（`@corum/corum-agent/contract`）不会被 `/client` 规则误放行', () => {
  // 只有 `/client` 后缀才有「对方 bundle 注册」的含义；`/contract` 没有。
  assert.equal(stripClientSuffix('@corum/corum-agent/contract'), '@corum/corum-agent/contract')
  const opts = options({ clientPackages: ['@corum/corum-agent'] })
  assert.equal(isUnresolvableRequire('@corum/corum-agent/contract', opts), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 扫描行为
// ─────────────────────────────────────────────────────────────────────────────

test('去重且保序（同一漂移出现多次只报一次）', () => {
  const source = bundle('react', 'lodash', 'lodash', '@corum/corum-agent/contract', 'lodash')
  assert.deepEqual(foreignRequires(source, options()), ['lodash', '@corum/corum-agent/contract'])
})

test('健康产物不产生任何抱怨', () => {
  const source = bundle('react', 'react-dom', '@deepseek-ai/cordis', 'url', '@corum/corum-ui-conversation/client')
  const opts = options({ clientPackages: ['@corum/corum-ui-conversation'] })
  assert.deepEqual(foreignRequires(source, opts), [])
})

test('描述文案点名 specifier 并给出可执行的处置命令', () => {
  const text = describeForeignRequires(['@corum/corum-agent/contract'])
  assert.match(text, /@corum\/corum-agent\/contract/)
  assert.match(text, /build-all\.mjs --clean/, '必须给出重建命令，否则读者只知道坏了不知道怎么办')
})

// ─────────────────────────────────────────────────────────────────────────────
// 与官方清单同步
// ─────────────────────────────────────────────────────────────────────────────

test('seed 清单与官方 PLATFORM_MODULES 同形（11 项，含其全部词）', () => {
  // 官方来源：dsh 仓 `packages/client/web/src/platform.ts` 的 PLATFORM_MODULES。
  // 少一项 ⇒ 那个包会被误判成漂移；多一项 ⇒ 会放行一个运行期其实解析不到的 specifier。
  const official = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    'zod', '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ]
  assert.equal(PLATFORM_SEED.length, official.length)
  for (const spec of official) assert.ok(PLATFORM_SEED.includes(spec), spec)
})
