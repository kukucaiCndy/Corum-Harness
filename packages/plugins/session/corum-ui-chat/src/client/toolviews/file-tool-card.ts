/**
 * fork（corum）：文件工具卡（read / edit / write 统一玻璃卡）的数据模型（2026-09-14）。
 *
 * 设计源：`doc/UXDesign/design.pen` §1.1 `row-文件工具卡` 六个 reusable 组件
 * （`file-card-read-ok` / `-read-fail` / `-edit-ok` / `-edit-miss` / `-write-ok` /
 * `-write-fail`）+ 设计报告 `docs/analysis/file-tool-card-design-2026-09-14.md` §2/§2.1。
 *
 * 本文件保持**纯函数、无 React、无 cordis**（与 edit-not-found.ts 同纪律）：
 * 三个工具的参数形 / 结果文本 / presentationMeta 的窄化解析都集中在这里，
 * UI 内不散落正则，fixture 测试可直接喂真实文本。
 *
 * @module @corum/corum-ui-chat/toolviews/file-tool-card
 */
import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

/**
 * read 卡的默认显示行数（定稿取舍点 C，2026-09-14 用户拍板）：
 * 默认 5 行 + 底部固定截断提示「已截断 · 已读 N 行 / 共 M 行」。
 * 官方 `DEFAULT_READ_MAX_LINES = 16` 不适用于本卡（设计稿画的是 5 行）。
 */
export const DEFAULT_FILE_CARD_READ_LINES = 5

/** read 工具的参数形（官方 `validReadCall` 同口径：file_path 必填，offset/limit 可选正整数）。 */
export interface FileCardReadArgs {
  readonly filePath: string
  readonly offset?: number
  readonly limit?: number
}

/** read 结果的呈现元数据（官方 `readMeta` 同口径的窄化版）。 */
export interface FileCardReadMeta {
  readonly path: string
  readonly offset: number
  readonly lines: readonly { readonly number: number; readonly text: string }[]
  readonly totalLines: number
  readonly lang?: string
}

/** write 工具的参数形。 */
export interface FileCardWriteArgs {
  readonly filePath: string
  readonly content: string
}

/** write 的落盘动作（官方 `formatWriteOutput` 的 `Created file` / `Updated file` 两档）。 */
export type FileCardWriteOutcome = 'create' | 'update'

/** 失败原因分档（定稿取舍点 D：非路径类错误与「不存在 / 无权限」同一张失败卡，只换原因标签）。 */
export type FileCardCauseKind =
  | 'not-found'
  | 'no-permission'
  | 'is-directory'
  | 'encoding'
  | 'sandbox'
  | 'unknown'

/** 一条失败原因：分档（决定 i18n 标签）+ 等宽原文（设计稿 `reason` 面板的第二列）。 */
export interface FileCardCause {
  readonly kind: FileCardCauseKind
  readonly detail: string
}

