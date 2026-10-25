/**
 * 池的单测（含**真进程**假 MCP server）。
 *
 * 覆盖用户拍板的每一条硬要求：
 *   · 一个服务名**只有一个进程**，多 Agent 共用（pid 相同）；
 *   · **独占**：并发调用被串行化（服务端 `maxConcurrent` 必须为 1）；
 *   · 忙时 **FIFO 排队 + 超时**，超时错误必须点名**当前持有者**；
 *   · 引用计数：最后一份授权撤销 ⇒ 进程停掉；仍有授权 ⇒ 进程不变；
 *   · 崩溃 ⇒ 下一次调用自动重连（换 pid）；
 *   · 定义（args/env）变了 ⇒ 换进程；定义没变 ⇒ **pid 不变**（用户验收判据）。
 *
 * 为什么用真子进程而不是 mock：`pid`、进程存活、协议握手、崩溃重连这些都只在真进程边界上成立。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpLeaseTimeoutError, McpPool, describeOwner, leaseTimeoutsFromEnv } from '../src/pool.ts'
import { publicToolName } from '../src/tool-naming.ts'
import type { McpServerConfig } from '../src/types.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs')

/** 造一个「注册表里只有 fake 一个服务」的池（定义可被测试改写）。 */
function makePool(overrides: { leaseTimeoutMs?: number; leaseTtlMs?: number; stopGraceMs?: number } = {}): {
  pool: McpPool
  definitions: Map<string, McpServerConfig>
} {
  const definitions = new Map<string, McpServerConfig>([
    ['fake', { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE] }],
  ])
  const pool = new McpPool({
    resolve: name => definitions.get(name),
    log: () => {},
    stopGraceMs: stopGrace,
    ...overrides,
  })
  return { pool, definitions }
}

/** 夹具把结果包在 content[0].text 的 JSON 里。 */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: readonly { text?: string }[] }).content ?? []
  const text = content[0]?.text ?? '{}'
  return JSON.parse(text) as Record<string, unknown>
}

/** 停止宽限期（测试里调短，避免拖慢套件）。 */
const stopGrace = 150

const ownerA = { agentId: 'agent-A' }
const ownerB = { agentId: 'agent-B' }

/** 等一小会（异步收尾用）。 */
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** pid 是否还活着。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 轮询等待进程**真的**退出（或复活）。
 *
 * 为什么需要它（2026-10-26 CI 实测）：原先的写法是「`await tick(250)` 之后
 * 断言 `alive(pid) === false`」——把「进程死掉要多久」当成固定值。本地
 * 连跑 3 次都是 19/19 绿，但 GitHub 的 macos runner 在负载下收尸更慢，
 * 250ms 到点时进程还活着 ⇒
 *   `pool.spec.ts:212  expected true to be false`（= 期望已死、实际还活）
 * 这是**时序脆弱**，不是产品缺陷（该包不在改动范围内）。
 *
 * 轮询把「等一个固定时长」换成「等到条件成立，最多等 timeoutMs」：
 * 快机器上立刻返回（不拖慢），慢机器上不会假红。
 * @param predicate 条件（每 25ms 求值一次）。
 * @param timeoutMs 上限；超过则返回最后一次求值结果（由调用方断言，保持原有失败语义）。
 * @returns 条件是否成立。
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return predicate()
    await tick(25)
  }
}

