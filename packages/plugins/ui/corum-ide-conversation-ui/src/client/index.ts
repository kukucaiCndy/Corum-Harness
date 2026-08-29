/**
 * @corum/corum-ide-conversation-ui client half — the IDE conversation column
 * (design.pen ②, flex). Registers the full conversation surface into the
 * inherited official `conversation` slot: Convo Header + Session Stats +
 * View Tabs + Chat Flow + Review Card + Chat Input. Structure mirrors the
 * design frame's children order (nkAAA → PMP9d → U8KO6 → kEPVP → pD6NP →
 * q3HcU); data rides the sessions feed (current title / workspace), while the
 * flow/stats are design-faithful defaults until the message stream lands.
 */
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import { type ISessions, type SessionSummary, type SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the `ctx.slots` Context merge (SlotRegistry, 0.1.2 起由 ui-renderer 声明)。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@corum/corum-ide-ui/client'
// Type-only: pulls the official conversation SlotMap merge that declares the
// `conversation.input.model` seat (owner `{locked}` + session scope) so this
// package's children declaration type-checks against the shared vocabulary.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationArea } from './ConversationArea.tsx'

/** Injected actions + the live feed (see the component's prop type). */
export interface ConversationInjected {
  /** The sessions standard feed (list + selection), for the current session's cwd. */
  list: ISessions['list']
  /** Open another session (header crumb acts as a workspace switcher). */
  open: (sessionId: string) => void
  /**
   * 调 host corumAgent RPC（task 泳道）：createTaskAgent / getTaskSessionEvents。
   * 经桌面 IPC 桥 window.corumDesktop.unary。
   */
  callAgent: <T>(method: string, args: Record<string, unknown>) => Promise<T>
  /**
   * 取当前会话的官方 SessionFace（泳道已在官方对象层，binding 可用）——发送走
   * 官方 session.prompt（决策 A2：官方提交管线）。
   */
  sessionOf: (sessionId: string) => SessionFace | undefined
  /**
   * 官方 pending interaction 快照（ctx.uiSession.pendingInteractions，SessionId keyed）——
   * 审批 awaiting 卡数据源。泳道在官方对象层，官方 ui-approval answerer 把泳道工具审批
   * publish 进此快照；自研审批卡读它渲染 + PendingApproval.answer() 应答（升级 0.1.2 目的）。
   */
  pendingInteractions: PendingInteractionsFace
}

/**
 * 官方 pending interaction 快照的结构化本地类型（dsh-client-ui-session 的
 * ctx.uiSession.pendingInteractions；按官方 HostObservable getSnapshot/subscribe 形态）。
 * approval 形态对齐官方 PendingApproval（kind/toolName/callId/reason/answer）。
 */
export interface PendingInteractionsFace {
  getSnapshot: () => ReadonlyMap<string, SessionPendingInteractionLike>
  subscribe: (listener: () => void) => () => void
}

/** 官方 SessionPendingInteraction 的最小结构（base + approval 域字段）。 */
export interface SessionPendingInteractionLike {
  readonly key: string
  readonly kind: string
  readonly sessionId: string
  readonly toolName?: string
  readonly callId?: string
  readonly reason?: string
  answer?: (outcome: 'allowed-once' | 'rejected') => Promise<void>
}

/** Required services: the slots registry + the runtime object layer + connection + pending interaction. */
export const inject = ['slots', 'sessions', 'connection', 'uiSession']

/**
 * 调 host 的 corumAgent Typert remote（task 泳道端点，IDE combo 注入 corum-agent-dev 后可用）。
 * 0.1.2 起走官方 connection.rpc（loopback HTTP 到 /api，Typert gateway 认领 corumAgent/*），
 * 不再用手搓 client-request 信封 + corumDesktop.unary IPC 桥（该桥已随架构换轨退役）。
 */
function makeCallAgentRemote(connection: ConnectionHandle) {
  return async function callAgent<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const result = await connection.rpc.call('/api', `corumAgent/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

/**
 * Client plugin body: register the conversation surface into conversation.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('conversation', () => ctx.slots.register(
      {
        name: 'conversation',
        // 模型选择器座位：corum-ui-model-selection 注入的 ModelSelect 占用
        // conversation.input.model。IDE 壳自绘对话区，官方 ui-conversation 已
        // 禁用，故由本插件声明该子槽（会话作用域，inject 收 sessionId）。
        children: {
          'conversation.input.model': { kind: 'single', scope: 'session' },
        },
        inject: (): ConversationInjected => ({
          list: ctx.sessions.list,
          open: (sessionId) => { ctx.sessions.open(sessionId as Parameters<ISessions['open']>[0]) },
          callAgent: makeCallAgentRemote(ctx.get('connection') as ConnectionHandle),
          sessionOf: (sessionId) => ctx.sessions.binding(sessionId as Parameters<ISessions['binding']>[0])?.session,
          // ctx.uiSession 由 dsh-client-ui-session 提供（其 Context 声明合并在该包，TS 经
          // 结构化类型对接）；按官方 HostObservable 形态 cast（getSnapshot/subscribe）。
          pendingInteractions: (ctx as unknown as { uiSession: { pendingInteractions: PendingInteractionsFace } }).uiSession.pendingInteractions,
        }),
      },
      ConversationArea,
    )),
    'ide-conversation: conversation surface',
  )
}
