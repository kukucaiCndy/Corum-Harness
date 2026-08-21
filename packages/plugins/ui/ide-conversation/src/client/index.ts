/**
 * @corum/ide-conversation client half — the IDE conversation column
 * (design.pen ②, flex). Registers the full conversation surface into the
 * inherited official `conversation` slot: Convo Header + Session Stats +
 * View Tabs + Chat Flow + Review Card + Chat Input. Structure mirrors the
 * design frame's children order (nkAAA → PMP9d → U8KO6 → kEPVP → pD6NP →
 * q3HcU); data rides the sessions feed (current title / workspace), while the
 * flow/stats are design-faithful defaults until the message stream lands.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ISessions, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@corum/ide-shell/client'
// Type-only: pulls the official conversation SlotMap merge that declares the
// `conversation.input.model` seat (owner `{locked}` + session scope) so this
// package's children declaration type-checks against the shared vocabulary.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationArea } from './ConversationArea.tsx'

/** Injected actions + the live feed (see the component's prop type). */
export interface ConversationInjected {
  /** The sessions standard feed (list + selection), for the current title. */
  list: ISessions['list']
  /** Open another session (header crumb acts as a workspace switcher). */
  open: (sessionId: string) => void
}

/** Required services: the slots registry + the runtime object layer. */
export const inject = ['slots', 'sessions']

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
        }),
      },
      ConversationArea,
    )),
    'ide-conversation: conversation surface',
  )
}
