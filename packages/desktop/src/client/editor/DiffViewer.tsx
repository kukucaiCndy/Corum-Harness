/**
 * DiffViewer — VS Code 语义的双侧只读 diff 视图。两种用法：
 *   ① 「与已选项目比较」：两侧都是**磁盘上的文件路径**（original/modified）。
 *   ② Review 卡「点击文件看改动」：左侧是**内存里重建的原文**
 *      （originalContent，来自 host 影子 git 仓库 corumReview/fileBefore —— 每个轮次
 *      的起始状态都提交过，所以是精确的改动前内容），右侧仍是磁盘当前文件。
 * 用 monaco 的 `editor.createDiffEditor`，双侧 readOnly。模型不共享主编辑器的
 * per-path cache（diff 是临时只读视图，卸载即 dispose），URI 用
 * `inmemory://diff/…` 避免与真实文件模型撞车。
 *
 * 布局（并排 / 内联）由**调用方显式决定**（`sideBySide` prop，用户在编辑器里切换、
 * 偏好持久化），不再用宽度自动判定。为什么放弃自动：
 *   - `useInlineViewWhenSpaceIsLimited` + 断点即使显式给出，早期实现里也**压不住**
 *     窄容器（左侧被压成 0–36px 的 gutter，用户看不到「改前」那一侧）；
 *   - 更重要的是「自动」会在用户**明确选了并排**之后又偷偷切成内联 —— 那就没有
 *     「切换」可言了。
 * 所以这里把两个自动选项全部拿掉，只从 prop 取。
 *
 * 主题复用 corum-light/corum-dark（defineCorumThemes 全局一次性注册，与
 * MonacoEditor 同源）；`useShadowDOM: false` 与主编辑器一致（避免 overflow
 * widget 进 shadow root 的问题——见 dev-conventions §7.1）。
 * @module corum-desktop/client/editor/DiffViewer
 */
import { useEffect, useRef, useState } from 'react'
import { editor, Uri } from 'monaco-editor'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { applyCorumTheme, defineCorumThemes } from './monaco-theme.ts'
import { summarizeLineChanges } from './diff-summary.ts'
import { installMinimapViewport } from './minimap-viewport.ts'
import { installMonacoWorkerEnvironment } from './worker.ts'
import { DEFAULT_DISPLAY_PREFS, displayOptions, getDisplayPrefsInstance } from './display-prefs.ts'
import css from './EditorColumn.module.css'

export interface DiffViewerProps {
  /** 原文（先选的文件）相对路径；仅用于**标题/URI 标识**，`originalContent` 存在时不读盘。 */
  original: string
  /** 新文（后选的文件）相对路径。 */
  modified: string
  /** Monaco 语言 id（取 modified 的语言）。 */
  language: string
  /** 读文件内容（corumFs/read RPC 直通）。 */
  readFile: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { content: string; language: string } }>
  /** 主题。 */
  dark: boolean
  /**
   * 左侧原文的**内存内容**（Review 卡的 diff 用）。给了它就不再读盘取左侧 ——
   * 重建出的原文并不存在于磁盘上。
   */
  originalContent?: string | undefined
  /**
   * 右侧新文的**内存内容**（2026-09-18）。给了它就不再读盘取右侧。
   *
   * 为什么必须支持：审查卡的 diff 右侧曾经只能读盘，而**隔离 worktree 在集成后会被回收**
   * ⇒ 右侧永远只有一行「（无法读取 …）」（读失败不抛错，所以表现为「开着但没内容」）。
   * 改后内容其实已经在影子仓库里（`ReviewFileEntry.hash` 就是它的 blob 号），
   * 由 host 的 `corumReview/fileAfter` 取回后经这里传入。
   */
  modifiedContent?: string | undefined
  /** 左右并排（true）还是内联单栏（false）。缺省 true。 */
  sideBySide?: boolean | undefined
  onSideBySideChange: (sideBySide: boolean) => void
}

