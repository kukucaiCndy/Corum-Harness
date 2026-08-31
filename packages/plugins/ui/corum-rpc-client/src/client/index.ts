/**
 * @corum/corum-rpc-client —— corum 自有 RPC 的浏览器调用助手。
 *
 * dsh 基座 0.1.2 起，desktop 架构从「自定义 IPC transport」换成「官方 loopback
 * webserver + loadURL authenticatedUrl」，旧的 `window.corumDesktop.unary` IPC
 * 桥已删除。原来手搓的 `client-request` 信封 + rpcId 核对 + HTTP status 检查
 * 全部由官方 `connection.rpc.call` 内部处理：
 *
 *   connection.rpc.call(channel '/api', endpoint '<ns>/<method>', payload { args })
 *
 * endpoint 的 `<ns>/<method>` 与旧 unary 路径 `/api/<ns>/<method>` 一致
 * （如 `corumAgent/listProfiles`、`skillManager/listAll`、`pluginManager/list`）。
 */
import { type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

/**
 * 一个命名空间化的 corum RPC 调用函数（失败抛 `<code>: <message>`）。
 *
 * args 形参是泛型 `A extends object`（缺省 `Record<string, unknown>`）而非固定
 * `Record<string, unknown>`——TS 的具名 interface 无隐式索引签名、不能赋给
 * `Record<string, unknown>`（C3b 契约的 `CreateTaskAgentArgs` 等 Args 类型直接
 * 传入时会 TS2345）；放宽为泛型后任何具名 object 类型都可直接传，运行时零变化。
 */
export type CorumRpcCall = <T, A extends object = Record<string, unknown>>(service: string, method: string, args: A) => Promise<T>

/**
 * 基于官方 ConnectionHandle 构造 corum RPC 调用函数。
 *
 * 供 client 插件在 apply 内调用一次（`ctx.get('connection') as ConnectionHandle`），
 * 把返回的 caller 传给纯 React 面板组件（面板不再依赖 cordis ctx，可跨包复用）。
 *
 * @param connection - 官方 client connection 服务（`ctx.connection`）。
 * @returns 命名空间化调用函数；`!result.ok` 时抛错，成功返回 `result.value`。
 */
export function makeCorumRpcCall(connection: ConnectionHandle): CorumRpcCall {
  return async function callRemote<T, A extends object = Record<string, unknown>>(service: string, method: string, args: A): Promise<T> {
    const result = await connection.rpc.call('/api', `${service}/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}
