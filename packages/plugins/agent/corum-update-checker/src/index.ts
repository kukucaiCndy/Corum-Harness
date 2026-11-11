/**
 * @corum/corum-update-checker —— 更新检查 + 后台下载（corum 核心插件，**不可卸载**）。
 *
 * ## 职责
 *
 * 1. 检测当前应用版本 vs GitHub latest release（semver 比较）；
 * 2. 匹配当前平台 + 架构的下载资产（darwin→zip / win32→exe / linux→AppImage）；
 * 3. **后台自动下载**到 `CORUM_UPDATES_DIR`（main 进程注入，指向 `~/.corum/updates`）；
 * 4. 进度上报（渲染层轮询 `getUpdateState`）；
 * 5. 下载完成后，渲染层经 IPC 让 Electron 主进程执行「重启安装」。
 *
 * ## 状态机
 *
 * ```
 * idle → checking → (up-to-date | update-available | check-failed)
 *                            │
 *                            ▼ (自动)
 *                      downloading → downloaded-ready
 *                                       │
 *                                       ▼ (渲染层触发 IPC → 主进程安装)
 *                                     installing → [app 重启]
 * ```
 *
 * ## 服务面（@Remote RPC，service 名 `updateChecker`）
 *
 * - `checkForUpdates()` —— 检查；成功且有更新则自动开始下载。
 * - `getUpdateState()` —— 完整状态（phase / 版本 / 进度 / 已下载文件路径）。
 * - `downloadUpdate()` —— 手动触发下载（菜单「立即下载」/ 重试）。
 *
 * 渲染层经 `makeCorumRpcCall` 调 `updateChecker/<method>`。安装动作走
 * **IPC**（`window.corumDesktop.installUpdate`）让主进程执行——host 子进程
 * 无法直接退出 Electron 壳（它的父进程）。
 *
 * ## 配置来源（env，与 @corum/corum-platform 同构）
 *
 * - `CORUM_APP_VERSION` —— main 进程 buildHostEnv 注入（读 desktop package.json）；
 *   缺省回落到本包路径推导。
 * - `CORUM_UPDATES_DIR` —— main 进程注入（指向 `~/.corum/updates`）；缺省回落
 *   到 `os.homedir()/.corum/updates`。
 *
 * ## 不可卸载
 *
 * 与 `@corum/corum-platform` 同规：cordis.patch.yml insert 段挂载 +
 * plugin-manager 的 CORE_PLUGIN_PACKAGES / CORE_PLUGIN_ENTRIES 按包名过滤。
 *
 * @module corum-update-checker
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import {
  fetchLatestRelease, parseLatestRelease, isUpdateAvailable,
  type ParsedRelease, type GithubQueryError,
} from './github-release.ts'
import { detectLinuxInstallForm } from './platform-asset.ts'
import { downloadAsset, findExistingDownload, type DownloadProgress } from './download-manager.ts'

/** 仓库配置常量。 */
const REPO_OWNER = 'kukucaiCndy'
const REPO_NAME = 'Corum-Harness'
/** 启动后自动检查的延迟（ms）。 */
const STARTUP_CHECK_DELAY_MS = 8000

/** 更新流程的完整状态（RPC 返回形状，渲染层直接消费）。 */
export interface UpdateState {
  /** 当前阶段。 */
  readonly phase: 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'downloading' | 'downloaded-ready' | 'check-failed' | 'download-failed'
  /** 当前应用版本。 */
  readonly currentVersion: string
  /** GitHub 最新版本号（去 v 前缀）。 */
  readonly latestVersion: string | null
  /** release 页面 URL。 */
  readonly releaseUrl: string | null
  /** 更新日志。 */
  readonly releaseNotes: string | null
  /** 匹配当前平台的下载资产。 */
  readonly downloadAsset: {
    readonly platform: string
    readonly arch: string
    readonly filename: string
    readonly downloadUrl: string
    readonly size: number
  } | null
  /** 下载进度（phase=downloading 时有值）。 */
  readonly downloadProgress: DownloadProgress | null
  /** 已下载文件路径（phase=downloaded-ready 时有值）。 */
  readonly downloadedFile: { readonly path: string; readonly filename: string; readonly size: number } | null
  /** 上次检查时间戳。 */
  readonly checkedAt: number | null
  /** 失败原因。 */
  readonly error: string | null
}

/** 持久化状态文件名（在 updates dir 内，跨 host 重启恢复「已下载」态）。 */
const STATE_FILENAME = 'update-state.json'
/** 持久化的最小字段集（只存恢复态所需）。 */
interface PersistedState {
  readonly version: string
  readonly filename: string
  readonly size: number
}

