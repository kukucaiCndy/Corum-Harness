#!/usr/bin/env node
/**
 * recompose-probe.mjs — 真实宿主热重组证据探针（rc3 profileContext 修复的验收件）。
 *
 * 为什么必须是**子进程**：宿主 boot 会挂上 webServer（真监听套接字）、timer、
 * HMR watcher、extension watcher —— 这些句柄让同进程的 `node --test` 永不退出。
 * 子进程跑完整 boot + 真实写盘，打印一行 JSON 证据后 `process.exit()`，
 * 父进程（`tests/profile-context-recompose.test.mjs`）只做断言。
 *
 * 判据（全部是真实行为，不看日志字符串）：
 *   1. 冷启动：webServer 绑 `127.0.0.1:<ephemeral>`（**不是** 3080），且端口真的
 *      在 LISTEN（用真 TCP 连接判定，不看 ready 日志）。
 *   2. profileContext.overlays 非空，且含官方 plugin-manager 的禁用行。
 *   3. 关键 corum 服务唯一：pluginManager 是 corum fork、webserver 条目只有一条。
 *   4. 真实设置写入 `ctx.settings.update(ns, {field})`：
 *      dsh-settings → ConfigEditor.edit → readProfilePatches → reconcileProfilePatches
 *      → recompose（**就是** rc3 丢覆盖层的路径）。
 *   5. 写后：webServer 端口不变且仍在 LISTEN（不回落 3080、不哑掉）、设置读回生效、
 *      官方 plugin-manager 仍被禁用（没有重新激活撞服务名）、IDE 壳行的 disabled 仍在。
 *
 * 用法（父进程注入隔离 env；本探针自己再把 home 写死成传入值）：
 *   CORUM_HOME=/tmp/... DSH_HOME=/tmp/... CORUM_USER_DATA_DIR=/tmp/... \
 *   CORUM_DESKTOP_MODE=ide node tests/fixtures/recompose-probe.mjs
 */
import { createConnection } from 'node:net'

const SETTINGS_NS = process.env.PROBE_SETTINGS_NS ?? 'corum-review'
const SETTINGS_FIELD = process.env.PROBE_SETTINGS_FIELD ?? 'retentionDays'
const SETTINGS_VALUE = Number(process.env.PROBE_SETTINGS_VALUE ?? 23)

/** 用真 TCP 连接判定端口在 LISTEN（连不上 = 没监听，与 ready 日志无关）。 */
function probeListen(port, host = '127.0.0.1', timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const done = (listening, detail) => {
      socket.destroy()
      resolve({ listening, detail })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true, 'connected'))
    socket.once('timeout', () => done(false, 'timeout'))
    socket.once('error', error => done(false, String(error?.code ?? error)))
  })
}

/** 读一次宿主侧的关键证据快照。 */
async function snapshot(ctx, label) {
  const webServer = ctx.get('webServer')
  const profileContext = ctx.get('profileContext')
  const pluginManager = ctx.get('pluginManager')
  const credentials = ctx.get('credentials')
  const entries = [...ctx.loader.entries()]
  const countRows = id => entries.filter(entry => entry.options.id === id).length
  const probe = webServer === undefined ? { listening: false, detail: 'no webServer' } : await probeListen(webServer.port, webServer.host)
  return {
    label,
    webServer: webServer === undefined ? null : { host: webServer.host, port: webServer.port },
    listening: probe,
    pluginManager: pluginManager?.constructor?.name ?? null,
    credentials: credentials?.constructor?.name ?? null,
    overlayRows: profileContext?.overlays?.length ?? -1,
    overlaysIncludePluginManagerDisabled: (profileContext?.overlays ?? []).some(row => row.id === 'plugin-manager' && row.disabled === true),
    // `webserver` 的 config 覆盖**不在** overlay 层（2026-11-03 起与 insert 行一起
    // 搬进运行期 bundle：bundle 在 profile patch **之前**，用户设置才是最后写入者）。
    // overlay 只留 `disabled` 行，故判据改为：overlay 里不得有 config 行 + 生效的
    // webserver 行仍被 pin 成 port 0（真正要保的东西）。
    overlayConfigRowIds: (profileContext?.overlays ?? []).filter(row => row.config !== undefined).map(row => row.id),
    webserverRowPinnedToEphemeral: [...ctx.loader.entries()].some(entry => entry.options.id === 'webserver' && entry.options.config?.port === 0),
    rows: {
      webserver: countRows('webserver'),
      pluginManager: countRows('plugin-manager'),
      uiLayout: countRows('ui-layout'),
      uiSidebar: countRows('ui-sidebar'),
      corumIdeUi: countRows('corum-ide-ui'),
    },
    settings: readSettings(ctx),
  }
}

