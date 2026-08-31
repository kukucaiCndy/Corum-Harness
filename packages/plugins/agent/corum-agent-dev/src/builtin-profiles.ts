/**
 * 内置 profile 工厂 —— corum 框架预置的 system profile（幂等确保存在）。
 *
 * 三个内置 profile：
 *   - smoke-test：服务自检/冒烟测试用（最小 prompt + 模型）；
 *   - pm：项目组 PM 统筹 Agent（所有项目默认带入的人机交互入口，prompt 随
 *     版本演进幂等刷新、保留用户的模型/能力配置）；
 *   - task：task 模式单任务开发 Agent（无项目团队语义，独立完成任务）。
 *
 * 从 agent-service.ts 拆出（包内文件拆分，零 RPC 面变化）——profile 的
 * 创建/落盘经 profile-store，本模块只持有各 profile 的事实源 prompt 与
 * 幂等确保逻辑。
 * @module @corum/corum-agent-dev/builtin-profiles
 */

import type { AgentProfile } from './profile.ts'
import { loadProfile, saveProfile } from './profile-store.ts'

/** 冒烟测试固定提示词。 */
export const SMOKE_PROMPT = 'Reply with exactly the single word "ok".'

/** 内置 smoke-test profile id。 */
const SMOKE_PROFILE_ID = 'smoke-test'

/** 框架预置的 PM profile id（所有项目默认带入的项目组 PM 助理）。 */
export const PM_PROFILE_ID = 'pm'

/** PM 兜底 profile 的 prompt（system profile 幂等刷新的事实源）。 */
const PM_PROMPT = [
  '你是项目组的 PM（项目经理 / 统筹 Agent），是「项目」与「用户」之间的交互入口，协助用户统筹管理项目。',
  '你的职责：',
  '1. 汇总信息：用 list_team_tasks 感知团队各成员的任务队列、当前任务与忙闲（含执行时长/最后活动/疑似卡住标注），向用户报告项目进展。',
  '2. 分配任务：理解用户指令后，用 assign_task 把任务精确派给合适的团队成员，并指定正确的工作类型泳道（general/ui/debug 或项目自定义泳道）。',
  '3. 回收结果：成员完成任务后（complete_task 闭环），汇总执行结果，清晰回报给用户。',
  '4. 卡住干预（你专属的协调工具）：发现成员疑似卡住（list_team_tasks 有 ⚠ 标注）或用户说某成员卡住时，按轻到重处置——steer_task 插入引导收敛（不打断）→ cancel_task 中止重派 → reassign_task 改派他人。处置后向用户说明。',
  '5. 决策与上报：基于项目状态，等待用户决策，或在职责范围内自主决策下一步要派给团队的任务；识别风险并上报用户。',
  '工作方式：先感知（list_team_tasks）再决策，派活要精确到成员和泳道；与用户对话简洁专业。',
].join('\n')

/**
 * 确保框架预置的 PM profile 存在（幂等）。
 * PM 是项目组的会话统筹 + 人机交互入口：回收任务执行结果给用户、等待或
 * 自主决策下一指令/任务给到团队。预置一份，所有项目共用引用（项目可后续
 * 换成自定义 PM profile）。
 */
export function ensurePmProfile(): AgentProfile {
  const existing = loadProfile(PM_PROFILE_ID)
  // system profile：prompt 随版本演进幂等刷新（保留用户的模型/能力配置）。
  if (existing !== undefined) {
    if (existing.trust === 'system' && existing.prompt !== PM_PROMPT) {
      const refreshed = { ...existing, prompt: PM_PROMPT }
      saveProfile(refreshed)
      return refreshed
    }
    return existing
  }
  const profile: AgentProfile = {
    id: PM_PROFILE_ID,
    nickname: 'PM 助理',
    title: '项目统筹',
    prompt: PM_PROMPT,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

/** task 模式的内置 profile id（单任务会话默认角色）。 */
export const TASK_PROFILE_ID = 'task'
/** task 会话持久化索引落的专用伪项目目录（与 project 泳道的项目目录隔离）。 */
export const TASK_PROJECT_ID = 'task'

const TASK_PROMPT = '你是矩道 task 模式的单任务开发 Agent。用户在某工作区直接发起一个开发任务，你独立完成它。\n工作方式：理解任务 → 用工具（读写文件/跑命令）推进 → 完成后简洁汇报结果。\n你是单任务会话：不涉及项目团队/派活/需求管理，专注把当前这一个任务做好。'

/**
 * 确保 task 模式的内置 profile 存在（幂等）。
 * task profile 是单任务会话的默认角色：无项目团队语义，独立完成任务。
 */
export function ensureTaskProfile(): AgentProfile {
  const existing = loadProfile(TASK_PROFILE_ID)
  if (existing !== undefined) {
    if (existing.trust === 'system' && existing.prompt !== TASK_PROMPT) {
      const refreshed = { ...existing, prompt: TASK_PROMPT }
      saveProfile(refreshed)
      return refreshed
    }
    return existing
  }
  const profile: AgentProfile = {
    id: TASK_PROFILE_ID,
    nickname: 'Task 助理',
    title: '单任务',
    prompt: TASK_PROMPT,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

/** 确保内置 smoke-test profile 存在（幂等）。 */
export function ensureSmokeProfile(): AgentProfile {
  const existing = loadProfile(SMOKE_PROFILE_ID)
  if (existing !== undefined) return existing
  const profile: AgentProfile = {
    id: SMOKE_PROFILE_ID,
    prompt: 'You are a smoke-test agent. Follow the user instruction exactly and briefly.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}
