/**
 * fork（corum, 2026-11-22）：「咨询」按钮 + 「选中→询问 AI」浮条的共享 helper。
 *
 * 职责收口：
 * - {@link createChatSession}：经 corumAgent/createTaskAgent 创建 chat-assistant
 *   profile、read-only 权限的咨询会话，返回 sessionId。
 * - {@link openChatSplitPane}：经 layout.openSplitPane 在右栏打开咨询会话。
 * - {@link getExistingChatSession}：读 layout.getSplitPanePayload()，若右栏已是
 *   mode='chat' 且有 sessionId 则返回之（复用，不重复建会话）。
 * - {@link setDraftForSession}：轮询 inputHub shell 就绪后 setDraft（新建会话
 *   的 shell 需经 SessionScope 物化才有 binding，时序上不立即可用）。
 *
 * 红线遵守：
 * - 红线 1：不 window 全局；经参数传入的 inputHub 是 cordis 服务实例。
 * - 红线 3：layout 经 {@link SplitPaneChatCapableLayout} 本地能力接口收窄，
 *   不 import 壳实现包。
 * - 红线 4：不 ctx.get 未装配服务；layout 由调用方（apply.ts inject 回调）延迟取。
 *
 * @module corum-ui-conversation/client/chat-assistant
 */
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import { CORUM_AGENT_METHODS, type CreateTaskAgentResult } from '@corum/corum-agent/contract'
import type { InputHub } from './input/hub.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** chat-assistant profile id（host 内置：zero-tool、只读咨询 persona）。 */
export const CHAT_ASSISTANT_PROFILE_ID = 'chat-assistant'

/** 咨询会话的只读权限档位 id（= 官方 permissionPresets preset key）。 */
export const CHAT_ASSISTANT_PERMISSION = 'read-only'

/** setDraft 轮询 shell 就绪的最长等待（新建会话的 SessionScope 物化需时序）。 */
const SHELL_READY_TIMEOUT_MS = 3000

/** setDraft 轮询间隔。 */
const SHELL_READY_POLL_INTERVAL_MS = 80

/** 选中文本截断上限（防止超长引用撑爆草稿）。 */
const QUOTE_MAX_CHARS = 4000

/**
 * ctx.layout 的分栏能力面（corum IDE 壳 LayoutController 提供，超出官方
 * 基座窄 ILayout）。与 corum-ui-split-pane 的 SplitPaneCapableLayout 同型
 * （红线 3：不 import 实现包类型，本地声明收窄面）。
 */
export interface SplitPaneChatCapableLayout {
  openSplitPane(payload: { key: string; title: string; props?: Record<string, unknown> }): void
  getSplitPanePayload(): { key: string; title: string; props?: Record<string, unknown> } | null
}

/**
 * 取 ctx.layout 的分栏能力面（运行时探测）。不具备时返回 undefined。
 */
export function splitPaneChatLayout(layout: unknown): SplitPaneChatCapableLayout | undefined {
  if (layout === null || typeof layout !== 'object') return undefined
  if (!('openSplitPane' in layout) || typeof (layout as { openSplitPane: unknown }).openSplitPane !== 'function') return undefined
  if (!('getSplitPanePayload' in layout) || typeof (layout as { getSplitPanePayload: unknown }).getSplitPanePayload !== 'function') return undefined
  return layout as unknown as SplitPaneChatCapableLayout
}

/** `__corumNotify` 一次写只读桥（规范 §1 例外：CorumNotification 面）。 */
interface CorumNotifyBridge {
  __corumNotify?: (n: { tone: 'error'; title: string; message?: string | undefined }) => void
}

/** 用户可见失败反馈（与 corum-ui-chat 的 notifyUser 同型）。 */
function notifyUser(title: string, message?: string | undefined): void {
  const notify = (window as unknown as CorumNotifyBridge).__corumNotify
  notify?.({ tone: 'error', title, ...message === undefined ? {} : { message } })
}

/**
 * 创建咨询会话（chat-assistant profile + read-only permission）。
 *
 * @param rpc - corum RPC 调用函数（makeCorumRpcCall(connection)）。
 * @param cwd - 工作目录（从当前会话 sessions.list 快照读）。
 * @returns 新会话的 sessionId。
 * @throws RPC 失败时抛错（调用方走错误提示）。
 */
export async function createChatSession(rpc: CorumRpcCall, cwd: string): Promise<string> {
  const { sessionId } = await rpc<CreateTaskAgentResult>(
    'corumAgent', CORUM_AGENT_METHODS.createTaskAgent,
    { cwd, profileId: CHAT_ASSISTANT_PROFILE_ID, permission: CHAT_ASSISTANT_PERMISSION },
  )
  return sessionId
}

/**
 * 在右栏打开咨询会话的分栏视图。
 *
 * @param layout - 分栏能力面（splitPaneChatLayout 探测后传入）。
 * @param sessionId - 咨询会话的 sessionId。
 */
export function openChatSplitPane(layout: SplitPaneChatCapableLayout, sessionId: string): void {
  layout.openSplitPane({
    key: 'session',
    title: '咨询',
    props: { sessionId, mode: 'chat' },
  })
}

