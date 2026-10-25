#!/usr/bin/env node
/**
 * check-shipped-skills.mjs — 随包内置技能集的自检脚本。
 *
 * ## 为什么不是 vitest
 *
 * `@corum/corum-skill-manager` 本机没有本地 vitest（该包 node_modules/.bin 里只有
 * cordis / tsc / tsdown / tsserver / yaml），而 `pnpm install` 在本机因 TTY 保护拒绝
 * 执行；往 package.json 加 `vitest` devDependency 又会让 pnpm-lock.yaml 的 importer
 * 与 package.json 不一致（CI 的 `--frozen-lockfile` 会直接失败）。所以这里走
 * 「纯策略模块 + 可独立执行的 .mjs 自检」这条路：
 *
 *   - 判定核心 `planShippedImport` 是**无 fs 的纯函数**（src/shipped-skills.ts）；
 *   - 落盘壳 `importShippedSkills` 只依赖 node 内置模块，编译产物
 *     `lib/types/shipped-skills.js` 可被本脚本直接 import；
 *   - 夹具全部用 `os.tmpdir()` 下的临时目录真建真删，不碰用户技能库。
 *
 * 等价于单测的断言，只是没有测试框架的语法糖——这正是「本机装不上 vitest」时
 * 仍然能跑通、且在任何有 node 的机器上都能跑的那条路。
 *
 * ## 覆盖的验收点
 *
 *   A. 随包目录真实性：解析锚点、技能数量/名单、frontmatter 与目录名一致、无本机产物
 *   B. 纯策略 planShippedImport：installed / skipped / tombstoned 三分支与优先级
 *   C. 首次导入 → 全部 installed
 *   D. 改过的技能再导入 → skipped 且**逐字节未被覆盖**（用户改动保得住）
 *   E. 删掉的技能再导入 → tombstoned 且**目录不复活**
 *   F. tombstone 台账：幂等 / 坏 JSON 容错 / clearTombstone 撤回
 *   G. 随包目录缺失 → ok:false + error，且不写任何东西
 *
 * 用法：node scripts/check-shipped-skills.mjs
 * 退出码：0 全部通过；1 有断言失败（失败清单打在 stderr）。
 */

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MODULE_URL = new URL('../lib/types/shipped-skills.js', import.meta.url)

let mod
try {
  mod = await import(MODULE_URL.href)
} catch (error) {
  console.error(`[check-shipped-skills] 无法加载 ${MODULE_URL.pathname}`)
  console.error('  先跑 `pnpm --filter @corum/corum-skill-manager run build`（tsc 产出 lib/types/shipped-skills.js）。')
  console.error(`  原始错误：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { planShippedImport, importShippedSkills, scanShippedSkills, resolveShippedSkillsRoot, readTombstones, writeTombstone, clearTombstone, TOMBSTONE_FILE_NAME } = mod

/* ── 断言记账 ───────────────────────────────────────────────────────── */

let passed = 0
const failures = []

/**
 * 跑一个具名断言。
 * @param {string} label - 用例名（打印用）。
 * @param {() => void} fn - 断言体，抛错即失败。
 */
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

/** 建一个技能目录（含带 frontmatter 的 SKILL.md + 一个附属文件）。 */
function makeSkill(root, name, description = `${name} 的描述`, extra = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(dir + '/SKILL.md', `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8')
  for (const [rel, body] of Object.entries(extra)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body, 'utf8')
  }
  return dir
}

/** @returns {string} 新建的临时根目录。 */
const tempRoots = []
function makeTempRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `corum-shipped-skills-${label}-`))
  tempRoots.push(dir)
  return dir
}

/* ── A. 随包目录真实性 ─────────────────────────────────────────────── */

console.log('\nA. 随包目录真实性（真实仓库目录，只读）')

// Corum/dsh 项目专属技能由 corum-dev-preset 扩展包维护；此处只列
// 仍随应用分发的通用技能。目录扫描仍兼容 shipped-modules 布局。
const EXPECTED = [
  'record-browser-gif',
]

