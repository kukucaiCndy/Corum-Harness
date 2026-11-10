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
  /**
   * 事件时间戳，**统一为 epoch 毫秒**（见 {@link normalizeEpochMs}：CDP 有按秒给的，
   * 一律归一到毫秒）。用于「本次窗口」屏障（{@link Evidence.markStart}）的前后分区。
   */
  readonly timestamp: number
}

/** 网络请求的时间口径。 */
export type NetworkTimeSource = 'wallTime' | 'unknown'

/** 收集到的单条网络请求。 */
export interface NetworkEntry {
  readonly id: string
  readonly url: string
  readonly method: string
  status?: number
  /**
   * 请求发出的**墙钟**时间（epoch 毫秒，取自 `params.wallTime * 1000`）。
   * 缺省 = CDP 没给墙钟，**不臆造**。
   */
  readonly wallTimeMs?: number
  /**
   * 时间口径：
   * - `wallTime` —— 有墙钟，可与本次窗口起点比较、可被丢弃；
   * - `unknown` —— CDP 只给了单调时钟（`params.timestamp`，秒、原点在浏览器启动）
   *   或什么都没给。**单调时钟不能与 epoch 起点比较**，故本字段如实标 unknown，
   *   条目保留但不声称属于本次窗口（旧实现拿单调值比 epoch 起点，判据恒假）。
   */
  readonly timeSource: NetworkTimeSource
}

/** 收集到的单条网络失败。 */
export interface NetworkFailure {
  readonly url: string
  readonly errorText: string
  readonly canceled: boolean
  readonly blockedReason?: string
}

/** 证据汇总（**本次窗口**的增量 + 屏障前的存量计数）。 */
export interface EvidenceSummary {
  readonly console: {
    /** 屏障之后到达的条目数（= 本次脚本产生的 console 量）。 */
    readonly count: number
    /** 屏障之后的 error/exception 文本（旧 CTS 只读这两个字段，语义不变）。 */
    readonly errors: readonly string[]
    /**
     * 屏障**之前**到达/被回放的条目数。`Runtime.enable` / `Log.enable` 会回放目标页的
     * 历史 console（含启动期错误），那是**存量**、不是本次脚本产生的错误 ⇒ 只计数，
     * 不进 count/errors（2026-11 T3：旧实现把它们一律算成本次错误，同 fixture 连跑
     * 越跑越脏）。
     */
    readonly preExisting: number
    /** 屏障时刻（epoch 毫秒）；未打屏障为 `null`。 */
    readonly windowStartMs: number | null
  }
  readonly network: { readonly count: number; readonly failed: readonly NetworkFailure[] }
}

