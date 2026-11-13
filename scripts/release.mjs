#!/usr/bin/env node
/**
 * release.mjs —— 发布助手：**自动递增版本号 + 输出 TOP5 更新日志 + 注意事项**。
 *
 * 由来（台账 `decision.versioning.app-vs-dsh-baseline`，2026-10-03 用户要求
 * 「每次发布时要能自动输出 TOP5 的更新日志，注意事项，并自动递增版本」）。
 * 规则的家是 [`docs/VERSIONING.md`](../../docs/VERSIONING.md)，本脚本是它的可执行投影。
 *
 * ## 数据源（两块，各有其职）
 *
 * - **更新日志 ← git 提交信息**（conventional commits）。用户 2026-10-03 拍板。
 *   ⚠️ 本仓有 `wip(turn-…): auto-commit on turn end` 这类**自动提交**（实测 v0.1.0 以来
 *   28 个提交里 14 个是 wip）。它们不是给人看的条目，故默认按 `wip` 前缀过滤掉；
 *   但**wip 提交里也含真实工作**（如三页迁移那轮），所以脚本会**统计 wip 占比并警示**，
 *   而不是假装没有——占比过高时更新日志可信度下降，这个信号必须让人看见。
 * - **注意事项 ← 台账 `docs/tasks/log.jsonl`**。提交信息里没有「坑/约束/风险」这类内容，
 *   而台账的 `lesson` / `risk` / `constraint` / `correction` 正是它们的家。
 *   取「上个 tag 以来」的这几类条目，摘其首句。
 *
 * ## 版本递增规则
 *
 * 按**本轮提交类型**判定（`--bump` 可覆盖）：
 *   - 含 `feat!` / `BREAKING CHANGE` → **major**
 *   - 含 `feat`                       → **minor**
 *   - 其余（fix/docs/chore/refactor…） → **patch**
 *
 * ## 用法
 *
 *   node scripts/release.mjs                     # 预览：打印版本变更 + TOP5 + 注意事项（不写文件）
 *   node scripts/release.mjs --write             # 实际递增全部受管版本位置 + 追加台账
 *   node scripts/release.mjs --bump=minor        # 强制递增档位（major|minor|patch）
 *   node scripts/release.mjs --since=<ref>       # 指定基线（默认：最近 tag）
 *   node scripts/release.mjs --json              # 机器可读
 *
 * 退出码：0 = 正常；1 = 有阻断性问题（如工作树脏、两处版本不一致、无新提交）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 版本号住两处发布位，必须同值（VERSIONING.md §5.3）。 */
const VERSION_FILES = ['package.json', 'packages/desktop/package.json']

/** 插件包根目录（`packages/plugins/<group>/<name>/package.json`）。 */
const PLUGIN_ROOT = join(ROOT, 'packages/plugins')

/**
 * 所有 publishable 插件包的 `package.json` 相对路径（带 `publishConfig` 且非 `private`）。
 *
 * ## 为什么发版必须把它们也带上（A.6-VERSION-LINE）
 *
 * `scripts/verify-plugin-spec.mjs` 的 A.6 要求**每个 publishable 包的 version 都等于根版本**，
 * 而本脚本原先只写「根 + packages/desktop」两处 —— 于是版本一跳档（0.6.0 → 0.7.0、0.7.0 →
 * 0.8.0）就会出现「根说 0.8.0、51 个包仍说 0.7.0」的自相矛盾状态。
 *
 * 2026-11-12 首次暴露：`73fc8458 chore(release): 0.8.0` 只改了两处，pr-gate 第三道门
 * `Plugin spec gate`（`node scripts/verify-plugin-spec.mjs --strict`）从那一笔起恒红
 * （error 51 / warn 0，清一色 A.6-VERSION-LINE），此前被 Typecheck 先红挡住没暴露。
 * 0.7.0 那次是靠一笔手工补救提交（「48 个可发布插件包版本跟随根版本到 0.7.0」）才凑齐的 ——
 * 手工补丁不可依赖，故把「带上它们」收进本脚本：只要写版本，就一次写全。
 *
 * @returns 相对路径列表（排序稳定，便于逐条核对 diff）。
 */
