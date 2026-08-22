/**
 * AgentProfile → preset 编译（路径 A 的核心）。
 *
 * 把 AgentProfile 翻译成一份 agent.cordis.yml 文本 + preset.yml 元数据，
 * 落盘到 agent-presets 的 user root（`~/.corum-shell/.agent-presets/<id>/`），
 * 再由 `ctx.agentPresets.mount(agentCtx, id)` 走官方组装链路。
 *
 * 编译映射：
 *   prompt        → dsh-persona 行（text）
 *   model         → 不进 preset（创建 Agent 时的 agentOptions）
 *   skills        → skill-filesystem 行（customSkillDirs 指向 Agent 自身的
 *                   skills/ 目录）+ tool-skill 行
 *   mcpServers    → dsh-mcp-client 行（每 server 一行）
 *   terminal      → persistent bash/pwsh 行（sandbox 由 host 层提供）
 *   memoryPolicy  → 不进 preset（记忆由专属工具/服务注入，后续接入）
 *
 * 纯函数，无副作用：输出两份文件的内容，由调用方落盘。
 * @module @corum/dev-agent/compile
 */

import type { AgentProfile } from './profile.ts'

/** 一行 cordis 配置（编译成 YAML 的中间表示）。 */
interface CordisRow {
  id: string
  name: string
  config?: Record<string, unknown>
  /** 布尔或 `!!js ...` 表达式字符串（YAML 标记）。 */
  disabled?: boolean | string
  group?: boolean
  isolate?: Record<string, boolean>
  children?: CordisRow[]
}

/** 编译结果：preset 目录的两份文件内容。 */
export interface CompiledPreset {
  /** agent.cordis.yml 文本。 */
  cordisYml: string
  /** preset.yml 文本。 */
  presetYml: string
}

/**
 * 把一个 AgentProfile 编译成 preset 目录内容。
 *
 * @param profile - AgentProfile。
 * @param agentDir - Agent 的目录绝对路径（用于 customSkillDirs 的 `!!js` 表达式）。
 *                   传入时，skill-filesystem 行的 customSkillDirs 会指向
 *                   `<agentDir>/skills/`，让 Agent 从自己的目录发现已导入的 skills。
 * @returns 两份文件文本（agent.cordis.yml + preset.yml）。
 */
