#!/usr/bin/env node
/**
 * publish.mjs —— `@corum/*` 插件包的发布流水线（方案 §A.5 / P5）。
 *
 * ## 它解决什么
 *
 * 48 个插件包要发到 npm，但发布顺序**不能靠人记**：`plugin-sdk` 必须在它 re-export 的
 * `ui-base` / `rpc-client` 之后，`plugin-build` 在被任何包当构建依赖之前。顺序错了
 * 表现为「装到一半 404」，而修它要重发。
 *
 * ## 四道关（顺序即失败代价）
 *
 * 1. **规范守卫**（`verify-plugin-spec.mjs --strict`）—— 不过就不发。
 * 2. **拓扑排序** —— 只算**运行时** `dependencies` 里的 `@corum/*` 边（dev/peer 不参与，
 *    否则会引入假约束；与方案 §A.5 的口径一致）。
 * 3. **幂等** —— 已存在的 `name@version` 跳过（不报错），所以重跑安全。
 * 4. **失败即停** —— 已发布的记进台账，不继续往后发（避免半套版本）。
 *
 * ## 用法
 *
 *   node scripts/publish.mjs                    # 干跑（默认）：列包 + 拓扑序 + 已发布判定
 *   node scripts/publish.mjs --layer=public      # 只干跑公开层
 *   node scripts/publish.mjs --publish --layer=public   # 真发
 *   node scripts/publish.mjs --publish --otp=123456     # 账号强制 2FA 且没有 automation token 时
 *   node scripts/publish.mjs --publish --via=npm --provenance   # CI 里用可信发布（需 id-token: write）
 *   node scripts/publish.mjs --publish --layer=all
 *
 * **默认是干跑**：真发必须显式 `--publish`（发布不可逆，不该由「忘了加 --dry-run」触发）。
 *
 * ## 公开层 / 内部层
 *
 * 公开层 = 第三方写插件真正需要的面（方案 §A.2）。内部层 = 其余 43 个包：发布但不承诺
 * API 稳定，文档标注 internal。**`corum-tools` / `corum-fs-local` 不发**（它们顶替官方
 * `@deepseek-ai/dsh-tools` / `dsh-fs-local`，发出去会让第三方装到两个包，方案 §F.1）。
 *
 * @module scripts/publish
 */

import { execFileSync } from 'node:child_process'
import { readSync } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
/** `--via=npm` 时 pnpm pack 的产物目录（CI 里用临时目录即可）。 */
const PACK_DIR = process.env.CORUM_PACK_DIR ?? join(tmpdir(), 'corum-plugin-publish')
const LEDGER = join(ROOT, 'docs', 'RELEASE-LEDGER.md')
const args = new Set(process.argv.slice(2))
const argValue = (name, fallback) => {
  const inline = process.argv.find(a => a.startsWith(`--${name}=`))
  return inline === undefined ? fallback : inline.slice(name.length + 3)
}
const DO_PUBLISH = args.has('--publish')
/** 一次性验证码（显式给一个，6 个包共用；过期再给一个新的）。 */
let OTP = argValue('otp', undefined)
/**
 * `--ask-otp`：由**本脚本**逐包提问，而不是让 pnpm 自己弹。
 *
 * 为什么不用 pnpm 自己的提示：npm 2FA 对**每一次写操作**都要验证（发布 N 个包 = N 次写），
 * pnpm 在每个包上单独挑战；它内部的「等待 OTP → 重试」循环在终端里表现为**验证完就卡住**
 * （2026-10-20 实测）。改成：脚本先问码 → `pnpm publish --otp=CODE` → 只在真的过期时才再问一次。
 */
const ASK_OTP = args.has('--ask-otp')
/** CI 专用：`--provenance` 需要 workflow 的 `id-token: write`，让 npm 页面出现来源声明。 */
const PROVENANCE = args.has('--provenance')
/**
 * 上传器：`pnpm`（本机首选用）或 `npm`（**Trusted Publishing 必须用它**）。
 *
 * 为什么 CI 里必须换 npm：npm 的 OIDC 可信发布（Trusted Publishing）是**npm CLI 的能力**，
 * pnpm 目前不会交换 OIDC token。而依赖改写（`workspace:*` → 真版本）是 pnpm 的强项，
 * 所以 `--via=npm` 的做法是：**用 pnpm 打包，用 npm 上传 tarball** —— 两件事各用对的工具。
 */
