/**
 * cdp-client —— 连到某个 CDP 端口，在目标页里执行代码 + 驱动 Input/Page/Emulation 域。
 *
 * ## 为什么这是本插件的核心
 *
 * 「用测试装置去测**别的实例**」这件事的全部技术前提，就是能在**目标进程的页面里**
 * 执行代码。有了它，目标实例便**零安装**：不需要在目标上装任何插件、不需要拿它的
 * token —— 页面自己带着 token 与 cookie，在页内 `fetch('/api/...')` 天然带鉴权。
 *
 * ## 能力面
 *
 * 除 `evaluate`（Runtime.evaluate）外，本模块还提供：
 * - `send(method, params)` —— 通用 CDP 命令发送（Input./Page./Emulation./Log./Network.）；
 * - 证据收集（consoleAPICalled / exceptionThrown / Log.entryAdded / 网络请求失败）；
 * - 高阶原语：`click` / `insertText` / `pressKey` / `captureScreenshot` / `resize`。
 *
 * 原语语义照搬 ui-verify.mjs（/Users/kukucai/work/corum-dev-preset/skills/corum-cdp-verify/scripts/ui-verify.mjs
 * 的 runStep/runAssertion，319–469 行）—— 那是已验证的成熟实现。
 *
 * ## 生命周期
 *
 * 每次 `connectSession` 建立一条长连接、返回可反复使用的会话。**调用方必须 `close()`**
 * （或用 `withSession` 包一层）。不做连接池：目标实例可能随时重启，长连接会留下僵尸 fd。
 *
 * @module @corum/corum-cdp-router/cdp-client
 */

import WebSocket from 'ws'

// ─────────────────────────────────────────────────────────────────────────────
// 类型与错误
// ─────────────────────────────────────────────────────────────────────────────

/** CDP 命令参数（任意键值，由调用方保证与 method 匹配）。 */
export type CdpParams = Record<string, unknown>

/** 收集到的单条 console / exception 证据。 */
export interface ConsoleEntry {
  readonly kind: 'log' | 'error' | 'exception' | 'warning' | 'info' | 'debug'
  readonly text: string
  /** CDP 事件的时间戳（毫秒，单调时钟），用于起点后过滤。 */
  readonly timestamp: number
}

/** 收集到的单条网络请求。 */
export interface NetworkEntry {
  readonly id: string
  readonly url: string
  readonly method: string
  status?: number
}

/** 收集到的单条网络失败。 */
export interface NetworkFailure {
  readonly url: string
  readonly errorText: string
  readonly canceled: boolean
  readonly blockedReason?: string
}

/** 证据汇总（一次会话的生命周期内持续累积）。 */
export interface Evidence {
  readonly console: readonly ConsoleEntry[]
  readonly network: readonly NetworkEntry[]
  readonly failed: readonly NetworkFailure[]
  /** 对象形式汇总，供 runScript 返回。 */
  summary(): { console: { count: number; errors: readonly string[] }; network: { count: number; failed: readonly NetworkFailure[] } }
}

/** 一次 CDP 会话的最小接口（便于测试替身）。 */
export interface CdpSession {
  /** 目标页 id（来自 /json/list）。 */
  readonly pageId: string
  /** 目标页的 URL（已脱敏，不含 token）。 */
  readonly pageUrl: string
  /** 在页面内求值；`awaitPromise: true` + `returnByValue: true`。 */
  evaluate: (expression: string, timeoutMs?: number) => Promise<unknown>
  /** 通用 CDP 命令发送（任意域）。返回 CDP result。 */
  send: (method: string, params?: CdpParams, timeoutMs?: number) => Promise<unknown>
  /** 关闭连接。 */
  close: () => void
  /** 该会话的证据收集器（console/network/exception）。 */
  readonly evidence: Evidence
}

