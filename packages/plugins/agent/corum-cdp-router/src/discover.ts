/**
 * discover.ts — 自动发现本机正在运行的 Corum 实例（解决「端口不能写死」）。
 *
 * ## 为什么需要它
 *
 * 原实现把 target 写死在配置文件里（示例就是 `port: 9333`）。但：
 *  - 不同的人、不同的机器、不同的 combo，CDP 端口都不一样；
 *  - 同一个用户也可能同时跑主实例、验证实例、旧版本实例；
 *  - 手写配置必然过时（实例重启换端口后配置就指向空气）。
 *
 * 所以「发现」必须是一等能力：**扫描 → 探测 → 识别 → 产出 target 清单**，
 * 用户只在需要时用配置显式覆盖或补充。
 *
 * ## 三个发现源（按可信度排序）
 *
 * 1. **pid 记录文件**（最准，带 home/combo/role/版本）：
 *    `<home>/run/{pack-<port>.pid, verify-*.pid, host.pid}`。
 *    由 `corum-instance.sh` 启动时写，字段含 `debugPort` / `home` / `kind`。
 *
 * 2. **CDP `/json/version`**（验证真实身份）：
 *    端口上跑的是不是 Corum、什么版本，只有它说了算。
 *    注意：Electron 会为每个渲染进程开一堆内部端口（实测 18488/30500/39024…），
 *    这些**不是** CDP 调试端口，`/json/version` 会给出非 Corum 的 User-Agent 或直接不通。
 *
 * 3. **监听端口扫描**（兜底，最慢）：
 *    从 `lsof -nP -iTCP -sTCP:LISTEN` 里挑本机回环端口逐个探 —— 只在显式要求时做，
 *    因为它慢且噪音大。
 *
 * ## 识别 Corum 的依据（不猜）
 *
 * `/json/version` 的 `User-Agent` 含 `corum-desktop/<版本>`。
 * 这是桌面壳自己设的，比「浏览器名 = Chrome」精确得多（所有 Electron 都长这样）。
 *
 * @module @corum/cdp-target-router/discover
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 实例角色。 */
export type InstanceRole = 'main' | 'verify' | 'other'

/** pid 记录文件里能出现的字段（两种形态的并集）。 */
export interface PidRecord {
  pid: number
  /** combo 名（pack-<port>.pid / verify-*.pid 才有）。 */
  combo?: string | undefined
  /** 该实例的 CORUM_HOME。 */
  home?: string | undefined
  /**
   * CDP 调试端口（原始值）。
   *
   * ⚠️ 可能是 `''`：`host.pid` 记的 host 子进程不持有 CDP 端口（端口在宿主主进程上）。
   * 这是**合法形态**，不是配置错误 —— 空值记录会被静默跳过。
   */
  debugPort: number | string | undefined
  /** 启动时刻（epoch ms）。 */
  startedAt?: number | undefined
  /** `dev` / `packaged`。 */
  kind?: string | undefined
  /** 旧形态里偶尔出现的模式标记。 */
  mode?: string | undefined
}

/** `readPidRecords` 读出的单条记录（带派生字段）。 */
export interface PidRecordEntry extends PidRecord {
  /** 归一化后的端口。 */
  port: number
  /** 记录文件绝对路径。 */
  file: string
  /** 记录里带的 home，没有则回退到传入的 home。 */
  homeFromRecord: string
}

/** `probePort` 的返回。 */
export interface ProbeResult {
  /** 端口可达（`/json/version` 能访问）—— **这是「是不是 CDP 端点」的唯一硬判据**。 */
  reachable: boolean
  /**
   * 是否 Corum 实例（UA 含 `corum-desktop/`）。
   *
   * ⚠️ 这只是**补充信息**，不是「能不能作为目标」的判据：本插件的目标是
   * **任意 CDP 端点**（Chrome / 任意 Electron 应用 / 其它 CDP 兼容浏览器）。
   * 之前把它当硬判据，导致只能测 Corum，为每个客户端各配一份 MCP 的老问题照旧。
   */
  isCorum: boolean
  /** 端点类型（由 UA + Browser 字段粗判）：`corum` / `chrome` / `electron` / `unknown`。 */
  kind: CdpEndpointKind
  /** Electron 版本（UA `corum-desktop/<ver>` 或 `Electron/<ver>`）；非 Electron 为 null。 */
  electronVersion: string | null
  /** 应用名（UA 里若带 `<name>/<ver>` 形态则取 name，如 `corum-desktop`）。 */
  appName: string | null
  userAgent: string | null
  /** `/json/version` 的 Browser 字段（如 `Chrome/150.0.7871.224`）。 */
  browser: string | null
  /** page target 数量（0 = 起来了但没窗口）。 */
  targetCount: number
}

