/**
 * corum-ui-commit-card —— Git 面板（2026-11-26 重构）。
 *
 * ## 功能
 *
 * 输入框工具栏新增 git 按钮（26×26 r8 git-branch 图标）。点击后面板**向上展开**：
 *   - 当前分支 + ahead/behind + upstream 同步状态
 *   - 分支列表（可切换，Agent 空闲时才可用）
 *   - 未提交文件列表（勾选 + 提交信息 + 手动提交）
 *   - Agent 工作时全置灰（分支切换与提交都禁用）
 *
 * 切换/提交操作在**下一轮用户发消息时**注入给 Agent（只有操作才注入，看过不注入）。
 * 注入由 host 侧 `agent/pre-step` 监听器实现（corum-git-core）。
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
import { zh, en, NS } from './locales.ts'

export { createGitPanelButton } from './GitPanelButton.tsx'
export type { GitPanelData, BranchInfo, ChangeEntry } from './contract.ts'

/** Required services: Sessions, Connection, Session UI, Slot registry, Locale. */
export const inject = ['sessions', 'connection', 'uiSession', 'slots', 'locale', 'uiConversation']

/**
 * Client plugin body: register git button in `conversation.input.left` slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'corum-ui-commit-card: dictionaries')
  const sessions = ctx.sessions as ISessions
  const connection = ctx.get('connection') as ConnectionHandle
  const call = makeCorumRpcCall(connection)
  const GitPanelButton = createGitPanelButton(sessions, call)
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'git-panel',
    locale: 'conversation',
  }, GitPanelButton))
}
