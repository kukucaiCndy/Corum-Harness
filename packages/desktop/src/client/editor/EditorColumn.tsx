/**
 * EditorColumn — the resident right-hand code editor in IDE mode (design.pen
 * ③ 编辑器区, 430px, 浅 sswc6 / 深 KTXnd). Registered into the `corum.editor`
 * slot (a root-scope single slot declared ONLY by @corum/corum-ide-ui, IDE mode
 * only), so the editor is a resident column — not a session tab — and
 * disappears entirely in minimal mode.
 *
 * Structure follows the design frame's children order: Editor Tabs (nT1EK:
 * tab-file ×2 + spacer + detach) → crumb (Ji9cT) → Code (NIgux: Monaco) →
 * Editor Status (wsYCi: 行/编码/语言 + dirty). Styles live in
 * EditorColumn.module.css (design tokens only, no inline hex); the Monaco theme
 * flips with the global light/dark theme (body[data-ds-dark-theme]).
 * @module corum-desktop/client/editor/EditorColumn
 */

import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Monitor, X } from 'lucide-react'
// Type-only: pulls the `corum.editor` SlotMap row (declared by @corum/corum-ide-ui,
// IDE mode only). The type import keeps this file compiling standalone without
// a runtime dependency on the shell plugin.
import type {} from '@corum/corum-ide-ui/client'
import { MonacoEditor, type MonacoFileModel } from './MonacoEditor.tsx'
import css from './EditorColumn.module.css'

/** Design-file demo content: mirrors the design's Code frame lines 1–7. */
const DEMO_FILE: MonacoFileModel = {
  path: 'docs/backend-requirements.md',
  language: 'markdown',
  value: [
    '矩道 Corum Harness',
    '## 1. 液态玻璃主题',
    '',
    '**优先级**: P0',
    'Set-Cookie: token=<jwt>;',
    'HttpOnly; Secure; SameSite=Strict;',
    'Path=/api; Max-Age=86400',
  ].join('\n'),
}

/** 本插件的注入面（见 client/index.ts apply：closeRegion 直通 ctx.layout.closeRegion）。 */
export interface EditorColumnInjected {
  /** 关闭本区域（隐藏叶子，可在插件中心「视图管理」恢复）。 */
  closeRegion: () => void
}

/** Full composed props of the root-scope editor slot (owner share + 本插件注入面). */
export type EditorColumnProps = PropsRuntime<'corum.editor'> & EditorColumnInjected

/** Open files as the design's editor tab strip (tab-file rows). */
const OPEN_TABS = [
  { title: 'requirements.md', active: true, dirty: true },
  { title: 'columns.ts', active: false, dirty: false },
]

/** Track the global light/dark theme via body[data-ds-dark-theme]. */
function useDarkTheme(): boolean {
  const [dark, setDark] = useState<boolean>(
    () => document.body.hasAttribute('data-ds-dark-theme'),
  )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.body.hasAttribute('data-ds-dark-theme'))
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/** The resident editor column (see module doc). */
export function EditorColumn({ closeRegion }: EditorColumnProps): React.ReactElement {
  const dark = useDarkTheme()
  return (
    <div className={css.column} data-code-editor-column="">
      {/* nT1EK — Editor Tabs（gap6 · pad[10,10,6,10]） */}
      <div className={css.tabs}>
        {OPEN_TABS.map((tab) => (
          <div
            key={tab.title}
            className={`${css.tab}${tab.active ? ` ${css.tabActive}` : ''}`}
            data-tab-active={tab.active || undefined}
          >
            {tab.dirty && <span className={css.tabDirty} />}
            <span className={css.tabTitle}>{tab.title}</span>
            <X size={13} strokeWidth={2} className={css.tabClose} />
          </div>
        ))}
        <div className={css.spacer} />
        {/* detach（26×26 r8 glass-2，icon-monitor） */}
        <button type="button" title="拖出独立窗口" className={css.detach}>
          <Monitor size={13} strokeWidth={2} />
        </button>
        {/* 区域关闭按钮：固定在编辑器区右上角，与 detach 并排。 */}
        <button
          type="button"
          title="关闭此区域（可在插件中心「视图管理」恢复）"
          className={css.detach}
          onClick={closeRegion}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      {/* Ji9cT — crumb（pad[0,14,8,14]） */}
      <div className={css.crumb}>docs › backend-requirements.md</div>

      {/* NIgux — Code（Monaco，flex:1；主题随深浅翻转） */}
      <div className={css.code}>
        <MonacoEditor file={DEMO_FILE} dark={dark} className="corum-code-editor" />
      </div>

      {/* wsYCi — Editor Status（pad[6,14,8,14] gap10） */}
      <div className={css.status}>
        <span>行 7, 列 1</span>
        <span>UTF-8</span>
        <span>Markdown</span>
        <div className={css.statusSpacer} />
        <span className={css.dirtyDot} />
        <span className={css.dirtyText}>未保存</span>
      </div>
    </div>
  )
}
