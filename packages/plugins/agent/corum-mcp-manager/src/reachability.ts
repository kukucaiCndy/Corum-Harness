/**
 * MCP 三层探测的第 ② 层：**可达性**（reachability）。
 *
 * ## 为什么单独有这一层（与第 ①③ 层的边界）
 *
 * - 第 ① 层（`mcp-requirements.ts` / `probeRequirement`）：**前置**——只判「命令/应用在不在
 *   本机」「服务 URL 能不能解析」，不真起进程、不发请求。它的失败代表「连装都没装」。
 * - 第 ② 层（本文件）：**可达性**——真 spawn 命令看进程起没起来、真 fetch 看 HTTP 端点在不在。
 *   它能分出「命令不存在（ENOENT）」与「命令存在但起不来（EACCES/退出）」，这是第 ③ 层做不到的。
 * - 第 ③ 层（`test-connection.ts` / `testConnection`）：**握手**——用 MCP SDK 跑 initialize→
 *   listTools。它**分不出**「命令不存在」与「握手失败」（`test-connection.ts:66-67` 把所有异常
 *   收敛成一句 `error.message`，调用方拿不到原始 spawn code），这正是本层存在的全部理由。
 *   **不要**改 `testConnection` 的现有语义（已有调用方依赖它），本层只做加法。
 *
 * 判据矩阵（冻结于契约 §3，不许简化）：
 *
 * | 形态 | started | ok | 说明 |
 * |---|---|---|---|
 * | stdio：进程起来了（`spawn` 事件触发） | true | true | 哪怕它随后非零退出也算通过——「装了且能起」是本层的判据 |
 * | stdio：spawn 抛 `error`（ENOENT/EACCES/EPERM） | false | false | `detail` 必须带原始 code，不许收敛成一句模糊话 |
 * | stdio：超时内既没 error 也没 spawn | false | false | detail 说明超时 |
 * | http：拿到任何 HTTP 响应（含 4xx/5xx） | true | true | 服务在；协议层问题归第 ③ 层 |
 * | http：连接被拒/超时/域名解析失败 | false | false | detail 带原始原因 |
 *
 * ## 无副作用
 *
 * 探测不写任何文件、不改任何状态、探测完不留进程（stdio 路径起进程必 kill）。
 *
 * @module @corum/corum-mcp-manager/reachability
 */

import { spawn } from 'node:child_process'
import type { McpHttpServer, McpStdioServer } from './types.ts'

/** 探测结果（契约 §3 冻结，字段名/语义不许改）。 */
export interface ReachabilityResult {
  readonly ok: boolean
  /**
   * stdio：进程是否**起来了**（spawn 成功）；http：是否连上。
   *
   * 这是本层与第 ③ 层的分界线：进程起来了就算本层通过，哪怕它随后非零退出——
   * 「装了且能起」与「握手能不能成」是两件事。
   */
  readonly started: boolean
  readonly kind: 'stdio' | 'streamable-http'
  /** 原始判据/报错（人类可读；失败时必须带原始错误码，如 spawn ENOENT/EACCES）。 */
  readonly detail: string
}

/** 探测选项（契约 §3 冻结）。 */
export interface ReachabilityOptions {
  /**
   * 超时（毫秒），缺省 3000。
   *
   * **必须有**——否则一笔挂起的 spawn 会拖死导入向导（向导是同步等结果的 UI 流程）。
   * 第 ③ 层握手默认 10s，本层更快：只判「起来没起来」，不必等协议。
   */
  readonly timeoutMs?: number
}

/** 缺省超时：3s（只判进程是否起来，不必等协议握手）。 */
const DEFAULT_TIMEOUT_MS = 3_000

/**
 * kill 后的宽限期：先 `SIGTERM`，这段时间内还活着再 `SIGKILL`。
 *
 * 为什么必须有宽限而不是直接 `SIGKILL`：本探测层起的是**用户的真实 MCP server**（不是我们的夹具），
 * 直接 `SIGKILL` 会跳过它的清理钩子（落盘/解锁/通知远端），留下半截状态。先给一次优雅退出的机会。
 * 注意：POSIX 上信号是 `SIGTERM`/`SIGKILL`；Windows 上 `process.kill` 没有「信号」概念——
 * `tree-kill` 式的强杀在 win32 上等价于 `taskkill /F /T`，这里用 `process.kill(pid)` 即可
 * （win32 的 `kill` 走 `TerminateProcess`，本身就是不可拒绝的强杀，没有「优雅」这一步）。
 */
