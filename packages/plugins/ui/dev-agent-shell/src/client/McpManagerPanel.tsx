/**
 * McpManagerPanel — MCP 服务全局管理面板（卡片列表 + 弹窗编辑）。
 *
 * 信息架构参考 Cursor Settings > MCP：
 *   - 顶部工具栏：标题 / 从 JSON 导入 / 全部刷新 / 添加服务
 *   - 服务卡片：状态点、名称、描述、transport 徽标 + endpoint、
 *     启停开关、工具数、操作（重新探测 / 编辑 / 删除）
 *   - 卡片点击展开工具列表（来自真实握手探测结果）
 *   - 添加 / 编辑走模态弹窗（env/headers 用 key-value 行编辑器）
 *   - 删除前确认并提示引用该服务的 AgentProfile
 *
 * 组件自包含：自理 RPC 数据流，无必需 props。
 * 通过桌面 IPC 桥调 /api/mcpManager/* RPC 端点。
 * @module @corum/dev-agent-shell/client/McpManagerPanel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Check, ChevronDown, CircleAlert, FileJson, Pencil, Plus, RefreshCw, Trash2,
  Wrench, X,
} from 'lucide-react'
import css from './McpManagerPanel.module.css'

// ── RPC 类型（镜像 @corum/dev-mcp-manager 的 types.ts） ────────────

interface McpServerSummary {
  name: string
  description?: string
  transport: 'stdio' | 'streamable-http'
  endpoint: string
  disabled?: boolean
}

interface McpStdioServer {
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

interface McpHttpServer {
  name: string
  description?: string
  transport: 'streamable-http'
  url: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  disabled?: boolean
}

type McpServerConfig = McpStdioServer | McpHttpServer

interface McpToolSummary {
  name: string
  description?: string
}

type TestConnectionResult =
  | { ok: true; tools: McpToolSummary[] }
  | { ok: false; error: string }

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

async function callRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `mcpManager/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/mcpManager/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`mcpManager/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { type: string; rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error('rpcId mismatch')
  if (!envelope.result.ok) throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`)
  return envelope.result.value
}

// ── 连接状态 ──────────────────────────────────────────────────────

type ProbeState =
  | { status: 'unknown' }
  | { status: 'testing' }
  | { status: 'online'; tools: McpToolSummary[] }
  | { status: 'error'; error: string }

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

// ── key-value 行编辑器 ────────────────────────────────────────────

interface KvPair {
  key: string
  value: string
}

function kvFromRecord(record: Record<string, string> | undefined): KvPair[] {
  if (record === undefined) return []
  return Object.entries(record).map(([key, value]) => ({ key, value }))
}

function kvToRecord(pairs: readonly KvPair[]): Record<string, string> | undefined {
  const record: Record<string, string> = {}
  for (const p of pairs) {
    if (p.key.trim() !== '') record[p.key.trim()] = p.value
  }
  return Object.keys(record).length > 0 ? record : undefined
}

function KvEditor({ pairs, onChange, keyPlaceholder, valuePlaceholder }: {
  pairs: readonly KvPair[]
  onChange: (pairs: KvPair[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
}): ReactNode {
  return (
    <div className={css.kvEditor}>
      {pairs.map((pair, index) => (
        <div key={index} className={css.kvRow}>
          <input
            className={css.fieldInput}
            value={pair.key}
            placeholder={keyPlaceholder}
            onChange={e => {
              const next = pairs.slice()
              next[index] = { key: e.target.value, value: pair.value }
              onChange(next)
            }}
          />
          <input
            className={css.fieldInput}
            value={pair.value}
            placeholder={valuePlaceholder}
            onChange={e => {
              const next = pairs.slice()
              next[index] = { key: pair.key, value: e.target.value }
              onChange(next)
            }}
          />
          <button
            type="button"
            className={`${css.iconBtn} ${css.kvRemove}`}
            title="删除此行"
            onClick={() => { onChange(pairs.filter((_, i) => i !== index)) }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={css.kvAdd}
        onClick={() => { onChange([...pairs, { key: '', value: '' }]) }}
      >
        <Plus size={11} /> 添加一行
      </button>
    </div>
  )
}

// ── 编辑弹窗草稿 ──────────────────────────────────────────────────

interface ServerDraft {
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

function emptyDraft(): ServerDraft {
  return {
    name: '', description: '', transport: 'stdio', command: '', args: '',
    env: [], cwd: '', url: '', headers: [], toolCallTimeoutMs: '', disabled: false,
  }
}

function draftFromServer(s: McpServerConfig): ServerDraft {
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

function draftToConfig(d: ServerDraft): McpServerConfig {
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

interface ParsedImport {
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
function normalizeServerName(raw: string): string | null {
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
function parseImportJson(text: string): ParsedImport[] {
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

interface Toast {
  level: 'info' | 'error' | 'success'
  message: string
}

// ── 弹窗通用外壳 ──────────────────────────────────────────────────

function Dialog({ title, size, onClose, children, footer }: {
  title: string
  size?: 'sm'
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])
  return createPortal(
    <div
      className={css.overlay}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={css.dialog} {...(size !== undefined ? { 'data-size': size } : {})}>
        <div className={css.dialogHeader}>
          <span className={css.dialogTitle}>{title}</span>
          <button type="button" className={css.iconBtn} title="关闭" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className={css.dialogBody}>{children}</div>
        <div className={css.dialogFooter}>{footer}</div>
      </div>
    </div>,
    document.body,
  )
}

// ── 编辑弹窗 ──────────────────────────────────────────────────────

function ServerEditorDialog({ initial, editing, onClose, onSaved, toast }: {
  /** 编辑模式回填的初始草稿。 */
  initial: ServerDraft
  /** 是否为编辑（服务名只读）。 */
  editing: boolean
  onClose: () => void
  onSaved: (name: string) => Promise<void>
  toast: (level: Toast['level'], message: string) => void
}): ReactNode {
  const [draft, setDraft] = useState<ServerDraft>(initial)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const onSave = useCallback(async () => {
    if (draft.name.trim() === '') { setFormError('服务名不能为空'); return }
    if (!NAME_PATTERN.test(draft.name.trim())) {
      setFormError('服务名仅允许字母/数字/_/-，1-32 字符'); return
    }
    if (draft.transport === 'stdio' && draft.command.trim() === '') {
      setFormError('stdio 模式需要填写命令'); return
    }
    if (draft.transport === 'streamable-http' && draft.url.trim() === '') {
      setFormError('streamable-http 模式需要填写 URL'); return
    }
    setFormError(null)
    setSaving(true)
    try {
      await callRemote('saveServer', { input: draftToConfig(draft) })
      toast('success', `MCP 服务 "${draft.name}" 已保存`)
      await onSaved(draft.name.trim())
      onClose()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [draft, onClose, onSaved, toast])

  const onImportFill = useCallback(() => {
    try {
      const parsed = parseImportJson(importText)
      const first = parsed[0]
      setDraft(draftFromServer(first.config))
      setImporting(false)
      setImportError(null)
      setImportText('')
      toast('success', first.originalName !== undefined
        ? `已回填配置，服务名规范化为 "${first.name}"（原名 "${first.originalName}"）`
        : `已回填 "${first.name}" 的配置`)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
    }
  }, [importText, toast])

  return (
    <Dialog
      title={editing ? `编辑服务 — ${initial.name}` : '添加 MCP 服务'}
      onClose={onClose}
      footer={
        <>
          <div className={css.dialogFooterLeft}>
            <button
              type="button"
              className={css.btn}
              onClick={() => { setImporting(v => !v); setImportError(null) }}
            >
              <FileJson size={13} /> 从 JSON 导入
            </button>
          </div>
          <button type="button" className={css.btn} onClick={onClose}>取消</button>
          <button
            type="button"
            className={css.btnPrimary}
            disabled={saving}
            onClick={() => { void onSave() }}
          >
            {saving ? <RefreshCw size={13} className={css.spinning} /> : <Check size={13} />}
            {editing ? '保存修改' : '添加服务'}
          </button>
        </>
      }
    >
      {importing && (
        <>
          <div className={css.field}>
            <span className={css.fieldLabel}>粘贴配置 JSON（mcpServers 片段或单个服务）</span>
            <textarea
              className={css.fieldTextarea}
              rows={6}
              value={importText}
              placeholder={'{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"],\n      "env": { "GITHUB_TOKEN": "ghp_xxx" }\n    }\n  }\n}'}
              onChange={e => { setImportText(e.target.value) }}
            />
            {importError !== null && <span className={css.fieldError}>{importError}</span>}
          </div>
          <div>
            <button
              type="button"
              className={css.btn}
              disabled={importText.trim() === ''}
              onClick={onImportFill}
            >
              解析并回填表单
            </button>
          </div>
        </>
      )}

      <div className={css.fieldRow}>
        <div className={css.field}>
          <span className={css.fieldLabel} data-required>服务名</span>
          <input
            className={css.fieldInput}
            value={draft.name}
            placeholder="如 github, filesystem"
            disabled={editing}
            onChange={e => { setDraft(d => ({ ...d, name: e.target.value })) }}
          />
          {editing && <span className={css.fieldHint}>编辑时不可改名（引用完整性）</span>}
        </div>
        <div className={css.field}>
          <span className={css.fieldLabel}>传输方式</span>
          <select
            className={css.fieldSelect}
            value={draft.transport}
            onChange={e => { setDraft(d => ({ ...d, transport: e.target.value as 'stdio' | 'streamable-http' })) }}
          >
            <option value="stdio">stdio（子进程）</option>
            <option value="streamable-http">streamable-http</option>
          </select>
        </div>
      </div>

      <div className={css.field}>
        <span className={css.fieldLabel}>描述</span>
        <input
          className={css.fieldInput}
          value={draft.description}
          placeholder="可选"
          onChange={e => { setDraft(d => ({ ...d, description: e.target.value })) }}
        />
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <div className={css.field}>
            <span className={css.fieldLabel} data-required>命令</span>
            <input
              className={css.fieldInput}
              value={draft.command}
              placeholder="如 npx, node, uvx"
              onChange={e => { setDraft(d => ({ ...d, command: e.target.value })) }}
            />
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>参数（每行一个）</span>
            <textarea
              className={css.fieldTextarea}
              rows={3}
              value={draft.args}
              placeholder={'-y\n@modelcontextprotocol/server-github'}
              onChange={e => { setDraft(d => ({ ...d, args: e.target.value })) }}
            />
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>环境变量</span>
            <KvEditor
              pairs={draft.env}
              onChange={env => { setDraft(d => ({ ...d, env })) }}
              keyPlaceholder="KEY"
              valuePlaceholder="VALUE"
            />
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>工作目录</span>
            <input
              className={css.fieldInput}
              value={draft.cwd}
              placeholder="可选，子进程 cwd"
              onChange={e => { setDraft(d => ({ ...d, cwd: e.target.value })) }}
            />
          </div>
        </>
      ) : (
        <>
          <div className={css.field}>
            <span className={css.fieldLabel} data-required>URL</span>
            <input
              className={css.fieldInput}
              value={draft.url}
              placeholder="http://localhost:3000/mcp"
              onChange={e => { setDraft(d => ({ ...d, url: e.target.value })) }}
            />
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>请求头</span>
            <KvEditor
              pairs={draft.headers}
              onChange={headers => { setDraft(d => ({ ...d, headers })) }}
              keyPlaceholder="Header"
              valuePlaceholder="Value"
            />
          </div>
        </>
      )}

      <div className={css.field}>
        <span className={css.fieldLabel}>工具调用超时（ms）</span>
        <input
          className={css.fieldInput}
          value={draft.toolCallTimeoutMs}
          placeholder="默认 60000"
          onChange={e => { setDraft(d => ({ ...d, toolCallTimeoutMs: e.target.value })) }}
        />
      </div>

      <div className={css.toggleField}>
        <div>
          <div className={css.toggleFieldLabel}>停用此服务</div>
          <div className={css.toggleFieldHint}>停用后不会编译进 Agent preset，也不会自动探测</div>
        </div>
        <button
          type="button"
          className={css.toggle}
          {...(draft.disabled ? { 'data-on': true } : {})}
          onClick={() => { setDraft(d => ({ ...d, disabled: !d.disabled })) }}
        />
      </div>

      {formError !== null && <span className={css.fieldError}>{formError}</span>}
    </Dialog>
  )
}

