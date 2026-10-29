/**
 * cdp-client —— 连到某个 CDP 端口，在目标页里执行代码。
 *
 * ## 为什么这是本插件的核心
 *
 * 「用测试装置去测**别的实例**」这件事的全部技术前提，就是能在**目标进程的页面里**
 * 执行代码。有了它，目标实例便**零安装**：不需要在目标上装任何插件、不需要拿它的
 * token —— 页面自己带着 token 与 cookie，在页内 `fetch('/api/...')` 天然带鉴权。
 *
 * 实测（2026-10-29，rc3 :9350）：
 *
 * ```
 * 在目标页内执行 fetch('/api/agentPresets/list')
 * → HTTP 200，拿到 {"ok":true,"value":{"presets":[...]}}
 * → 同时读到 window.__DSH_BOOT__.release.version = "0.2.1-rc.3"
 * ```
 *
 * 而**从外部进程直接 POST** 那个 host 端口只会得到 `401 unauthorized`（缺 token）。
 * 这是本模块存在的根本理由。
 *
 * ## 为什么不用 WebSocket 之外的方案
 *
 * - 官方 `chrome-devtools-mcp` 走 MCP stdio 协议，是给 Agent 的通道，不是库 API；
 * - `ws` 是 Electron 生态里已有的事实依赖，且 CDP 的线协议就是 WebSocket。
 *   本包把 `ws` 打进产物（`tsdown` 不 external 它），宿主不必自带。
 *
 * ## 生命周期
 *
 * 每次 `evaluate` 建立短连接、用完即关。**不做连接池**：目标实例可能随时重启，
 * 长连接会留下僵尸 fd，而单次 evaluate 的开销（~10ms 建连）在测试场景可忽略。
 *
 * @module @corum/corum-cdp-router/cdp-client
 */

import WebSocket from 'ws'

/** 一次 CDP 会话的最小接口（便于测试替身）。 */
export interface CdpSession {
  /** 在页面内求值；`awaitPromise: true` + `returnByValue: true`。 */
  evaluate: (expression: string, timeoutMs?: number) => Promise<unknown>
  /** 目标页的 URL（已脱敏，不含 token）。 */
  readonly pageUrl: string
  /** 关闭连接。 */
  close: () => void
}

/** 目标���描述（来自 `/json/list`）。 */
export interface CdpPage {
  readonly id: string
  readonly type: string
  /** 原始 URL —— **可能含 token，禁止外泄到日志/存档**。 */
  readonly rawUrl: string
  /** 脱敏后的 URL（token 替换为 `<hidden>`），可安全展示。 */
  readonly safeUrl: string
  readonly webSocketDebuggerUrl: string
}

/** CDP 操作失败（带阶段信息，便于定位是「连不上」还是「执行报错」）。 */
export class CdpError extends Error {
  readonly code: string
  readonly stage: 'list' | 'connect' | 'evaluate' | 'timeout'

  /**
   * @param code - 稳定错误码
   * @param message - 人可读原因
   * @param stage - 失败阶段
   */
  constructor(code: string, message: string, stage: 'list' | 'connect' | 'evaluate' | 'timeout') {
    super(message)
    this.name = 'CdpError'
    this.code = code
    this.stage = stage
  }
}

/**
 * 把 URL 里的 token 抹掉，得到可安全记录的形式。
 *
 * 为什么要专门做：MCP/日志/留档里一旦带上 token，等于把该实例的完整控制权写进了
 * 一份可能被分享的文件里。本仓已有先例（页面 URL 含临时 token，交接文档明确要求
 * 不得记录完整 token）。
 *
 * @param url - 原始 URL
 * @returns 脱敏 URL
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|auth|key|access_token)=)[^&#]*/gi, '$1<hidden>')
}

/**
 * 从 `/json/list` 的结果里挑出「Corum 主窗」。
 *
 * 判定：`type === 'page'` **且** url 是 loopback http（`http://127.0.0.1:`）。
 * 排除 `corumapp://startup/...` 启动动画页 —— 那上面没有 `__DSH_BOOT__`，
 * 连上去只会得到一堆 undefined。
 *
 * @param targets - `/json/list` 原始数组
 * @returns 匹配的页面列表（主窗通常恰好 1 个）
 */
export function pickCorumPages(targets: readonly unknown[]): CdpPage[] {
  const out: CdpPage[] = []
  for (const item of targets) {
    if (item === null || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    if (t.type !== 'page') continue
    const url = typeof t.url === 'string' ? t.url : ''
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) continue
    const wsUrl = typeof t.webSocketDebuggerUrl === 'string' ? t.webSocketDebuggerUrl : ''
    if (wsUrl === '') continue
    out.push({
      id: typeof t.id === 'string' ? t.id : '',
      type: 'page',
      rawUrl: url,
      safeUrl: redactUrl(url),
      webSocketDebuggerUrl: wsUrl,
    })
  }
  return out
}

/**
 * 列某端口上的页面。
 *
 * @param port - CDP 端口
 * @param timeoutMs - HTTP 超时
 * @returns 页面列表（可能是空数组 = 实例起了但还没窗口）
 * @throws {CdpError} 端口不可达
 */
export async function listPages(port: number, timeoutMs = 2000): Promise<CdpPage[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal })
    if (!res.ok) {
      throw new CdpError('cdp/list-http', `/json/list 返回 HTTP ${res.status}`, 'list')
    }
    const all = await res.json() as unknown[]
    return pickCorumPages(Array.isArray(all) ? all : [])
  } catch (error: unknown) {
    if (error instanceof CdpError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new CdpError('cdp/unreachable', `无法列出 :${port} 的页面：${message}`, 'list')
  } finally {
    clearTimeout(timer)
  }
}