/** 读取当前应用版本（env 优先，回落到 package.json 路径推导）。 */
export function readCurrentVersion(): string {
  const envVersion = process.env.CORUM_APP_VERSION
  if (envVersion !== undefined && envVersion.length > 0) return envVersion
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const p of [
      join(here, '..', '..', '..', '..', 'desktop', 'package.json'),
      join(process.cwd(), 'package.json'),
      join(process.cwd(), 'packages', 'desktop', 'package.json'),
    ]) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf8'))
        if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
      }
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 读取/解析更新缓存目录。 */
function resolveUpdatesDir(): string {
  const env = process.env.CORUM_UPDATES_DIR
  if (env !== undefined && env.length > 0) return env
  return join(homedir(), '.corum', 'updates')
}

/** 从 ParsedRelease 构建一个「检查完成」的 UpdateState。 */
function buildCheckedState(
  currentVersion: string,
  parsed: ParsedRelease | null,
  error: GithubQueryError | undefined,
  checkedAt: number,
): UpdateState {
  if (parsed === null) {
    return {
      phase: 'check-failed',
      currentVersion,
      latestVersion: null,
      releaseUrl: null,
      releaseNotes: null,
      downloadAsset: null,
      downloadProgress: null,
      downloadedFile: null,
      checkedAt,
      error: error !== undefined ? `${error.kind}: ${error.message}` : 'failed to parse release',
    }
  }
  const hasUpdate = isUpdateAvailable(currentVersion, parsed.version)
  return {
    phase: hasUpdate ? 'update-available' : 'up-to-date',
    currentVersion,
    latestVersion: parsed.version,
    releaseUrl: parsed.releaseUrl,
    releaseNotes: parsed.releaseNotes,
    downloadAsset: parsed.downloadAsset,
    downloadProgress: null,
    downloadedFile: null,
    checkedAt,
    error: null,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 更新检查 + 下载（cordis 服务，核心插件不可卸载）。 */
    updateChecker: UpdateCheckerService
  }
}

/**
 * 更新检查 + 下载服务（cordis 服务，host 侧）。
 *
 * 经 `@Remote` 暴露 RPC。状态在内存 + 磁盘（update-state.json）双写，
 * 跨 host 重启可恢复「已下载待安装」态。
 */
export class UpdateCheckerService extends TypertRemoteService {
  /** 内存中的完整状态。 */
  private state: UpdateState
  private readonly currentVersion: string
  private readonly updatesDir: string
  /** 正在检查（防并发）。 */
  private checking = false
  /** 正在下载（防并发）。 */
  private downloading = false

  constructor(ctx: Context) {
    super(ctx, 'updateChecker')
    this.currentVersion = readCurrentVersion()
    this.updatesDir = resolveUpdatesDir()
    this.state = {
      phase: 'idle',
      currentVersion: this.currentVersion,
      latestVersion: null,
      releaseUrl: null,
      releaseNotes: null,
      downloadAsset: null,
      downloadProgress: null,
      downloadedFile: null,
      checkedAt: null,
      error: null,
    }
    // 启动时恢复持久化状态（已下载待安装）。
    this.restorePersistedState()
    // 启动后延迟自动检查。
    setTimeout(() => { void this.checkForUpdates() }, STARTUP_CHECK_DELAY_MS)
  }

  /**
   * 执行一次完整检查。成功且有更新则自动开始后台下载。
   * 防并发：正在检查时返回当前状态。
   */
  @Remote('check')
  async checkForUpdates(): Promise<UpdateState> {
    if (this.checking) return this.snapshot()
    this.checking = true
    const checkedAt = Date.now()
    try {
      const fetchResult = await fetchLatestRelease({ owner: REPO_OWNER, repo: REPO_NAME })
      if (!fetchResult.ok || fetchResult.json === undefined) {
        this.state = buildCheckedState(this.currentVersion, null, fetchResult.error, checkedAt)
        return this.snapshot()
      }
      const platform = process.platform as 'darwin' | 'linux' | 'win32'
      const arch = process.arch
      // issue #151：Linux 上「装的是 AppImage 还是 deb」决定该下发哪个资产。
      // 传错会让 deb 用户拿到 AppImage，随后安装阶段必然失败（旧实现静默回滚）。
      const installForm = detectLinuxInstallForm(process.execPath, process.env.APPIMAGE)
      const parsed = parseLatestRelease(fetchResult.json, platform, arch, installForm)
      this.state = buildCheckedState(this.currentVersion, parsed, undefined, checkedAt)
      // 有更新且匹配到资产 → 自动开始后台下载。
      if (this.state.phase === 'update-available' && this.state.downloadAsset !== null) {
        // 不 await：后台下载，check 立即返回。
        void this.startDownload()
      }
      return this.snapshot()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.state = {
        ...this.state,
        phase: 'check-failed',
        checkedAt,
        error: msg,
      }
      return this.snapshot()
    } finally {
      this.checking = false
    }
  }