/** 目标页描述（来自 `/json/list`）。 */
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
  readonly stage: 'list' | 'connect' | 'evaluate' | 'timeout' | 'command' | 'input'

  constructor(
    code: string,
    message: string,
    stage: 'list' | 'connect' | 'evaluate' | 'timeout' | 'command' | 'input',
  ) {
    super(message)
    this.name = 'CdpError'
    this.code = code
    this.stage = stage
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// URL 脱敏与页面选择
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 URL 里的 token 抹掉，得到可安全记录的形式。
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
 * 排除 `corumapp://startup/...` 启动动画页。
 *
 * @param targets - `/json/list` 原始数组
 * @returns 匹配的页面列表
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
 * @returns 页面列表
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
  /** 连哪个页面（按 /json/list 的 id）。 */
  readonly pageId?: string
  /** URL 子串匹配（优先级最高，用于多浮窗/自定义场景）。如 `floating=someSlot`。 */
  readonly pageUrlIncludes?: string
  /** 建连超时。 */
  readonly connectTimeoutMs?: number
}

/**
 * 连上目标页，返回一个可反复求值 + 发 CDP 命令的会话。
 *
 * 页面选择（照搬 ui-verify 的 attach 语义，257–265 行）：
 * - `pageUrlIncludes` 给了 → 取 URL 含该子串的第一个（优先级最高）；
 * - 否则 `pageId` 给了 → 按 id 匹配；
 * - 否则取**非浮窗**的第一个（排除 `?floating=` —— 浮窗先建时会挑错窗口）。
 *
 * **调用方必须 `close()`**。
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
  let page: CdpPage | undefined
  if (options.pageUrlIncludes !== undefined) {
    page = pages.find(p => p.rawUrl.includes(options.pageUrlIncludes!))
  } else if (options.pageId !== undefined) {
    page = pages.find(p => p.id === options.pageId)
  } else {
    // 缺省：非浮窗优先（浮窗 URL 含 `?floating=`）
    page = pages.find(p => !p.rawUrl.includes('floating=')) ?? pages[0]
  }
  if (page === undefined) {
    const hint = options.pageUrlIncludes !== undefined
      ? `pageUrlIncludes=${JSON.stringify(options.pageUrlIncludes)}`
      : options.pageId !== undefined
        ? `pageId=${options.pageId}`
        : '(默认)'
    throw new CdpError('cdp/page-not-found', `:${port} 上找不到页面（${hint}）`, 'connect')
  }
  return await openSocket(page, options.connectTimeoutMs ?? 5000)
}

// ─────────────────────────────────────────────────────────────────────────────
// 证据收集器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 建一个 console/exception/network 证据收集器。
 *
 * 事件来源（必须在 enable 三域**之前**挂上，否则丢首批事件）：
 * - `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` → console
 * - `Log.entryAdded` → console（按 level 分类）
 * - `Network.requestWillBeSent` → network 请求
 * - `Network.responseReceived` → 补 status
 * - `Network.loadingFailed` → failed
 *
 * @param startTime - 时间戳过滤起点（毫秒，单调时钟）；早于它的事件被丢弃
 */

// ─────────────────────────────────────────────────────────────────────────────
// 内部：Evidence 的可变实现（不暴露给调用方）
// ─────────────────────────────────────────────────────────────────────────────

/** 内部可变证据容器（createMutableEvidence 的实现细节）。 */
interface MutableEvidence extends Evidence {
  pushConsole(entry: ConsoleEntry): void
  pushNetwork(entry: NetworkEntry): void
  setNetworkStatus(id: string, status: number): void
  pushFailure(id: string, failure: Omit<NetworkFailure, 'url'>): void
  rememberRequestUrl(id: string, url: string): void
}

