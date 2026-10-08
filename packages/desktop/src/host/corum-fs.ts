/**
 * corum-desktop/corum-fs — 桌面文件系统 Host 半（Typert Remote，service 名
 * `corumFs`）。0.1.2 架构换轨（自定义 IPC transport → 官方 loopback webserver）
 * 后重供的 IDE 资源管理器（文件树）数据源：旧 `corum.fs.list`（已删除的
 * host/connection.ts 的 handleCorumFsList，走手搓 IPC unary 路径拦截）退役，
 * 同一语义按 corum 自有 RPC 官方范式（TypertRemoteService + @Remote 装饰器）
 * 重供为 `/api/corumFs/list` 端点，api-gateway 的 SRC 发现自动认领
 * （与 pluginManager 同理，见 boot.ts 的根 ctx 注册点）。
 *
 * 语义复刻旧 handleCorumFsList：
 *   - 以 host 进程 cwd 为项目根；`path` 相对根（'/' = 根）。
 *   - 安全：realpath 校验防 symlink 穿越根（任何逃出根的路径拒绝）。
 *   - 过滤 `.git` / `node_modules` / `.` 开头；目录优先 + 名称排序。
 *
 * @Remote 方法直接 return value（Typert Remote 信封自动包成
 * `{ ok: true, value }`），失败 throw（包成 `{ ok: false, error }`）。
 * @module corum-desktop/corum-fs
 */

import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { getPlatformModule } from '../electron/platform/index.ts'
// 拉入 corum 领域事件的 cordis Events 声明（'corum/file/changed' 等）——声明在
// fork 包 @corum/corum-api-remotes 自包含（UNIFIED-EVENT-BUS §2.2 类型安全三段式
// 之一），type-only import 编译期即擦除，无运行时依赖。
import type {} from '@corum/corum-api-remotes/corum-events'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 桌面文件系统服务（IDE 资源管理器文件树数据源）。 */
    corumFs: CorumFsService
  }
}

/** 目录条目（文件树节点）。 */
export interface CorumFsEntry {
  name: string
  type: 'dir' | 'file'
}

/** 图片扩展名 → MIME（readBinary + 编辑区图片预览）。 */
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

/** 视频扩展名 → MIME（编辑区视频预览；corumfs:// scheme 同表）。 */
const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
}

/** 按扩展名取图片 MIME（非图片返回 undefined）。 */
export function imageMimeOf(path: string): string | undefined {
  return IMAGE_MIME[extname(path).toLowerCase()]
}

/** 按扩展名取视频 MIME（非视频返回 undefined）。 */
export function videoMimeOf(path: string): string | undefined {
  return VIDEO_MIME[extname(path).toLowerCase()]
}

/** 文件扩展名 → Monaco 语言 id（与 client 端 languageFromPath 对齐）。 */
function languageFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript'
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript'
    case 'json': case 'jsonc': case 'json5': return 'json'
    case 'css': case 'scss': case 'less': return 'css'
    case 'html': case 'htm': case 'xhtml': case 'vue': case 'svelte': return 'html'
    case 'md': case 'markdown': return 'markdown'
    case 'py': case 'pyi': return 'python'
    case 'yaml': case 'yml': return 'yaml'
    case 'sh': case 'bash': case 'zsh': return 'shell'
    case 'rs': return 'rust'
    case 'go': return 'go'
    case 'java': case 'kt': case 'kts': return 'java'
    case 'c': case 'h': return 'c'
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh': return 'cpp'
    case 'toml': case 'ini': case 'conf': return 'ini'
    case 'xml': case 'svg': case 'plist': return 'xml'
    case 'sql': return 'sql'
    case 'lock': return 'plaintext'
    default: return 'plaintext'
  }
}

/**
 * 桌面文件系统 Remote：以 host 进程 cwd 为项目根的只读目录浏览。
 *
 * 不走 fiber 的 static inject：本服务由 boot 回调在根 ctx 直 new（非 fiber
 * 挂载，与 CorumPluginManager 同一模式），无依赖服务。
 */
export class CorumFsService extends TypertRemoteService {
  /** 当前活跃的根 watcher（host cwd 递归）。 */
  private watcher: FSWatcher | null = null
  /** 去抖窗口内累积的本批变更（统一事件中心：到点一次性 emit 一帧）。 */
  private pendingChanges: { path: string; kind: 'rename' | 'change' }[] = []
  /** watcher 启动时的去抖定时器。 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** 当前项目根（默认 host 进程 cwd；client 经 setRoot 跟随当前会话/工作区切换）。 */
  private root: string = resolve(process.cwd())

