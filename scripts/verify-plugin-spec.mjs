#!/usr/bin/env node
/**
 * verify-plugin-spec.mjs —— 插件包规范的可执行守卫（PLAN-2026-10-19 的 B 段）。
 *
 * 规范文档：`docs/PLUGIN-SPEC.md`（prose）+ 本脚本（判据）。**两份必须同时改**：
 * docs 说「为什么」，这里说「怎么判」。任何一条规则只写在文档里、没有判据，就等于没立。
 *
 * ## 判据分两级（这是本脚本最重要的设计）
 *
 * - `error` —— **发布必炸**或**装配必炸**的事实错误：`exports` 指源码、缺
 *   `./package.json`、`dsh.client` 与 `./client` 不配对、`private` 与 `publishConfig`
 *   自相矛盾、构建链路缺步（红线 6）、包名与目录不符、未登记的 `exports` 子路径。
 *   出现任意一条，`pnpm publish` / 第三方 install 会失败或静默不生效。
 * - `warn` —— **已登记的迁移债**：`@deepseek-ai/*` 仍在 `dependencies`（规范 §B.5 要求
 *   peer）、react 位置、缺 `files` 字段、产物未构建。这些是**已知规模**的技术债（见
 *   `docs/plan/PLAN-2026-10-19-plugin-framework.md` §0.3），不是「没发现的问题」，
 *   所以既不掩盖也不阻断——`--strict` 才把它们升成失败。
 *
 * ## 为什么 `exports` 子路径要「登记制」而不是自由写
 *
 * 子路径就是**对第三方的承诺面**。今天全仓有 15 种（`./invariant`、`./settings-registrar`、
 * `./contract`、`./proxy` …），每一种都是某个包的实现细节被固化成了公开 API。规范 §B.4 的
 * 做法是「确需新增须先登记进词典」：本脚本的 {@link SUBPATH_DICTIONARY} 就是那本词典，
 * 新增子路径不登记 ⇒ error。这样「我的实现细节」和「我对外承诺的能力」在提交层面就被分开。
 *
 * ## 用法
 *
 *   node scripts/verify-plugin-spec.mjs            # 人读报告
 *   node scripts/verify-plugin-spec.mjs --strict   # warn 也判失败（发布门禁用）
 *   node scripts/verify-plugin-spec.mjs --json     # 机器可读（CI）
 *
 * 退出码：0 = 无 error（`--strict` 时无 warn）；1 = 有失败项；2 = 脚本自身出错。
 *
 * @module scripts/verify-plugin-spec
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PLUGIN_ROOT = join(ROOT, 'packages', 'plugins')
const args = new Set(process.argv.slice(2))
const strict = args.has('--strict')
const asJson = args.has('--json')

/** 永久 `private`：开发/测试占位包，永不发布（规范 §A.2「不发布」）。 */
const NOT_PUBLISHED = new Set([
  '@corum/corum-ide-test-conversation-ui',
  '@corum/corum-ide-test-sidebar-ui',
  '@corum/corum-ide-test-statusbar-ui',
])

/**
 * `exports` 子路径词典（规范 §B.4 + 本场登记）。`null` = 只允许出现在登记过的包里。
 *
 * 每条登记都要写清「它承诺的是什么」——否则下次没人敢删，也没人知道能不能改。
 */
const SUBPATH_DICTIONARY = {
  '.': '宿主入口 → ./lib/index.js（**不得**指向 ./src/**）',
  './client':
    '客户端入口。闭包产物 ./lib/client.js（`__ModuleLoader__` 工厂）；' +
    '**K3 纯客户端库例外**：被消费者构建期以真值 import 内联的共享库（ui-base / rpc-client）' +
    '必须指编译 ESM 产物，指闭包会在消费 bundle 里再注册一次',
  './package.json': '必填（Node/tooling 读 manifest）',
  './invariant': '不变式自检入口（可被宿主守卫 import）',
  './settings-registrar': '冷启动 settings namespace 预注册',
  './model-selection-settings': '子 Agent 候选模型及能力说明的 settings provider',
  './types': '共享类型面（type-only，编译后被擦除）',
  './presentation': '工具展示层类型（ToolCallView 一族）',
  './contract': 'RPC 契约常量（方法名表）',
  './corum-events': 'corum 领域事件名表（声明↔白名单双向对齐的单一事实源）',
  './runtime-state': '运行期状态快照的面',
  './lane-support': '泳道支持面',
  './spawn': '子 Agent spawn 面',
  './fork': 'fork 形态子 Agent 面',
  './isolated': '隔离形态子 Agent 面',
  './proxy': 'MCP 代理行（patch 里以字符串形式被引用）',
  './git-primitives': 'git 原语面',
  './sidebar.module.css': 'CSS Module 导出（供第三方复用侧栏骨架样式）',
  './mosaic.module.css': 'CSS Module 导出（供第三方复用磁贴墙样式）',
}

