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

import { readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

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

/**
 * 桌面文件系统 Remote：以 host 进程 cwd 为项目根的只读目录浏览。
 *
 * 不走 fiber 的 static inject：本服务由 boot 回调在根 ctx 直 new（非 fiber
 * 挂载，与 CorumPluginManager 同一模式），无依赖服务。
 */
export class CorumFsService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'corumFs')
  }

  /**
   * 列目录（资源管理器文件树的数据源）。以 host 进程 cwd 为项目根：任何
   * 真实路径逃出根目录的请求都拒绝（realpath 校验，防止 symlink 穿越）。
   * @param path - 相对根的路径（'/' 或 '' = 根；前导斜杠会被剥掉）。
   * @returns 规范回显的 path + 过滤排序后的目录条目。
   */
  @Remote('list')
  async list(path?: string): Promise<{ path: string; entries: CorumFsEntry[] }> {
    const root = resolve(process.cwd())
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
   * 安全：与 list 同一 realpath 防穿越校验——目标必须落在 host 进程 cwd 根
   * 之内（写工具的 filePath 是绝对路径；根外路径拒绝，不做 symlink 逃逸）。
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

  /** 单条撤销的落盘实现；目标必须 realpath 后仍在项目根内。 */
  private async revertOne(
    op: { path: string; kind: 'edit' | 'delete' | 'restoreContent'; oldString?: string; newString?: string },
    /** 撤销的路径根（泳道工作区；缺省 host 进程 cwd）。 */
    rootOverride?: string,
  ): Promise<void> {
    // 根与文件同基准 realpath（macOS /tmp → /private/tmp 的 symlink 会让 resolve 后
    // 的根（/tmp/...）与已 realpath 的文件路径（/private/tmp/...）前缀不一致，误判逃逸）。
    const root = await realpath(resolve(rootOverride ?? process.cwd())).catch(() => resolve(rootOverride ?? process.cwd()))
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
    // dirname 引用仅为类型锚定（writeFile 不建目录——撤销目标必然已存在）。
    void dirname
  }
}
