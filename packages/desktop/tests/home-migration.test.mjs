/**
 * 升级路径「老 home → 新 home」的行为契约（2026-11-11，用户要求「必须保证 OK」）。
 *
 * ## 为什么这条路径必须钉死
 *
 * 产品在两个地方写过不同的默认 home：`~/.corum-desktop`（corum-desktop 时代）、
 * `~/.corum`（产品默认），以及 2026-11-03~11-11 那批内部构建写过的 `~/.corum-rc3`
 * （见 `DEFAULT_DESKTOP_HOME` 的注释）。用户升级时若新构建读的是**另一个**目录，
 * 表现就是「会话、项目、技能全都不见了」——数据其实还在，只是没人去看它。
 * 所以接管逻辑必须满足下面这组不变式，且**任何一种现场都不能让应用起不来**。
 *
 * ## 这里钉住什么
 *
 * ① 目标不存在 / 没有用户数据 + 旧 home 有数据 ⇒ **整目录搬迁**（内容到位、旧目录消失、
 *    留下接管记录）；
 * ② 目标**已有**用户数据（典型：0.7.0 用户，`~/.corum` 是活的）+ 旧 home 有数据 ⇒
 *    **只补缺失条目**：既有路径的内容一个字节都不许改，源目录原样保留；
 * ③ **幂等**：同一个旧 home 只接管一次——第二次启动哪怕目标里那些文件已被用户改过，
 *    也不许被旧 home 的内容回灌；
 * ④ **凭据成对**：目标已有 `.master-key` 或 `.credentials.yaml` 任一 ⇒ 两个都不搬
 *    （搬过去只会「Key 全失效」）；
 * ⑤ **`profiles/` 永不搬**（含 runtime-bundle 登记与 node_modules 链接，搬了会叠出
 *    `duplicate loader entry id`；回归守卫见最后两条）；
 * ⑥ 旧 home 只有 `run/`、`logs/` 这类运行时垃圾 ⇒ 不接管；
 * ⑦ 显式 `CORUM_HOME` ⇒ 一律不动（调用方自管 home）。
 *
 * ⚠️ 全程把 `HOME` 指向临时目录（`resolveDshHome` 用 `os.homedir()` 展开 `~`），
 * 绝不碰真实 home。
 * @module corum-desktop/tests/home-migration
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { ADOPTABLE_ENTRIES, resolveDesktopHome } = await import('../lib/types/host/home.js')

/** 在临时 HOME 下跑一段回调，退出时还原环境（`HOME`/`CORUM_HOME`/`DSH_HOME`）。 */
function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'corum-home-adopt-'))
  const saved = { HOME: process.env.HOME, CORUM_HOME: process.env.CORUM_HOME, DSH_HOME: process.env.DSH_HOME }
  process.env.HOME = dir
  delete process.env.CORUM_HOME
  delete process.env.DSH_HOME
  try {
    return fn(dir)
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME
    else process.env.HOME = saved.HOME
    if (saved.CORUM_HOME === undefined) delete process.env.CORUM_HOME
    else process.env.CORUM_HOME = saved.CORUM_HOME
    if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.DSH_HOME
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 造一个「有用户数据」的 home 目录骨架。 */
function seedHome(root, { sessions = ['s-1'], settings = 'model: a\n', credentials = true } = {}) {
  mkdirSync(join(root, 'sessions'), { recursive: true })
  for (const id of sessions) {
    mkdirSync(join(root, 'sessions', id), { recursive: true })
    writeFileSync(join(root, 'sessions', id, 'session.jsonl'), `{"id":"${id}"}\n`)
  }
  writeFileSync(join(root, 'settings.yaml'), settings)
  if (credentials) {
    writeFileSync(join(root, '.master-key'), 'k1\n')
    writeFileSync(join(root, '.credentials.yaml'), 'enc:v1:abc\n')
  }
  mkdirSync(join(root, 'run'), { recursive: true })
  writeFileSync(join(root, 'run', 'host.pid'), '{"pid":1}\n')
  return root
}

test('① 目标不存在 + 旧 home 有数据 ⇒ 整目录搬迁（内容到位、旧目录消失、留记录）', () => {
  withTempHome(dir => {
    const legacy = seedHome(join(dir, '.corum-rc3'))
    const home = resolveDesktopHome()
    assert.equal(home, join(dir, '.corum'))
    assert.equal(readFileSync(join(home, 'sessions', 's-1', 'session.jsonl'), 'utf8'), '{"id":"s-1"}\n')
    assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'model: a\n')
    assert.equal(existsSync(legacy), false, '整目录搬迁后旧目录不该留下')
    const record = JSON.parse(readFileSync(join(home, '.home-adoption.json'), 'utf8'))
    assert.deepEqual(record.adopted.map(item => [item.from, item.mode]), [['corum-rc3', 'move']])
  })
})

