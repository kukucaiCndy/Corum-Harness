/**
 * mcp-dialogs —— McpManagerPanel 的弹窗组（从 McpManagerPanel.tsx 拆出，包内文件拆分）。
 *
 * 三个业务弹窗（自理各自 RPC 调用，caller 由主面板经 props 注入）：
 *   - ServerEditorDialog：添加/编辑服务（draft 三态 + JSON 导入回填 + KvEditor）；
 *   - DeleteConfirmDialog：删除确认（提示引用该服务的 AgentProfile）；
 *   - ImportDialog：claude_desktop_config 风格 JSON 批量导入。
 * @module @corum/corum-agent-ui-dev/mcp-dialogs
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Check, CircleAlert, FileJson, RefreshCw, Trash2,
} from 'lucide-react'
import {
  NAME_PATTERN, draftFromServer, draftToConfig, parseImportJson,
} from './mcp-model.ts'
import type { ParsedImport, ServerDraft, Toast } from './mcp-model.ts'
import { Dialog, KvEditor } from './mcp-widgets.tsx'
import type { McpManagerPanelProps } from './McpManagerPanel.tsx'
import css from './McpManagerPanel.module.css'

// ── 编辑弹窗 ──────────────────────────────────────────────────────

export function ServerEditorDialog({ initial, editing, onClose, onSaved, toast, callRemote }: {
  /** 编辑模式回填的初始草稿。 */
  initial: ServerDraft
  /** 是否为编辑（服务名只读）。 */
  editing: boolean
  onClose: () => void
  onSaved: (name: string) => Promise<void>
  toast: (level: Toast['level'], message: string) => void
  callRemote: McpManagerPanelProps['callRemote']
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
  }, [draft, onClose, onSaved, toast, callRemote])

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

export function DeleteConfirmDialog({ name, onClose, onDeleted, toast, callRemote }: {
  name: string
  onClose: () => void
  onDeleted: () => Promise<void>
  toast: (level: Toast['level'], message: string) => void
  callRemote: McpManagerPanelProps['callRemote']
}): ReactNode {
  const [references, setReferences] = useState<string[] | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    callRemote<{ references: string[] }>('getServerReferences', { name })
      .then(r => { if (!cancelled) setReferences(r.references) })
      .catch(() => { if (!cancelled) setReferences([]) })
    return () => { cancelled = true }
  }, [name, callRemote])

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
  }, [name, onClose, onDeleted, toast, callRemote])

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

export function ImportDialog({ existing, onClose, onImported, toast, callRemote }: {
  existing: readonly string[]
  onClose: () => void
  onImported: (imported: readonly string[]) => Promise<void>
  toast: (level: Toast['level'], message: string) => void
  callRemote: McpManagerPanelProps['callRemote']
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
  }, [parsed, onClose, onImported, toast, callRemote])

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
