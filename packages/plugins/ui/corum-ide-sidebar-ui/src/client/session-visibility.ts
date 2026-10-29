/**
 * 任务模式会话列表的**可见性判据**（纯函数，无 React / CSS 依赖）。
 *
 * 抽成独立模块的两个理由：
 *  1. 这里是「哪条会话进侧栏」的**唯一口径**，渲染与单测必须共用同一份判定——
 *     过去这条判据内联在 `SessionsPane.tsx` 里，零测试，2026-10-29 的分叉会话
 *     缺陷正是从这里漏过去的。
 *  2. `SessionsPane.tsx` 依赖 CSS Modules 与 UI primitives，vitest 无 CSS 处理
 *     时无法直接导入；纯模块可以让判据被单测直接覆盖。
 *
 * ⚠️ 任何新增的「会话可见性」分支都必须改在本文件里，不要回到组件内部另起一份。
 */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * 是否为 task 泳道会话（`corum-task-*`）。
 *
 * 2026-08-28 方案：会话管理回归官方对象层，按 id 前缀筛泳道。官方 `session-*`
 * 测试会话、项目泳道（`corum-proj*`）、dev 直聊（`corum-dev-*`）均不进 task 列表。
 */
export function isTaskSessionId(id: SessionId): boolean {
  return id.startsWith('corum-task-')
}

/**
 * 是否为「分叉自某会话」的子会话（2026-10-29 分叉会话修复）。
 *
 * 判据 = 宿主 `session.list` 给出的 `parentId`（官方 client 侧
 * `SessionSummary.parentId`，由 host 的 `SessionListEntry.parentSessionId` 投影而来）。
 *
 * **不能靠 id 前缀**：宿主 fork 出的子会话 id 固定是 `session-<uuid>`（官方
 * `session-controller/src/commands.ts` 的 fork 分支自行 mint `session-${randomUUID()}`），
 * 与源会话的 `corum-task-*` 前缀无关。
 *
 * ⚠️ `parentId` 对**子 Agent 路由会话**（`origin === 'subagent'`）同样有值，
 * 故判定分叉会话前**必须先排除 subagent**（见 {@link isTaskSession}）。
 */
export function isForkChild(row: Pick<SessionSummary, 'parentId' | 'origin'>): boolean {
  return row.parentId !== undefined && row.origin !== 'subagent'
}

/**
 * 任务模式列表行过滤（对齐官方 WorkspaceBrowser `deriveGroups` 的可见性规则）：
 * 泳道 id 前缀 **或分叉子会话**（2026-10-29 起），且 **origin !== 'subagent'**
 * ——子 Agent 路由会话（origin='subagent'，UUID 形态 id）不进分组列表：它们的标题
 * 由 subagent routing 管理（host 拒绝 rename：「owned by subagent routing」），且由
 * 对话区子 Agent 卡承载，与官方一致不在此列出。2026-08-28 用户报「未分组会话重命名
 * 不生效」即此漏滤所致。
 *
 * 分叉子会话必须单独放行：宿主 fork 出的 id 是 `session-<uuid>`，不满足
 * `corum-task-` 前缀，否则用户点「分叉会话」成功后新会话**从侧栏消失**（看起来像
 * 点了没反应）——这正是 2026-10-29 用户反馈「分叉会话不可用」的第二层原因。
 */
export function isTaskSession(row: SessionSummary): boolean {
  if (row.origin === 'subagent') return false
  return isTaskSessionId(row.id) || isForkChild(row)
}
