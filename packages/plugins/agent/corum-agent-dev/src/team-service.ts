/**
 * CorumTeamService — corum 全局团队服务。
 *
 * 团队是「预设 Agent 集合」（部门/模板）：用户创建团队、把全局 AgentProfile
 * 组进去。团队不直接参与调度——项目把团队（或指定 Agent）拉进项目组后，
 * 运行时才围绕项目组分配任务。
 *
 * 继承 TypertRemoteService，通过 @Remote 暴露 /api/corumTeam/* 端点。
 * @module @corum/corum-agent-dev/team-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { CorumTeam } from './team.ts'
import { isValidTeamId, slugifyTeamId } from './team.ts'
import { loadTeam, listTeams, saveTeam, deleteTeam } from './team-store.ts'
import { isValidProfileId } from './profile.ts'
import { loadProfile } from './profile-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum 全局团队服务（预设 Agent 集合管理）。 */
    corumTeam: CorumTeamService
  }
}

/**
 * CorumTeamService — corum 全局团队服务。
 * 单例（注册在 host 根 ctx），负责团队的创建/成员管理/列表/删除。
 */
export class CorumTeamService extends TypertRemoteService {
  static inject = ['agents', 'sessions']

  constructor(ctx: Context) {
    super(ctx, 'corumTeam')
  }

  /**
   * 创建一个新团队，返回分配了唯一 teamId 的团队实体。
   * teamId 由 name slug 化，冲突时追加 -2/-3 后缀。
   */
  createTeam(name: string, description?: string, memberProfileIds: string[] = []): CorumTeam {
    const clean = name.trim()
    if (clean === '') throw new Error('dev-agent: team name must not be empty')
    const base = slugifyTeamId(clean)
    let id = base
    for (let n = 2; loadTeam(id) !== undefined; n += 1) id = `${base}-${n}`
    const members = this.validateMembers(memberProfileIds)
    const team: CorumTeam = {
      id,
      name: clean,
      ...(description !== undefined && description.trim() !== '' ? { description: description.trim() } : {}),
      memberProfileIds: members,
      createdAt: Date.now(),
      version: 0,
    }
    saveTeam(team)
    this.ctx.logger.info(`corumTeam: created "${id}" — ${clean}（${members.length} 成员）`)
    return team
  }

  /** 校验成员 profile id 列表：合法且对应的 profile 存在，去重。 */
  private validateMembers(memberProfileIds: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of memberProfileIds) {
      const id = raw.trim()
      if (!isValidProfileId(id)) throw new Error(`dev-agent: invalid profile id "${raw}"`)
      if (loadProfile(id) === undefined) throw new Error(`dev-agent: profile "${id}" not found`)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }

  // ── TypertRemoteService @Remote 端点（/api/corumTeam/*） ──────────

  /** 创建团队。 */
  @Remote('createTeam')
  createTeamRemote(name: string, description?: string, memberProfileIds?: string[]): { team: CorumTeam } {
    return { team: this.createTeam(name, description, memberProfileIds ?? []) }
  }

  /** 列出所有团队。 */
  @Remote('listTeams')
  listTeamsRemote(): { teams: CorumTeam[] } {
    return { teams: listTeams() }
  }

  /** 给团队添加一个成员（profile id，去重）。 */
  @Remote('addMember')
  addMemberRemote(teamId: string, profileId: string): { team: CorumTeam } {
    const team = loadTeam(teamId)
    if (team === undefined) throw new Error(`dev-agent: team "${teamId}" not found`)
    if (team.memberProfileIds.includes(profileId)) return { team }
    const members = this.validateMembers([...team.memberProfileIds, profileId])
    saveTeam({ ...team, memberProfileIds: members })
    return { team: { ...team, memberProfileIds: members, version: team.version + 1 } }
  }

  /** 从团队移除一个成员。 */
  @Remote('removeMember')
  removeMemberRemote(teamId: string, profileId: string): { team: CorumTeam } {
    const team = loadTeam(teamId)
    if (team === undefined) throw new Error(`dev-agent: team "${teamId}" not found`)
    const members = team.memberProfileIds.filter(id => id !== profileId)
    saveTeam({ ...team, memberProfileIds: members })
    return { team: { ...team, memberProfileIds: members, version: team.version + 1 } }
  }

  /** 删除一个团队。 */
  @Remote('deleteTeam')
  deleteTeamRemote(teamId: string): { ok: boolean } {
    if (!isValidTeamId(teamId)) throw new Error(`dev-agent: invalid team id "${teamId}"`)
    deleteTeam(teamId)
    return { ok: true }
  }
}

export default CorumTeamService
