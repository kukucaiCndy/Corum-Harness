/**
 * corumProject 跨域 RPC 契约（/api/corumProject/*）。
 *
 * 给 client 半消费方 type-only 引用：方法名常量替代裸字符串，args/result 类型
 * 与服务实现（project-service.ts 的 @Remote 端点）同源。与 contract/agent.ts
 * 同为纯类型 + 字符串常量，无运行时副作用。
 *
 * 注意：openProject 的 wire 参数名是 **id**（不是 projectId）——消费方传错键名
 * 运行时才炸（2026-08 曾实踩）；契约表以服务端实现为准。
 * @module @corum/corum-agent-dev/contract
 */

import type { CorumProject, ProjectGroup, ProjectGroupMember, WorkType } from '../project.ts'
import type { CompleteSetupInput, OpenProjectByPathResult } from '../project-service.ts'

// ── 复用的 wire 投影类型（与 project.ts / project-service.ts 同源 re-export） ──

export type { CorumProject, ProjectGroup, ProjectGroupMember, WorkType }
export type { CompleteSetupInput, OpenProjectByPathResult }

/**
 * corumProject 被消费方实际调用的 @Remote 方法名常量（wire 值与装饰器字符串一致）。
 */
export const CORUM_PROJECT_METHODS = {
  /** 创建项目（自动带 PM 兜底成员进项目组）。 */
  createProject: 'createProject',
  /** 列出所有项目（最近打开在前）。 */
  listProjects: 'listProjects',
  /** 打开项目（刷新 lastOpenedAt）。参数名是 id。 */
  openProject: 'openProject',
  /** 按工作目录打开项目（existing 直读 / 空目录进创建向导）。 */
  openProjectByPath: 'openProjectByPath',
  /** 创建向导提交（空目录 → 新项目 + 拉成员进项目组）。 */
  completeSetup: 'completeSetup',
  /** 列出项目的完整工作类型表（框架兜底 + 项目自定义）。 */
  listWorkTypes: 'listWorkTypes',
  /** 给项目新增一个自定义工作类型（泳道）。 */
  addWorkType: 'addWorkType',
  /** 列出项目组成员。 */
  listGroupMembers: 'listGroupMembers',
  /** 把一个团队整体拉进项目组。 */
  addTeamToGroup: 'addTeamToGroup',
  /** 把单个 Agent 拉进项目组。 */
  addMemberToGroup: 'addMemberToGroup',
  /** 从项目组移除一个成员（PM 不可移除）。 */
  removeGroupMember: 'removeGroupMember',
} as const

/** corumProject 已契约化的方法名（CORUM_PROJECT_METHODS 的值联合）。 */
export type CorumProjectMethod = (typeof CORUM_PROJECT_METHODS)[keyof typeof CORUM_PROJECT_METHODS]

// ── 每端点的 args（命名参数对象）/ result 类型 ─────────────────────────────

/** createProject 入参：name 必填，cwd/description 可选。 */
export type CreateProjectArgs = {
  name: string
  cwd?: string
  description?: string
}
/** createProject 返回：新建项目实体（group 已含 PM 兜底成员）。 */
export interface CreateProjectResult {
  project: CorumProject
}

/** listProjects 返回：全部项目（最近打开在前）。 */
export interface ListProjectsResult {
  projects: CorumProject[]
}

/** openProject 入参。**参数名是 id**（wire 契约，见文件头注释）。 */
export type OpenProjectArgs = {
  id: string
}
/** openProject 返回：打开后的项目实体（lastOpenedAt 已刷新）。 */
export interface OpenProjectResult {
  project: CorumProject
}

/** openProjectByPath 入参：待打开的工作目录绝对路径。 */
export type OpenProjectByPathArgs = {
  cwd: string
}
/** openProjectByPath 返回：existing（已有项目）/ wizard（空目录进向导）。 */
export type OpenProjectByPathRemoteResult = OpenProjectByPathResult

/** completeSetup 入参：创建向导提交。 */
export type CompleteSetupArgs = {
  input: CompleteSetupInput
}
/** completeSetup 返回：最终项目实体（group 已落）。 */
export interface CompleteSetupResult {
  project: CorumProject
}

/** listWorkTypes 入参。 */
export type ListWorkTypesArgs = {
  id: string
}
/** listWorkTypes 返回：完整工作类型表。 */
export interface ListWorkTypesResult {
  workTypes: WorkType[]
}

/** addWorkType 入参：slug 必须合法且不冲突。 */
export type AddWorkTypeArgs = {
  id: string
  slug: string
  label: string
  description?: string
}
/** addWorkType 返回：新增后的完整工作类型表。 */
export interface AddWorkTypeResult {
  workTypes: WorkType[]
}

/** listGroupMembers 入参。 */
export type ListGroupMembersArgs = {
  id: string
}
/** listGroupMembers 返回：项目组成员表。 */
export interface ListGroupMembersResult {
  members: ProjectGroupMember[]
}

/** addTeamToGroup 入参。 */
export type AddTeamToGroupArgs = {
  id: string
  teamId: string
}
/** addTeamToGroup 返回：合并后的项目组。 */
export interface AddTeamToGroupResult {
  group: ProjectGroup
}

/** addMemberToGroup 入参：fromTeam 标记团队来源，role 缺省 member。 */
export type AddMemberToGroupArgs = {
  id: string
  profileId: string
  fromTeam?: string
  role?: 'pm' | 'member'
}
/** addMemberToGroup 返回：合并后的项目组。 */
export interface AddMemberToGroupResult {
  group: ProjectGroup
}

/** removeGroupMember 入参。 */
export type RemoveGroupMemberArgs = {
  id: string
  profileId: string
}
/** removeGroupMember 返回：移除后的项目组。 */
export interface RemoveGroupMemberResult {
  group: ProjectGroup
}

/**
 * corumProject 端点描述表：方法名 → 命名参数对象 / 返回体。
 * `{}` 表示该端点无参数。
 */
export interface CorumProjectEndpointTable {
  [CORUM_PROJECT_METHODS.createProject]: { args: CreateProjectArgs; result: CreateProjectResult }
  [CORUM_PROJECT_METHODS.listProjects]: { args: {}; result: ListProjectsResult }
  [CORUM_PROJECT_METHODS.openProject]: { args: OpenProjectArgs; result: OpenProjectResult }
  [CORUM_PROJECT_METHODS.openProjectByPath]: { args: OpenProjectByPathArgs; result: OpenProjectByPathRemoteResult }
  [CORUM_PROJECT_METHODS.completeSetup]: { args: CompleteSetupArgs; result: CompleteSetupResult }
  [CORUM_PROJECT_METHODS.listWorkTypes]: { args: ListWorkTypesArgs; result: ListWorkTypesResult }
  [CORUM_PROJECT_METHODS.addWorkType]: { args: AddWorkTypeArgs; result: AddWorkTypeResult }
  [CORUM_PROJECT_METHODS.listGroupMembers]: { args: ListGroupMembersArgs; result: ListGroupMembersResult }
  [CORUM_PROJECT_METHODS.addTeamToGroup]: { args: AddTeamToGroupArgs; result: AddTeamToGroupResult }
  [CORUM_PROJECT_METHODS.addMemberToGroup]: { args: AddMemberToGroupArgs; result: AddMemberToGroupResult }
  [CORUM_PROJECT_METHODS.removeGroupMember]: { args: RemoveGroupMemberArgs; result: RemoveGroupMemberResult }
}
