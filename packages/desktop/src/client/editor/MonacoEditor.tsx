/**
 * MonacoEditor — the corum-desktop desktop code editor surface.
 *
 * A thin React wrapper around the Monaco standalone editor, tuned for the
 * desktop shell: the worker environment is installed once (see ./worker.ts),
 * the editor is created on mount against a DOM node, and the model/theme are
 * driven by props. Phase 2 adds editable mode + content/cursor change callbacks
 * for dirty tracking and status bar.
 *
 * Model caching (2026-09-04 P0): models are keyed by file path in a module-
 * level cache and REUSED across tab switches — undo/redo stacks, cursor
 * position and scroll state survive switching away and back. External content
 * updates (file reloaded from disk / saved) reuse the model when the in-editor
 * text already matches (no-op), or apply a full-range edit so the undo stack
 * is preserved. Models are disposed only when their tab closes (the parent
 * passes the closed path list via `disposePaths`).
 *
 * Language contributions are imported for their side effects (registering
 * tokenizers/features) via the `monaco.contribution.js` subpath of each
 * language. The editor API itself comes from
 * `monaco-editor/esm/vs/editor/editor.api`,
 * NOT the full `monaco-editor` index (which pulls every language + the LSP
 * client, inflating the bundle far beyond what a desktop code view needs).
 * @module corum-desktop/client/editor/MonacoEditor
 */

import { useEffect, useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { installMinimapViewport } from './minimap-viewport.ts'
import css from './EditorColumn.module.css'
// 中文化（2026-09-04 第二十二轮）：Monaco 的 nls 在加载时读
// `globalThis._VSCODE_NLS_MESSAGES`——必须在 monaco 主入口**之前** import
// zh-cn 语言包（否则 nls 已初始化为英文，后 import 不生效）。zh-cn.js 是
// 纯副作用（设置 globalThis._VSCODE_NLS_MESSAGES/_VSCODE_NLS_LANGUAGE），
// 会被 bundler 内联（有全局赋值副作用，tree-shake 不掉）。
import 'monaco-editor/nls/lang/zh-cn.js'
// Monaco 全量主入口（`monaco-editor` 裸 specifier → esm/vs/index.js）：
//   - editor.api（editor/languages/Uri/KeyCode 等命名导出）；
//   - basic-languages 全部语种 monarch tokenizer（语法高亮着色——tsx/jsx/css/
//     html/json/md/py/yaml/sh/xml/sql/rs/go/java/cpp/ini 等 60+ 语种）；
//   - editor contrib 全家（find/multicursor/bracketMatching/folding/suggest/
//     gotoSymbol/semanticTokens/caretOperations/dropOrPaste 等）。
// 为什么不用 editor.api 子集 + 按需 import：basic-languages/contribution 的
// side-effect import specifier 会被 bundler 原样保留为运行时 require——dsh
// 模块表没有这些 seed（「missed the module table」白屏）。主入口是模块表
// seed（monaco-editor 裸名），其内部依赖全部内联，不产生运行时 require。
import { editor } from 'monaco-editor'
import type { editor as MonacoEditorApi } from 'monaco-editor'
import { applyCorumTheme, corumThemeName, defineCorumThemes } from './monaco-theme.ts'
import { installMonacoWorkerEnvironment } from './worker.ts'
import { setCorumMonacoInstance, type CorumMonacoInstance } from './monaco-bridge.ts'
import { getFontPrefsInstance } from './font-prefs.ts'
import { DEFAULT_DISPLAY_PREFS, displayOptions, getDisplayPrefsInstance } from './display-prefs.ts'

/** One code file shown in the editor. */
export interface MonacoFileModel {
  /** Stable identity used to key the model across content swaps. */
  readonly path: string
  /** File contents. */
  readonly value: string
  /** Language id Monaco uses (typescript/json/css/html/…). */
  readonly language: string
}

export interface MonacoEditorProps {
  modelScope?: string
  onAddSelection?: ((selection: EditorSelection) => void) | undefined
  /** The file to display; changes replace the model content. */
  file: MonacoFileModel
  /** Light/dark preference; maps to the corum glass Monaco themes. */
  dark?: boolean
  /** Extra class on the host element (layout/positioning). */
  className?: string
  /** Whether the editor is editable (Phase 2: true). */
  editable?: boolean
  /** Fired when the user edits content (dirty tracking). */
  onContentChange?: (value: string) => void
  /** Fired when the cursor moves (status bar line/column). */
  onCursorChange?: (pos: { line: number; column: number }) => void
  /** Paths whose models should be disposed (closed tabs). */
  disposePaths?: readonly string[]
}

export interface EditorSelection {
  startLine: number
  endLine: number
  text: string
}

/**
 * The corum liquid-glass Monaco themes (design.pen ③ 编辑器区). The editor
 * surface sits inside the glass region card, so the editor background is
 * transparent — the card's glass-1 fill shows through instead of Monaco's
 * stock solid #1e1e1e/#fffffe. Gutter/line-number/cursor colors follow the
 * design's label tokens; values are the design.pen hex (Monaco themes take
 * literal colors, not CSS variables).
 */
/** Resolve a stable language id from a file path (no model guessing needed). */
export function languageFromPath(path: string, fallback: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript'
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript'
    case 'json': case 'jsonc': case 'json5': return 'json'
    case 'css': case 'scss': case 'less': return 'css'
    case 'html': case 'htm': case 'xhtml': case 'vue': case 'svelte': return 'html'
    case 'md': case 'markdown': return 'markdown'
    case 'py': case 'pyi': return 'python'
    case 'yaml': case 'yml': return 'yaml'
    case 'sh': case 'bash': case 'zsh': return 'shell'
    case 'rs': return 'rust'
    case 'go': return 'go'
    case 'java': case 'kt': case 'kts': return 'java'
    case 'c': case 'h': return 'c'
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh': return 'cpp'
    case 'toml': case 'ini': case 'conf': return 'ini'
    case 'xml': case 'svg': case 'plist': return 'xml'
    case 'sql': return 'sql'
    case 'lock': return 'plaintext'
    default: return fallback
  }
}