/** CDP 端点类型。 */
export type CdpEndpointKind = 'corum' | 'chrome' | 'electron' | 'unknown'


/** `readAppVersion` 的返回（成功形态）。 */
export interface AppVersionIdentity {
  ok: true
  releaseVersion: string | null
  releaseCommit: string | null
  rev: string | null
  bootEntries: number | null
  origin: string | null
  pageUrl: string | null
  error?: undefined
}

/** `readAppVersion` 的返回（失败形态）。 */
export interface AppVersionFailure {
  ok: false
  releaseVersion: null
  releaseCommit: null
  rev: null
  bootEntries: null
  origin: null
  pageUrl: null
  error: string
}

/** `readAppVersion` 的返回（成功或失败的联合）。 */
export type AppVersionResult = AppVersionIdentity | AppVersionFailure

/** 一次发现产出的 target。 */
export interface DiscoveredTarget {
  /** CDP 端口。 */
  port: number
  /** 建议的 target id（来自 pid 记录的 role/combo）。 */
  id: string
  /** 该实例的 CORUM_HOME（pid 记录里带的）。 */
  home: string | null
  /** `dev` / `packaged`。 */
  kind: string | null
  /** `main` / `verify` / `other`（由端口 + home 推断；非 Corum 端点多为 `other`）。 */
  role: InstanceRole
  /**
   * 端点类型：`corum` / `chrome` / `electron` / `unknown`。**不参与可用性判定**。
   *
   * ⚠️ 字段名叫 `endpointKind` 而不是 `kind`：`kind` 已被「dev / packaged」
   * （`corum-instance.sh` 的启动模式）占用，同名会让两者混淆。
   */
  endpointKind: CdpEndpointKind
  /** 是否 Corum 实例（补充信息，不是可用性判据）。 */
  isCorum: boolean
  /** 应用名（UA 里若带 vendor token，如 `corum-desktop`）；纯 Chrome 为 null。 */
  appName: string | null
  /** Electron 版本（来自 UA，仅作身份佐证）。 */
  electronVersion: string | null
  /** 基座版本（`__DSH_BOOT__.release.version`）；旧基座为 null。 */
  releaseVersion: string | null
  /** 构建 commit 短 hash。 */
  releaseCommit: string | null
  /** 实例启动时刻（ISO，来自 pid 记录）。 */
  startedAt: string | null
  /** 发现来源：`pid-file` / `port-scan` / `config`。 */
  source: string
}

/** `discover` 的选项。 */
export interface DiscoverOptions {
  /** 要扫 pid 记录的 home 列表；缺省为 `defaultHomes()`。 */
  homes?: string[]
  /** 是否做端口扫描兜底（慢，默认 false）。 */
  scanPorts?: boolean
  /** 端口扫描上限（默认 40 个）。 */
  maxScan?: number
}

/** `discover` 的返回。 */
export interface DiscoverResult {
  targets: DiscoveredTarget[]
  problems: string[]
}

/** `defaultHomes` 的选项（便于测试注入环境）。 */
export interface DefaultHomesEnv {
  CORUM_HOME?: string
  DSH_HOME?: string
  HOME?: string
}

/** `readPidRecords` 的返回。 */
export interface ReadPidRecordsResult {
  records: PidRecordEntry[]
  problems: string[]
}

/** `listListeningPorts` 的返回。 */
export interface ListPortsResult {
  ports: number[]
  problems: string[]
}

/** `discover` 内部构造 target 用的可选项（字段对齐 `DiscoveredTarget`，但允许省略）。 */
interface DiscoveredTargetInit {
  port: number
  id: string
  role: InstanceRole
  electronVersion: string | null
  releaseVersion: string | null
  releaseCommit: string | null
  source: string
  home?: string | null
  kind?: string | null
  startedAt?: string | null
  endpointKind?: CdpEndpointKind
  isCorum?: boolean
  appName?: string | null
}

