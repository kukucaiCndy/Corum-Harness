/**
 * smoke-reap.spec.mjs —— `scripts/lib/smoke-reap.mjs` 的自动化测试。
 *
 * 覆盖（与 2026-11-07 的 rc3 GT4 缺陷一一对应）：
 *   1. opt-in 开关解析（reap!=1 不改变旧语义）
 *   2. `ps` 输出解析（三平台同一格式）
 *   3. 归属判定：launch pid + 组成员 + 后代；**非 owned pid 永不进信号集**
 *   4. pid 复用 / 命令行不含启动标记 ⇒ 拒绝信号
 *   5. leader 已退出但组仍在 ⇒ 逐成员可认才发组信号
 *   6. 端口上的别的实例（声明不同调试端口）⇒ 拒绝信号
 *   7. 受保护 pid（主实例/执行端）进信号集 ⇒ 整体拒绝
 *   8. 真起 launcher + 子进程，reap=1 全回收（真信号，POSIX）
 *   9. reap 关闭时**不杀**任何进程
 *  10. 启动早期失败（没有 owned pid）⇒ skip，不抛
 *  11. 信号失败（EPERM）如实记录、不抛、判 fail
 *
 * 运行：`node --test scripts/lib/smoke-reap.spec.mjs`
 * 平台：真信号用例只在 POSIX 上跑（Windows 上本模块显式返回 skip，见平台边界）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { createReaper, isReapEnabled, parseProcessTable, planOwned } from './smoke-reap.mjs'

/** 一条能证明「这个 pid 是我们起的」的启动标记。 */
const MARKER = '/repo/packages/desktop/lib/cli.js'

/** pid 是否还活着。 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等到 pid 消失（或有界超时）。 */
async function waitDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

/** 起一个真的「launcher + 子进程」树（launcher 是 detached 的组组长）。 */
async function spawnLauncherTree() {
  const code = `
    const { spawn } = require('node:child_process')
    process.title = ${JSON.stringify(`corum-smoke-reap-spec ${MARKER}`)}
    const child = spawn('/bin/sh', ['-c', 'sleep 60'], { stdio: 'ignore' })
    process.stdout.write(String(child.pid))
    setInterval(() => {}, 1000)
  `
  const launcher = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const childPid = await new Promise((resolve, reject) => {
    let buf = ''
    launcher.stdout.on('data', (d) => {
      buf += String(d)
      if (/^\d+$/.test(buf.trim())) resolve(Number(buf.trim()))
    })
    launcher.once('error', reject)
    setTimeout(() => reject(new Error('子进程 pid 未在 5s 内出现')), 5000)
  })
  return { launcherPid: launcher.pid, childPid }
}

test('opt-in：只有显式真值才开', () => {
  assert.equal(isReapEnabled({ CORUM_SMOKE_REAP: '1' }), true)
  assert.equal(isReapEnabled({ CORUM_SMOKE_REAP: 'true' }), true)
  assert.equal(isReapEnabled({ CORUM_SMOKE_REAP: 'YES' }), true)
  assert.equal(isReapEnabled({ CORUM_SMOKE_REAP: '0' }), false)
  assert.equal(isReapEnabled({ CORUM_SMOKE_REAP: '' }), false)
  assert.equal(isReapEnabled({}), false)
})

test('parseProcessTable：pid/ppid/pgid + 整行命令行', () => {
  const table = parseProcessTable([
    '    1     0     1 /sbin/launchd',
    ' 4242     1  4242 node /repo/lib/cli.js --remote-debugging-port=9345',
    ' 4243  4242  4242 /repo/Electron.app/Contents/MacOS/Electron --type=gpu-process',
    '',
  ].join('\n'))
  assert.equal(table.length, 3)
  assert.deepEqual(table[1], {
    pid: 4242,
    ppid: 1,
    pgid: 4242,
    command: 'node /repo/lib/cli.js --remote-debugging-port=9345',
  })
  assert.equal(table[2].pgid, 4242)
})

test('归属：launch pid + 组成员 + 后代；非 owned pid 不进信号集', () => {
  const table = [
    { pid: 100, ppid: 1, pgid: 100, command: `node ${MARKER} --remote-debugging-port=9345` },
    { pid: 101, ppid: 100, pgid: 100, command: '/repo/Electron /repo/packages/desktop/lib/main.js' },
    { pid: 102, ppid: 101, pgid: 100, command: '/repo/Electron Helper --type=renderer --remote-debugging-port=9345' },
    { pid: 200, ppid: 1, pgid: 199, command: '/Applications/Other.app/Contents/MacOS/Electron' },
  ]
  const plan = planOwned({ table, owned: { pid: 100, marker: MARKER, port: 9345 }, port: 9345, portHolders: [] })
  assert.deepEqual(plan.targets.sort((a, b) => a - b), [100, 101, 102])
  assert.equal(plan.groupSafe, true)
  assert.equal(plan.refusals.length, 0)
  assert.ok(!plan.targets.includes(200), '非 owned pid 不得进信号集')
})