/** 证据汇总（一次会话的生命周期内持续累积）。 */
export interface Evidence {
  readonly console: readonly ConsoleEntry[]
  readonly network: readonly NetworkEntry[]
  readonly failed: readonly NetworkFailure[]
  /**
   * 打「本次窗口」屏障（epoch 毫秒，默认 `Date.now()`）。
   *
   * 必须在本轮真正动作**之前**、`Runtime.enable` / `Log.enable` 回放历史之后调用
   * （`runScriptRemote` 就是这么做的）。屏障之前的 console 只计 `preExisting`；
   * 网络请求按墙钟（{@link NetworkEntry.timeSource}）判定。
   *
   * 不调它 ⇒ 一切条目都算 preExisting，`console.count` 恒 0（**偏保守，不会假报错误**）。
   */
  markStart(at?: number): void
  /** 对象形式汇总，供 runScript 返回。 */
  summary(): EvidenceSummary
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
export async function listPages(port: number, timeoutMs = 2000, ip = '127.0.0.1'): Promise<CdpPage[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const host = ip.includes(':') ? `[${ip}]` : ip
  try {
    const res = await fetch(`http://${host}:${port}/json/list`, { signal: ctrl.signal })
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
  /** CDP 监听地址；缺省本机，IPv6 字面量由 listPages 加方括号。 */
  readonly ip?: string
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
  const pages = await listPages(port, 2000, options.ip)
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
 * ⚠️ 时间口径（T1/T3）：收集器**不带**构造时的时间起点，起点由调用方经
 * {@link Evidence.markStart} 显式打屏障 —— 因为 `enable` 回放的历史 console 与
 * 「本次脚本产生的 console」必须分开，构造时刻分不开这两者。
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

/**
 * @internal 建一个内容可变的证据容器。
 *
 * 屏障语义（{@link Evidence.markStart}）：
 * - 屏障前到达的 console → 只累加 `preExisting`，不入 delta 数组；
 * - 屏障后到达的 console → 入 delta（count/errors 只统计它）；
 * - 网络请求按 `wallTimeMs` 判定（`timeSource: 'unknown'` 的不丢弃、也不声称在窗口内）；
 * - **不用 `Log.clear`**：那会清掉目标页真实的日志缓冲（副作用外泄到目标实例）。
 */
export function createMutableEvidence(): MutableEvidence {
  const consoleEntries: ConsoleEntry[] = []
  const networkEntries: NetworkEntry[] = []
  const failedEntries: NetworkFailure[] = []
  const requestUrls = new Map<string, string>()
  /** 屏障时刻（epoch 毫秒）；`null` = 还没打屏障 ⇒ 一切皆存量。 */
  let windowStartMs: number | null = null
  /** 屏障前到达/被回放的 console 条目数。 */
  let preExisting = 0

  /** 该网络条目是否**确定**落在屏障之前（只对墙钟口径可判）。 */
  function isBeforeWindow(entry: NetworkEntry): boolean {
    if (windowStartMs === null) return false
    if (entry.timeSource !== 'wallTime' || entry.wallTimeMs === undefined) return false
    return entry.wallTimeMs < windowStartMs
  }

  function markStart(at: number = Date.now()): void {
    windowStartMs = Number.isFinite(at) && at > 0 ? at : Date.now()
    // 屏障之前已经收进来的网络请求（墙钟可判的）一并剔掉，保持「delta 只含本次」。
    for (let i = networkEntries.length - 1; i >= 0; i--) {
      if (isBeforeWindow(networkEntries[i]!)) networkEntries.splice(i, 1)
    }
  }

  function pushConsole(entry: ConsoleEntry): void {
    if (windowStartMs === null || entry.timestamp < windowStartMs) {
      preExisting++
      return
    }
    consoleEntries.push(entry)
  }

  function pushNetwork(entry: NetworkEntry): void {
    if (isBeforeWindow(entry)) return
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
    markStart,
    summary() {
      const errorish = (e: ConsoleEntry) => e.kind === 'error' || e.kind === 'exception'
      return {
        console: {
          count: consoleEntries.length,
          errors: consoleEntries.filter(errorish).map(e => e.text),
          preExisting,
          windowStartMs,
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
 * 把 CDP 时间戳归一到 **epoch 毫秒**（`null` = 没给/不可用）。
 *
 * CDP 的时间字段口径不统一（这是 T1/T3 的根因）：
 * - `Runtime.consoleAPICalled.timestamp`、`Log.entryAdded.entry.timestamp`：epoch **毫秒**；
 * - `Network.requestWillBeSent.wallTime`：epoch **秒**（`*1000` 才是毫秒）；
 * - `Network.requestWillBeSent.timestamp`：**单调**秒（原点在浏览器启动）——不是 epoch，
 *   不能当 epoch 用（旧实现正是拿它比 epoch 起点，判据恒假）。
 *
 * 判据：`>= 1e12` 视为已是毫秒（1e12 ms ≈ 2001-09），否则视为秒再乘 1000。
 *
 * @param raw - CDP 给的原始时间值
 * @returns epoch 毫秒；非法/缺失返回 null（调用方不得臆造）
 */
export function normalizeEpochMs(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  return raw >= 1e12 ? raw : raw * 1000
}

/**
 * 把一个 CDP 域事件推入证据收集器（内部用，被 openSocket 的 message handler 调用）。
 *
 * @param evidence - 可变证据容器（窗口由它的 `markStart` 决定）
 * @param method - CDP 事件方法名（如 `Runtime.consoleAPICalled`）
 * @param params - 事件参数
 */
export function pushEvidence(
  evidence: MutableEvidence,
  method: string,
  params: Record<string, unknown>,
): void {
  // `params.timestamp` 在 Runtime/Log 事件上是 epoch 毫秒；缺失时用「现在」——
  // 这是**观测时刻**而非对 CDP 值的臆造（不会把事件虚假地推入屏障之前）。
  const eventMs = normalizeEpochMs(params.timestamp) ?? Date.now()
  if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
    evidence.pushConsole(makeConsoleEntry(method, params, eventMs))
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
      // 优先级（brief T3）：条目自带的墙钟 → 事件时间戳 → now。
      timestamp: normalizeEpochMs(entry.timestamp) ?? eventMs,
    })
    return
  }
  if (method === 'Network.requestWillBeSent') {
    // 只用 wallTime（epoch 秒 → 毫秒）。给了单调 timestamp 也不拿它当 epoch；
    // 两者都没有 ⇒ timeSource: 'unknown'（保留条目、如实标注、不丢弃不臆造）。
    const wallTimeMs = normalizeEpochMs(params.wallTime)
    const request = (params.request ?? {}) as Record<string, unknown>
    evidence.pushNetwork({
      id: String(params.requestId ?? ''),
      url: String(request.url ?? ''),
      method: String(request.method ?? 'GET'),
      ...(wallTimeMs !== null ? { wallTimeMs } : {}),
      timeSource: wallTimeMs !== null ? 'wallTime' : 'unknown',
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
    // 窗口起点**不在这里定**：由调用方在 enable 之后调 `evidence.markStart()` 打屏障，
    // 这样 enable 回放的历史 console 只计 preExisting（T3）。
    const evidence = createMutableEvidence()

    // 事件监听器列表（域事件 = 没有 id 的 message）。
    const eventListeners: Array<(method: string, params: Record<string, unknown>) => void> = [
      (method, params) => pushEvidence(evidence, method, params),
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

// ─────────────────────────────────────────────────────────────────────────────
// 真实输入原语（hover / contextmenu / drag，2026-11-07）
// ─────────────────────────────────────────────────────────────────────────────
//
// 为什么必须走 `Input.dispatchMouseEvent` 而不是页内 `el.dispatchEvent(new MouseEvent(…))`：
// 后者造出来的是**不可信事件**（`isTrusted:false`），React 的合成事件系统、浏览器的
// 默认行为（悬停打开浮层、右键弹原生菜单、HTML5 dragstart）都**不会**被触发 ——
// 脚本「跑过了」但界面上什么都没发生。所以这三种原语一律派发真实 Input 事件，
// 且**先做可见性/几何检查**（拿不到可命中的中心点就 fail-closed，不发半套事件）。

/**
 * 元素在**视口坐标系**里的可命中几何（`Input.dispatchMouseEvent` 用的就是这套坐标）。
 *
 * 与 {@link click} 内联那段几何读取的口径差异（click 保持历史行为不动，避免动到
 * 已通过的老用例）：
 *  - 明确要求元素**可见**：`display:none` / `visibility:hidden|collapse` / `opacity:0` /
 *    尺寸为 0 **都算不可见**；
 *  - **中心点必须落在视口内**：CDP 的鼠标坐标是视口坐标，中心点在视口外时事件会落到
 *    别的元素上（或落空）—— 那是「看起来发了、其实没点到」，只能 fail-closed。
 */
export interface ElementBox {
  /** 元素中心点 X（视口坐标）。 */
  readonly x: number
  /** 元素中心点 Y（视口坐标）。 */
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 读元素的**可命中几何**：找不到 / 不可见 / 中心点在视口外 ⇒ `null`。
 *
 * @param session - 已连上的会话
 * @param selector - CSS 选择器或 `text:可见文字`
 * @returns 中心坐标 + 尺寸；不可命中时为 `null`
 */
export async function visibleElementBox(session: CdpSession, selector: string): Promise<ElementBox | null> {
  return await session.evaluate(`(() => {
    const el = ${buildFinder(selector)}
    if (!el || typeof el.getBoundingClientRect !== 'function') return null
    if (el.isConnected === false) return null
    const r = el.getBoundingClientRect()
    if (!(r.width > 0) || !(r.height > 0)) return null
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
    if (cs) {
      if (cs.display === 'none') return null
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return null
      if (Number(cs.opacity) === 0) return null
    }
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    if (!(x >= 0) || !(y >= 0)) return null
    if (x > (window.innerWidth || 0) || y > (window.innerHeight || 0)) return null
    return { x: x, y: y, width: r.width, height: r.height }
  })()`) as ElementBox | null
}

/** 单点输入原语（hover / contextmenu）的结果。 */
export interface PointerResult {
  readonly ok: boolean
  /** 派发时的元素中心坐标（视口坐标）。 */
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
}

/**
 * 悬停到元素中心（真实 `Input.dispatchMouseEvent` `mouseMoved`）。
 *
 * **只发 mouseMoved，不按任何键**：悬停要能真实触发 `mouseover` / `mouseenter` /
 * CSS `:hover`，但**绝不能**带 `mousePressed`（那会变成一次点击，把「悬停打开浮层」
 * 这条用例变成「点了两下」）。
 *
 * @param session - 已连上的会话
 * @param selector - CSS 选择器或 `text:可见文字`
 * @returns 派发坐标与元素尺寸
 * @throws {CdpError} 元素不可见 / 中心点不在视口内（`cdp/hover-not-visible`）
 */
export async function hover(session: CdpSession, selector: string): Promise<PointerResult> {
  const box = await visibleElementBox(session, selector)
  if (box === null) {
    throw new CdpError('cdp/hover-not-visible', `找不到元素，或它不可见/中心不在视口内：${selector}`, 'input')
  }
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.x,
    y: box.y,
    button: 'none',
    buttons: 0,
  })
  return { ok: true, x: box.x, y: box.y, width: box.width, height: box.height }
}

/**
 * 在元素中心**右键**（真实 `mousePressed` + `mouseReleased`，`button:'right'`）。
 *
 * 打开的是应用自己的 `onContextMenu` 菜单：Chromium 只对真实右键入参（`button:'right'`）
 * 触发 `contextmenu`，页内合成事件不会。
 *
 * `buttons` 掩码按 DOM 语义给：按下时 = 2（右键位），抬起后 = 0。
 *
 * @param session - 已连上的会话
 * @param selector - CSS 选择器或 `text:可见文字`
 * @returns 派发坐标与元素尺寸
 * @throws {CdpError} 元素不可见 / 中心点不在视口内（`cdp/contextmenu-not-visible`）
 *
 * @remarks
 * **菜单打开后不会自动收口**，这是本原语有意为之：右键之后要用哪个动作关闭（`Escape`、
 * 点空白处、点某个菜单项）取决于被测应用的实现，替调用方猜一个反而会掩盖它的真实行为。
 * 代价是下一条步骤可能命中菜单遮罩 —— 所以脚本里 `contextmenu` 之后要么紧跟菜单项点击，
 * 要么显式 `{ action: 'key', key: 'Escape' }`；留在界面上没关的菜单应当写进
 * `recovery`，否则它会污染后续用例（同 `resize` 视口残留口径）。
 */
export async function contextMenu(session: CdpSession, selector: string): Promise<PointerResult> {
  const box = await visibleElementBox(session, selector)
  if (box === null) {
    throw new CdpError('cdp/contextmenu-not-visible', `找不到元素，或它不可见/中心不在视口内：${selector}`, 'input')
  }
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'right',
    buttons: 2,
    clickCount: 1,
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'right',
    buttons: 0,
    clickCount: 1,
  })
  return { ok: true, x: box.x, y: box.y, width: box.width, height: box.height }
}

/** 视口坐标点。 */
export interface Point {
  readonly x: number
  readonly y: number
}

/** drag 的目标（二选一：元素选择器，或明确的视口坐标）。 */
export interface DragOptions {
  /** 目标元素选择器（与 `to` 二选一；元素必须可见）。 */
  readonly toSelector?: string
  /** 目标视口坐标（与 `toSelector` 二选一）。 */
  readonly to?: Point
  /** 中间 `mouseMoved` 的步数（默认 {@link DRAG_DEFAULT_MOVES}=4；最少 1）。 */
  readonly moves?: number
  /**
   * 是否在鼠标序列中间补发**原生 DnD 事件**（默认 true，见 {@link drag} 的 2026-11-07 实测）。
   *
   * 只有源元素 `draggable === true` 时才补发；否则什么也不补（不是原生拖放元素，
   * 补发只会给页面塞进它本来收不到的 `drop`）。
   */
  readonly native?: boolean
}

/** drag 的结果。 */
export interface DragResult extends PointerResult {
  /** 起点（源元素中心，视口坐标）。 */
  readonly from?: Point
  /** 终点（目标元素中心或显式坐标）。 */
  readonly to?: Point
  /** 实际派发的中间移动步数。 */
  readonly moves?: number
  /**
   * 是否补发了原生 DnD 事件（`Input.dispatchDragEvent`）。
   *
   * 这个字段是**证据**而不只是调试信息：`true` 表示页面收到过 `dragEnter/dragOver/drop`；
   * `false` 表示源元素不是 `draggable`，此时页面**不可能**发生原生拖放 —— 用例必须
   * 自己断言「拖拽后状态」，别把「步骤 ok」读成「拖成功了」。
   */
  readonly nativeDrag?: boolean
}

/**
 * drag 缺省中间步数（4）。
 *
 * 为什么不是 1：中间位置按线性插值均匀铺开，步数越少位移越像一步到位 —— HTML5 DnD 的
 * `dragstart` 位移阈值、以及靠 `pointermove` 序列推进的拖放库（dnd-kit 一类）都可能因此
 * 判成「没在拖」。4 步接近真实鼠标在同一距离上产生的移动次数。
 *
 * 下限仍是 1 而不是 2：即使 `moves: 1` 也有「按下 → 中点 → 终点」两次位移，显式要求
 * 更少步数的调用方不该被偷偷改写。
 */
export const DRAG_DEFAULT_MOVES = 4

/**
 * 真实鼠标拖拽：`mouseMoved(源)` → `mousePressed(left)` → 多步 `mouseMoved(buttons:1)`
 * → `mouseReleased(left)`。
 *
 * 为什么必须**多步**移动：一口气瞬移到终点，`pointermove` 驱动的拖放库（dnd-kit 一类）
 * 要么看不出位移、要么直接判失败；真实鼠标一定产生连续的中间位置。中间步按线性插值
 * 均匀铺开（不含两端），最后再补一次到终点的移动。
 *
 * **原生 HTML5 拖放**（`draggable="true"`）另走 `Input.dispatchDragEvent`，见下面
 * `nativeDrag` 那段的实测说明 —— 单靠 mouse 事件序列在 Chromium 里一次都触发不了。
 *
 * 源与目标**都必须可见**（显式 `to{x,y}` 除外——那是调用方自己给的视口坐标，
 * 只校验是有限数字）。
 *
 * @param session - 已连上的会话
 * @param selector - 源元素（CSS 选择器或 `text:可见文字`）
 * @param opts - `{ toSelector? , to?, moves?, native? }`
 * @returns 起止坐标 + 中间步数 + 是否补发了原生 DnD 事件
 * @throws {CdpError} 源不可见 / 目标不可见 / 缺目标 / 目标坐标非法
 */
export async function drag(
  session: CdpSession,
  selector: string,
  opts: DragOptions = {},
): Promise<DragResult> {
  const from = await visibleElementBox(session, selector)
  if (from === null) {
    throw new CdpError('cdp/drag-source-not-visible', `拖拽源找不到，或它不可见/中心不在视口内：${selector}`, 'input')
  }
  let to: Point
  if (opts.toSelector !== undefined) {
    const target = await visibleElementBox(session, opts.toSelector)
    if (target === null) {
      throw new CdpError(
        'cdp/drag-target-not-visible',
        `拖拽目标找不到，或它不可见/中心不在视口内：${opts.toSelector}`,
        'input',
      )
    }
    to = { x: target.x, y: target.y }
  } else if (opts.to !== undefined) {
    if (!Number.isFinite(opts.to.x) || !Number.isFinite(opts.to.y)) {
      throw new CdpError('cdp/drag-target-invalid', `drag 的 to 必须是有限数字坐标（收到 ${JSON.stringify(opts.to)}）`, 'input')
    }
    to = { x: opts.to.x, y: opts.to.y }
  } else {
    throw new CdpError('cdp/drag-target-missing', 'drag 需要 toSelector 或 to{x,y} 指定终点', 'input')
  }
  /**
   * 中间步数归一：非有限值退回默认，**不是** 0。
   * `Math.max(1, Math.floor(NaN))` 仍是 `NaN`，那会让插值循环一次都不跑（只剩最后那次
   * 到终点的移动）并把 `moves: NaN` 写进证据 —— 一个"看起来拖了、其实没动"的假成功。
   */
  const requestedMoves = opts.moves
  const moves = typeof requestedMoves === 'number' && Number.isFinite(requestedMoves)
    ? Math.max(1, Math.floor(requestedMoves))
    : DRAG_DEFAULT_MOVES
  // mouseMoved 的 `button` 恒为 'none'（DOM 里移动事件没有「变动的键」），
  // 按键状态由 `buttons` 位掩码表达 —— 这是 Chromium DevTools 协议的标准用法。
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: from.x,
    y: from.y,
    button: 'none',
    buttons: 0,
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  for (let i = 1; i <= moves; i++) {
    const t = i / (moves + 1)
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      button: 'none',
      buttons: 1,
    })
  }
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: to.x,
    y: to.y,
    button: 'none',
    buttons: 1,
  })
  /**
   * **原生 HTML5 拖放事件**（2026-11-07 实测结论，别删这条注释）。
   *
   * 上面那套 `Input.dispatchMouseEvent` 序列能让**指针驱动**的拖放库动起来
   * （dnd-kit 一类吃 `pointermove`），但**起不了原生拖放**：实测在一个
   * `draggable="true"` 的元素上按下并分步移动到放置区，页面**一个** `dragstart` /
   * `dragenter` / `drop` 都没收到（即使每步加 20–50ms 帧间隔、窗口已 front、并开了
   * `Input.setInterceptDrags` —— 拦截数 0）。Chromium 的原生 drag session 不从合成
   * mouse 事件开始。
   *
   * 而 `Input.dispatchDragEvent` + 自造 `DragData` **可以**：同样的位置派发
   * `dragEnter → dragOver → drop`，页面收到 `dragenter/dragover/drop` 且 `isTrusted:true`、
   * `drop` 处理器真的跑了。
   *
   * 所以拖拽 = 鼠标序列（给指针库）+ 原生事件（给 HTML5 DnD）。只在源元素
   * `draggable === true` 时才补发 —— 非 draggable 元素本不可能发生原生拖放，
   * 补发等于往页面塞它本来收不到的 `drop`。
   */
  let nativeDrag = false
  if (opts.native !== false) {
    const facts = await dragSourceFacts(session, selector)
    if (facts.draggable) {
      const data = {
        items: [{ mimeType: 'text/plain', data: facts.text === '' ? selector : facts.text }],
        dragOperationsMask: 1,
      }
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await session.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data })
      }
      nativeDrag = true
    }
  }
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  return {
    ok: true,
    x: from.x,
    y: from.y,
    width: from.width,
    height: from.height,
    from: { x: from.x, y: from.y },
    to,
    moves,
    nativeDrag,
  }
}

