/**
 * fork（corum）：Session Controller 的**增量补丁**插件（fork 官方
 * `@deepseek-ai/dsh-api-session-controller` 0.1.3-alpha.1 的运行时面，
 * 不替换其实现）。
 *
 * 唯一增量：QueueAction 新增 `{ kind: 'requeue' }` —— 把 next-step 里
 * **尚未被 step 认领**的插话消息原子移回 next-turn 队首（「插话撤回 →
 * 退回排队」，需求 feature.queued-message.revert-and-requeue ②）。
 * 官方 `inbox.remove` 是纯丢弃（durable splice 带 `outcome: 'canceled'`
 * + discarded 通知），退回队列必须保留消息本体：
 *
 *   ① splice next-step 删 1 插 0；
 *   ② prepend next-turn 插回同一条冻结消息（inserted 通知让控制面广播新
 *      队列帧，QueueDock 即刻可见）。
 *
 * 事件层事实（2026-09-14 监督侧核验，勿再写反）：公开 `inbox.splice()`
 * 写死 `mutate(..., discardRemoved=true)`（dsh-agent/lib/types/inbox.js:116-118），
 * 故 ① 必然带 `outcome: 'canceled'` 且必然发 `notifications.discarded`，
 * 进而广播 `agent/inbox/discarded` —— **撤回在事件层与丢弃同形**，既有
 * 消费者会按「被丢弃」解读这条消息：本仓 corum-subagent
 * src/continuation.ts:1367-1369（唤醒激活）、官方 dsh-goal-round-driver
 * lib/index.js:252-255（同形目标轮 attempt 标 cancelled）、
 * dsh-agent consumed-work.js:64-69（droppedUnrun 置位）。消息本体仍在
 * next-turn 会被正常消费，上述按 id/内容匹配的外围账本仅在该消息确属
 * 其跟踪对象时受牵连——这是本设计的**已知依赖**，不是无声丢弃。
 *
 * 形态决策（2026-09-14，监督侧裁决）：**不换服务**。官方 session-controller
 * 行的 client.js 是 client 侧 `sessions` 服务的唯一 provider —— 整服务
 * 替换（禁官方行 + fork 行）要求复刻该 client 半（closure-factory 工件，
 * 构建期 import 不到 apply；vendor 其 4000 行 client 源码又引入 tsdown
 * 0.15 对 INLINE_SAFE 库的外部化漂移，module table 只有 8 个平台种子，
 * 无解），成本与脆弱性都不可接受。本插件因此在官方服务激活后**就地覆
 * 写**其内部 commands.updateQueue（红线 3：本地能力接口收窄；官方私有
 * 字段不可达时构造期 fail-loud），其余 17 个 Remote 方法与非 requeue
 * 分支全部走官方/vendored 实现（vendor/updateQueue-official.ts 逐字照抄
 * 官方 commands.ts:402-450，升级官方基线时重拷并 diff）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {
  SessionUpdateQueueRequest, SessionUpdateQueueValue,
} from '@deepseek-ai/dsh-api-session-controller'
import { freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  updateQueueOfficial,
  type OfficialUpdateQueueReceiver,
} from './vendor/updateQueue-official.ts'
import {
  apiSessionSubagentOwnershipErrorLocal,
  hasApiSessionSubagentOwnerLocal,
} from './vendor/agent-guards.ts'

/** 官方 commands 实例的运行时容器（构造参数属性：ctx / agents / defaultCwd）。 */
type CommandsHolder = OfficialUpdateQueueReceiver & {
  defaultCwd: string
}

/** 官方 SessionController 私有面的最小收窄（红线 3 能力接口）。 */
interface SessionControllerInternalsFace {
  commands: CommandsHolder & {
    updateQueue(request: SessionUpdateQueueRequest): SessionUpdateQueueValue
  }
}

/**
 * 读取一个 TS-private（运行时普通属性）字段；不可达时 fail-loud。官方
 * 编译产物里构造参数属性是普通可枚举属性，故运行时可读。
 */