describe('MCP 池：一个服务名一个进程，多 Agent 共用（2026-09-27 用户模型）', () => {
  it('★ 两个 Agent 共用同一个进程（pid 相同），且连接只有一份', async () => {
    const { pool } = makePool()
    const release = pool.retain('fake')
    try {
      const tools = await pool.listTools('fake')
      expect(tools.map(tool => tool.name)).toContain('echo')
      const first = payloadOf(await pool.callTool('fake', 'echo', { text: 'a' }, ownerA))
      const second = payloadOf(await pool.callTool('fake', 'echo', { text: 'b' }, ownerB))
      expect(first.pid).toBe(second.pid)
      const snapshots = pool.snapshot()
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.pid).toBe(first.pid)
      expect(snapshots[0]?.toolCount).toBe(tools.length)
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ 独占：并发调用被串行化（服务端 maxConcurrent 必须为 1）', async () => {
    const { pool } = makePool()
    const release = pool.retain('fake')
    try {
      await pool.listTools('fake')
      const [slow] = await Promise.all([
        pool.callTool('fake', 'slow', { delayMs: 150 }, ownerA),
        pool.callTool('fake', 'echo', { text: 'after' }, ownerB),
      ])
      const slowPayload = payloadOf(slow)
      const stats = payloadOf(await pool.callTool('fake', 'stats', {}, ownerA))
      expect(stats.maxConcurrent).toBe(1)
      expect(slowPayload.maxConcurrent).toBe(1)
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ 忙时排队 + 超时：错误必须点名当前持有者', async () => {
    const { pool } = makePool({ leaseTimeoutMs: 60 })
    const release = pool.retain('fake')
    try {
      await pool.listTools('fake')
      const running = pool.callTool('fake', 'slow', { delayMs: 400 }, ownerA)
      await expect(pool.callTool('fake', 'echo', { text: 'x' }, ownerB)).rejects.toBeInstanceOf(McpLeaseTimeoutError)
      await expect(pool.callTool('fake', 'echo', { text: 'x' }, ownerB)).rejects.toThrow(/agent-A/)
      await running
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ 排队中被中止（turn 结束/用户打断）⇒ 立刻让出排队位，且不占租约', async () => {
    const { pool } = makePool()
    const release = pool.retain('fake')
    try {
      await pool.listTools('fake')
      const running = pool.callTool('fake', 'slow', { delayMs: 250 }, ownerA)
      const controller = new AbortController()
      const queued = pool.callTool('fake', 'echo', { text: 'x' }, ownerB, { signal: controller.signal })
      await tick(30)
      expect(pool.snapshot()[0]?.queueLength).toBe(1)
      controller.abort(new Error('turn ended'))
      await expect(queued).rejects.toThrow(/aborted by its caller/)
      // 排队位立刻让出（不是等超时才清）
      expect(pool.snapshot()[0]?.queueLength).toBe(0)
      await running
      expect(pool.snapshot()[0]?.holder).toBeUndefined()
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ TTL 兜底：持有者崩死（永不释放）⇒ 租约被回收并点名原持有者', async () => {
    const warns: string[] = []
    const definitions = new Map<string, McpServerConfig>([
      ['fake', { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE] }],
    ])
    const pool = new McpPool({
      resolve: name => definitions.get(name),
      leaseTimeoutMs: 5_000,
      leaseTtlMs: 60,
      log: (level, message) => { if (level === 'warn') warns.push(message) },
    })
    const release = pool.retain('fake')
    try {
      // 模拟"某个 Agent 拿了租约就再也没还"（崩死/被 kill）
      const deadLease = await pool.acquire('fake', { agentId: 'dead-agent', sessionId: 's-dead' })
      expect(pool.snapshot()[0]?.holder?.agentId).toBe('dead-agent')
      await tick(90)
      // 下一个调用者能拿到（TTL 已回收），warn 点名原持有者
      const liveLease = await pool.acquire('fake', ownerB)
      expect(pool.snapshot()[0]?.holder?.agentId).toBe('agent-B')
      expect(warns.join(' ')).toContain('dead-agent')
      expect(warns.join(' ')).toContain('reclaiming')
      // ⚠️ 真正的危险在这里：崩死者的**迟到释放**绝不能把别人的租约偷走（token 已经不是它了）
      deadLease()
      expect(pool.snapshot()[0]?.holder?.agentId).toBe('agent-B')
      // B 正常归还之后再发起调用（⚠️ 首版我把调用写在归还之前 ⇒ 它排队等满 leaseTimeout 超时，
      // 测试自己造了个 5 秒死锁；顺序错在测试，不在实现）
      liveLease()
      expect(pool.snapshot()[0]?.holder).toBeUndefined()
      const result = payloadOf(await pool.callTool('fake', 'echo', { text: 'next' }, ownerA))
      expect(result.text).toBe('next')
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('describeOwner：归属文本带 session/lane（拒绝与日志共用一处措辞）', () => {
    expect(describeOwner(undefined)).toBe('nobody')
    expect(describeOwner({ agentId: 'a1' })).toBe('agent a1')
    expect(describeOwner({ agentId: 'a1', sessionId: 's1', lane: 'work' })).toBe('agent a1 / session s1 / lane work')
  })
})

describe('MCP 池：引用计数与进程生命周期', () => {
  it('★ 最后一份授权撤销 ⇒ 进程停掉；仍有授权 ⇒ 进程不变', async () => {
    const { pool } = makePool()
    const releaseA = pool.retain('fake')
    const releaseB = pool.retain('fake')
    const pid = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerA)).pid)
    releaseA()
    // 还有一份授权 ⇒ 同进程继续服务
    const stillThere = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerB)).pid)
    expect(stillThere).toBe(pid)
    releaseB()
    // 宽限期内进程**仍在**（这正是「保存 profile 不重启进程」的实现点）；
    // 断言点必须落在宽限期内（首版我按 200ms 断言、而默认宽限 150ms ⇒ 已经停了，红）。
    await tick(60)
    expect(alive(pid)).toBe(true)
    // 同理：等它真的消失，而不是赌「宽限 + 250ms 一定够」
    expect(await waitUntil(() => !alive(pid), stopGrace + 10_000)).toBe(true)
    expect(alive(pid)).toBe(false)
    await pool.disposeAll()
  })

  it('★ 崩溃后下一次调用自动重连（换 pid）', async () => {
    const { pool } = makePool()
    const release = pool.retain('fake')
    try {
      const before = Number(payloadOf(await pool.callTool('fake', 'crash', {}, ownerA)).pid)
      // 等进程真的消失（不用固定 250ms —— 见 waitUntil 的注释）
      expect(await waitUntil(() => !alive(before), 10_000)).toBe(true)
      expect(alive(before)).toBe(false)
      const after = Number(payloadOf(await pool.callTool('fake', 'echo', { text: 'back' }, ownerA)).pid)
      expect(after).not.toBe(before)
      expect(alive(after)).toBe(true)
    } finally {
      release()
      await pool.disposeAll()
    }
  })
})