/**
 * 读源元素的原生拖放事实：是否 `draggable`，以及能当 `dataTransfer` 载荷的可见文本。
 *
 * 单独求值（而不是塞进 {@link visibleElementBox}）：可见性口径要能被所有指针原语共用，
 * 而「是不是 draggable」只有 `drag` 关心。读不到就当成不可拖 —— 宁可不补发原生事件，
 * 也不往页面塞它本来收不到的 `drop`。
 *
 * @param session - 已连上的会话
 * @param selector - 源元素选择器
 * @returns `{ draggable, text }`（失败时 `draggable:false`）
 */
async function dragSourceFacts(session: CdpSession, selector: string): Promise<{ draggable: boolean; text: string }> {
  const raw = await session.evaluate(`(() => {
    const el = ${buildFinder(selector)}
    if (!el) return { draggable: false, text: '' }
    return { draggable: el.draggable === true, text: String(el.textContent ?? '').trim().slice(0, 200) }
  })()`) as { draggable?: unknown; text?: unknown } | null
  return {
    draggable: raw !== null && typeof raw === 'object' && raw.draggable === true,
    text: raw !== null && typeof raw === 'object' && typeof raw.text === 'string' ? raw.text : '',
  }
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
 * `reset: true` → Emulation.clearDeviceMetricsOverride（复原）+ **复核**。
 *
 * ⚠️ 2026-11-07 实机结论（rc3 / Electron 43 / Chromium 150，CDP 实测）：
 * `Emulation.clearDeviceMetricsOverride` 的应答**不代表视口真的复原了**。
 * device-metrics override 是**按 CDP 会话（agent）持有**的：
 * - 没设过 override 的会话发 clear 是**静默 no-op**（命令返回 `{}`，视口一动不动）；
 * - 一个会话的 clear 只摘掉它自己那层，摘完还可能回落到**前一个会话残留的那层**
 *   （实测：B 设 700x400 → B clear → 回到 A 的 900x600，而不是真实窗口尺寸）；
 * - 因此「上一个会话（尤其崩掉的会话）留下的 override」**新会话清不掉**，页面只有
 *   重载（`Page.reload`，实测能回落到真实 1280x860）或重启目标实例才回到真实窗口。
 *
 * 所以这里 clear 之后必须**重新测量**：仍 `emulated` 就抛具名错误
 * `cdp/viewport-not-restored`，绝不让调用方以为复原成功、继续拿假视口截图。
 *
 * @param session - 已连上的会话
 * @param opts - `{ width, height }` 或 `{ reset: true }`
 * @throws {CdpError} reset 后视口仍被覆盖（`cdp/viewport-not-restored`）
 */
export async function resize(
  session: CdpSession,
  opts: ResizeOptions | { reset: true },
): Promise<void> {
  if ('reset' in opts && opts.reset === true) {
    // force：本会话可能确实设过 override，而测量在 outer 量不出来（无头/隐藏窗口）时
    // 判 `unmeasurable`、看不出覆盖 —— 不强制 clear 就会把自己的那层留下来。
    const outcome = await ensureRealViewport(session, { force: true })
    /**
     * 什么时候还要再补一刀（重载页面）：
     *  - `!restored`：clear 是 no-op，残留 override 清不掉（实机主因）；
     *  - `geometry === 'unmeasurable'`：**量不出 outer**（窗口隐藏/被遮挡）时判据本身失明 ——
     *    此时 clear 后的复核只能说「看不出被覆盖」，不能说「已经复原」。实测就踩过：
     *    这种状态下复位返回成功，但 `inner` 仍是上一案的 1219x427，下一案又踩同一坑。
     *    重载是幂等且廉价的，宁可多刷一次页面，也不要留一个看不见的假视口。
     */
    const needReload = !outcome.restored || outcome.viewport.geometry === 'unmeasurable'
    if (needReload) {
      /**
       * **自愈一次：重载页面**（2026-11-07 rc3 实机）。
       *
       * 只抛错是不够的：实测一条 resize 用例把页面留在 1219x427 之后，**同一轮里后续
       * 每一条用例都在开局 fail-closed**（残留 override 新会话清不掉），一次全量 run
       * 被一条用例整死；而 `Page.reload()` 能把它拉回真实窗口（实测 1280x860）。
       * 所以先把「能救的救掉」，救不回来才失败关闭 —— 判据仍然是**实测**，不是应答。
       */
      const reload = await reloadPageAndWait(session)
      const after = await ensureRealViewport(session, { force: true })
      if (after.restored) {
        return
      }
      throw new CdpError(
        VIEWPORT_NOT_RESTORED,
        'Emulation.clearDeviceMetricsOverride 已下发、并重载页面复核，视口仍未恢复到真实窗口'
        + `（重载后实测 ${describeViewport(after.viewport)}；重载 ${reload.reloaded ? '已执行' : '未执行'}`
        + `，耗时 ${reload.waitedMs}ms）。`
        + 'override 按 CDP 会话持有：新会话清不掉前一会话残留的那层，'
        + '此时截图/断言不可作为真实窗口证据，需重启目标实例。',
        'command',
      )
    }
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

/** 页面视口的实测几何（window.innerWidth/innerHeight/outerWidth/outerHeight）。 */
export interface ViewportInfo {
  readonly innerWidth: number
  readonly innerHeight: number
  readonly outerWidth: number
  readonly outerHeight: number
  /**
   * 判定结果的**兼容布尔**：等价于 `geometry === 'emulated'`（旧 CTS 只读这个字段）。
   *
   * 判据：`innerWidth !== outerWidth || innerHeight !== outerHeight` —— 真实窗口下
   * inner === outer；一旦不等，说明有 override 残留或窗口被压小，**截图不可作为
   * 真实窗口证据**（2026-11-02 事故：视口被钉在 1280x620 而真实窗口 1280x860，
   * 9 张截图作废 + 误判产品缺陷）。
   *
   * ⚠️ 视口**测不出来**时（见 `geometry: 'unmeasurable'`）本字段为 `false`，
   * 但 `false` 在这里**不等于「真实」** —— 判真实必须看 `geometry === 'real'`。
   */
  readonly emulated: boolean
  /**
   * 几何可判定性（三态，T1）：
   * - `real` —— inner === outer 且四元组都是有限正数 ⇒ 可作为**真实窗口证据**；
   * - `emulated` —— 已知 override 生效（调用方报 `overrideActive`）或 inner !== outer
   *   ⇒ 截图不可作为真实窗口证据；
   * - `unmeasurable` —— `outer <= 0` 或非有限（无头/被隐藏/窗口未创建）⇒ **什么都
   *   证明不了**：既不能判真实，也不能判模拟。此时截图可以继续产出，但必须标明
   *   unverified，且**不得**当作真实窗口证据。
   */
  readonly geometry: 'real' | 'emulated' | 'unmeasurable'
}

/**
 * 一次 evaluate 读回视口四元组（innerWidth/innerHeight/outerWidth/outerHeight）。
 *
 * 供截图前校验「视口是真实的」用；读失败由调用方决定降级策略（本函数只抛）。
 *
 * ⚠️ `outerWidth/outerHeight` 在无头环境（Xvfb/离屏窗口）会是 0。旧实现直接拿
 * `inner !== outer` 判 emulated ⇒ 无头下**恒判模拟视口**，而这个判定既假又不可反驳。
 * 故 outer 不可用时判 `unmeasurable`（不把 emulated 当 true，也不当 real）。
 *
 * @param session - 已连上的会话
 * @param opts - `{ overrideActive?: boolean }`：调用方**已知**本次会话设过
 *   `Emulation.setDeviceMetricsOverride` 且未复原时置 true —— 这时无需测量即可判
 *   `emulated`（比测量更可靠：override 生效中 inner/outer 可能恰好相等）。
 * @returns 视口几何 + 三态判定
 */
export async function readViewport(
  session: CdpSession,
  opts: { overrideActive?: boolean } = {},
): Promise<ViewportInfo> {
  const raw = await session.evaluate(`JSON.stringify({
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    outerWidth: window.outerWidth, outerHeight: window.outerHeight,
  })`) as string
  if (typeof raw !== 'string') {
    throw new CdpError('cdp/viewport-unreadable', `视口读取失败：evaluate 返回 ${JSON.stringify(raw)}`, 'evaluate')
  }
  const vp = JSON.parse(raw) as { innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number }
  const nums = [vp.innerWidth, vp.innerHeight, vp.outerWidth, vp.outerHeight]
  const allFinite = nums.every(n => typeof n === 'number' && Number.isFinite(n))
  /** outer 是否给出了可用的窗口几何（0/非有限 = 量不到窗口外框）。 */
  const outerUsable = allFinite && vp.outerWidth > 0 && vp.outerHeight > 0
  // 优先级：已知 override 生效 > 量不出外框 > inner/outer 不等 > 真实。
  const geometry: ViewportInfo['geometry'] = opts.overrideActive === true
    ? 'emulated'
    : !outerUsable
      ? 'unmeasurable'
      : vp.innerWidth !== vp.outerWidth || vp.innerHeight !== vp.outerHeight
        ? 'emulated'
        : 'real'
  return {
    innerWidth: vp.innerWidth,
    innerHeight: vp.innerHeight,
    outerWidth: vp.outerWidth,
    outerHeight: vp.outerHeight,
    emulated: geometry === 'emulated',
    geometry,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 残留 override 的复原与复核（2026-11-07 事故：305 张假视口截图）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 视口无法恢复真实的具名错误码。
 *
 * 语义：`Emulation.clearDeviceMetricsOverride` 已下发（或目标本来就没被我们覆盖），
 * 但**复核实测**仍是 emulated —— 也就是说这个页面的视口不真实、截图不能当证据。
 * 调用方必须**失败关闭**（不许继续 click/assert/screenshot 假装完成）。
 */
export const VIEWPORT_NOT_RESTORED = 'cdp/viewport-not-restored'

/** clear 后复核的轮询参数（渲染器重排是异步的，clear 的应答早于重排完成）。 */
export interface ViewportRestoreOptions {
  /** 最多复核几次（>=1，默认 3）。 */
  readonly attempts?: number
  /** 每次复核前的等待（ms，默认 90）。 */
  readonly delayMs?: number
  /**
   * 强制先发 clear，不看开局测量（默认 false）。
   *
   * 用于「本会话**确实下发过** setDeviceMetricsOverride」的收尾：即使当下一测就是
   * 真实视口，也要摘掉自己那层（自己设的层自己清得掉），再复核。
   */
  readonly force?: boolean
}

/** 一次「视口是否真实」的复原结论。 */
export interface ViewportRestoreOutcome {
  /** 复核后的实测视口。 */
  readonly viewport: ViewportInfo
  /** 本次是否真的下发过 `Emulation.clearDeviceMetricsOverride`。 */
  readonly cleared: boolean
  /**
   * 复核结论：`viewport.geometry !== 'emulated'`。
   *
   * ⚠️ `restored === true` 且 `viewport.geometry === 'unmeasurable'` 时只代表
   * 「没证据说它被覆盖」，不代表「已认证真实」（无头/隐藏窗口量不到 outer）。
   */
  readonly restored: boolean
}

/** 视口几何的短描述（错误信息/证据里用）。 */
export function describeViewport(vp: ViewportInfo): string {
  return `inner=${vp.innerWidth}x${vp.innerHeight}, outer=${vp.outerWidth}x${vp.outerHeight}`
}

/** 可注入的等待（测试不想真的 sleep 时替换掉）。 */
function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * 重载目标页并等它回到可用状态（**视口残留的最后一招**）。
 *
 * 为什么必须有这一步（2026-11-07 rc3 实机）：残留的 device-metrics override 新会话
 * `clear` 不掉，只有 `Page.reload()` 能让页面回落到真实窗口尺寸。实测一条 resize 用例
 * 留下 1219x427 后，**同一轮后续用例全部开局 fail-closed** —— 装置必须能自己把页面救回来，
 * 否则一次全量 run 会被一条用例整死。
 *
 * 就绪判据只看两件事（都可页内求值、不依赖网络）：`readyState === 'complete'` 且
 * `document.body` 存在。**不**在这里判视口 —— 那是调用方 `ensureRealViewport` 的职责，
 * 两件事分开判，失败时才说得清是哪一步没成。
 *
 * 失败不抛错（返回 `reloaded: false` 的语义由调用方决定）：重载是**补救**动作，
 * 补救失败要让上层按原判据失败关闭，而不是换成一个新的错误码。
 *
 * @param session - 已连上的会话
 * @param opts - 总预算（默认 8s）与轮询间隔（默认 120ms）
 * @returns 是否执行了 reload、等待了多久
 */
export async function reloadPageAndWait(
  session: CdpSession,
  opts: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<{ reloaded: boolean; waitedMs: number }> {
  const timeoutMs = Math.max(200, Math.trunc(opts.timeoutMs ?? 8_000))
  const pollMs = Math.max(20, Math.trunc(opts.pollMs ?? 120))
  const startedAt = Date.now()
  let reloaded = false
  try {
    // Page.enable 可能已开过；失败不致命（reload 本身不需要它）
    await session.send('Page.enable', {})
  } catch {
    // 忽略：只要 Page.reload 能下发就够
  }
  try {
    await session.send('Page.reload', { ignoreCache: false })
    reloaded = true
    /**
     * 重载后把窗口拉到前台：**被遮挡的窗口 `outer` 读作 0**，geometry 就变成
     * `unmeasurable`（判据失明，截图会被标 unverified）。重载本来就是「把页面弄回
     * 可控状态」，顺手激活窗口成本为零；失败也不致命（部分平台/无头下没有前台概念）。
     */
    try {
      await session.send('Page.bringToFront', {})
    } catch {
      // 忽略：没有前台概念的执行环境
    }
  } catch {
    return { reloaded: false, waitedMs: Date.now() - startedAt }
  }
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const ready = await session.evaluate(
        "(()=>document.readyState==='complete'&&!!document.body)()",
      )
      if (ready === true) return { reloaded, waitedMs: Date.now() - startedAt }
      /**
       * 明确答 `false` ⇒ 还在加载，继续等；**不是布尔**（假会话/求值被禁用/返回了对象）
       * ⇒ 这个会话根本不提供就绪信号，直接返回，绝不空等满预算。
       * 判据只认「页内确实给出了布尔」，杜绝把「问不出来」当成「还没好」。
       */
      if (typeof ready !== 'boolean') return { reloaded, waitedMs: Date.now() - startedAt }
    } catch {
      // 重载中求值失败是正常的（上下文被销毁），继续轮询
    }
    await waitMs(pollMs)
  }
  return { reloaded, waitedMs: Date.now() - startedAt }
}

/**
 * 复核视口是否真实；发现残留 override 则 best-effort clear 并重新测量。
 *
 * 用在两个地方，语义一致：
 * - `resize({ reset: true })` —— reset 步骤后必须复核，否则「reset 成功」是假的；
 * - `runScript` 每案开始 —— 先自愈上一个案/上一个会话留下的残留 override。
 *
 * 与「只是再发一次 clear」的区别：**不信应答、只信实测**。clear 是 no-op 的三种
 * 实机情形见 `resize` 的注释；因此这里 clear 之后一定轮询复测，测不出来就
 * `restored: false` 交给调用方失败关闭。
 *
 * @param session - 已连上的会话
 * @param opts - 复核次数/间隔
 * @returns 复核后的视口 + 是否清过 + 是否恢复
 * @throws {CdpError} 首测/复测读不到视口（`cdp/viewport-unreadable`）
 */
export async function ensureRealViewport(
  session: CdpSession,
  opts: ViewportRestoreOptions = {},
): Promise<ViewportRestoreOutcome> {
  const attempts = Math.max(1, Math.trunc(opts.attempts ?? 3))
  const delayMs = Math.max(0, Math.trunc(opts.delayMs ?? 90))
  if (opts.force !== true) {
    const pre = await readViewport(session)
    if (pre.geometry !== 'emulated') {
      return { viewport: pre, cleared: false, restored: true }
    }
  }
  await session.send('Emulation.clearDeviceMetricsOverride', {})
  let last: ViewportInfo | undefined
  for (let i = 0; i < attempts; i++) {
    if (delayMs > 0) await waitMs(delayMs)
    last = await readViewport(session)
    if (last.geometry !== 'emulated') {
      return { viewport: last, cleared: true, restored: true }
    }
  }
  return { viewport: last!, cleared: true, restored: false }
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