const EXCLUDED_LOCAL = ['testSkill', 'androidSkill']

const shippedRoot = resolveShippedSkillsRoot()

check('A1 resolveShippedSkillsRoot() 命中 packages/desktop/shipped-skills', () => {
  assert.ok(shippedRoot !== undefined, '解析结果为 undefined')
  assert.equal(resolve(shippedRoot), resolve(PACKAGE_ROOT, '../../../desktop/shipped-skills'))
})

const scanned = shippedRoot === undefined ? [] : scanShippedSkills(shippedRoot)

check(`A2 随包技能恰好 ${EXPECTED.length} 个且名单与判定表一致`, () => {
  assert.deepEqual(scanned.map(s => s.name), EXPECTED)
})

// 直接读经典 shipped-skills 目录，核验与 EXPECTED 一致；模块布局的
// 兼容性由下方独立夹具覆盖，不再要求 corum-dev 模块存在。
check('A2b 经典 shipped-skills 目录只收录 EXPECTED 通用技能', () => {
  const inShippedSkills = readdirSync(shippedRoot)
    .filter(n => /^[a-z0-9][a-z0-9-]*$/.test(n) && existsSync(join(shippedRoot, n, 'SKILL.md')))
  assert.deepEqual(inShippedSkills.sort(), [...EXPECTED].sort())
})

check('A3 每个技能都有合法 frontmatter（name/description 非空）', () => {
  for (const s of scanned) {
    assert.ok(s.description.trim() !== '', `${s.name} 的 description 为空`)
  }
})