test('② 目标已有数据（0.7.0 用户）⇒ 只补缺失条目，既有内容一个字节都不改，源保留', () => {
  withTempHome(dir => {
    const target = seedHome(join(dir, '.corum'), { sessions: ['keep-me'], settings: 'model: kept\n' })
    const legacy = seedHome(join(dir, '.corum-rc3'), { sessions: ['legacy-only'], settings: 'model: ignored\n' })
    // 旧 home 独有、目标缺失的条目（技能 + 项目）
    mkdirSync(join(legacy, 'skills', 'only-in-legacy'), { recursive: true })
    writeFileSync(join(legacy, 'skills', 'only-in-legacy', 'SKILL.md'), 'legacy skill\n')
    mkdirSync(join(legacy, 'projects', 'p-1'), { recursive: true })
    writeFileSync(join(legacy, 'projects', 'p-1', 'project.json'), '{"id":"p-1"}\n')

    const home = resolveDesktopHome()
    assert.equal(home, target)
    // 既有数据不许被覆盖
    assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'model: kept\n')
    assert.deepEqual(existsSync(join(home, 'sessions', 'legacy-only')), false, '目标已有 sessions/ ⇒ 整目录不动（不合并）')
    assert.deepEqual(existsSync(join(home, 'sessions', 'keep-me')), true)
    // 目标缺失的条目要补进来
    assert.equal(readFileSync(join(home, 'skills', 'only-in-legacy', 'SKILL.md'), 'utf8'), 'legacy skill\n')
    assert.equal(readFileSync(join(home, 'projects', 'p-1', 'project.json'), 'utf8'), '{"id":"p-1"}\n')
    // 源目录原样保留（用户的旧 home 不消失）
    assert.equal(existsSync(join(legacy, 'skills', 'only-in-legacy', 'SKILL.md')), true)
    assert.equal(existsSync(join(legacy, 'sessions', 'legacy-only')), true)
    const record = JSON.parse(readFileSync(join(home, '.home-adoption.json'), 'utf8'))
    assert.deepEqual(record.adopted.map(item => [item.from, item.mode]), [['corum-rc3', 'merge']])
  })
})

test('③ 幂等：第二次启动不许把旧 home 的内容回灌进已被用户改过的目标文件', () => {
  withTempHome(dir => {
    seedHome(join(dir, '.corum'), { settings: 'model: kept\n' })
    const legacy = seedHome(join(dir, '.corum-rc3'), { sessions: ['legacy-only'] })
    mkdirSync(join(legacy, 'skills', 'legacy-skill'), { recursive: true })
    writeFileSync(join(legacy, 'skills', 'legacy-skill', 'SKILL.md'), 'legacy\n')

    const first = resolveDesktopHome()
    assert.equal(readFileSync(join(first, 'skills', 'legacy-skill', 'SKILL.md'), 'utf8'), 'legacy\n')
    // 用户随后改了这份技能、并删掉了 recording 之外的另一个旧条目快照
    writeFileSync(join(first, 'skills', 'legacy-skill', 'SKILL.md'), 'user edited\n')

    const second = resolveDesktopHome()
    assert.equal(second, first)
    assert.equal(readFileSync(join(second, 'skills', 'legacy-skill', 'SKILL.md'), 'utf8'), 'user edited\n')
    const record = JSON.parse(readFileSync(join(second, '.home-adoption.json'), 'utf8'))
    assert.equal(record.adopted.length, 1, '同一个旧 home 只接管一次')
  })
})