describe('MCP 池：定义指纹（改配置要不要换进程）', () => {
  it('★ args 变了 ⇒ 换进程；没变 ⇒ pid 不变', async () => {
    const { pool, definitions } = makePool()
    const release = pool.retain('fake')
    try {
      const first = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerA)).pid)
      // 同一个定义再调：pid 必须不变（用户判据：不该因为无关改动重启进程）
      const again = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerA)).pid)
      expect(again).toBe(first)
      // 定义本体变了（加一个 args）⇒ 必须换进程
      definitions.set('fake', { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE, '--changed'] })
      const changed = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerA)).pid)
      expect(changed).not.toBe(first)
      await tick(200)
      expect(alive(first)).toBe(false)
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ 注册表里被停用的服务 ⇒ 不起进程、明确报错（改 disabled 立即生效，不必重写 preset）', async () => {
    const definitions = new Map<string, McpServerConfig>([
      ['off', { name: 'off', transport: 'stdio', command: process.execPath, args: [FIXTURE], disabled: true }],
    ])
    const pool = new McpPool({ resolve: name => definitions.get(name), log: () => {} })
    expect(() => pool.retain('off')).toThrow(/disabled/)
    expect(pool.snapshot()).toEqual([])
    await pool.disposeAll()
  })

  it('注册表里没有该服务 ⇒ 明确报错（不静默）', async () => {
    const { pool } = makePool()
    expect(() => pool.retain('nope')).toThrow(/not in the registry/)
    await pool.disposeAll()
  })
})

describe('工具命名：与官方 dsh-mcp-client 逐字一致', () => {
  it('干净情形就是 mcp__<server>__<tool>', () => {
    expect(publicToolName('srv', 'x')).toBe('mcp__srv__x')
    expect(publicToolName('chrome-devtools-9333', 'click')).toBe('mcp__chrome-devtools-9333__click')
  })

  it('★ 超长名走官方哈希截断（常量与结果都钉死）', () => {
    const raw = 'x'.repeat(80)
    const name = publicToolName('srv', raw)
    expect(name).toBe('mcp__srv__xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_cfc51d92f062')
    expect(name).toHaveLength(64)
    expect(name.endsWith('_cfc51d92f062')).toBe(true)
  })

  it('★ 官方微妙语义：**只要发生过字符替换就走哈希分支**（哪怕替换后很短）', () => {
    // 官方判据是 `normalized === joined && normalized.length <= 64` 两个条件**同时**成立才返回干净名，
    // 所以「替换过」即刻落到哈希分支——首版我的断言写成 `mcp__srv__a_b_c`（想当然），实测红。
    // 这里把官方真实行为钉死（含具体哈希），免得后人"顺手修正"成看起来更合理的样子。
    expect(publicToolName('srv', 'a/b c')).toBe('mcp__srv__a_b_c_4545e0115f58')
    expect(publicToolName('srv', 'a'.repeat(70))).toHaveLength(64)
  })
})