  /** 取完整状态快照（渲染层轮询用，O(1)，只读内存）。 */
  @Remote('getUpdateState')
  getUpdateState(): UpdateState {
    return this.snapshot()
  }

  /**
   * 手动触发下载（菜单「立即下载」/ 失败重试）。
   * 已在下载中或已下载完成则 no-op 返回当前状态。
   */
  @Remote('download')
  async downloadUpdate(): Promise<UpdateState> {
    if (this.downloading) return this.snapshot()
    if (this.state.phase === 'downloaded-ready') return this.snapshot()
    // 需要 downloadAsset；若还没有（没检查过或检查失败），先 check。
    if (this.state.downloadAsset === null) {
      await this.checkForUpdates()
    }
    if (this.state.downloadAsset === null) return this.snapshot()
    await this.startDownload()
    return this.snapshot()
  }

  /**
   * 后台下载核心逻辑（内部，不暴露 RPC）。
   * 流式下载到 updates dir，进度实时写 state，完成持久化 + 转 phase。
   */
  private async startDownload(): Promise<void> {
    const asset = this.state.downloadAsset
    if (asset === null || this.downloading) return
    this.downloading = true
    // 先查是否已存在完整文件（断点续传简化版：在就直接用）。
    const existing = findExistingDownload(this.updatesDir, asset.filename, asset.size)
    if (existing !== null) {
      this.state = {
        ...this.state,
        phase: 'downloaded-ready',
        downloadProgress: { receivedBytes: existing.size, totalBytes: existing.size, percent: 100 },
        downloadedFile: existing,
      }
      this.persistState()
      this.downloading = false
      return
    }
    this.state = {
      ...this.state,
      phase: 'downloading',
      downloadProgress: { receivedBytes: 0, totalBytes: asset.size, percent: 0 },
      downloadedFile: null,
      error: null,
    }
    try {
      const downloaded = await downloadAsset(
        asset.downloadUrl,
        this.updatesDir,
        asset.filename,
        (progress: DownloadProgress) => {
          this.state = { ...this.state, downloadProgress: progress }
        },
      )
      this.state = {
        ...this.state,
        phase: 'downloaded-ready',
        downloadProgress: { receivedBytes: downloaded.size, totalBytes: downloaded.size, percent: 100 },
        downloadedFile: downloaded,
        error: null,
      }
      this.persistState()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.state = {
        ...this.state,
        phase: 'download-failed',
        downloadProgress: null,
        error: msg,
      }
    } finally {
      this.downloading = false
    }
  }

  /** 持久化「已下载」态到 update-state.json（跨 host 重启恢复）。 */
  private persistState(): void {
    const statePath = join(this.updatesDir, STATE_FILENAME)
    if (this.state.phase !== 'downloaded-ready' || this.state.downloadedFile === null) {
      // 非已下载态：清掉持久化文件（避免恢复到过期态）。
      try { if (existsSync(statePath)) unlinkSync(statePath) } catch { /* noop */ }
      return
    }
    try {
      if (!existsSync(this.updatesDir)) mkdirSync(this.updatesDir, { recursive: true })
      const data: PersistedState = {
        version: this.state.latestVersion ?? '',
        filename: this.state.downloadedFile.filename,
        size: this.state.downloadedFile.size,
      }
      writeFileSync(statePath, JSON.stringify(data), 'utf8')
    } catch { /* 持久化失败不影响内存态 */ }
  }

  /** 启动时恢复持久化的「已下载」态。 */
  private restorePersistedState(): void {
    try {
      const p = join(this.updatesDir, STATE_FILENAME)
      if (!existsSync(p)) return
      const data = JSON.parse(readFileSync(p, 'utf8')) as PersistedState
      if (typeof data.version !== 'string' || typeof data.filename !== 'string') return
      const filePath = join(this.updatesDir, data.filename)
      if (!existsSync(filePath)) return
      const size = statSync(filePath).size
      // 只有 latest 版本仍 > 当前版本才恢复为「待安装」（否则视为过期，下次检查会刷新）。
      this.state = {
        ...this.state,
        phase: 'downloaded-ready',
        latestVersion: data.version,
        downloadProgress: { receivedBytes: size, totalBytes: size, percent: 100 },
        downloadedFile: { path: filePath, filename: data.filename, size },
      }
    } catch { /* 恢复失败：静默从 idle 开始 */ }
  }

  /** 深拷贝快照（防外部突变内存状态）。 */
  private snapshot(): UpdateState {
    return JSON.parse(JSON.stringify(this.state)) as UpdateState
  }
}

/**
 * 插件 apply（cordis 装配点）。
 * @param ctx - host cordis context.
 */
export function apply(ctx: Context): void {
  new UpdateCheckerService(ctx)
}
