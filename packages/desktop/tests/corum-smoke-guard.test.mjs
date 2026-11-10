import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAIN_INSTANCE_PORT,
  collectExecutorPorts,
  evaluateLaunchPort,
  evaluateSmokeGuard,
  forceKillLaunched,
  parsePort,
  processGroupTarget,
  reapLaunchedSubtree,
  reapPlan,
  shouldReap,
} from '../../../scripts/lib/smoke-guards.mjs'

/**
 * 冲烟隔离守卫与自启动清理的回归网（对应 `scripts/lib/smoke-guards.mjs`）。
 *
 * 为什么这些断言必须是**纯函数级**的：守卫的存在意义是「守卫本身不能在错误的那一侧
 * 失效」—— 放行 = 可能扰动用户主实例/测了自己；误杀 = 会清掉别人的进程。
 * 用 mock 覆盖，绝不真起进程、绝不真发信号。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 端口解析 / 执行端端口收集
// ─────────────────────────────────────────────────────────────────────────────

test('parsePort：数字与字符串都收，非法一律 null', () => {
  assert.equal(parsePort(9333), 9333)
  assert.equal(parsePort('9333'), 9333)
  assert.equal(parsePort(' 9333 '), 9333)
  assert.equal(parsePort('0'), null)
  assert.equal(parsePort('65536'), null)
  assert.equal(parsePort('abc'), null)
  assert.equal(parsePort(''), null)
  assert.equal(parsePort(undefined), null)
  assert.equal(parsePort(null), null)
  assert.equal(parsePort(9333.5), null)
})

test('collectExecutorPorts：显式 > 隐式，去重且忽略非法值', () => {
  assert.deepEqual(collectExecutorPorts({}), [])
  assert.deepEqual(collectExecutorPorts({ CORUM_DEBUG_PORT: '9222' }), [9222])
  assert.deepEqual(
    collectExecutorPorts({ CORUM_SMOKE_EXECUTOR_PORT: '9333', CORUM_DEBUG_PORT: '9333' }),
    [9333],
  )
  assert.deepEqual(
    collectExecutorPorts({ CORUM_SMOKE_EXECUTOR_PORT: '9333', CORUM_DEBUG_PORT: '9222' }),
    [9333, 9222],
  )
  assert.deepEqual(collectExecutorPorts({ CORUM_SMOKE_EXECUTOR_PORT: 'nope' }), [])
})

// ─────────────────────────────────────────────────────────────────────────────
// 隔离守卫
// ─────────────────────────────────────────────────────────────────────────────

test('守卫：9222（用户主实例）在 attach 与 launch 下都拒绝', () => {
  const attach = evaluateSmokeGuard({ port: MAIN_INSTANCE_PORT, launch: false, targetListening: false, env: {} })
  assert.equal(attach.allowed, false)
  assert.equal(attach.code, 'main-instance')
  assert.match(attach.reason, /主实例/)

  const launch = evaluateSmokeGuard({ port: 9222, launch: true, targetListening: false, env: {} })
  assert.equal(launch.allowed, false)
  assert.equal(launch.code, 'main-instance')
})

test('守卫：attach 目标 == CORUM_SMOKE_EXECUTOR_PORT ⇒ 拒绝（测自己）', () => {
  const verdict = evaluateSmokeGuard({
    port: 9333,
    launch: false,
    targetListening: true,
    env: { CORUM_SMOKE_EXECUTOR_PORT: '9333' },
  })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'executor-port')
  assert.match(verdict.reason, /执行端自己/)
})

test('守卫：attach 目标 == CORUM_DEBUG_PORT ⇒ 拒绝', () => {
  const verdict = evaluateSmokeGuard({
    port: 9333,
    launch: false,
    targetListening: true,
    env: { CORUM_DEBUG_PORT: '9333' },
  })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'executor-port')
})

test('守卫：launch 目标 == 执行端端口 ⇒ 拒绝', () => {
  const verdict = evaluateSmokeGuard({
    port: 9333,
    launch: true,
    targetListening: false,
    env: { CORUM_SMOKE_EXECUTOR_PORT: '9333' },
  })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'executor-port')
})

test('守卫：attach 目标端口**明确空闲**且无从知道执行端 ⇒ 放行（没东西可附着）', () => {
  const verdict = evaluateSmokeGuard({ port: 9333, launch: false, targetListening: false, env: {} })
  assert.equal(verdict.allowed, true)
  assert.equal(verdict.code, null)
})

test('守卫：attach 目标端口有人在听、又没有执行端端口可比 ⇒ fail-closed 拒绝', () => {
  const verdict = evaluateSmokeGuard({ port: 9333, launch: false, targetListening: true, env: {} })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'unproven-isolation')
  assert.match(verdict.reason, /CORUM_SMOKE_EXECUTOR_PORT/)
})

test('守卫：attach 端口探测结果未知（null/省略）⇒ 同样 fail-closed 拒绝', () => {
  for (const targetListening of [null, undefined]) {
    const verdict = evaluateSmokeGuard({ port: 9333, launch: false, targetListening, env: {} })
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.code, 'unproven-isolation')
  }
})

test('守卫：attach 目标有人在听、但执行端端口已知且不同 ⇒ 放行', () => {
  const verdict = evaluateSmokeGuard({
    port: 9333,
    launch: false,
    targetListening: true,
    env: { CORUM_SMOKE_EXECUTOR_PORT: '9222' },
  })
  assert.equal(verdict.allowed, true)
})

test('守卫：launch 模式即使没有执行端端口也放行（新进程 + 端口必须空闲由 evaluateLaunchPort 兜住）', () => {
  const verdict = evaluateSmokeGuard({ port: 9333, launch: true, targetListening: false, env: {} })
  assert.equal(verdict.allowed, true)
})

test('守卫：非法端口拒绝（不猜）', () => {
  for (const port of [0, -1, 70000, Number.NaN, 'abc']) {
    const verdict = evaluateSmokeGuard({ port, launch: false, targetListening: false, env: {} })
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.code, 'invalid-port')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 自启动端口判据（原有「端口被占拒绝」的纯函数版）
// ─────────────────────────────────────────────────────────────────────────────

test('launch 端口判据：占用 ⇒ 拒绝（保留原有语义）', () => {
  const verdict = evaluateLaunchPort({ port: 9333, listening: true })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'port-occupied')
  assert.match(verdict.reason, /假绿/)
})

test('launch 端口判据：占用未知 ⇒ fail-closed 拒绝', () => {
  const verdict = evaluateLaunchPort({ port: 9333, listening: null })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'port-unproven')
})

test('launch 端口判据：明确空闲 ⇒ 放行', () => {
  assert.deepEqual(evaluateLaunchPort({ port: 9333, listening: false }), { allowed: true, code: null, reason: '' })
})

// ─────────────────────────────────────────────────────────────────────────────
// opt-in 清理
// ─────────────────────────────────────────────────────────────────────────────

test('shouldReap：只有 CORUM_SMOKE_REAP=1 才启用（默认不改变人工 smoke 语义）', () => {
  assert.equal(shouldReap({}), false)
  assert.equal(shouldReap({ CORUM_SMOKE_REAP: '0' }), false)
  assert.equal(shouldReap({ CORUM_SMOKE_REAP: 'true' }), false)
  assert.equal(shouldReap({ CORUM_SMOKE_REAP: '1' }), true)
})

test('reapPlan：未启用/无 pid/自杀/系统 pid 一律不清理', () => {
  assert.equal(reapPlan({ enabled: false, launchedPid: 4242 }).reap, false)
  assert.equal(reapPlan({ enabled: true, launchedPid: null }).reap, false)
  assert.equal(reapPlan({ enabled: true, launchedPid: undefined }).reap, false)
  assert.equal(reapPlan({ enabled: true, launchedPid: 1 }).reap, false)
  assert.equal(reapPlan({ enabled: true, launchedPid: 0 }).reap, false)
  assert.equal(reapPlan({ enabled: true, launchedPid: 4242, selfPid: 4242 }).reap, false)
  assert.match(reapPlan({ enabled: true, launchedPid: 4242, selfPid: 4242 }).reason, /拒绝自杀/)
})

test('reapPlan：合法目标 → 进程组目标为 -pid（覆盖整棵子树）', () => {
  const plan = reapPlan({ enabled: true, launchedPid: 4242, selfPid: 999 })
  assert.equal(plan.reap, true)
  assert.equal(plan.pid, 4242)
  assert.equal(processGroupTarget(plan.pid), -4242)
})

test('reapLaunchedSubtree：TERM 后已退出 ⇒ 不发 KILL，且只打进程组', async () => {
  const calls = []
  const result = await reapLaunchedSubtree({
    pid: 4242,
    enabled: true,
    selfPid: 999,
    kill: (target, signal) => calls.push([target, signal]),
    probe: () => false,
    sleep: async () => {},
  })

  assert.deepEqual(calls, [[-4242, 'SIGTERM']])
  assert.deepEqual(result.signals, ['SIGTERM'])
  assert.equal(result.reaped, true)
})

test('reapLaunchedSubtree：TERM 后仍活着 ⇒ 补 SIGKILL', async () => {
  const calls = []
  const result = await reapLaunchedSubtree({
    pid: 4242,
    enabled: true,
    selfPid: 999,
    kill: (target, signal) => calls.push([target, signal]),
    probe: () => true,
    sleep: async () => {},
  })

  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']])
  assert.deepEqual(result.signals, ['SIGTERM', 'SIGKILL'])
})

test('reapLaunchedSubtree：进程早已不在（ESRCH）⇒ 不抛错', async () => {
  const err = Object.assign(new Error('no such process'), { code: 'ESRCH' })
  const result = await reapLaunchedSubtree({
    pid: 4242,
    enabled: true,
    selfPid: 999,
    kill: () => { throw err },
    probe: () => false,
    sleep: async () => {},
  })

  assert.equal(result.reaped, true)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.signals, [])
})

test('reapLaunchedSubtree：未启用 ⇒ 一次信号都不发', async () => {
  let called = 0
  const result = await reapLaunchedSubtree({
    pid: 4242,
    enabled: false,
    kill: () => { called++ },
    probe: () => true,
    sleep: async () => {},
  })

  assert.equal(called, 0)
  assert.equal(result.reaped, false)
  assert.match(result.error, /未启用/)
})

test('reapLaunchedSubtree：目标等于本进程 ⇒ 绝不发信号', async () => {
  const calls = []
  const result = await reapLaunchedSubtree({
    pid: 4242,
    enabled: true,
    selfPid: 4242,
    kill: (target, signal) => calls.push([target, signal]),
    probe: () => true,
    sleep: async () => {},
  })

  assert.deepEqual(calls, [])
  assert.equal(result.reaped, false)
})

test('forceKillLaunched：合法目标同步 SIGKILL 进程组；自杀目标不动作', () => {
  const calls = []
  const kill = (target, signal) => calls.push([target, signal])

  assert.equal(forceKillLaunched({ pid: 4242, selfPid: 999, kill }), true)
  assert.deepEqual(calls, [[-4242, 'SIGKILL']])

  calls.length = 0
  assert.equal(forceKillLaunched({ pid: 4242, selfPid: 4242, kill }), false)
  assert.deepEqual(calls, [])
  assert.equal(forceKillLaunched({ pid: null, selfPid: 999, kill }), false)
})
