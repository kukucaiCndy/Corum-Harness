#!/usr/bin/env node
/**
 * corum combo 构建 / 启动工具。
 *
 * 数据源唯一事实：packages/shell/src/electron/combos.ts 的 BUILTIN_COMBOS。
 * 本脚本用正则从源码解析 combo 列表（id / name / description / plugins / env），
 * 不复制硬编码——combo 增减只改 combos.ts，脚本自动跟随。
 *
 * 用法：
 *   node scripts/combos.mjs list                 列出所有可用 combo
 *   node scripts/combos.mjs build <id>           构建该 combo 依赖的插件 + corum-shell
 *   node scripts/combos.mjs start <id>           构建并启动该 combo（Electron）
 *   node scripts/combos.mjs start <id> --no-build 跳过构建直接启动
 *
 * @module scripts/combos
 */

import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHELL_DIR = join(ROOT, 'packages', 'shell')
const COMBOS_TS = join(SHELL_DIR, 'src', 'electron', 'combos.ts')
const SHELL_PKG = 'corum-shell'

// ── 解析 BUILTIN_COMBOS ─────────────────────────────────────────────

/**
 * 从 combos.ts 源码解析内置 combo 列表。
 * 以每个 combo 对象的顶层 `id: '...'` 为锚点切分：combo 对象都有 id 字段，
 * 用平衡括号从该对象的 `{` 走到匹配的 `}`（跳过字符串内的括号），逐个截取。
 */
function parseCombos() {
  const src = readFileSync(COMBOS_TS, 'utf8')
  const declIdx = src.indexOf('BUILTIN_COMBOS')
  if (declIdx === -1) throw new Error(`未在 ${COMBOS_TS} 找到 BUILTIN_COMBOS`)
  // 声明形如 `BUILTIN_COMBOS: Combo[] = [...]`：类型标注 `Combo[]` 里也有 `[`，
  // 必须从 `=` 之后再找数组字面量的 `[`。
  const eqIdx = src.indexOf('=', declIdx)
  const arrStart = src.indexOf('[', eqIdx)
  const arrEnd = matchingBracket(src, arrStart, '[', ']')
  const body = src.slice(arrStart + 1, arrEnd)

  // 以顶层 `id: '...'` 切出每个 combo 对象的起始，再平衡截取到对象闭合。
  const items = []
  const idRe = /\bid:\s*'/g
  let m
  while ((m = idRe.exec(body)) !== null) {
    // 该 id 所属对象的 `{` 在它之前最近的、未被闭合的 `{`。
    const openIdx = body.lastIndexOf('{', m.index)
    const closeIdx = matchingBracket(body, openIdx, '{', '}')
    items.push(body.slice(openIdx, closeIdx + 1))
    idRe.lastIndex = closeIdx + 1
  }
  return items.map(parseComboObject).filter(c => c !== null)
}

/**
 * 返回与 openIdx 处开括号匹配的闭括号下标（跳过单/双引号字符串内容）。
 */
function matchingBracket(text, openIdx, open, close) {
  let depth = 0
  let quote = null // 当前字符串引号（' 或 "），null = 不在字符串内
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') i++ // 跳过转义字符
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`括号不匹配：${open} 起于 ${openIdx}`)
}

/** 解析单个 combo 对象字面量，提取关心的字段。 */
function parseComboObject(text) {
  const id = matchStr(text, 'id')
  const name = matchStr(text, 'name')
  const description = matchStr(text, 'description')
  if (id === null) return null
  return {
    id,
    name: name ?? id,
    description: description ?? '',
    plugins: matchStrArray(text, 'plugins'),
    env: matchEnv(text),
  }
}

/** 抓取顶层 `key: 'value'`（单/双引号）。 */
function matchStr(text, key) {
  const m = text.match(new RegExp(`\\b${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'|\\b${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  if (m === null) return null
  return m[1] ?? m[2] ?? null
}

/** 抓取 `key: ['a', 'b', ...]`。 */
function matchStrArray(text, key) {
  const m = text.match(new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`))
  if (m === null) return []
  return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
    .map(x => x[1] ?? x[2])
}

/** 抓取 `env: { K: 'v', ... }`。 */
function matchEnv(text) {
  const m = text.match(/\benv:\s*\{([^}]*)\}/)
  if (m === null) return {}
  const env = {}
  for (const kv of m[1].matchAll(/(\w+):\s*'((?:[^'\\]|\\.)*)'|(\w+):\s*"((?:[^"\\]|\\.)*)"/g)) {
    env[kv[1] ?? kv[3]] = kv[2] ?? kv[4]
  }
  return env
}

// ── 命令实现 ────────────────────────────────────────────────────────

/** 运行一条命令（继承 stdio，失败即退）。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`))
    })
    child.on('error', reject)
  })
}

function cmdList(combos) {
  console.log('\n可用 combo：\n')
  for (const c of combos) {
    console.log(`  ${c.id.padEnd(12)} ${c.name}  — ${c.description}`)
    console.log(`  ${''.padEnd(12)} plugins: ${c.plugins.join(', ') || '(无)'}`)
    console.log(`  ${''.padEnd(12)} env:     ${JSON.stringify(c.env)}`)
    console.log()
  }
}

/** 构建一个 combo：plugins 里的 @corum/* 包逐个 build，再 build corum-shell。 */
async function cmdBuild(combo) {
  const filters = [...combo.plugins, SHELL_PKG]
  console.log(`\n构建 combo "${combo.id}"，目标包：${filters.join(', ')}\n`)
  // 插件逐个构建（UI 插件含 CSS 内联），最后 corum-shell 重建模块图。
  for (const pkg of combo.plugins) {
    console.log(`── pnpm --filter ${pkg} build`)
    await run('pnpm', ['--filter', pkg, 'build'])
  }
  console.log(`── pnpm --filter ${SHELL_PKG} build`)
  await run('pnpm', ['--filter', SHELL_PKG, 'build'])
  console.log(`\n✔ combo "${combo.id}" 构建完成\n`)
}

/** 启动一个 combo：node lib/cli.js --combo=<id>（Electron 主进程 spawn host）。 */
async function cmdStart(combo) {
  const cliJs = join(SHELL_DIR, 'lib', 'cli.js')
  if (!existsSync(cliJs)) {
    throw new Error(`未找到 ${cliJs}，请先构建：node scripts/combos.mjs build ${combo.id}`)
  }
  console.log(`\n启动 combo "${combo.id}"（${combo.name}）…\n`)
  await run('node', [cliJs, `--combo=${combo.id}`], { cwd: SHELL_DIR })
}

// ── 入口 ────────────────────────────────────────────────────────────

async function main() {
  const [, , command, id, ...rest] = process.argv
  const combos = parseCombos()

  if (command === 'list' || command === undefined) {
    cmdList(combos)
    return
  }

  const combo = combos.find(c => c.id === id)
  if (combo === undefined) {
    console.error(`未知 combo: "${id ?? ''}"\n`)
    cmdList(combos)
    process.exit(1)
  }

  if (command === 'build') {
    await cmdBuild(combo)
  } else if (command === 'start') {
    if (!rest.includes('--no-build')) await cmdBuild(combo)
    await cmdStart(combo)
  } else {
    console.error(`未知命令: "${command}"（支持 list / build / start）`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error(`\n✖ ${err.message}`)
  process.exit(1)
})
