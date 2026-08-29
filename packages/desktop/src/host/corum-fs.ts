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

import { readdir, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
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
}
