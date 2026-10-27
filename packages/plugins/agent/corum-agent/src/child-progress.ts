/**
 * 子 Agent 进度投影里的**纯判定与纯折叠**（corum fork 增量）。
 *
 * ## 2026-09-13：先抽出「半途失去运行」的判定
 *
 * 这条判定此前长在 `agent-service.ts` 的 RPC 方法体里（读持久化事件的循环 +
 * registry 查询 + 本进程启动时刻），没有任何单测能碰它——而 2026-09-12 那个把 8 张卡片
 * 全卡在 Running 的事故正出在这条路径上（`agents.list` 被当成可迭代属性用 → RPC 整体抛
 * `function is not iterable` → 渲染层的冷启动基线全废）。纯函数化之后，「什么时候算半途
 * 失去运行」有单测钉住，改坏了会红。
 *
 * ## 2026-09-21：再抽出**事件折叠**（架构拆分第二轮 P1）
 *
 * 折叠同一条会话事件语义**此前有两份实现**，靠源头一句注释人肉维持一致：
 *
 * | 位置 | 形态 |
 * |---|---|
 * | `agent-service.foldSubagentProgress` | 增量（随 `session/event` 逐条折） |
 * | `agent-service.getChildSessionProgressRemote` 内的循环 | 全量（读持久化事件折一遍） |
 *
 * 两份各 6 个 `case`，**改一边不会红**。本模块把折叠收成**唯一一份**纯函数：
 * {@link foldProgressEvent}（折一条）与 {@link foldProgressAll}（折一窗，= 逐条折的
 * 归纳），增量与全量两条路径都调它 ⇒ 漂移在结构上不再可能。
 *
 * ⚠️ **本模块不得引入 I/O**（不读盘、不查 registry、不发事件、不看时钟）。中断判据的
 * 「现在」与「本进程启动时刻」都由调用方经 {@link ChildRunInterruptInput} 传进来，
 * 正是为了让它可单测。
 *
 * @module @corum/corum-agent/child-progress
 */

import {
  stopReasonOfTurnEnd,
  type SubagentProgressEvent,
  type SubagentStopReason,
  type SubagentTodoItem,
} from '@corum/corum-api-remotes/corum-events'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * 进度折叠状态（**不含** `sessionId` / `lastActive` / `changeSummary`——那三者不是
 * 「折叠出来的状态」而是「本帧的元信息」，见 {@link ProgressState} 的字段清单）。
 */
export interface ProgressState {
  /** 最新已开启 turn（0 = 尚未开 turn）。 */
  readonly turn: number
  /** 当前 turn 已闭合 step 数。 */
  readonly step: number
  /** 当前动作（最新工具调用名）；无进行中动作时**不带该键**。 */
  readonly currentAction?: string
  /** 最新 turn 是否已闭合（`turn/end`）。不代表终态——终态看 `stopReason`。 */
  readonly done: boolean
  /** 终局原因；`turn/start` 会重置为「无」。 */
  readonly stopReason?: SubagentStopReason
  /** 计划列表（`todo/write` last-write-wins；`turn/start` 重置为「无」）。 */
  readonly todos?: readonly SubagentTodoItem[]
}

/** 折叠的初始状态（未开任何 turn）。 */
export function initialProgressState(): ProgressState {
  return { turn: 0, step: 0, done: false }
}

/**
 * 把**一条**子会话事件折进 `prev`；**无变化返回 `undefined`**。
 *
 * 「无变化」= 该事件与进度语义无关（`user/message`、`step/start` 等），或折叠结果与
 * `prev` 逐字段相同（乱序 / 重复事件）。调用方（增量路径）据此**不广播**帧。
 *
 * ⚠️ 返回的对象**按键存在性**构造（可选字段缺省时**不带键**，不是 `undefined` 占位）——
 * 这是既有契约，UI 侧按 `=== undefined` 判「无该信息」；`Object.keys` 的差异也会影响
 * 等价判据，故必须逐字保持。
 *
 * @param prev - 该会话当前的折叠状态。
 * @param event - 新到的会话事件。
 * @returns 新状态；无变化时 `undefined`。
 */