export function DiffViewer({ original, modified, language, readFile, dark, originalContent, modifiedContent, sideBySide = true, onSideBySideChange }: DiffViewerProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const diffRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const [summary, setSummary] = useState<ReturnType<typeof summarizeLineChanges> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    setSummary(null)
    setError(null)
    installMonacoWorkerEnvironment()
    // 先注册主题再创建 diff：传未注册的主题名会被 monaco 静默回落到浅色 `vs`。
    defineCorumThemes()
    const diff = editor.createDiffEditor(host, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: sideBySide,
      // 两个「自动」选项都显式关掉：用户在编辑器里选了并排就必须真并排，
      // 不能被「空间有限」再偷偷切回内联（见文件头注释）。
      useInlineViewWhenSpaceIsLimited: false,
      automaticLayout: true,
      useShadowDOM: false,
      // 对比两侧是否显示小地图**由显示偏好决定**（见下方 applyDisplayPrefs）。
      // 这里不写 `minimap: { enabled: false }`：Monaco 0.56 的 updateOptions 对
      // 对象型选项是**按键合并**（`EditorOptionsUtil.applyUpdate` →
      // `editorOptions.js` 的 applyUpdate），紧随其后的 applyDisplayPrefs 只覆盖
      // enabled 键，创建时写的 false 会被立刻翻回 true——留下一个骗人的死值。
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      renderOverviewRuler: false,
      // VS Code 默认：内联差异高亮 + 忽略前导/尾随空白关闭（精确对比）
      renderIndicators: true,
      ignoreTrimWhitespace: false,
      // 自动折叠中间未改动的代码段（VS Code 的「Hide Unchanged Regions」）：
      // 只留改动处 + 每侧 3 行上下文，其余折叠成可点开的「N 行未改动」条。
      // 这是 monaco 内置能力，不要自己实现折叠。
      hideUnchangedRegions: {
        enabled: true,
        contextLineCount: 3,
        minimumLineCount: 3,
        revealLineCount: 20,
      },
    })
    diffRef.current = diff
    const disposeOriginalViewport = installMinimapViewport(diff.getOriginalEditor())
    const disposeModifiedViewport = installMinimapViewport(diff.getModifiedEditor())
    // 显示九项对**对比两侧**都生效（PR 要求「普通编辑器与对比两侧即时生效」）。
    // 小地图刻意跟随同一份偏好：用户在设置里关掉它，对比页也应当没有它。
    const displayPrefs = getDisplayPrefsInstance()
    const applyDisplayPrefs = (): void => {
      const options = displayOptions(displayPrefs?.getPrefs() ?? DEFAULT_DISPLAY_PREFS)
      diff.getOriginalEditor().updateOptions(options)
      diff.getModifiedEditor().updateOptions(options)
    }
    applyDisplayPrefs()
    const disposeDisplayPrefs = displayPrefs?.subscribe(applyDisplayPrefs)
    const diffListener = diff.onDidUpdateDiff(() => {
      const changes = diff.getLineChanges()
      setSummary(changes === null ? null : summarizeLineChanges(changes))
    })

    let cancelled = false
    void (async () => {
      // 左侧：给了内存原文就不读盘（重建出的原文不落盘）；否则读 original 文件。
      let contentA: string
      if (originalContent !== undefined) {
        contentA = originalContent
      } else {
        const ra = await readFile(original)
        if (cancelled) return
        if (!ra.ok || ra.value === undefined) throw new Error(`无法读取 ${original}：${ra.error?.message ?? '未知错误'}`)
        contentA = ra.value.content
      }
      // 右侧：给了内存新文就不读盘（改后内容可能在已回收的 worktree 里 —— 见 props 注释）。
      let contentB: string
      if (modifiedContent !== undefined) {
        contentB = modifiedContent
      } else {
        const rb = await readFile(modified)
        if (cancelled) return
        if (!rb.ok || rb.value === undefined) throw new Error(`无法读取 ${modified}：${rb.error?.message ?? '未知错误'}`)
        contentB = rb.value.content
      }
      const modelPath = modified.startsWith('/') ? modified : `/${modified}`
      const uriA = Uri.from({ scheme: 'inmemory', authority: 'diff-original', path: modelPath })
      const uriB = Uri.from({ scheme: 'inmemory', authority: 'diff-modified', path: modelPath })
      const modelA = editor.createModel(contentA, language, uriA)
      const modelB = editor.createModel(contentB, language, uriB)
      diff.setModel({ original: modelA, modified: modelB })
    })().catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })

    return () => {
      cancelled = true
      diffListener.dispose()
      disposeOriginalViewport()
      disposeModifiedViewport()
      const model = diff.getModel()
      diff.dispose()
      diffRef.current = null
      // diff 模型独立创建（非共享 cache），随视图销毁
      model?.original.dispose()
      model?.modified.dispose()
      disposeDisplayPrefs?.()
    }
    // original/modified/language 在同一 diff tab 生命周期内不变（tab 级固定），
    // 变化即重开 tab（新 path）。`sideBySide` 例外：它由用户在工具条上实时切换，
    // 而 `diff.updateOptions({renderSideBySide})` 在这版 monaco 上无效（实测），
    // 所以必须**重建**编辑器才能换布局 —— 故把它放进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBySide])

  // 主题跟随。
  //
  // 必须走 `applyCorumTheme`（它先 defineCorumThemes 再 setTheme）：早期这里直接
  // `editor.setTheme('corum-dark')`，而在**没打开过任何文件**的情况下 monaco 还不知道
  // 这个主题名 —— 回落到默认的 `vs`（浅色），编辑区就变成白底。这就用户实测到的
  // 「看差异时背景是浅色」。
  useEffect(() => {
    applyCorumTheme(dark)
  }, [dark])

  return (
    <div className={css.diffView} data-diff-viewer="">
      <div className={css.diffBar}>
        <div className={css.diffSummary} role="status" aria-live="polite">
          {error !== null ? '比较失败' : summary === null ? '正在比较…' : summary.count === 0 ? '文件内容相同' : (
            <><span className={css.diffAdded}>+{summary.added}</span><span className={css.diffRemoved}>−{summary.removed}</span><span>{summary.count} 处改动</span></>
          )}
        </div>
        <div className={css.editorActions}>
          <button type="button" className={css.editorAction} aria-label="上一处改动" title="上一处改动" disabled={!summary?.count || error !== null} onClick={() => diffRef.current?.goToDiff('previous')}><ArrowUp size={14} /></button>
          <button type="button" className={css.editorAction} aria-label="下一处改动" title="下一处改动" disabled={!summary?.count || error !== null} onClick={() => diffRef.current?.goToDiff('next')}><ArrowDown size={14} /></button>
          <button type="button" className={css.diffToggle} aria-pressed={sideBySide} onClick={() => onSideBySideChange(!sideBySide)}>{sideBySide ? '左右并排' : '内联单栏'}</button>
        </div>
      </div>
      <div className={css.diffHeadings} data-side-by-side={sideBySide}>
        <span title={original}>修改前 <span>{original.split('/').pop()}</span></span>
        <span title={modified}>修改后 <span>{modified.split('/').pop()}</span></span>
      </div>
      {error !== null && <div className={css.loadError} role="alert">{error}</div>}
      <div ref={hostRef} className={css.diffCanvas} />
    </div>
  )
}