/** 有限窄化助手：未知/缺失一律回 undefined（调用方决定降级）。 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 解析 JSON 对象形参数（非对象/坏 JSON 一律 undefined）。 */
function parseArgsObject(argsRaw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 解析 read 参数（`file_path` 必填；`offset`/`limit` 只在正整数时保留）。 */
export function readCallArgs(argsRaw: string): FileCardReadArgs | undefined {
  const args = parseArgsObject(argsRaw)
  if (args === undefined) return undefined
  const filePath = args.file_path
  if (typeof filePath !== 'string' || filePath.trim() === '') return undefined
  const offset = asNumber(args.offset)
  const limit = asNumber(args.limit)
  return {
    filePath,
    ...offset !== undefined && Number.isInteger(offset) && offset >= 1 ? { offset } : {},
    ...limit !== undefined && Number.isInteger(limit) && limit >= 1 ? { limit } : {},
  }
}

/** 解析 edit / write 共用的 `file_path`（与 `editFilePath` 同口径，供三工具统一取路径）。 */
export function filePathFromArgs(argsRaw: string): string | undefined {
  const args = parseArgsObject(argsRaw)
  const filePath = args?.file_path
  return typeof filePath === 'string' && filePath !== '' ? filePath : undefined
}

/** 解析 write 参数（`file_path` + `content` 都必填，缺一即降级）。 */
export function writeCallArgs(argsRaw: string): FileCardWriteArgs | undefined {
  const args = parseArgsObject(argsRaw)
  if (args === undefined) return undefined
  const filePath = args.file_path
  const content = args.content
  if (typeof filePath !== 'string' || filePath.trim() === '') return undefined
  if (typeof content !== 'string') return undefined
  return { filePath, content }
}

/**
 * 窄化 read 的 presentationMeta（官方 `readMeta` 同口径：行号严格递增、≤ totalLines）。
 * 任一字段不合法 → undefined（调用方降级，绝不用半截数据画卡）。
 */
export function readMeta(meta: unknown): FileCardReadMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  const path = record.path
  const offset = asNumber(record.offset)
  const totalLines = asNumber(record.totalLines)
  if (typeof path !== 'string' || path === '') return undefined
  if (offset === undefined || offset < 1) return undefined
  if (totalLines === undefined || totalLines < 0) return undefined
  if (!Array.isArray(record.lines)) return undefined
  const lines: { number: number; text: string }[] = []
  for (const entry of record.lines) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const item = entry as Record<string, unknown>
    const number = asNumber(item.number)
    const text = item.text
    if (number === undefined || !Number.isInteger(number) || number < 1) return undefined
    if (typeof text !== 'string') return undefined
    if (number > totalLines) return undefined
    const previous = lines.at(-1)
    if (previous !== undefined && number <= previous.number) return undefined
    lines.push({ number, text })
  }
  const lang = record.lang
  return {
    path,
    offset,
    lines,
    totalLines,
    ...typeof lang === 'string' && lang !== '' ? { lang } : {},
  }
}

/**
 * 窄化 write / edit 的 presentationMeta.diffs（官方 `narrowDiffs` 同口径）。
 *
 * 注意 `[]` 与 undefined 的**语义差别**（官方 `appliedDiffs` 的 `"empty"` 哨兵）：
 * write 用一个合法的空 diffs 表示「新建 / 内容与原文完全相同」，这时官方**回落到
 * 参数派生的整文件 diff**（`diffCardModel`：`applied === "empty"` → intended）。
 * 所以调用方必须用 `nonEmptyDiffs` 而不是裸 `diffsFromMeta`。
 */
export function diffsFromMeta(meta: unknown): DiffHunk[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  if (!Array.isArray(record.diffs)) return undefined
  const hunks: DiffHunk[] = []
  for (const entry of record.diffs) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const item = entry as Record<string, unknown>
    const path = item.path
    const oldText = item.oldText
    const newText = item.newText
    if (typeof path !== 'string') return undefined
    if (typeof oldText !== 'string' && oldText !== null) return undefined
    if (typeof newText !== 'string') return undefined
    hunks.push({ path, oldText: oldText as string | null, newText })
  }
  return hunks
}

/**
 * 落盘 diff，但把「合法空数组」当成 undefined（= 回落到参数派生的 intended diff）。
 * 官方语义：空 diffs 表示没有可呈现的增量（新建 / 完全相同），此时用 intended。
 */
export function nonEmptyDiffs(meta: unknown): DiffHunk[] | undefined {
  const hunks = diffsFromMeta(meta)
  return hunks === undefined || hunks.length === 0 ? undefined : hunks
}

/**
 * 结果文本提取（与官方 `resultText` 同口径：content 里 text block 按序拼接）。
 * 失败原因、write 的 create/update 都从这里读——错误原文绝不吞掉（红线）。
 */
export function resultText(props: ToolCallViewProps): string | undefined {
  if (!('kind' in props.block)) return undefined
  const texts: string[] = []
  for (const block of props.block.content) {
    if (
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string'
    ) {
      texts.push(block.text)
    }
  }
  return texts.length === 0 ? undefined : texts.join('\n')
}

/**
 * 从 write 的结果文本判新建 / 覆盖（官方 `formatWriteOutput` 的
 * `<type>file</type>\n<content>\nCreated file|Updated file\n</content>` 信封）。
 */
export function writeOutcome(text: string | undefined): FileCardWriteOutcome | undefined {
  if (text === undefined) return undefined
  const match = /\n(Created|Updated) file\n/u.exec(text)
  if (match === null) return undefined
  return match[1] === 'Created' ? 'create' : 'update'
}

/**
 * write 的 intended diff（官方 `intendedDiff` 的 write 分支同口径）：
 * `{ path, oldText: null, newText: content }`——新建与覆盖同构，
 * 「新建 / 覆盖」由 head 的 mode 徽标区分（定稿取舍点 E 的已批准形态）。
 */
