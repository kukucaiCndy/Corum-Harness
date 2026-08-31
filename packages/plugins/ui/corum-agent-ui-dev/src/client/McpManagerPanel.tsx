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
 * 组件自包含：自理 RPC 数据流；mcpManager 命名空间的 RPC caller 由宿主
 * apply 注入（0.1.2 起走官方 connection.rpc，旧 corumDesktop.unary 已退役）。
 * @module @corum/corum-agent-ui-dev/client/McpManagerPanel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Check, ChevronDown, CircleAlert, FileJson, Pencil, Plus, RefreshCw, Trash2,
  Wrench, X,
} from 'lucide-react'
import {
  emptyDraft, draftFromServer,
} from './mcp-model.ts'
import type {
  McpServerSummary, McpToolSummary, ProbeState, TestConnectionResult, Toast,
  ServerDraft, McpServerConfig,
} from './mcp-model.ts'
import { ServerEditorDialog, DeleteConfirmDialog, ImportDialog } from './mcp-dialogs.tsx'
import css from './McpManagerPanel.module.css'

/** 面板对外依赖：mcpManager 命名空间的 RPC caller。 */
export interface McpManagerPanelProps {
  readonly callRemote: <T>(method: string, args: Record<string, unknown>) => Promise<T>
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

export function McpManagerPanel({ callRemote }: McpManagerPanelProps): ReactNode {
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
  }, [callRemote])

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
  }, [probeOne, toast, callRemote])

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
  }, [probeOne, refresh, toast, callRemote])

  const onEdit = useCallback(async (name: string) => {
    try {
      const { server } = await callRemote<{ server?: McpServerConfig }>('getServer', { name })
      if (server === undefined) throw new Error('服务不存在')
      setEditor({ draft: draftFromServer(server), editing: true })
    } catch (error) {
      toast('error', `读取配置失败 — ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [toast, callRemote])

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
          callRemote={callRemote}
        />
      )}
      {importOpen && (
        <ImportDialog
          existing={servers.map(s => s.name)}
          onClose={() => { setImportOpen(false) }}
          onImported={onImported}
          toast={toast}
          callRemote={callRemote}
        />
      )}
      {deleting !== null && (
        <DeleteConfirmDialog
          name={deleting}
          onClose={() => { setDeleting(null) }}
          onDeleted={onDeleted}
          toast={toast}
          callRemote={callRemote}
        />
      )}
    </div>
  )
}