test('pid 复用：命令行不含启动标记 ⇒ 拒绝信号', () => {
  const table = [{ pid: 100, ppid: 1, pgid: 100, command: 'node /some/other/app.js --remote-debugging-port=9345' }]
  const plan = planOwned({ table, owned: { pid: 100, marker: MARKER, port: 9345 }, port: 9345 })
  assert.deepEqual(plan.targets, [])
  assert.match(plan.refusals.join('；'), /疑似 pid 复用/)
})

test('leader 的 pgid 不是自己的 ⇒ 不发组信号，只按 pid 树精确回收', () => {
  const table = [
    { pid: 100, ppid: 1, pgid: 87536, command: `node ${MARKER} --remote-debugging-port=9345` },
    { pid: 101, ppid: 100, pgid: 87536, command: '/repo/Electron /repo/packages/desktop/lib/main.js' },
    { pid: 102, ppid: 87536, pgid: 87536, command: 'node /repo/packages/desktop/lib/bridge.js' },
  ]
  const plan = planOwned({ table, owned: { pid: 100, marker: MARKER, port: 9345 }, port: 9345 })
  assert.equal(plan.groupSafe, false, '父组不是我们建的 ⇒ 不得发 kill(-pgid)')
  assert.deepEqual(plan.targets.sort((a, b) => a - b), [100, 101])
  assert.ok(!plan.targets.includes(102), '同组的兄弟进程（非我们后代）不得被信号')
})

test('leader 已退出：组内成员可认 ⇒ 发组信号；认不出 ⇒ 拒绝', () => {
  const recognizable = [
    { pid: 101, ppid: 1, pgid: 100, command: '/repo/Electron /repo/packages/desktop/lib/main.js --remote-debugging-port=9345' },
  ]
  const ok = planOwned({ table: recognizable, owned: { pid: 100, marker: MARKER, port: 9345 }, port: 9345 })
  assert.equal(ok.groupSafe, true)
  assert.deepEqual(ok.targets, [101])

  const unrecognizable = [
    { pid: 101, ppid: 1, pgid: 100, command: '/Applications/Unrelated.app/Contents/MacOS/Electron' },
  ]
  const denied = planOwned({ table: unrecognizable, owned: { pid: 100, marker: MARKER, port: 9345 }, port: 9345 })
  assert.equal(denied.groupSafe, false)
  assert.deepEqual(denied.targets, [])
  assert.match(denied.refusals.join('；'), /无法验明归属/)
})

test('本次端口上的别的实例（声明不同调试端口）⇒ 拒绝信号', () => {
  const table = [
    { pid: 100, ppid: 1, pgid: 100, command: `node ${MARKER} --remote-debugging-port=9345` },
    { pid: 300, ppid: 1, pgid: 299, command: '/repo/Electron --remote-debugging-port=9222' },
  ]
  const plan = planOwned({ table, owned: { pid: 100, marker: MARKER, port: 9345 }, port: 9345, portHolders: [300] })
  assert.ok(!plan.targets.includes(300))
  assert.match(plan.refusals.join('；'), /别的实例/)
})

test('受保护 pid（主实例/执行端）进信号集 ⇒ 整体拒绝', () => {
  const table = [
    { pid: 100, ppid: 1, pgid: 100, command: `node ${MARKER} --remote-debugging-port=9345` },
  ]
  const plan = planOwned({
    table,
    owned: { pid: 100, marker: MARKER, port: 9345 },
    port: 9345,
    protectedPids: [100],
  })
  assert.deepEqual(plan.targets, [], '出现受保护 pid 时整体拒绝信号')
  assert.match(plan.refusals.join('；'), /受保护 pid/)
})

test('非法 leader：pid<=1 或本进程 ⇒ 拒绝', () => {
  assert.deepEqual(planOwned({ table: [], owned: { pid: 1, marker: MARKER }, port: 9345 }).targets, [])
  const self = planOwned({ table: [], owned: { pid: process.pid, marker: MARKER }, port: 9345 })
  assert.deepEqual(self.targets, [])
  assert.match(self.refusals.join('；'), /本进程/)
})

