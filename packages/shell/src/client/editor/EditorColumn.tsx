/**
 * EditorColumn — the resident right-hand code editor in IDE mode.
 *
 * Registered into the `corum.editor` slot (a root-scope single slot declared
 * ONLY by @corum/corum-layout, which is itself only inserted in IDE mode), so
 * the editor is a resident column — not a session tab — and disappears
 * entirely in minimal mode (the slot is never declared, so this registration
 * never fires). Phase 1 renders a read-only demo file to prove the Monaco
 * load + worker + render chain inside the desktop shell; Phase 2 wires the
 * file-tree + open-file handoff + edit/save/approval.
 * @module corum-shell/client/editor/EditorColumn
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `corum.editor` SlotMap row (declared by @corum/ide-shell,
// IDE mode only). EditorColumn is parked for S0 (not registered — the shell
// fills the column with a test card) and re-registers at S1; the type import
// keeps this file compiling standalone without a runtime dependency.
import type {} from '@corum/ide-shell/client'
import { MonacoEditor, type MonacoFileModel } from './MonacoEditor.tsx'

/** Phase 1 demo file: proves the whole render chain without host file I/O. */
const DEMO_FILE: MonacoFileModel = {
  path: 'corum-shell-demo.ts',
  language: 'typescript',
  value: [
    '// corum-shell Monaco editor (IDE resident column)',
    '// ✅ 已从 conversation.view 迁移到常驻 corum.editor 列',
    '//',
    '// This column proves the desktop shell can load Monaco,',
    '// its language workers, and render a code model end to end.',
    '',
    'export function greet(name: string): string {',
    '  const message = `hello, ${name}`',
    '  return message',
    '}',
    '',
    'greet("corum")',
  ].join('\n'),
}

/** Full composed props of the root-scope editor slot (no owner/inject/store). */
export type EditorColumnProps = PropsRuntime<'corum.editor'>

/**
 * Render the resident editor column. Phase 1 is read-only and static: a slim
 * file header + the Monaco surface.
 * @param _props - the composed root-slot props (unused in Phase 1).
 * @returns the editor column surface.
 */
export function EditorColumn(_props: EditorColumnProps): React.ReactElement {
  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      data-code-editor-column=""
    >
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          height: 36,
          padding: '0 14px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          fontSize: 12,
          color: 'var(--dsw-alias-label-secondary)',
        }}
      >
        {DEMO_FILE.path}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MonacoEditor file={DEMO_FILE} theme="vs-dark" className="corum-code-editor" />
      </div>
    </div>
  )
}