// ── 删除确认弹窗 ──────────────────────────────────────────────────

function DeleteConfirmDialog({ name, onClose, onDeleted, toast }: {
  name: string
  onClose: () => void
  onDeleted: () => Promise<void>
  toast: (level: Toast['level'], message: string) => void
}): ReactNode {
  const [references, setReferences] = useState<string[] | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    callRemote<{ references: string[] }>('getServerReferences', { name })
      .then(r => { if (!cancelled) setReferences(r.references) })
      .catch(() => { if (!cancelled) setReferences([]) })
    return () => { cancelled = true }
  }, [name])

  const onDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await callRemote('deleteServer', { name })
      toast('success', `MCP 服务 "${name}" 已删除`)
      await onDeleted()
      onClose()
    } catch (error) {
      toast('error', `删除失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDeleting(false)
    }
  }, [name, onClose, onDeleted, toast])

  return (
    <Dialog
      title="删除 MCP 服务"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={css.btn} onClick={onClose}>取消</button>
          <button
            type="button"
            className={css.btnDanger}
            disabled={deleting || references === null}
            onClick={() => { void onDelete() }}
          >
            <Trash2 size={13} /> 确认删除
          </button>
        </>
      }
    >
      <p className={css.confirmText}>
        确定要删除服务 <strong>{name}</strong> 吗？此操作不可撤销。
      </p>
      {references !== null && references.length > 0 && (
        <div className={css.confirmWarn}>
          <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            以下 AgentProfile 正在引用该服务：{references.join('、')}。
            删除后这些 Profile 编译时将跳过该服务。
          </span>
        </div>
      )}
    </Dialog>
  )
}

// ── 全局 JSON 导入弹窗（批量） ────────────────────────────────────

function ImportDialog({ existing, onClose, onImported, toast }: {
  existing: readonly string[]
  onClose: () => void
  onImported: (imported: readonly string[]) => Promise<void>
  toast: (level: Toast['level'], message: string) => void
}): ReactNode {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedImport[] | null>(null)
  const [importing, setImporting] = useState(false)

  const onParse = useCallback(() => {
    try {
      const result = parseImportJson(text)
      setParsed(result)
      setError(null)
    } catch (e) {
      setParsed(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [text])

  const onImportAll = useCallback(async () => {
    if (parsed === null) return
    setImporting(true)
    const imported: string[] = []
    try {
      for (const item of parsed) {
        await callRemote('saveServer', { input: item.config })
        imported.push(item.name)
      }
      toast('success', `已导入 ${imported.length} 个 MCP 服务`)
      await onImported(imported)
      onClose()
    } catch (e) {
      toast('error', `导入失败 — ${e instanceof Error ? e.message : String(e)}`)
      if (imported.length > 0) await onImported(imported)
    } finally {
      setImporting(false)
    }
  }, [parsed, onClose, onImported, toast])

  return (
    <Dialog
      title="从 JSON 导入"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={css.btn} onClick={onClose}>取消</button>
          {parsed === null ? (
            <button
              type="button"
              className={css.btnPrimary}
              disabled={text.trim() === ''}
              onClick={onParse}
            >
              解析
            </button>
          ) : (
            <button
              type="button"
              className={css.btnPrimary}
              disabled={importing}
              onClick={() => { void onImportAll() }}
            >
              {importing
                ? <RefreshCw size={13} className={css.spinning} />
                : <Check size={13} />}
              导入全部（{parsed.length}）
            </button>
          )}
        </>
      }
    >
      <div className={css.field}>
        <span className={css.fieldLabel}>
          粘贴 claude_desktop_config 的 mcpServers 片段，或单个服务配置
        </span>
        <textarea
          className={css.fieldTextarea}
          rows={8}
          value={text}
          placeholder={'{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"]\n    },\n    "remote": {\n      "url": "http://localhost:3000/mcp"\n    }\n  }\n}'}
          onChange={e => { setText(e.target.value); setParsed(null) }}
        />
        {error !== null && <span className={css.fieldError}>{error}</span>}
      </div>
      {parsed !== null && (
        <div className={css.importPreview}>
          <span className={css.importPreviewTitle}>将导入 {parsed.length} 个服务：</span>
          {parsed.map(item => (
            <div key={item.name} className={css.importItem}>
              <span className={css.importItemName}>{item.name}</span>
              <span className={css.importItemMeta}>
                {item.originalName !== undefined ? `原名 "${item.originalName}" · ` : ''}
                {item.config.transport}
                {' · '}
                {item.config.transport === 'stdio' ? item.config.command : item.config.url}
                {existing.includes(item.name) ? '（将覆盖同名服务）' : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  )
}

// ── 服务卡片 ──────────────────────────────────────────────────────

function ServerCard({ server, probe, expanded, busy, onToggleExpand, onToggleEnabled, onRetest, onEdit, onDelete }: {
  server: McpServerSummary
  probe: ProbeState | undefined
  expanded: boolean
  busy: boolean
  onToggleExpand: () => void
  onToggleEnabled: () => void
  onRetest: () => void
  onEdit: () => void
  onDelete: () => void
}): ReactNode {
  const disabled = server.disabled === true
  const status = disabled ? 'unknown' : (probe?.status ?? 'unknown')
  const statusTitle = disabled
    ? '已停用'
    : status === 'online'
      ? `在线 · ${probe?.status === 'online' ? probe.tools.length : 0} 个工具`
      : status === 'error'
        ? `连接失败：${probe?.status === 'error' ? probe.error : ''}`
        : status === 'testing' ? '探测中…' : '未探测'

  return (
    <div className={css.card} {...(disabled ? { 'data-disabled': true } : {})}>
      <div className={css.cardMain} role="button" tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleExpand() } }}
      >
        <span className={css.statusDot} data-status={status} title={statusTitle} />
        <div className={css.cardBody}>
          <div className={css.cardHead}>
            <span className={css.cardName}>{server.name}</span>
            <span className={css.transportBadge}>{server.transport}</span>
            {probe?.status === 'online' && (
              <span className={css.toolsCount}>{probe.tools.length} tools</span>
            )}
          </div>
          {server.description !== undefined && (
            <span className={css.cardDesc}>{server.description}</span>
          )}
          <span className={css.cardEndpoint}>{server.endpoint}</span>
        </div>
        <div className={css.cardActions} onClick={e => { e.stopPropagation() }}>
          <button
            type="button"
            className={css.toggle}
            title={disabled ? '启用' : '停用'}
            disabled={busy}
            {...(!disabled ? { 'data-on': true } : {})}
            onClick={onToggleEnabled}
          />
          <button
            type="button"
            className={css.iconBtn}
            title="重新探测"
            disabled={busy || disabled || status === 'testing'}
            onClick={onRetest}
          >
            <RefreshCw size={13} className={status === 'testing' ? css.spinning : undefined} />
          </button>
          <button type="button" className={css.iconBtn} title="编辑" disabled={busy} onClick={onEdit}>
            <Pencil size={13} />
          </button>
          <button
            type="button"
            className={css.iconBtn}
            data-danger
            title="删除"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 size={13} />
          </button>
        </div>
        <ChevronDown size={14} className={css.cardChevron} {...(expanded ? { 'data-expanded': true } : {})} />
      </div>

      {expanded && (
        <div className={css.cardTools}>
          {disabled && <div className={css.toolsEmpty}>已停用 — 启用后可探测连接并查看工具。</div>}
          {!disabled && probe?.status === 'online' && probe.tools.length === 0 && (
            <div className={css.toolsEmpty}>已连接，但该服务未暴露任何工具。</div>
          )}
          {!disabled && probe?.status === 'online' && probe.tools.map(t => (
            <div key={t.name} className={css.toolRow}>
              <span className={css.toolName}>{t.name}</span>
              {t.description !== undefined && <span className={css.toolDesc}>{t.description}</span>}
            </div>
          ))}
          {!disabled && (probe === undefined || probe.status === 'unknown') && (
            <div className={css.toolsEmpty}>尚未探测。点击 <RefreshCw size={10} style={{ verticalAlign: '-1px' }} /> 重新探测查看工具列表。</div>
          )}
          {!disabled && probe?.status === 'testing' && (
            <div className={css.toolsEmpty}>正在探测连接…</div>
          )}
          {!disabled && probe?.status === 'error' && (
            <div className={css.toolsEmpty}>连接失败，修正配置后重新探测。</div>
          )}
        </div>
      )}
      {expanded && probe?.status === 'error' && !disabled && (
        <div className={css.cardError}>{probe.error}</div>
      )}
    </div>
  )
}

// ── 主面板 ────────────────────────────────────────────────────────

export function McpManagerPanel(): ReactNode {
  const [servers, setServers] = useState<readonly McpServerSummary[]>([])
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [toastState, setToastState] = useState<Toast | null>(null)
  const [editor, setEditor] = useState<{ draft: ServerDraft; editing: boolean } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toast = useCallback((level: Toast['level'], message: string) => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    setToastState({ level, message })
    toastTimer.current = setTimeout(() => { setToastState(null) }, 3200)
  }, [])

  const probeOne = useCallback(async (name: string) => {
    setProbes(p => ({ ...p, [name]: { status: 'testing' } }))
    try {
      const result = await callRemote<TestConnectionResult>('testConnection', { name })
      setProbes(p => ({
        ...p,
        [name]: result.ok
          ? { status: 'online', tools: result.tools }
          : { status: 'error', error: result.error },
      }))
    } catch (error) {
      setProbes(p => ({
        ...p,
        [name]: { status: 'error', error: error instanceof Error ? error.message : String(error) },
      }))
    }
  }, [])

  const refresh = useCallback(async (opts?: { probe?: boolean }) => {
    try {
      const { servers: list } = await callRemote<{ servers: McpServerSummary[] }>('listServers', {})
      setServers(list)
      // 清理已删除服务的探测/展开状态
      setProbes(p => Object.fromEntries(Object.entries(p).filter(([k]) => list.some(s => s.name === k))))
      if (opts?.probe === true) {
        for (const s of list) {
          if (s.disabled !== true) void probeOne(s.name)
        }
      }
    } catch (error) {
      toast('error', `加载失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoading(false)
    }
  }, [probeOne, toast])

  useEffect(() => { void refresh({ probe: true }) }, [refresh])

  // ── 操作 ──

  const onToggleEnabled = useCallback(async (server: McpServerSummary) => {
    const nextDisabled = server.disabled !== true
    try {
      const { server: full } = await callRemote<{ server?: McpServerConfig }>('getServer', { name: server.name })
      if (full === undefined) throw new Error('服务不存在')
      await callRemote('saveServer', {
        input: { ...full, ...(nextDisabled ? { disabled: true } : { disabled: false }) },
      })
      if (nextDisabled) {
        setProbes(p => ({ ...p, [server.name]: { status: 'unknown' } }))
      } else {
        void probeOne(server.name)
      }
      await refresh()
    } catch (error) {
      toast('error', `切换失败 — ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [probeOne, refresh, toast])

  const onEdit = useCallback(async (name: string) => {
    try {
      const { server } = await callRemote<{ server?: McpServerConfig }>('getServer', { name })
      if (server === undefined) throw new Error('服务不存在')
      setEditor({ draft: draftFromServer(server), editing: true })
    } catch (error) {
      toast('error', `读取配置失败 — ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [toast])

  const onSaved = useCallback(async (name: string) => {
    await refresh()
    void probeOne(name)
  }, [probeOne, refresh])

  const onImported = useCallback(async (imported: readonly string[]) => {
    await refresh()
    for (const name of imported) void probeOne(name)
  }, [probeOne, refresh])

  const onDeleted = useCallback(async () => {
    await refresh()
  }, [refresh])

  const onRefreshAll = useCallback(async () => {
    await refresh({ probe: true })
    toast('info', '已刷新并重新探测全部服务')
  }, [refresh, toast])

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <span className={css.toolbarTitle}>
          <Wrench size={14} /> MCP 服务
          <span className={css.toolbarCount}>{servers.length}</span>
        </span>
        <div className={css.toolbarActions}>
          <button type="button" className={css.btn} onClick={() => { setImportOpen(true) }}>
            <FileJson size={13} /> 从 JSON 导入
          </button>
          <button
            type="button"
            className={css.btn}
            disabled={loading}
            title="刷新列表并重新探测全部服务"
            onClick={() => { void onRefreshAll() }}
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className={css.btnPrimary}
            onClick={() => { setEditor({ draft: emptyDraft(), editing: false }) }}
          >
            <Plus size={13} /> 添加服务
          </button>
        </div>
      </div>

      <div className={css.list}>
        {!loading && servers.length === 0 && (
          <div className={css.empty}>
            <Wrench size={32} className={css.emptyIcon} />
            <span className={css.emptyTitle}>还没有 MCP 服务</span>
            <span className={css.emptyHint}>
              添加你的第一个 MCP 服务，或粘贴
              <code>claude_desktop_config</code>
              中的 <code>mcpServers</code> 片段一键导入。
            </span>
            <div className={css.emptyActions}>
              <button
                type="button"
                className={css.btnPrimary}
                onClick={() => { setEditor({ draft: emptyDraft(), editing: false }) }}
              >
                <Plus size={13} /> 添加服务
              </button>
              <button type="button" className={css.btn} onClick={() => { setImportOpen(true) }}>
                <FileJson size={13} /> 从 JSON 导入
              </button>
            </div>
          </div>
        )}
        {servers.map(s => (
          <ServerCard
            key={s.name}
            server={s}
            probe={probes[s.name]}
            expanded={expanded[s.name] === true}
            busy={false}
            onToggleExpand={() => { setExpanded(e => ({ ...e, [s.name]: e[s.name] !== true })) }}
            onToggleEnabled={() => { void onToggleEnabled(s) }}
            onRetest={() => { void probeOne(s.name) }}
            onEdit={() => { void onEdit(s.name) }}
            onDelete={() => { setDeleting(s.name) }}
          />
        ))}
      </div>

      {toastState !== null && (
        <div className={css.toastBar} data-level={toastState.level}>
          {toastState.message}
        </div>
      )}

      {editor !== null && (
        <ServerEditorDialog
          initial={editor.draft}
          editing={editor.editing}
          onClose={() => { setEditor(null) }}
          onSaved={onSaved}
          toast={toast}
        />
      )}
      {importOpen && (
        <ImportDialog
          existing={servers.map(s => s.name)}
          onClose={() => { setImportOpen(false) }}
          onImported={onImported}
          toast={toast}
        />
      )}
      {deleting !== null && (
        <DeleteConfirmDialog
          name={deleting}
          onClose={() => { setDeleting(null) }}
          onDeleted={onDeleted}
          toast={toast}
        />
      )}
    </div>
  )
}
