/**
 * UpdateApi —— 更新检查能力接口（本地窄化，红线 3）。
 *
 * AppFrame 是纯组件不碰 cordis；host 侧 `@corum/corum-update-checker` 经
 * `@Remote` 暴露 RPC，这里窄化成 AppFrame / UpdatePanel 只需的几个方法。
 * 类型与 `@corum/corum-update-checker` 的 UpdateState 同构（结构窄化，不 import
 * 实现包——红线 3：跨 bundle type-face 用本地能力接口收窄）。
 *
 * @module corum-ide-ui/client/update/update-api
 */

/** 下载进度（与 host 侧 DownloadProgress 同构）。 */
export interface UpdateDownloadProgress {
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly percent: number
}

/** 更新完整状态（与 host 侧 UpdateState 同构）。 */
export interface UpdateState {
  readonly phase: 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'downloading' | 'downloaded-ready' | 'check-failed' | 'download-failed'
  readonly currentVersion: string
  readonly latestVersion: string | null
  readonly releaseUrl: string | null
  readonly releaseNotes: string | null
  readonly downloadAsset: {
    readonly platform: string
    readonly arch: string
    readonly filename: string
    readonly downloadUrl: string
    readonly size: number
  } | null
  readonly downloadProgress: UpdateDownloadProgress | null
  readonly downloadedFile: { readonly path: string; readonly filename: string; readonly size: number } | null
  readonly checkedAt: number | null
  readonly error: string | null
}

/**
 * 更新能力面（AppFrame / UpdatePanel 经 props 消费）。
 * 安装动作走 IPC（window.corumDesktop.installUpdate），不经此面。
 */
export interface UpdateApi {
  /** 取完整状态（O(1) 内存读，轮询用）。 */
  getState(): Promise<UpdateState | null>
  /** 执行检查（成功且有更新则自动开始下载）。 */
  check(): Promise<UpdateState>
  /** 手动触发下载（菜单「立即下载」/ 重试）。 */
  download(): Promise<UpdateState>
}

/** 是否有「需要用户关注的更新」——活动栏按钮的显示条件。 */
export function hasReadyUpdate(state: UpdateState | null): boolean {
  return state !== null && state.phase === 'downloaded-ready'
}

/** 是否有「有更新但未下载」——用户菜单红点角标的显示条件。 */
export function hasPendingUpdate(state: UpdateState | null): boolean {
  return state !== null && (state.phase === 'update-available' || state.phase === 'downloading' || state.phase === 'download-failed')
}

/** 有更新时的版本标签（如 `v0.5.0`）。 */
export function updateVersionLabel(state: UpdateState | null): string | null {
  return state?.latestVersion ?? null
}

/**
 * dsh 基座版本来源（本地能力接口，红线 3：不 import 实现包）。
 *
 * `window.corumDesktop.getDshBaselineVersion` 读的是**实际安装**的官方锚点包
 * 版本（不是依赖声明区间 —— 区间是 `^0.1.5-rc.3` 这种范围，写进界面会撒谎）。
 * 更新面板是「关于本应用」语境，用户 2026-10-16 明确要求在这里展示基座版本。
 */
export interface BaselineVersionBridge {
  getDshBaselineVersion?: () => Promise<string | undefined>
}

/** 读取 dsh 基座版本；取不到（老 preload / 非桌面壳）返回 null，不编造。 */
export async function readDshBaselineVersion(): Promise<string | null> {
  const bridge = (window as unknown as { corumDesktop?: BaselineVersionBridge }).corumDesktop
  if (typeof bridge?.getDshBaselineVersion !== 'function') return null
  try {
    const version = await bridge.getDshBaselineVersion()
    return version !== undefined && version !== '' ? version : null
  } catch {
    return null
  }
}

/** 更新日志：正文 + 磁盘绝对路径（路径供「在编辑器打开」使用）。 */
export interface ChangelogDoc {
  readonly path: string
  readonly content: string
}

/** 更新日志来源桥（随安装包分发的 CHANGELOG.md）。 */
export interface ChangelogBridge {
  getChangelog?: () => Promise<ChangelogDoc | null>
}

/** 读取随包分发的更新日志；取不到（老产物 / 非桌面壳）返回 null，不编造。 */
export async function readChangelog(): Promise<ChangelogDoc | null> {
  const bridge = (window as unknown as { corumDesktop?: ChangelogBridge }).corumDesktop
  if (typeof bridge?.getChangelog !== 'function') return null
  try {
    const doc = await bridge.getChangelog()
    if (doc === null || typeof doc.content !== 'string' || doc.content === '') return null
    return doc
  } catch {
    return null
  }
}

/**
 * 「在编辑器打开」的窄能力面（红线 3：跨 bundle 用局部能力接口收窄）。
 *
 * 实现方是 `corum-desktop/client` provide 的 `ctx.corumEditor` 服务（与 chat
 * 「在编辑器打开」同一个）。这里只声明本面板用到的 `openFile`，不 import
 * 实现包——服务缺席（非桌面壳 / 未装配）时调用方降级为「复制日志正文」。
 */
export interface CorumEditorCapable {
  openFile?: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>
}

/**
 * 把日志文件在编辑器里打开。
 * @param path - 日志文件绝对路径（随包分发，位于工作区外 ⇒ 服务内部走
 *   openExternalPreview 作只读预览，不会写盘）。
 */
export async function openChangelogInEditor(
  editor: CorumEditorCapable | null,
  path: string,
): Promise<{ ok: boolean; error?: string }> {
  if (editor === null || typeof editor.openFile !== 'function') {
    return { ok: false, error: '编辑器不可用' }
  }
  if (path === '') return { ok: false, error: '日志文件路径缺失' }
  try {
    return await editor.openFile(path)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}


/**
 * 解析更新日志为「版本节」列表（面板里显示当前版本摘要、编辑器视图做导航）。
 *
 * 只认 `## <版本> — <日期>` 这一级标题（首行 `# ` 文档标题不算版本）；`###` 段落
 * 留作正文里的分组，不单独成节。返回顺序与文件一致（新版本在上）。
 *
 * 解析刻意宽松：日志是人手写的，格式漂移不该让功能失效——认不出的行原样留在
 * 该节的 `body` 里。
 */
export interface ChangelogSection {
  /** 版本号（已剥离 `v` 前缀之外的空白），无 `v` 时按原文保留。 */
  readonly version: string
  /** 该节日期串（`YYYY-MM-DD`），缺失时为空串。 */
  readonly date: string
  /** 该节正文（含 `###` 分组与 `- ` 条目，原样保留）。 */
  readonly body: string
}

export function parseChangelog(content: string): ChangelogSection[] {
  const sections: ChangelogSection[] = []
  const lines = content.split(/\r?\n/)
  let current: { version: string; date: string; lines: string[] } | null = null
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*(?:[—–-]\s*(\d{4}-\d{2}-\d{2}))?\s*$/.exec(line)
    if (match !== null) {
      if (current !== null) sections.push({ version: current.version, date: current.date, body: current.lines.join('\n').trim() })
      current = { version: match[1] ?? '', date: match[2] ?? '', lines: [] }
      continue
    }
    if (current !== null) current.lines.push(line)
  }
  if (current !== null) sections.push({ version: current.version, date: current.date, body: current.lines.join('\n').trim() })
  return sections
}

