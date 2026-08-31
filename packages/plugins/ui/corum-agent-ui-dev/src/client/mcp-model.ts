/**
 * mcp-model —— McpManagerPanel 的 RPC 镜像类型与纯函数（从 McpManagerPanel.tsx 拆出，包内文件拆分）。
 *
 * 两块：
 *   - 类型镜像（@corum/corum-mcp-manager-dev 的 types.ts 的 UI 侧投影）：
 *     McpServerSummary/McpStdioServer/McpHttpServer/McpServerConfig/
 *     McpToolSummary/TestConnectionResult/ProbeState/Toast；
 *   - 纯函数：KvPair 互转、ServerDraft 三态转换（empty/fromServer/toConfig）、
 *     normalizeServerName、parseImportJson（claude_desktop_config 风格导入解析）。
 * 纯数据层：不碰 React / RPC。
 * @module @corum/corum-agent-ui-dev/mcp-model
 */

// ── RPC 类型（镜像 @corum/corum-mcp-manager-dev 的 types.ts） ────────────

export interface McpServerSummary {
  name: string
  description?: string
  transport: 'stdio' | 'streamable-http'
  endpoint: string
  disabled?: boolean
}

export interface McpStdioServer {
  name: string
  description?: string
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  toolCallTimeoutMs?: number
  disabled?: boolean
}

export interface McpHttpServer {
  name: string
  description?: string
  transport: 'streamable-http'
  url: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  disabled?: boolean
}

export type McpServerConfig = McpStdioServer | McpHttpServer

export interface McpToolSummary {
  name: string
  description?: string
}

export type TestConnectionResult =
  | { ok: true; tools: McpToolSummary[] }
  | { ok: false; error: string }

// ── 连接状态 ──────────────────────────────────────────────────────

export type ProbeState =
  | { status: 'unknown' }
  | { status: 'testing' }
  | { status: 'online'; tools: McpToolSummary[] }
  | { status: 'error'; error: string }

export const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

// ── key-value 行 ──────────────────────────────────────────────────

export interface KvPair {
  key: string
  value: string
}

export function kvFromRecord(record: Record<string, string> | undefined): KvPair[] {
  if (record === undefined) return []
  return Object.entries(record).map(([key, value]) => ({ key, value }))
}

export function kvToRecord(pairs: readonly KvPair[]): Record<string, string> | undefined {
  const record: Record<string, string> = {}
  for (const p of pairs) {
    if (p.key.trim() !== '') record[p.key.trim()] = p.value
  }
  return Object.keys(record).length > 0 ? record : undefined
}

// ── 编辑弹窗草稿 ──────────────────────────────────────────────────

export interface ServerDraft {
  /** 编辑模式下为原服务名（只读）；新建时为空串。 */
  name: string
  description: string
  transport: 'stdio' | 'streamable-http'
  command: string
  args: string
  env: KvPair[]
  cwd: string
  url: string
  headers: KvPair[]
  toolCallTimeoutMs: string
  disabled: boolean
}

export function emptyDraft(): ServerDraft {
  return {
    name: '', description: '', transport: 'stdio', command: '', args: '',
    env: [], cwd: '', url: '', headers: [], toolCallTimeoutMs: '', disabled: false,
  }
}

export function draftFromServer(s: McpServerConfig): ServerDraft {
  const base = emptyDraft()
  base.name = s.name
  base.description = s.description ?? ''
  base.transport = s.transport
  base.toolCallTimeoutMs = s.toolCallTimeoutMs !== undefined ? String(s.toolCallTimeoutMs) : ''
  base.disabled = s.disabled === true
  if (s.transport === 'stdio') {
    base.command = s.command
    base.args = (s.args ?? []).join('\n')
    base.env = kvFromRecord(s.env)
    base.cwd = s.cwd ?? ''
  } else {
    base.url = s.url
    base.headers = kvFromRecord(s.headers)
  }
  return base
}

