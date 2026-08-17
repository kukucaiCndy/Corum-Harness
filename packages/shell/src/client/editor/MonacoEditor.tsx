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
  /** Light/dark preference; maps to Monaco's built-in themes in Phase 1. */
  theme?: 'vs' | 'vs-dark'
  /** Extra class on the host element (layout/positioning). */
  className?: string
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
export function MonacoEditor({ file, theme = 'vs-dark', className }: MonacoEditorProps): React.ReactElement {
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
    try {
      const instance = editor.create(host, {
        value: '',
        language: 'plaintext',
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        theme,
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
  }, [theme])

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
      style={{ height: '100%', minHeight: '420px', width: '100%' }}
    />
  )
}