export function compilePreset(profile: AgentProfile, agentDir?: string): CompiledPreset {
  const rows: CordisRow[] = []

  // persona：profile.prompt → 完整 system prompt（complete:true，与 minimal 一致，
  // 让角色 prompt 独占，避免官方默认 persona/工具引导混入）。
  rows.push({
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: {
      text: profile.prompt,
      complete: true,
      includeRuntimeContext: false,
    },
  })

  // skills：始终挂 skill-filesystem + tool-skill。
  // 若提供了 agentDir，则 customSkillDirs 指向 Agent 自身的 skills/ 目录
  //（已导入的 skill 从该目录被发现）。同时也继承全局 skill 发现（不覆盖
  // skill-filesystem 的默认扫描根）。
  const skillRow: CordisRow = {
    id: 'skill-filesystem',
    name: '@deepseek-ai/dsh-skill-filesystem',
  }
  if (agentDir !== undefined) {
    // customSkillDirs 用 `!!js` 表达式引用 Agent 目录下的 skills/ 子目录。
    // 用 JSON.stringify 包裹路径 + fileURLToPath 确保跨平台路径解析。
    // 但 agent.cordis.yml 的 `!!js` 表达式在 mount 时由 Include 解析器执行，
    // 上下文中有 `baseUrl`（= agent.cordis.yml 所在目录的 file URL）。
    // 所以直接用 new URL('skills/', baseUrl) 让路径随 preset 目录走。
    skillRow.config = {
      customSkillDirs: ["!!js \"new URL('skills/', baseUrl).href\""],
    }
  }
  rows.push(skillRow)
  rows.push({
    id: 'tool-skill',
    name: '@deepseek-ai/dsh-tool-skill',
  })

  // terminal：persistent shell（bash on POSIX / pwsh on win32）。sandbox 策略由 host 层
  // 提供，这里只挂持久终端工具。profile.terminal.mode 仅记录意图，host 级敏感能力
  // 需人显式开启（护栏在创建 Agent 处校验）。
  rows.push({
    id: 'persistent-shell',
    name: 'cordis:group',
    group: true,
    isolate: { terminals: true },
    children: [
      {
        id: 'pty',
        name: '@deepseek-ai/dsh-terminal',
      },
      {
        id: 'terminal-bash',
        name: '@deepseek-ai/dsh-terminal-bash',
        disabled: '!!js process.platform === \'win32\'',
        config: { timeoutMs: 300000 },
      },
      {
        id: 'persistent-bash',
        name: '@deepseek-ai/dsh-tool-bash-persistent',
        disabled: '!!js process.platform === \'win32\'',
        config: { timeoutMs: 300000 },
      },
      {
        id: 'terminal-pwsh',
        name: '@deepseek-ai/dsh-terminal-bash',
        disabled: '!!js process.platform !== \'win32\'',
        config: { shellDialect: 'pwsh', timeoutMs: 300000 },
      },
      {
        id: 'persistent-pwsh',
        name: '@deepseek-ai/dsh-tool-pwsh-persistent',
        disabled: '!!js process.platform !== \'win32\'',
        config: { timeoutMs: 300000 },
      },
    ],
  })

  // filesystem：文件 + 编辑工具（Agent 干活的基础能力）。
  rows.push({
    id: 'filesystem',
    name: 'cordis:group',
    group: true,
    isolate: { fs: true },
    children: [
      {
        id: 'fs-local',
        name: '@deepseek-ai/dsh-fs-local',
        config: { cwd: '!!js process.env.DSH_CWD ?? process.cwd()' },
      },
      {
        id: 'str-replace-editor',
        name: '@deepseek-ai/dsh-tool-str-replace-editor',
        config: { maxOutputChars: 16000 },
      },
    ],
  })

  // MCP：每 server 一行 dsh-mcp-client。
  for (const mcp of profile.mcpServers) {
    const config: Record<string, unknown> = {
      serverName: mcp.serverName,
      transport: mcp.transport,
    }
    if (mcp.transport === 'stdio') {
      if (mcp.command !== undefined) config.command = mcp.command
      if (mcp.args !== undefined && mcp.args.length > 0) config.args = mcp.args
      if (mcp.env !== undefined) config.env = mcp.env
    } else {
      if (mcp.url !== undefined) config.url = mcp.url
      if (mcp.headers !== undefined) config.headers = mcp.headers
    }
    rows.push({
      id: `mcp-${mcp.serverName}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config,
    })
  }

  return {
    cordisYml: renderRows(rows),
    presetYml: `name: ${profile.id}\ndescription: ${profile.prompt.split('\n')[0] ?? ''}\n`,
  }
}

/** 把中间表示的行渲染成 YAML 文本（对齐官方 agent.cordis.yml 风格）。 */
function renderRows(rows: readonly CordisRow[]): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.group) {
      lines.push(`- id: ${row.id}`)
      lines.push(`  name: ${renderScalar(row.name)}`)
      lines.push(`  group: true`)
      if (row.isolate !== undefined) {
        lines.push(`  isolate:`)
        for (const [key, value] of Object.entries(row.isolate)) {
          lines.push(`    ${key}: ${value}`)
        }
      }
      lines.push(`  config:`)
      for (const child of row.children ?? []) {
        lines.push(`    - id: ${child.id}`)
        lines.push(`      name: ${renderScalar(child.name)}`)
        if (child.disabled !== undefined) lines.push(`      disabled: ${child.disabled}`)
        if (child.config !== undefined) {
          lines.push(`      config:`)
          for (const [key, value] of Object.entries(child.config)) {
            lines.push(`        ${key}: ${renderScalar(value)}`)
          }
        }
      }
    } else {
      lines.push(`- id: ${row.id}`)
      lines.push(`  name: ${renderScalar(row.name)}`)
      if (row.disabled !== undefined) lines.push(`  disabled: ${row.disabled}`)
      if (row.config !== undefined) {
        lines.push(`  config:`)
        for (const [key, value] of Object.entries(row.config)) {
          lines.push(`    ${key}: ${renderScalar(value)}`)
        }
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 把一个标量渲染成 YAML 标量（字符串用引号，数字/布尔原样）。 */
function renderScalar(value: unknown): string {
  if (typeof value === 'string') {
    // `!!js ...` 是 YAML 标记表达式（见官方 minimal preset 的 `disabled:` 与
    // `fs-local` 的 `cwd:`），必须不带引号原样输出——JSON.stringify 会把它
    // 包成普通字符串，使 `!!js` 标记失效，terminal/fs 行就会按错误的语义装载。
    if (value.startsWith('!!js ')) return value
    return JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return 'null'
  return JSON.stringify(value)
}
