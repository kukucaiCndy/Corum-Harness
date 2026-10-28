/**
 * 工具调用的**惰性参数视图**（rc3 契约面的最小实现）。
 *
 * ## 为什么有这个文件（2026-10-29 rc3 行为验收实测缺陷）
 *
 * rc3 的官方工具行实现（`@deepseek-ai/dsh-client-ui-tool` 的 `toolRowModel`）
 * 用 `block.args` 读参数：
 *
 * ```js
 * const primary = argumentSummary(variant, block.args, cwd, home)
 * // → args.complete("file_path") / args.text("file_path") / args.has(key) / args.stringLength(key)
 * ```
 *
 * 官方 `ui-chat` 的块构建器给每个块都带 `args`（官方是 `PartialArguments` 实例）。
 * corum fork 的块构建器漏了这一层 ⇒ 任何**未被 fork 卡认领**的工具行渲染即抛
 * `TypeError: Cannot read properties of undefined (reading 'text')`，被槽错误边界
 * 吞成一行错误占位。实测：打开一条真实 v4 历史会话时 66 个工具节点全部崩，
 * 页面 console 出现成对错误（`argumentSummary` + `slot entry crashed in
 * 'conversation.chat.node'`）。
 *
 * ## 语义（与官方 `PartialArguments` 读者面一致）
 *
 * 本仓的块都是**已完成**调用（`tool/call` / `tool/result` 事件），没有流式
 * preparing 阶段，因此视图恒为 **sealed**：源是那段已完成 JSON 文本。
 * 读取器全部 **total**（缺字段/类型不符返回 `undefined` / `false`，绝不抛）——
 * 与官方注释「Every reader is total」同款纪律。
 *
 * @module @corum/corum-ui-conversation/client/tool-args
 */
import type { ToolArgumentView } from './contract/records.ts'

/** 已解析对象视图（惰性解析：官方工具行按需读字段，不读就不解析）。 */
class SealedArguments implements ToolArgumentView {
  readonly isSealed = true
  private parsed: Record<string, unknown> | null | undefined

  /** 已完成调用的参数 JSON 原文（可能为空串或坏 JSON）。 */
  private readonly raw: string

  /**
   * @param raw - 参数 JSON 原文。
   */
  constructor(raw: string) {
    // ⚠️ 字段名**不能**叫 `text`：本类同时有 `text(key)` 读取器，同名字段会
    // 在构造时被 own property 覆盖掉原型方法（本文件的单测第一版就踩了这个）。
    this.raw = raw
  }

  /**
   * 解析一次并缓存；非对象/坏 JSON 视作「无字段」。
   * @returns 参数对象，或 null（无字段）。
   */
  private object(): Record<string, unknown> | null {
    if (this.parsed !== undefined) return this.parsed
    try {
      const value: unknown = JSON.parse(this.raw)
      this.parsed = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    } catch {
      this.parsed = null
    }
    return this.parsed
  }

  has(key: string): boolean {
    const object = this.object()
    return object !== null && Object.hasOwn(object, key)
  }

  complete(key: string): boolean {
    // 封口视图：字段到场且值可读即完整（官方对 sealed 视图的 completeNow 同义）。
    return this.has(key)
  }

  text(key: string): string | undefined {
    const object = this.object()
    if (object === null || !Object.hasOwn(object, key)) return undefined
    const value = object[key]
    return typeof value === 'string' ? value : undefined
  }

  stringLength(key: string, options?: { step?: number; offset?: number }): number | undefined {
    const value = this.text(key)
    if (value === undefined) return undefined
    const step = Math.max(1, Math.floor(options?.step ?? 1))
    const offset = options?.offset ?? 0
    return Math.ceil((value.length + offset) / step)
  }
}

/**
 * 由已完成调用的参数原文建一个 sealed 参数视图。
 * @param argsRaw - 参数 JSON 原文（`tool/call` 的 `arguments`，或派发对象的 JSON）。
 * @returns 官方工具行可读的 `block.args`。
 */
export function toolArguments(argsRaw: string): ToolArgumentView {
  return new SealedArguments(argsRaw)
}

/** 无参数可读时视图（窗口截断丢失调用头等）。 */
export const EMPTY_TOOL_ARGUMENTS: ToolArgumentView = toolArguments('')