export function foldProgressEvent(prev: ProgressState, event: SessionEvent): ProgressState | undefined {
  let turn = prev.turn
  let step = prev.step
  let currentAction = prev.currentAction
  let done = prev.done
  let stopReason = prev.stopReason
  let todos = prev.todos
  switch (event.type) {
    case 'turn/start': {
      const t = (event.data as { turn?: number }).turn ?? 0
      if (t > turn) { turn = t; step = 0 }
      done = false
      stopReason = undefined // 新一轮开始＝不再有终态
      todos = undefined // 投影语义：turn/start 重置 todos 为 null（空列表）
      break
    }
    case 'step/end': {
      const t = (event.data as { turn?: number }).turn ?? 0
      const s = (event.data as { step?: number }).step ?? 0
      if (t === turn && s >= step) step = s
      break
    }
    case 'tool/call': {
      const name = (event.data as { name?: string }).name
      if (name !== undefined && name !== '') currentAction = name
      break
    }
    case 'assistant/message': {
      // 一条 assistant 正文闭合 = 当前 step 的生成结束，清掉工具动作避免滞留。
      const content = (event.data as { message?: { content?: ReadonlyArray<{ type: string }> } }).message?.content ?? []
      if (content.some(b => b.type === 'text' || b.type === 'reasoning')) currentAction = undefined
      break
    }
    case 'turn/end': {
      done = true
      stopReason = stopReasonOfTurnEnd((event.data as { reason?: { kind?: string } }).reason?.kind)
      currentAction = undefined
      break
    }
    case 'todo/write': {
      // 与 dsh-tool-todo 投影同口径：last-write-wins，turn/start 重置。
      todos = (event.data as { todos?: SubagentTodoItem[] }).todos ?? undefined
      break
    }
    default:
      return undefined // 非进度事件（user/message、step/start 等）不产生帧。
  }
  if (turn === prev.turn && step === prev.step && currentAction === prev.currentAction
    && done === prev.done && stopReason === prev.stopReason && todos === prev.todos) {
    return undefined // 折叠无变化（如乱序/重复事件），不广播。
  }
  return {
    turn,
    step,
    ...currentAction === undefined ? {} : { currentAction },
    done,
    ...stopReason === undefined ? {} : { stopReason },
    ...todos === undefined ? {} : { todos },
  }
}

/**
 * **全量**折叠一窗事件（= 逐条 {@link foldProgressEvent} 的归纳）。
 *
 * 与增量路径共用同一个 {@link foldProgressEvent} ⇒ 两条路径**不可能漂移**（这正是本
 * 函数存在的理由，见模块头注）。
 *
 * @param events - 一段会话事件（按 seq 升序）。
 * @returns 折叠后的状态；无任何进度事件时返回 {@link initialProgressState}。
 */
export function foldProgressAll(events: readonly SessionEvent[]): ProgressState {
  let state = initialProgressState()
  for (const event of events) {
    state = foldProgressEvent(state, event) ?? state
  }
  return state
}

/**
 * 由折叠状态 + 元信息造一条推送帧（`lastActive` 取触发事件的时间）。
 *
 * 与 {@link foldProgressEvent} 同一套「按键存在性」构造纪律。
 */
export function progressFrameOf(
  sessionId: string,
  state: ProgressState,
  lastActive: number,
  changeSummary?: SubagentProgressEvent['changeSummary'],
): SubagentProgressEvent {
  return {
    sessionId,
    turn: state.turn,
    step: state.step,
    ...state.currentAction === undefined ? {} : { currentAction: state.currentAction },
    done: state.done,
    ...state.stopReason === undefined ? {} : { stopReason: state.stopReason },
    lastActive,
    ...state.todos === undefined ? {} : { todos: state.todos },
    ...changeSummary === undefined ? {} : { changeSummary },
  }
}

/** 「半途失去运行」的判定输入。 */
export interface ChildRunInterruptInput {
  /** 事件窗口折出来的 turn 是否已闭合（`turn/end`）。 */
  readonly done: boolean
  /** `turn/end.reason.kind` 推出的权威终局原因（undefined = 没有）。 */
  readonly stopReason: string | undefined
  /**
   * registry 判定（**惰性**：只有真需要时才查，与旧实现一致——done/stopReason 已给定局时
   * 不必扫一遍 agents）。
   * true = 在跑 / false = 没在跑 / undefined = 问不到（没有 agents 服务）。
   */
  readonly agentRunning: () => boolean | undefined
  /** 最后一条事件的时间（ms epoch）。 */
  readonly lastActive: number
  /** 本进程启动时刻（ms epoch）。 */
  readonly bootAt: number
}

/**
 * 判定「半途失去运行」，返回判据（undefined = 不算中断）。
 *
 * 两个判据**取或**（缺一不可覆盖全部情况）：
 *   ① registry 说它没在跑——已 dispose 的一次性子会话，或 status=idle 的常驻子会话；
 *   ② 最后一条事件发生在本进程**启动之前**——那个未闭合的 turn 不可能还在本进程里跑。
 *      app 重启会把**常驻**子会话的半途 turn 留在 log 里（只有 turn/start、没有 turn/end），
 *      而常驻子会话不会被 dispose，故 ① 对它判不出来（2026-09-12 实测）。
 *
 * 不伪造 `stopReason`：既不是正常完成，也不是用户手动终止，UI 另有「已中断」文案。
 */
export function childRunInterruptOf(input: ChildRunInterruptInput): 'not-running' | 'pre-boot' | undefined {
  if (input.done) return undefined
  if (input.stopReason !== undefined) return undefined
  if (input.agentRunning() === false) return 'not-running'
  if (input.lastActive < input.bootAt) return 'pre-boot'
  return undefined
}
