/**
 * @corum/corum-todo-guard —— turn 收口时的 todo 清单对账兜底。
 *
 * ## 它解决什么（issue #2）
 *
 * To-dos 面板在任务实际做完后仍显示「1 in_progress · 1 pending」。取证结论：
 * **面板与投影都没有 BUG**——面板计数直接来自 `todos` 投影；官方 `tool-todo` 的投影刻意
 * 「`turn/start` 清空、`turn/end` 保留刚完成的清单」；官方工具描述也已写明
 * `Mark each todo completed as soon as it is done.`。清单陈旧的唯一原因是**模型没再调
 * `todo_write`**；官方 dsh 亦没有任何 turn 收口对账机制（2026-10-12 核实）。
 *
 * 兜底因此只能落在「机制提醒模型去对账」这一轴——与提交卡片（corum-git-core 的
 * `agent/turn-stopping` + `agent.steer()`）同一手法：
 *
 *   turn 将关时读 `todos` 投影，若仍有 `in_progress` 项，就 `agent.steer()` 一条指令，
 *   让模型自己看清单、按真实进度重写（或明确说明仍未完成）。
 *
 * ## 为什么是「提醒」而不是「代劳」
 *
 * 机制**不替模型改状态**：它无从知道那项工作是否真的做完（只有模型知道）。凭猜测把
 * `in_progress` 改成 `completed` 是撒谎，把清单清空是丢信息。机制只做它确定知道的事
 * ——「清单与 turn 收口不同步」这个事实本身——把判断交回模型。
 *
 * ## 幂等（防死循环）——本插件的关键不变量
 *
 * steer 让 `inbox.nextStep` 非空 ⇒ turn 关不掉 ⇒ 模型跑完再进本钩子（官方契约：
 * "steer() from an agent/turn-stopping listener continues the same turn"）。若模型**无视**
 * 提醒、或明确表示「仍未完成」，第二次进钩子必须放过，否则就成了每轮必催、永远关不掉。
 * 故按 sessionId 记「本 turn 已提醒过」（与 corum-git-core 的 `cardedTurns` 同款）。
 * 清单一旦不再有 `in_progress`，登记即删除 ⇒ 下一个 turn 重新获得一次提醒机会。
 *
 * ## 作用域：只提醒**主会话**
 *
 * 与提交卡片同一闸门（`origin === 'subagent'` 放过）：子 Agent 的清单由其父会话/编排面
 * 负责，本机制不越界；也免得只读子 Agent 收到它无从执行的要求。
 *
 * ## steer 的可读性（刻意不改任何 UI 包）
 *
 * steer 带 producer-owned `source.kind: 'todo-reconcile'` ⇒ 会话流里渲染为一条 **context
 * 行**（机制注入上下文），用户看得见「机制为何多跑一轮」。提交卡片那条同类 context 行被
 * 隐藏，是因为卡片节点已承载同一份信息；本提醒没有卡片，隐藏它只会让这一轮变成
 * 「无解释的静默重跑」，故保留可见。
 *
 * ## 挂载
 *
 * `cordis.patch.yml` 的 insert 段挂载（host 常驻行）。本插件只读投影 + steer，不注册任何
 * 服务与工具，故**不需要**「不可卸载」标记。
 *
 * @module @corum/corum-todo-guard
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// type-only：拉入官方投影包对 `Context.sessionProjections` 的类型合并
// （与 corum-tool-subagent 同款依赖方式；不 import 则本包看不到该服务属性）。
import type {} from '@deepseek-ai/dsh-session-projection'

/** cordis 插件名。 */
export const name = 'corum-todo-guard'
/**
 * 依赖声明：只读会话投影。
 *
 * `todos` 单元由官方 `dsh-tool-todo` 注册——**不 inject 该工具包**（它不是服务）：
 * 未注册时 `stateOf` 返回 `undefined`，本插件静默不介入（fail-soft）。
 */
export const inject: string[] = ['sessionProjections']

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * todo 对账提醒的来源标记（producer-owned，确定性可识别）。
     *
     * 非 `user` 的 producer-owned kind ⇒ 会话流里渲染为 `context` 行（机制注入上下文），
     * 而不是伪装成用户发言。
     */
    'todo-reconcile': { kind: 'todo-reconcile' }
  }
}

/** 官方 `dsh-tool-todo` 注册的投影键。 */
export const TODO_PROJECTION_KEY = 'todos'

/** todo 项（官方投影单元的形状，按需收窄）。 */
export interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/**
 * 只读会话投影的能力面。
 *
 * 红线 3：本包不引官方注册表的完整类型面（`todos` 键由官方包合并进
 * `SessionProjectionStateMap`，本包编译期看不到），只收窄到用到的这一处。
 */