describe('租约时长的运维旋钮（设置 UI 落地前用环境变量）', () => {
  it('缺省 = 排队 60s / 停止宽限 3s（TTL 缺省 10 分钟，见池内注释）', () => {
    expect(leaseTimeoutsFromEnv({})).toEqual({ leaseTimeoutMs: 60_000, stopGraceMs: 3_000 })
  })

  it('★ 读得到覆盖值；非法值回落默认（配置写错不该让 MCP 起不来）', () => {
    expect(leaseTimeoutsFromEnv({ CORUM_MCP_LEASE_TIMEOUT_MS: '2000' }))
      .toEqual({ leaseTimeoutMs: 2000, stopGraceMs: 3_000 })
    expect(leaseTimeoutsFromEnv({ CORUM_MCP_LEASE_TIMEOUT_MS: '2000', CORUM_MCP_LEASE_TTL_MS: '5000' }))
      .toEqual({ leaseTimeoutMs: 2000, leaseTtlMs: 5000, stopGraceMs: 3_000 })
    for (const bad of ['', '  ', 'abc', '0', '-1', 'NaN']) {
      expect(leaseTimeoutsFromEnv({ CORUM_MCP_LEASE_TIMEOUT_MS: bad }).leaseTimeoutMs).toBe(60_000)
    }
  })

  it('★ 池真的按覆盖值超时（2s 的旋钮在真子进程上生效）', async () => {
    const previous = process.env.CORUM_MCP_LEASE_TIMEOUT_MS
    process.env.CORUM_MCP_LEASE_TIMEOUT_MS = '120'
    const definitions = new Map<string, McpServerConfig>([
      ['fake', { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE] }],
    ])
    const pool = new McpPool({ resolve: name => definitions.get(name), log: () => {} })
    const release = pool.retain('fake')
    try {
      await pool.listTools('fake')
      const running = pool.callTool('fake', 'slow', { delayMs: 400 }, ownerA)
      await expect(pool.callTool('fake', 'echo', {}, ownerB)).rejects.toBeInstanceOf(McpLeaseTimeoutError)
      await running
    } finally {
      release()
      await pool.disposeAll()
      if (previous === undefined) delete process.env.CORUM_MCP_LEASE_TIMEOUT_MS
      else process.env.CORUM_MCP_LEASE_TIMEOUT_MS = previous
    }
  })
})

describe('TTL 是最后手段、不是调用时长上限（2026-09-27 实机教训）', () => {
  it('★ 合法长调用不得被 TTL 抢走槽位：同资源竞争者必须超时，而不是"接管"', async () => {
    // 复刻实机：排队超时很短（80ms），但持有者的调用会跑 400ms。
    // 旧实现 TTL = 80×2 = 160ms ⇒ 会在 160ms 时把槽位回收给竞争者（同资源并发 ✗）。
    const { pool } = makePool({ leaseTimeoutMs: 80 })
    const release = pool.retain('fake')
    try {
      await pool.listTools('fake')
      const holding = pool.callTool('fake', 'echo', { text: 'doc-a', delayMs: 400 }, ownerA)
      await tick(30)
      // 竞争者等 300ms：若槽位被 TTL 抢走，它会在 ~160ms 成功；正确行为是 80ms 超时被拒。
      const outcome = await pool
        .callTool('fake', 'echo', { text: 'doc-a', delayMs: 1 }, ownerB)
        .then(() => 'acquired' as const, () => 'timed-out' as const)
      expect(outcome).toBe('timed-out')
      await holding
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('显式把 TTL 设小 ⇒ 仍然会回收（保留为可配置的兜底手段）', async () => {
    const { pool } = makePool({ leaseTimeoutMs: 5_000, leaseTtlMs: 60 })
    const release = pool.retain('fake')
    try {
      await pool.listTools('fake')
      const lease = await pool.acquire('fake', { agentId: 'dead' })
      await tick(90)
      const next = await pool.acquire('fake', ownerB)
      expect(pool.snapshot()[0]?.holder?.agentId).toBe('agent-B')
      next()
      lease() // 迟到的释放：空操作
    } finally {
      release()
      await pool.disposeAll()
    }
  })
})
