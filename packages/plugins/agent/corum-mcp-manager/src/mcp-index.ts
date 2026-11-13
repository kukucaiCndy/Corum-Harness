/**
 * MCP 渐进式索引（index 模式）的**展示层**：索引段文本、工具摘要截断，以及两个共享工具
 * （`mcp_index` / `mcp_load`）的结果渲染。
 *
 * ## 为什么要有这一层（2026-11-12d §2，用户批准；默认 index）
 *
 * 改造前（eager）：每个被授权的 server 在挂载瞬间就把**全部**工具 `tools.register` 进工具面，
 * 每工具 schema 随首轮提示词一起进上下文（11 个工具 ≈ 10KB，10 个 server ≈ 60~100KB）。
 * index 模式的取舍是：**首轮只放一张索引**（server 名 + 一行用途 + 工具名与 ≤60 字符摘要），
 * 模型按需 `mcp_index` 看全量定义、`mcp_load` 把选中的工具真正注册进工具面。
 *
 * 本文件只做**纯函数**（文本生成），不做注册态与并发协调——那是 `proxy.ts` 的职责（它持有
 * `tools.register` 的面，且要把「每 scope 只注册一次」的协调状态放在与注册面同一处）。
 * 拆开的理由与 `mcp-guidance.ts` 相同：文本可以脱离 cordis 上下文单测。
 *
 * ## 语言纪律
 *
 * 本文件产出的一切**包装文本**（标题 / 说明 / 摘要分隔 / 纪律句）一律英文（用户 2026-09-10 定调
 * 「提示词都以英文编写」，本包门禁 `tests/guidance-language.spec.ts` 同族）。正文（注册表里的
 * `description` / `guidance`、服务端给的工具描述）原样引用，不重写不翻译。
 *
 * @module @corum/corum-mcp-manager/mcp-index
 */

import type { McpPoolTool } from './pool.ts'
import { mcpGuidanceSectionText } from './mcp-guidance.ts'
import { publicToolName } from './tool-naming.ts'

/** 索引段名前缀（每 server 一段：`corum:mcp-index:<serverName>`）。 */
export const MCP_INDEX_SECTION_PREFIX = 'corum:mcp-index'

/** 单个工具摘要的字符上限（首句截断；见 {@link summarizeToolDescription}）。 */
export const MCP_TOOL_SUMMARY_MAX_CHARS = 60

/** 索引段里每 server 最多列多少个工具名（超出给一句提示，细节走 `mcp_index`）。 */
export const MCP_INDEX_MAX_LISTED_TOOLS = 40

/** server 一行用途（注册表 `description`）的字符上限。 */
export const MCP_INDEX_PURPOSE_MAX_CHARS = 120

/** 索引查询工具名（共享：每 scope 只注册一次）。 */
export const MCP_INDEX_TOOL_NAME = 'mcp_index'

/** 索引加载工具名（共享：每 scope 只注册一次）。 */
export const MCP_LOAD_TOOL_NAME = 'mcp_load'

/**
 * 索引查询工具的描述（模型可见，英文）。
 *
 * 明确写「不改工具面」：否则模型会拿它当 `mcp_load` 用，以为查过就能调。
 */
export const MCP_INDEX_TOOL_DESCRIPTION =
  'List the MCP tools this session is authorized for, with full descriptions, parameter schemas and usage guidance. '
  + 'Read-only: it never registers a tool. Use mcp_load to register the tools you need, then call them.'

/** 索引加载工具的描述（模型可见，英文）。 */
export const MCP_LOAD_TOOL_DESCRIPTION =
  'Register MCP tools for this session so they become callable. Pass a server name to load every tool of that '
  + 'server, or `tools` to load a subset. Loaded tools stay callable for the rest of the session and the '
  + "server's usage guidance enters the system prompt."

/** 一个 server 的索引数据（纯数据，用于文本生成与查询）。 */
export interface McpIndexCatalogEntry {
  /** 服务名（= 注册表 `name`，也是 `mcp__<server>__` 前缀里的那一段）。 */
  readonly serverName: string
  /** 注册表里给人看的服务简介（索引段里压成一行用途）。 */
  readonly description?: string
  /** 注册表里的使用指导（加载后才进提示词；`mcp_index` 里按需全文出示）。 */
  readonly guidance?: string
  /** 当前工具表（来自池的 `listTools`）。 */
  readonly tools: readonly McpPoolTool[]
  /** 已加载的**原始**工具名（索引段据此隐藏已加载项，详情里标注 `(loaded)`）。 */
  readonly loaded?: readonly string[]
}

