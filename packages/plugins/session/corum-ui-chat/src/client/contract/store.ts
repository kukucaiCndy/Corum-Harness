/** Chat-owned selection state shared by the transcript and details panel. */

/** Tool call identity as carried by Chat nodes. */
export type ToolCallId = string

/** Selection target for the Chat details linkage channel. */
export interface SelectionTarget {
  turnSeq: number
  stepSeq?: number
  callId?: ToolCallId
  toolName?: string
}

/** One manually expanded Turn answer generation. */
export interface TurnProcessViewEntry {
  readonly turn: number
  readonly answerStep: number
}

/**
 * 一张提交卡片的折叠状态（2026-10-12 用户定调）。
 *
 * 提交卡片出现后，其 steer 锚点**之后**的同 turn 过程（思考/工具/结论）
 * 收进卡片内部——默认折叠（只有卡片头部可见），用户点卡片头部展开才看得到。
 * 用户一旦手动点过，就记住用户选择（不再随 done 态自动回折）。
 */
export interface CommitCardViewEntry {
  readonly turn: number
  /** 用户手动设定的展开态；`undefined` = 未干预（跟随卡片状态自动决定）。 */
  readonly open: boolean
}

/** Per-Session state shared only by the Chat view and details surface. */
export interface ChatStoreState {
  selection: SelectionTarget | null
  turnProcesses: TurnProcessViewEntry[]
  /** 各 turn 提交卡片的用户手动折叠选择（未记录的 turn = 用户未干预）。 */
  commitCards: CommitCardViewEntry[]
}