/** 把可选项补齐成 `DiscoveredTarget`（缺省字段填 null）。 */
function makeTarget(init: DiscoveredTargetInit): DiscoveredTarget {
  return {
    port: init.port,
    id: init.id,
    role: init.role,
    electronVersion: init.electronVersion,
    releaseVersion: init.releaseVersion,
    releaseCommit: init.releaseCommit,
    source: init.source,
    home: init.home ?? null,
    kind: init.kind ?? null,
    startedAt: init.startedAt ?? null,
    endpointKind: init.endpointKind ?? 'unknown',
    isCorum: init.isCorum ?? false,
    appName: init.appName ?? null,
  }
}

/**
 * 推断实例角色。
 *
 * 判定顺序（先看端口，再看 home 名，最后看 home 是不是用户主 home）：
 *  1. 9222 ⇒ `main`（桌面壳把主实例固定在这个端口）
 *  2. home 路径里含 `.corum-verify-home` 或位于临时目录 ⇒ `verify`（隔离实例）
 *  3. home === `~/.corum` ⇒ `main`（用户自己的 home，即使换了端口也还是主实例）
 *  4. 其余 ⇒ `other`
 *
 * 为什么第 3 条必须存在：实测（2026-10-30）主实例当时并不在 9222（9222 空着），
 * 而是在 9333 上跑、home 就是 `~/.corum`。只按端口判会把主实例误标成 `other`，
 * 那会让「不得碰主实例」的护栏失效 —— 这是危险方向的误判，宁可按 home 兜住。
 *
 * @param port - CDP 端口
 * @param home - CORUM_HOME
 * @param userHome - 用户 home（`os.homedir()`），用于第 3 条
 * @returns `'main'` / `'verify'` / `'other'`
 */