/** `mcp_index` 的查询参数。 */
export interface McpIndexQuery {
  /** 只看这个 server（缺省 = 全部已授权 server）。 */
  readonly server?: string
  /** 大小写不敏感的子串，匹配工具名与描述（缺省 = 全部工具）。 */
  readonly query?: string
}

/** 该 server 的索引段名。 */
export function mcpIndexSectionName(serverName: string): string {
  return `${MCP_INDEX_SECTION_PREFIX}:${serverName}`
}

/** 折成一行（索引段是清单，不能有换行）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 按字符上限截断（追加省略号，结果长度 ≤ `max`）。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * 工具摘要：描述**首句**截断到 {@link MCP_TOOL_SUMMARY_MAX_CHARS} 字符。
 *
 * 取首句而不是前 N 字符：服务端描述多是「一句话做什么，然后若干使用要点」，首句正好是"做什么"；
 * 硬截前 60 字符常把半句留下，读起来像噪声。首句本身超长时才硬截。
 *
 * 句末判定用 `[.!?]` + 后随空白/结尾，或 CJK 句末标点（CJK 不加空格）——这样 `` `demo.run` ``
 * 里的点号不会被当成句末。
 *
 * @param description - 服务端给的工具描述（可缺省）。
 * @returns 单行摘要；描述为空 ⇒ 空串（调用方据此只列工具名）。
 */
export function summarizeToolDescription(description: string | undefined): string {
  const body = oneLine(description ?? '')
  if (body === '') return ''
  const sentence = /^.*?(?:[.!?](?=\s|$)|[。！？])/u.exec(body)?.[0] ?? body
  return clip(sentence.trim(), MCP_TOOL_SUMMARY_MAX_CHARS)
}

/**
 * 索引段文本（**纯函数**）：一行用途 + 工具名清单（每项 ≤60 字符摘要）+ 使用纪律一句。
 *
 * 已加载的工具不再列出；全部都加载了 ⇒ 返回空串（调用方据此**摘掉**该段，不占提示词）。
 *
 * @param entry - 该 server 的索引数据（含 `loaded`）。
 * @returns 段文本；没有待加载工具 ⇒ 空串。
 */
export function mcpIndexSectionText(entry: McpIndexCatalogEntry): string {
  const loaded = new Set(entry.loaded ?? [])
  const pending = entry.tools.filter(tool => !loaded.has(tool.name))
  if (pending.length === 0) return ''
  const purpose = oneLine(entry.description ?? '')
  const listed = pending.slice(0, MCP_INDEX_MAX_LISTED_TOOLS)
  const hidden = pending.length - listed.length
  const count = `${pending.length} tool${pending.length === 1 ? '' : 's'}`
  const lines = [
    `## MCP tool index: ${entry.serverName}`,
    '',
    ...(purpose === '' ? [] : [clip(purpose, MCP_INDEX_PURPOSE_MAX_CHARS), '']),
    `Authorized MCP server \`${entry.serverName}\` with ${count} not loaded yet (public tool names look like \`mcp__${entry.serverName}__<tool>\`):`,
    '',
    ...listed.map((tool) => {
      const summary = summarizeToolDescription(tool.description)
      return summary === '' ? `- \`${tool.name}\`` : `- \`${tool.name}\` — ${summary}`
    }),
    ...(hidden > 0 ? [`- … and ${hidden} more (call \`${MCP_INDEX_TOOL_NAME}\` to see all)`] : []),
    '',
    `Load before calling: \`${MCP_LOAD_TOOL_NAME}({server: "${entry.serverName}"})\` loads every tool, or pass \`tools\` for a subset. \`${MCP_INDEX_TOOL_NAME}({server: "${entry.serverName}"})\` returns full descriptions, parameter schemas and guidance. A tool that was never loaded is NOT callable.`,
  ]
  return lines.join('\n')
}

/**
 * 按查询条件挑出索引条目（`mcp_index` 的筛选规则，抽出来便于单测）。
 *
 * server 名先精确匹配、再大小写不敏感匹配；指定了不存在的 server ⇒ `unknownServer` 回给调用方
 * 去 fail-loud（决策 5：未知 server 名大声报错，不做静默空结果）。
 *
 * @param entries - 本 scope 的索引条目。
 * @param query - 查询条件。
 * @returns 命中的条目与（可能的）未知 server 名。
 */
