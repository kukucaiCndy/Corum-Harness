/**
 * AgentProfile 数据模型：corum 跨项目、可复用的 Agent 配置单元。
 *
 * 对应 PRD §4.0.2 的六项：
 *   prompt / model / skills / mcpServers / terminal / memoryPolicy
 * 加上 version / trust（快照隔离 / 信任级）。
 *
 * 存储：`~/.corum-shell/.agent-presets/<id>/agent.json`。
 *
 * MCP 服务采用全局注册表 + 授权引用：
 *   agent.json 的 mcpServers 字段记录 string[]（授权的服务名列表），
 *   编译 preset 时从 ~/.corum-shell/mcp-servers.json 读取完整配置。
 *
 * Skill 采用引用绑定 + 版本 pinning：
 *   agent.json 的 skills 字段记录 SkillBinding[]（name + versionId），
 *   Agent mount 前把对应版本的 SKILL.md 复制为当前 SKILL.md。
 *   Skill 全局统一管理在 ~/.dsh/skills/。
 * @module @corum/dev-agent/profile
 */

/** 默认大模型配置。 */
export interface ProfileModel {
  /** provider route（如 deepseek / pi-ai）。 */
  provider: string
  /** model id。 */
  model: string
  /** 可选 reasoning effort。 */
  reasoningEffort?: string
}

/** 终端能力。 */
export interface ProfileTerminal {
  /** sandbox | host（host 级敏感，需人显式开启）。 */
  mode: 'sandbox' | 'host'
}

/** 专属记忆策略（PRD §4.0.5）。 */
export interface ProfileMemoryPolicy {
  /** 记忆作用域（当前固定 agent）。 */
  scope: 'agent'
  /** 自定义记忆目录（空 = 默认 `~/.corum-shell/memory/<profileId>/`）。 */
  dir?: string
}

/**
 * Skill 绑定：Agent 引用全局 skill 的一个固定版本。
 * - name：skill 名称（对应 ~/.dsh/skills/<name>/）
 * - versionId：pin 的版本 ID（日期+序号，如 2026-08-22-01）
 *   Agent 创建前把对应版本的 SKILL.md 复制为当前 SKILL.md。
 */
export interface SkillBinding {
  /** skill name（全局目录 ~/.dsh/skills/<name>/ 下的子目录名）。 */
  name: string
  /** pin 的版本 ID（日期+序号）。Agent 对 skill 版本不可见，始终用此版本。 */
  versionId: string
}

/** AgentProfile 完整定义。 */
export interface AgentProfile {
  /** profile id（文件名，slug）。 */
  id: string
  /** 昵称（显示用，可选）。 */
  nickname?: string
  /** 岗位 / 职位（显示用，可选）。 */
  title?: string
  /** dsh 标准 system prompt（与专业相关）。 */
  prompt: string
  /** 默认大模型配置。 */
  model: ProfileModel
  /** 技能绑定列表（引用全局 skill + pin 版本）。 */
  skills: SkillBinding[]
  /** MCP 服务授权列表（引用全局注册表中的服务名）。 */
  mcpServers: string[]
  /** 终端能力。 */
  terminal: ProfileTerminal
  /** 专属记忆策略。 */
  memoryPolicy: ProfileMemoryPolicy
  /** 版本号（快照隔离）。 */
  version: number
  /** 信任级（system / user）。 */
  trust: 'system' | 'user'
}

/** 校验一个 profile id（slug 形式，防路径逃逸）。 */
export function isValidProfileId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}
