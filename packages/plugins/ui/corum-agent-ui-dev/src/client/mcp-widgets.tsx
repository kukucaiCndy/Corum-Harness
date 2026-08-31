/**
 * mcp-widgets —— McpManagerPanel 的通用小部件（从 McpManagerPanel.tsx 拆出，包内文件拆分）。
 *
 * 两个跨弹窗共享的展示组件：
 *   - KvEditor：env/headers 的 key-value 行编辑器（增删行 + 双向 onChange）；
 *   - Dialog：模态弹窗通用外壳（portal 挂 body、Escape 关闭、点遮罩关闭）。
 * 经 props 收数据与回调，不碰 RPC。
 * @module @corum/corum-agent-ui-dev/mcp-widgets
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X } from 'lucide-react'
import type { KvPair } from './mcp-model.ts'
import css from './McpManagerPanel.module.css'

// ── key-value 行编辑器 ────────────────────────────────────────────

export function KvEditor({ pairs, onChange, keyPlaceholder, valuePlaceholder }: {
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

// ── 弹窗通用外壳 ──────────────────────────────────────────────────

export function Dialog({ title, size, onClose, children, footer }: {
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
