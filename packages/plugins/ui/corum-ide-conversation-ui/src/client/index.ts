/**
 * @corum/corum-ide-conversation-ui client half — the IDE conversation column
 * (design.pen ②, flex). Registers the full conversation surface into the
 * inherited official `conversation` slot: Convo Header + Session Stats +
 * View Tabs + Chat Flow + Review Card + Chat Input. Structure mirrors the
 * design frame's children order (nkAAA → PMP9d → U8KO6 → kEPVP → pD6NP →
 * q3HcU); data rides the sessions feed (current title / workspace), while the
 * flow/stats are design-faithful defaults until the message stream lands.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ISessions, SessionSummary, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
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
}

/** Required services: the slots registry + the runtime object layer. */
export const inject = ['slots', 'sessions']

/** 调 host 的 corumAgent Typert remote（task 泳道端点，IDE combo 注入 corum-agent-dev 后可用）。 */
async function callAgentRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `corumAgent/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/corumAgent/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`corumAgent/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { rpcId: string; result: { ok: boolean; value?: T; error?: { code: string; message: string } } }
  if (envelope.rpcId !== rpcId) throw new Error(`corumAgent/${method}: rpcId mismatch`)
  if (!envelope.result.ok) throw new Error(`${envelope.result.error?.code}: ${envelope.result.error?.message}`)
  return envelope.result.value as T
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
          callAgent: callAgentRemote,
          sessionOf: (sessionId) => ctx.sessions.binding(sessionId as Parameters<ISessions['binding']>[0])?.session,
        }),
      },
      ConversationArea,
    )),
    'ide-conversation: conversation surface',
  )
}
