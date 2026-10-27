#!/usr/bin/env node
/**
 * S1 override 正向清单生成脚本（0.2.1-rc.3 升级阶段 2）
 *
 * 用途：从官方 dsh 仓 tag `dsh-v0.2.1-rc.3` 的 packages/+apps/ 全量 package.json
 * 读取 name/version/private，只收公开 @deepseek-ai/* 包（排除 private/非发布包），
 * 生成 override 映射（精确钉版 0.2.1-rc.3）。
 *
 * 用法：
 *   node scripts/generate-rc3-overrides.mjs [--dsh-checkout /Users/kukucai/dsh] [--tag dsh-v0.2.1-rc.3] [--output .corum-tmp/override-draft.yaml]
 *
 * 只读：用 git -C <checkout> ls-tree/show，不 checkout，不修改 dsh 工作树。
 */
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.split('=')
  return [k.replace(/^--/, ''), v ?? true]
}))

const DSH_CHECKOUT = args['dsh-checkout'] || '/Users/kukucai/dsh'
const TAG = args.tag || 'dsh-v0.2.1-rc.3'
const OUTPUT = args.output || '.corum-tmp/override-draft.yaml'
const TARGET_VERSION = '0.2.1-rc.3'

// vendor 包用各自真实版本（不是 0.2.1-rc.3），与 S2.2 vendor 表对齐
const VENDOR_VERSIONS = {
  '@deepseek-ai/cordis': '4.0.5',
  '@deepseek-ai/cordis-plugin-group': '1.0.5',
  '@deepseek-ai/cordis-plugin-include': '1.0.10',
  '@deepseek-ai/cordis-plugin-loader': '1.0.6',
  '@deepseek-ai/cordis-plugin-timer': '1.1.7',
  '@deepseek-ai/cosmokit': '1.8.6',
  '@deepseek-ai/schemastery': '3.18.5',
  // dsh-hmr 是 0.2.1-rc.3（官方继任包，走目标版本）
  // cordis-plugin-hmr 旧 override 删除（S2.2），不在 VENDOR_VERSIONS 里
  // cordis-plugin-logger-console corum 不装配，不加 override（S2.2），不在 VENDOR_VERSIONS 里
}

// native addon 平台子包用各自真实版本（独立版本线，非 dsh 应用包）
const NATIVE_ADDON_PREFIX = '@deepseek-ai/node-addon-system'

function gitShow(path) {
  try {
    return execSync(`git -C ${DSH_CHECKOUT} show ${TAG}:${path} 2>/dev/null`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

// S2.2 明确删除/不 override 的 vendor 包
const OVERRIDE_EXCLUDE = new Set([
  '@deepseek-ai/cordis-plugin-hmr',       // 旧 override 删除（S2.2：dsh-hmr 继任）
  '@deepseek-ai/cordis-plugin-logger-console', // corum 不装配，不加 override（S2.2）
])

// 1. 列出 tag 下所有 package.json
const treeOutput = execSync(`git -C ${DSH_CHECKOUT} ls-tree -r --name-only ${TAG}`, {
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
})

const packageJsonPaths = treeOutput
  .split('\n')
  .filter((f) => f.endsWith('package.json'))
  .filter((f) => !f.includes('node_modules/'))

console.log(`[1] Found ${packageJsonPaths.length} package.json files under ${TAG}`)

// 2. 逐个读取 name/version/private
const publicDshPackages = []   // @deepseek-ai/* 且非 private
const privatePackages = []     // 有 name 但 private
const excludedNoName = []      // 无 name（fixture/website 等）
const versionAnomalies = []    // version !== TARGET_VERSION

for (const pkgPath of packageJsonPaths) {
  const content = gitShow(pkgPath)
  if (!content) continue

  let pkg
  try {
    pkg = JSON.parse(content)
  } catch {
    continue
  }

  const name = pkg.name
  const version = pkg.version
  const isPrivate = pkg.private === true

  if (!name || !name.startsWith('@deepseek-ai/')) {
    // 非 @deepseek-ai/* 包（如 @corum/*, 第三方 fixture 等）
    continue
  }

  if (isPrivate) {
    privatePackages.push({ path: pkgPath, name, version })
    continue
  }

  // 公开 @deepseek-ai/* 包
  if (OVERRIDE_EXCLUDE.has(name)) {
    // S2.2 明确排除的包（cordis-plugin-hmr 删除、cordis-plugin-logger-console 不装配）
    continue
  }

  publicDshPackages.push({ path: pkgPath, name, version })

  // 审查异常：version 不等于目标版本（vendor / native addon 等）
  if (version !== TARGET_VERSION) {
    versionAnomalies.push({ path: pkgPath, name, version, expected: TARGET_VERSION })
  }
}

// 3. 排序（按 name 排序，保证稳定）
publicDshPackages.sort((a, b) => a.name.localeCompare(b.name))
privatePackages.sort((a, b) => a.name.localeCompare(b.name))

// 4. 生成 override YAML 片段
// 版本决策：
// - vendor 包（cordis/cosmokit/schemastery 等）用各自真实版本
// - native addon 平台子包用各自真实版本
// - 其余 dsh 应用包统一钉 0.2.1-rc.3
const overrideLines = publicDshPackages.map((p) => {
  let resolvedVersion
  if (p.name in VENDOR_VERSIONS) {
    resolvedVersion = VENDOR_VERSIONS[p.name]
  } else if (p.name.startsWith(NATIVE_ADDON_PREFIX)) {
    resolvedVersion = p.version // native addon 用真实版本（0.1.2 等）
  } else {
    resolvedVersion = TARGET_VERSION
  }
  return `  '${p.name}': '${resolvedVersion}'`
})

const yamlContent = `# 官方 rc3 公开 @deepseek-ai/* 包 override 映射（精确钉版 ${TARGET_VERSION}）
# 生成来源：git -C ${DSH_CHECKOUT} ls-tree -r --name-only ${TAG} + git show
# 生成时间：${new Date().toISOString()}
# 公开包数：${overrideLines.length}
# 被排除 private 包数：${privatePackages.length}
# 版本异常数（version !== ${TARGET_VERSION}）：${versionAnomalies.length}

${overrideLines.join('\n')}
`

writeFileSync(OUTPUT, yamlContent)

// 5. 输出审查报告
console.log('\n=== 审查报告 ===')
console.log(`[2] 公开 @deepseek-ai/* 包（加入 override）：${overrideLines.length} 条`)
console.log(`[3] 被排除 private 包：${privatePackages.length} 条`)

if (privatePackages.length > 0) {
  console.log('\n--- 被排除 private 包清单 ---')
  for (const p of privatePackages) {
    console.log(`  ${p.name} (${p.version}) [${p.path}]`)
  }
}

if (versionAnomalies.length > 0) {
  console.log('\n--- 版本异常（version !== 0.2.1-rc.3）---')
  for (const a of versionAnomalies) {
    console.log(`  ⚠ ${a.name} actual=${a.version} expected=${a.expected} [${a.path}]`)
  }
} else {
  console.log('\n[4] 所有公开包 version 均等于 0.2.1-rc.3 ✓')
}

console.log(`\n[5] Override 映射已写入 ${OUTPUT}`)
console.log(`[6] 目标版本：${TARGET_VERSION}（精确钉版，不用 ^）`)
