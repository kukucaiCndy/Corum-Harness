// fork（corum）：Review 卡「全部撤销」实操——把聚合出的写操作逆序（新写的
// 先撤）编译成 host 端 corumFs/revertWrites RPC 的 op 列表，一次调用反向
// apply 回磁盘（read → 唯一匹配 splice → write，见 desktop host corum-fs.ts）。
// 撤销路径走官方 connection.rpc（/api 命名空间，与 ide-explorer 同一范式）。
//
// 可撤销性（事件流只含工具入参，不含文件旧内容，所以分三档）：
//   edit / str_replace          → 精确反向（swap oldString/newString），host 端
//                                 唯一匹配校验，漂移即失败（安全）。
//   str_replace_editor create   → delete（文件仍在则删除）。
//   write（整文件覆盖）          → 旧内容不可知，跳过（skipped）。
//   str_replace_editor insert   → 行号已漂移，跳过（skipped）。

// ConnectionHandle 经 dsh-api-remotes/client 再导出（ui-chat 未直接依赖
// dsh-client-connection，与 apply.ts 的 remotes 类型引入同一通道）。
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ReviewWriteOp } from './review-changes.ts'

/** 「全部撤销」的执行结果。 */
export interface RevertAllResult {
  readonly ok: boolean
  readonly reverted: number
  readonly failed: number
  readonly skipped: number
  readonly message?: string
}

/** host corumFs/revertWrites 的 op 线格式。 */
interface RevertRpcOp {
  readonly path: string
  readonly kind: 'edit' | 'delete' | 'restoreContent'
  readonly oldString?: string
  readonly newString?: string
}

interface RevertRpcResponse {
  readonly ok: boolean
  readonly value?: { reverted: number; failed: number; results: { path: string; ok: boolean; message?: string }[] }
  readonly error?: { message?: string }
}

/** 把聚合出的写操作编译成可下发的撤销 op；不可安全撤销的条目单独计数。 */
export function compileRevertOps(
  ops: readonly ReviewWriteOp[],
): { rpcOps: RevertRpcOp[]; skipped: number } {
  const rpcOps: RevertRpcOp[] = []
  let skipped = 0
  for (const op of ops) {
    if (op.args.kind === 'edit') {
      rpcOps.push({
        path: op.args.filePath,
        kind: 'edit',
        // 反向：把当时写入的 newString 换回 oldString。
        oldString: op.args.newString ?? '',
        newString: op.args.oldString ?? '',
      })
      continue
    }
    if (op.args.kind === 'create') {
      rpcOps.push({ path: op.args.filePath, kind: 'delete' })
      continue
    }
    // write（覆盖写，旧内容不可知）与 insert（行号漂移）：跳过。
    skipped++
  }
  return { rpcOps, skipped }
}

/** 执行整批撤销：compile → 一次 RPC → 聚合结果。 */
export async function revertAllOps(
  connection: ConnectionHandle,
  ops: readonly ReviewWriteOp[],
): Promise<RevertAllResult> {
  const { rpcOps, skipped } = compileRevertOps(ops)
  if (rpcOps.length === 0) {
    return { ok: false, reverted: 0, failed: 0, skipped, message: 'no reversible operations' }
  }
  let response: RevertRpcResponse
  try {
    response = await connection.rpc.call('/api', 'corumFs/revertWrites', { args: { ops: rpcOps } }) as RevertRpcResponse
  } catch (error) {
    return {
      ok: false, reverted: 0, failed: rpcOps.length, skipped,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  if (!response.ok || response.value === undefined) {
    return {
      ok: false, reverted: 0, failed: rpcOps.length, skipped,
      message: response.error?.message ?? 'revertWrites RPC failed',
    }
  }
  const { reverted, failed, results } = response.value
  const firstFailure = results.find(item => !item.ok)
  return {
    ok: failed === 0 && skipped === 0,
    reverted,
    failed,
    skipped,
    ...(firstFailure?.message === undefined ? {} : { message: firstFailure.message }),
  }
}
