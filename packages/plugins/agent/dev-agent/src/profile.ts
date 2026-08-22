/**
 * AgentProfile 数据模型：corum 跨项目、可复用的 Agent 配置单元。
 *
 * 对应 PRD §4.0.2 的六项：
 *   prompt / model / skills / mcpServers / terminal / memoryPolicy
 * 加上 version / trust（快照隔离 / 信任级）。
 *
 * 存储：`~/.corum-shell/agent-profiles/<id>.json`（不 per-workspace）。
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

/** MCP 服务配置（对齐官方 dsh-mcp-client 的 config 子集）。 */
export interface ProfileMcpServer {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
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

/** AgentProfile 完整定义。 */
export interface AgentProfile {
  /** profile id（文件名，slug）。 */
  id: string
  /** dsh 标准 system prompt（与专业相关）。 */
  prompt: string
  /** 默认大模型配置。 */
  model: ProfileModel
  /** 技能（skill 名列表）。 */
  skills: string[]
  /** MCP 服务列表。 */
  mcpServers: ProfileMcpServer[]
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