/**
 * K3 纯客户端库（只有 `./client`、无 `dsh.client`、不独立装载）。
 * 它们的 `./client` **必须**指编译产物（见词典里 `./client` 的例外条款）。
 */
const K3_CLIENT_LIBS = new Set(['@corum/corum-ui-base', '@corum/corum-rpc-client'])

const errors = []
const warns = []
const notes = []

function record(level, pkg, rule, message) {
  const entry = { pkg, rule, message }
  if (level === 'error') errors.push(entry)
  else warns.push(entry)
}

/** 所有插件包目录（packages/plugins/<group>/<name>）。 */
function packageDirs() {
  const out = []
  for (const group of readdirSync(PLUGIN_ROOT)) {
    const groupDir = join(PLUGIN_ROOT, group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name)
      if (!statSync(dir).isDirectory()) continue
      if (!existsSync(join(dir, 'package.json'))) continue
      out.push(dir)
    }
  }
  return out.sort()
}

/** 递归数某目录下的 .css（缺失即 0）。 */
function countCss(dir) {
  let count = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.css')) count++
    }
  }
  try {
    walk(dir)
  } catch {
    /* 无 src 目录 = 0 个 CSS */
  }
  return count
}

/** `exports` 里所有字符串目标（含条件分支）。 */
function exportTargets(exportsField) {
  const targets = []
  for (const [subpath, value] of Object.entries(exportsField ?? {})) {
    const conditions = typeof value === 'string' ? { default: value } : value
    for (const [condition, target] of Object.entries(conditions ?? {})) {
      if (typeof target === 'string') targets.push({ subpath, condition, target })
    }
  }
  return targets
}