const VIA = argValue('via', 'pnpm')
const LAYER = argValue('layer', 'public')

/** 公开层：第三方插件开发真正需要的面（方案 §A.2）。 */
const PUBLIC_LAYER = new Set([
  '@corum/plugin-sdk',
  '@corum/plugin-ui-contract',
  '@corum/plugin-build',
  '@corum/corum-ui-base',
  '@corum/corum-rpc-client',
  '@corum/corum-platform',
])

/** 永不发布：顶替官方包名的 fork（发出去会让第三方装到两个包，方案 §F.1）、测试占位、构建工具已单列。 */
const NEVER_PUBLISH = new Set([
  '@corum/corum-tools',
  '@corum/corum-fs-local',
  '@corum/corum-ui-renderer',
  '@corum/corum-ide-test-conversation-ui',
  '@corum/corum-ide-test-sidebar-ui',
  '@corum/corum-ide-test-statusbar-ui',
])

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/**
 * 交互式执行：**继承 stdio**。
 *
 * 发布是唯一需要 TTY 的步骤 —— 账号开了 2FA 时 `pnpm publish` 会**当场提问要 OTP**。
 * 如果这里像其它步骤那样 `stdio: ['ignore','pipe','pipe']` 把 stdin 关掉，pnpm 就没有终端可问，
 * 直接报 `ERR_PNPM_OTP_NON_INTERACTIVE`（本仓 2026-10-20 实测：用户在终端里跑，
 * 却 "已发 0 个" 且台账里错误信息为空 —— 真因就是脚本吞掉了 stdin）。
 */
function runInteractive(command, commandArgs, cwd) {
  // 给个上限：pnpm 的 OTP 重试循环在终端里可能**永久等待**（2026-10-20 实测「验证完就卡住」）。
  // 超时宁可失败并报出来，也不要让发布流程无声挂着。
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit', timeout: 240_000 })
}

function run(command, commandArgs, cwd) {
  return execFileSync(command, commandArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * 从**终端**读一个 6 位验证码（同步读 stdin：这个脚本本来就是交互式发布用的）。
 * @param prompt - 提示语。
 * @returns 用户输入的验证码（去掉空白）。
 */
function askOtp(prompt) {
  process.stdout.write(prompt)
  const buffer = Buffer.alloc(64)
  const bytes = readSync(0, buffer, 0, buffer.length, null)
  const text = buffer.subarray(0, bytes).toString('utf8').trim()
  return text
}

function pnpmBin() {
  for (const candidate of ['/opt/homebrew/bin/pnpm', '/usr/local/bin/pnpm']) {
    if (existsSync(candidate)) return candidate
  }
  return 'pnpm'
}

/** 工作区里的全部可发布包（插件 + tooling + sdk）。 */
function collectPackages() {
  const packages = []
  const roots = [
    join(ROOT, 'packages', 'plugins'),
    join(ROOT, 'packages', 'tooling'),
    join(ROOT, 'packages', 'sdk'),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const groups = root.endsWith('plugins') ? readdirSync(root).map(g => join(root, g)) : [root]
    for (const group of groups) {
      for (const name of readdirSync(group)) {
        const dir = join(group, name)
        const manifestPath = join(dir, 'package.json')
        if (!existsSync(manifestPath)) continue
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (NEVER_PUBLISH.has(manifest.name)) continue
        if (manifest.private === true) continue
        packages.push({ dir, manifest })
      }
    }
  }
  return packages
}

/**
 * 拓扑排序：只算运行时 `dependencies` 里的 `@corum/*` 边。
 * @returns 依赖在前的顺序（同层按名字稳定排序，便于 diff）。
 */
function topologicalOrder(packages) {
  const byName = new Map(packages.map(p => [p.manifest.name, p]))
  const order = []
  const visiting = new Set()
  const visited = new Set()
  const visit = (name) => {
    if (visited.has(name)) return
    if (visiting.has(name)) throw new Error(`依赖成环：${[...visiting].join(' → ')} → ${name}`)
    visiting.add(name)
    const pkg = byName.get(name)
    for (const dep of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (byName.has(dep)) visit(dep)
    }
    visiting.delete(name)
    visited.add(name)
    order.push(pkg)
  }
  for (const name of [...byName.keys()].sort()) visit(name)
  return order
}

/**
 * 该版本是否已在 registry 上。
 *
 * 为什么直连 registry 而不用 `npm view`：npm CLI 在 Agent 沙箱里会尝试写 `~/.npm`
 * （cache/logs）并直接失败 —— 实测 `npm error sudo chown -R ... /Users/…/.npm`。
 * 发布判定不该被「本机 npm 缓存目录权限」左右。
 * @returns true / false / undefined（网络不可达 = 未知，不阻断干跑）
 */
async function publishedVersion(manifest) {
  const encoded = manifest.name.replace('/', '%2F')
  const check = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      return response.status
    } catch {
      return undefined
    }
  }
  const docStatus = await check(`https://registry.npmjs.org/${encoded}`)
  if (docStatus === 200) {
    try {
      const body = await (await fetch(`https://registry.npmjs.org/${encoded}`, { signal: AbortSignal.timeout(5000) })).json()
      return body.versions?.[manifest.version] !== undefined
    } catch {
      return undefined
    }
  }
  if (docStatus === 404) {
    // 新包的 **文档快照**可能还没生成（doc 404），但**版本端点**已经是权威事实。
    // 只看 doc 会把「已发布」误判成「待发布」⇒ 重发同版本 ⇒ 409/403 打断整批。
    const versionStatus = await check(`https://registry.npmjs.org/${encoded}/${encodeURIComponent(manifest.version)}`)
    if (versionStatus === 200) return true
    if (versionStatus === 404) return false
  }
  return undefined
}