function readField<T>(owner: object, name: string, label: string): T {
  const value = (owner as Record<string, unknown>)[name]
  if (value === undefined || value === null) {
    throw new Error(
      `corum-session-queue-revert: official ${label} field "${name}" is not reachable — `
      + 'the official dsh-api-session-controller internals changed; re-fork required',
    )
  }
  return value as T
}

/**
 * fork（corum）requeue 分支 + 其余动作转官方 vendored 实现。挂在官方
 * commands 实例上（原位替换其 updateQueue 方法），官方
 * SessionController.updateQueue 的 `this.commands.updateQueue(request)`
 * 委托原样到达。
 */
function patchedUpdateQueue(
  holder: CommandsHolder,
  request: SessionUpdateQueueRequest,
): SessionUpdateQueueValue {
  // wire 类型 QueueAction 由 client 侧类型扩展（corum-ui-conversation
  // contract/queue.ts）扩出 'requeue'；host 收到的 action 对象按运行时
  // kind 分流，官方类型联合里没有该分支，故按 widened 形状判定。
  const action = request.action as { readonly kind: string }
  if (action.kind !== 'requeue') {
    return updateQueueOfficial(holder, request)
  }

  // fork（corum）requeue：守卫与官方 updateQueue 对齐（subagent 所有权与
  // 存活检查；edit 的内容校验不适用 requeue）。官方读 `this.ctx.agents`
  // （cordis 服务），不是构造参数里的 ApiSessionAgentController。
  const agent = holder.ctx.agents.get(request.sessionId)
  if (agent !== undefined && hasApiSessionSubagentOwnerLocal(holder.ctx, agent.session, agent as never)) {
    throw apiSessionSubagentOwnershipErrorLocal(request.sessionId)
  }
  if (agent === undefined) {
    throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
  }
  // 与官方 remove 的 retirePrompt 不同：requeue 不移除消息，prompt 上传
  // 绑定必须保留（消息还会被消费）。

  // 仅 next-step 可撤回：next-turn 本来就在队列里；已认领（两份 pending
  // 列表都找不到）与「队列项已不在」同码，不假装可撤。
  const inbox = agent.inbox as unknown as {
    nextTurn: readonly UserMessage[]
    nextStep: readonly UserMessage[]
    splice(
      target: 'next-turn' | 'next-step',
      start: number,
      deleteCount: number,
      inserted: readonly UserMessage[],
    ): readonly UserMessage[]
    prepend(target: 'next-turn' | 'next-step', message: UserMessage): void
  }
  const index = inbox.nextStep.findIndex(message => message.id === request.itemId)
  if (index < 0) {
    throw new RemoteError(
      'session/queue-item-not-found',
      'steered message is no longer recallable (already claimed into context)',
      { itemId: request.itemId },
    )
  }
  const message = inbox.nextStep[index]
  // 原子性：两条 splice 都是同步 durable append（官方 session.append 同
  // 步提交）；中间没有 await，不存在交错窗口。注意：公开 splice() 写死
  // discardRemoved=true，第一条必然带 outcome:'canceled' + discarded 通知
  // （事件层与丢弃同形，见文件头注的已知依赖说明）。
  inbox.splice('next-step', index, 1, [])
  inbox.prepend('next-turn', freezeMessage<UserMessage>({ ...message }))
  return { accepted: true }
}

/**
 * 就地覆写官方 SessionController 的 commands.updateQueue + 放宽 wire
 * schema。不注册任何服务（cordis object-plugin：apply-only），不影响
 * fiber 拓扑；行排序保证官方 session-controller 先激活（insert 段在其
 * bundle 之后）。inject 声明既满足红线 4（不经 ctx.get 取未装配服务），
 * 也让激活序显式化。
 */
export const inject = ['sessionController', 'typert']

