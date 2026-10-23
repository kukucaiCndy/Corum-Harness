import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCAL_STATE_FILENAME,
  LAST_TMPDIR_VERSION,
  planUserDataDir,
  migrateLocalState,
  prepareUserDataDir,
  shouldMigrateLocalState,
  userDataLeaf,
  isUnder,
} from '../lib/types/electron/user-data-dir.js'

/**
 * user-data-dir 落点与 Local State 迁移的回归网。
 *
 * 这组断言保护的是一个**已造成真实事故**的边界（2026-10-23：清 C 盘 ⇒
 * userData 被删 ⇒ safeStorage 主密钥重生成 ⇒ 全部凭证失效 ⇒ host exit 1）。
 * 因此每条断言都对着「再犯一次会是怎么错的」来写，而不是对着实现细节。
 */

/** 建一个临时沙箱（appData / temp 两个根，模拟真实布局）。 */
function sandbox(run) {
  const root = mkdtempSync(join(tmpdir(), 'corum-udd-'))
  const appData = join(root, 'appdata')
  const temp = join(root, 'temp')
  mkdirSync(appData, { recursive: true })
  mkdirSync(temp, { recursive: true })
  try {
    return run({ root, appData, temp })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('落点必须在持久目录，不能落在临时目录（事故根因）', () => {
  sandbox(({ appData, temp }) => {
    const plan = planUserDataDir({ env: {}, appData, tempRoot: temp })
    assert.equal(plan.dir, join(appData, 'corum-desktop-ud-minimal-noport'))
    // 反证：落点绝不在 temp 之下 —— 这是本次修复的唯一硬判据。
    assert.equal(isUnder(plan.dir, temp), false)
    assert.equal(isUnder(plan.dir, appData), true)
  })
})

test('叶子名沿用旧命名，使「按 mode + 端口隔离」语义不变', () => {
  assert.equal(userDataLeaf({}), 'corum-desktop-ud-minimal-noport')
  assert.equal(userDataLeaf({ CORUM_DESKTOP_MODE: 'ide', CORUM_DEBUG_PORT: '9222' }), 'corum-desktop-ud-ide-9222')
  // 空字符串按未设置处理：否则 `CORUM_DEBUG_PORT=` 会得到带尾横线的怪名字，
  // 且与 noport 分成两个锁 —— 同一个「未设端口」的实例被拆成两份 profile。
  assert.equal(userDataLeaf({ CORUM_DEBUG_PORT: '' }), 'corum-desktop-ud-minimal-noport')
  assert.equal(userDataLeaf({ CORUM_DESKTOP_MODE: '' }), 'corum-desktop-ud-minimal-noport')
})

test('不同 mode / 端口各自拿到独立目录（多实例隔离不退化）', () => {
  sandbox(({ appData, temp }) => {
    const a = planUserDataDir({ env: {}, appData, tempRoot: temp })
    const b = planUserDataDir({ env: { CORUM_DESKTOP_MODE: 'ide', CORUM_DEBUG_PORT: '9333' }, appData, tempRoot: temp })
    const c = planUserDataDir({ env: { CORUM_DEBUG_PORT: '9222' }, appData, tempRoot: temp })
    assert.equal(new Set([a.dir, b.dir, c.dir]).size, 3)
  })
})

test('显式 CORUM_USER_DATA_DIR 优先，且不做迁移（dev/验证实例自己管落点）', () => {
  sandbox(({ root, appData, temp }) => {
    const explicit = join(root, 'explicit-ud')
    // 旧临时目录**有** Local State：若实现漏了 explicit 判据，会把它搬进显式落点。
    mkdirSync(join(temp, 'corum-desktop-ud-minimal-noport'), { recursive: true })
    writeFileSync(join(temp, 'corum-desktop-ud-minimal-noport', LOCAL_STATE_FILENAME), 'legacy-key')
    const plan = planUserDataDir({
      env: { CORUM_USER_DATA_DIR: explicit },
      appData,
      tempRoot: temp,
      platform: 'win32',
    })
    assert.equal(plan.dir, explicit)
    assert.equal(plan.explicit, true)
    assert.equal(plan.legacyDir, undefined)
    const result = migrateLocalState(plan)
    assert.equal(result.migrated, false)
    assert.equal(existsSync(join(explicit, LOCAL_STATE_FILENAME)), false)
    // 目录仍被建出来（调用后「目标存在」是单点保证）。
    assert.equal(existsSync(explicit), true)
  })
})

test('首次在新根启动时迁移旧 Local State —— 既有主密钥因此仍然可解', () => {
  sandbox(({ appData, temp }) => {
    mkdirSync(join(temp, 'corum-desktop-ud-minimal-noport'), { recursive: true })
    writeFileSync(join(temp, 'corum-desktop-ud-minimal-noport', LOCAL_STATE_FILENAME), 'legacy-oscrypt-key')
    // 迁移用例必须显式声明「win32 + 0.6.0 之前」，否则会被门槛正确拦下（见文末门槛组）。
    const plan = planUserDataDir({ env: {}, appData, tempRoot: temp, platform: 'win32' })
    assert.equal(plan.legacyDir, join(temp, 'corum-desktop-ud-minimal-noport'))
    const result = migrateLocalState(plan)
    assert.equal(result.migrated, true)
    // 关键：搬的是**原字节**，不是重新生成一把新密钥。
    assert.equal(readFileSync(join(plan.dir, LOCAL_STATE_FILENAME), 'utf8'), 'legacy-oscrypt-key')
  })
})

test('迁移是幂等的：新根已自带 Local State 时绝不用旧值覆盖', () => {
  sandbox(({ appData, temp }) => {
    mkdirSync(join(temp, 'corum-desktop-ud-minimal-noport'), { recursive: true })
    writeFileSync(join(temp, 'corum-desktop-ud-minimal-noport', LOCAL_STATE_FILENAME), 'legacy-key')
    const plan = planUserDataDir({ env: {}, appData, tempRoot: temp, platform: 'win32' })
    mkdirSync(plan.dir, { recursive: true })
    writeFileSync(join(plan.dir, LOCAL_STATE_FILENAME), 'current-key')
    const result = migrateLocalState(plan)
    assert.equal(result.migrated, false)
    // 覆盖会把**当前可用的**密钥换成旧的 ⇒ 又是一次凭证全失效。
    assert.equal(readFileSync(join(plan.dir, LOCAL_STATE_FILENAME), 'utf8'), 'current-key')
  })
})

test('旧目录不存在 / 没有 Local State 时不迁移，但仍建出目标目录', () => {
  sandbox(({ appData, temp }) => {
    const plan = planUserDataDir({ env: {}, appData, tempRoot: temp })
    assert.equal(plan.legacyDir, undefined)
    const result = migrateLocalState(plan)
    assert.equal(result.migrated, false)
    assert.equal(existsSync(plan.dir), true)
  })
})

test('旧目录被清理工具删掉后（Local State 已失）不报错、不阻塞启动', () => {
  sandbox(({ appData, temp }) => {
    // 模拟：清理工具把 temp 下的 userData 整个删了，只剩空目录壳。
    mkdirSync(join(temp, 'corum-desktop-ud-minimal-noport'), { recursive: true })
    const plan = planUserDataDir({ env: {}, appData, tempRoot: temp })
    assert.equal(plan.legacyDir, undefined)
    assert.doesNotThrow(() => migrateLocalState(plan))
  })
})

test('isUnder 不把同前缀的兄弟目录误判为子目录', () => {
  assert.equal(isUnder('/a/b/c', '/a/b'), true)
  assert.equal(isUnder('/a/b', '/a/b'), true)
  // `/a/bc` 不在 `/a/b` 之下 —— 纯 startsWith 会判错。
  assert.equal(isUnder('/a/bc', '/a/b'), false)
})

test('持久目录不可写时退化到备用落点，绝不让启动失败（不拿新失败换旧失败）', () => {
  sandbox(({ root, temp }) => {
    // 用一个「在文件路径下面建目录」的路径，必然 EPERM/ENOTDIR —— 跨平台稳定的不可写判据。
    // （不用 chmod 不可写目录：Windows 与 root 下 chmod 不生效，那会让本用例假绿。）
    const blocker = join(root, 'not-a-dir')
    writeFileSync(blocker, 'x')
    const appData = join(blocker, 'appdata')
    const plan = planUserDataDir({ env: {}, appData, tempRoot: temp })
    assert.equal(plan.dir, join(appData, 'corum-desktop-ud-minimal-noport'))
    // 主落点确实不可用（前提成立，否则本用例测的是别的东西）。
    assert.throws(() => mkdirSync(plan.dir, { recursive: true }))
    const ready = prepareUserDataDir(plan)
    assert.equal(ready.degraded, true)
    assert.equal(ready.dir, join(temp, 'corum-desktop-ud-minimal-noport'))
    assert.equal(existsSync(ready.dir), true)
    // 退化原因必须写清楚「这里仍是临时目录、会被清理工具删」，否则等于静默降级。
    assert.match(ready.reason, /临时目录/)
  })
})

test('正常路径不退化（degraded=false，落点仍是持久目录）', () => {
  sandbox(({ appData, temp }) => {
    const ready = prepareUserDataDir(planUserDataDir({ env: {}, appData, tempRoot: temp }))
    assert.equal(ready.degraded, false)
    assert.equal(isUnder(ready.dir, appData), true)
    assert.equal(isUnder(ready.dir, temp), false)
  })
})

test('显式落点不可写时【不】退化到别处（调用方选定的落点不能被悄悄替换）', () => {
  sandbox(({ root }) => {
    const blocker = join(root, 'file-blocker')
    writeFileSync(blocker, 'x')
    const explicit = join(blocker, 'ud')
    const plan = planUserDataDir({ env: { CORUM_USER_DATA_DIR: explicit }, appData: root, tempRoot: root })
    // 显式落点的备用就是它自己 ⇒ 建不出来时如实抛错，而不是搬到别处
    //（搬走会让它下次找不到自己的 profile，症状比失败更难查）。
    assert.throws(() => prepareUserDataDir(plan), /user-data-dir 不可用/)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 迁移的**平台门槛 + 版本门槛**（用户 2026-10-23 定）：
 *   · 只有 Windows 需要（darwin 用钥匙串、linux 用 libsecret，密钥不在 Local State）；
 *   · 只有 0.6.0 **之前**需要，之后不跑；
 *   · 1.0.0 之后整块删除（见 MIGRATION_REMOVE_AT）。
 *
 * 这组断言的用途不是「实现对不对」，而是**防止门槛被无意放宽**：一旦哪天有人把
 * `shouldMigrateLocalState` 简化成恒 true，macOS/Linux 上就会开始无意义地搬
 * `Local State`（搬不到密钥、还可能把别的东西弄脏），而测试必须当场拦下。
 * ──────────────────────────────────────────────────────────────────────────── */

test('平台门槛：只有 win32 需要迁移（darwin/linux 密钥不在 Local State）', () => {
  assert.equal(shouldMigrateLocalState('win32'), true)
  assert.equal(shouldMigrateLocalState('darwin'), false)
  assert.equal(shouldMigrateLocalState('linux'), false)
  // 未知平台同样不迁移（fail-safe：不认识的平台不碰密钥文件）。
  assert.equal(shouldMigrateLocalState('freebsd'), false)
})

test('⚠️ 不得按「当前运行版本」拦截迁移（否则升级用户拿不到迁移、修复失效）', () => {
  // 这条锁的是一个**已犯过的方向性错误**：曾写成「运行版本 ≤ 0.6.0 才迁移」。
  // 迁移代码跑在**修复版自己**的进程里（如 0.7.0）；0.6.0 老用户升级后
  // readAppVersion() 读到 0.7.0 ⇒ 按旧写法判定「不迁移」⇒ 主密钥换新 ⇒ 凭证全失效。
  // 故 shouldMigrateLocalState 只认平台、不认版本。
  assert.equal(shouldMigrateLocalState.length, 1, '签名只接受平台，不应再收版本参数')
  // 同一台 Windows 机器上，无论后续版本号怎么涨，探测旧目录这件事都必须继续尝试。
  const affected = LAST_TMPDIR_VERSION
  assert.equal(typeof affected, 'string')
  sandbox(({ appData, temp }) => {
    const leaf = 'corum-desktop-ud-minimal-noport'
    mkdirSync(join(temp, leaf), { recursive: true })
    writeFileSync(join(temp, leaf, LOCAL_STATE_FILENAME), 'old-key')
    // 落点计划不接收 version 字段：给不给都不影响探测结果。
    const plan = planUserDataDir({ env: {}, appData, tempRoot: temp, platform: 'win32' })
    assert.notEqual(plan.legacyDir, undefined, 'win32 必须探测旧目录（与运行版本无关）')
    const ready = prepareUserDataDir(plan)
    assert.equal(ready.migrated, true, '升级后的首次启动必须完成迁移')
    assert.equal(readFileSync(join(ready.dir, LOCAL_STATE_FILENAME), 'utf8'), 'old-key')
  })
})

test('「只运行一次」由幂等保证：第二次启动不再复制（无需版本号参与）', () => {
  sandbox(({ appData, temp }) => {
    const leaf = 'corum-desktop-ud-minimal-noport'
    mkdirSync(join(temp, leaf), { recursive: true })
    writeFileSync(join(temp, leaf, LOCAL_STATE_FILENAME), 'first-key')
    // 首次：迁移发生
    const first = prepareUserDataDir(planUserDataDir({ env: {}, appData, tempRoot: temp, platform: 'win32' }))
    assert.equal(first.migrated, true)
    // 旧目录换内容，模拟「干净工具没删、但内容不该再被采用」
    writeFileSync(join(temp, leaf, LOCAL_STATE_FILENAME), 'should-not-be-used')
    // 第二次：新落点已自带 Local State ⇒ 不再复制
    const second = prepareUserDataDir(planUserDataDir({ env: {}, appData, tempRoot: temp, platform: 'win32' }))
    assert.equal(second.migrated, false)
    assert.equal(readFileSync(join(second.dir, LOCAL_STATE_FILENAME), 'utf8'), 'first-key')
  })
})

test('落点变更三平台统一（只有「迁移」按平台分），迁移门槛不改变落点', () => {
  sandbox(({ appData, temp }) => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const plan = planUserDataDir({ env: {}, appData, tempRoot: temp, platform })
      // 无论平台，落点都必须是持久目录、都不得是临时目录。
      assert.equal(plan.dir, join(appData, 'corum-desktop-ud-minimal-noport'))
      assert.equal(isUnder(plan.dir, temp), false)
    }
  })
})

test('非 win32 平台即使有旧目录也不复制（Local State 里没有密钥）', () => {
  sandbox(({ appData, temp }) => {
    mkdirSync(join(temp, 'corum-desktop-ud-minimal-noport'), { recursive: true })
    writeFileSync(join(temp, 'corum-desktop-ud-minimal-noport', LOCAL_STATE_FILENAME), 'not-a-key')
    const plan = planUserDataDir({ env: {}, appData, tempRoot: temp, platform: 'darwin' })
    assert.equal(plan.legacyDir, undefined)
    const ready = prepareUserDataDir(plan)
    assert.equal(ready.migrated, false)
    assert.equal(existsSync(join(ready.dir, LOCAL_STATE_FILENAME)), false)
  })
})

test('darwin 不迁移（钥匙串机制，Local State 里没有密钥）', () => {
  sandbox(({ appData, temp }) => {
    mkdirSync(join(temp, 'corum-desktop-ud-minimal-noport'), { recursive: true })
    writeFileSync(join(temp, 'corum-desktop-ud-minimal-noport', LOCAL_STATE_FILENAME), 'mac-has-no-key-here')
    const plan = planUserDataDir({ env: {}, appData, tempRoot: temp, platform: 'darwin' })
    assert.equal(plan.legacyDir, undefined)
    const ready = prepareUserDataDir(plan)
    assert.equal(ready.migrated, false)
    assert.equal(existsSync(join(ready.dir, LOCAL_STATE_FILENAME)), false)
  })
})
