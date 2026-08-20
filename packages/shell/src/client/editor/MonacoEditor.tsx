/**
 * MonacoEditor — the corum-shell desktop code editor surface.
 *
 * A thin React wrapper around the Monaco standalone editor, tuned for the
 * desktop shell: the worker environment is installed once (see ./worker.ts),
 * the editor is created on mount against a DOM node, and the model/theme are
 * driven by props. Phase 1 is read-only; edit + save + approval land in Phase 2.
 *
 * Language contributions are imported for their side effects (registering
 * tokenizers/features) via the `monaco.contribution.js` subpath of each
 * language. The editor API itself comes from
 * `monaco-editor/esm/vs/editor/editor.api`,
 * NOT the full `monaco-editor` index (which pulls every language + the LSP
 * client, inflating the bundle far beyond what a desktop code view needs).
 * @module corum-shell/client/editor/MonacoEditor
 */

import { useEffect, useRef } from 'react'
import { editor } from 'monaco-editor/editor/editor.api'
import type { editor as MonacoEditorApi } from 'monaco-editor'
import { installMonacoWorkerEnvironment } from './worker.ts'

// Side-effect language registrations: the tokenizers/features these contribute
// are what make TS/JSON/CSS/HTML files highlight and parse. Kept to the four
// the desktop shell's code surface actually opens; more can be added on demand.
// The `./*` exports subpath maps these to esm/vs/language/*/monaco.contribution.js,
// which carries no CSS (that lives in the full `monaco-editor` index), so the
// client bundle stays free of Monaco's stylesheet stack.
import 'monaco-editor/language/typescript/monaco.contribution.js'
import 'monaco-editor/language/json/monaco.contribution.js'
import 'monaco-editor/language/css/monaco.contribution.js'
import 'monaco-editor/language/html/monaco.contribution.js'

/** One code file shown in the editor. */
export interface MonacoFileModel {
  /** Stable identity used to key the model across content swaps. */
  readonly path: string
  /** File contents (read-only in Phase 1). */
  readonly value: string
  /** Language id Monaco uses (typescript/json/css/html/…). */
  readonly language: string
}

export interface MonacoEditorProps {
  /** The file to display; changes replace the model content. */
  file: MonacoFileModel
  /** Light/dark preference; maps to the corum glass Monaco themes. */
  dark?: boolean
  /** Extra class on the host element (layout/positioning). */
  className?: string
}

/**
 * The corum liquid-glass Monaco themes (design.pen ③ 编辑器区). The editor
 * surface sits inside the glass region card, so the editor background is
 * transparent — the card's glass-1 fill shows through instead of Monaco's
 * stock solid #1e1e1e/#fffffe. Gutter/line-number/cursor colors follow the
 * design's label tokens; values are the design.pen hex (Monaco themes take
 * literal colors, not CSS variables).
 */
const CORUM_THEMES: Record<'corum-light' | 'corum-dark', MonacoEditorApi.IStandaloneThemeData> = {
  'corum-light': {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      'editor.lineHighlightBackground': '#0E0E1C08',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#8B8BA3',
      'editorLineNumber.activeForeground': '#0E0E1C',
      'editorCursor.foreground': '#5B21F5',
      'editor.foreground': '#0E0E1C',
      'editorWidget.background': '#FFFFFFCC',
      'editorWidget.border': '#FFFFFF',
      'scrollbarSlider.background': '#8B8BA333',
      'scrollbarSlider.hoverBackground': '#8B8BA355',
    },
  },
  'corum-dark': {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      'editor.lineHighlightBackground': '#F3ECFF0A',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#7E719E',
      'editorLineNumber.activeForeground': '#F3ECFF',
      'editorCursor.foreground': '#01CDFE',
      'editor.foreground': '#F3ECFF',
      'editorWidget.background': '#2A1840D9',
      'editorWidget.border': '#B98CFF2E',
      'scrollbarSlider.background': '#7E719E33',
      'scrollbarSlider.hoverBackground': '#7E719E55',
    },
  },
}

/** Registered-once flag (defineTheme is global, not per-editor). */
let corumThemesDefined = false
function defineCorumThemes(): void {
  if (corumThemesDefined) return
  corumThemesDefined = true
  editor.defineTheme('corum-light', CORUM_THEMES['corum-light'])
  editor.defineTheme('corum-dark', CORUM_THEMES['corum-dark'])
}

/** Resolve a stable language id from a file path (no model guessing needed). */
export function languageFromPath(path: string, fallback: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript'
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript'
    case 'json': case 'jsonc': return 'json'
    case 'css': case 'scss': case 'less': return 'css'
    case 'html': case 'htm': case 'xhtml': return 'html'
    case 'md': case 'markdown': return 'markdown'
    case 'py': return 'python'
    case 'yaml': case 'yml': return 'yaml'
    case 'sh': case 'bash': return 'shell'
    default: return fallback
  }
}

/**
 * Render a Monaco editor bound to one file model.
 * @param props - see {@link MonacoEditorProps}.
 * @returns the host div Monaco mounts into.
 */
export function MonacoEditor({ file, dark = true, className }: MonacoEditorProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<MonacoEditorApi.ITextModel | null>(null)

  // One-time: install the worker environment before the first editor exists.
  useEffect(() => {
    installMonacoWorkerEnvironment()
  }, [])

  // Create the editor once, on the host node.
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    defineCorumThemes()
    // dark prop is the light/dark preference; map it onto the corum glass
    // theme so the surface stays liquid-glass.
    const corumTheme = dark ? 'corum-dark' : 'corum-light'
    try {
      const instance = editor.create(host, {
        value: '',
        language: 'plaintext',
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        theme: corumTheme,
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
      })
      editorRef.current = instance
    } catch (error) {
      console.error('[corum-shell] monaco editor.create failed:', error)
      throw error
    }
    return () => {
      editorRef.current?.dispose()
      editorRef.current = null
    }
  }, [dark])

  // Replace the model/content when the file changes.
  useEffect(() => {
    const instance = editorRef.current
    if (instance === null) return
    const model = editor.createModel(file.value, file.language)
    instance.setModel(model)
    const previous = modelRef.current
    modelRef.current = model
    if (previous !== null) previous.dispose()
    return () => {
      // Model is disposed on the next swap; nothing to do per-file here.
    }
  }, [file.path, file.value, file.language])

  return (
    <div
      ref={hostRef}
      className={className}
      data-monaco-editor=""
      style={{ height: '100%', minHeight: '0', width: '100%' }}
    />
  )
}