/**
 * wire 面扩展：gateway 的 strict codec（dsh-api-gateway index.js:827-841
 * `codec.schema.parse`）按 typert-registry localStore 里的 descriptor
 * schema 校验请求——官方生成的 union 只有 edit/remove/steer，requeue 会在
 * boundary 被 gateway/input-invalid 拒掉（探针实证：patched 方法零调用）。
 * 官方 DescriptorStore 没有替换 API（register 拒绝重复 endpoint），本插件
 * 因此就地改写 descriptor 的 schema：action union 追加 requeue 分支
 * （zod v4 `.or()`），其余字段不动。官方改版若 descriptor 结构变化，取
 * 不到 entry/descriptor 即 fail-loud。
 */
function widenUpdateQueueWireSchema(ctx: Context): void {
  interface DescriptorEntry {
    descriptor: {
      parameters?: Array<{
        codec?: {
          mode?: string
          /** rc3（0.2.1-rc.3）：codec.schema 字段被改为 codec.create（一个延迟返回 zod schema 的函数）。 */
          schema?: z.ZodType
          create?: () => z.ZodType
        }
      }>
    }
  }
  const typert = ctx.typert as unknown as {
    localStore?: { entries?: Map<string, DescriptorEntry> }
  }
  const entry = typert.localStore?.entries?.get('session/updateQueue')
  const parameter = entry?.descriptor.parameters?.[0]
  // rc3 codec 结构变化：旧版 0.1.5 的 `codec.schema`（zod 类型直挂）在 0.2.1-rc.3
  // 被改为 `codec.create`（一个 `() => z.object(…)` 延迟函数，内部 memoized）。
  // 两个形态都认：优先 `create()`（rc3），退回 `schema`（旧版），取不到即 fail-loud。
  const schema = parameter?.codec?.create?.() ?? parameter?.codec?.schema
  if (entry === undefined || schema === undefined) {
    throw new Error('corum-session-queue-revert: typert descriptor for session/updateQueue is not reachable — the official typert-registry internals changed; re-fork required')
  }
  // schema 形状 = z.object({ sessionId, itemId, action: <union> }).readonly()
  // —— requeue 分支必须并进 **action union**（zod union 按整形状判臂，
  // 在 request 顶层 or 一个 {kind} 对象永远不匹配）。zod v4 的 object
  // def.shape 可重写（readonly 只是外层包装，def 共享）。
  interface ObjectDef { shape?: Record<string, z.ZodType> }
  const def = (schema as unknown as { _zod?: { def?: ObjectDef }; def?: ObjectDef })
  const shape = def._zod?.def?.shape ?? def.def?.shape
  const actionSchema = shape?.['action'] as (z.ZodType & { or(other: z.ZodType): z.ZodType }) | undefined
  if (shape === undefined || actionSchema === undefined || typeof actionSchema.or !== 'function') {
    throw new Error('corum-session-queue-revert: updateQueue wire schema shape is not reachable (action union missing) — the official generated schema changed; re-fork required')
  }
  shape['action'] = actionSchema.or(z.object({ kind: z.literal('requeue').readonly() }).readonly())
}

export function apply(ctx: Context): void {
  const controller = ctx.sessionController as unknown as SessionControllerInternalsFace | undefined
  if (controller === undefined) {
    throw new Error('corum-session-queue-revert: sessionController service unavailable — the official session-controller row must stay enabled')
  }
  const commands = readField<SessionControllerInternalsFace['commands']>(controller, 'commands', 'SessionController')
  // 幂等：重入（HMR/行重挂）不叠包。
  if ((commands.updateQueue as { __corumRequeuePatched?: boolean }).__corumRequeuePatched === true) return
  const holder = commands as unknown as CommandsHolder
  const patched = (request: SessionUpdateQueueRequest): SessionUpdateQueueValue => patchedUpdateQueue(holder, request)
  ;(patched as { __corumRequeuePatched?: boolean }).__corumRequeuePatched = true
  commands.updateQueue = patched
  widenUpdateQueueWireSchema(ctx)
}

/**
 * cordis object-plugin：inject 必须挂在**插件对象自身**上（cordis 读
 * plugin.inject，命名导出不生效——api-remotes 等函数插件是
 * `export const inject` + 同文件 apply 函数引用同一名字，对象插件则把
 * 两个键都放在对象面）。
 */
export default { apply, inject }
