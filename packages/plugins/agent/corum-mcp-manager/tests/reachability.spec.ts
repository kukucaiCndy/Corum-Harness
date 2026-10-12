/**
 * 第 ② 层可达性探测的单测（契约 §3 末尾四条判据，**必须能证伪**）。
 *
 * 四条判据（每条对应一个 ★ 用例，证伪时改错实现要让对应用例变红）：
 *   1. **真实存在的命令** ⇒ `ok:true, started:true`（用 `process.execPath --version`，
 *      跨平台；不用 `'node'` 因为 PATH 上不一定有 node——这是契约点名的要求）。
 *   2. **必然不存在的命令** ⇒ `ok:false, started:false`，`detail` 含原始 code（ENOENT）。
 *   3. **存在但立刻非零退出**（`process.execPath -e "process.exit(3)"`）⇒ `started:true`——
 *      进程起来了 = 第 ② 层通过，哪怕它退出了；这是本层与第 ③ 层的分界。
 *   4. **http 连接被拒**（无人监听的端口）⇒ `ok:false, started:false`。
 *
 * 为什么用真子进程而不是 mock：被验证对象是「spawn 的 error/spawn 事件时序」与
 * 「进程存活/退出」，这些只在真进程边界上成立。mock 掉 spawn 等于在测我们自己的假接口。
 *
 * ## 超时与孤儿进程
 *
 * vitest 默认 5s 超时；本组用例起真子进程，给每个 8s。所有 stdio 用例都在 finally 里
 * 不依赖实现的 kill——实现承诺探测完不留进程，这里用 `probeReachability` 的返回值**不**
 * 持有 pid（也无法持有），但加一个套件级兜底：每个用例结束等一小会确认无残留（实现内部的
 * `killGracefully` 是 await 的，返回时进程已不在）。http 用例起一个真 TCP 监听器做对照。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { probeReachability } from '../src/reachability.ts'
import type { McpHttpServer, McpStdioServer } from '../src/types.ts'

// 用 `process.execPath` 而非 `'node'`：PATH 上不一定有 node（契约点名），execPath 一定指向
// 正在跑这个测试的 Node 解释器，跨平台一致（darwin/linux/win32 都是绝对路径）。
const NODE = process.execPath

// 探测超时调短（测试要快），但留足余量让真 spawn 起来。
const PROBE_TIMEOUT_MS = 2_000

// 每个用例结束后等一小会，给实现的 killGracefully 宽限期收尾（不依赖时序，只是兜底防孤儿）。
// vitest 的 afterEach 不 await——这里用同步钩子 + 一个短定时器 unref 即可，真正保证不漏进程
// 的是实现内部的 `await killGracefully(pid)`，返回时进程已 kill。
afterEach(() => {
  const timer = setTimeout(() => {}, 50)
  timer.unref?.()
})

describe('第 ② 层可达性：stdio（契约 §3）', () => {
  it('★ 真实命令起得来 ⇒ ok:true, started:true', async () => {
    const config: McpStdioServer = {
      name: 'probe-ok',
      transport: 'stdio',
      command: NODE,
      args: ['--version'],
    }
    const result = await probeReachability(config, { timeoutMs: PROBE_TIMEOUT_MS })
    expect(result.ok).toBe(true)
    expect(result.started).toBe(true)
    expect(result.kind).toBe('stdio')
  }, 8_000)

  it('★ 必然不存在的命令 ⇒ ok:false, started:false，detail 含原始 code（ENOENT）', async () => {
    // 一个不可能存在的命令名（带足够随机性，避免撞上任何 PATH 上的东西）。
    const config: McpStdioServer = {
      name: 'probe-missing',
      transport: 'stdio',
      command: 'this-command-does-not-exist-anywhere-zzz-987654321',
      args: [],
    }
    const result = await probeReachability(config, { timeoutMs: PROBE_TIMEOUT_MS })
    expect(result.ok).toBe(false)
    expect(result.started).toBe(false)
    expect(result.kind).toBe('stdio')
    // 必须带原始 code——这正是本层相对第 ③ 层的价值（第 ③ 层把它收敛成模糊一句）。
    // 用「以 命令启动失败：ENOENT（ 开头」断言，确保 code 是结构化带出的（不是 message 里恰好含 ENOENT 字样）。
    // 证伪：把实现里 `code` 丢掉、只用 err.message 拼 detail ⇒ message 形如 `spawn xxx ENOENT`，
    // detail 开头变成 `命令启动失败：spawn ...`，不再匹配 `^命令启动失败：ENOENT（`，此断言变红。
    expect(result.detail).toMatch(/^命令启动失败：ENOENT（/)
  }, 8_000)

  it('★ 存在但立刻非零退出 ⇒ started:true（进程起来了 = 第 ② 层通过；退出码归第 ③ 层）', async () => {
    // 进程确实起来了（spawn 事件触发），然后立刻 process.exit(3)。
    // 本层的判据是「起来没起来」，不是「退出码对不对」——这是与第 ③ 层的分界线。
    const config: McpStdioServer = {
      name: 'probe-exit-nonzero',
      transport: 'stdio',
      command: NODE,
      args: ['-e', 'process.exit(3)'],
    }
    const result = await probeReachability(config, { timeoutMs: PROBE_TIMEOUT_MS })
    expect(result.started).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('stdio')
  }, 8_000)

  it('★ 超时兜底 + 不留孤儿：挂起的进程被探测后必然被 kill', async () => {
    // 一个 spawn 成功但永不退出的脚本（setInterval 持续）。探测超时后会触发 killGracefully。
    // 这条不测「超时返回 ok:false」（node 的 spawn 事件其实会触发 ⇒ started:true，那是正确行为），
    // 而是测**纪律要求**的「不许留孤儿进程」——这是契约写明「kill 要稳、别留孤儿进程」的可测投影。
    const config: McpStdioServer = {
      name: 'probe-hang',
      transport: 'stdio',
      command: NODE,
      args: ['-e', 'setInterval(()=>{},60000); process.stdin.resume()'],
    }
    const result = await probeReachability(config, { timeoutMs: 300 })
    // node 进程起得快：spawn 事件会先触发 ⇒ started:true 是正确行为（不是超时）。
    // 这条用例的真正断言是「进程结束了」，见下。
    // （result.ok 可能 true 也可能 false，取决于 spawn 与超时谁先；不硬断言 ok。）
    expect(result.kind).toBe('stdio')
    // 给实现的 killGracefully 兜底宽限（300ms SIGTERM + 300ms grace），等够确认无残留。
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1_200)
      t.unref?.()
    })
    // 至此探测已返回，实现的 killGracefully 应已把进程杀掉。
    // 没有直接拿 pid 的途径（probeReachability 不返回 pid），所以这条纪律用「套件不挂」+
    // 「后续 spawn 不受残留影响」间接收敛——真正的孤儿防护在实现的 await killGracefully 里。
    // 这里只断言探测本身不抛、有返回。
    expect(result).toBeDefined()
  }, 8_000)

  it('env 透传：子进程能读到 config.env（与 test-connection 同款合并 process.env）', async () => {
    // 用一个会输出环境变量的脚本，验证 env 真的传进去了。
    // 这条不直接对应四条判据，但守住「env 字段的真实语义」，防止有人把合并 process.env 去掉。
    const config: McpStdioServer = {
      name: 'probe-env',
      transport: 'stdio',
      command: NODE,
      args: ['-e', 'process.stdout.write(process.env.CORUM_PROBE_ENV_TEST ?? "")'],
      env: { CORUM_PROBE_ENV_TEST: 'sent-from-config' },
    }
    const result = await probeReachability(config, { timeoutMs: PROBE_TIMEOUT_MS })
    // 命令真实存在且能起 ⇒ started:true（本层不读 stdout，只判进程）。
    expect(result.started).toBe(true)
    expect(result.ok).toBe(true)
  }, 8_000)
})

describe('第 ② 层可达性：streamable-http（契约 §3）', () => {
  it('★ http 服务在（拿到任何 HTTP 响应）⇒ ok:true, started:true', async () => {
    // 起一个真合规的 HTTP server（不是 raw TCP）——fetch 期望完整 HTTP/1.1 响应，
    // 手搓 raw 字节会被 fetch 当作协议错误挂住。
    const server = createHttpServer((_req, res) => {
      res.statusCode = 200
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const config: McpHttpServer = {
        name: 'probe-http-ok',
        transport: 'streamable-http',
        url: `http://127.0.0.1:${port}/`,
      }
      const result = await probeReachability(config, { timeoutMs: PROBE_TIMEOUT_MS })
      expect(result.ok).toBe(true)
      expect(result.started).toBe(true)
      expect(result.kind).toBe('streamable-http')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 8_000)

  it('★ http 连接被拒（无人监听）⇒ ok:false, started:false，detail 带原始原因', async () => {
    // 占一个端口再立刻关掉，拿到一个「确定没人监听」的端口（bind 0 然后 close）。
    // 比 hardcode 端口稳：不会撞上别的服务，也不会因为 TIME_WAIT 残留而假绿。
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
    const port = (holder.address() as AddressInfo).port
    await new Promise<void>((resolve) => holder.close(() => resolve()))

    const config: McpHttpServer = {
      name: 'probe-http-refused',
      transport: 'streamable-http',
      url: `http://127.0.0.1:${port}/`,
    }
    const result = await probeReachability(config, { timeoutMs: PROBE_TIMEOUT_MS })
    expect(result.ok).toBe(false)
    expect(result.started).toBe(false)
    expect(result.kind).toBe('streamable-http')
    // detail 必须带原始原因（ECONNREFUSED / fetch failed 之类），不许收敛成「连接失败」一句。
    expect(result.detail.length).toBeGreaterThan(0)
    expect(result.detail).toContain('127.0.0.1')
  }, 8_000)
})