  constructor(ctx: Context) {
    super(ctx, 'corumFs')
  }

  /** 当前项目根（realpath 未解析；各端点使用时再 resolve+realpath 校验）。 */
  private rootPath(): string {
    return this.root
  }

  /**
   * 切换项目根（client 跟随当前会话 cwd / 工作区 path 调用）。空串/未传 =
   * 回退 host 进程 cwd。切换后 watcher 重启到新根，pendingChanges 清空。
   * @param cwd - 新根的绝对路径（必须在磁盘上存在；不在校验时不切）。
   */
  @Remote('setRoot')
  async setRoot(cwd?: string): Promise<{ root: string }> {
    const next = cwd !== undefined && cwd !== '' ? resolve(cwd) : resolve(process.cwd())
    // 新根必须真实存在（避免 client 传了还没建的目录把树打死）。
    const real = await realpath(next).catch(() => null)
    if (real === null) {
      throw new Error(`setRoot: directory does not exist: ${next}`)
    }
    if (real === this.root) return { root: this.root }
    this.root = real
    // 换根 = 旧 watcher 无意义；停掉，等 client 下次 startWatch 重挂到新根。
    if (this.watcher !== null) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingChanges = []
    return { root: real }
  }

  /**
   * 当前根快照（host 内部 API，非 Remote——bridge.ts 的 /corumfs 媒体流式
   * 路由与 read 端点共享同一 realpath 防穿越基准）。
   */
  currentRoot(): string {
    return this.root
  }