function publishablePackageFiles() {
  const out = []
  for (const group of readdirSync(PLUGIN_ROOT, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupRel = `packages/plugins/${group.name}`
    for (const name of readdirSync(join(ROOT, groupRel), { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const rel = `${groupRel}/${name.name}/package.json`
      if (!existsSync(join(ROOT, rel))) continue
      let pkg
      try { pkg = JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) } catch { continue }
      if (pkg.publishConfig === undefined || pkg.private === true) continue
      out.push(rel)
    }
  }
  return out.sort()
}

/**
 * 版本号必须同值的**全部**位置：两处发布位 + 所有 publishable 插件包（见上）。 */
function versionFiles() {
  return [...VERSION_FILES, ...publishablePackageFiles()]
}

/** 自动提交前缀：不是给人看的条目，默认不进更新日志。 */
const WIP_PREFIX = /^wip(\(|:)/

/** conventional commit 的 `type(scope)` 头。 */
const COMMIT_HEAD = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/s

/**
 * 更新日志的排序权重：**用户可见影响优先**（用户 2026-10-03 拍板）。
 * feat 最前（新能力），其次 fix（缺陷修复），再 refactor/perf（体感变化），
 * docs/chore/test 最后（对用户几乎不可见）。
 */
const TYPE_WEIGHT = {
  feat: 0, fix: 1, perf: 2, refactor: 3, revert: 4,
  build: 5, chore: 6, docs: 7, test: 8, style: 9, ci: 10,
}

/** 注意事项从台账这几类里取（提交信息没有「坑」这个维度）。 */
const NOTE_KINDS = new Set(['lesson', 'risk', 'constraint', 'correction'])

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(`--${name}`)
const flagValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 3)
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function tryGit(args) {
  try { return git(args) } catch { return '' }
}

/** 读全部受管位置（versionFiles）的 version；不一致即阻断（否则会写出一个自相矛盾的版本）。 */
function readVersions() {
  return versionFiles().map((rel) => {
    const raw = readFileSync(join(ROOT, rel), 'utf8')
    const m = raw.match(/"version":\s*"([^"]+)"/)
    if (m === null) throw new Error(`${rel} 里找不到 "version" 字段`)
    return { rel, version: m[1] }
  })
}

/** 只替换 `"version"` 那一处，保持文件其余内容逐字节不变（不重新序列化整个 JSON）。 */
function writeVersion(rel, next) {
  const path = join(ROOT, rel)
  const raw = readFileSync(path, 'utf8')
  const nextRaw = raw.replace(/("version":\s*")([^"]+)(")/, `$1${next}$3`)
  if (nextRaw === raw) throw new Error(`${rel} 的 version 未被替换（正则没命中）`)
  writeFileSync(path, nextRaw, 'utf8')
}

/** 自增：支持 `0.2.0` 与 `0.2.0-rc.1` 两种形态（后者只动前面的三段）。 */
function bumpVersion(version, kind) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (m === null) throw new Error(`版本号形态不认识：${version}`)
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'major') { major += 1; minor = 0; patch = 0 }
  else if (kind === 'minor') { minor += 1; patch = 0 }
  else { patch += 1 }
  return `${major}.${minor}.${patch}`
}

/** 基线：默认最近 tag；无 tag 则退回「首个提交」——用空树 ref，不能拿 rev-list 的
 *  输出当 ref 用（那会得到 "fatal: 'root': not an integer"）。 */
function resolveSince() {
  const explicit = flagValue('since')
  if (explicit !== undefined) return explicit
  const tag = tryGit(['describe', '--tags', '--abbrev=0'])
  // git 的空树对象：与首个提交比较时等效于「从仓库起点算起」。
  return tag === '' ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : tag
}

/** 取 `since..HEAD` 的提交（跳过合并提交——它们没有独立的信息量）。 */
function collectCommits(since) {
  const raw = tryGit([
    'log', `${since}..HEAD`, '--no-merges', '--format=%H%x1f%s%x1f%b%x1e',
  ])
  if (raw === '') return []
  return raw.split('\x1e').map((chunk) => chunk.trim()).filter((c) => c !== '').map((chunk) => {
    const [hash, subject, body] = chunk.split('\x1f')
    return { hash: (hash ?? '').slice(0, 7), subject: subject ?? '', body: body ?? '' }
  })
}

/** 提交 → 结构化条目；`wip` 自动提交标记为 noise（不参与日志，但计入占比）。 */
function classify(commits) {
  const entries = []
  const noise = []
  for (const c of commits) {
    if (WIP_PREFIX.test(c.subject)) { noise.push(c); continue }
    const m = c.subject.match(COMMIT_HEAD)
    if (m === null) {
      // 非 conventional 的提交也要留痕（否则会静默丢失工作）。
      entries.push({ hash: c.hash, type: 'other', scope: '', breaking: false, text: c.subject, body: c.body })
      continue
    }
    entries.push({
      hash: c.hash,
      type: m[1],
      scope: m[2] ?? '',
      breaking: m[3] === '!' || /BREAKING[ -]CHANGE/.test(c.body),
      text: m[4].trim(),
      body: c.body,
    })
  }
  return { entries, noise }
}

/**
 * TOP N 更新日志：**用户可见影响优先 + 区域去重**（用户 2026-10-03 拍板）。
 *
 * 去重的意义：同一轮的改动常拆成多个同 scope 提交（本仓常见），若不去重，
 * 5 条可能全是 `sidebar`，等于没让人看到这版都动了哪些地方。
 *
 * @param entries - 结构化提交条目。
 * @param limit - 取前几条（默认 5）。
 * @returns 选中的条目。
 */