/** @internal */
function createMutableEvidence(startTime: number): MutableEvidence {
  const consoleEntries: ConsoleEntry[] = []
  const networkEntries: NetworkEntry[] = []
  const failedEntries: NetworkFailure[] = []
  const requestUrls = new Map<string, string>()

  function pushConsole(entry: ConsoleEntry): void {
    if (entry.timestamp < startTime) return
    consoleEntries.push(entry)
  }

  function pushNetwork(entry: NetworkEntry): void {
    networkEntries.push(entry)
    requestUrls.set(entry.id, entry.url)
  }

  function setNetworkStatus(id: string, status: number): void {
    const rec = networkEntries.find(r => r.id === id)
    if (rec !== undefined) (rec as NetworkEntry & { status?: number }).status = status
  }

  function pushFailure(id: string, failure: Omit<NetworkFailure, 'url'>): void {
    const url = requestUrls.get(id) ?? ''
    failedEntries.push({ url, ...failure })
  }

  function rememberRequestUrl(id: string, url: string): void {
    requestUrls.set(id, url)
  }

  const evidence: MutableEvidence = {
    get console() { return consoleEntries },
    get network() { return networkEntries },
    get failed() { return failedEntries },
    summary() {
      const errorish = (e: ConsoleEntry) => e.kind === 'error' || e.kind === 'exception'
      return {
        console: {
          count: consoleEntries.length,
          errors: consoleEntries.filter(errorish).map(e => e.text),
        },
        network: {
          count: networkEntries.length,
          failed: [...failedEntries],
        },
      }
    },
    pushConsole,
    pushNetwork,
    setNetworkStatus,
    pushFailure,
    rememberRequestUrl,
  }
  return evidence
}

/**
 * 把一个 CDP 域事件推入证据收集器（内部用，被 openSocket 的 message handler 调用）。
 *
 * @param evidence - 可变证据容器
 * @param startTime - 时间戳过滤起点
 * @param method - CDP 事件方法名（如 `Runtime.consoleAPICalled`）
 * @param params - 事件参数
 */
export function pushEvidence(
  evidence: MutableEvidence,
  startTime: number,
  method: string,
  params: Record<string, unknown>,
): void {
  const timestamp = typeof params.timestamp === 'number' ? params.timestamp : Date.now()
  if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
    evidence.pushConsole(makeConsoleEntry(method, params, timestamp))
    return
  }
  if (method === 'Log.entryAdded') {
    const entry = (params.entry ?? {}) as Record<string, unknown>
    const level = typeof entry.level === 'string' ? entry.level : 'info'
    const kindMap: Record<string, ConsoleEntry['kind']> = {
      error: 'error', warning: 'warning', info: 'info', debug: 'debug', verbose: 'log',
    }
    evidence.pushConsole({
      kind: kindMap[level] ?? 'log',
      text: String(entry.text ?? entry.name ?? '(log entry)').slice(0, 500),
      timestamp,
    })
    return
  }
  if (method === 'Network.requestWillBeSent') {
    if (timestamp < startTime) return
    const request = (params.request ?? {}) as Record<string, unknown>
    evidence.pushNetwork({
      id: String(params.requestId ?? ''),
      url: String(request.url ?? ''),
      method: String(request.method ?? 'GET'),
    })
    evidence.rememberRequestUrl(String(params.requestId ?? ''), String(request.url ?? ''))
    return
  }
  if (method === 'Network.responseReceived') {
    const response = (params.response ?? {}) as Record<string, unknown>
    evidence.setNetworkStatus(String(params.requestId ?? ''), typeof response.status === 'number' ? response.status : 0)
    return
  }
  if (method === 'Network.loadingFailed') {
    evidence.pushFailure(String(params.requestId ?? ''), {
      errorText: String(params.errorText ?? 'loadingFailed'),
      canceled: params.canceled === true,
      ...(params.blockedReason !== undefined ? { blockedReason: String(params.blockedReason) } : {}),
    })
    return
  }
}