// ── 关 1：规范守卫 ──────────────────────────────────────────────────────
console.log('── 1. 规范守卫（--strict）')
try {
  run(process.execPath, [join(ROOT, 'scripts', 'verify-plugin-spec.mjs'), '--strict'], ROOT)
  console.log('  ✓ error 0 / warn 0')
} catch (error) {
  fail(`规范守卫未通过，拒绝发布：\n${error.stdout ?? ''}${error.stderr ?? ''}`)
}

// ── 关 2：选层 + 拓扑序 ─────────────────────────────────────────────────
const all = collectPackages()
const selected = LAYER === 'all'
  ? all
  : all.filter(p => PUBLIC_LAYER.has(p.manifest.name))
if (selected.length === 0) fail(`layer=${LAYER} 没有选中任何包`)
const ordered = topologicalOrder(selected)

console.log(`\n── 2. 发布顺序（layer=${LAYER}，${ordered.length} 个包，运行时依赖口径）`)
for (const [index, pkg] of ordered.entries()) {
  const layer = PUBLIC_LAYER.has(pkg.manifest.name) ? 'public' : 'internal'
  console.log(`  ${String(index + 1).padStart(2)}. ${pkg.manifest.name}@${pkg.manifest.version}  [${layer}]`)
}

// ── 关 3：幂等判定 ──────────────────────────────────────────────────────
console.log('\n── 3. 已发布判定')
const todo = []
for (const pkg of ordered) {
  const exists = await publishedVersion(pkg.manifest)
  const label = exists === true ? '已存在，跳过' : exists === false ? '待发布' : '未知（registry 不可达）'
  console.log(`  · ${pkg.manifest.name}@${pkg.manifest.version} → ${label}`)
  if (exists !== true) todo.push(pkg)
}

if (!DO_PUBLISH) {
  console.log(`\n干跑完成：${todo.length} 个包待发布。真发请加 --publish（不可逆）。`)
  process.exit(0)
}