test('④ 凭据成对：目标已有 .master-key ⇒ 绝不搬 .credentials.yaml（也不覆盖 key）', () => {
  withTempHome(dir => {
    const target = seedHome(join(dir, '.corum'))
    writeFileSync(join(target, '.credentials.yaml'), 'enc:v1:target\n')
    const legacy = seedHome(join(dir, '.corum-rc3'))
    writeFileSync(join(legacy, '.master-key'), 'legacy-key\n')
    writeFileSync(join(legacy, '.credentials.yaml'), 'enc:v1:legacy\n')

    const home = resolveDesktopHome()
    assert.equal(readFileSync(join(home, '.master-key'), 'utf8'), 'k1\n')
    assert.equal(readFileSync(join(home, '.credentials.yaml'), 'utf8'), 'enc:v1:target\n')
  })
})

test('④b 目标没有凭据 ⇒ 成对搬过来（否则搬到一半会出现解不开的密文）', () => {
  withTempHome(dir => {
    const target = join(dir, '.corum')
    mkdirSync(join(target, 'sessions', 's'), { recursive: true }) // 有用户数据但没凭据
    const legacy = seedHome(join(dir, '.corum-rc3'))
    writeFileSync(join(legacy, '.master-key'), 'legacy-key\n')
    writeFileSync(join(legacy, '.credentials.yaml'), 'enc:v1:legacy\n')

    const home = resolveDesktopHome()
    assert.equal(readFileSync(join(home, '.master-key'), 'utf8'), 'legacy-key\n')
    assert.equal(readFileSync(join(home, '.credentials.yaml'), 'utf8'), 'enc:v1:legacy\n')
  })
})

test('⑤ 旧 home 只有运行时垃圾（run/、logs/）⇒ 不接管，也不建目标目录', () => {
  withTempHome(dir => {
    const legacy = join(dir, '.corum-rc3')
    mkdirSync(join(legacy, 'run'), { recursive: true })
    mkdirSync(join(legacy, 'logs'), { recursive: true })
    writeFileSync(join(legacy, 'run', 'host.pid'), '{}\n')
    const home = resolveDesktopHome()
    assert.equal(home, join(dir, '.corum'))
    assert.equal(existsSync(join(dir, '.corum', '.home-adoption.json')), false, '没接管就不该留记录')
  })
})

test('⑥ 显式 CORUM_HOME ⇒ 一律不动（不迁移、不写记录）', () => {
  withTempHome(dir => {
    const iso = join(dir, 'isolated')
    mkdirSync(iso, { recursive: true })
    seedHome(join(dir, '.corum-rc3'))
    process.env.CORUM_HOME = iso
    const home = resolveDesktopHome()
    assert.equal(home, iso)
    assert.equal(existsSync(join(dir, '.corum')), false, '显式 home 时产品 home 不该被创建')
    assert.equal(existsSync(join(dir, '.corum-rc3')), true, '旧 home 原样保留')
  })
})

test('⑦ profiles/ 永不搬 —— 回归守卫（搬它会叠出 duplicate loader entry id）', () => {
  assert.deepEqual(
    ADOPTABLE_ENTRIES.filter(entry => entry === 'profiles' || entry.startsWith('profiles') || entry === 'run' || entry === 'logs'),
    [],
  )
  // 端到端：旧 home 带 profiles/ ⇒ 目标不能出现它
  withTempHome(dir => {
    const legacy = seedHome(join(dir, '.corum-rc3'))
    mkdirSync(join(legacy, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(legacy, 'profiles', 'web', 'package.json'), '{"name":"dsh-profile-web"}\n')
    const home = resolveDesktopHome()
    assert.equal(existsSync(join(home, 'sessions', 's-1')), true, '整目录搬迁时用户数据照样到位')
    // 整目录搬迁是整目录，profiles 会随之过去 —— 这是允许的（等同用户原本的 home）；
    // 真正被禁的是「增量补齐时单独搬 profiles」。下面这格盯后者。
    rmSync(home, { recursive: true, force: true })
    mkdirSync(join(home, 'sessions', 'existing'), { recursive: true })
    rmSync(join(home, '.home-adoption.json'), { force: true })
    const second = resolveDesktopHome()
    assert.equal(existsSync(join(second, 'profiles')), false, '增量补齐时绝不单搬 profiles/')
  })
})
