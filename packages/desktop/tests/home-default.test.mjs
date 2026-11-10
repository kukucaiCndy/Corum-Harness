/**
 * 产品默认 home 的契约：**必须是 `~/.corum`**。
 *
 * ## 这组挡的是什么（2026-11-10 实测）
 *
 * 2026-11-03 曾把 `DEFAULT_DESKTOP_HOME` 改成 `~/.corum-rc3`，用来规避「本线写入
 * runtime-bundle 登记 ⇒ 另一条构建读共享 home 时叠出 duplicate loader entry id」。
 * 那个撞车是真的，但**换产品默认 home** 的代价是：发版包升级后读的是另一个目录、
 * 且没有任何迁移 ⇒ 用户看到近乎空的主界面（本机现场：`~/.corum` 174 个会话 / 11 GB，
 * 新包读的 `~/.corum-rc3` 只有 5.5 MB）。隔离属于**开发机**的事，由
 * `scripts/corum-instance.sh` 的 dev/verify 角色 + 显式 `CORUM_HOME` 承担。
 *
 * 所以这里钉三条：
 *  ① 默认常量等于 `~/.corum`（不是任何线专属目录）；
 *  ② 解析优先级：显式 `CORUM_HOME` > 默认；解析后 `DSH_HOME` 与 `CORUM_HOME` 同值；
 *  ③ `~/.corum-desktop`（corum-desktop 时代）仍会迁移到默认 home，且**不覆盖已有的
 *    默认 home**（那条「目标已存在就不动」的守卫是数据安全线）。
 *
 * ⚠️ 全程把 `HOME` 指向临时目录（`resolveDshHome` 用 `os.homedir()` 展开 `~`），
 * 绝不碰真实 home。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { DEFAULT_DESKTOP_HOME, resolveDesktopHome } = await import('../lib/types/host/home.js')

/** 在临时 HOME 下跑一段回调，退出时还原环境（`HOME`/`CORUM_HOME`/`DSH_HOME`）。 */
function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'corum-home-default-'))
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

test('★ 默认 home 是 ~/.corum —— 不许再变成某条线的专属目录', () => {
  assert.equal(DEFAULT_DESKTOP_HOME, '~/.corum')
  // 反例形态（2026-11-03 那次的写法）：带后缀的线专属目录。
  assert.doesNotMatch(DEFAULT_DESKTOP_HOME, /-(rc|dev|verify|main)\d*$/i)
  assert.match(DEFAULT_DESKTOP_HOME, /^~\/\.corum$/)
})

test('未设 CORUM_HOME ⇒ 落到 $HOME/.corum，并把 DSH_HOME / CORUM_HOME 写成同值', () => {
  withTempHome(dir => {
    const home = resolveDesktopHome()
    assert.equal(home, join(dir, '.corum'))
    assert.equal(process.env.DSH_HOME, home)
    assert.equal(process.env.CORUM_HOME, home)
  })
})

test('显式 CORUM_HOME 最优先（隔离靠它，不靠改默认值）', () => {
  withTempHome(dir => {
    const iso = join(dir, 'isolated-home')
    process.env.CORUM_HOME = iso
    const home = resolveDesktopHome()
    assert.equal(home, iso)
    assert.equal(process.env.DSH_HOME, iso)
  })
})

test('~/.corum-desktop 仍迁移到默认 home（旧用户升级不掉数据）', () => {
  withTempHome(dir => {
    const legacy = join(dir, '.corum-desktop')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'marker.txt'), 'from-legacy\n')
    const home = resolveDesktopHome()
    assert.equal(home, join(dir, '.corum'))
    assert.equal(readFileSync(join(home, 'marker.txt'), 'utf8'), 'from-legacy\n')
    assert.equal(existsSync(legacy), false, '迁移是 rename/copy+删，旧目录不该留下')
  })
})

test('★ 默认 home 已存在时不迁移 —— 绝不用旧目录覆盖现网数据', () => {
  withTempHome(dir => {
    const legacy = join(dir, '.corum-desktop')
    const target = join(dir, '.corum')
    mkdirSync(legacy, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(legacy, 'old.txt'), 'old\n')
    writeFileSync(join(target, 'current.txt'), 'current\n')
    const home = resolveDesktopHome()
    assert.equal(home, target)
    assert.equal(existsSync(join(home, 'current.txt')), true, '现网数据必须还在')
    assert.equal(existsSync(join(home, 'old.txt')), false, '目标已存在时不该合并/覆盖')
    assert.equal(existsSync(legacy), true, '不迁移就不许删旧目录')
  })
})