/** @internal 把 Runtime.consoleAPICalled / exceptionThrown 参数转成 ConsoleEntry。 */
function makeConsoleEntry(method: string, p: Record<string, unknown>, timestamp: number): ConsoleEntry {
  if (method === 'Runtime.exceptionThrown') {
    const detail = (p.exceptionDetails ?? {}) as Record<string, unknown>
    const exc = (detail.exception ?? {}) as Record<string, unknown>
    return {
      kind: 'exception',
      text: `exception: ${String(exc.description ?? detail.text ?? '页内异常').slice(0, 500)}`,
      timestamp,
    }
  }
  const apiType = typeof p.type === 'string' ? p.type : 'log'
  const kindMap: Record<string, ConsoleEntry['kind']> = {
    error: 'error', warning: 'warning', info: 'info', debug: 'debug', log: 'log',
  }
  const kind = kindMap[apiType] ?? 'log'
  const args = Array.isArray(p.args) ? p.args : []
  const parts = args.map((a) => {
    const arg = a as Record<string, unknown>
    if (arg.value !== undefined) {
      return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value)
    }
    return String(arg.description ?? arg.unserializableValue ?? arg.type ?? '?')
  })
  return { kind, text: (parts.join(' ') || '(empty)').slice(0, 500), timestamp }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket 会话建立
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 建立 WebSocket 会话并按 id 派发响应 + 分发域事件。
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

    // 证据收集器：在 enable 三域之前创建，确保连接后第一批事件不丢。
    const startTime = Date.now()
    const evidence = createMutableEvidence(startTime)

    // 事件监听器列表（域事件 = 没有 id 的 message）。
    const eventListeners: Array<(method: string, params: Record<string, unknown>) => void> = [
      (method, params) => pushEvidence(evidence, startTime, method, params),
    ]

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
      // 命令应答（有 id）
      const id = typeof msg.id === 'number' ? msg.id : undefined
      if (id !== undefined) {
        const entry = pending.get(id)
        if (entry === undefined) return
        pending.delete(id)
        clearTimeout(entry.timer)
        const err = msg.error as { message?: string } | undefined
        if (err !== undefined && err !== null) {
          entry.reject(new CdpError('cdp/command-failed', err.message ?? 'CDP 命令失败', 'command'))
        } else {
          entry.resolve(msg.result)
        }
        return
      }
      // 域事件（有 method，无 id）
      const method = typeof msg.method === 'string' ? msg.method : ''
      if (method !== '') {
        const params = (msg.params ?? {}) as Record<string, unknown>
        for (const listener of eventListeners) {
          try { listener(method, params) } catch { /* listener 不应影响消息流 */ }
        }
      }
    })

    socket.on('open', () => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)

      const session: CdpSession = {
        pageId: page.id,
        pageUrl: page.safeUrl,
        evidence,
        evaluate: (expression: string, timeoutMs = 15000) => new Promise((res, rej) => {
          const id = ++seq
          const timer = setTimeout(() => {
            pending.delete(id)
            rej(new CdpError('cdp/evaluate-timeout', `求值超时（${timeoutMs}ms）`, 'timeout'))
          }, timeoutMs)
          pending.set(id, {
            resolve: (raw) => {
              clearTimeout(timer)
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
        send: (method: string, params: CdpParams = {}, timeoutMs = 10000) => new Promise((res, rej) => {
          const id = ++seq
          const timer = setTimeout(() => {
            pending.delete(id)
            rej(new CdpError('cdp/command-timeout', `${method} 超时（${timeoutMs}ms）`, 'timeout'))
          }, timeoutMs)
          pending.set(id, {
            resolve: (raw) => {
              clearTimeout(timer)
              res(raw)
            },
            reject: (error) => {
              clearTimeout(timer)
              rej(error)
            },
            timer,
          })
          socket.send(JSON.stringify({ id, method, params }))
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

// ─────────────────────────────────────────────────────────────────────────────
// 高阶原语：click / insertText / pressKey / captureScreenshot / resize
// ─────────────────────────────────────────────────────────────────────────────
//
// 语义照搬 ui-verify.mjs（runStep 319–396 行 + runAssertion 415–468 行）。
// 它们是已验证的成熟实现，字段语义一致。

/** click 的结果。 */
export interface ClickResult {
  readonly ok: boolean
  /** 点击的元素中心坐标（视口坐标系）。 */
  readonly x?: number
  readonly y?: number
  /** 元素 bounding box 尺寸（诊断用）。 */
  readonly width?: number
  readonly height?: number
}

/** captureScreenshot 的结果。 */
export interface ScreenshotResult {
  readonly base64: string
  readonly width: number
  readonly height: number
  /** base64 字符串长度（诊断用，调用方可据此估算大小）。 */
  readonly size: number
}

/** resize 的选项。 */
export interface ResizeOptions {
  readonly width: number
  readonly height: number
}

/**
 * 把「CSS 选择器 / text:可见文字」解析成一段返回元素（或 null）的 JS 表达式。
 *
 * 照搬 ui-verify 的 finder（292–299 行）：
 * - `text:xxx` → 在 button/a/[role=button] 里找 innerText 精确匹配；
 * - 其它 → `document.querySelector(selector)`。
 *
 * @param target - CSS 选择器或 `text:` 前缀
 * @returns 返回元素或 null 的 JS 表达式
 */
export function buildFinder(target: string): string {
  if (target.startsWith('text:')) {
    const want = JSON.stringify(target.slice(5))
    return `[...document.querySelectorAll('button,a,[role=button]')].find(e => (e.innerText||'').trim() === ${want}) ?? null`
  }
  const sel = JSON.stringify(target)
  return `document.querySelector(${sel})`
}

/**
 * 点击元素（真实鼠标 Input.dispatchMouseEvent，中心坐标）。
 *
 * 照搬 ui-verify 的 realClick（302–317 行）：
 * 取元素 getBoundingClientRect 的中心 → mousePressed + mouseReleased。
 *
 * `clickJs` 逃生舱：给 `clickJs: true` 或一个选择器时走合成 `el.click()`（旧方案，
 * 对 contenteditable / Shadow DOM 有时更可靠）。
 *
 * @param session - 已连上的会话
 * @param selector - CSS 选择器或 `text:可见文字`
 * @param opts - `{ clickJs?: boolean | string }`
 * @returns 点击结果
 */
export async function click(
  session: CdpSession,
  selector: string,
  opts: { clickJs?: boolean | string } = {},
): Promise<ClickResult> {
  // clickJs 逃生舱
  if (opts.clickJs !== undefined) {
    const sel = opts.clickJs === true ? selector : String(opts.clickJs)
    const ok = await session.evaluate(
      `(() => { const el = ${buildFinder(sel)}; if (!el) return false; el.click(); return true })()`,
    )
    if (ok !== true) {
      throw new CdpError('cdp/click-not-found', `clickJs 找不到元素：${sel}`, 'input')
    }
    return { ok: true }
  }
  // 真实鼠标：取中心坐标
  const box = await session.evaluate(`(() => {
    const el = ${buildFinder(selector)}
    if (!el || typeof el.getBoundingClientRect !== 'function') return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  })()`) as { x: number; y: number; w: number; h: number } | null
  if (box === null) {
    throw new CdpError('cdp/click-not-found', `找不到元素（或不可见）：${selector}`, 'input')
  }
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await session.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    })
  }
  return { ok: true, x: box.x, y: box.y, width: box.w, height: box.h }
}

/** insertText 的结果。 */
export interface InsertTextResult {
  readonly ok: boolean
  /** 插入后读回的 el.value（仅当 expectValue 给了时才有）。 */
  readonly observed?: string
  /** 是否匹配 expectValue（仅当 expectValue 给了时才有）。 */
  readonly matched?: boolean
}

/**
 * 在输入元素里插入文本（Input.insertText —— React 受控组件吃这个）。
 *
 * 照搬 ui-verify 的 type 步骤（337–367 行）：
 * - `into` 给了 → 先聚焦该元素；
 * - 没给 → 要求当前聚焦元素是 INPUT/TEXTAREA/contentEditable，否则报错；
 * - `submit: true` → 追加 Enter（keyDown + keyUp）；
 * - `expectValue` → 插入后读回 el.value 自证。
 *
 * @param session - 已连上的会话
 * @param text - 要插入的文本
 * @param opts - `{ into?, submit?, expectValue? }`
 * @returns 插入结果
 */
export async function insertText(
  session: CdpSession,
  text: string,
  opts: { into?: string; submit?: boolean; expectValue?: string } = {},
): Promise<InsertTextResult> {
  if (opts.into !== undefined) {
    const ok = await session.evaluate(
      `(() => { const el = ${buildFinder(opts.into!)}; if (!el) return false; el.focus(); return true })()`,
    )
    if (ok !== true) {
      throw new CdpError('cdp/insert-into-not-found', `into 找不到元素：${opts.into}`, 'input')
    }
  } else {
    const focused = await session.evaluate(`(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable ? el.tagName : null
    })()`)
    if (focused === null) {
      throw new CdpError('cdp/insert-no-focus', '未指定 into 且当前没有聚焦的输入元素', 'input')
    }
  }
  await session.send('Input.insertText', { text })
  if (opts.submit === true) {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }
  if (opts.expectValue !== undefined) {
    const target = opts.into !== undefined
      ? `document.querySelector(${JSON.stringify(opts.into)})`
      : 'document.activeElement'
    const got = await session.evaluate(
      `(() => { const el = ${target}; return el ? String(el.value ?? '') : null })()`,
    ) as string | null
    return {
      ok: true,
      ...(got !== null ? { observed: got } : {}),
      matched: got === opts.expectValue,
    }
  }
  return { ok: true }
}

/** pressKey 支持的修饰键。 */
export interface KeyModifiers {
  readonly alt?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
}

/**
 * 派发一次按键（含修饰键组合）。
 *
 * 照搬 ui-verify 的 key 步骤（369–378 行）：
 * - `key` 支持 `Escape` / `Enter` / `ArrowDown` / `ArrowUp` / 单字符；
 * - 修饰键通过 `+` 连接，如 `Meta+a` / `Control+Shift+s`；
 * - 修饰键位掩码：alt=1, ctrl=2, meta=4, shift=8。
 *
 * @param session - 已连上的会话
 * @param key - 按键描述，如 `Escape` / `Meta+a`
 * @param mods - 显式修饰键（可选，与 `+` 语法等价）
 */
export async function pressKey(
  session: CdpSession,
  key: string,
  mods: KeyModifiers = {},
): Promise<void> {
  const parts = String(key).split('+')
  const main = parts.pop()!
  const hasMod = (name: string): boolean => parts.includes(name) || mods[asModKey(name)] === true
  const modifiers = (hasMod('Alt') ? 1 : 0) | (hasMod('Control') ? 2 : 0) | (hasMod('Meta') ? 4 : 0) | (hasMod('Shift') ? 8 : 0)
  const vk = main.length === 1
    ? main.toUpperCase().charCodeAt(0)
    : main === 'Enter' ? 13
      : main === 'Escape' ? 27
        : main === 'ArrowDown' ? 40
          : main === 'ArrowUp' ? 38
            : main === 'Tab' ? 9
              : main === 'Backspace' ? 8
                : 0
  const ev = {
    key: main,
    code: main.length === 1 ? `Key${main.toUpperCase()}` : main,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  }
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ev })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev })
}

/** 把 KeyModifiers 的键名转成 mod 属性名。 */
function asModKey(name: string): keyof KeyModifiers {
  switch (name) {
    case 'Alt': return 'alt'
    case 'Control': return 'ctrl'
    case 'Meta': return 'meta'
    case 'Shift': return 'shift'
    default: return 'alt'
  }
}

/**
 * 截图（Page.captureScreenshot）。
 *
 * @param session - 已连上的会话
 * @returns base64 编码的 PNG + 尺寸信息
 */
export async function captureScreenshot(session: CdpSession): Promise<ScreenshotResult> {
  const result = await session.send('Page.captureScreenshot', { format: 'png' }) as {
    data?: string
    metadata?: { deviceWidth?: number; deviceHeight?: number }
  } | null
  const base64 = result?.data ?? ''
  if (base64 === '') {
    throw new CdpError('cdp/screenshot-empty', 'Page.captureScreenshot 返回空数据', 'command')
  }
  const width = result?.metadata?.deviceWidth ?? 0
  const height = result?.metadata?.deviceHeight ?? 0
  return { base64, width, height, size: base64.length }
}

/**
 * 设置视口尺寸（Emulation.setDeviceMetricsOverride）。
 *
 * 照搬 ui-verify 的 resize 步骤（383–395 行）：
 * `reset: true` → Emulation.clearDeviceMetricsOverride（复原）。
 *
 * @param session - 已连上的会话
 * @param opts - `{ width, height }` 或 `{ reset: true }`
 */
export async function resize(
  session: CdpSession,
  opts: ResizeOptions | { reset: true },
): Promise<void> {
  if ('reset' in opts && opts.reset === true) {
    await session.send('Emulation.clearDeviceMetricsOverride', {})
    return
  }
  const { width, height } = opts as ResizeOptions
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 0,
    mobile: false,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 便捷封装
// ─────────────────────────────────────────────────────────────────────────────

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

// 导出内部类型供测试使用
export type { MutableEvidence }
