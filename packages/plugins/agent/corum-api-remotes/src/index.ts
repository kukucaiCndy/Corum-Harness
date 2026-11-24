/** Host BFF entry and Loader shell for the Remote contribution assembly. */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  TypertRemoteEventDispatch,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import { Deque } from '@deepseek-ai/dsh-deque'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

// The owner packages' client-safe `./types` exports carry the cordis `Events`
// declarations for every allowlisted event. Pulling them into this face is what
// makes the shape assertion below judge real signatures rather than an empty
// event vocabulary.
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type {} from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-goal/types'
import type {} from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
export type {} from '@deepseek-ai/dsh-api-session-controller/types'

export { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'
export type { ApiRemoteForwardedEvent } from './types.ts'

/** Required Host service: the Gateway owns the physical Remote stream mux. */
export const inject = ['typertGateway']

/** Host plugin body registering this application's selected Cordis event source. */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx), { home: homedir() }),
    'api-remotes: forwarded Cordis event source',
  )
}

/** Create the sole queue and listener set consumed by the registered Gateway. */
function remoteEventSource(ctx: Context): TypertRemoteEventSource {
  return (signal) => {
    const queue = new RemoteEventQueue()
    const disposers = API_REMOTE_FORWARDED_EVENTS.map((entry) => {
      const { event, mode } = entry
      if (mode === 'emit') {
        const resources = 'resources' in entry ? entry.resources : undefined
        return ctx.on(event as never, ((...args: unknown[]) => {
          /**
           * fork（corum）2026-11-22：**丢弃这一帧，不要抛出**。
           *
           * 这里原本直接 `assertJsonArgs(...)` —— 校验失败就把 Error 抛出监听器，
           * cordis 的 emit 会把它升级成未捕获异常，而宿主装了 `installFailLoud`
           * （boot.ts）⇒ **整个宿主进程 exit 1**。
           *
           * 实测事故（2026-11-22，用户两次「界面卡死」后重启）：宿主 host.log 里
           *   corum-desktop: fatal load failure: Error: forwarded host event
           *   "corum/subagent/progress" argument 0 is not lossless JSON data
           *   at Object.emitProgress (corum-agent) ← emitTerminalFrame
           * 之后 host.pid 换代、界面卡死近 3.5 小时。也就是说：**一条进度帧的
           * 可序列化瑕疵（一个 undefined 值或 NaN）杀死了整个宿主**，而进度帧本身
           * 只是「子 Agent 卡片上的一行状态」——丢了它必须降级，绝不能致命。
           *
           * 取舍：转发是**单向 best-effort 遥测**，不是事务。任何一帧不合格就
           * 丢弃该帧并记一条可诊断的 warn，其余事件照常转发。真正需要 fail-loud
           * 的是「host 起不来」，不是「某帧推不出去」。
           *
           * 判据（实测 `isJsonValue`）：`undefined` 值、`NaN`、`-0`、非 plain
           * 原型对象、循环引用、稀疏数组都会让它返回 false。
           */
          try {
            queue.push({ event, args: assertJsonArgs(event, args), ...resources === undefined ? {} : { resources } })
          } catch (error: unknown) {
            /**
             * 丢弃该帧并**指出是哪一层坏了**（只报路径与类型，不报值）。
             *
             * 2026-11-22 第一次事故时只有「argument 0 不合格」这一句，整帧十几层
             * 嵌套无从下手，我为此把候选字段逐个静态排除了一遍仍未命中。这条
             * `where` 就是为此补的：下次复现直接看 host.log 里的 `.changeSummary.
             * files[0].removed: undefined` 这类定位。
             */
            let where = ''
            try {
              for (const [index, arg] of args.entries()) {
                const found = describeNonJsonPath(arg)
                if (found !== undefined) {
                  where = ` | at arg[${String(index)}] → ${found}`
                  break
                }
              }
            } catch {
              // 定位本身失败绝不影响丢弃语义（它已经在 catch 里，再抛就会杀宿主）。
              where = ' | <locator threw>'
            }
            ctx.logger.warn(
              `api-remotes: dropped one "${event}" frame that is not lossless JSON `
              + `(the host stays alive; the renderer loses only this frame): ${error instanceof Error ? error.message : String(error)}${where}`,
            )
          }
        }) as never)
      }
      return ctx.on(event as never, (function (
        this: unknown,
        request: object,
        next: () => unknown,
      ) {
        const carrierAgent = carrierKeyOf(this)
        if (carrierAgent === undefined) return next()
        const agent = (request as { readonly agent?: Agent }).agent
        if (agent === undefined || agent !== carrierAgent) {
          throw new TypeError(`forwarded scoped event ${JSON.stringify(event)} must carry its Agent directly`)
        }
        // fork（corum）2026-11-14：审批转发载荷补 sessionId——修复无 UI 附着的会话
        // （task agent / 未来形态）审批 unavailable deny。
        //
        // 官方 `ApprovalRequestEvent` 不声明 `sessionId`（dsh-user-approval/types/types.d.ts:55-67），
        // 会话身份由 waterfall 的载体 `this` 给出。但 renderer 端 `corum-ui-approval` 的
        // `answerApproval` 先用 `scopeOf(owner)` 解析会话——task agent 在 host 侧完整创建
        // 但 renderer 从不 materializeScope（无 UI engage）⇒ `scopeOf` 恒 undefined ⇒
        // 回落 `sessionIdHintOf(request)` ⇒ 载荷无 sessionId ⇒ hint undefined ⇒ 返回 'unavailable'。
        //
        // 这里在转发时从载体 Agent 的 `id`（即 SessionId）补上 `sessionId`：
        // · 补 `approval/request`（官方载荷唯一缺 sessionId 的 waterfall 事件）；
        // · ★ 2026-11-18（实机事故 corum-task-f5d3b522）：同款补 `corum/model-ask/request`——
        //   它的 client 应答者同样先 `scopeOf(owner)`，task agent 载体解析不到时面板永不
        //   出现、前台委派永久挂起；补上后 client 可按载荷回落（corum-ui-model-ask）；
        // · 已有 `sessionId` 不覆盖（corum 自有事件如 `corum/escalation/ask` 自带）；
        // · 不改原始 request 对象（官方 `readonly`），而是浅拷一份再补。
        let forwardedRequest = request
        if ((event === 'approval/request' || event === 'corum/model-ask/request') && !('sessionId' in request)) {
          forwardedRequest = { ...request, sessionId: agent.id }
        }
        return forwardWaterfall(
          queue,
          event,
          forwardedRequest,
          { value: agent.ctx, subject: agent, agentId: agent.id },
          next,
        )
      }) as never)
    })
    return queue.iterate(signal, () => {
      for (const dispose of disposers) dispose()
    })
  }
}