function pickTop(entries, limit = 5) {
  const ranked = [...entries].sort((a, b) => {
    const wa = TYPE_WEIGHT[a.type] ?? 50
    const wb = TYPE_WEIGHT[b.type] ?? 50
    if (wa !== wb) return wa - wb
    return a.scope.localeCompare(b.scope)
  })
  const chosen = []
  const seenScope = new Set()
  for (const e of ranked) {
    const key = e.scope === '' ? `__${e.hash}` : e.scope
    if (seenScope.has(key)) continue
    seenScope.add(key)
    chosen.push(e)
    if (chosen.length >= limit) break
  }
  // 区域不够 N 条时（提交种类少），用剩下的按权重补齐，不硬凑空位。
  if (chosen.length < limit) {
    for (const e of ranked) {
      if (chosen.includes(e)) continue
      chosen.push(e)
      if (chosen.length >= limit) break
    }
  }
  return chosen
}

/**
 * 注意事项：台账里的 lesson/risk/constraint/correction，取首句，**最多 limit 条**。
 *
 * 为什么要限量：这些条目是给开发看的复盘，一轮可能积几十条，全倒出来没人看。
 * 取「最新」的若干条——离这次发布最近的经验最相关。
 *
 * 基线日期取不到时（如无 tag 且 `--since` 指向非提交 ref），**退回按台账末尾取**，
 * 而不是把整本台账倒出来（实测无 tag 时会打印 150+ 条）。
 *
 * @param since - 基线 ref。
 * @param limit - 最多几条（默认 8）。
 * @returns 注意事项条目。
 */
function collectNotes(since, limit = 8) {
  const path = join(ROOT, 'docs/tasks/log.jsonl')
  let rows = []
  try {
    rows = readFileSync(path, 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l !== '')
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((r) => r !== null)
  } catch { return [] }
  const sinceDate = tryGit(['log', '-1', '--format=%cs', since])
  const picked = rows
    .filter((r) => NOTE_KINDS.has(r.kind))
    .filter((r) => sinceDate === '' || String(r.created ?? '') >= sinceDate)
    .map((r) => {
      const first = String(r.text ?? '').replace(/\s+/g, ' ').split(/(?<=。)|(?<=\. )/)[0] ?? ''
      return { kind: r.kind, key: r.key, created: r.created ?? '', line: first.trim().slice(0, 180) }
    })
  // 按日期降序取最新 limit 条（同日内保持台账原序 = 书写顺序）。
  return picked.slice(-limit)
}

/**
 * 判定递增档位（用户 2026-10-28 定调，放宽规则）：
 *   - major：巨大的产品迭代（需 `--bump major` 或 breaking 变更显式触发）
 *   - minor：当前迭代下新增或重要功能改变（需 `--bump minor` 显式触发）
 *   - patch：小版本发版自动提升（默认档）
 *
 * 自动判定只看 breaking：有 breaking → major；其余一律 patch。
 * feat 不再自动升 minor——由发布者用 `--bump minor` 显式决定。
 */
function decideBump(entries) {
  if (entries.some((e) => e.breaking)) return 'major'
  return 'patch'
}

function renderText(report) {
  const out = []
  out.push(`发布预览（基线 ${report.since} → HEAD）`)
  out.push('')
  out.push(`版本：${report.current} → ${report.next}（${report.bumpKind}${report.bumpForced ? '，--bump 指定' : '，自动判定'}）`)
  out.push(`提交：${report.total} 个（有效 ${report.entries.length}，自动提交 ${report.noiseCount}）`)
  if (!report.currentIsTagged) {
    out.push(`⚠️ 当前版本 ${report.current} **没有对应 tag**（最近 tag 是 ${report.since}）。`)
    out.push(`   版本号已在 package.json 里前进过但没打 tag ⇒ 按本脚本会再递增一档，`)
    out.push(`   那个「${report.current}」就永远没有发布记录。发布前先补 \`git tag v${report.current}\`，`)
    out.push(`   否则这次会直接从 ${report.current} 跳到 ${report.next}。`)
  }
  if (report.noiseCount / Math.max(1, report.total) > 0.4) {
    out.push(`⚠️ 自动提交占比 ${Math.round((report.noiseCount / report.total) * 100)}% —— 更新日志只覆盖规范提交，`)
    out.push('   若真实工作散落在 wip 提交里，日志会漏项。建议发布前把关键改动落成规范提交。')
  }
  out.push('')
  out.push('## TOP5 更新日志')
  report.top.forEach((e, i) => {
    const scope = e.scope === '' ? '' : `**${e.scope}**：`
    out.push(`${i + 1}. ${scope}${e.text}（${e.type}，${e.hash}）`)
  })
  if (report.top.length === 0) out.push('（本轮无可列条目）')
  out.push('')
  out.push(`## 注意事项（${report.notes.length} 条，来自台账）`)
  if (report.notes.length === 0) out.push('（本轮无 lesson/risk/constraint 条目）')
  for (const n of report.notes) out.push(`- [${n.kind}] ${n.line}`)
  return out.join('\n')
}