for (const dir of packageDirs()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const name = pkg.name
  const baseDir = dir.split('/').pop()
  const rel = `packages/plugins/${dir.slice(PLUGIN_ROOT.length + 1)}`

  // ── 身份：包名 = @corum/<目录名>，全小写连字符（§B.2） ─────────────────
  if (name !== `@corum/${baseDir}`) {
    record('error', name, 'B.2-NAME', `包名 @corum/${baseDir} 与目录名不符（实际 ${name}）`)
  }
  if (!/^@corum\/[a-z0-9]+(-[a-z0-9]+)*$/.test(name ?? '')) {
    record('error', name, 'B.2-NAME-FORM', `包名不是全小写连字符形态：${name}`)
  }

  // ── exports：形状（§B.4） ──────────────────────────────────────────────
  const exportsField = pkg.exports
  if (exportsField === undefined) {
    record('error', name, 'B.4-EXPORTS-MISSING', '没有 exports 字段（发布后无法被 import）')
  } else {
    // K3 纯客户端库**没有宿主入口**（§B.1「K3 无宿主入口，只需 exports["./client"]」），
    // 其余包缺 "." 等于发布后 `import '@corum/xxx'` 直接炸。
    if (exportsField['.'] === undefined && !K3_CLIENT_LIBS.has(name)) {
      record('error', name, 'B.4-EXPORTS-DOT', 'exports 缺 "." 入口')
    }
    if (exportsField['./package.json'] === undefined) {
      record('error', name, 'B.4-EXPORTS-PKGJSON', 'exports 缺 "./package.json"')
    }
    for (const subpath of Object.keys(exportsField)) {
      if (SUBPATH_DICTIONARY[subpath] === undefined) {
        record('error', name, 'B.4-SUBPATH-UNREGISTERED', `未登记的 exports 子路径 ${subpath}（先登记进词典再发）`)
      }
    }
    for (const { subpath, condition, target } of exportTargets(exportsField)) {
      const normalized = target.replace(/^\.\//, '')
      if (normalized.includes('src/') || subpath.includes('src/')) {
        record('error', name, 'B.4-EXPORTS-TO-SRC', `exports["${subpath}"].${condition} 指向源码 ${target}`)
      }
      if (!normalized.endsWith('.d.ts') && /\.(ts|tsx)$/.test(normalized)) {
        record('error', name, 'B.4-EXPORTS-TO-TS', `exports["${subpath}"].${condition} 指向 TS 源码 ${target}`)
      }
      if (!existsSync(join(dir, normalized))) {
        record('warn', name, 'B.4-EXPORTS-NO-ARTIFACT', `exports["${subpath}"].${condition} 的目标尚未构建（${target}）`)
      }
    }
    // 子路径 ⇒ lib 产物（`.` 尤其不许别的形态）
    const dot = exportsField['.']
    const dotDefault = (typeof dot === 'string' ? dot : dot?.default) ?? ''
    if (dotDefault !== '' && !dotDefault.startsWith('./lib/')) {
      record('error', name, 'B.4-EXPORTS-DOT-TARGET', `exports["."] 应指向 ./lib/ 产物，实际 ${dotDefault}`)
    }
  }

  // ── 已废弃字段 ────────────────────────────────────────────────────────
  if (pkg.main !== undefined) {
    record('error', name, 'B.4-MAIN-FIELD', '仍有 main 字段（exports["."] 是唯一入口）')
  }

  // ── dsh.client ↔ ./client 配对（§B.1） ───────────────────────────────
  const hasDshClient = pkg.dsh?.client !== undefined
  const hasClientExport = exportsField?.['./client'] !== undefined
  if (hasDshClient && !hasClientExport) {
    record('error', name, 'B.1-CLIENT-PAIR', '有 dsh.client 但缺 exports["./client"]（装载器会找不到客户端半）')
  }
  if (!hasDshClient && hasClientExport && !K3_CLIENT_LIBS.has(name)) {
    record('error', name, 'B.1-CLIENT-ORPHAN', '有 exports["./client"] 却没有 dsh.client，且不在 K3 纯客户端库登记表里')
  }

  // ── 构建链路（§B.7 / 红线 6） ──────────────────────────────────────────
  const build = pkg.scripts?.build ?? ''
  if (build === '') {
    record('error', name, 'B.7-NO-BUILD', '没有 build 脚本（发布产物无从产生）')
  } else {
    if (!build.includes('tsc -b')) {
      record('error', name, 'B.7-NO-TSC', `build 缺 tsc -b 步：${build}`)
    }
    const cssCount = countCss(join(dir, 'src'))
    const clientTarget = exportsField?.['./client']
    const clientDefault = (typeof clientTarget === 'string' ? clientTarget : clientTarget?.default) ?? ''
    const closureClient = clientDefault.endsWith('/lib/client.js')
    if (closureClient && !build.includes('tsdown')) {
      record('error', name, 'B.7-NO-TSDOWN', `客户端半走闭包产物但 build 没有 tsdown：${build}`)
    }
    // 红线 6：CSS 不内联 ⇒ 实机样式全丢（且不报错）
    if (cssCount > 0 && !build.includes('inline-css')) {
      record('error', name, 'B.7-NO-INLINE-CSS', `src 下有 ${cssCount} 个 CSS 但 build 没有 inline-css（实机会裸 UI）`)
    }
  }

  // ── 发布字段（§A.2 / §A.3） ───────────────────────────────────────────
  const isPrivate = pkg.private === true
  const publishable = !NOT_PUBLISHED.has(name)
  if (publishable && isPrivate) {
    record('error', name, 'A.3-PRIVATE-BLOCKS', '在发布清单里却带 private: true')
  }
  if (!publishable && !isPrivate) {
    record('error', name, 'A.2-TEST-PLACEHOLDER', '测试占位包必须 private: true')
  }
  if (publishable) {
    const pc = pkg.publishConfig
    if (pc === undefined) record('error', name, 'A.3-NO-PUBLISH-CONFIG', '缺 publishConfig')
    else {
      if (pc.access !== 'public') record('error', name, 'A.3-PUBLISH-ACCESS', `publishConfig.access 应为 public，实际 ${pc.access}`)
      if (typeof pc.registry !== 'string' || !pc.registry.startsWith('https://')) {
        record('error', name, 'A.3-PUBLISH-REGISTRY', 'publishConfig.registry 缺失或不是 https')
      }
    }
    if (pkg.version !== JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version) {
      record('error', name, 'A.6-VERSION-LINE', `version ${pkg.version} 未跟随根版本`)
    }
  }

  // ── 兼容声明（§C.1）────────────────────────────────────────────────
  const compat = pkg.corum?.plugin
  if (compat === undefined) {
    if (publishable) record('warn', name, 'C.1-NO-COMPAT-DECL', '缺 corum.plugin 兼容声明（api / host / kind）')
  } else {
    if (typeof compat.api !== 'number') record('error', name, 'C.1-API-MISSING', 'corum.plugin.api 必须是数字')
    if (typeof compat.host !== 'string' || compat.host === '') record('error', name, 'C.1-HOST-MISSING', 'corum.plugin.host 必须是 semver range')
    if (!['bundle', 'builtin'].includes(compat.kind)) {
      record('error', name, 'C.1-KIND-INVALID', `corum.plugin.kind 只能是 bundle / builtin，实际 ${JSON.stringify(compat.kind)}`)
    }
    // corum 自己的包由 desktop 的 patch 统一挂载，不该声明成第三方 bundle 形态。
    if (compat.kind === 'bundle' && name.startsWith('@corum/')) {
      record('warn', name, 'C.1-KIND-BUNDLE', 'corum 自带包统一由 desktop patch 挂载，kind 应为 builtin（方案 §A.4）')
    }
  }

  // ── 依赖分层（§B.5）—— 已登记债，warn ────────────────────────────────
  const dshInDeps = Object.keys(pkg.dependencies ?? {}).filter(d => d.startsWith('@deepseek-ai/'))
  if (dshInDeps.length > 0) {
    record('warn', name, 'B.5-DSH-IN-DEPS', `dependencies 里有 ${dshInDeps.length} 个 @deepseek-ai/*（应进 peer）：${dshInDeps.slice(0, 3).join(', ')}${dshInDeps.length > 3 ? ' …' : ''}`)
  }
  const reactInDeps = ['react', 'react-dom'].filter(d => (pkg.dependencies ?? {})[d] !== undefined)
  if (reactInDeps.length > 0) {
    record('warn', name, 'B.5-REACT-IN-DEPS', `dependencies 里有 ${reactInDeps.join(' / ')}（client 侧应进 peer）`)
  }
  // 只有**会发布**的包才谈「发什么」；测试占位包永远 private，不适用。
  if (publishable && pkg.files === undefined) {
    record('warn', name, 'A.3-NO-FILES', '没有 files 字段 —— 发布会把 src/ tests/ tsconfig* 一起发出去')
  }

  notes.push({ pkg: name, rel, kind: hasDshClient ? 'K2' : (K3_CLIENT_LIBS.has(name) ? 'K3' : 'K1'), exportsCount: Object.keys(exportsField ?? {}).length })
}

// ── 报告 ────────────────────────────────────────────────────────────────
const kindCount = { K1: 0, K2: 0, K3: 0 }
for (const note of notes) kindCount[note.kind]++

if (asJson) {
  console.log(JSON.stringify({ errors, warns, summary: { packages: notes.length, ...kindCount }, strict }, null, 2))
} else {
  console.log(`插件规范守卫（${notes.length} 个包：K1 宿主 ${kindCount.K1} / K2 双半 ${kindCount.K2} / K3 纯客户端库 ${kindCount.K3}）\n`)
  if (errors.length > 0) {
    console.log('ERROR（发布/装配必炸）：')
    for (const e of errors) console.log(`  ✗ [${e.rule}] ${e.pkg}: ${e.message}`)
    console.log('')
  }
  if (warns.length > 0) {
    const byRule = new Map()
    for (const w of warns) byRule.set(w.rule, [...(byRule.get(w.rule) ?? []), w])
    console.log(`WARN（已登记的迁移债，${warns.length} 条）：`)
    for (const [rule, items] of byRule) {
      console.log(`  ⚠ [${rule}] ${items.length} 个包`)
      for (const item of items.slice(0, 3)) console.log(`      ${item.pkg}: ${item.message}`)
      if (items.length > 3) console.log(`      …其余 ${items.length - 3} 个同类`)
    }
    console.log('')
  }
  console.log(`结论：error ${errors.length} / warn ${warns.length}${errors.length === 0 && warns.length === 0 ? ' —— 全绿' : ''}`)
}

const failed = errors.length > 0 || (strict && warns.length > 0)
process.exit(failed ? 1 : 0)