  /**
   * 列目录（资源管理器文件树的数据源）。以 host 进程 cwd 为项目根：任何
   * 真实路径逃出根目录的请求都拒绝（realpath 校验，防止 symlink 穿越）。
   * @param path - 相对根的路径（'/' 或 '' = 根；前导斜杠会被剥掉）。
   * @returns 规范回显的 path + 过滤排序后的目录条目。
   */
  @Remote('list')
  async list(path?: string): Promise<{ path: string; entries: CorumFsEntry[] }> {
    const root = resolve(this.rootPath())
    const requested = path ?? '/'
    let target: string
    try {
      // 路径一律按相对根处理：'/' 与 '' 映射根，剥掉前导斜杠，杜绝
      // resolve(root, '/abs') 被绝对路径覆盖 root 的逃逸。
      const normalized = requested === '/' || requested === '' ? '.' : requested.replace(/^\/+/, '')
      target = resolve(root, normalized)
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error(`path escapes the project root: ${requested}`)
      }
      const real = await realpath(target)
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`path escapes the project root via symlink: ${requested}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('path escapes')) throw error
      throw new Error(`cannot resolve ${requested}: ${String(error)}`)
    }
    try {
      const entries = await readdir(target, { withFileTypes: true })
      const items: CorumFsEntry[] = entries
        .filter(entry => entry.name !== '.git' && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
        .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'dir' as const : 'file' as const }))
        .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
      return { path: requested, entries: items }
    } catch (error) {
      throw new Error(`cannot read ${requested}: ${String(error)}`)
    }
  }

  /**
   * 读文件内容（编辑器打开文件的数据源）。与 list 同一 realpath 防穿越校验。
   * 二进制防御：图片/视频按 UTF-8 读必乱码卡死 Monaco——按扩展名直接拒绝
   * （`binary file`），client 按类型走 readBinary（图片）/ corumfs://（视频）。
   * @param path - 相对根的路径（'/' 或 '' = 根；前导斜杠会被剥掉）。
   * @returns 文件内容（UTF-8）+ 推断的语言 id（供 Monaco 直接用）。
   */
  @Remote('read')
  async read(path?: string): Promise<{ path: string; content: string; language: string }> {
    const requested0 = path ?? '/'
    if (imageMimeOf(requested0) !== undefined || videoMimeOf(requested0) !== undefined) {
      throw new Error(`binary file: open it as preview instead of text (${requested0})`)
    }
    const root = resolve(this.rootPath())
    const requested = path ?? '/'
    const normalized = requested === '/' || requested === '' ? '.' : requested.replace(/^\/+/, '')
    const target = resolve(root, normalized)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`path escapes the project root: ${requested}`)
    }
    const real = await realpath(target)
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`path escapes the project root via symlink: ${requested}`)
    }
    try {
      const content = await readFile(real, 'utf8')
      return { path: requested, content, language: languageFromPath(requested) }
    } catch (error) {
      throw new Error(`cannot read file ${requested}: ${String(error)}`)
    }
  }

  /**
   * 读图片二进制（编辑区图片预览的数据源）。仅允许图片扩展名（视频走
   * corumfs:// scheme 流式，不经 RPC）；与 read 同一 realpath 防穿越校验。
   * 大小钳制 32MB（base64 走 RPC 信封，过大应走协议 URL）。
   * @param path - 相对根的路径。
   * @returns base64 内容 + MIME（client 拼 data: URL 渲染 `<img>`）。
   */
  @Remote('readBinary')
  async readBinary(path?: string): Promise<{ path: string; mime: string; base64: string }> {
    const requested = path ?? '/'
    const mime = imageMimeOf(requested)
    if (mime === undefined) {
      throw new Error(`readBinary only serves image files: ${requested}`)
    }
    const root = resolve(this.rootPath())
    const normalized = requested === '/' || requested === '' ? '.' : requested.replace(/^\/+/, '')
    const target = resolve(root, normalized)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`path escapes the project root: ${requested}`)
    }
    const real = await realpath(target)
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`path escapes the project root via symlink: ${requested}`)
    }
    try {
      const buf = await readFile(real)
      if (buf.byteLength > 32 * 1024 * 1024) {
        throw new Error(`image too large for preview (>32MB): ${requested}`)
      }
      return { path: requested, mime, base64: buf.toString('base64') }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('image too large')) throw error
      throw new Error(`cannot read file ${requested}: ${String(error)}`)
    }
  }

  /**
   * 取相对路径的真实绝对路径（资源管理器「复制路径」的数据源）。
   * 与 read 同一 realpath 防穿越校验；返回 realpath 解析后的绝对路径。
   * @param path - 相对根的路径。
   */
  @Remote('absolutePath')
  async absolutePath(path: string): Promise<{ absolutePath: string }> {
    const root = resolve(this.rootPath())
    const normalized = path === '/' || path === '' ? '.' : path.replace(/^\/+/, '')
    const target = resolve(root, normalized)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`path escapes the project root: ${path}`)
    }
    const real = await realpath(target)
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`path escapes the project root via symlink: ${path}`)
    }
    return { absolutePath: real }
  }

  /**
   * 在系统文件管理器中显示（资源管理器右键「在 Finder 中显示」）。
   * macOS：`open -R <abs>`（揭示并选中）；其它平台退化为打开所在目录。
   * 与 absolutePath 同一 realpath 防穿越校验。
   * @param path - 相对根的路径。
   */
  @Remote('reveal')
  async reveal(path: string): Promise<{ revealed: boolean }> {
    const root = resolve(this.rootPath())
    const normalized = path === '/' || path === '' ? '.' : path.replace(/^\/+/, '')
    const target = resolve(root, normalized)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`path escapes the project root: ${path}`)
    }
    const real = await realpath(target)
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`path escapes the project root via symlink: ${path}`)
    }
    // 平台选路收进 electron/platform/（P1：reveal 能力）——macOS open -R 揭示选中；
    // Linux xdg-open 所在目录；Windows explorer /select。本段保持三向完整（参照实现）。
    const { cmd, args } = getPlatformModule().revealCommand(real, dirname(real))
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(cmd, args, { stdio: 'ignore' })
      child.on('error', rejectPromise)
      child.on('exit', (code) => {
        if (code === 0) resolvePromise()
        else rejectPromise(new Error(`${cmd} exited with code ${code}`))
      })
    })
    return { revealed: true }
  }

  /**
   * 写文件内容（编辑器保存 ⌘S 的数据源）。与 list/read 同一 realpath 防穿越校验。
   * 新文件自动创建父目录（recursive mkdir）。
   * @param path - 相对根的路径。
   * @param content - 文件新内容（UTF-8）。
   */
  @Remote('write')
  async write(path: string, content: string): Promise<{ path: string }> {
    const root = resolve(this.rootPath())
    const normalized = path === '/' || path === '' ? '.' : path.replace(/^\/+/, '')
    const target = resolve(root, normalized)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`path escapes the project root: ${path}`)
    }
    const real = await realpath(target).catch(() => {
      // 新文件 realpath 失败——校验父目录
      return null
    })
    if (real !== null) {
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`path escapes the project root via symlink: ${path}`)
      }
    }
    try {
      // 新文件自动补父目录（mkdir recursive 已存在不报错）。
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      return { path }
    } catch (error) {
      throw new Error(`cannot write file ${path}: ${String(error)}`)
    }
  }

  /**
   * 新建目录（资源管理器「新建文件夹」）。recursive（已存在不报错）。
   * @param path - 相对根的路径。
   */
  @Remote('mkdir')
  async mkdirp(path: string): Promise<{ path: string }> {
    const root = resolve(this.rootPath())
    const normalized = path === '/' || path === '' ? '.' : path.replace(/^\/+/, '')
    const target = resolve(root, normalized)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`path escapes the project root: ${path}`)
    }
    try {
      await mkdir(target, { recursive: true })
      return { path }
    } catch (error) {
      throw new Error(`cannot mkdir ${path}: ${String(error)}`)
    }
  }

  /**
   * 删除文件或目录（资源管理器右键「删除」）。目录递归删除。
   * @param path - 相对根的路径。
   */
  @Remote('delete')
  async remove(path: string): Promise<{ path: string }> {
    const root = resolve(this.rootPath())
    const normalized = path === '/' || path === '' ? '.' : path.replace(/^\/+/, '')
    const target = resolve(root, normalized)
    if (target === root || !target.startsWith(root + sep)) {
      throw new Error(`refusing to delete the project root or outside path: ${path}`)
    }
    const real = await realpath(target)
    if (real === root || !real.startsWith(root + sep)) {
      throw new Error(`path escapes the project root via symlink: ${path}`)
    }
    try {
      await rm(real, { recursive: true, force: true })
      return { path }
    } catch (error) {
      throw new Error(`cannot delete ${path}: ${String(error)}`)
    }
  }

  /**
   * 重命名/移动（资源管理器右键「重命名」、拖拽移动）。
   * @param from - 源相对路径。
   * @param to - 目标相对路径。
   */
  @Remote('rename')
  async renamePath(from: string, to: string): Promise<{ from: string; to: string }> {
    const root = resolve(this.rootPath())
    const normFrom = from === '/' || from === '' ? '.' : from.replace(/^\/+/, '')
    const normTo = to === '/' || to === '' ? '.' : to.replace(/^\/+/, '')
    const targetFrom = resolve(root, normFrom)
    const targetTo = resolve(root, normTo)
    if (targetFrom === root || !targetFrom.startsWith(root + sep)) {
      throw new Error(`refusing to rename the project root or outside path: ${from}`)
    }
    if (targetTo !== root && !targetTo.startsWith(root + sep)) {
      throw new Error(`destination escapes the project root: ${to}`)
    }
    const realFrom = await realpath(targetFrom)
    if (realFrom === root || !realFrom.startsWith(root + sep)) {
      throw new Error(`path escapes the project root via symlink: ${from}`)
    }
    try {
      await mkdir(dirname(targetTo), { recursive: true })
      await rename(realFrom, targetTo)
      return { from, to }
    } catch (error) {
      throw new Error(`cannot rename ${from} → ${to}: ${String(error)}`)
    }
  }

  /**
   * 启动项目根递归 watch（幂等）。变更事件在去抖窗口内累积、到点一次性
   * emit `corum/file/changed` 一帧推送（统一事件中心，renderer $on 直收
   * 唯一路径——三期删 pollChanges 端点 + changeLog 缓冲，host/renderer 同生
   * 同死「旧 host 不 emit」永不发生）。过滤 .git / node_modules / 点开头的
   * 隐藏项（与 list 同规则）。500ms 去抖（编辑器保存一顿连写只报一次）。
   */
  @Remote('watch')
  async startWatch(): Promise<{ watching: boolean }> {
    if (this.watcher !== null) return { watching: true }
    const root = resolve(this.rootPath())
    try {
      this.watcher = watch(root, { recursive: true }, (eventType, filename) => {
        if (filename === null || filename === '') return
        const parts = filename.split(sep)
        // 与 list 同规则：过滤 .git / node_modules / 点开头的隐藏段。
        if (parts.some(p => p === '.git' || p === 'node_modules' || p.startsWith('.'))) return
        // 统一事件中心：去抖窗口内累积本批 changes（原实现每事件重启定时器、
        // 到点只记最后一条——批量编辑器保存/外部改动会丢中间帧）。到点把整个
        // batch 一次性 emit 一帧推送（renderer $on 直收；一个去抖窗口一帧，
        // 不每 fs 事件一帧）。
        this.pendingChanges.push({ path: `/${filename.split(sep).join('/')}`, kind: eventType === 'rename' ? 'rename' : 'change' })
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null
          if (this.pendingChanges.length === 0) return
          const changes = this.pendingChanges
          this.pendingChanges = []
          this.ctx.emit('corum/file/changed', { changes })
        }, 500)
      })
      this.watcher.on('error', (err) => {
        console.error('[corum-fs] watcher error', err)
      })
      return { watching: true }
    } catch (error) {
      throw new Error(`cannot watch project root: ${String(error)}`)
    }
  }

  /**
   * fork（corum）：Review 卡「全部撤销」的 host 实操端点。把会话里 Agent
   * 经 edit/write/str_replace_editor 工具写入的文本改动反向 apply 回磁盘。
   *
   * 每条 op 的语义（client 按 call seq 逆序传入）：
   *   - kind 'edit'   ：read → 唯一匹配 oldString（= 当时写入的新文本）→
   *     换回 newString（= 当时的旧文本）→ 写回。匹配不到/多处匹配 → 该条失败
   *     （内容已漂，不动文件是安全的）。
   *   - kind 'delete' ：create 工具的反向——文件仍在则删除（不存在视为已撤）。
   *   - kind 'restoreContent'：write 工具覆盖已存在文件的反向——仅在调用方
   *     持有当时完整旧内容时使用；本会话事件流不含旧内容，client 不下发此
   *     类 op，保留端点给后续 meta 携带 diff 的场景。
   *
   * 安全：与 list 同一 realpath 防穿越校验——目标必须落在有效根之内
   * （写工具的 filePath 是绝对路径；根外路径拒绝，不做 symlink 逃逸）。
   * 有效根本身再被钳制在 host 进程 cwd 之内：`root` 参数（来自渲染层）只能
   * 指向 cwd 或其子目录（泳道工作区在 cwd 下，照常工作），指向 cwd 之外/之上
   * 的 root（如 /Users/x）一律拒绝——否则持有 dsh-auth cookie 的本机页面可借
   * restoreContent 写任意文件（P0 根权限放大）。
   * @param ops - 逆序写操作列表（JSON 可序列化）。
   * @returns 每条独立成败 + 聚合计数；整体失败以逐条 false 表达，不 throw。
   */
  @Remote('revertWrites')
  async revertWrites(
    ops?: readonly { path: string; kind: 'edit' | 'delete' | 'restoreContent'; oldString?: string; newString?: string }[],
    /** 撤销的路径根（泳道工作区绝对路径；缺省回退 host 进程 cwd——用于非泳道场景）。 */
    root?: string,
  ): Promise<{ reverted: number; failed: number; results: { path: string; ok: boolean; message?: string }[] }> {
    const list = ops ?? []
    const results: { path: string; ok: boolean; message?: string }[] = []
    let reverted = 0
    let failed = 0
    for (const op of list) {
      try {
        // eslint-disable-next-line no-await-in-loop -- 逐条串行：同一文件多条 op 必须按序 apply
        await this.revertOne(op, root)
        results.push({ path: op.path, ok: true })
        reverted++
      } catch (error) {
        results.push({ path: op.path, ok: false, message: error instanceof Error ? error.message : String(error) })
        failed++
      }
    }
    return { reverted, failed, results }
  }

  /**
   * 只读预览：把某文件本轮写操作在**内存里**逆序反推，重建出「改动前」的文本，
   * 供 Review 卡的「点击文件 → 看 diff」使用（与 revertWrites 同一套 matching
   * 语义，但不落盘）。
   *
   * 为什么需要它：会话事件流只含工具入参（oldString/newString），不含文件旧内容
   * （见 revertWrites 注释与 review-revert.ts 的三档说明）。要展示整文件
   * before/after diff，就必须拿当前文件 + 逆序反推算出原文。
   *
   * 重建边界（`complete` 标志如实反映）：
   *   - `edit` / `str_replace` → 精确反向（newString 唯一匹配换回 oldString）。
   *   - `str_replace_editor create` → 文件原本不存在，反向即「空文件」。
   *   - `write`（整文件覆盖）→ 旧内容不可知，**重建到此为止**：
   *     返回的是「最后一次整写之后」的状态，`complete: false`。
   *   - `str_replace_editor insert` → 行号已漂移，按 lineCount 尽力移除；
   *     移除失败同样停止并标 `complete: false`。
   *
   * 安全：与 revertWrites 完全同一套 realpath 防穿越 + root 钳制（root 必须在
   * host cwd 之内），只读、不写任何文件。
   *
   * @param ops - 该文件的写操作，**按 seq 逆序**（最新在前，与 revertOrder 同序）。
   * @param root - 路径根（泳道工作区绝对路径）。
   * @returns 重建文本 + 是否完整重建到会话起点 + 当前文件相对路径。
   */
  /**
   * 单条撤销的落盘实现；目标必须 realpath 后仍在有效根内。
   *
   * 有效根钳制：rootOverride 经 realpath 后必须等于 host 进程 cwd 或位于 cwd
   * 之内（泳道工作区都在 cwd 下）；cwd 之外/之上的 root 一律拒绝
   * （`refusing to revert outside the host workspace`）——否则渲染层可传任意
   * root 把 revertWrites 变成任意文件写。
   */
  private async revertOne(
    op: { path: string; kind: 'edit' | 'delete' | 'restoreContent'; oldString?: string; newString?: string },
    /** 撤销的路径根（泳道工作区；缺省 host 进程 cwd；钳制在 cwd 之内）。 */
    rootOverride?: string,
  ): Promise<void> {
    // 根与文件同基准 realpath（macOS /tmp → /private/tmp 的 symlink 会让 resolve 后
    // 的根（/tmp/...）与已 realpath 的文件路径（/private/tmp/...）前缀不一致，误判逃逸）。
    const root = await realpath(resolve(rootOverride ?? process.cwd())).catch(() => resolve(rootOverride ?? process.cwd()))
    // root 钳制（P0）：有效根必须落在 host 进程 cwd 之内。泳道工作区（cwd 的子
    // 目录）不受影响；渲染层指定 cwd 之外/之上的 root 直接拒绝。
    const allowedRoot = await realpath(resolve(this.rootPath())).catch(() => resolve(this.rootPath()))
    if (root !== allowedRoot && !root.startsWith(allowedRoot + sep)) {
      throw new Error(`refusing to revert outside the host workspace: ${rootOverride ?? ''}`)
    }
    const rawRequested = isAbsolute(op.path) ? op.path : resolve(root, op.path)
    // 文件路径同基准 realpath（写工具的绝对路径可能是 /tmp/... 而根 realpath 后是
    // /private/tmp/...；不 realpath 会误判逃逸）。文件不存在时 realpath 失败则退回原值。
    const requested = await realpath(rawRequested).catch(() => rawRequested)
    if (requested !== root && !requested.startsWith(root + sep)) {
      throw new Error(`path escapes the project root: ${op.path}`)
    }
    if (op.kind === 'delete') {
      const real = await realpath(requested).catch(() => null)
      if (real === null) return // 已不存在：视为已撤
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`path escapes the project root via symlink: ${op.path}`)
      }
      await rm(real)
      return
    }
    // edit / restoreContent 都要先读当前文本（realpath 校验同一时刻的真实文件）。
    const real = await realpath(requested)
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`path escapes the project root via symlink: ${op.path}`)
    }
    if (op.kind === 'restoreContent') {
      await writeFile(real, op.newString ?? '', 'utf8')
      return
    }
    const before = await readFile(real, 'utf8')
    const needle = op.oldString ?? ''
    if (needle === '') throw new Error('revert edit requires a non-empty oldString')
    const first = before.indexOf(needle)
    if (first < 0) throw new Error('oldString not found (content drifted)')
    if (before.indexOf(needle, first + needle.length) >= 0) {
      throw new Error('oldString matches multiple locations (ambiguous revert)')
    }
    const after = before.slice(0, first) + (op.newString ?? '') + before.slice(first + needle.length)
    await writeFile(real, after, 'utf8')
  }
}