export function inferRole(
  port: number,
  home: string | null,
  userHome: string = os.homedir(),
): InstanceRole {
  if (port === 9222) return 'main'
  if (typeof home === 'string' && home !== '') {
    const resolved = path.resolve(home)
    if (resolved.includes('.corum-verify-home')) return 'verify'
    // 临时目录下的 home 一律当隔离实例（/tmp /var/folders 等）
    const tmp = path.resolve(os.tmpdir())
    if (resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`)) return 'verify'
    // 用户主 home：这是主实例（与端口无关）
    if (resolved === path.resolve(userHome, '.corum')) return 'main'
  }
  return 'other'
}

/**
 * 读 `$CORUM_HOME/run/` 下的全部 pid 记录。
 *
 * 记录格式（corum-instance.sh 写的，几种形态都见得到）：
 *  - `{ pid, combo, home, debugPort, startedAt, kind }`  ← pack-<port>.pid / verify-*.pid
 *  - `{ pid, debugPort, startedAt }`                    ← host.pid
 *
 * 解析失败的记录**跳过并记入 problems**，不静默吞掉（坏记录本身是诊断信息）。
 *
 * @param home - 要扫描的 home
 * @returns 记录与 problems；home 不存在时返回空且不抛错
 */
export function readPidRecords(home: string): ReadPidRecordsResult {
  const runDir = path.join(home, 'run')
  const records: PidRecordEntry[] = []
  const problems: string[] = []
  let names: string[]
  try {
    names = fs.readdirSync(runDir)
  } catch {
    return { records, problems }
  }
  for (const name of names) {
    if (!name.endsWith('.pid')) continue
    const file = path.join(runDir, name)
    try {
      const raw = fs.readFileSync(file, 'utf8').trim()
      if (raw === '') continue
      const parsed = JSON.parse(raw) as Partial<PidRecord> & Record<string, unknown>
      /**
       * ⚠️ `debugPort` 为空**不是错误**，是一个合法形态。
       *
       * 实测（2026-10-29）：`<home>/run/host.pid` 记的是 **host 子进程**
       * （`node .../host/lib/bridge.js`），它的 `debugPort` 就是 `""` —— 因为
       * CDP 端口挂在**宿主主进程**上，不在 host 子进程上。把它记成
       * 「debugPort 非法」会让每次发现都产出 1 条无意义噪音，掩盖真正的问题。
       *
       * 所以：空值 ⇒ 静默跳过该记录（它不携带 CDP 信息，也就无法成为 target）；
       * 只有「非空但确实非法」（`"abc"`、`70000`、`-1`）才算配置错误进 problems。
       */
      const rawPort = parsed.debugPort
      const isBlankPort = rawPort === '' || rawPort === null || rawPort === undefined
      if (isBlankPort) continue
      const port = Number(rawPort)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        problems.push(`${file}: debugPort 非法（${JSON.stringify(rawPort)}）`)
        continue
      }
      records.push({
        pid: Number(parsed.pid),
        combo: typeof parsed.combo === 'string' ? parsed.combo : undefined,
        home: typeof parsed.home === 'string' ? parsed.home : undefined,
        debugPort: port,
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined,
        kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
        mode: typeof parsed.mode === 'string' ? parsed.mode : undefined,
        port,
        file,
        homeFromRecord: typeof parsed.home === 'string' ? parsed.home : home,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      problems.push(`${file}: 解析失败（${msg}）`)
    }
  }
  return { records, problems }
}

/**
 * 探测某端口的 CDP `/json/version`，判定它是不是 Corum。
 *
 * @param port - 端口
 * @param timeoutMs - 超时
 * @returns 探测结果；不可达时返回全 false/null 的 blank 对象，不抛错
 */
export async function probePort(port: number, timeoutMs: number = 900): Promise<ProbeResult> {
  const blank: ProbeResult = {
    reachable: false,
    isCorum: false,
    kind: 'unknown',
    electronVersion: null,
    appName: null,
    userAgent: null,
    browser: null,
    targetCount: 0,
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal })
    if (!res.ok) return blank
    const info = (await res.json()) as { 'User-Agent'?: unknown; Browser?: unknown }
    const ua = typeof info['User-Agent'] === 'string' ? info['User-Agent'] : null
    const browserField = typeof info.Browser === 'string' ? info.Browser : null

    /**
     * 识别端点类型 —— 但**识别结果不作为可用性判据**。
     *
     * 本插件的目标是「任意 CDP 端点」：Chrome 与任意 Electron 应用都要能当目标，
     * 因为用户的真实痛点是「chrome-devtools-mcp 的 MCP 配置必须写死端口，
     * 每个客户端各配一份」。只认 Corum 就等于没解决那个问题。
     *
     * 判据顺序：
     *  1. UA 含 `corum-desktop/` ⇒ corum（且能从这里读 Electron 版本）
     *  2. UA 含 `Electron/`       ⇒ electron（Electron 版本从这取）
     *  3. UA 含 `Chrome/` 且不含 Electron ⇒ chrome（含 Chromium/Edge/Brave 等）
     *  4. 其余 ⇒ unknown（只要能连上仍是合法目标）
     *
     * ⚠️ 实测（2026-10-30）：`corum-desktop/<ver>` 里的 ver 是 **Electron 版本**
     * （如 43.4.1），不是应用版本（0.7.0）。绝不能当 appVersion 报出去。
     */
    const corumMatch = /\bcorum-desktop\/([0-9][0-9A-Za-z.\-]*)/.exec(ua ?? '')
    const electronMatch = /\bElectron\/([0-9][0-9A-Za-z.\-]*)/.exec(ua ?? '')
    const chromeMatch = /\b(?:Chrome|Chromium)\/([0-9][0-9A-Za-z.\-]*)/.exec(ua ?? '')
    const kind: CdpEndpointKind = corumMatch !== null
      ? 'corum'
      : electronMatch !== null
        ? 'electron'
        : chromeMatch !== null
          ? 'chrome'
          : 'unknown'
    const electronVersion = corumMatch?.[1] ?? electronMatch?.[1] ?? null
    // 应用名：取 UA 里第一个非标准 vendor token（如 corum-desktop/0.7.0）
    const appNameMatch = /\b([a-z][a-z0-9-]{2,})\/[0-9][0-9A-Za-z.\-]*/.exec(ua ?? '')
    const APP_NAME_DENYLIST = new Set(['mozilla', 'applewebkit', 'chrome', 'chromium', 'electron', 'safari', 'gecko', 'version'])
    const appName = appNameMatch !== null && !APP_NAME_DENYLIST.has(appNameMatch[1]!.toLowerCase())
      ? appNameMatch[1]!
      : null
    // 再数一下 page target：Corum 主窗一定有一个 http 页面
    let targetCount = 0
    try {
      const listRes = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal })
      if (listRes.ok) {
        const list = (await listRes.json()) as Array<{ type?: unknown }>
        targetCount = list.filter((t) => t?.type === 'page').length
      }
    } catch {
      /* list 不通不影响身份判定 */
    }
    return {
      reachable: true,
      isCorum: kind === 'corum',
      kind,
      electronVersion,
      appName,
      userAgent: ua,
      browser: browserField,
      targetCount,
    }
  } catch {
    return blank
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 列出本机的监听端口（仅回环，去重）。
 *
 * macOS / Linux 走 `lsof`；Windows 走 `netstat -ano`。
 * 命令不可用时返回空数组并给出 problem —— **不抛错**，因为发现是尽力而为。
 *
 * @returns 端口列表与 problems
 */
export function listListeningPorts(): ListPortsResult {
  const ports = new Set<number>()
  const problems: string[] = []
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
        timeout: 5000,
      })
      for (const line of out.split('\n')) {
        const m = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/i.exec(line)
        if (m) ports.add(Number(m[1]))
      }
    } else {
      const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
        encoding: 'utf8',
        timeout: 5000,
      })
      for (const line of out.split('\n')) {
        const m = /127\.0\.0\.1:(\d+)\s+\(LISTEN\)/.exec(line)
        if (m) ports.add(Number(m[1]))
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    problems.push(
      `列监听端口失败（${process.platform === 'win32' ? 'netstat' : 'lsof'}）：${msg}`,
    )
  }
  return { ports: [...ports].sort((a, b) => a - b), problems }
}

/**
 * 建议的 target id。
 *
 * 规则（尽量可读且稳定，不随端口变）：
 *  - `main` 端口 ⇒ `main`
 *  - 验证 home ⇒ `verify`（同角色多实例时后缀端口）
 *  - 其余用 combo 名（`coding` 等）；再不行用端口
 *
 * @param rec - pid 记录（含派生字段）
 * @param port - 端口
 * @returns 建议的 id
 */
export function suggestId(rec: PidRecordEntry, port: number): string {
  const role = inferRole(port, rec.homeFromRecord)
  if (role === 'main') return 'main'
  if (role === 'verify') return 'verify'
  if (typeof rec.combo === 'string' && rec.combo !== '') return rec.combo
  return `port-${port}`
}

/**
 * 默认要扫的 home 列表：当前进程的 CORUM_HOME、DSH_HOME、`~/.corum`，
 * 以及 `/tmp/*` 下带 `.corum-verify-home` 的隔离实例（只列一层目录，不递归）。
 *
 * @param env - 可选的环境变量覆盖（便于测试）
 * @returns 去重后的 home 列表
 */
export function defaultHomes(env?: DefaultHomesEnv): string[] {
  const homes = new Set<string>()
  const src = env ?? process.env
  for (const key of ['CORUM_HOME', 'DSH_HOME'] as const) {
    const v = src[key]
    if (typeof v === 'string' && v !== '') homes.add(path.resolve(v))
  }
  const homeDir = typeof src.HOME === 'string' && src.HOME !== '' ? src.HOME : os.homedir()
  homes.add(path.join(homeDir, '.corum'))
  // 隔离实例：/tmp/<stamp>/.corum-verify-home
  try {
    for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(os.tmpdir(), entry.name, '.corum-verify-home')
      if (fs.existsSync(candidate)) homes.add(candidate)
    }
  } catch {
    /* tmpdir 读不到就算了 */
  }
  return [...homes]
}

/**
 * 经 CDP 在目标页内读**真实版本身份**。
 *
 * ## 为什么必须进页面读（实测 2026-10-30）
 *
 * 三条看似能用的路子全部失败或误导，只有一条成立：
 *
 * | 来源 | 实测结果 |
 * |---|---|
 * | `/json/version` 的 UA `corum-desktop/43.4.1` | 那是 **Electron 版本**，与产品版本无关 |
 * | 渲染进程 `process.env.CORUM_APP_VERSION` | **读不到**：`contextIsolation` 下渲染进程没有 `process`（实测 `hasProcess=false`） |
 * | `window.__DSH_BOOT__` 的 `rev`/`batches` | 有，但只是构建指纹/条目批次 |
 * | **`window.__DSH_BOOT__.release`** | ✅ **`{version:"0.2.1-rc.3", commit:"be72761"}`** —— 这才是基座版本 |
 *
 * 注意 `release` 是 rc3 新增字段：0.1.5 基座没有它（实测 `undefined`）。
 * 所以「读不到 release」本身就是一条信息 —— 它说明目标可能是旧基座，
 * 不能当成「读取失败」静默掉。
 *
 * ## 返回什么
 *
 *  - `releaseVersion`：基座版本（如 `0.2.1-rc.3`）；旧基座为 `null`
 *  - `releaseCommit`：构建 commit 短 hash
 *  - `rev`：客户端构建指纹（用于判断是不是同一份产物）
 *  - `bootEntries`：启动条目数（证明启动完成）
 *  - `origin`：页面 origin（必须是 loopback http）
 *
 * @param port - CDP 端口
 * @param timeoutMs - 整体超时
 * @returns 身份快照；失败时 `ok:false` 且带 `error`
 */
export async function readAppVersion(
  port: number,
  timeoutMs: number = 2500,
): Promise<AppVersionResult> {
  const fail = (error: string): AppVersionFailure => ({
    ok: false,
    releaseVersion: null,
    releaseCommit: null,
    rev: null,
    bootEntries: null,
    origin: null,
    pageUrl: null,
    error,
  })
  let targets: Array<{ type?: unknown; url?: unknown; webSocketDebuggerUrl?: unknown }>
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!res.ok) return fail(`/json/list HTTP ${res.status}`)
    targets = (await res.json()) as Array<{
      type?: unknown
      url?: unknown
      webSocketDebuggerUrl?: unknown
    }>
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return fail(`/json/list 不可达：${msg}`)
  }
  // 只找真正的 Corum 主窗：loopback http 页面（启动动画页是 corumapp://）
  const page = targets.find(
    (t) => t?.type === 'page' && /^http:\/\/127\.0\.0\.1:/.test(String(t.url)),
  )
  if (page === undefined) return fail('没有 loopback http 页面（可能还在启动动画）')
  if (typeof page.webSocketDebuggerUrl !== 'string')
    return fail('页面缺少 webSocketDebuggerUrl')
  if (typeof globalThis.WebSocket !== 'function')
    return fail('当前 Node 没有内置 WebSocket（需 >= 22）')

  const expression = `(function(){
    var boot = window.__DSH_BOOT__ || {};
    var rel = boot.release || null;
    return {
      releaseVersion: rel && typeof rel.version === 'string' ? rel.version : null,
      releaseCommit: rel && typeof rel.commit === 'string' ? rel.commit : null,
      rev: typeof boot.rev === 'string' ? boot.rev : null,
      bootEntries: Object.keys(boot.entries || {}).length,
      origin: location.origin,
    };
  })()`

  return await new Promise<AppVersionResult>((resolve) => {
    let settled = false
    const done = (payload: AppVersionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve(payload)
    }
    const timer = setTimeout(() => done(fail(`读版本超时（${timeoutMs}ms）`)), timeoutMs)
    let socket: WebSocket
    try {
      socket = new globalThis.WebSocket(page.webSocketDebuggerUrl as string)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return done(fail(`连 CDP 失败：${msg}`))
    }
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { returnByValue: true, expression },
        }),
      )
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      let msg: {
        id?: number
        result?: { result?: { value?: unknown }; exceptionDetails?: unknown }
        error?: unknown
      }
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (msg.id !== 1) return
      const value = msg.result?.result?.value
      if (value === undefined || value === null) {
        return done(
          fail(
            `Runtime.evaluate 没返回值：${JSON.stringify(msg.result?.exceptionDetails ?? msg.error ?? null).slice(0, 160)}`,
          ),
        )
      }
      const v = value as {
        releaseVersion: string | null
        releaseCommit: string | null
        rev: string | null
        bootEntries: number
        origin: string
      }
      const identity: AppVersionIdentity = {
        ok: true,
        releaseVersion: v.releaseVersion ?? null,
        releaseCommit: v.releaseCommit ?? null,
        rev: v.rev ?? null,
        bootEntries: v.bootEntries ?? null,
        origin: v.origin ?? null,
        pageUrl: typeof page.url === 'string' ? page.url : null,
      }
      done(identity)
    })
    socket.addEventListener('error', () => done(fail('CDP WebSocket 错误')))
    socket.addEventListener('close', () => done(fail('CDP 连接被关闭')))
  })
}