// ── Per-path model cache ────────────────────────────────────────────────────
// Models are created once per file path and reused across tab switches, so
// undo/redo history, cursor and scroll state survive. A model is disposed
// only when its tab closes (EditorColumn passes the closed paths through the
// `disposePaths` prop). Language changes re-create the model (rare: only when
// the host's language detection disagrees with the initial extension guess).
const modelCache = new Map<string, MonacoEditorApi.ITextModel>()
const viewStates = new Map<string, MonacoEditorApi.ICodeEditorViewState>()

function acquireModel(file: MonacoFileModel): MonacoEditorApi.ITextModel {
  const cached = modelCache.get(file.path)
  if (cached !== undefined && !cached.isDisposed()) {
    if (cached.getLanguageId() !== file.language) {
      // Language re-detected (host override): re-create, undo history is lost
      // but this only happens once right after load.
      cached.dispose()
      const fresh = editor.createModel(file.value, file.language)
      modelCache.set(file.path, fresh)
      return fresh
    }
    // 单向数据流（第二十二轮）：模型是唯一事实源，**绝不在这里回写内容**——
    // 外部变更由 useEffect 的 ② 分支显式 pushEditOperations（唯一回写点）。
    // 在这里回写会在切换 tab 时把落后的 file.value（React 批处理）灌进模型
    // 污染撤销栈。
    return cached
  }
  const model = editor.createModel(file.value, file.language)
  modelCache.set(file.path, model)
  return model
}

function disposeModels(paths: readonly string[]): void {
  for (const path of paths) {
    const model = modelCache.get(path)
    if (model !== undefined) {
      if (!model.isDisposed()) model.dispose()
      modelCache.delete(path)
      viewStates.delete(path)
    }
  }
}

/**
 * Render a Monaco editor bound to one file model.
 * @param props - see {@link MonacoEditorProps}.
 * @returns the host div Monaco mounts into.
 */