// ── 关 4：逐包发布，失败即停 ────────────────────────────────────────────
console.log(`\n── 4. 发布（${todo.length} 个包）`)
const done = []
for (const pkg of todo) {
  process.stdout.write(`  → ${pkg.manifest.name}@${pkg.manifest.version} … `)
  if (ASK_OTP && OTP === undefined) {
    OTP = askOtp('\n    需要 OTP（6 位，30 秒有效，可给一个复用；过期会再问）：')
  }
  try {
    if (VIA === 'npm') {
      // pnpm 打包（改写 workspace:*）→ npm 上传（OIDC/OTP 都由 npm 处理）
      const packOut = run(pnpmBin(), ['pack', '--pack-destination', PACK_DIR], pkg.dir)
      const tgz = packOut.split('\n').map(l => l.trim()).filter(l => l.endsWith('.tgz')).pop()
      if (tgz === undefined) throw new Error('pnpm pack 没有产出 tarball')
      const npmArgs = ['publish', tgz, '--access', 'public']
      if (OTP !== undefined) npmArgs.push(`--otp=${OTP}`)
      if (PROVENANCE) npmArgs.push('--provenance')
      runInteractive('npm', npmArgs, pkg.dir)
    } else {
      const publishArgs = ['publish', '--access', 'public', '--no-git-checks']
      if (OTP !== undefined) publishArgs.push(`--otp=${OTP}`)
      if (PROVENANCE) publishArgs.push('--provenance')
      runInteractive(pnpmBin(), publishArgs, pkg.dir)
    }
    console.log('ok')
    done.push(pkg.manifest)
  } catch (error) {
    // OTP 过期/被拒：清掉旧码，让下一轮重新问（最常见的就是输码慢了）。
    const text = `${error?.message ?? ''}`
    if (ASK_OTP && /EOTP|one-time password|OTP/i.test(text)) {
      console.log('OTP 过期或被拒，重试该包')
      OTP = undefined
      continue
    }
    console.log('FAILED')
    // 常见误诊：PUT 新包名返回 404 且该包「不存在」⇒ 不是 scope 没了，而是 **token 没有
    // 创建新包的权限**（granular token 选了「Selected packages」时，只能更新已存在的包）。
    const raw = `${error?.stderr ?? ''}${error?.stdout ?? ''}${error?.message ?? ''}`
    if (/E404|404 Not Found/.test(raw) && !/Scope not found/i.test(raw)) {
      console.log('    提示：这是「PUT 新包名 404」。若该包在 registry 上确实还不存在，')
      console.log('    真因通常是 **token 没有创建新包的权限**（granular token 选了 Selected packages）。')
      console.log('    修法：npmjs → Access Tokens → 新建 Granular token，Packages 选 **All packages**')
      console.log('          （或含 @corum 且允许新建），Read and write；替换 ~/.npmrc 里对应的那一行。')
    }
    // stdio 是 inherit ⇒ 详细原因已经打在**终端上**，这里只记退出码与最后一句话。
    const detail = typeof error.status === 'number' ? `exit ${error.status}` : (error.message ?? 'unknown')
    appendLedger(done, `中断于 ${pkg.manifest.name}@${pkg.manifest.version}（${detail}；详细原因见终端输出）`)
    fail(`发布失败并已停止（已发 ${done.length} 个，记录在 ${LEDGER}；终端上方的 pnpm/npm 输出就是真因）`)
    process.exit(1)
  }
}
appendLedger(done, '全部成功')
console.log(`\n✓ 发布完成：${done.length} 个包`)

/** 台账一行一个包（应用版 ↔ 基座版映射的唯一事实源是 docs/VERSIONING.md，这里只记 npm 发布事实）。 */
function appendLedger(published, note) {
  const header = existsSync(LEDGER) ? '' : '# 发布台账（npm `@corum/*`）\n\n| 时间 | 包 | 版本 | 结果 |\n|---|---|---|---|\n'
  const stamp = new Date().toISOString()
  const rows = published.map(p => `| ${stamp} | \`${p.name}\` | ${p.version} | ok |`).join('\n')
  const line = `${rows}\n\n> ${stamp} ${note}\n`
  try {
    writeFileSync(LEDGER, `${existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8') : ''}${header}${line}`)
  } catch (error) {
    console.error(`（台账写入失败，忽略）${String(error)}`)
  }
}