function readSettings(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined) return null
  const descriptor = settings.describe().find(row => row.ns === SETTINGS_NS)
  return descriptor === undefined ? null : { ns: descriptor.ns, revision: descriptor.revision, value: descriptor.value }
}

/** 顶层 errno/异常兜底：打印 JSON 后退出（父进程据此判失败并带上完整堆栈）。 */
function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

process.on('uncaughtException', (error) => {
  emit({ ok: false, stage: 'uncaughtException', error: String(error?.stack ?? error) })
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  emit({ ok: false, stage: 'unhandledRejection', error: String(reason?.stack ?? reason) })
  process.exit(1)
})

const hardStop = setTimeout(() => {
  emit({ ok: false, stage: 'timeout', error: 'probe exceeded 240s' })
  process.exit(1)
}, 240_000)
hardStop.unref()

try {
  const { bootDesktop } = await import('../../lib/types/host/boot.js')
  const ctx = await bootDesktop()
  // A/B 对照（诊断用）：`PROBE_OVERLAYS=empty` 把 profileContext.overlays 清空，
  // 复现 rc3 修复前的形态（热重组丢覆盖层）。默认不动。
  const profileContextObject = ctx.get('profileContext')
  if (process.env.PROBE_OVERLAYS === 'empty' && profileContextObject !== undefined) {
    profileContextObject.overlays = []
  }
  const before = await snapshot(ctx, 'cold-boot')
  if (before.webServer === null) throw new Error('webServer 服务不存在')
  if (before.webServer.port === 3080) throw new Error('webServer 端口回落到基座默认 3080')
  if (!before.listening.listening) throw new Error(`冷启动后端口不监听：${before.listening.detail}`)
  if (before.pluginManager !== 'CorumPluginManager') throw new Error(`pluginManager 不是 corum fork：${before.pluginManager}`)

  // ── 真实写盘：settings.update → ConfigEditor.edit → reconcileProfilePatches ──
  // 目标字段必须是 volatile（settings 表单字段），否则官方会拒绝「不是 volatile」。
  await ctx.settings.update(SETTINGS_NS, { [SETTINGS_FIELD]: SETTINGS_VALUE })

  // ── 关键回归：写**被桌面覆盖层钉过 config** 的 namespace ──
  //
  // 2026-11-03 实测缺陷：这些 ns 的 config 覆盖行留在 `profileContext.overlays`
  // （= readProfilePatches 的最后一层）⇒ 用户写进 profile patch 的值永远被它压过 ⇒
  // 官方 config-editor 写盘守卫拒成
  //   `Configuration for "…" is overridden by a home patch or command-line overlay`
  // 用户在设置里「选供应商 / 选模型 / 选权限预设」全部失败。修法 = config 行搬进
  // 运行期 bundle（profile patch 之前）。这里对每条被钉过的 ns 真写一次，任何一条
  // 被拒就让探针 ok=false（父进程据此红）。
  const OVERRIDDEN_NS_WRITES = [
    { ns: 'agent-default-model', field: 'provider', value: 'local' },
    { ns: 'permission', field: 'defaultPreset', value: 'workspace-write' },
  ]
  const overriddenWrites = []
  for (const { ns, field, value } of OVERRIDDEN_NS_WRITES) {
    try {
      await ctx.settings.update(ns, { [field]: value })
      const descriptor = ctx.get('settings')?.describe().find(row => row.ns === ns)
      overriddenWrites.push({ ns, field, ok: true, readBack: descriptor?.value?.[field] ?? null })
    } catch (error) {
      overriddenWrites.push({ ns, field, ok: false, error: String(error?.message ?? error) })
    }
  }

  const after = await snapshot(ctx, 'after-settings-update')
  // 任何一条「被钉过 config 的 ns」写失败 ⇒ 让父进程红（带具体错误）。
  const rejected = overriddenWrites.filter(row => row.ok !== true)
  if (rejected.length > 0) {
    emit({
      ok: false,
      stage: 'overridden-ns-write',
      error: rejected.map(row => `${row.ns}.${row.field}: ${row.error}`).join('; '),
      overriddenWrites,
    })
    process.exit(1)
  }
  emit({
    ok: true,
    settingsNs: SETTINGS_NS,
    settingsField: SETTINGS_FIELD,
    settingsValue: SETTINGS_VALUE,
    overriddenWrites,
    before,
    after,
  })
  process.exit(0)
} catch (error) {
  emit({ ok: false, stage: 'probe', error: String(error?.stack ?? error) })
  process.exit(1)
}