export function draftToConfig(d: ServerDraft): McpServerConfig {
  const timeout = d.toolCallTimeoutMs.trim() !== '' ? Number(d.toolCallTimeoutMs) : undefined
  if (d.transport === 'stdio') {
    const args = d.args.split('\n').map(a => a.trim()).filter(a => a !== '')
    const env = kvToRecord(d.env)
    return {
      name: d.name.trim(),
      transport: 'stdio',
      command: d.command.trim(),
      ...(d.description.trim() !== '' ? { description: d.description.trim() } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(d.cwd.trim() !== '' ? { cwd: d.cwd.trim() } : {}),
      ...(timeout !== undefined && Number.isFinite(timeout) ? { toolCallTimeoutMs: timeout } : {}),
      ...(d.disabled ? { disabled: true } : {}),
    }
  }
  const headers = kvToRecord(d.headers)
  return {
    name: d.name.trim(),
    transport: 'streamable-http',
    url: d.url.trim(),
    ...(d.description.trim() !== '' ? { description: d.description.trim() } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(timeout !== undefined && Number.isFinite(timeout) ? { toolCallTimeoutMs: timeout } : {}),
    ...(d.disabled ? { disabled: true } : {}),
  }
}

// ── JSON 导入解析 ─────────────────────────────────────────────────

export interface ParsedImport {
  name: string
  config: McpServerConfig
  /** 名称被规范化时记录原始名（用于预览提示与 description 兜底）。 */
  originalName?: string
}

/**
 * 把任意显示名规范化为合法 serverName（`[A-Za-z0-9_-]{1,32}`）。
 * 该约束来自官方 dsh：serverName 要拼进模型侧工具名
 * `mcp__<serverName>__<tool>`（function-name 字符集 + 长度预算）。
 * 规则：小写 → 非法字符折叠为 `-` → 去首尾 `-` → 截断 32。
 * 无法得到有效名时返回 null。
 */
export function normalizeServerName(raw: string): string | null {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return NAME_PATTERN.test(normalized) ? normalized : null
}

/**
 * 解析粘贴的 JSON：
 *   - claude_desktop_config 风格：{ "mcpServers": { name: {...}, ... } }
 *   - 单个 server map：{ name: {...} }
 *   - 单个 server 配置（带 name 字段）：{ "name": "x", "command": ... }
 * 服务名会自动规范化为合法 serverName（如 "Pencli MCP" → "pencli-mcp"），
 * 原始名在 description 缺省时兜底保留。缺 command/url、名字无法规范化时抛错。
 */
export function parseImportJson(text: string): ParsedImport[] {
  const raw = JSON.parse(text) as unknown
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('JSON 必须是对象')
  }
  let entries: Record<string, unknown>
  const obj = raw as Record<string, unknown>
  if (typeof obj.mcpServers === 'object' && obj.mcpServers !== null) {
    entries = obj.mcpServers as Record<string, unknown>
  } else if (typeof obj.name === 'string') {
    entries = { [obj.name]: obj }
  } else {
    entries = obj
  }
  const results: ParsedImport[] = []
  for (const [rawName, value] of Object.entries(entries)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`服务 "${rawName}" 的配置必须是对象`)
    }
    const name = NAME_PATTERN.test(rawName) ? rawName : normalizeServerName(rawName)
    if (name === null) {
      throw new Error(`服务名 "${rawName}" 无法规范化为合法 id（需要至少一个字母/数字）`)
    }
    const renamed = name !== rawName
    const v = value as Record<string, unknown>
    const description = typeof v.description === 'string'
      ? v.description
      : renamed ? rawName : undefined
    const timeout = typeof v.toolCallTimeoutMs === 'number' ? v.toolCallTimeoutMs : undefined
    const renamedMeta = renamed ? { originalName: rawName } : {}
    if (typeof v.url === 'string') {
      const headers = (typeof v.headers === 'object' && v.headers !== null)
        ? v.headers as Record<string, string> : undefined
      results.push({
        name,
        ...renamedMeta,
        config: {
          name, transport: 'streamable-http', url: v.url,
          ...(description !== undefined ? { description } : {}),
          ...(headers !== undefined ? { headers } : {}),
          ...(timeout !== undefined ? { toolCallTimeoutMs: timeout } : {}),
        },
      })
    } else if (typeof v.command === 'string') {
      const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : undefined
      const env = (typeof v.env === 'object' && v.env !== null)
        ? v.env as Record<string, string> : undefined
      results.push({
        name,
        ...renamedMeta,
        config: {
          name, transport: 'stdio', command: v.command,
          ...(description !== undefined ? { description } : {}),
          ...(args !== undefined && args.length > 0 ? { args } : {}),
          ...(env !== undefined ? { env } : {}),
          ...(typeof v.cwd === 'string' ? { cwd: v.cwd } : {}),
          ...(timeout !== undefined ? { toolCallTimeoutMs: timeout } : {}),
        },
      })
    } else {
      throw new Error(`服务 "${rawName}" 缺少 command（stdio）或 url（http）字段`)
    }
  }
  if (results.length === 0) throw new Error('未解析到任何服务配置')
  return results
}

// ── Toast ─────────────────────────────────────────────────────────

export interface Toast {
  level: 'info' | 'error' | 'success'
  message: string
}
