// fork（corum）：Review 卡数据模型——从会话事件窗的 tool/call + tool/result
// 事件里聚合成「本轮未确认的文件更改」。官方 dsh 无此概念，数据全部从
// 事件流重新推导，不依赖任何 tool 私有 meta。

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** 识别为「文件写操作」的工具集合。
 *  - dsh-tool-fs 的 edit（file_path/old_string/new_string，唯一替换语义）
 *  - dsh-tool-fs 的 write（file_path/content，整文件 create-or-overwrite）
 *  - dsh-tool-str-replace-editor（path + command: str_replace/create/insert）
 * 只认这些已知工具的已知参数形态；未知 name 一律不算写操作。 */
export const FILE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'edit', 'write', 'str_replace_editor',
])

/** 写工具的参数形态（tool/call 的 arguments JSON 反序列化后）。 */
export interface WriteToolArgs {
  readonly filePath: string
  readonly kind: 'edit' | 'write' | 'create' | 'insert'
  /** edit/str_replace：被替换的旧文本。 */
  readonly oldString?: string | undefined
  /** edit/write/create/insert：写入的新文本。 */
  readonly newString?: string | undefined
  /** str_replace_editor insert：在 insert_line 之前插入（0-based 行号）。 */
  readonly insertLine?: number | undefined
}

/** 从 tool/call 参数解析出写操作描述；不是写操作时返回 undefined。
 * @param name - tool/call 的 name。
 * @param argsRaw - tool/call 的 arguments（JSON string）。
 */
export function parseWriteToolArgs(name: string, argsRaw: string): WriteToolArgs | undefined {
  if (!FILE_WRITE_TOOL_NAMES.has(name)) return undefined
  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    args = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  const str = (key: string): string | undefined =>
    typeof args[key] === 'string' ? args[key] as string : undefined
  if (name === 'edit') {
    const filePath = str('file_path')
    const oldString = str('old_string')
    const newString = str('new_string')
    if (filePath === undefined || oldString === undefined || newString === undefined) return undefined
    return { filePath, kind: 'edit', oldString, newString }
  }
  if (name === 'write') {
    const filePath = str('file_path')
    const newString = str('content')
    if (filePath === undefined || newString === undefined) return undefined
    return { filePath, kind: 'write', newString }
  }
  // str_replace_editor：path + command 决定操作；view 不是写操作。
  const command = str('command')
  const filePath = str('path')
  if (filePath === undefined) return undefined
  if (command === 'str_replace') {
    const oldString = str('old_str')
    if (oldString === undefined) return undefined
    // new_str 缺省/null = 删除匹配段。
    const newString = str('new_str') ?? ''
    return { filePath, kind: 'edit', oldString, newString }
  }
  if (command === 'create') {
    const newString = str('file_text')
    if (newString === undefined) return undefined
    return { filePath, kind: 'create', newString }
  }
  if (command === 'insert') {
    const newString = str('new_str')
    const insertLine = typeof args.insert_line === 'number' ? args.insert_line : undefined
    if (newString === undefined) return undefined
    return { filePath, kind: 'insert', newString, insertLine }
  }
  return undefined
}

/** 一段文本的行数（空串 = 0 行；以换行计，与 str_replace_editor 的行计数一致）。 */
export function lineCount(text: string): number {
  if (text === '') return 0
  return text.split('\n').length
}

/** 一条写操作的行数差（+ 新增 / − 删除；量级近似，不做逐行 diff）。 */
export function writeLineDelta(args: WriteToolArgs): { added: number; removed: number } {
  if (args.kind === 'edit') {
    const before = lineCount(args.oldString ?? '')
    const after = lineCount(args.newString ?? '')
    return after >= before
      ? { added: after - before, removed: 0 }
      : { added: 0, removed: before - after }
  }
  if (args.kind === 'insert') return { added: lineCount(args.newString ?? ''), removed: 0 }
  // write / create：整文件写入，只能把新内容全计为新增（覆盖的旧内容不可知）。
  return { added: lineCount(args.newString ?? ''), removed: 0 }
}

/** 一次被聚合的文件写操作（tool/call 与结果配对后）。 */
export interface ReviewWriteOp {
  readonly callId: string
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly args: WriteToolArgs
  readonly added: number
  readonly removed: number
}

/** Review 卡里一个文件的聚合视图。 */
export interface ReviewFileChange {
  readonly path: string
  readonly added: number
  readonly removed: number
  readonly ops: readonly ReviewWriteOp[]
}

/** Review 卡完整聚合：总 diff + 每文件 diff + 撤销用的逆序操作列表。 */
export interface ReviewChanges {
  readonly totalAdded: number
  readonly totalRemoved: number
  readonly files: readonly ReviewFileChange[]
  /** 撤销时的应用顺序：新写的先撤（call seq 逆序）。 */
  readonly revertOrder: readonly ReviewWriteOp[]
}

const EMPTY_REVIEW: ReviewChanges = {
  totalAdded: 0, totalRemoved: 0, files: [], revertOrder: [],
}

export function emptyReviewChanges(): ReviewChanges {
  return EMPTY_REVIEW
}

/** tool/result 的 content 是否有错误标记（isError 为 true 的调用不算成功写操作）。 */
function resultFailed(event: SessionEvent<'tool/result'>): boolean {
  if (event.data.error !== undefined) return true
  const block = event.data.message.content[0]
  return block?.isError === true
}

/** 从完整事件窗聚合未确认的文件写操作。
 * @param entries - 会话事件窗条目（SessionEventLikeEntry 的 event 子集）。
 * @param confirmedSeq - 「全部保留」确认水位：seq 小于等于它的写操作已确认，不再计入。
 */
export function aggregateReviewChanges(
  entries: readonly { readonly event: SessionEvent }[],
  confirmedSeq: number,
): ReviewChanges {
  const failedCallIds = new Set<string>()
  for (const entry of entries) {
    const event = entry.event
    if (event.type === 'tool/result' && resultFailed(event)) {
      failedCallIds.add(String(event.data.message.source.callId))
    }
  }
  const files = new Map<string, { added: number; removed: number; ops: ReviewWriteOp[] }>()
  const revert: ReviewWriteOp[] = []
  for (const entry of entries) {
    const event = entry.event
    if (event.type !== 'tool/call') continue
    if (event.seq <= confirmedSeq) continue
    const callId = String(event.data.callId)
    if (failedCallIds.has(callId)) continue
    const args = parseWriteToolArgs(event.data.name, event.data.arguments)
    if (args === undefined) continue
    const delta = writeLineDelta(args)
    const op: ReviewWriteOp = {
      callId,
      turn: event.data.turn,
      seq: event.seq,
      time: event.time,
      args,
      added: delta.added,
      removed: delta.removed,
    }
    const bucket = files.get(args.filePath) ?? { added: 0, removed: 0, ops: [] }
    bucket.added += delta.added
    bucket.removed += delta.removed
    bucket.ops.push(op)
    files.set(args.filePath, bucket)
    revert.push(op)
  }
  revert.sort((a, b) => b.seq - a.seq)
  let totalAdded = 0
  let totalRemoved = 0
  const fileList: ReviewFileChange[] = []
  for (const [path, bucket] of files) {
    totalAdded += bucket.added
    totalRemoved += bucket.removed
    fileList.push({ path, added: bucket.added, removed: bucket.removed, ops: bucket.ops })
  }
  // 文件按最新一次写入排序，最近动的在前。
  fileList.sort((a, b) => (b.ops.at(-1)?.seq ?? 0) - (a.ops.at(-1)?.seq ?? 0))
  return { totalAdded, totalRemoved, files: fileList, revertOrder: revert }
}