/**
 * 读当前分栏 payload，若右栏已是 mode='chat' 且有 sessionId 则返回该 sessionId。
 *
 * @param layout - 分栏能力面。
 * @returns 咨询会话 sessionId，或 undefined（右栏不是 chat 模式 / 无 sessionId）。
 */
export function getExistingChatSession(layout: SplitPaneChatCapableLayout | undefined): string | undefined {
  if (layout === undefined) return undefined
  const payload = layout.getSplitPanePayload()
  if (payload === null) return undefined
  if (payload.key !== 'session') return undefined
  const props = payload.props
  if (props === undefined) return undefined
  if (props.mode !== 'chat') return undefined
  const sid = props.sessionId
  return typeof sid === 'string' && sid !== '' ? sid : undefined
}

/**
 * 截断引用文本到 QUOTE_MAX_CHARS。
 */
export function truncateQuote(text: string): string {
  return text.length > QUOTE_MAX_CHARS ? text.slice(0, QUOTE_MAX_CHARS) : text
}

/**
 * 构造草稿文本（用户接着输入问题）。
 *
 * @param quote - 选中的会话片段文本（已截断）。
 * @returns 草稿文本。
 */
export function buildDraftFromQuote(quote: string): string {
  return `关于以下会话片段：\n"""\n${quote}\n"""\n\n`
}

/**
 * 轮询 inputHub shell 就绪后 setDraft。
 *
 * 新建会话的 shell 需经 SessionScope 物化才有 binding（shellFor 在 scope
 * materialization 时创建），RPC 返回 sessionId 后 shell 不立即可用。照 hub.ts
 * 先例：shell(id) 在 binding 缺失时抛错，故先判 sessions.binding(id) 再取 shell。
 *
 * @param inputHub - 会话输入 hub（apply.ts 闭包持有）。
 * @param sessionId - 目标会话 id。
 * @param text - 要 setDraft 的文本。
 * @param timeoutMs - 最长等待（默认 3s）。
 * @returns 是否成功 setDraft（超时则 false）。
 */
export function setDraftForSession(
  inputHub: InputHub,
  sessionId: string,
  text: string,
  timeoutMs: number = SHELL_READY_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise(resolve => {
    const start = Date.now()
    const poll = (): void => {
      const binding = inputHub.sessions().binding(sessionId as SessionId)
      if (binding !== undefined) {
        try {
          inputHub.shell(sessionId as SessionId).actions.setDraft(text)
          resolve(true)
          return
        } catch {
          // shell 创建中（竞态），继续轮询
        }
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(poll, SHELL_READY_POLL_INTERVAL_MS)
    }
    poll()
  })
}

/**
 * 咨询按钮点击 → 创建咨询会话 + 打开分栏。
 *
 * 能力不具备（无 openSplitPane）时静默返回（按钮本应隐藏，此为兜底）。
 * 失败走 __corumNotify（与 corum-ui-chat 的 notifyUser 同惯例）。
 *
 * @param rpc - corum RPC 调用函数。
 * @param cwd - 当前会话的工作目录。
 * @param layout - 分栏能力面（可能 undefined）。
 */
export async function openChatForSession(
  rpc: CorumRpcCall,
  cwd: string,
  layout: SplitPaneChatCapableLayout | undefined,
): Promise<void> {
  if (layout === undefined) return
  try {
    const sessionId = await createChatSession(rpc, cwd)
    openChatSplitPane(layout, sessionId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    notifyUser('咨询会话创建失败', message)
  }
}

/**
 * 浮条点击 → 引用选中片段到咨询会话的草稿。
 *
 * 流程：
 * 1. 若右栏已是 mode='chat' 且有 sessionId → 直接 setDraft 到该会话。
 * 2. 否则创建 chat 会话 + openSplitPane 后 setDraft（轮询 shell 就绪）。
 * 3. setDraft 失败（超时）→ notifyUser 提示。
 *
 * @param rpc - corum RPC 调用函数。
 * @param cwd - 当前会话的工作目录（新建时用）。
 * @param layout - 分栏能力面（可能 undefined）。
 * @param inputHub - 会话输入 hub。
 * @param quote - 选中的会话片段文本（未截断）。
 */
export async function askAiAboutSelection(
  rpc: CorumRpcCall,
  cwd: string,
  layout: SplitPaneChatCapableLayout | undefined,
  inputHub: InputHub,
  quote: string,
): Promise<void> {
  const truncated = truncateQuote(quote)
  const draftText = buildDraftFromQuote(truncated)

  // ① 复用已有 chat 会话
  const existingSessionId = getExistingChatSession(layout)
  if (existingSessionId !== undefined) {
    const ok = await setDraftForSession(inputHub, existingSessionId, draftText)
    if (!ok) notifyUser('咨询草稿设置失败', '会话输入未就绪，请稍后重试')
    return
  }

  // ② 新建 chat 会话 + 打开分栏
  if (layout === undefined) {
    notifyUser('咨询功能不可用', '当前布局不支持分栏视图')
    return
  }
  try {
    const sessionId = await createChatSession(rpc, cwd)
    openChatSplitPane(layout, sessionId)
    const ok = await setDraftForSession(inputHub, sessionId, draftText)
    if (!ok) notifyUser('咨询草稿设置失败', '会话输入未就绪，请稍后重试')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    notifyUser('咨询会话创建失败', message)
  }
}
