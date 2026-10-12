#!/usr/bin/env node
/**
 * check-shipped-modules.mjs — 随包预设模块的自检脚本。
 *
 * ## 为什么不是 vitest
 *
 * 与 check-shipped-skills.mjs 同理：纯 node 脚本可在任何有 node 的机器上跑，
 * 不依赖测试框架。守卫的是「随包模块的清单与磁盘实况一致 + corum-dev 的
 * agent.json 与 builtin spec 逐字一致」。
 *
 * ## 覆盖的验收点
 *
 *   A. 每个 shipped module 的 module.json 过 validateManifest 且 0 错
 *   B. contents.skills 每个名字都有 skills/<name>/SKILL.md（防清单与磁盘脱节）
 *   C. contents.mcp 每个名字都有 mcp/<name>.json 且过 validateMcpEntry（含 requires 强制）
 *   D. contents.hasAvatar 与 assets/avatar.png 是否存在一致
 *   E. corum-dev 模块的 agent.json 与 builtin spec 的关键字段逐字一致
 *      （防提示词漂移——builtin spec 从 corum-agent/lib/types/builtin-profiles.js 读取）
 *
 * 用法：node scripts/check-shipped-modules.mjs
 * 退出码：0 全部通过；1 有断言失败。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MODULE_URL = new URL('../lib/index.js', import.meta.url)
const BUILTIN_PROFILES_JS = resolve(PACKAGE_ROOT, '../corum-agent/lib/types/builtin-profiles.js')

let mod
try {
  mod = await import(MODULE_URL.href)
} catch (error) {
  console.error(`[check-shipped-modules] 无法加载 ${MODULE_URL.pathname}`)
  console.error('  先跑 `pnpm --filter @corum/corum-preset-modules run build`。')
  console.error(`  原始错误：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { validateManifest, validateMcpEntry, resolveShippedModulesRoot, listShippedModules } = mod

/* ── 断言记账 ───────────────────────────────────────────────────────── */

let passed = 0
const failures = []

function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  ✗ ${label}`)
    console.log(`      ${error instanceof Error ? error.message.split('\n').slice(0, 6).join('\n      ') : String(error)}`)
  }
}

/* ── E. corum-dev 的 builtin spec（防提示词漂移的判据）────────────────── */
//
// builtin-profiles.ts 的 `BUILTIN_ROLES` 是**模块内私有 const**（未 export），
// 故无法 `import { BUILTIN_ROLES }`。两条路：
//   1. 解析 corum-agent/lib/types/builtin-profiles.js（产物里确有该数组）；
//   2. 这里硬编码逐字抄 spec 的关键字段（来源：builtin-profiles.ts:517-529）。
//
// 选 1：从编译产物 .js 里提取 BUILTIN_ROLES 数组并找到 id:'corum-dev' 那条。
// 产物 .js 是打包后的 ESM，`const BUILTIN_ROLES = [...]` 在模块作用域内——
// 用一个轻量 hack：把文件内容包进一个函数，提取该数组的求值结果。
// 若这条提取失败（产物结构变了），回退到硬编码期望值并在报告里标记。
function loadBuiltinRoleSpec(roleId) {
  if (!existsSync(BUILTIN_PROFILES_JS)) return null
  const src = readFileSync(BUILTIN_PROFILES_JS, 'utf8')
  // 粗提取：找 `const BUILTIN_ROLES = [ ... ]` 块，再在块内找 `id: 'corum-dev'`。
  // 产物里 const 声明在模块顶层；用正则定位数组起止。
  const startMarker = 'const BUILTIN_ROLES = ['
  const startIdx = src.indexOf(startMarker)
  if (startIdx < 0) return null
  // 从 `[` 开始往后找匹配的 `]`（朴素括号配对，忽略字符串内的括号——够用）。
  let depth = 0
  let i = startIdx + startMarker.length - 1
  let endIdx = -1
  let inString = false
  let stringChar = ''
  for (; i < src.length; i += 1) {
    const ch = src[i]
    if (inString) {
      if (ch === '\\') { i += 1; continue }
      if (ch === stringChar) inString = false
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = true; stringChar = ch; continue }
    if (ch === '[') depth += 1
    if (ch === ']') { depth -= 1; if (depth === 0) { endIdx = i; break } }
  }
  if (endIdx < 0) return null
  const arrayBody = src.slice(startIdx + startMarker.length - 1, endIdx + 1)
  // 在数组体里找 `id: '<roleId>'` 那个对象块（朴素：找 id 出现位置，往前找最近的 `{`，
  // 往后找匹配的 `}`）。
  const idMarker = `id: '${roleId}'`
  const idIdx = arrayBody.indexOf(idMarker)
  if (idIdx < 0) return null
  // 往前找最近的 `{`。
  let objStart = -1
  let d = 0
  let s = false
  let sc = ''
  for (let j = idIdx - 1; j >= 0; j -= 1) {
    const ch = arrayBody[j]
    if (s) { if (ch === sc) s = false; continue }
    if (ch === "'" || ch === '"' || ch === '`') { s = true; sc = ch; continue }
    if (ch === '}') d += 1
    if (ch === '{') { if (d === 0) { objStart = j; break } d -= 1 }
  }
  if (objStart < 0) return null
  // 往后找匹配的 `}`。
  d = 0; s = false; sc = ''
  let objEnd = -1
  for (let j = objStart; j < arrayBody.length; j += 1) {
    const ch = arrayBody[j]
    if (s) { if (ch === '\\') { j += 1; continue } if (ch === sc) s = false; continue }
    if (ch === "'" || ch === '"' || ch === '`') { s = true; sc = ch; continue }
    if (ch === '{') d += 1
    if (ch === '}') { d -= 1; if (d === 0) { objEnd = j; break } }
  }
  if (objEnd < 0) return null
  const objBody = arrayBody.slice(objStart, objEnd + 1)
  // 朴素提取字段：用正则抓 `key: value`，value 可能是字符串、数字、布尔。
  const spec = {}
  const fieldRe = /(\w+):\s*('[^']*'|"[^"]*"|`[^`]*`|true|false|[\d.]+|\{[^}]*\}|\[[^\]]*\])/g
  let m
  while ((m = fieldRe.exec(objBody)) !== null) {
    let val = m[2]
    if (val.startsWith("'") || val.startsWith('"') || val.startsWith('`')) {
      val = val.slice(1, -1)
    }
    spec[m[1]] = val
  }
  return spec
}

