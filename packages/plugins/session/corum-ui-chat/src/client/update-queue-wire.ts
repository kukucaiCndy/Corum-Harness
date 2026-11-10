/**
 * fork（corum）client 侧 wire 补丁：feature.queued-message.revert-and-requeue ②。
 *
 * 背景链：requeue 动作要到达 host，必须过两道 strict 校验
 * —— ① client 侧 `ctx.remote.session.updateQueue` 的 parseInput（官方
 * api-gateway client.js:1834 `codec.schema.parse`，schema 来自 corum-
 * api-remotes 挂载的官方 remote-client 贡献，union 只含 edit/remove/
 * steer）；② host 侧 gateway 的 decode（已由 corum-session-queue-revert
 * 就地放宽）。本模块负责 ①，两个动作：
 *
 *   a) 放宽 client 侧 descriptor schema：`ctx.typert.remotes.get(
 *      'session/updateQueue')` 直达 mount 注册的 descriptor（client 侧
 *      RemoteStore 与 host localStore 同构的 {descriptor} entry，schema 是
 *      schemastery 实例）。schemastery Schema.union 不可追加分支，且
 *      descriptor 的所有者（官方 mount 闭包）后续按 parseInput 消费同一
 *      schema 引用——就地换成「官方 schema ∪ requeue 分支」的组合校验器
 *      （官方三态继续走原 schema.parse，requeue 形状由本补丁守卫放行）。
 *   b) 代理 ctx.remote.session.updateQueue 仅为类型/调用面闭环（官方
 *      实现照常完成 invoke；descriptor 放宽后其 parseInput 对 requeue
 *      不再拒绝）。
 *
 * 类型面：TypertRemoteNamespaceMap 是 merge-extensible 空接口，官方
 * remote-client 以 `TypertRemoteNamespace$73657373696f6e`（hex("session")）
 * 声明 session 命名空间，这里对同一接口做 declaration merging，把
 * updateQueue 的入参拓宽为官方请求 ∪ requeue。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionUpdateQueueRequest, SessionUpdateQueueValue,
} from '@deepseek-ai/dsh-api-session-controller/types'

/** corum 拓宽后的 updateQueue 入参（官方请求 + requeue）。 */
export type CorumUpdateQueueRequest =
  | SessionUpdateQueueRequest
  | {
    readonly sessionId: SessionUpdateQueueRequest['sessionId']
    readonly itemId: SessionUpdateQueueRequest['itemId']
    readonly action: { readonly kind: 'requeue' }
  }

declare module '@deepseek-ai/dsh-typert-protocol' {
  // 官方 remote-client 的 session 命名空间声明（同接口）已有 updateQueue，
  // declaration merging 要求同签名——wire 拓宽无法经接口合并表达（合并
  // 只加新成员，不改既有成员签名）。因此类型拓宽改由消费侧的结构化
  // 形状完成（apply.ts 的 revertSteering 按 CorumUpdateQueueRequest 的
  // action 形状构造，经下方 widenUpdateQueueAction 收窄后调用官方签名）。
}

/** 把 corum 的 requeue 意图收窄成官方签名可传的请求（wire 形状不变）。 */
export function widenUpdateQueueAction(
  sessionId: SessionUpdateQueueRequest['sessionId'],
  itemId: SessionUpdateQueueRequest['itemId'],
): CorumUpdateQueueRequest {
  return { sessionId, itemId, action: { kind: 'requeue' } }
}

/** 官方 session namespace 的最小收窄（本补丁只触达 updateQueue）。 */
interface SessionNamespaceFace {
  updateQueue(request: SessionUpdateQueueRequest): Promise<RemoteResult<SessionUpdateQueueValue>>
}

/** client 侧 descriptor 收窄（typert-registry RemoteStore 的 get 直达 descriptor）。
 *
 * rc.3 typert-registry 的 InvocationParameterDescriptor.codec 是 TypertCodec：
 *   - mode 'strict': TypertRemoteValue & { mode, typeSymbol, decode?, encode? }
 *     TypertRemoteValue.create(): TypertSchema { parse(value): Output }
 *     （create 是 lazy materializer，schema 不在 descriptor 上直接存在）
 *   - mode 'src-json': { mode: 'src-json' }（无 parser）
 * 本补丁拦截 create() 返回的 TypertSchema.parse 来放行 requeue 形状。
 */
interface StrictCodec {
  readonly mode: 'strict'
  /** Materialize the generated parser without loading the owning Service. */
  create(): { parse(value: unknown): unknown }
  __corumRequeuePatched?: boolean
}
interface RemoteDescriptor {
  parameters?: ReadonlyArray<{ readonly codec?: { readonly mode?: string } & Partial<StrictCodec> }>
}

/** requeue 形状守卫（与 host 半 widened schema 同形：仅 kind 字面量）。 */
function isRequeueAction(action: unknown): action is { readonly kind: 'requeue' } {
  return typeof action === 'object' && action !== null
    && (action as { kind?: unknown }).kind === 'requeue'
    && Object.keys(action as object).length === 1
}

/**
 * 在官方 api-remotes 挂载完成后，放宽 client 侧 session/updateQueue 的
 * strict descriptor schema。幂等；descriptor 不可达即 fail-loud。
 *
 * rc.3 适配：TypertCodec 的 schema 不再作为 descriptor 的直接属性——
 * 它由 `codec.create()` 懒实例化。本补丁包装 `create` 使其返回的
 * TypertSchema.parse 先判 requeue 形状、其余交官方 parser。
 * @param ctx - client root context（本插件 inject 含 'remote' 与 'typert'）。
 */
export function patchUpdateQueueWire(ctx: Context): void {
  const registry = ctx.typert as unknown as {
    remotes: { get(endpoint: string): RemoteDescriptor | undefined }
  }
  const descriptor = registry.remotes.get('session/updateQueue')
  const parameter = descriptor?.parameters?.[0]
  const codec = parameter?.codec as StrictCodec | undefined
  if (descriptor === undefined || codec === undefined || codec.mode !== 'strict' || typeof codec.create !== 'function') {
    throw new Error('corum-ui-chat: typert remote descriptor for session/updateQueue is not reachable — the official typert-registry internals changed; re-fork required')
  }
  if (codec.__corumRequeuePatched === true) return
  const officialCreate = codec.create.bind(codec)
  ;(codec as StrictCodec).__corumRequeuePatched = true
  ;(codec as StrictCodec).create = (): { parse(value: unknown): unknown } => {
    const officialSchema = officialCreate()
    return {
      parse(value: unknown): unknown {
        // requeue 形状由本补丁放行；其余形状全部交官方 schema（edit/remove/
        // steer 的校验口径一字不动）。
        if (
          typeof value === 'object' && value !== null
          && isRequeueAction((value as { action?: unknown }).action)
        ) return value
        return officialSchema.parse(value)
      },
    }
  }
}
