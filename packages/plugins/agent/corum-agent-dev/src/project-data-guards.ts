/**
 * project-data-guards —— CorumProjectDataService 的状态机与权限辅助纯函数
 * （从 project-data-service.ts 拆出，包内文件拆分）。
 *
 * 纯数据层（不碰 cordis / storage-domain / 服务实例）：
 *   - TASK_FLOW / BUG_FLOW：任务与 BUG 的状态机边（PRD §3.3）；
 *   - inferProfession / requireMember：项目组成员角色推导与成员门槛；
 *   - transition / parseEntity：状态历史追加与 zod 载荷校验（中文可读错误）。
 * @module @corum/corum-agent-dev/project-data-guards
 */

import type { z } from 'zod'
import type { CorumProject, ProjectGroupMember } from './project.ts'
import type { BugStatus, ProjectRole, TaskStatus } from './project-entities.ts'

/** 数据层写动作（权限矩阵的最小维度）。 */
export type WriteAction =
  | 'create'
  | 'update'
  | 'assign'
  | 'status'

/** 任务状态机边（PRD §3.3；completed→doing 是 PM 驳回返工）。 */
export const TASK_FLOW: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['doing'],
  doing: ['todo', 'dev_done'],
  dev_done: ['doing', 'completed'],
  completed: ['doing'],
}

/** BUG 状态机边（PRD §3.3；转交走 transferBug 单独留痕，不改状态）。 */
export const BUG_FLOW: Readonly<Record<BugStatus, readonly BugStatus[]>> = {
  open: ['processing'],
  processing: ['fixed', 'rejected'],
  fixed: ['pending_verify'],
  rejected: ['reopened', 'closed'],
  pending_verify: ['closed', 'reopened'],
  reopened: ['processing'],
  closed: [],
}

/** 成员专业角色推导（数据层权限用；显式 profession 优先）。 */
export function inferProfession(member: ProjectGroupMember): ProjectRole {
  if (member.role === 'pm') return 'pm'
  if (member.profession !== undefined) return member.profession
  const id = member.profileId.toLowerCase()
  if (id.includes('qa') || id.includes('test')) return 'qa'
  if (id.includes('pd') || id.includes('product')) return 'pd'
  if (id.includes('tl') || id.includes('tech') || id.includes('lead')) return 'techLead'
  return 'dev'
}

/** 取 profileId 在项目组的成员（非成员不可读写项目数据）。 */
export function requireMember(project: CorumProject, profileId: string): ProjectGroupMember {
  const member = (project.group?.members ?? []).find(m => m.profileId === profileId)
  if (member === undefined) {
    throw new Error(`project-data: profile "${profileId}" 不是项目 "${project.id}" 的项目组成员`)
  }
  return member
}

/** 状态历史追加（显式 undefined 不进 JSON）。 */
export function transition(status: string, by: string): { status: string; at: number; by: string } {
  return { status, at: Date.now(), by }
}

/** zod 解析失败转中文可读错误（写路径 100% 拒绝非法载荷）。 */
export function parseEntity<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new Error(`project-data: ${label} 校验失败：${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；')}`)
  }
  return result.data
}