function main() {
  const versions = readVersions()
  const unique = [...new Set(versions.map((v) => v.version))]
  if (unique.length > 1) {
    // 只列**不一致**的那些，否则 53 个文件全量打印会淹掉真正越位的那几处。
    const counts = new Map()
    for (const v of versions) counts.set(v.version, (counts.get(v.version) ?? 0) + 1)
    const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const drifted = versions.filter((v) => v.version !== majority)
    console.error(`✗ 版本号不一致（${versions.length} 处受管位置，应为同值）：${majority} 之外还有 ${drifted.length} 处`)
    for (const v of drifted.slice(0, 20)) console.error(`  - ${v.rel} = ${v.version}`)
    if (drifted.length > 20) console.error(`  …另有 ${drifted.length - 20} 处`)
    console.error('  先对齐（VERSIONING.md §5.3 要求同值；publishable 包另受 plugin-spec A.6 约束），再发布。')
    return 1
  }
  const current = unique[0]

  const since = resolveSince()
  const commits = collectCommits(since)
  if (commits.length === 0) {
    console.error(`✗ ${since}..HEAD 之间没有提交，无可发布内容。`)
    return 1
  }
  const { entries, noise } = classify(commits)
  const bumpKind = flagValue('bump') ?? decideBump(entries)
  if (!['major', 'minor', 'patch'].includes(bumpKind)) {
    console.error(`✗ --bump 只接受 major|minor|patch，收到 ${bumpKind}`)
    return 1
  }
  const next = bumpVersion(current, bumpKind)

  /* 「打号未打 tag」陷阱：基线取的是**最近 tag**，而版本号可能已经在
     package.json 里前进过却没有对应 tag（本仓真实发生过：0.2.0 已写进两处
     package.json，但 tag 仍停在 v0.1.0）。此时本脚本会把 0.2.0 当成「未发布」
     再递增一次 ⇒ 同一个版本号被计两次。必须让人看见，而不是默默多跳一版。 */
  const tagExists = tryGit(['tag', '--list', `v${current}`]) !== ''
  const currentIsTagged = tagExists || current === since.replace(/^v/, '')

  const report = {
    since,
    current,
    currentIsTagged,
    next,
    bumpKind,
    bumpForced: flagValue('bump') !== undefined,
    total: commits.length,
    noiseCount: noise.length,
    entries,
    top: pickTop(entries, 5),
    notes: collectNotes(since),
  }

  if (hasFlag('json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  }

  process.stdout.write(`${renderText(report)}\n`)

  if (!hasFlag('write')) {
    process.stdout.write('\n（预览模式，未改任何文件。加 --write 才会递增版本号。）\n')
    return 0
  }

  // 写盘：全部受管位置（两处发布位 + 所有 publishable 插件包）+ 台账追一条
  //（台账追记才让「这版基于哪个基座」有据可查）。
  for (const { rel } of versions) writeVersion(rel, next)
  const notesLine = report.notes.map((n) => `  - [${n.kind}] ${n.line}`).join('\n')
  const logPath = join(ROOT, 'docs/tasks/log.jsonl')
  const entryRow = {
    key: `release.v${next}`,
    kind: 'delivery',
    status: 'shipped',
    scope: ['release'],
    value: `released-v${next}`,
    author: 'agent',
    created: new Date().toISOString().slice(0, 10),
    text: `发布 v${current} → v${next}（${bumpKind}，基线 ${since}，提交 ${report.total} 个）。\n\n`
      + `TOP5 更新日志：\n${report.top.map((e, i) => `  ${i + 1}. ${e.scope === '' ? '' : e.scope + '：'}${e.text}`).join('\n')}\n`
      + (report.notes.length > 0 ? `\n注意事项：\n${notesLine}` : ''),
  }
  writeFileSync(logPath, `${readFileSync(logPath, 'utf8').replace(/\n*$/, '\n')}${JSON.stringify(entryRow)}\n`, 'utf8')

  process.stdout.write(`\n✓ 已写入 ${versions.length} 处 version（${VERSION_FILES.join('、')} + ${versions.length - VERSION_FILES.length} 个 publishable 插件包）→ ${next}\n✓ 已向 docs/tasks/log.jsonl 追记 release.v${next}\n`)
  process.stdout.write('  下一步：确认 TOP5 文案 → 提交 → 打 tag（git tag v' + next + '）。\n')
  return 0
}

process.exit(main())