const KILL_GRACE_MS = 300

/**
 * 探测一个 MCP 服务的**可达性**（第 ② 层）。
 *
 * 不抛出：所有失败收敛为 `{ ok: false, started: false, detail }`，`detail` 带原始原因。
 *
 * @param config - McpStdioServer | McpHttpServer（与 `testConnection` 同一个判别联合）。
 * @param options - 超时等（见 {@link ReachabilityOptions}）。
 */
export async function probeReachability(
  config: McpStdioServer | McpHttpServer,
  options?: ReachabilityOptions,
): Promise<ReachabilityResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (config.transport === 'stdio') {
    return await probeStdio(config, timeoutMs)
  }
  return await probeHttp(config, timeoutMs)
}

/**
 * stdio 可达性：真 spawn `command` + `args`，监听 `error` / `spawn` 事件。
 *
 * 关键边界（与第 ③ 层的分界，不许简化）：
 * - `error` 事件（`ENOENT`/`EACCES`/`EPERM`）⇒ `started:false`：进程**没起来**，`detail` 带原始 code。
 * - `spawn` 事件触发 ⇒ `started:true`，**立刻 kill**，`ok:true`：进程起来了就算本层通过，
 *   哪怕它随后非零退出（「装了但起不来」与「装了且能起但握手失败」是两件事，后者归第 ③ 层）。
 * - 超时内既没 error 也没 spawn ⇒ `started:false`，`detail` 说明超时。
 *
 * `env` 与 `cwd` 的传法照 `types.ts` 的真实字段（`McpStdioServer.env` / `.cwd`），与
 * `test-connection.ts:24` 合并 `process.env` 的做法一致——子进程需要 PATH 等才能找到自己的依赖。
 */
async function probeStdio(config: McpStdioServer, timeoutMs: number): Promise<ReachabilityResult> {
  // stdio 合并 process.env（子进程需要 PATH 等；与 test-connection.ts / pool.ts 同款）。
  // 注意 `exactOptionalPropertyTypes`：cwd 没给就别传 undefined，传了会被 SDK 当显式覆盖。
  const spawnOptions: {
    readonly stdio: 'ignore'
    readonly env: NodeJS.ProcessEnv
    readonly cwd?: string
  } = {
    stdio: 'ignore',
    env: { ...process.env, ...(config.env ?? {}) },
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
  }

  let settled = false
  // 用 `spawn`（不是 `execFile`/`fork`）：我们要原生拿到 `error`/`spawn` 事件与 pid，
  // 不要 `execFile` 的回调包装（它会把 spawn error 转成回调参数，丢失事件时序）。
  const child = spawn(config.command, config.args ?? [], spawnOptions)

  // 探测完必须保证进程结束（不留孤儿）。这里用 once 而不是持有 child 引用常驻监听——
  // 探测是一次性判定，判定完立刻 kill，进程不该比本函数活得更久。
  const result = await new Promise<ReachabilityResult>((resolve) => {
    const finish = (value: ReachabilityResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    // spawn 成功事件：进程**起来了**（pid 已分配）。这是本层的「通过」判据。
    // 哪怕它下一行就非零退出，`started` 仍是 true——退出码归第 ③ 层握手去判。
    child.once('spawn', () => {
      finish({ ok: true, started: true, kind: 'stdio', detail: `进程已启动（pid ${child.pid ?? '?'}, command=${config.command}）` })
    })

    // spawn error（不是子进程内的运行时错误，是「根本起不来」）：
    // Node 把 ENOENT/EACCES/EPERM 等以 'error' 事件抛出（child 进程从未存在）。
    // 必须把原始 code 原样带出来——这正是本层相对第 ③ 层的价值（第 ③ 层把它收敛成模糊一句）。
    child.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? ''
      const detail = code !== ''
        ? `命令启动失败：${code}（command=${config.command}）${err.message !== '' ? '：' + err.message : ''}`
        : `命令启动失败：${err.message}（command=${config.command}）`
      finish({ ok: false, started: false, kind: 'stdio', detail })
    })

    // 超时兜底：既没 spawn 也没 error（一笔挂起的 spawn 会拖死向导，必须有上限）。
    const timer = setTimeout(() => {
      finish({ ok: false, started: false, kind: 'stdio', detail: `启动超时（${timeoutMs}ms 内进程未起来；command=${config.command}）` })
    }, timeoutMs)
    // 探测定时器不该拖住进程退出（与 pool.ts 的 stopTimer 同款 unref）。
    timer.unref?.()
  })

  // 无论结果如何，只要进程可能还活着就 kill（不留孤儿）。
  // pid 可能 undefined（spawn error 时根本没有 pid）；判一下再 kill。
  if (child.pid !== undefined) {
    await killGracefully(child.pid)
  }
  // 兜底：摘掉残留监听器，避免 child 对象在事件循环里挂着（虽然 stdio:'ignore' + killed 后
  // 进程已没，但 Node 的 ChildProcess 实例可能仍被内部引用，显式 removeAllListeners 更稳）。
  child.removeAllListeners()

  return result
}