export function filterIndexEntries(
  entries: readonly McpIndexCatalogEntry[],
  query: McpIndexQuery = {},
): { readonly matched: readonly McpIndexCatalogEntry[]; readonly unknownServer?: string } {
  let pool = entries
  if (query.server !== undefined) {
    const wanted = query.server
    const exact = entries.find(entry => entry.serverName === wanted)
    const relaxed = exact ?? entries.find(entry => entry.serverName.toLowerCase() === wanted.toLowerCase())
    if (relaxed === undefined) return { matched: [], unknownServer: wanted }
    pool = [relaxed]
  }
  const needle = query.query === undefined ? '' : oneLine(query.query).toLowerCase()
  if (needle === '') return { matched: pool }
  const matched: McpIndexCatalogEntry[] = []
  for (const entry of pool) {
    const tools = entry.tools.filter(tool => {
      const haystack = `${tool.name} ${oneLine(tool.description ?? '')}`.toLowerCase()
      return haystack.includes(needle)
    })
    if (tools.length > 0) matched.push({ ...entry, tools })
  }
  return { matched }
}

/** JSON 化一个 schema（服务端可能不给 / 给非对象 ⇒ 空对象字面量）。 */
function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

/**
 * `mcp_index` 的结果文本：命中工具的**完整描述 + 参数 schema + 该 server 的 guidance**。
 *
 * 纯查询，不改工具面。已加载的工具标 `(loaded)`，避免模型重复 load。
 *
 * @param entries - `filterIndexEntries` 的结果。
 * @returns 模型可读文本。
 */
export function renderIndexDetail(entries: readonly McpIndexCatalogEntry[]): string {
  if (entries.length === 0) {
    return `No authorized MCP tool matches this query. Call \`${MCP_INDEX_TOOL_NAME}\` without arguments to list every authorized server.`
  }
  const blocks: string[] = []
  for (const entry of entries) {
    const loaded = new Set(entry.loaded ?? [])
    blocks.push(`### \`${entry.serverName}\``)
    const purpose = oneLine(entry.description ?? '')
    if (purpose !== '') blocks.push('', purpose)
    // guidance 复用既有包装/截断（同一份文本、同一条语言纪律），加载后它也会作为独立段注入。
    const guidance = mcpGuidanceSectionText(entry.serverName, entry.guidance)
    if (guidance !== '') blocks.push('', guidance)
    if (entry.tools.length === 0) {
      blocks.push('', 'This server has listed no tools.')
      continue
    }
    blocks.push('', `Tools (load with \`${MCP_LOAD_TOOL_NAME}({server: "${entry.serverName}", tools: [...]})\`):`)
    for (const tool of entry.tools) {
      const mark = loaded.has(tool.name) ? ' (loaded)' : ''
      blocks.push(`- \`${publicToolName(entry.serverName, tool.name)}\` — server tool name \`${tool.name}\`${mark}`)
      const description = oneLine(tool.description ?? '')
      if (description !== '') blocks.push(`  description: ${description}`)
      blocks.push(`  parameters: ${jsonOf(tool.inputSchema)}`)
    }
  }
  return blocks.join('\n')
}

/**
 * `mcp_load` 的结果文本：说清**这次真的加载了什么**、以及"已加载"的部分。
 *
 * @param serverName - 服务名。
 * @param loaded - 本次新注册的原始工具名。
 * @param already - 之前已注册过的原始工具名（幂等重放时非空）。
 * @returns 模型可读文本。
 */
export function renderLoadResult(
  serverName: string,
  loaded: readonly string[],
  already: readonly string[],
): string {
  const names = (list: readonly string[]): string => list.map(name => `\`${publicToolName(serverName, name)}\``).join(', ')
  const lines: string[] = []
  if (loaded.length > 0) {
    lines.push(`Loaded ${loaded.length} tool(s) from \`${serverName}\`: ${names(loaded)}.`)
    lines.push('They are callable now; their schemas are part of your tool list from this turn on.')
  } else {
    lines.push(`No new tool was loaded from \`${serverName}\`.`)
  }
  if (already.length > 0) lines.push(`Already loaded earlier: ${names(already)}.`)
  return lines.join('\n')
}

/** `mcp_index` 的参数 schema（模型可见描述英文）。 */
export function mcpIndexToolParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'MCP server name to inspect. Omit to cover every authorized server.',
      },
      query: {
        type: 'string',
        description: 'Case-insensitive substring matched against tool names and descriptions. Omit to list every tool.',
      },
    },
    additionalProperties: false,
  }
}

/** `mcp_load` 的参数 schema（模型可见描述英文）。 */
export function mcpLoadToolParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'MCP server name whose tools to register (required).',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tool names to load (raw server names or mcp__<server>__<tool> names). Omit to load every tool of that server.',
      },
    },
    required: ['server'],
    additionalProperties: false,
  }
}
