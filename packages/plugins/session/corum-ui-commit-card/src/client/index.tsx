/**
 * corum-ui-commit-card —— Git 面板（2026-11-26 重构）。
 *
 * ## 形态
 *
 * 两个槽、两个组件，共享一份开关状态：
 *   · `conversation.input.left` —— 输入框工具栏的 git 按钮（只负责开/关）；
 *   · `conversation.input.dock` —— 输入框**上方的玻璃卡**面板，与「文件更改」
 *     （order -10）、「TODO LIST」（order 0）、排队条（order 20）同槽同款，
 *     由 composer 座位统一吸附、宽度对齐输入卡。
 *
 * 早先面板是按钮旁的 absolute 浮窗，窄窗/贴底时会被 composer 裁掉且与相邻卡片
 * 对不齐；改槽注册后几何全由槽位系统保证。
 *
 * ## 内容
 *
 *   - 当前分支 + ahead/behind + upstream 同步状态
 *   - 分支列表（可切换，Agent 空闲时才可用）
 *   - 未提交文件列表（勾选 + 提交信息 + 手动提交）
 *   - Agent 工作时全置灰（分支切换与提交都禁用）
 *
 * 切换/提交操作在**下一轮用户发消息时**注入给 Agent（只有操作才注入，看过不注入）。
 * 注入由 host 侧 `agent/pre-step` 监听器实现（corum-git-core）。
 *
 * ## 跨槽状态
 *
 * 开关状态放进 cordis 服务（`GitPanelOpenService`）：按钮与面板在两个槽、由不同
 * bundle 组装，而 dsh 会把 `@corum/*` 源码内联进每个消费方 bundle ⇒ 模块级变量
 * 是两份独立实例（红线 1）。服务实例的唯一性由根上下文 `reflect.store` 保证。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@corum/corum-ui-conversation/client'
import type {} from '@corum/corum-api-remotes/client'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
import { createGitPanelButton } from './GitPanelButton.tsx'
import { createGitPanelDock } from './GitPanelDock.tsx'
import { GitPanelOpenService } from './panel-open.ts'
import type { GitPanelOpenState } from './panel-open.ts'
import { zh, en, NS } from './locales.ts'

export { createGitPanelButton } from './GitPanelButton.tsx'
export { createGitPanelDock, fetchPanelData } from './GitPanelDock.tsx'
export { GitPanelOpenService } from './panel-open.ts'
export type { GitPanelOpenState } from './panel-open.ts'
export type { GitPanelData, BranchInfo, ChangeEntry } from './contract.ts'

/** Required services: Sessions, Connection, Session UI, Slot registry, Locale. */
export const inject = ['sessions', 'connection', 'uiSession', 'slots', 'locale', 'uiConversation']

/** 两个槽条目共享的注入面：面板开关状态（渲染时从服务取，不用闭包捕获）。 */
export interface GitPanelInjected {
  /** 跨槽共享的开关状态。 */
  openState: GitPanelOpenState
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Git 面板的跨槽开关状态（按钮与面板在不同槽、不同 bundle，必须走服务）。 */
    gitPanelOpen: GitPanelOpenService
  }
}

/**
 * Client plugin body: 注册开关服务 + git 按钮（input.left）+ 面板（input.dock）。
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'corum-ui-commit-card: dictionaries')
  const sessions = ctx.sessions as ISessions
  const connection = ctx.get('connection') as ConnectionHandle
  const call = makeCorumRpcCall(connection)

  // 跨槽共享的开关状态：provided 在根上下文 ⇒ 两个槽组件看到同一个实例。
  const openState = new GitPanelOpenService()
  ctx.provide('gitPanelOpen', openState)

  // 槽注册的 `inject` 是**渲染时求值的工厂**（renderer 的 `runInject` 会调
  // `inject(...args)` 并把返回对象展开成组件 props）。这里用 apply 作用域内的
  // `openState` 直接闭包捕获——那个实例就是本插件 provide 出去的那一个。
  //
  // ⚠️ 不要写成 `inject: () => ({ openState: ctx.gitPanelOpen })`：对刚
  // `ctx.provide()` 的服务在同一 apply 里立刻读，读到的是 undefined
  // （真机实测 ⇒ 渲染崩溃 `Cannot read properties of undefined (reading '#listeners')`）。
  const GitPanelButton = createGitPanelButton()
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'git-panel',
    locale: NS,
    // 槽注册的 `inject` 是**渲染时求值的工厂**：返回对象会被展开成组件 props。
    // 照 QueueDock / ReviewDock 的既定范式显式声明形参与返回类型。
    inject: (): GitPanelInjected => ({ openState }),
  }, GitPanelButton))

  // order 10：排在 todo（0）之下、queue（20）之上——git 操作是偶发动作，
  // 不该抢在「本轮待确认的文件」和「当前计划」之前。
  const GitPanelDock = createGitPanelDock(sessions, call)
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'git-panel',
    order: 10,
    locale: NS,
    inject: (): GitPanelInjected => ({ openState }),
  }, GitPanelDock))
}