export interface TodoProjectionReader {
  /**
   * 读某会话的投影状态。
   * @param session - 目标会话。
   * @param key - 投影键；**未注册时返回 `undefined`**（官方语义，不抛错）。
   * @returns 投影状态，或 `undefined`。
   */
  stateOf(session: unknown, key: string): unknown
}

/**
 * 读会话当前的 todo 清单。
 * @param projections - 会话投影注册表。
 * @param session - 目标会话。
 * @returns 清单；未注册该投影或形状不是数组时返回 `null`。
 */
export function readTodos(
  projections: TodoProjectionReader,
  session: unknown,
): readonly TodoItem[] | null {
  const value = projections.stateOf(session, TODO_PROJECTION_KEY)
  if (!Array.isArray(value)) return null
  return value as readonly TodoItem[]
}

/**
 * 组装对账提醒文本。
 *
 * 模型可见文本一律英文（仓纪律：2026-09-10 用户定调）；清单正文原样引用。
 * 返回 text block 数组（`createUserMessage` 的 `content` 形态，与提交卡片的 steer 同款）。
 * @param todos - 当前清单（含未完成项）。
 * @returns steer 消息内容块。
 */
export function buildTodoReconcileMessage(todos: readonly TodoItem[]): { type: 'text'; text: string }[] {
  const lines = todos.map(item => `- [${item.status}] ${item.content}`)
  const text = [
    'This turn is ending, but the todo list still marks work as in progress.',
    '',
    'Current list:',
    ...lines,
    '',
    'If that work is already finished, call `todo_write` with the COMPLETE list and the correct',
    'statuses (each finished item as `completed`) before you end the turn.',
    'If it genuinely remains unfinished, say so explicitly in your reply and leave it as is.',
  ].join('\n')
  return [{ type: 'text', text }]
}

/** 清单里是否还有「进行中」项（本机制的触发条件）。 */
export function hasInProgress(todos: readonly TodoItem[] | null): boolean {
  return todos !== null && todos.some(item => item.status === 'in_progress')
}

/**
 * turn 将关时的对账主逻辑。
 *
 * 三条闸门（顺序即优先级）：①只提醒主会话；②清单已无 `in_progress` ⇒ 收敛并清登记；
 * ③本 turn 已提醒过 ⇒ 放过（防死循环，见模块头注）。
 *
 * @param ctx - host cordis context。
 * @param agent - turn 所属 Agent。
 * @param turn - turn 编号。
 * @param nudgedTurns - sessionId → 已提醒过的 turn（幂等登记）。
 */
export function handleTodoReconcile(
  ctx: Context,
  agent: Agent,
  turn: number,
  nudgedTurns: Map<string, number>,
): void {
  // ①作用域闸门：子 Agent 的清单归父会话/编排面，本机制不越界。
  if (agent.session.header.origin === 'subagent') return

  const sessionId = String(agent.session.id)
  const todos = readTodos(
    ctx.sessionProjections as unknown as TodoProjectionReader,
    agent.session,
  )

  // ②清单已对账（或本就没有进行中项）⇒ 收敛：删掉登记，让下一个 turn 重新获得提醒机会。
  if (!hasInProgress(todos)) {
    nudgedTurns.delete(sessionId)
    return
  }

  // ③本 turn 已提醒过 ⇒ 放过。模型可能已明确回答「仍未完成」，再催就是死循环。
  if (nudgedTurns.get(sessionId) === turn) return
  nudgedTurns.set(sessionId, turn)

  try {
    agent.steer(createUserMessage({
      content: buildTodoReconcileMessage(todos as readonly TodoItem[]),
      source: { kind: 'todo-reconcile' },
    }))
  } catch (error: unknown) {
    // steer 失败（通路异常）⇒ 不阻断 turn 收口，清单维持现状交给用户可见。
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`todo-guard: could not steer agent ${sessionId} to reconcile todos: ${detail}`)
  }
}

/**
 * 插件 apply（cordis 装配点）：注册 `agent/turn-stopping` 监听器。
 *
 * 与提交卡片同款：监听器是 async 的、由 turn loop await（serial 分发）；
 * 本机制**只入队不等待**（`steer` 即返回），不做轮询——turn 关不掉由 steer 保持
 * `inbox.nextStep` 非空来保证，模型对账后重入本钩子即收敛。
 *
 * @param ctx - host cordis context。
 */
export function apply(ctx: Context): void {
  // 幂等登记：只记最近一个 turn（turn 前进即覆盖，条目数与会话数同阶，不会长成日志）。
  const nudgedTurns = new Map<string, number>()
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      handleTodoReconcile(ctx, agent, turn, nudgedTurns)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`todo-guard: turn-stopping handler failed: ${detail}`)
    }
  })
}
