/**
 * CorumProjectService — corum 项目服务（轻量版）。
 *
 * 打通「创建项目 → 拿 projectId」链路，为团队调度事件日志提供落点边界
 * （见 docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md）。每个项目是
 * `$CORUM_HOME/projects/<projectId>/` 一个独立目录，天然多项目隔离。
 *
 * 继承 TypertRemoteService，通过 @Remote 暴露 /api/corumProject/* 端点，
 * 供浏览器半（项目选择器 / AgentTestPanel）经桌面 IPC 桥调用。
 *
 * 这是轻量版——只承载 projectId 生成 + 项目元信息 CRUD。PRD §3 的完整
 * 项目实体（计划/需求/任务/BUG）后续迁入 project-core 数据层。
 * @module @corum/corum-agent-dev/project-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { CorumProject } from './project.ts'
import { isValidProjectId, slugifyProjectId } from './project.ts'
import { loadProject, listProjects, saveProject, projectDir } from './project-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum 项目服务（项目创建/列表 → projectId）。 */
    corumProject: CorumProjectService
  }
}

/** 创建项目的 RPC 入参。 */
export interface CreateProjectInput {
  /** 项目名（必填，用于派生 projectId slug）。 */
  name: string
  /** 工作目录（可选，绝对路径）。 */
  cwd?: string
  /** 描述（可选）。 */
  description?: string
}

/**
 * CorumProjectService — corum 项目服务。
 *
 * 单例（注册在 host 根 ctx），负责：创建/列出/打开项目，返回真实 projectId。
 */
export class CorumProjectService extends TypertRemoteService {
  static inject = ['agents', 'sessions']

  constructor(ctx: Context) {
    super(ctx, 'corumProject')
  }

  /**
   * 创建一个新项目，返回分配了唯一 projectId 的项目实体。
   * projectId 由 name slug 化，冲突时追加 -2/-3 后缀。
   */
  createProject(input: CreateProjectInput): CorumProject {
    const name = input.name.trim()
    if (name === '') throw new Error('dev-agent: project name must not be empty')
    const base = slugifyProjectId(name)
    let id = base
    for (let n = 2; loadProject(id) !== undefined; n += 1) id = `${base}-${n}`
    const now = Date.now()
    const project: CorumProject = {
      id,
      name,
      ...(input.cwd !== undefined && input.cwd.trim() !== '' ? { cwd: input.cwd.trim() } : {}),
      ...(input.description !== undefined && input.description.trim() !== '' ? { description: input.description.trim() } : {}),
      createdAt: now,
      lastOpenedAt: now,
      version: 0,
    }
    saveProject(project)
    this.ctx.logger.info(`corumProject: created "${id}" — ${name} (${projectDir(id)})`)
    return project
  }

  /** 记录一次「打开项目」（刷新 lastOpenedAt 排序）。 */
  touchProject(id: string): CorumProject {
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    const next = { ...project, lastOpenedAt: Date.now() }
    saveProject(next)
    return next
  }

  // ── TypertRemoteService @Remote 端点（/api/corumProject/*） ──────────

  /** 创建项目。 */
  @Remote('createProject')
  createProjectRemote(name: string, cwd?: string, description?: string): { project: CorumProject } {
    return {
      project: this.createProject({
        name,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(description !== undefined ? { description } : {}),
      }),
    }
  }

  /** 列出所有项目（最近打开在前）。 */
  @Remote('listProjects')
  listProjectsRemote(): { projects: CorumProject[] } {
    return { projects: listProjects() }
  }

  /** 打开项目（刷新 lastOpenedAt）。 */
  @Remote('openProject')
  openProjectRemote(id: string): { project: CorumProject } {
    if (!isValidProjectId(id)) throw new Error(`dev-agent: invalid project id "${id}"`)
    return { project: this.touchProject(id) }
  }
}

export default CorumProjectService
