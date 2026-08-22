/**
 * AgentProfile → preset 编译（路径 A 的核心）。
 *
 * 把 AgentProfile 六项翻译成一份 agent.cordis.yml 文本 + preset.yml 元数据，
 * 落盘到 agent-presets 的 user root（`~/.corum-shell/.agent-presets/<id>/`），
 * 再由 `ctx.agentPresets.mount(agentCtx, id)` 走官方组装链路。
 *
 * 编译映射（PRD §4.0.2 → preset 行）：
 *   prompt        → dsh-persona 行（text）
 *   model         → 不进 preset（创建 Agent 时的 agentOptions）
 *   skills        → skill-filesystem + tool-skill 行
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
 * @param profile - AgentProfile。
 * @returns 两份文件文本（agent.cordis.yml + preset.yml）。
 */
export function compilePreset(profile: AgentProfile): CompiledPreset {
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

  // skills：若声明了 skill，挂 skill-filesystem + tool-skill（模型可通过 skill 工具调用）。
  if (profile.skills.length > 0) {
    rows.push({
      id: 'skill-filesystem',
      name: '@deepseek-ai/dsh-skill-filesystem',
    })
    rows.push({
      id: 'tool-skill',
      name: '@deepseek-ai/dsh-tool-skill',
    })
  }

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
  for (const [index, mcp] of profile.mcpServers.entries()) {
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
      lines.push(`  name: ${row.name}`)
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
        lines.push(`      name: ${child.name}`)
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
      lines.push(`  name: ${row.name}`)
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