/**
 * 自动发现本机所有 Corum 实例。
 *
 * @param options - 选项
 * @returns 发现的 targets（按 port 升序）与 problems
 */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoverResult> {
  const problems: string[] = []
  const seen = new Map<number, DiscoveredTarget>() // port -> DiscoveredTarget

  const homes = options.homes ?? defaultHomes()
  for (const home of homes) {
    const { records, problems: p } = readPidRecords(home)
    problems.push(...p)
    for (const rec of records) {
      if (seen.has(rec.port)) continue
      const info = await probePort(rec.port)
      if (!info.reachable) {
        // pid 记录在但端口不通：实例可能已退出（残留记录），记为 problem 供诊断
        problems.push(
          `${rec.file}: 记录了端口 ${rec.port}，但 /json/version 不可达（实例可能已退出）`,
        )
        continue
      }
      /**
       * ⚠️ **不要求是 Corum**。
       *
       * 用户动机（2026-10-29 原话）：「Google devtools 的 MCP 配置只能写死端口，
       * 如果不需要写死端口，根据扫描让 Agent 直接动态传参调工具就最好了」。
       *
       * 所以只要能连上 `/json/version`（= 合法 CDP 端点）、且有 page target，
       * 它就是可用目标 —— Chrome、任意 Electron 应用、其它 CDP 兼容浏览器都算。
       * 之前这里判 `!isCorum` 就跳过，等于把插件退化成「只能测 Corum」，
       * 那个写死端口的老问题照旧。
       */
      if (info.targetCount === 0) {
        // 可达但一个 page target 都没有（起来了没开窗、或是内部端口）
        problems.push(
          `${rec.file}: 端口 ${rec.port} 是 CDP 端点但没有页面 target（UA=${String(info.userAgent).slice(0, 50)}）`,
        )
        continue
      }
      const ident = await readAppVersion(rec.port)
      seen.set(
        rec.port,
        makeTarget({
          port: rec.port,
          id: suggestId(rec, rec.port),
          home: rec.homeFromRecord,
          kind: rec.kind ?? (rec.mode === 'dev' ? 'dev' : null),
          role: inferRole(rec.port, rec.homeFromRecord),
          electronVersion: info.electronVersion,
          releaseVersion: ident.ok ? ident.releaseVersion : null,
          releaseCommit: ident.ok ? ident.releaseCommit : null,
          startedAt:
            rec.startedAt === undefined ? null : new Date(Number(rec.startedAt)).toISOString(),
          source: 'pid-file',
          endpointKind: info.kind,
          isCorum: info.isCorum,
          appName: info.appName,
        }),
      )
    }
  }

  // 兜底：pid 记录没覆盖到的端口（用户手工起的实例、别的 home 等）
  if (options.scanPorts === true) {
    const { ports, problems: p } = listListeningPorts()
    problems.push(...p)
    let probed = 0
    for (const port of ports) {
      if (seen.has(port)) continue
      if (probed >= (options.maxScan ?? 40)) break
      probed += 1
      const info = await probePort(port, 400)
      /**
       * 同样不要求是 Corum —— 任何 CDP 端点都要能发现。
       * 但要求至少有 1 个 page target：Electron 会为每个渲染进程开一堆内部端口
       * （实测 18488 / 30500 / 39024…），它们 `/json/version` 也可能通，
       * 却没有 page，不是「可驱动的窗口」。
       */
      if (!info.reachable || info.targetCount === 0) continue
      const ident = await readAppVersion(port)
      seen.set(
        port,
        makeTarget({
          port,
          id: `discovered-${port}`,
          role: inferRole(port, null),
          electronVersion: info.electronVersion,
          releaseVersion: ident.ok ? ident.releaseVersion : null,
          releaseCommit: ident.ok ? ident.releaseCommit : null,
          source: 'port-scan',
          endpointKind: info.kind,
          isCorum: info.isCorum,
          appName: info.appName,
        }),
      )
    }
  }

  return { targets: [...seen.values()].sort((a, b) => a.port - b.port), problems }
}