/** `connectSession` 的选项。 */
export interface ConnectOptions {
  /** 连哪个页面；缺省取 `pickCorumPages` 的第一个。 */
  readonly pageId?: string
  /** 建连超时。 */
  readonly connectTimeoutMs?: number
}

/**
 * 连上目标页，返回一个可反复求值的会话。
 *
 * **调用方必须 `close()`**（或用 `withSession` 包一层）。
 *
 * @param port - CDP 端口
 * @param options - 选项
 * @returns 会话
 * @throws {CdpError} 无页面 / 连不上
 */
export async function connectSession(port: number, options: ConnectOptions = {}): Promise<CdpSession> {
  const pages = await listPages(port)
  if (pages.length === 0) {
    throw new CdpError(
      'cdp/no-page',
      `:${port} 上没有 loopback http 页面（实例可能还在启动动画，或窗口已关闭）`,
      'connect',
    )
  }
  const page = options.pageId === undefined ? pages[0]! : pages.find(p => p.id === options.pageId)
  if (page === undefined) {
    throw new CdpError('cdp/page-not-found', `:${port} 上找不到页面 ${options.pageId}`, 'connect')
  }
  return await openSocket(page, options.connectTimeoutMs ?? 5000)
}

/**
 * 建立 WebSocket 会话并按 id 派发响应。
 *
 * @param page - 目标页
 * @param connectTimeoutMs - 建连超时
 * @returns 会话
 */
function openSocket(page: CdpPage, connectTimeoutMs: number): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
    let seq = 0
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      try { socket.terminate() } catch { /* already closed */ }
      reject(error)
    }

    const connectTimer = setTimeout(() => {
      fail(new CdpError('cdp/connect-timeout', `连 :${page.safeUrl} 超时（${connectTimeoutMs}ms）`, 'connect'))
    }, connectTimeoutMs)

    socket.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!settled) return fail(new CdpError('cdp/connect-failed', `CDP 连接失败：${message}`, 'connect'))
      // 已 settle 之后的错误只影响在飞请求
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new CdpError('cdp/socket-error', `CDP 连接错误：${message}`, 'connect'))
      }
      pending.clear()
    })

    socket.on('close', () => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new CdpError('cdp/socket-closed', 'CDP 连接被关闭', 'connect'))
      }
      pending.clear()
    })

    socket.on('message', (data: WebSocket.RawData) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>
      } catch {
        return
      }
      const id = typeof msg.id === 'number' ? msg.id : undefined
      if (id === undefined) return
      const entry = pending.get(id)
      if (entry === undefined) return
      pending.delete(id)
      clearTimeout(entry.timer)
      const err = msg.error as { message?: string } | undefined
      if (err !== undefined && err !== null) {
        entry.reject(new CdpError('cdp/command-failed', err.message ?? 'CDP 命令失败', 'evaluate'))
      } else {
        entry.resolve(msg.result)
      }
    })

    socket.on('open', () => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)

      const session: CdpSession = {
        pageUrl: page.safeUrl,
        evaluate: (expression: string, timeoutMs = 15000) => new Promise((res, rej) => {
          const id = ++seq
          const timer = setTimeout(() => {
            pending.delete(id)
            rej(new CdpError('cdp/evaluate-timeout', `求值超时（${timeoutMs}ms）`, 'timeout'))
          }, timeoutMs)
          pending.set(id, {
            resolve: (raw) => {
              clearTimeout(timer)
              /**
               * ⚠️ 必须解包：CDP 的 `Runtime.evaluate` 返回的是
               * `{ result: { type, value, description? }, exceptionDetails? }`，
               * 真正的值在 `result.value`。
               *
               * 直接返回外层对象会让所有调用方拿到 `{result:{...}}` ——
               * 实测症状：`readRemoteIdentity` 读不到任何字段（全 null），
               * 而 `1+1` 返回 `{result:{type:'number',value:2}}`。
               */
              const envelope = raw as {
                result?: { value?: unknown; description?: string }
                exceptionDetails?: { text?: string; exception?: { description?: string } }
              } | null
              if (envelope?.exceptionDetails !== undefined) {
                const detail = envelope.exceptionDetails
                const message = detail.exception?.description ?? detail.text ?? '页内求值抛错'
                rej(new CdpError('cdp/evaluate-threw', String(message).slice(0, 800), 'evaluate'))
                return
              }
              res(envelope?.result?.value)
            },
            reject: (error) => {
              clearTimeout(timer)
              rej(error)
            },
            timer,
          })
          socket.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }))
        }),
        close: () => {
          for (const [, entry] of pending) {
            clearTimeout(entry.timer)
            entry.reject(new CdpError('cdp/socket-closed', '会话已关闭', 'connect'))
          }
          pending.clear()
          try { socket.close() } catch { /* already closed */ }
        },
      }
      resolve(session)
    })
  })
}

/**
 * 便捷封装：连上、执行、确保关闭。
 *
 * @param port - CDP 端口
 * @param expression - 要执行的表达式（可 `await`，本函数已开 `awaitPromise`）
 * @param options - 连接与求值超时
 * @returns 求值结果
 */
export async function evaluateOnPort(
  port: number,
  expression: string,
  options: ConnectOptions & { readonly evaluateTimeoutMs?: number } = {},
): Promise<unknown> {
  const session = await connectSession(port, options)
  try {
    return await session.evaluate(expression, options.evaluateTimeoutMs)
  } finally {
    session.close()
  }
}