export function intendedWriteHunk(args: FileCardWriteArgs | undefined): DiffHunk | undefined {
  if (args === undefined) return undefined
  return { path: args.filePath, oldText: null, newText: args.content }
}

/**
 * edit 成功态的 intended diff（官方 `intendedDiff` 的 edit 分支同口径：
 * `old_string` / `new_string` 全量段；`old_string` 缺失 = 全新增）。
 */
export function intendedEditHunk(argsRaw: string): DiffHunk | undefined {
  const args = parseArgsObject(argsRaw)
  if (args === undefined) return undefined
  const filePath = args.file_path
  if (typeof filePath !== 'string' || filePath.trim() === '') return undefined
  const newText = args.new_string
  if (typeof newText !== 'string') return undefined
  const oldText = args.old_string
  if (oldText !== undefined && typeof oldText !== 'string') return undefined
  return { path: filePath, oldText: oldText ?? null, newText }
}

/** 失败原因分档的匹配表：按等宽原文里出现的错误码/关键短语归类（顺序即优先级）。 */
const CAUSE_PATTERNS: readonly { readonly kind: FileCardCauseKind; readonly pattern: RegExp }[] = [
  { kind: 'sandbox', pattern: /sandbox:|沙箱|denied outside|write denied/iu },
  { kind: 'not-found', pattern: /\bENOENT\b|no such file or directory|不存在/u },
  { kind: 'no-permission', pattern: /\bEACCES\b|\bEPERM\b|permission denied|拒绝访问|无权限/u },
  { kind: 'is-directory', pattern: /\bEISDIR\b|is a directory|是目录/u },
  { kind: 'encoding', pattern: /\bEILSEQ\b|encoding|invalid utf-?8|编码/u },
]

/** 每行的最长保留长度（原因面板是等宽单行，超长截断避免撑破玻璃卡）。 */
const CAUSE_DETAIL_MAX = 160

/** 一条原因行的原文候选：跳过围栏/标记行，取含错误码的那一行；没有就取首个非空行。 */
function causeDetailLines(text: string): string[] {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('<<<corum-'))
  const withCode = lines.filter(line => CAUSE_PATTERNS.some(({ pattern }) => pattern.test(line)))
  return withCode.length > 0 ? withCode : lines.slice(0, 1)
}

/**
 * 把失败结果文本分成原因行（定稿取舍点 D：读目录 / 编码错走**同一张失败卡**，
 * 只是原因标签换文案）。最多两行——设计稿的 `reason` 面板就是 r1/r2 两行。
 *
 * @param text - tool-result 的完整原文（含 errors 的 `name: code` 兜底段）。
 * @returns 原因列表；识别不出任何分档时给一条 `unknown`（原文照旧可见，不吞错）。
 */
export function classifyFailure(text: string, errorCode?: string): FileCardCause[] {
  const details = causeDetailLines(text)
  const causes: FileCardCause[] = []
  const seen = new Set<FileCardCauseKind>()
  for (const detail of details) {
    for (const { kind, pattern } of CAUSE_PATTERNS) {
      if (seen.has(kind) || !pattern.test(detail)) continue
      seen.add(kind)
      causes.push({ kind, detail: detail.slice(0, CAUSE_DETAIL_MAX) })
      break
    }
    if (causes.length >= 2) break
  }
  if (causes.length > 0) return causes
  const fallback = details[0] ?? (errorCode === undefined ? '' : errorCode)
  return [{ kind: 'unknown', detail: fallback.slice(0, CAUSE_DETAIL_MAX) }]
}

/**
 * read 的范围 chip 文案参数（设计稿 `L1–60`：起止都用**文件真实行号**，
 * 不是 1..N——offset 读取时首行号就是 offset）。
 */
export function readRange(meta: FileCardReadMeta): { start: number; end: number } | undefined {
  const first = meta.lines[0]
  const last = meta.lines.at(-1)
  if (first === undefined || last === undefined) return undefined
  return { start: first.number, end: last.number }
}

/** cwd 相对化（官方 `relativizeToCwd` 同语义）。分隔符按平台（P2 收口，
 *  原硬编码 `/` ⇒ Windows 的 `\` cwd 永不匹配）。实现见 ui-base platform-paths。 */
export { shortenPath } from '@corum/corum-ui-base/client'