export function MonacoEditor({ file, modelScope = '', onAddSelection, dark = true, className, editable = false, onContentChange, onCursorChange, disposePaths }: MonacoEditorProps): React.ReactElement {
  const modelPath = `${modelScope}\0${file.path}`
  const boundPath = useRef<string | null>(null)
  const onAddSelectionRef = useRef(onAddSelection)
  onAddSelectionRef.current = onAddSelection
  const [selectedCode, setSelectedCode] = useState<(EditorSelection & { top: number; left: number }) | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null)
  /** 字面偏好订阅的退订函数（try 块内订阅 → 桥到 effect cleanup 退订）。 */
  const fontPrefsDisposeRef = useRef<(() => void) | null>(null)
  const displayPrefsDisposeRef = useRef<(() => void) | null>(null)
  // Stable refs to callbacks so the editor is not recreated on every parent render.
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange
  const onCursorChangeRef = useRef(onCursorChange)
  onCursorChangeRef.current = onCursorChange

  // One-time: install the worker environment before the first editor exists.
  useEffect(() => {
    installMonacoWorkerEnvironment()
  }, [])

  // Create the editor once, on the host node. Theme switches go through the shared
  // `applyCorumTheme` (module corum-desktop/client/editor/monaco-theme), which also
  // guarantees the theme is registered first.
  // the live instance instead of recreating it (preserves view state).
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    // 先注册主题再创建：传未注册的主题名会让 monaco 回落到浅色 `vs`。
    defineCorumThemes()
    // find widget 窄栏修复：monaco findWidget.js 按 editorWidth 算三档（reduced/
    // narrow/collapsed）——编辑器列 ~420px 时命中 narrowFindWidget（419+28+minimap
    // -69 >= 420），匹配模式钮（Aa/ab/正则）被 findInput.layout 隐藏。且
    // style.maxWidth 硬算 = editorWidth - 28 - minimap - 15（≈170px）挤没全部钮。
    // inline style 优先级最高，CSS !important 打不过——MutationObserver 监听
    // find-widget 出现，强制覆盖 maxWidth:none + minWidth 500px（>438 退出
    // narrow 档，匹配模式钮恢复显示；widget 溢出编辑器右缘，VS Code 窄栏行为）。
    const findWidgetFix = new MutationObserver(() => {
      const fw = host.querySelector('.find-widget')
      if (fw instanceof HTMLElement && fw.style.maxWidth !== 'none') {
        fw.style.maxWidth = 'none'
        fw.style.minWidth = '500px'
        fw.style.width = '500px'
      }
    })
    findWidgetFix.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
    // 字面偏好（PRD §4.23 E1/E2/E3）：cordis 服务真源（font-prefs 实例桥，
    // 同 bundle）。服务未 provide 时回落现状硬编码缺省（font-prefs DEFAULT_EDITOR）。
    const fontPrefs = getFontPrefsInstance()
    const editorFont = fontPrefs?.getPrefs().editor
    let disposeMinimapViewport: (() => void) | undefined
    try {
      const instance = editor.create(host, {
        value: '',
        language: 'plaintext',
        readOnly: !editable,
        automaticLayout: true,
        // minimap：VS Code 标志性代码缩略图（slider 模式滑块常驻）。
        minimap: { enabled: true, showSlider: 'always', renderCharacters: false, maxColumn: 80 },
        theme: corumThemeName(dark),
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
        // 关键：关掉 shadow DOM（0.56 默认 true）。否则右键菜单等 overflow
        // widget 渲染进 .shadow-root-host 的 shadow root，document 级玻璃拟态
        // CSS 与 --vscode-menu-* token 覆盖全部失效，菜单退化为暗色原生块。
        useShadowDOM: false,
        // 括号/缩进/折叠/空白字符（VS Code 默认体验对齐）。
        matchBrackets: 'always',
        bracketPairColorization: { enabled: true },
        autoClosingBrackets: 'languageDefined',
        autoClosingQuotes: 'languageDefined',
        autoIndent: 'full',
        guides: { bracketPairs: true, indentation: true },
        folding: true,
        foldingHighlight: true,
        showFoldingControls: 'always',
        renderWhitespace: 'selection',
        renderControlCharacters: true,
        // 多光标（⌥Click + ⌘⌥↑↓）。
        multiCursorModifier: 'alt',
        multiCursorMergeOverlapping: true,
        // 查找（⌘F widget 自带，无需额外配置）。
        find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
        // 选择/滚动体验。
        selectOnLineNumbers: true,
        roundedSelection: false,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        smoothScrolling: true,
        // 字体/行高（真源 = font-prefs cordis 服务；缺省对齐原硬编码 234-236 行值）。
        fontFamily: editorFont?.fontFamily ?? "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace",
        fontSize: editorFont?.fontSize ?? 13,
        lineHeight: editorFont?.lineHeight ?? 20,
        letterSpacing: 0,
        // 行号/装饰。
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        glyphMargin: false,
        lineDecorationsWidth: 8,
        // 滚动条（细滑块对齐玻璃风格）。
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        // 粘贴/拖拽。
        dragAndDrop: true,
        pasteAs: { enabled: true },
        // 快速建议（输入即补全；VS Code 默认 on）。
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnEnter: 'on',
        tabCompletion: 'off',
        wordBasedSuggestions: 'currentDocument',
        // 格式化（⌥⇧F 自带，register 由 language contribution 提供）。
        formatOnPaste: false,
        formatOnType: false,
      })
      editorRef.current = instance
      disposeMinimapViewport = installMinimapViewport(instance)
      const readSelection = (): void => {
        const selection = instance.getSelection()
        const model = instance.getModel()
        if (selection === null || selection.isEmpty() || model === null || !onAddSelectionRef.current) { setSelectedCode(null); return }
        const text = model.getValueInRange(selection)
        if (text.trim() === '') { setSelectedCode(null); return }
        const position = instance.getScrolledVisiblePosition(selection.getStartPosition())
        setSelectedCode({ text, startLine: selection.startLineNumber, endLine: selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber,
          top: Math.max(4, (position?.top ?? 40) - 36), left: Math.max(8, Math.min(position?.left ?? 64, host.clientWidth - 170)) })
      }
      instance.onDidChangeCursorSelection(readSelection)
      instance.onDidScrollChange(() => setSelectedCode(null))
      instance.onDidChangeModel(() => setSelectedCode(null))
      instance.addAction({ id: 'corum.add-selection-to-chat', label: '添加选中代码到对话', contextMenuGroupId: 'navigation', contextMenuOrder: 0,
        precondition: 'editorHasSelection', run: () => {
          const selection = instance.getSelection()
          const model = instance.getModel()
          if (selection && model && !selection.isEmpty()) onAddSelectionRef.current?.({ startLine: selection.startLineNumber,
            endLine: selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber, text: model.getValueInRange(selection) })
        } })
      const displayPrefs = getDisplayPrefsInstance()
      instance.updateOptions(displayOptions(displayPrefs?.getPrefs() ?? DEFAULT_DISPLAY_PREFS))
      displayPrefsDisposeRef.current = displayPrefs?.subscribe(() => {
        instance.updateOptions(displayOptions(displayPrefs.getPrefs()))
      }) ?? null
      // 字面偏好实时生效（PRD §4.23）：fontSize/fontFamily/lineHeight 均实测对
      // updateOptions 有效（区别于 diff 布局等布局类选项需重建）。订阅 cordis
      // 服务，设置页写入即实时反映到已打开的编辑器。dispose 经 ref 桥到 cleanup。
      const disposeFontPrefs = fontPrefs?.subscribe(() => {
        const next = getFontPrefsInstance()?.getPrefs().editor
        if (next === undefined) return
        instance.updateOptions({
          fontFamily: next.fontFamily,
          fontSize: next.fontSize,
          lineHeight: next.lineHeight,
        })
      })
      fontPrefsDisposeRef.current = disposeFontPrefs ?? null
      // P2-1（2026-09-09）：原挂 window.__corumMonacoEditor（可写可清的可变单例，
      // 红线 1 形态）→ 同 bundle 模块引用桥（monaco-bridge.ts）。EditorColumn 的
      // 快捷键兜底经 getCorumMonacoInstance() 取同一实例。
      setCorumMonacoInstance({
        trigger: (source, handlerId) => { instance.trigger(source, handlerId, undefined) },
        // 「编辑未命中」卡行号跳转（2026-09-13）：滚动到行 + 光标定位 + 聚焦。
        revealLine: (line) => {
          const model = instance.getModel()
          if (model === null) return
          const target = Math.max(1, Math.min(line, model.getLineCount()))
          instance.revealLineInCenter(target)
          instance.setPosition({ lineNumber: target, column: 1 })
          instance.focus()
        },
      } satisfies CorumMonacoInstance)
      instance.onDidChangeModelContent(() => {
        const model = instance.getModel()
        if (model !== null) {
          // 程序化变更（setValue/pushEditOperations 重置/外部回写）不同步——
          // 否则会覆盖 readFile 完成后的真实内容（① 的 setValue('') 触发
          // onContentChange('') 把真实内容覆盖回 '' 的根因）。
          if (suppressContentSyncRef.current) return
          // 单向数据流：模型变化（输入/撤销/重做）只同步只读投影
          // （dirty 标记/状态栏），绝不回写模型（防 React 批处理 race 污染撤销栈）。
          onContentChangeRef.current?.(model.getValue())
        }
      })
      instance.onDidChangeCursorPosition((e) => {
        onCursorChangeRef.current?.({ line: e.position.lineNumber, column: e.position.column })
      })
    } catch (error) {
      console.error('[corum-desktop] monaco editor.create failed:', error)
      throw error
    }
    return () => {
      findWidgetFix.disconnect()
      disposeMinimapViewport?.()
      fontPrefsDisposeRef.current?.()
      fontPrefsDisposeRef.current = null
      displayPrefsDisposeRef.current?.()
      displayPrefsDisposeRef.current = null
      setCorumMonacoInstance(undefined)
      const view = editorRef.current?.saveViewState()
      if (view && boundPath.current !== null) viewStates.set(boundPath.current, view)
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // editable is a create-time option; a change recreates the editor (never
    // happens in practice — the editor column is always editable).
  }, [editable])

  // Theme switch on the live editor (no recreation → cursor/scroll survive).
  useEffect(() => {
    applyCorumTheme(dark)
  }, [dark])

  // Bind the cached per-path model to the editor (tab switch = setModel).
  // 单向数据流（2026-09-04 第二十二轮重构，根治「连续 ⌘Z 内容被清空」）：
  // 模型是唯一事实源，React state（file.value）只是只读投影（dirty 标记/状态
  // 栏），**绝不回写模型**——除了两种情况：① 切换 tab（file.path 变）绑定另一
  // 个模型；② 外部变更（file.path 相同但磁盘内容变了，EditorColumn 经 watch
  // 检测到后 bump file.value 触发本 effect）。用户输入/撤销/重做都是模型自己
  // 产生的变化，onDidChangeModelContent 只同步只读投影，不回写——否则 React
  // 18 批处理 race 把中间态 file.value 回写进模型污染撤销栈（连续 ⌘Z 时模型
  // 被回退到任意中间撤销态，内容被清空/错乱）。
  const lastExternalValueRef = useRef<{ path: string; value: string } | null>(null)
  // 程序化模型变更抑制标记：setValue/pushEditOperations 会触发
  // onDidChangeModelContent → onContentChange 把 React state 覆盖成程序化值
  // （readFile 完成后的真实内容被① 的 setValue('') 覆盖回 '' 的根因）。程序
  // 化变更期间置 true，onContentChange 跳过同步。
  const suppressContentSyncRef = useRef(false)
  useEffect(() => {
    const instance = editorRef.current
    if (instance === null) return
    const currentModel = instance.getModel()
    // ① 切换 tab（path 变）→ 绑定该 path 的缓存模型（不存在则创建）。
    if (currentModel === null || lastExternalValueRef.current?.path !== modelPath) {
      const previousView = instance.saveViewState()
      if (previousView !== null && boundPath.current !== null) viewStates.set(boundPath.current, previousView)
      const model = acquireModel({ path: modelPath, value: file.value, language: file.language })
      // 脏模型重置（第二十二轮）：缓存模型内容与磁盘 file.value 不一致（上次
      // 会话残留的未保存编辑 / HMR 热更新跨模型缓存）→ setValue 清撤销栈重置
      // 为磁盘内容（文件以磁盘为准，undo 历史从干净开始）。否则 ⌘Z 会撤到
      // 「打开前」的脏状态（连续 ⌘Z 把内容清空的根因之一）。
      if (model.getValue() !== file.value) {
        suppressContentSyncRef.current = true
        model.setValue(file.value)
        suppressContentSyncRef.current = false
      }
      lastExternalValueRef.current = { path: modelPath, value: file.value }
      if (instance.getModel() !== model) {
        instance.setModel(model)
      }
      boundPath.current = modelPath
      const view = viewStates.get(modelPath)
      if (view !== undefined) instance.restoreViewState(view)
      const position = instance.getPosition()
      if (position !== null) onCursorChangeRef.current?.({ line: position.lineNumber, column: position.column })
      return
    }
    // ② 同 path 外部变更（watch 重载 / placeholder 加载完成：file.value 与
    // 上次外部值不同）→ 回写模型。区分两种：
    //   - placeholder 加载完成（模型与上次外部值都是空串）→ setValue 清撤销栈
    //     （undo 历史从加载完成的内容开始，撤不回空 placeholder——连续 ⌘Z 把
    //     内容清空的根因：placeholder 空状态被 pushEditOperations 留在 undo 栈）；
    //   - watch 外部变更（模型有真实内容）→ pushEditOperations 保留撤销栈
    //     （外部新版作为一次新编辑，可撤销回用户之前的编辑）。
    if (lastExternalValueRef.current.value !== file.value && currentModel.getValue() !== file.value) {
      const isPlaceholderLoad = lastExternalValueRef.current.value === '' && currentModel.getValue() === ''
      lastExternalValueRef.current = { path: modelPath, value: file.value }
      suppressContentSyncRef.current = true
      if (isPlaceholderLoad) {
        currentModel.setValue(file.value)
      } else {
        currentModel.pushEditOperations(
          [],
          [{ range: currentModel.getFullModelRange(), text: file.value }],
          () => null,
        )
      }
      suppressContentSyncRef.current = false
    }
    // 用户输入/撤销/重做引起的 file.value 变化（currentModel.getValue() ===
    // file.value 或 lastExternalValueRef.current.value === file.value 的同步
    // 投影）→ 不回写，模型已是正确内容。
  }, [modelPath, file.value, file.language])

  // Dispose models of closed tabs.
  useEffect(() => {
    if (disposePaths !== undefined && disposePaths.length > 0) disposeModels(disposePaths.map(path => `${modelScope}\0${path}`))
  }, [disposePaths, modelScope])

  return (
    <div
      className={className}
      data-monaco-editor=""
      style={{ height: '100%', minHeight: '0', width: '100%', position: 'relative' }}
    >
      <div ref={hostRef} style={{ height: '100%', width: '100%' }} />
      {selectedCode && onAddSelection && <button type="button" className={css.addSelection} style={{ top: selectedCode.top, left: selectedCode.left }}
        onMouseDown={event => event.preventDefault()} onClick={() => { onAddSelection(selectedCode); setSelectedCode(null) }}>
        <MessageSquarePlus size={14} /> 添加到对话 <span>{selectedCode.endLine - selectedCode.startLine + 1} 行</span>
      </button>}
    </div>
  )
}