check('A4 frontmatter name 与目录名一致（官方加载器按 name 校验）', () => {
  for (const s of scanned) {
    const raw = readFileSync(join(s.sourcePath, 'SKILL.md'), 'utf8')
    const name = raw.match(/^---\n[\s\S]*?^name:\s*(.+)$/m)?.[1]?.trim()
      // 2026-10-11 修：官方加载器用 **YAML 解析器**（`skill-filesystem/src/index.ts:925`
      // 的 `parseYaml`）取 name，YAML 会**剥掉引号**。例如带冒号的 description
      // 需要引号，name 也可能采用引号风格；直接比对原文会误判不一致。
      // 这里按 YAML 口径剥引号，与官方加载器对齐。
      ?.replace(/^(['"])([\s\S]*)\1$/, '$2')
    assert.equal(name, s.name, `${s.name} 的 frontmatter name=${String(name)}`)
  }
})

check('A5 体量：无随包产物（.versions / skill-versions.json / .git / node_modules）', () => {
  for (const s of scanned) {
    for (const artifact of ['.versions', 'skill-versions.json', '.git', 'node_modules', '.DS_Store']) {
      assert.ok(!existsSync(join(s.sourcePath, artifact)), `${s.name} 带了本机产物 ${artifact}`)
    }
  }
})

check('A6 本机自建/试验技能与 corum 自有技能不在随包集里', () => {
  const names = new Set(scanned.map(s => s.name))
  for (const name of EXCLUDED_LOCAL) {
    assert.ok(!names.has(name), `不应随包分发：${name}`)
  }
})

/* ── B. 纯策略 planShippedImport ──────────────────────────────────── */

console.log('\nB. 纯策略 planShippedImport（无 fs 判定核心）')

check('B1 目标为空 → 全部 installed', () => {
  const plan = planShippedImport({ available: ['a', 'b', 'c'], existing: [], tombstoned: [] })
  assert.deepEqual(plan, { installed: ['a', 'b', 'c'], skipped: [], tombstoned: [] })
})

check('B2 目标已有同名 → skipped，其余 installed', () => {
  const plan = planShippedImport({ available: ['a', 'b', 'c'], existing: ['b'], tombstoned: [] })
  assert.deepEqual(plan, { installed: ['a', 'c'], skipped: ['b'], tombstoned: [] })
})

check('B3 tombstone → tombstoned，且优先于 skipped', () => {
  const plan = planShippedImport({ available: ['a', 'b'], existing: ['b'], tombstoned: ['b'] })
  assert.deepEqual(plan, { installed: ['a'], skipped: [], tombstoned: ['b'] })
})

check('B4 三桶互斥且并集 = available', () => {
  const available = ['a', 'b', 'c', 'd']
  const plan = planShippedImport({ available, existing: ['b', 'c'], tombstoned: ['d'] })
  const all = [...plan.installed, ...plan.skipped, ...plan.tombstoned]
  assert.equal(new Set(all).size, all.length, '出现了重复项')
  assert.deepEqual([...all].sort(), [...available].sort())
})

check('B5 输入里的重复名只落一桶', () => {
  const plan = planShippedImport({ available: ['a', 'a'], existing: [], tombstoned: [] })
  assert.deepEqual(plan.installed, ['a'])
})

/* ── C~G. 落盘壳 importShippedSkills（临时目录夹具）────────────────── */

console.log('\nC~G. 落盘壳 importShippedSkills（临时目录真建真删）')

// 夹具：随包目录 3 个技能（其中一个带附属文件）；空的技能库
const fxShipped = makeTempRoot('shipped')
const fxSkills = makeTempRoot('skills')
const fxHome = makeTempRoot('home')
const fxTombstone = join(fxHome, TOMBSTONE_FILE_NAME)

makeSkill(fxShipped, 'alpha', 'alpha 描述', { 'references/notes.md': 'alpha 参考\n' })
makeSkill(fxShipped, 'beta', 'beta 描述')
makeSkill(fxShipped, 'gamma', 'gamma 描述')
// 随包目录根下的散文件不应被当成技能
writeFileSync(join(fxShipped, 'PROVENANCE.md'), '# 来源说明\n', 'utf8')

check('C1 首次导入 → 全部 installed，且文件真的落盘', () => {
  const r = importShippedSkills({ shippedRoot: fxShipped, skillsRoot: fxSkills, tombstoneFile: fxTombstone })
  assert.equal(r.ok, true)
  assert.deepEqual(r.installed, ['alpha', 'beta', 'gamma'])
  assert.deepEqual(r.skipped, [])
  assert.deepEqual(r.tombstoned, [])
  assert.ok(existsSync(join(fxSkills, 'alpha', 'SKILL.md')), 'alpha/SKILL.md 未落盘')
  assert.ok(existsSync(join(fxSkills, 'alpha', 'references', 'notes.md')), '附属文件未随目录复制')
  assert.ok(!existsSync(join(fxSkills, 'PROVENANCE.md')), '随包目录根的散文件被误当技能安装')
})

check('C2 再次导入（没人改没人删）→ 全部 skipped', () => {
  const r = importShippedSkills({ shippedRoot: fxShipped, skillsRoot: fxSkills, tombstoneFile: fxTombstone })
  assert.deepEqual(r.installed, [])
  assert.deepEqual(r.skipped, ['alpha', 'beta', 'gamma'])
  assert.deepEqual(r.tombstoned, [])
})

check(`C3 用真实随包技能集做一次完整往返：${EXPECTED.length} 个全部装上，再导入全部 skipped`, () => {
  const realSkills = makeTempRoot('skills-real')
  const realTombstone = join(makeTempRoot('home-real'), TOMBSTONE_FILE_NAME)
  const first = importShippedSkills({ shippedRoot, skillsRoot: realSkills, tombstoneFile: realTombstone })
  assert.equal(first.ok, true, `首次导入失败：${String(first.error)}`)
  assert.deepEqual(first.installed, EXPECTED, '装上的名单与判定表不一致')
  for (const name of EXPECTED) {
    assert.ok(existsSync(join(realSkills, name, 'SKILL.md')), `${name}/SKILL.md 未落盘`)
  }
  const second = importShippedSkills({ shippedRoot, skillsRoot: realSkills, tombstoneFile: realTombstone })
  assert.deepEqual(second.installed, [])
  assert.deepEqual(second.skipped, EXPECTED)
})

// 模拟「用户改过 alpha」：改 SKILL.md、改随包带来的附属文件、加自己的文件
const USER_EDIT = '---\nname: alpha\ndescription: 用户改过的 alpha\n---\n\n用户自己的正文\n'
const USER_REF = '用户改过的参考资料\n'
writeFileSync(join(fxSkills, 'alpha', 'SKILL.md'), USER_EDIT, 'utf8')
writeFileSync(join(fxSkills, 'alpha', 'user-note.md'), '用户加的笔记\n', 'utf8')
writeFileSync(join(fxSkills, 'alpha', 'references', 'notes.md'), USER_REF, 'utf8')

check('D1 改过的技能再导入 → 计入 skipped（不报 installed）', () => {
  const r = importShippedSkills({ shippedRoot: fxShipped, skillsRoot: fxSkills, tombstoneFile: fxTombstone })
  assert.deepEqual(r.installed, [])
  assert.deepEqual(r.skipped, ['alpha', 'beta', 'gamma'])
})

check('D2 改过的技能逐字节未被覆盖（正文 / 附属文件 / 用户新增文件）', () => {
  assert.equal(readFileSync(join(fxSkills, 'alpha', 'SKILL.md'), 'utf8'), USER_EDIT, 'SKILL.md 被覆盖了')
  assert.equal(readFileSync(join(fxSkills, 'alpha', 'references', 'notes.md'), 'utf8'), USER_REF, '随包附属文件覆盖了用户改过的同名文件')
  assert.equal(readFileSync(join(fxSkills, 'alpha', 'user-note.md'), 'utf8'), '用户加的笔记\n', '用户文件被动了')
})

// 模拟「用户删掉 beta」：删目录 + 记 tombstone（服务 deleteSkill 对内置技能名做同样的事）
rmSync(join(fxSkills, 'beta'), { recursive: true, force: true })
writeTombstone(fxTombstone, 'beta', '2026-09-13T00:00:00.000Z')

check('E1 删掉的技能再导入 → 计入 tombstoned，不是 installed/skipped', () => {
  const r = importShippedSkills({ shippedRoot: fxShipped, skillsRoot: fxSkills, tombstoneFile: fxTombstone })
  assert.deepEqual(r.installed, [])
  assert.deepEqual(r.skipped, ['alpha', 'gamma'])
  assert.deepEqual(r.tombstoned, ['beta'])
})

check('E2 删掉的技能没有复活：目标目录仍不存在', () => {
  assert.ok(!existsSync(join(fxSkills, 'beta')), 'beta 被复活了')
})

check('E3 台账落在 CORUM_HOME 根，且记下了删除时间', () => {
  assert.ok(existsSync(fxTombstone), '台账文件不存在')
  assert.equal(TOMBSTONE_FILE_NAME, 'skills.tombstones.json')
  const raw = JSON.parse(readFileSync(fxTombstone, 'utf8'))
  assert.equal(raw.version, 1)
  assert.deepEqual(raw.tombstones, [{ name: 'beta', deletedAt: '2026-09-13T00:00:00.000Z' }])
  assert.deepEqual(readTombstones(fxTombstone), ['beta'])
})

check('E4 tombstone 是幂等的（重复删除不产生重复条目）', () => {
  writeTombstone(fxTombstone, 'beta', '2026-09-13T01:00:00.000Z')
  const raw = JSON.parse(readFileSync(fxTombstone, 'utf8'))
  assert.equal(raw.tombstones.length, 1)
  assert.equal(raw.tombstones[0].deletedAt, '2026-09-13T01:00:00.000Z')
})

check('F1 台账坏掉（非 JSON）时按空台账处理，导入不整体失败', () => {
  // 用独立技能库：坏台账 = 记录丢失，这里只验证「不炸」，不验证「不复活」
  // （记录丢失会退化成可能复活一个被删的技能，是台账读不出的已知代价）。
  const brokenFile = join(fxHome, 'broken.tombstones.json')
  const brokenSkills = makeTempRoot('skills-broken')
  writeFileSync(brokenFile, '{ 这不是 JSON', 'utf8')
  assert.deepEqual(readTombstones(brokenFile), [])
  const r = importShippedSkills({ shippedRoot: fxShipped, skillsRoot: brokenSkills, tombstoneFile: brokenFile })
  assert.equal(r.ok, true)
  assert.deepEqual(r.installed, ['alpha', 'beta', 'gamma'])
})

check('F2 台账结构合法但字段类型不对时逐条过滤', () => {
  const oddFile = join(fxHome, 'odd.tombstones.json')
  writeFileSync(oddFile, JSON.stringify({ version: 1, tombstones: [{ name: 'ok', deletedAt: 'x' }, { name: 42 }, null, 'nope'] }), 'utf8')
  assert.deepEqual(readTombstones(oddFile), ['ok'])
})

check('F3 clearTombstone 撤回后该技能可以重新装上（显式导入的出口）', () => {
  assert.equal(clearTombstone(fxTombstone, 'beta'), true)
  assert.deepEqual(readTombstones(fxTombstone), [])
  const r = importShippedSkills({ shippedRoot: fxShipped, skillsRoot: fxSkills, tombstoneFile: fxTombstone })
  assert.deepEqual(r.installed, ['beta'], '撤回 tombstone 后 beta 应能装回来')
  assert.ok(existsSync(join(fxSkills, 'beta', 'SKILL.md')))
})

check('F4 clearTombstone 对不存在的名字返回 false（幂等空操作）', () => {
  assert.equal(clearTombstone(fxTombstone, 'never-tombstoned'), false)
})

check('G1 随包目录缺失 → ok:false + error，且不往技能库写任何东西', () => {
  const emptySkills = makeTempRoot('skills-empty')
  const r = importShippedSkills({
    shippedRoot: join(fxShipped, 'does-not-exist'),
    skillsRoot: emptySkills,
    tombstoneFile: join(fxHome, 'unused.tombstones.json'),
  })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /内置技能目录不存在/)
  assert.deepEqual(r.installed, [])
  assert.deepEqual(r.skipped, [])
  assert.deepEqual(r.tombstoned, [])
  assert.equal(existsSync(join(emptySkills, 'alpha')), false)
})

check('G2 shippedRoot 里的坏技能（frontmatter 缺 description）被扫描跳过', () => {
  const halfShipped = makeTempRoot('shipped-half')
  makeSkill(halfShipped, 'good', '好的')
  mkdirSync(join(halfShipped, 'bad'), { recursive: true })
  writeFileSync(join(halfShipped, 'bad', 'SKILL.md'), '---\nname: bad\n---\n没有 description\n', 'utf8')
  const names = scanShippedSkills(halfShipped).map(s => s.name)
  assert.deepEqual(names, ['good'])
})

/* ── I. 服务级集成（真 SkillManagerService + 临时 CORUM_HOME）───────── */

console.log('\nI. 服务级集成（真 SkillManagerService + 临时 CORUM_HOME）')

const { Context } = await import('@deepseek-ai/cordis')
const { SkillManagerService } = await import(new URL('../lib/index.js', import.meta.url).href)

/**
 * 在隔离的 CORUM_HOME / 随包目录下跑一段回调。
 * `corumHome()` 与 `resolveShippedSkillsRoot()` 都在调用时读环境变量，
 * 所以换 env 就能把服务指向临时目录，不碰真实用户技能库。
 *
 * @param {{ home: string, shipped: string }} env - 临时 CORUM_HOME 与随包目录。
 * @param {() => void} fn - 断言体。
 */
function withServiceEnv(env, fn) {
  const savedHome = process.env.CORUM_HOME
  const savedShipped = process.env.CORUM_SHIPPED_SKILLS_DIR
  process.env.CORUM_HOME = env.home
  process.env.CORUM_SHIPPED_SKILLS_DIR = env.shipped
  try {
    fn()
  } finally {
    if (savedHome === undefined) delete process.env.CORUM_HOME
    else process.env.CORUM_HOME = savedHome
    if (savedShipped === undefined) delete process.env.CORUM_SHIPPED_SKILLS_DIR
    else process.env.CORUM_SHIPPED_SKILLS_DIR = savedShipped
  }
}

/** 起一个挂在独立 cordis Context 上的真服务实例。 */
function newService() {
  return new SkillManagerService(new Context())
}

const svcHome = makeTempRoot('svc-home')
const svcSkills = join(svcHome, 'skills')
const svcTombstone = join(svcHome, TOMBSTONE_FILE_NAME)

check('I1 服务级：首次 importBuiltinSkills() → 三个全部 installed 且补了初始版本', () => {
  withServiceEnv({ home: svcHome, shipped: fxShipped }, () => {
    const svc = newService()
    const r = svc.importBuiltinSkills()
    assert.equal(r.ok, true, `未成功：${String(r.error)}`)
    assert.deepEqual(r.installed, ['alpha', 'beta', 'gamma'])
    assert.deepEqual(r.skipped, [])
    assert.deepEqual(r.tombstoned, [])
    const versions = JSON.parse(readFileSync(join(svcSkills, 'alpha', 'skill-versions.json'), 'utf8'))
    assert.equal(versions.versions.length, 1)
    assert.equal(versions.versions[0].label, '内置技能导入')
    assert.deepEqual(svc.listAll().skills.map(s => s.name), ['alpha', 'beta', 'gamma'])
  })
})

const SVC_USER_EDIT = '---\nname: alpha\ndescription: 用户改过的 alpha\n---\n\n服务级夹具改动\n'
writeFileSync(join(svcSkills, 'alpha', 'SKILL.md'), SVC_USER_EDIT, 'utf8')

check('I2 服务级：改过的技能再 importBuiltinSkills() → skipped，正文未被覆盖', () => {
  withServiceEnv({ home: svcHome, shipped: fxShipped }, () => {
    const svc = newService()
    const r = svc.importBuiltinSkills()
    assert.deepEqual(r.installed, [])
    assert.deepEqual(r.skipped, ['alpha', 'beta', 'gamma'])
    assert.equal(readFileSync(join(svcSkills, 'alpha', 'SKILL.md'), 'utf8'), SVC_USER_EDIT, '用户改动被覆盖了')
  })
})

check('I3 服务级：deleteSkill() 删内置技能 → tombstone 落在 <CORUM_HOME>/skills.tombstones.json', () => {
  withServiceEnv({ home: svcHome, shipped: fxShipped }, () => {
    const svc = newService()
    assert.deepEqual(svc.deleteSkill('beta'), { ok: true })
    assert.ok(existsSync(svcTombstone), '删除内置技能没落 tombstone')
    const raw = JSON.parse(readFileSync(svcTombstone, 'utf8'))
    assert.deepEqual(raw.tombstones.map(t => t.name), ['beta'])
  })
})

check('I4 服务级：删掉的内置技能再 importBuiltinSkills() → tombstoned，目录不复活', () => {
  withServiceEnv({ home: svcHome, shipped: fxShipped }, () => {
    const svc = newService()
    const r = svc.importBuiltinSkills()
    assert.deepEqual(r.installed, [])
    assert.deepEqual(r.skipped, ['alpha', 'gamma'])
    assert.deepEqual(r.tombstoned, ['beta'])
    assert.equal(existsSync(join(svcSkills, 'beta')), false, 'beta 被复活了')
  })
})

check('I5 服务级：显式 importFromText 导入同名技能 → 撤回 tombstone（用户主动要回来）', () => {
  withServiceEnv({ home: svcHome, shipped: fxShipped }, () => {
    const svc = newService()
    const r = svc.importFromText('beta', '---\nname: beta\ndescription: 用户重新要回来的 beta\n---\n正文\n')
    assert.equal(r.ok, true, `显式导入失败：${String(r.error)}`)
    assert.deepEqual(readTombstones(svcTombstone), [], 'tombstone 未被撤回')
    const again = svc.importBuiltinSkills()
    assert.deepEqual(again.tombstoned, [])
    assert.deepEqual(again.skipped, ['alpha', 'beta', 'gamma'])
  })
})

check('I6 服务级：删除非内置技能不落 tombstone（用户自建技能不占内置名额）', () => {
  const localHome = makeTempRoot('svc-local-home')
  withServiceEnv({ home: localHome, shipped: fxShipped }, () => {
    const svc = newService()
    const created = svc.importFromText('my-own-skill', '---\nname: my-own-skill\ndescription: 用户自建\n---\n正文\n')
    assert.equal(created.ok, true)
    assert.deepEqual(svc.deleteSkill('my-own-skill'), { ok: true })
    assert.equal(existsSync(join(localHome, TOMBSTONE_FILE_NAME)), false, '非内置技能也被记了 tombstone')
  })
})

check('I7 服务级：随包目录解析不到 → ok:false + 可读 error，技能库不被动', () => {
  const emptyHome = makeTempRoot('svc-empty-home')
  withServiceEnv({ home: emptyHome, shipped: join(fxShipped, 'missing-dir') }, () => {
    const svc = newService()
    const r = svc.importBuiltinSkills()
    assert.equal(r.ok, false)
    assert.match(String(r.error), /不存在/)
    assert.deepEqual(r.installed, [])
    assert.equal(existsSync(join(emptyHome, 'skills', 'alpha')), false)
  })
})

check(`I8 服务级：用真实随包目录首次点按钮 → ${EXPECTED.length} 个技能全部 installed`, () => {
  const realHome = makeTempRoot('svc-real-home')
  withServiceEnv({ home: realHome, shipped: shippedRoot }, () => {
    const svc = newService()
    const r = svc.importBuiltinSkills()
    assert.equal(r.ok, true, `未成功：${String(r.error)}`)
    assert.deepEqual(r.installed, EXPECTED)
    assert.deepEqual(r.skipped, [])
    assert.deepEqual(r.tombstoned, [])
    assert.equal(svc.listAll().skills.length, EXPECTED.length)
  })
})

/* ── 收尾 ─────────────────────────────────────────────────────────── */

const DEFAULT_SHIPPED = join(PACKAGE_ROOT, '..', '..', '..', 'desktop', 'shipped-skills')
check('H1 随包技能目录就是 packages/desktop/shipped-skills（无环境变量覆盖时）', () => {
  const previous = process.env.CORUM_SHIPPED_SKILLS_DIR
  delete process.env.CORUM_SHIPPED_SKILLS_DIR
  try {
    assert.equal(resolve(resolveShippedSkillsRoot() ?? ''), resolve(DEFAULT_SHIPPED))
  } finally {
    if (previous !== undefined) process.env.CORUM_SHIPPED_SKILLS_DIR = previous
  }
})

check('H2 CORUM_SHIPPED_SKILLS_DIR 覆盖生效（自定义打包/自检入口）', () => {
  const previous = process.env.CORUM_SHIPPED_SKILLS_DIR
  process.env.CORUM_SHIPPED_SKILLS_DIR = fxShipped
  try {
    assert.equal(resolveShippedSkillsRoot(), fxShipped)
  } finally {
    if (previous === undefined) delete process.env.CORUM_SHIPPED_SKILLS_DIR
    else process.env.CORUM_SHIPPED_SKILLS_DIR = previous
  }
})

check('H3 夹具用的是临时目录，未触碰真实技能库', () => {
  assert.ok(fxSkills.startsWith(tmpdir()), 'fixture 不在 tmpdir 下')
  assert.ok(!existsSync(join(DEFAULT_SHIPPED, 'alpha')), '污染了真实随包目录')
})

for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error('\n失败清单：')
  for (const { label, error } of failures) {
    console.error(`  - ${label}`)
    console.error(`    ${error instanceof Error ? error.stack?.split('\n').slice(0, 3).join('\n    ') : String(error)}`)
  }
  process.exit(1)
}
console.log('随包内置技能集自检全部通过。')