const shippedRoot = resolveShippedModulesRoot()

check('shipped-modules 目录解析命中', () => {
  assert.ok(shippedRoot !== undefined, 'resolveShippedModulesRoot() 返回 undefined')
})

const modules = shippedRoot === undefined ? [] : listShippedModules(shippedRoot)

check(`随包模块恰好 ${modules.length} 个`, () => {
  assert.ok(modules.length > 0, '没有随包模块')
  const ids = modules.map(m => m.manifest.id)
  assert.ok(ids.includes('corum-dev'), `缺少 corum-dev 模块（现有：${ids.join(', ')}）`)
})

/* ── A. module.json 校验 ───────────────────────────────────────────── */

console.log('\nA. module.json 校验')

check('每个 shipped module 的 module.json 过 validateManifest 且 0 错', () => {
  for (const { dir, manifest } of modules) {
    const raw = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'))
    const errors = validateManifest(raw)
    assert.equal(errors.length, 0, `${manifest.id}: ${errors.map(e => `${e.field}: ${e.message}`).join('; ')}`)
  }
})

/* ── B. skills 清单与磁盘一致 ───────────────────────────────────────── */

console.log('\nB. skills 清单与磁盘一致')

check('contents.skills 每个名字都有 skills/<name>/SKILL.md', () => {
  for (const { dir, manifest } of modules) {
    for (const name of manifest.contents.skills) {
      const skillMd = join(dir, 'skills', name, 'SKILL.md')
      assert.ok(existsSync(skillMd), `${manifest.id}: 技能 "${name}" 缺 SKILL.md（${skillMd}）`)
    }
  }
})

/* ── C. mcp 清单与磁盘一致 + requires 强制 ──────────────────────────── */

console.log('\nC. mcp 清单与磁盘一致 + requires 强制')

check('contents.mcp 每个名字都有 mcp/<name>.json 且过 validateMcpEntry', () => {
  for (const { dir, manifest } of modules) {
    for (const name of manifest.contents.mcp) {
      const entryPath = join(dir, 'mcp', `${name}.json`)
      assert.ok(existsSync(entryPath), `${manifest.id}: MCP "${name}" 缺条目文件`)
      const entry = JSON.parse(readFileSync(entryPath, 'utf8'))
      const errors = validateMcpEntry(entry)
      assert.equal(errors.length, 0, `${manifest.id}/mcp/${name}.json: ${errors.map(e => `${e.field}: ${e.message}`).join('; ')}`)
    }
  }
})

