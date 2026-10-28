import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 真宿主热重组验收（rc3 profileContext/recompose 缺陷的端到端回归）。
 *
 * 判据全部来自**真实宿主进程**（子进程 boot 完整 web profile + 真写盘），不是日志字符串：
 *   1. 冷启动 webServer 是真 `127.0.0.1:<ephemeral>` 且端口真在 LISTEN（真 TCP connect）；
 *   2. `profileContext.overlays` 非空、含官方 plugin-manager 的禁用行、含 desktop 的
 *      webserver 行；
 *   3. 关键服务唯一：pluginManager 是 corum fork（官方行若复活会 `has been registered`）、
 *      webserver 条目只有一条；
 *   4. `settings.update()` 走通官方 ConfigEditor → readProfilePatches →
 *      reconcileProfilePatches → recompose 全链（就是 rc3 丢覆盖层/报
 *      `TypeError … reading 'await'` 的那条路径）；
 *   5. 写后 webServer 端口**不变**且仍在 LISTEN（不回落 3080、不哑掉）、设置读回生效、
 *      服务与行数不变；
 *   6. 重启后（persist）四个 corum settings ns 的值仍在 —— 覆盖行真的被持久化并生效。
 *
 * 为什么要 spawn：宿主 boot 会挂真监听套接字 + HMR/extension watcher，同进程跑会让
 * `node --test` 永不退出；探针自己 `process.exit()`，父进程只做断言。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const PROBE = join(HERE, 'fixtures', 'recompose-probe.mjs')

/** 每个用例自带的临时根（隔离 home / user-data）。 */
function isolate() {
  const root = mkdtempSync(join(tmpdir(), 'corum-recompose-'))
  return {
    root,
    home: join(root, 'home'),
    userData: join(root, 'user-data'),
    env: (extra = {}) => ({
      ...process.env,
      CORUM_HOME: join(root, 'home'),
      DSH_HOME: join(root, 'home'),
      CORUM_USER_DATA_DIR: join(root, 'user-data'),
      CORUM_DESKTOP_MODE: 'ide',
      DSH_TELEMETRY_DISABLED: '1',
      ...extra,
    }),
  }
}

/** 跑一次探针，返回它打印的 JSON（失败时把完整堆栈抛出来）。 */
function runProbe(scope, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PROBE], {
      cwd: REPO,
      env: scope.env(extraEnv),
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const line = String(stdout).trim().split('\n').filter(Boolean).at(-1)
      let parsed
      try {
        parsed = JSON.parse(line ?? 'null')
      } catch {
        reject(new Error(`探针输出不是 JSON：${String(stdout).slice(-2000)}\n--- stderr ---\n${String(stderr).slice(-4000)}`))
        return
      }
      if (parsed === null) {
        reject(new Error(`探针没有输出：${error?.message}\n--- stderr ---\n${String(stderr).slice(-4000)}`))
        return
      }
      resolve({ parsed, stderr })
    })
  })
}

test('真宿主：settings.update 经 ConfigEditor/reconcile 后覆盖层与服务保持完整', { timeout: 320_000 }, async (t) => {
  const scope = isolate()
  t.after(() => rmSync(scope.root, { recursive: true, force: true }))
  const { parsed, stderr } = await runProbe(scope)
  assert.equal(parsed.ok, true, `探针失败（stage=${parsed.stage}）：\n${parsed.error}`)

  const { before, after } = parsed

  // 1) 冷启动：真监听 + ephemeral 端口（绝不 3080）
  assert.equal(before.webServer.host, '127.0.0.1')
  assert.ok(before.webServer.port > 0, 'webServer 必须有真实端口')
  assert.notEqual(before.webServer.port, 3080, 'webServer 不得回落到基座默认 3080')
  assert.equal(before.listening.listening, true, `冷启动端口必须真在 LISTEN：${before.listening.detail}`)

  // 2) profileContext.overlays 完整（rc3 根因判据）
  assert.ok(before.overlayRows > 0, 'profileContext.overlays 不得为空')
  assert.equal(before.overlaysIncludePluginManagerDisabled, true)
  assert.equal(before.overlaysIncludeDesktopWebserver, true)

  // 3) 关键服务唯一、行的数量正确
  assert.equal(before.pluginManager, 'CorumPluginManager', 'pluginManager 必须是 corum 实现（官方行复活会重复注册）')
  assert.equal(before.credentials, 'LocalCredentialProvider', 'credentials 必须是 corum 加密 fork')
  assert.equal(before.rows.webserver, 1)
  assert.equal(before.rows.pluginManager, 1)

  // 4) 写盘成功（走通官方守卫）：值读回
  assert.equal(before.settings.revision, 0)
  assert.notEqual(after.settings.revision, 0, '设置写入后 revision 必须变化')
  assert.equal(after.settings.value[parsed.settingsField], parsed.settingsValue)

  // 5) 写后：同一个 ephemeral 端口仍在 LISTEN，服务不重复，覆盖层不丢
  assert.deepEqual(after.webServer, before.webServer, '热重组不得改变 webServer 的监听地址（回落 3080 即为失败）')
  assert.equal(after.listening.listening, true, `热重组后端口必须仍在 LISTEN：${after.listening.detail}`)
  assert.equal(after.pluginManager, before.pluginManager)
  assert.equal(after.credentials, before.credentials)
  assert.equal(after.rows.webserver, 1)
  assert.equal(after.rows.pluginManager, 1)
  assert.equal(after.overlayRows, before.overlayRows)

  // 写盘确实落到 profile patch（用户层），不是内存假象
  const profilePatch = readFileSync(join(scope.root, 'home', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(profilePatch, new RegExp(`${parsed.settingsNs}[\\s\\S]{0,200}${parsed.settingsField}: ${parsed.settingsValue}`))

  // 重组的运行期 bundle 出现在 profile manifest 里（行定义在 profile patch 之前建行，
  // 否则设置写会被官方守卫拒成 overridden by overlay —— 见 runtime-bundle.ts）
  const manifest = JSON.parse(readFileSync(join(scope.root, 'home', 'profiles', 'web', 'package.json'), 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes('corum-desktop-runtime'))

  // 宿主侧不该出现服务重复注册/端口回落的错误
  assert.doesNotMatch(stderr, /has been registered/)
  assert.doesNotMatch(stderr, /EADDRINUSE/)
})
