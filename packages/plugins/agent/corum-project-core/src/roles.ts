/**
 * 角色定义：corum 项目管理平台的三种内置角色。
 *
 * 每个角色 = 一个 root Agent，能力（persona + 工具集）在 `setup` 里通过
 * `agentCtx` 注入：
 *   - persona      → `ctx.systemPrompt.section()`（agent-scoped prompt section）
 *   - 工具集        → 角色专属工具（在 setup 里 `ctx.tools.register()` 或复用全局工具）
 *
 * 角色能力在创建时钉死（呼应官方"preset 产内容后不可换"）。
 * @module @corum/corum-project-core/roles
 */

import type { Context } from '@deepseek-ai/cordis'

/** 角色 id（封闭枚举）。 */
export type RoleId = 'dev' | 'test' | 'pm'

/** 角色定义：persona 文案 + 说明。 */
export interface RoleDefinition {
  readonly id: RoleId
  /** 角色名称（中文，用于展示）。 */
  readonly label: string
  /** 注入到该角色 Agent system prompt 的 persona 文案。 */
  readonly persona: string
  /** 该角色默认可见的全局工具（留空 = 继承全部；后续按需收权）。 */
  readonly toolAllowlist: readonly string[]
}

/** 三个内置角色的定义表。 */
export const ROLE_DEFINITIONS: Readonly<Record<RoleId, RoleDefinition>> = {
  dev: {
    id: 'dev',
    label: '研发',
    persona: [
      '你是项目中的研发（Developer）角色。',
      '你的职责：实现需求、修复缺陷、产出可运行代码，并对改动自测。',
      '完成任务前，必须逐项核对验收标准；确认达标后调用 complete_task 上报完成。',
      '遇到缺失前置信息时立即停止并挂起，不要臆造或补全条件。',
    ].join('\n'),
    toolAllowlist: [],
  },
  test: {
    id: 'test',
    label: '测试',
    persona: [
      '你是项目中的测试（QA）角色。',
      '你的职责：验收研发产出、复现并上报 BUG、跟踪修复直至关闭。',
      '完成任务前，必须逐项核对验收标准；确认达标后调用 complete_task 上报完成。',
      '遇到缺失前置信息时立即停止并挂起，不要臆造或补全条件。',
    ].join('\n'),
    toolAllowlist: [],
  },
  pm: {
    id: 'pm',
    label: '项目经理',
    persona: [
      '你是项目中的项目经理（PM）角色，也是用户（人）与项目之间的交互入口。',
      '你的职责：汇总信息、跟踪进度、上报风险、审核项目级沉淀，并将需决策事项上报给用户审批。',
      '完成任务前，必须逐项核对验收标准；确认达标后调用 complete_task 上报完成。',
      '遇到缺失前置信息时立即停止并挂起，不要臆造或补全条件。',
    ].join('\n'),
    toolAllowlist: [],
  },
}

/** 该角色 Agent 的 persona section 名（order 0，遮蔽部署默认 persona）。 */
const PERSONA_SECTION_NAME = 'corum:role-persona'

/**
 * 在 `setup(agentCtx)` 里注入一个角色的 persona。
 * @param agentCtx - unpublished Agent scope（由 `ctx.agents.create({ setup })` 提供）。
 * @param role - 角色定义。
 * @returns disposer（随 agentCtx 生命周期回收）。
 */
export function installRolePersona(agentCtx: Context, role: RoleDefinition): () => void {
  return agentCtx.systemPrompt.section({
    name: PERSONA_SECTION_NAME,
    order: 0,
    text: role.persona,
  })
}

/**
 * 在 `setup(agentCtx)` 里应用一个角色的工具收权。
 *
 * 当前 toolAllowlist 为空 = 继承全部全局工具。未来按角色收权时，
 * 这里改为 `agentCtx.tools.restrict(...)` 的 allow/deny mask。
 * @param agentCtx - unpublished Agent scope。
 * @param role - 角色定义。
 */
export function installRoleToolFilter(agentCtx: Context, role: RoleDefinition): void {
  if (role.toolAllowlist.length === 0) return
  // 预留：allowlist 非空时，用 allow mask 收窄可见工具。
  agentCtx.tools.restrict({
    allow: [...role.toolAllowlist],
  })
}