/* ── D. hasAvatar 与 assets/avatar.png 一致 ─────────────────────────── */

console.log('\nD. hasAvatar 与 assets/avatar.png 一致')

check('contents.hasAvatar 与 assets/avatar.png 是否存在一致', () => {
  for (const { dir, manifest } of modules) {
    const avatarPath = join(dir, 'assets', 'avatar.png')
    const exists = existsSync(avatarPath)
    assert.equal(exists, manifest.contents.hasAvatar,
      `${manifest.id}: hasAvatar=${manifest.contents.hasAvatar} 但 avatar.png ${exists ? '存在' : '不存在'}`)
  }
})

/* ── E. corum-dev agent.json 与 builtin spec 逐字一致 ────────────────── */

console.log('\nE. corum-dev agent.json 与 builtin spec 逐字一致（防提示词漂移）')

const corumDev = modules.find(m => m.manifest.id === 'corum-dev')
const builtinSpec = loadBuiltinRoleSpec('corum-dev')

if (corumDev === undefined) {
  check('corum-dev 模块存在', () => {
    assert.fail('缺少 corum-dev 模块')
  })
} else if (builtinSpec === null) {
  // 产物读不到 ⇒ 回退硬编码（逐字抄自 builtin-profiles.ts:517-529），并标记。
  // 这条路径诚实但不理想——理想态是 builtin spec 已 export。
  console.log('  ⚠ 无法从 corum-agent/lib/types/builtin-profiles.js 提取 BUILTIN_ROLES，回退硬编码期望值')
  const EXPECTED = {
    id: 'corum-dev',
    nickname: 'Corum 开发',
    title: 'Corum 开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    personaPreset: 'efficient-executor',
    prompt: 'You are the Corum development engineer: you build the Corum Agent OS desktop app (the kkc-desktop repo) — the desktop shell and IDE UI, the plugin and session mechanism, agents and orchestration. How you work: prove which surface owns the behavior before editing → build the artifact that actually loads (tsc && tsdown && inline-css for UI packages) → verify on a real CDP instance (UI renders + behavior + zero new console errors). Read the design file doc/UXDesign/design.pen for layout, follow the repo red lines (cordis service for cross-bundle state, inject declarations, restart after host-plugin changes), and treat "it compiles" as not done.',
  }
  const agentJson = JSON.parse(readFileSync(join(corumDev.dir, 'agent.json'), 'utf8'))
  for (const [key, expected] of Object.entries(EXPECTED)) {
    check(`corum-dev agent.json.${key} 与 builtin spec 逐字一致（硬编码回退）`, () => {
      assert.equal(agentJson[key], expected, `${key} 不一致`)
    })
  }
} else {
  // 从产物成功提取了 spec —— 逐字段对账。
  const agentJson = JSON.parse(readFileSync(join(corumDev.dir, 'agent.json'), 'utf8'))
  const FIELDS = ['id', 'nickname', 'title', 'dimension', 'baseMode', 'prompt']
  for (const key of FIELDS) {
    check(`corum-dev agent.json.${key} 与 builtin spec 逐字一致`, () => {
      assert.equal(agentJson[key], builtinSpec[key],
        `${key} 不一致\n  agent.json: ${String(agentJson[key]).slice(0, 80)}\n  builtin spec: ${String(builtinSpec[key]).slice(0, 80)}`)
    })
  }
  // personaPreset 不在 builtin spec 里（spec 没有该字段），是任务要求里指定的，
  // 单独断言它等于 'efficient-executor'。
  check('corum-dev agent.json.personaPreset = efficient-executor（任务指定，非 builtin spec）', () => {
    assert.equal(agentJson.personaPreset, 'efficient-executor')
  })
}

/* ── 收尾 ─────────────────────────────────────────────────────────── */

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error('\n失败清单：')
  for (const { label, error } of failures) {
    console.error(`  - ${label}`)
    console.error(`    ${error instanceof Error ? error.message.split('\n').slice(0, 3).join('\n    ') : String(error)}`)
  }
  process.exit(1)
}
console.log('随包预设模块自检全部通过。')