/** One pull-driven queue bridging synchronous Cordis listeners to an AsyncIterable. */
class RemoteEventQueue {
  private readonly buffer = new Deque<TypertRemoteEventDispatch>()
  private waiter: (() => void) | undefined
  private done = false

  push(frame: TypertRemoteEventDispatch): boolean {
    if (this.done) return false
    this.buffer.pushBack(frame)
    this.waiter?.()
    return true
  }

  private end(reason: unknown): void {
    if (this.done) return
    this.done = true
    while (this.buffer.size > 0) {
      const dispatch = this.buffer.popFront() as TypertRemoteEventDispatch
      if ('context' in dispatch) dispatch.reject(reason)
    }
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<TypertRemoteEventDispatch> {
    const abort = (): void => { this.end(remoteEventSourceEndReason(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        if (this.done || signal.aborted) return
        while (this.buffer.size > 0) yield this.buffer.popFront() as TypertRemoteEventDispatch
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.end(remoteEventSourceEndReason(signal))
      cleanup()
    }
  }
}

/**
 * Normalize an event-source shutdown for pending Host waterfalls.
 * @param signal - source lifetime whose reason wins after cancellation.
 * @returns the cancellation reason or an unexpected-end failure.
 */
function remoteEventSourceEndReason(signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason
  return new Error('api-remotes: forwarded Remote event source ended')
}

/** Bridge one Cordis waterfall listener through the Gateway-owned pending event. */
function forwardWaterfall(
  queue: RemoteEventQueue,
  event: string,
  request: object,
  context: TypertRemoteEventInvocation['context'],
  next: () => unknown,
): Promise<unknown> {
  const settled = Promise.withResolvers<unknown>()
  const dispatch: TypertRemoteEventInvocation = {
    event,
    request,
    context,
    resolve: (outcome: TypertRemoteEventOutcome) => {
      if (outcome.kind === 'result') {
        settled.resolve(outcome.value)
        return
      }
      void Promise.resolve().then(next).then(settled.resolve, settled.reject)
    },
    reject: settled.reject,
  }
  if (!queue.push(dispatch)) void Promise.resolve().then(next).then(settled.resolve, settled.reject)
  return settled.promise
}

/** Reject an allowlisted event whose runtime arguments are not lossless JSON data. */
function assertJsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  for (const [index, arg] of args.entries()) {
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${String(index)} is not lossless JSON data`)
    }
  }
  return args as JsonValue[]
}

/**
 * fork（corum）2026-11-22：定位「这一帧为什么不是 lossless JSON」——**只报路径与类型，
 * 不报值本身**。
 *
 * ## 为什么需要它
 *
 * 2026-11-22 的事故里，`corum/subagent/progress` 有一帧被判为不可序列化，而
 * `assertJsonArgs` 只说「argument 0 不合格」——**整帧十几层嵌套，不知道是哪一层**。
 * 我为此把 `todos`、`turn`/`step`、`changeSummary` 各字段、`stopReason` 逐个静态
 * 排除了一遍，全部落空，最终仍定位不到真凶。缺的就是这一条诊断。
 *
 * ## 为什么只报路径与类型
 *
 * ① 出错的值本身往往不可序列化（`undefined` / `NaN` / 循环引用），把它塞进日志
 *    可能再次踩同一个坑；
 * ② 帧里可能带子 Agent 的文本内容，日志不该复制业务数据；
 * ③ 排障需要的只是「哪个键、什么类型」。
 *
 * 判据与官方 `isJsonValue`（`walkJsonValue`）同源，逐条对应它返回 undefined 的分支：
 * `undefined`、非有限数（NaN/±Infinity）、`-0`、symbol/function/bigint、循环引用、
 * 非 plain 原型对象、稀疏数组 / 带额外自有键的数组。
 *
 * @param value - 被判为不合格的那个实参。
 * @returns 首个不合格位置的路径与类型描述；全部合格时返回 undefined（理论上不会发生，
 *   调用只在该值已判定不合格时进行）。
 */
export function describeNonJsonPath(value: unknown): string | undefined {
  /** 深度上限：防御异常深的帧把日志撑爆（正常帧最深不到 10 层）。 */
  const MAX_DEPTH = 12
  const seen = new Set<object>()

  const typeOf = (v: unknown): string => {
    if (v === null) return 'null'
    const t = typeof v
    if (t === 'number') {
      const n = v as number
      if (!Number.isFinite(n)) return `number(${String(n)})`
      if (Object.is(n, -0)) return 'number(-0)'
      return 'number'
    }
    if (t === 'object') {
      if (Array.isArray(v)) return 'array'
      const proto = Object.getPrototypeOf(v as object) as object | null
      return proto === Object.prototype || proto === null
        ? 'object'
        : `object(${(proto as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'anonymous'} proto)`
    }
    return t
  }

  const walk = (v: unknown, path: string, depth: number): string | undefined => {
    if (v === undefined) return `${path}: undefined`
    if (v === null) return undefined
    const t = typeof v
    if (t === 'boolean' || t === 'string') return undefined
    if (t === 'number') {
      const n = v as number
      if (!Number.isFinite(n)) return `${path}: number(${String(n)})`
      if (Object.is(n, -0)) return `${path}: number(-0)`
      return undefined
    }
    if (t !== 'object') return `${path}: ${t}`
    if (depth > MAX_DEPTH) return `${path}: <depth>${String(MAX_DEPTH)}>`
    const obj = v as object
    if (seen.has(obj)) return `${path}: circular`
    seen.add(obj)
    if (Array.isArray(obj)) {
      const len = obj.length
      // 稀疏数组 / 带额外自有键：与 walkJsonValue 的判据一致。
      if (Reflect.ownKeys(obj).length !== len + 1) return `${path}: sparse array`
      for (let i = 0; i < len; i += 1) {
        const found = walk(obj[i], `${path}[${String(i)}]`, depth + 1)
        if (found !== undefined) return found
      }
      return undefined
    }
    const proto = Object.getPrototypeOf(obj) as object | null
    if (proto !== Object.prototype && proto !== null) return `${path}: ${typeOf(obj)}`
    for (const key of Object.keys(obj)) {
      const found = walk((obj as Record<string, unknown>)[key], `${path}.${key}`, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }

  /**
   * ⚠️ 整体兜住：本函数只在 `catch` 分支里被调用（那一帧已经判为不合格），
   * 而调用它的目的仅仅是「多记一条定位」。若定位本身抛出去，就会把
   * 「丢弃该帧」重新变回「杀死宿主」——正是本次要修的那个事故形态。
   *
   * 触发抛出的现实形态：`Proxy` 的 `ownKeys` / `getPrototypeOf` trap 抛错、
   * 对象被并发改写导致 `Reflect.ownKeys` 与后续索引访问不一致、getter 抛错。
   */
  try {
    return walk(value, 'arg', 0)
  } catch (error: unknown) {
    return `arg: <locator failed: ${error instanceof Error ? error.message : String(error)}>`
  }
}