/**
 * http 可达性：`fetch(url, { signal: AbortSignal.timeout(ms) })`。
 *
 * 判据（契约 §3）：拿到**任何** HTTP 响应（含 4xx/5xx）⇒ `ok:true, started:true`——
 * 「服务在不在」是本层的事，「协议对不对」归第 ③ 层。连接被拒/超时/解析失败 ⇒ `ok:false`。
 *
 * 用 `AbortSignal.timeout` 而不是手搓 `AbortController`：它是平台原生的超时原语，
 * 语义是「到点 abort 这次 fetch」，比手写 timer + controller.abort 少一处定时器泄漏的可能。
 */
async function probeHttp(config: McpHttpServer, timeoutMs: number): Promise<ReachabilityResult> {
  const headers = config.headers ?? {}
  // headers 为空时不传 requestInit，避免 fetch 把空对象当成「覆盖所有头」的奇怪实现差异。
  const init: RequestInit & { signal: AbortSignal } = {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
    // 即使 4xx/5xx 也要 resolve（不抛），因为本层只判「服务在不在」。
    redirect: 'error',
  }
  if (Object.keys(headers).length > 0) {
    init.headers = headers
  }

  try {
    const response = await fetch(config.url, init)
    // 任何 HTTP 响应（含 4xx/5xx）都算「服务在」——协议层问题归第 ③ 层。
    return {
      ok: true,
      started: true,
      kind: 'streamable-http',
      detail: `HTTP ${response.status}（url=${config.url}）`,
    }
  } catch (error) {
    // 连接被拒（ECONNREFUSED）/ 超时（AbortError/TimeoutError）/ 域名解析失败（ENOTFOUND）
    // 都在这里：detail 带原始原因，不许收敛成「连接失败」一句模糊话。
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      started: false,
      kind: 'streamable-http',
      detail: `连接失败：${reason}（url=${config.url}）`,
    }
  }
}

/**
 * 稳健 kill：先 `SIGTERM`，宽限内还活着再 `SIGKILL`。
 *
 * 平台差异（写在这里而不是静默假设 POSIX）：
 * - POSIX（darwin/linux）：`process.kill(pid, 'SIGTERM')` 发信号，进程可捕获后优雅退出；
 *   `process.kill(pid, 'SIGKILL')` 不可拒绝、不可捕获。
 * - win32：`process.kill(pid)` 等价于 `TerminateProcess`，**本身就是不可拒绝的强杀**，
 *   没有「优雅」这一步，所以宽限期在 win32 上是空等（无害，保留代码路径统一）。
 *   注意 win32 上 spawn `.cmd`/`.exe` 会经由 cmd shell，kill pid 可能留下 cmd 进程——
 *   本探测层只起瞬时进程（探测完立刻 kill），不长期持有，故不引入 tree-kill；
 *   长期持有的连接池在 pool.ts 里管，那边走 SDK 的 close。
 *
 * @param pid - 子进程 pid。
 */
async function killGracefully(pid: number): Promise<void> {
  const tryKill = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      // 进程已退出（ESRCH）或无权限（EPERM）：前者是期望终态，后者在探测场景下不该发生
      // （进程是我们自己 spawn 的）。统一当「已经不在了」处理，不抛。
      return false
    }
  }
  // 先试 SIGTERM（POSIX 优雅退出；win32 上 process.kill(pid, 'SIGTERM') 实际仍走 TerminateProcess）。
  if (!tryKill('SIGTERM')) return
  // 给一段宽限让它优雅退出（落盘/解锁等清理钩子）。
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, KILL_GRACE_MS)
    timer.unref?.()
  })
  // 还活着就 SIGKILL（不可拒绝）。用信号 0 探测存活：不实际发信号，只判在不在。
  if (tryKill(0)) {
    tryKill('SIGKILL')
  }
}