test('reap=1：真回收 launcher + 子进程（POSIX）', { skip: process.platform === 'win32' }, async () => {
  const { launcherPid, childPid } = await spawnLauncherTree()
  try {
    assert.ok(alive(launcherPid) && alive(childPid), '前置：树已经起来')
    const reaper = createReaper({
      enabled: true,
      port: 1,
      deps: { termGraceMs: 2000, killGraceMs: 1000, pollMs: 50 },
    })
    reaper.ownProcess({ pid: launcherPid, marker: MARKER, port: 1 })
    const report = await reaper.reap()
    assert.equal(report.state, 'pass', report.detail)
    assert.equal(report.signalPath, 'process-group')
    assert.ok(await waitDead(launcherPid), `launcher ${launcherPid} 应已回收`)
    assert.ok(await waitDead(childPid), `子进程 ${childPid} 应已回收`)
    assert.deepEqual(report.after.residual, [])
    // 幂等：第二次返回同一份报告，不再发信号。
    assert.equal(await reaper.reap(), report)
  } finally {
    if (alive(launcherPid)) {
      try { process.kill(-launcherPid, 'SIGKILL') } catch { /* 已退出 */ }
    }
  }
})

test('reap 未开启：不发信号（旧语义不变）', { skip: process.platform === 'win32' }, async () => {
  const { launcherPid, childPid } = await spawnLauncherTree()
  try {
    const reaper = createReaper({ enabled: false, port: 1, deps: { termGraceMs: 200, killGraceMs: 100, pollMs: 20 } })
    reaper.ownProcess({ pid: launcherPid, marker: MARKER, port: 1 })
    const report = await reaper.reap()
    assert.equal(report.state, 'skip')
    assert.match(report.detail, /未开启/)
    assert.ok(alive(launcherPid) && alive(childPid), 'reap 关闭时不得杀任何进程')
  } finally {
    try { process.kill(-launcherPid, 'SIGKILL') } catch { /* 已退出 */ }
  }
})

test('启动早期失败：没有 owned pid ⇒ skip，不抛', async () => {
  const reaper = createReaper({ enabled: true, port: 1, deps: { termGraceMs: 10, killGraceMs: 10, pollMs: 5 } })
  const report = await reaper.reap()
  assert.equal(report.state, 'skip')
  assert.match(report.detail, /没有可回收/)
})

test('信号失败（EPERM）如实记录、判 fail、不抛', async () => {
  const table = [
    { pid: 4242, ppid: 1, pgid: 4242, command: `node ${MARKER} --remote-debugging-port=9345` },
  ]
  const errors = []
  const reaper = createReaper({
    enabled: true,
    port: 9345,
    deps: {
      readTable: () => table,
      listPortHolders: () => [],
      isPortInUse: async () => false,
      sleep: async () => {},
      termGraceMs: 50,
      killGraceMs: 20,
      pollMs: 5,
      kill: (pid) => {
        const e = new Error(`kill ${pid} denied`)
        e.code = 'EPERM'
        errors.push(pid)
        throw e
      },
    },
  })
  reaper.ownProcess({ pid: 4242, marker: MARKER, port: 9345 })
  const report = await reaper.reap()
  assert.equal(report.state, 'fail')
  assert.ok(report.errors.length > 0)
  assert.equal(report.errors[0].code, 'EPERM')
  assert.deepEqual(report.after.residual.map((p) => p.pid), [4242])
  assert.equal(report.phases.length, 2, 'SIGTERM 之后应升级 SIGKILL')
  assert.ok(errors.length >= 2)
})

test('绝不碰非 owned pid：回收自己那棵树时无关进程存活', { skip: process.platform === 'win32' }, async () => {
  const unrelated = spawn('/bin/sh', ['-c', 'sleep 60'], { stdio: 'ignore' })
  const { launcherPid, childPid } = await spawnLauncherTree()
  try {
    const reaper = createReaper({
      enabled: true,
      port: 1,
      deps: { termGraceMs: 2000, killGraceMs: 1000, pollMs: 50 },
    })
    reaper.ownProcess({ pid: launcherPid, marker: MARKER, port: 1 })
    const report = await reaper.reap()
    assert.equal(report.state, 'pass', report.detail)
    assert.ok(await waitDead(childPid))
    assert.ok(alive(unrelated.pid), '无关进程必须存活')
  } finally {
    unrelated.kill('SIGKILL')
    if (alive(launcherPid)) {
      try { process.kill(-launcherPid, 'SIGKILL') } catch { /* 已退出 */ }
    }
  }
})
