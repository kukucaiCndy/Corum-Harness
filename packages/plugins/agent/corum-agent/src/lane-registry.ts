/**
 * fork（corum）：**泳道登记与查找**——从 `agent-service.ts` 按关注点抽出（2026-09-20）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力……各个模块**至少要在
 * 文件层面切分清晰**，方便维护。」
 *
 * 本模块只回答一个问题：**一条泳道（task 会话）如何被登记、按工作区查找、挂到官方 workspace**。
 * 它不碰权限、指挥模式、profile 编译、子 Agent 装配。
 *
 * ## 统一模型的关键判据（易踩，故在此复述）
 *
 * **按工作区判，不按 type 判**（修 `bug.task-lane-reuse-misses-project-sessions`）：
 * 旧实现只遍历 `readTaskSessionIndex()`（仅 `type='task'`），于是同一工作区里**项目模式的
 * blank 会话不会被复用** ⇒ 同一工作区出现两条并行泳道（一条 task、一条 project），与
 * 「工作区即项目」的统一模型冲突。`type` 只决定**显示哪些会话**，不参与**能不能复用**。
 *
 * 工作区比较走 `canonicalWorkspaceKey`（realpath 归一）：存量实测 `"/a/b/"` 与 `"/a/b"`
 * 同指一个目录，直接比字符串会把一个工作区判成两个。
 *
 * @module @corum/corum-agent/lane-registry
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// 工作区身份（L0 助手）：项目模式剥离后由 workspace-identity.ts 承接。
import { canonicalWorkspaceKey } from './workspace-identity.ts'
import { readSessionIndex, registerSession } from './session-index.ts'

/**
 * 读取**统一索引**里的 task 泳道（sessionId → cwd/profileId）。
 *
 * 注意：这是「哪些会话显示在 task 视图」的判据，**不是**「能不能复用泳道」的判据
 * ——后者见 {@link findBlankTaskLane}。
 *
 * @returns sessionId → { cwd, profileId }。
 */
export function readTaskSessionIndex(): Record<string, { cwd: string; profileId: string }> {
  const out: Record<string, { cwd: string; profileId: string }> = {}
  for (const [sessionId, entry] of Object.entries(readSessionIndex())) {
    if (entry.type !== 'task') continue
    out[sessionId] = { cwd: entry.cwd, profileId: entry.profileId }
  }
  return out
}

/**
 * 登记一条 task 会话（sessionId → cwd/profileId）进统一索引（`type='task'`）。
 *
 * @param sessionId - 泳道会话 id。
 * @param cwd - 工作区目录。
 * @param profileId - 该泳道绑定的 Agent profile / preset id。
 */
export function registerTaskSession(sessionId: SessionId, cwd: string, profileId: string): void {
  registerSession(String(sessionId), { cwd, profileId, type: 'task' })
}

/**
 * 找一个可复用的 **blank**（未发过消息）泳道。
 *
 * 复用语义（官方 `connectWorkspace` 同款）：目标工作区里已有 blank 泳道时直接复用，
 * 不新建——用户连点「新建任务」不会堆出一串空会话。
 *
 * ⚠️ **查全库、不只查 task 索引**（见模块头注）。判据是「工作区匹配 ∧ 会话存在 ∧ 无 turn/start」。
 * 会话不在对象层时**保守不复用**（宁可新建，也不要复用一个可能有历史的会话）。
 *
 * @param ctx - 提供 `sessions` 对象层。
 * @param cwd - 目标工作区目录。
 * @param profileId - 可选：只复用绑定该 profileId 的 blank 泳道。chat 模式（`chat-assistant`）
 *   不应复用 task 模式的 blank 泳道（反之亦然），故调用方按 profileId 过滤——不同 profile
 *   的 blank 泳道互不复用。
 * @returns 可复用的 sessionId；无可复用时 `undefined`。
 */
export function findBlankTaskLane(ctx: Context, cwd: string, profileId?: string): string | undefined {
  const want = canonicalWorkspaceKey(cwd)
  if (want === undefined) return undefined
  for (const [sid, entry] of Object.entries(readSessionIndex())) {
    if (canonicalWorkspaceKey(entry.cwd) !== want) continue
    // profileId 过滤（2026-11 新增）：chat 会话与 task 会话不复用对方的 blank 泳道。
    // 不传 profileId 时不过滤（保持向后兼容——但所有调用点都应传）。
    if (profileId !== undefined && entry.profileId !== profileId) continue
    const session = ctx.sessions.list().find(s => String(s.id) === sid)
    if (session === undefined) continue
    if (!session.snapshotEvents().some(e => e.type === 'turn/start')) return sid
  }
  return undefined
}

/**
 * 把泳道会话挂到官方 workspace（侧栏按 `WorkspaceView.sessionIds` 分组，
 * 不 attach 就落「未分组」桶）。
 *
 * 官方 `session.create({workspaceId})` 会自动 attach，但泳道是自己起的 `agents.create`，
 * 必须补这一步。**attach 失败不阻断会话创建**（会话可用，只是归到未分组），但要打日志
 * ——静默失败会让「未分组」问题无法定位。
 *
 * @param ctx - 提供 `workspaceRegistry` 与 `logger`。
 * @param sessionId - 待挂载的泳道会话。
 * @param cwd - 工作区目录。
 */
export async function attachTaskWorkspace(ctx: Context, sessionId: SessionId, cwd: string): Promise<void> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    ctx.logger.warn('corum-agent(task): workspaceRegistry unavailable — lane stays ungrouped')
    return
  }
  try {
    // create 幂等：已注册的目录直接返回既有实体（不重复建节点）；未注册则新建
    // 并 prepend 到侧栏列表（用户要的「工作区先出现这个目录名的父节点」）。
    const target = await registry.create(cwd)
    await target.attachSession(sessionId)
    ctx.logger.info(`corum-agent(task): attached — ${String(sessionId)} → workspace ${String(target.id)}`)
  } catch (error) {
    // 不阻断：会话已可用，只是归到未分组。打日志避免「未分组」问题无法定位。
    ctx.logger.warn(`corum-agent(task): attach failed — ${String(error)}`)
  }
}
