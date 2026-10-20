/**
 * corumFsClient —— corumFs 的 11 个 RPC 封装（P2-8，.dbg/event-bus-audit-2026-09.md）。
 *
 * 原实现把这些封装散在 desktop client 的 `apply()` 闭包里、作为「上帝对象」注入面
 * 逐个塞给 EditorColumn（同一份 `connection.rpc.call('/api', 'corumFs/…')` 模式重复
 * 11 次）。现收进本模块的 `CorumFsClient`，由 desktop client `ctx.provide` 为 cordis
 * 服务：① 调用面单点定义（host 端点改名/新增只改这里）；② 任何 bundle 可经 inject
 * 复用（当前消费方 EditorColumn 仍走注入面，行为不变）。
 *
 * @module corum-desktop/client/editor/corum-fs-client
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { FsEntry } from './ExplorerPane.tsx'

/** corumFs RPC 统一信封（host Typert Remote 的 `{ ok, error?, value? }`）。 */
export interface CorumFsResult<T = never> {
  ok: boolean
  error?: { message?: string }
  value?: T
}

/** corumFs 调用面（14 个端点；与 host corum-fs.ts 的 @Remote 一一对应）。 */
export interface CorumFsClient {
  /** 用户明确打开的外部文件，仅创建该文件的只读预览。 */
  openExternalPreview(path: string): Promise<CorumFsResult<{ path: string }>>
  /** 撤销外部预览登记（关闭只读 tab 时调用；幂等）。 */
  releaseExternalPreview(path: string): Promise<CorumFsResult<{ released: boolean }>>
  /** 列目录（相对项目根；防穿越在 host 侧）。 */
  list(path: string): Promise<CorumFsResult<{ entries: FsEntry[] }>>
  /** 读文本文件。 */
  read(path: string): Promise<CorumFsResult<{ content: string; language: string }>>
  /** 读二进制文件（图片/PDF 预览）。 */
  readBinary(path: string): Promise<CorumFsResult<{ mime: string; base64: string }>>
  /** 写文本文件。 */
  write(path: string, content: string): Promise<CorumFsResult>
  /** 递归建目录。 */
  mkdir(path: string): Promise<CorumFsResult>
  /** 删除文件/目录。 */
  delete(path: string): Promise<CorumFsResult>
  /** 重命名/移动。 */
  rename(from: string, to: string): Promise<CorumFsResult>
  /** 相对路径 → 绝对路径（沙箱校验用）。 */
  absolutePath(path: string): Promise<CorumFsResult<{ absolutePath: string }>>
  /** 在系统文件管理器中显示。 */
  reveal(path: string): Promise<CorumFsResult>
  /** 切换项目根（cwd）。 */
  setRoot(cwd: string): Promise<CorumFsResult>
  /** 启动/重启项目根递归 watch（变更经 `corum/file/changed` 推送）。 */
  watch(): Promise<CorumFsResult>
}

/** 构造 corumFs 调用面（desktop client apply 持 connection 后调用一次）。 */
export function createCorumFsClient(connection: ConnectionHandle): CorumFsClient {
  const call = async <T>(method: string, args: Record<string, unknown>): Promise<CorumFsResult<T>> =>
    await connection.rpc.call('/api', `corumFs/${method}`, { args }) as unknown as CorumFsResult<T>
  return {
    openExternalPreview: path => call('openExternalPreview', { path }),
    releaseExternalPreview: path => call('releaseExternalPreview', { path }),
    list: path => call('list', { path }),
    read: path => call('read', { path }),
    readBinary: path => call('readBinary', { path }),
    write: (path, content) => call('write', { path, content }),
    mkdir: path => call('mkdir', { path }),
    delete: path => call('delete', { path }),
    rename: (from, to) => call('rename', { from, to }),
    absolutePath: path => call('absolutePath', { path }),
    reveal: path => call('reveal', { path }),
    setRoot: cwd => call('setRoot', { cwd }),
    watch: () => call('watch', {}),
  }
}
