/**
 * EditorColumn — the resident right-hand code editor in IDE mode, the
 * MERGED ③ 编辑器区 card (design.pen cZcBX). Registered into the
 * `corum.editor` slot (a root-scope single slot declared ONLY by
 * @corum/corum-ide-ui, IDE mode only).
 *
 * 真实文件读写（2026-09-04）：EditorColumn 管理已打开文件 tab 列表 + 活跃 tab
 * 的 Monaco 编辑器。文件内容经 corumFs/read RPC 加载、⌘S 经 corumFs/write
 * 保存。状态栏显示真实行/列/编码/语言/dirty。
 *
 * P0 稳定性（2026-09-04 第十五轮）：dirty 以 savedContent 基线比对；Monaco
 * 模型按路径缓存；保存反馈（保存中/已保存/失败红字）；关闭 dirty tab 确认；
 * 空态隐藏 crumb/状态栏。
 *
 * 第十六轮（2026-09-04）：
 * - 编辑器状态持久化（localStorage `corum.ide.editor.v1`：tabs/activePath/
 *   explorerWidth/explorerCollapsed/expandedDirs，刷新恢复）。
 * - 文件树↔编辑器双向同步：激活 tab → 树选中 + 自动展开父级 + scrollIntoView；
 *   关闭 tab → 同步清树选中；树选中变化 → 通知 EditorColumn。
 * - fs watch：host @Remote watch 启动递归 watch；变更通知走
 *   ctx.remote.$on('corum/file/changed') 推送（统一事件中心二期；三期删
 *   2s poll 兜底——host/renderer 同生同死永不触发）；变更 → 文件树局部刷新；
 *   已打开 tab 内容外部变更 → 未 dirty 自动重载 / 已 dirty 状态栏警告「磁盘已更改」。
 * - 新建文件/文件夹：tree-header 两钮 + 右键菜单接通（mkdirp/write 空文件 +
 *   自动刷新 + 新文件直接打开）。
 * - 右键菜单：文件（打开/重命名/删除）+ 目录（新建文件/新建文件夹/重命名/
 *   删除/刷新）。重命名行内 input；删除 window.confirm。
 * - write 自动建父目录（host 侧 mkdir recursive）。
 *
 * 卡内结构：editor-main（Tabs → crumb → Code → Status）+ sash + divider +
 * 资源管理器子面板（ExplorerPane）。折叠态资源管理器完全消失，编辑器占满。
 *
 * @module corum-desktop/client/editor/EditorColumn
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Code, Eye, PanelRightOpen, X } from 'lucide-react'
import type {} from '@corum/corum-ide-ui/client'
import { ConfirmDialog } from '@corum/corum-ui-base/client'
import { MonacoEditor, languageFromPath } from './MonacoEditor.tsx'
import { getCorumMonacoInstance } from './monaco-bridge.ts'
import { ExplorerPane, type ExplorerPaneInjected } from './ExplorerPane.tsx'
import { DiffViewer } from './DiffViewer.tsx'
import { ImagePreview, MarkdownPreview, SvgPreview, VideoPreview } from './PreviewView.tsx'
import css from './EditorColumn.module.css'
import { isExternalPreviewPath } from '../../shared/preview-path.ts'

/** 文件预览类型（HANDOFF §七.6）：md/svg 双模式可切；图片/视频仅预览。 */
type PreviewKind = 'markdown' | 'svg' | 'image' | 'video' | null

/** 按扩展名判预览类型（与 host corum-fs 的 IMAGE/VIDEO 表一致）。 */
function previewKindFromPath(path: string): PreviewKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'svg') return 'svg'
  if (['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp', 'ico'].includes(ext)) return 'image'
  if (['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video'
  return null
}

/** One open file tab. */
interface EditorTab {
  /** Relative path under the project root (e.g. '/src/index.ts'). diff tab 用合成键 'diff://A::B'。 */
  readonly path: string
  /** Display title (basename；diff tab 用 'A ↔ B')。 */
  readonly title: string
  /** Current in-editor content (may differ from savedContent while dirty). */
  content: string
  /** Baseline content as last loaded from / saved to disk. dirty = content !== savedContent. */
  savedContent: string
  /** Language id for Monaco. */
  language: string
  /** Load error (file not found / permission etc.). */
  error: string | null
  /** 磁盘上已被外部修改（watch 检测到）；仅在 dirty 时有意义（未 dirty 已自动重载）。 */
  externalChanged: boolean
  /** 预览 tab（VS Code 语义：单击文件打开的临时 tab，斜体显示；双击/编辑/双击 tab 后固定）。
   *  新打开预览 tab 会替换掉已有预览 tab（VS Code 单预览位）。 */
  preview: boolean
  /** diff tab（VS Code「选择以进行比较」+「与已选项目比较」）：只读双侧 diff 视图。
   *  `originalContent` 存在时左侧取内存内容（Review 卡「点击文件看改动」——
   *  重建出的原文不落盘）；否则两侧都按路径读盘。 */
  diff?: { original: string; modified: string; originalContent?: string | undefined; modifiedContent?: string | undefined }
  /** diff tab 的一行说明（如重建不完整的提示），显示在 tab 顶部横幅。 */
  diffNote?: string | undefined
  /** 预览类型（md/svg/图片/视频）；null = 普通代码 tab。 */
  kind?: PreviewKind
  /** 源码 ⟷ 预览切换（md/svg 有效；图片/视频恒预览）。 */
  viewMode?: 'source' | 'preview'
  /** 外部文件再次打开时，媒体预览也必须重新读取。 */
  previewRevision?: number
}

/** diff tab 合成 path 前缀（避免与真实文件路径冲突；不持久化）。 */
const DIFF_PATH_PREFIX = 'diff://'
function diffTabPath(a: string, b: string): string {
  return `${DIFF_PATH_PREFIX}${a}::${b}`
}

/** Review 卡「改动前后」diff tab 的合成 path 前缀（同样不持久化；与 compare
 *  diff tab 分开，避免同文件重叠时误复用内容不同的 tab）。 */
const REVIEW_DIFF_PREFIX = 'reviewdiff://'

/** diff 布局偏好（并排/内联）的 localStorage key。 */
const DIFF_SIDE_BY_SIDE_KEY = 'corum.diff.sideBySide'

/** 保存反馈（状态栏右侧短暂显示；失败常驻直到下次保存/编辑）。 */
type SaveFeedback =
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string }
  | null

/** 编辑器可编程入口（openFile 提升暴露，供 index.ts 的 corumEditor cordis 服务
 *  调用——统一事件中心三-2 服务化，原 corum:open-in-editor CustomEvent + 3s
 *  轮询已退役）。由 index.ts 创建并经 inject 面传入；EditorColumn 挂载时把
 *  openFile 写入（写入即触发服务 pending 认领）。 */
export interface EditorApiRef {
  openFile: ((path: string, opts?: { preview?: boolean; pin?: boolean }) => Promise<void>) | null
  /** 打开「改动前后」diff tab（Review 卡）：左侧为内存重建的原文，右侧读盘当前文件。 */
  openContentDiff: ((input: { path: string; originalContent: string; note?: string | undefined }) => Promise<void>) | null
}

/** 本插件的注入面（见 client/index.ts apply）。 */
export interface EditorColumnInjected {
  /** 关闭本区域（隐藏叶子，可在插件中心「视图管理」恢复）。 */
  closeRegion: () => void
  /** 编辑器可编程入口 ref（openFile 提升暴露；见 EditorApiRef）。 */
  editorApi: EditorApiRef
  /** 点亮编辑器区域（打开文件时自动显示，取消默认隐藏）。 */
  showEditor: () => void
  /** 资源管理器子面板数据源 + generation 源（ExplorerPane 直通）。 */
  explorer: Pick<ExplorerPaneInjected, 'listDir' | 'generation' | 'workspaceRoot'>
  /** 读文件内容（corumFs/read RPC）。 */
  readFile: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { content: string; language: string } }>
  /** 读图片二进制（corumFs/readBinary RPC，base64；图片预览数据源）。 */
  readBinary: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { mime: string; base64: string } }>
  /** 写文件内容（corumFs/write RPC，⌘S 保存；自动建父目录）。 */
  writeFile: (path: string, content: string) => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 新建目录（corumFs/mkdir RPC，recursive）。 */
  mkdirp: (path: string) => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 删除文件/目录（corumFs/delete RPC，目录递归）。 */
  deletePath: (path: string) => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 重命名/移动（corumFs/rename RPC）。 */
  renamePath: (from: string, to: string) => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 取真实绝对路径（corumFs/absolutePath RPC；「复制路径」数据源）。 */
  absolutePath: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { absolutePath: string } }>
  /** 在系统文件管理器中显示（corumFs/reveal RPC；macOS open -R）。 */
  revealPath: (path: string) => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 把文件 @引用加入当前会话草稿（conversation cordis service；见 client/index.ts）。 */
  addToConversation: (path: string) => { ok: boolean; error?: string }
  /** 启动项目根递归 watch（幂等）。 */
  startWatch: () => Promise<{ ok: boolean; error?: { message?: string } }>
  /**
   * 订阅文件变更推送（统一事件中心二期主路径：ctx.remote.$on
   * 'corum/file/changed'）。listener 收到去抖批量 { changes } 帧；返回 dispose
   * （组件 unmount 时调用）。
   */
  onFileChanged: (listener: (frame: { changes: { path: string; kind: 'rename' | 'change' }[] }) => void) => () => void
}

/** Full composed props of the root-scope editor slot. */
export type EditorColumnProps = PropsRuntime<'corum.editor'> & EditorColumnInjected

/** 资源管理器子面板宽度边界（设计 210 默认；调宽区间 [160, 480]）。 */
const EXPLORER_DEFAULT_WIDTH = 210
const EXPLORER_MIN_WIDTH = 160
const EXPLORER_MAX_WIDTH = 480

/** localStorage 持久化键（编辑器视图状态，不含文件内容——内容启动时从磁盘重载）。 */
const STORAGE_KEY = 'corum.ide.editor.v1'

interface PersistedEditorState {
  /** 已打开 tab 路径（启动时 readFile 重载内容）。 */
  tabs: string[]
  /** 激活 tab 路径。 */
  activePath: string | null
  /** 资源管理器子面板宽度。 */
  explorerWidth: number
  /** 资源管理器折叠态。 */
  explorerCollapsed: boolean
  /** 文件树展开的目录路径。 */
  expandedDirs: string[]
}

function loadPersisted(): Partial<PersistedEditorState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    return JSON.parse(raw) as Partial<PersistedEditorState>
  } catch {
    return {}
  }
}

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

/** The resident merged editor card (see module doc). */
export function EditorColumn({ closeRegion, showEditor, editorApi, explorer, readFile, readBinary, writeFile, mkdirp, deletePath, renamePath, absolutePath, revealPath, addToConversation, startWatch, onFileChanged }: EditorColumnProps): React.ReactElement {
  const dark = useDarkTheme()
  const persisted = useMemo(loadPersisted, [])
  const [explorerWidth, setExplorerWidth] = useState(persisted.explorerWidth ?? EXPLORER_DEFAULT_WIDTH)
  const [explorerCollapsed, setExplorerCollapsed] = useState(persisted.explorerCollapsed ?? false)
  const onToggleExplorerCollapsed = useCallback(() => {
    setExplorerCollapsed((prev) => !prev)
  }, [])

  // ── Tab management ──
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(persisted.activePath ?? null)
  const activeTab = useMemo(() => tabs.find(t => t.path === activePath) ?? null, [tabs, activePath])
  // ── 统一弹窗（替原生 alert/confirm）：confirm=双键确认执行 / info=单键错误告知。
  const [dialog, setDialog] = useState<
    | { kind: 'confirm'; title: string; message: string; warning?: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }
    | { kind: 'info'; title: string; message: string }
    | null
  >(null)
  /** 错误告知（替 window.alert）。 */
  const showError = useCallback((message: string) => { setDialog({ kind: 'info', title: '操作失败', message }) }, [])
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 })
  /** Models of closed tabs to dispose (consumed once by MonacoEditor). */
  const [disposePaths, setDisposePaths] = useState<string[]>([])
  /** 保存反馈（每次保存动作重置；「已保存」1.6s 后自动消失）。 */
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>(null)
  const saveFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashSaveFeedback = useCallback((next: SaveFeedback, autoClearMs?: number) => {
    if (saveFeedbackTimer.current !== null) {
      clearTimeout(saveFeedbackTimer.current)
      saveFeedbackTimer.current = null
    }
    setSaveFeedback(next)
    if (autoClearMs !== undefined) {
      saveFeedbackTimer.current = setTimeout(() => {
        setSaveFeedback(null)
        saveFeedbackTimer.current = null
      }, autoClearMs)
    }
  }, [])
  useEffect(() => () => {
    if (saveFeedbackTimer.current !== null) clearTimeout(saveFeedbackTimer.current)
  }, [])

  // 文件树展开的目录（持久化 + tab 激活自动展开）。
  const [expandedDirs, setExpandedDirs] = useState<string[]>(persisted.expandedDirs ?? [])
  // 文件树刷新生成号（watch / 新建 / 删除 / 重命名后 bump → ExplorerPane 重载受影响目录）。
  const [treeRefreshGen, setTreeRefreshGen] = useState(0)

  // 工作区根变化（client/index.ts 同步 corumFs/setRoot 后广播）→ 整树刷新 +
  // 清掉已展开的目录（旧根的展开态对新根无意义）。tab 保留：路径相对旧根的
  // tab 在新根下打不开会显示加载错误（符合预期——用户切了项目）。
  useEffect(() => {
    const onRootChanged = () => {
      setExpandedDirs([])
      setTreeRefreshGen(g => g + 1)
    }
    window.addEventListener('corum:workspace-root-changed', onRootChanged)
    return () => window.removeEventListener('corum:workspace-root-changed', onRootChanged)
  }, [])

  // ── 持久化（tabs/activePath/explorerWidth/explorerCollapsed/expandedDirs） ──
  useEffect(() => {
    const state: PersistedEditorState = {
      tabs: tabs.filter(t => !isExternalPreviewPath(t.path)).map(t => t.path),
      activePath: activePath !== null && isExternalPreviewPath(activePath) ? null : activePath,
      explorerWidth,
      explorerCollapsed,
      expandedDirs,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // localStorage 写失败（隐私模式）不影响功能
    }
  }, [tabs, activePath, explorerWidth, explorerCollapsed, expandedDirs])

  // ── 启动时恢复持久化的 tabs（内容从磁盘重载） ──
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    // 合成 tab（对比 diff `diff://…` 与 Review 卡的改动 diff `reviewdiff://…`）都
    // **不能**持久化：它们的 `diff` 字段（两侧路径/内存原文）没有落盘，重启后按普通
    // 文件 tab 恢复会去 readFile 一个假路径，得到一个报错的坏 tab。
    // （早期只排除了 `diff://`，`reviewdiff://` 不以它开头，于是漏了 —— 用户已复现。）
    const paths = (persisted.tabs ?? [])
      .filter(p => !p.startsWith(DIFF_PATH_PREFIX) && !p.startsWith(REVIEW_DIFF_PREFIX) && !isExternalPreviewPath(p))
    if (paths.length === 0) return
    // 并发恢复所有 tab（内容 readFile 重载）；恢复的 tab 都是固定（非预览）。
    for (const path of paths) {
      const title = path.split('/').pop() ?? path
      const kind = previewKindFromPath(path)
      const placeholder: EditorTab = {
        path,
        title,
        content: '',
        savedContent: '',
        language: languageFromPath(path, 'plaintext'),
        error: null,
        externalChanged: false,
        preview: false,
        ...(kind !== null ? { kind, viewMode: 'preview' as const } : {}),
      }
      setTabs(prev => prev.some(t => t.path === path) ? prev : [...prev, placeholder])
      // 图片/视频是二进制——不 read（host 也会拒绝），内容恒空。
      if (kind === 'image' || kind === 'video') continue
      readFile(path).then((result) => {
        if (result.ok && result.value !== undefined) {
          setTabs(prev => prev.map(t => t.path === path
            ? { ...t, content: result.value!.content, savedContent: result.value!.content, language: result.value!.language || t.language }
            : t,
          ))
        } else {
          const msg = result.error?.message ?? '读取失败'
          setTabs(prev => prev.map(t => t.path === path ? { ...t, error: msg } : t))
        }
      }).catch((err) => {
        setTabs(prev => prev.map(t => t.path === path ? { ...t, error: String(err) } : t))
      })
    }
    // 有恢复的 tab → 点亮编辑器区域
    showEditor()
  }, [persisted.tabs, readFile, showEditor])

  /** Open a file tab (or switch to it if already open). Called by ExplorerPane click.
   *  `preview: true` = VS Code 预览语义（斜体临时 tab，替换已有预览位；编辑/双击 tab 固定）。 */
  const openFile = useCallback(async (path: string, opts?: { preview?: boolean; pin?: boolean }) => {
    const wantPreview = opts?.preview ?? false
    // 打开文件时自动点亮编辑器区域（取消默认隐藏）。
    showEditor()
    // Already open? Just activate；pin=true 同时取消预览态（双击树文件）。
    const existing = tabs.find(t => t.path === path)
    if (existing !== undefined && !isExternalPreviewPath(path)) {
      setActivePath(path)
      if (opts?.pin === true && existing.preview) {
        setTabs(prev => prev.map(t => t.path === path ? { ...t, preview: false } : t))
      }
      return
    }
    // Create a placeholder tab, then load content.
    const title = path.split('/').pop() ?? path
    const kind = previewKindFromPath(path)
    const newTab: EditorTab = {
      path,
      title,
      content: '',
      savedContent: '',
      language: languageFromPath(path, 'plaintext'),
      error: null,
      externalChanged: false,
      preview: wantPreview,
      ...(isExternalPreviewPath(path) ? { previewRevision: (existing?.previewRevision ?? 0) + 1 } : {}),
      ...(kind !== null ? { kind, viewMode: 'preview' as const } : {}),
    }
    setTabs(prev => {
      // 预览 tab 替换已有预览位（VS Code 单预览语义）。
      const base = wantPreview ? prev.filter(t => !t.preview) : prev
      return [...base.filter(t => t.path !== path), newTab]
    })
    setActivePath(path)
    // 图片/视频是二进制——不 read（host 端对二进制扩展名也直接拒绝），
    // 内容恒空，预览组件自取（图片 readBinary / 视频 /corumfs URL）。
    if (kind === 'image' || kind === 'video') return
    try {
      const result = await readFile(path)
      if (result.ok && result.value !== undefined) {
        setTabs(prev => prev.map(t => t.path === path
          ? { ...t, content: result.value!.content, savedContent: result.value!.content, language: result.value!.language || t.language, externalChanged: false }
          : t,
        ))
      } else {
        const msg = result.error?.message ?? '读取失败'
        setTabs(prev => prev.map(t => t.path === path ? { ...t, error: msg } : t))
      }
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === path ? { ...t, error: String(err) } : t))
    }
  }, [tabs, readFile, showEditor])

  const openContentDiff = useCallback(async (
    input: { path: string; originalContent: string; modifiedContent?: string | undefined; note?: string | undefined },
  ) => {
    showEditor()
    const { path, originalContent, modifiedContent, note } = input
    // 合成键带上内容长度：同一文件再次点击且重建结果变化时应开新 tab 而不是
    // 复用旧内容（monaco 模型在 mount 时一次性建立，不随 props 更新）。
    // 右侧内容长度也进键：同一路径的「改后」在 worktree 回收前后会从「读不到」变成
    // 「git 里的真内容」，不进键就会复用那个已经渲染成「（无法读取 …）」的旧 tab。
    const key = `${REVIEW_DIFF_PREFIX}${path}::${originalContent.length}::${modifiedContent?.length ?? 'disk'}`
    const existing = tabs.find(t => t.path === key)
    if (existing !== undefined) {
      setActivePath(key)
      return
    }
    const name = path.split('/').pop() ?? path
    const newTab: EditorTab = {
      path: key,
      title: `${name} ↔`,
      content: '',
      savedContent: '',
      language: languageFromPath(path, 'plaintext'),
      error: null,
      externalChanged: false,
      preview: false,
      diff: {
        original: `${path}（本轮改动前）`,
        modified: path,
        originalContent,
        ...modifiedContent === undefined ? {} : { modifiedContent },
      },
      ...note !== undefined ? { diffNote: note } : {},
    }
    setTabs(prev => [...prev, newTab])
    setActivePath(key)
  }, [tabs, showEditor])

  // 把 openFile / openContentDiff 暴露给 index.ts（corumEditor 服务的调用入口；
  // 写入触发 pending 认领）。同 bundle 内 ref 直通，非跨 bundle 共享可变状态，
  // 不违反 cordis 红线。
  useEffect(() => {
    editorApi.openFile = openFile
    editorApi.openContentDiff = openContentDiff
    return () => { editorApi.openFile = null; editorApi.openContentDiff = null }
  }, [editorApi, openFile, openContentDiff])

  /**
   * diff 布局偏好：左右并排（true）还是内联单栏（false）。
   * 持久化在 localStorage —— 与 tab 无关的编辑器级偏好，刷新/重启后保持。
   * 默认**并排**（2026-09-11 用户定调：切到左右视图对比）。
   */
  const [diffSideBySide, setDiffSideBySide] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(DIFF_SIDE_BY_SIDE_KEY)
      return raw === null ? true : raw === '1'
    } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem(DIFF_SIDE_BY_SIDE_KEY, diffSideBySide ? '1' : '0') } catch { /* 容量满等：退回会话内记忆 */ }
  }, [diffSideBySide])

  /** 固定预览 tab（双击 tab / 编辑后 / 双击树文件）。 */
  const pinTab = useCallback((path: string) => {
    setTabs(prev => prev.map(t => t.path === path && t.preview ? { ...t, preview: false } : t))
  }, [])

  /** 源码 ⟷ 预览切换（md/svg tab；VS Code Ctrl+Shift+V 语义）。 */
  const toggleViewMode = useCallback((path: string) => {
    setTabs(prev => prev.map(t => t.path === path && (t.kind === 'markdown' || t.kind === 'svg')
      ? { ...t, viewMode: t.viewMode === 'preview' ? 'source' : 'preview' }
      : t,
    ))
  }, [])

  /** 打开 diff tab（VS Code「与已选项目比较」）：只读双侧 diff，内容立即从
   *  磁盘读取。已存在同对 tab 则激活。 */
  const openDiffTab = useCallback(async (original: string, modified: string) => {
    showEditor()
    const path = diffTabPath(original, modified)
    if (tabs.some(t => t.path === path)) {
      setActivePath(path)
      return
    }
    const nameA = original.split('/').pop() ?? original
    const nameB = modified.split('/').pop() ?? modified
    const newTab: EditorTab = {
      path,
      title: `${nameA} ↔ ${nameB}`,
      content: '',
      savedContent: '',
      language: languageFromPath(modified, 'plaintext'),
      error: null,
      externalChanged: false,
      preview: false,
      diff: { original, modified },
    }
    setTabs(prev => [...prev, newTab])
    setActivePath(path)
    // 读两侧内容（原文=original，新文=modified）。失败标 error。
    try {
      const [ra, rb] = await Promise.all([readFile(original), readFile(modified)])
      if (!ra.ok || ra.value === undefined) throw new Error(`无法读取 ${original}：${ra.error?.message ?? '未知'}`)
      if (!rb.ok || rb.value === undefined) throw new Error(`无法读取 ${modified}：${rb.error?.message ?? '未知'}`)
      // diff tab 内容不由 content 字段驱动（DiffViewer 直接 readFile），此处仅占位语言。
      setTabs(prev => prev.map(t => t.path === path ? { ...t, language: rb.value!.language || t.language } : t))
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === path ? { ...t, error: String(err) } : t))
    }
  }, [tabs, readFile, showEditor])

  /**
   * 打开「改动前后」diff tab（Review 卡点击文件行）。
   *
   * 与 openDiffTab 的区别：左侧不是磁盘文件，而是 host 侧逆序反推重建出的原文
   * （来自 host 影子 git 仓库 corumReview/fileBefore —— 轮次起始状态都提交过，故精确）。
   * 右侧仍是磁盘当前文件，所以只需要 `path` 一个路径。
   *
   * `note` 非空表示重建不完整（该文件被整文件覆盖写过等），作为横幅提示如实
   * 告知用户「左侧是尽力重建、可能不等于会话开始时的内容」。
   */
  /** Close a tab. If dirty, confirm first (save / discard / cancel). */
  const closeTab = useCallback((path: string) => {
    const doClose = (): void => {
      setTabs(prev => {
        const idx = prev.findIndex(t => t.path === path)
        if (idx < 0) return prev
        const next = prev.filter(t => t.path !== path)
        // If closing the active tab, switch to the neighbour.
        if (activePath === path) {
          const neighbour = next[idx] ?? next[idx - 1] ?? null
          setActivePath(neighbour?.path ?? null)
        }
        return next
      })
      // Release the Monaco model for the closed tab (undo stack is dropped with it).
      setDisposePaths([path])
    }
    const tab = tabs.find(t => t.path === path)
    if (tab === undefined) return
    if (tab.content !== tab.savedContent) {
      setDialog({
        kind: 'confirm',
        title: '关闭标签页',
        message: `「${tab.title}」有未保存的修改。`,
        warning: '关闭将丢弃这些修改。',
        confirmLabel: '仍要关闭',
        danger: true,
        onConfirm: doClose,
      })
      return
    }
    doClose()
  }, [tabs, activePath])

  /** Update content when the user types in Monaco (dirty = differs from disk baseline).
   *  编辑预览 tab → 自动固定（VS Code 语义）。 */
  const onContentChange = useCallback((newContent: string) => {
    if (activePath === null || isExternalPreviewPath(activePath)) return
    setTabs(prev => prev.map(t => {
      if (t.path !== activePath) return t
      if (t.content === newContent) return t
      return { ...t, content: newContent, externalChanged: false, preview: false }
    }))
  }, [activePath])

  /** Save the active file (⌘S). */
  const saveActive = useCallback(async () => {
    if (activeTab === null || activeTab.diff !== undefined || isExternalPreviewPath(activeTab.path)) return
    if (activeTab.content === activeTab.savedContent) {
      flashSaveFeedback({ kind: 'saved' }, 1600)
      return
    }
    flashSaveFeedback({ kind: 'saving' })
    try {
      const result = await writeFile(activeTab.path, activeTab.content)
      if (result.ok) {
        setTabs(prev => prev.map(t => t.path === activeTab.path ? { ...t, savedContent: t.content, externalChanged: false } : t))
        flashSaveFeedback({ kind: 'saved' }, 1600)
      } else {
        const msg = result.error?.message ?? '未知错误'
        console.error('[editor] 保存失败', activeTab.path, msg)
        flashSaveFeedback({ kind: 'failed', message: msg })
      }
    } catch (err) {
      console.error('[editor] 保存异常', activeTab.path, err)
      flashSaveFeedback({ kind: 'failed', message: String(err) })
    }
  }, [activeTab, writeFile, flashSaveFeedback])

  // ⌘S keyboard shortcut for save. Monaco 编辑器内由 Monaco keybinding service
  // 处理（MonacoEditor 注册 addCommand）；编辑器外（文件树聚焦等）由本 window
  // 监听兜底。capture 阶段拦 ⌘S 不影响 Monaco 的其他 ⌘ 组合键（只 match 's'）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void saveActive()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [saveActive])

  // 编辑器快捷键兜底：Monaco keybinding service 只在编辑器 focus 时响应。
  // 编辑器未 focus（文件树/侧栏聚焦）时，常用编辑快捷键（⌘F 查找 / ⌘Z 撤销 /
  // ⌘⇧Z 重做）应自动 focus 编辑器再放行（VS Code 行为：这些命令全局可用）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 编辑器已 focus → Monaco 自己处理，不干预。
      const monacoHost = document.querySelector('[data-monaco-editor]')
      if (monacoHost !== null && monacoHost.contains(document.activeElement)) return
      const isEditorCmd = (e.metaKey || e.ctrlKey) && !e.altKey && (
        e.key === 'f' ||           // ⌘F 查找
        (e.key === 'z' && !e.shiftKey) ||  // ⌘Z 撤销
        (e.key === 'z' && e.shiftKey) ||   // ⌘⇧Z 重做
        e.key === 'a'              // ⌘A 全选
      )
      if (!isEditorCmd) return
      // 有打开的文件才兜底（空态无编辑器实例）。
      if (activeTabRef.current === null) return
      e.preventDefault()
      // focus 编辑器 + 直接触发 Monaco command（keydown 已派发完，Monaco 接不到
      // 同一事件；用 editor.trigger 走 command 层，语义与 keybinding 一致）。
      const editContext = monacoHost?.querySelector('.native-edit-context, textarea.inputarea') as HTMLElement | null
      editContext?.focus()
      // P2-1：同 bundle 模块引用桥（替代 window.__corumMonacoEditor）。
      const monacoInstance = getCorumMonacoInstance()
      if (monacoInstance !== undefined) {
        const cmd = e.key === 'f' ? 'actions.find' : e.key === 'z' && !e.shiftKey ? 'undo' : e.key === 'z' && e.shiftKey ? 'redo' : 'editor.action.selectAll'
        monacoInstance.trigger('keyboard', cmd)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // activeTab ref（快捷键兜底判空态用，避免闭包捕获陈旧值）
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  // ── fs watch：启动 + 主路径 $on 推送；变更 → 树刷新 + tab 外部变更检测 ──
  // tabsRef 避免闭包捕获陈旧 tabs
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  useEffect(() => {
    void startWatch()
    // 变更处理（$on 推送帧）：树局部刷新 + 已打开 tab 的外部变更检测
    // （未 dirty 自动重载 / 已 dirty 状态栏标「磁盘已更改」）。
    const applyChanges = (changes: { path: string; kind: 'rename' | 'change' }[]): void => {
      if (changes.length === 0) return
      setTreeRefreshGen(g => g + 1)
      // 已打开 tab 的外部变更检测
      for (const change of changes) {
        const p = change.path
        const tab = tabsRef.current.find(t => t.path === p)
        if (tab === undefined) continue
        if (tab.content === tab.savedContent) {
          // 未 dirty → 自动重载磁盘内容（图片/视频 tab 无文本内容，跳过）
          if (tab.kind === 'image' || tab.kind === 'video') continue
          readFile(p).then((r) => {
            if (r.ok && r.value !== undefined) {
              setTabs(prev => prev.map(t => t.path === p
                ? { ...t, content: r.value!.content, savedContent: r.value!.content, language: r.value!.language || t.language, externalChanged: false }
                : t,
              ))
            }
          }).catch(() => { /* 文件可能已被删除，忽略 */ })
        } else {
          // dirty → 标记外部变更（状态栏警告，不覆盖用户编辑）
          setTabs(prev => prev.map(t => t.path === p ? { ...t, externalChanged: true } : t))
        }
      }
    }

    // 统一事件中心推送路径（唯一）：host corumFs 在 watcher 去抖回调 emit 批量
    // changes → 官方 forwarded-Remote-event 通道 → 本 listener（真实推送）。
    // 三期删 2s poll 降级兜底（host/renderer 同一构建产物，「旧 host 不 emit」
    // 永不发生；观测面 window.__corumEventStats）。
    let disposed = false
    const disposePush = onFileChanged(({ changes }) => {
      if (disposed) return
      applyChanges(changes)
    })

    // 断链补帧（文件侧）：连接 generation 变化（重连）后，把「断链窗口内错过的
    // corum/file/changed 帧」用一次全量补读替代——整树刷新 + 重读所有已打开文本
    // tab（dirty 的只标外部变更，不覆盖编辑）。generation 是官方连接服务的
    // 握手代际源（每次重连 +1）。
    let lastGeneration = explorer.generation.getSnapshot()
    const disposeGeneration = explorer.generation.subscribe(() => {
      const next = explorer.generation.getSnapshot()
      if (next === lastGeneration) return
      lastGeneration = next
      if (disposed) return
      applyChanges(tabsRef.current
        .filter(t => t.kind !== 'image' && t.kind !== 'video')
        .map(t => ({ path: t.path, kind: 'change' as const })))
    })

    return () => {
      disposed = true
      disposePush()
      disposeGeneration()
    }
  }, [startWatch, readFile, onFileChanged, explorer.generation])

  // Sash drag (resource manager width).
  const sashDragWidth = useRef(EXPLORER_DEFAULT_WIDTH)
  sashDragWidth.current = explorerWidth
  const onSashMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    let origin = e.clientX
    const style = document.createElement('style')
    style.textContent = '* { cursor: col-resize !important; user-select: none !important; -webkit-user-select: none !important; }'
    document.head.appendChild(style)
    const onMove = (ev: MouseEvent) => {
      ev.preventDefault()
      const delta = ev.clientX - origin
      origin = ev.clientX
      const next = Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, sashDragWidth.current - delta))
      sashDragWidth.current = next
      setExplorerWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      style.remove()
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
  }, [])

  // The Monaco model for the active tab.
  const monacoFile = useMemo(() => {
    if (activeTab === null) return null
    return {
      path: activeTab.path,
      value: activeTab.content,
      language: activeTab.language,
    }
  }, [activeTab])

  const activeDirty = activeTab !== null && activeTab.content !== activeTab.savedContent

  // ── 文件树联动回调 ──
  /** 新建文件（tree-header 钮 / 右键菜单）：父目录下创建空文件并打开。 */
  const onCreateFile = useCallback(async (parentDir: string, name: string) => {
    const path = parentDir === '/' ? `/${name}` : `${parentDir}/${name}`
    const result = await writeFile(path, '')
    if (result.ok) {
      setTreeRefreshGen(g => g + 1)
      // 新文件直接打开
      void openFile(path)
    } else {
      console.error('[explorer] 新建文件失败', path, result.error?.message)
      showError(`新建文件失败：${result.error?.message ?? '未知错误'}`)
    }
  }, [writeFile, openFile, showError])

  /** 新建文件夹。 */
  const onCreateFolder = useCallback(async (parentDir: string, name: string) => {
    const path = parentDir === '/' ? `/${name}` : `${parentDir}/${name}`
    const result = await mkdirp(path)
    if (result.ok) {
      setTreeRefreshGen(g => g + 1)
    } else {
      console.error('[explorer] 新建文件夹失败', path, result.error?.message)
      showError(`新建文件夹失败：${result.error?.message ?? '未知错误'}`)
    }
  }, [mkdirp, showError])

  /** 删除文件/文件夹。若文件已打开，关闭其 tab。 */
  const onDeletePath = useCallback(async (path: string, isDir: boolean) => {
    const name = path.split('/').pop() ?? path
    const doDelete = async (): Promise<void> => {
      const result = await deletePath(path)
      if (result.ok) {
        setTreeRefreshGen(g => g + 1)
        // 已打开的 tab（含目录下所有文件）关闭
        setTabs(prev => {
          const toClose = prev.filter(t => t.path === path || t.path.startsWith(`${path}/`))
          if (toClose.length > 0) {
            setDisposePaths(toClose.map(t => t.path))
            const remaining = prev.filter(t => !(t.path === path || t.path.startsWith(`${path}/`)))
            if (activePath !== null && !remaining.some(t => t.path === activePath)) {
              setActivePath(remaining[remaining.length - 1]?.path ?? null)
            }
            return remaining
          }
          return prev
        })
      } else {
        console.error('[explorer] 删除失败', path, result.error?.message)
        showError(`删除失败：${result.error?.message ?? '未知错误'}`)
      }
    }
    setDialog({
      kind: 'confirm',
      title: `删除${isDir ? '文件夹' : '文件'}`,
      message: `确定删除${isDir ? '文件夹' : '文件'}「${name}」？`,
      ...(isDir ? { warning: '目录内所有内容将被删除。' } : {}),
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => { void doDelete() },
    })
  }, [deletePath, activePath, showError])

  /** 重命名文件/文件夹（newName = 新文件名，同目录改名）。已打开 tab 路径同步更新。 */
  const onRenamePath = useCallback(async (from: string, newName: string) => {
    const parent = from.slice(0, from.lastIndexOf('/'))
    const to = parent === '' ? `/${newName}` : `${parent}/${newName}`
    if (to === from) return
    await movePath(from, to)
  }, [renamePath])

  /** 复制文件/文件夹（VS Code「复制」+「粘贴」：同目录自动加「 副本」后缀，
   *  冲突再递增「 副本 2」…）。实现 = read + write（文本级复制；目录暂不支持
   *  递归复制——host 侧无 cp RPC，目录粘贴走 rename 分支不适用）。 */
  const onCopyPath = useCallback(async (from: string, toDir: string) => {
    const name = from.split('/').pop() ?? ''
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    const fromDir = from.slice(0, from.lastIndexOf('/')) || '/'
    const join = (n: string) => toDir === '/' ? `/${n}` : `${toDir}/${n}`
    // 同目录 → 「 副本」；跨目录 → 原名
    const candidate = toDir === fromDir ? join(`${stem} 副本${ext}`) : join(name)
    const readResult = await readFile(from)
    if (!readResult.ok || readResult.value === undefined) {
      showError(`复制失败：无法读取源文件（${readResult.error?.message ?? '未知错误'}）`)
      return
    }
    const result = await writeFile(candidate, readResult.value.content)
    if (result.ok) {
      setTreeRefreshGen(g => g + 1)
    } else {
      showError(`复制失败：${result.error?.message ?? '未知错误'}`)
    }
  }, [readFile, writeFile, showError])

  /** 「复制路径」数据源：corumFs/absolutePath RPC 取真实绝对路径。 */
  const getAbsolutePath = useCallback(async (path: string): Promise<string | null> => {
    const result = await absolutePath(path)
    if (result.ok && result.value !== undefined) return result.value.absolutePath
    showError(`无法获取绝对路径：${result.error?.message ?? '未知错误'}`)
    return null
  }, [absolutePath, showError])

  /** 「在 Finder 中显示」：corumFs/reveal RPC（host 侧 macOS `open -R`）。 */
  const revealInFinder = useCallback((path: string) => {
    void revealPath(path).then((result) => {
      if (!result.ok) showError(`无法在 Finder 中显示：${result.error?.message ?? '未知错误'}`)
    })
  }, [revealPath, showError])

  /** 「添加到对话」：把文件以 @引用 形式加入当前会话草稿（conversation
   *  cordis service 注入面直通；与手打 @-mention 同构，agent 侧读文件）。 */
  const onAddToChat = useCallback((path: string) => {
    const result = addToConversation(path)
    if (!result.ok) {
      showError(`添加到对话失败：${result.error ?? '未知错误'}`)
    }
  }, [addToConversation, showError])

  /** 移动路径（跨目录拖拽 / 同目录重命名共用）。to = 完整目标路径。 */
  const movePath = useCallback(async (from: string, to: string) => {
    if (to === from) return
    const result = await renamePath(from, to)
    if (result.ok) {
      setTreeRefreshGen(g => g + 1)
      const newTitle = to.split('/').pop() ?? to
      // 已打开 tab 路径同步（含目录下所有文件）
      setTabs(prev => prev.map(t => {
        if (t.path === from) {
          return { ...t, path: to, title: newTitle }
        }
        if (t.path.startsWith(`${from}/`)) {
          const newPath = to + t.path.slice(from.length)
          return { ...t, path: newPath, title: newPath.split('/').pop() ?? t.title }
        }
        return t
      }))
      setActivePath(prev => {
        if (prev === from) return to
        if (prev !== null && prev.startsWith(`${from}/`)) return to + prev.slice(from.length)
        return prev
      })
    } else {
      console.error('[explorer] 移动失败', from, '→', to, result.error?.message)
      showError(`移动失败：${result.error?.message ?? '未知错误'}`)
    }
  }, [renamePath, showError])

  /** tab 激活 → 文件树自动展开父级目录。 */
  useEffect(() => {
    if (activePath === null || isExternalPreviewPath(activePath)) return
    // 自动展开所有父级目录
    const parts = activePath.split('/').filter(Boolean)
    const parents: string[] = []
    for (let i = 1; i < parts.length; i++) {
      parents.push('/' + parts.slice(0, i).join('/'))
    }
    setExpandedDirs(prev => {
      const missing = parents.filter(p => !prev.includes(p))
      return missing.length > 0 ? [...prev, ...missing] : prev
    })
  }, [activePath])

  // ── tab 拖拽排序 + 右键菜单 ──
  const [dragTabPath, setDragTabPath] = useState<string | null>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  // 右键菜单全局关闭
  useEffect(() => {
    if (tabMenu === null) return
    const onDown = () => setTabMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTabMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onDown)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onDown)
    }
  }, [tabMenu])

  /** 关闭其他 tab（保留指定 path + activePath）。 */
  const closeOtherTabs = useCallback((keepPath: string) => {
    setTabs(prev => {
      const closing = prev.filter(t => t.path !== keepPath && !(t.content !== t.savedContent))
      // dirty tab 不自动关（避免丢修改）——只关干净的
      if (closing.length > 0) setDisposePaths(closing.map(t => t.path))
      return prev.filter(t => t.path === keepPath || t.content !== t.savedContent)
    })
  }, [])

  /** 关闭右侧所有干净 tab。 */
  const closeTabsToRight = useCallback((path: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.path === path)
      if (idx < 0) return prev
      const right = prev.slice(idx + 1).filter(t => !(t.content !== t.savedContent))
      if (right.length > 0) setDisposePaths(right.map(t => t.path))
      return prev.filter((t, i) => i <= idx || t.content !== t.savedContent)
    })
    if (activePath !== null) {
      // active 在右侧被关 → 激活当前 path
      setActivePath(prev => {
        const stillThere = tabs.find(t => t.path === prev)
        if (stillThere === undefined) return prev
        return prev
      })
    }
  }, [tabs, activePath])

  /** 关闭所有干净 tab。 */
  const closeAllTabs = useCallback(() => {
    setTabs(prev => {
      const closing = prev.filter(t => !(t.content !== t.savedContent))
      if (closing.length > 0) setDisposePaths(closing.map(t => t.path))
      const remaining = prev.filter(t => t.content !== t.savedContent)
      if (activePath !== null && !remaining.some(t => t.path === activePath)) {
        setActivePath(remaining[remaining.length - 1]?.path ?? null)
      }
      return remaining
    })
  }, [activePath])

  return (
    <div className={css.column} data-code-editor-column="">
      <div className={css.editorMain}>
        {/* Editor Tabs（溢出横向滚动；tab 可拖拽排序；预览 tab 斜体） */}
        <div className={css.tabs}>
          {tabs.map((tab) => {
            const dirty = tab.content !== tab.savedContent
            return (
              <div
                key={tab.path}
                className={`${css.tab}${tab.path === activePath ? ` ${css.tabActive}` : ''}${tab.preview ? ` ${css.tabPreview}` : ''}${dragTabPath === tab.path ? ` ${css.tabDragging}` : ''}`}
                data-tab-active={tab.path === activePath || undefined}
                draggable
                onDragStart={(e) => {
                  setDragTabPath(tab.path)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', tab.path)
                }}
                onDragEnd={() => setDragTabPath(null)}
                onDragOver={(e) => {
                  if (dragTabPath !== null && dragTabPath !== tab.path) {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragTabPath === null || dragTabPath === tab.path) return
                  setTabs(prev => {
                    const fromIdx = prev.findIndex(t => t.path === dragTabPath)
                    const toIdx = prev.findIndex(t => t.path === tab.path)
                    if (fromIdx < 0 || toIdx < 0) return prev
                    const next = [...prev]
                    const [moved] = next.splice(fromIdx, 1)
                    next.splice(toIdx, 0, moved)
                    return next
                  })
                  setDragTabPath(null)
                }}
                onClick={() => setActivePath(tab.path)}
                onDoubleClick={() => pinTab(tab.path)}
                onAuxClick={(e) => {
                  // Middle-click closes the tab (VS Code semantics).
                  if (e.button === 1) {
                    e.preventDefault()
                    closeTab(tab.path)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setTabMenu({ x: e.clientX, y: e.clientY, path: tab.path })
                }}
              >
                {dirty && <span className={css.tabDirty} />}
                <span className={css.tabTitle}>{tab.title}</span>
                {(tab.kind === 'markdown' || tab.kind === 'svg') && (
                  <button
                    type="button"
                    className={css.tabViewModeBtn}
                    title={tab.viewMode === 'preview' ? '查看源码' : '预览'}
                    onClick={(e) => { e.stopPropagation(); toggleViewMode(tab.path) }}
                  >
                    {tab.viewMode === 'preview' ? <Code size={13} strokeWidth={2} /> : <Eye size={13} strokeWidth={2} />}
                  </button>
                )}
                <button
                  type="button"
                  className={css.tabCloseBtn}
                  title="关闭"
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.path) }}
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </div>
            )
          })}
          <div className={css.spacer} />
          {explorerCollapsed && (
            <button
              type="button"
              className={css.tbExpandExplorer}
              title="展开资源管理器"
              onClick={onToggleExplorerCollapsed}
            >
              <PanelRightOpen size={16} strokeWidth={2} />
            </button>
          )}
          {explorerCollapsed && (
            <button
              type="button"
              className={css.tbCloseExplorer}
              title="关闭此区域（可在插件中心「视图管理」恢复）"
              onClick={closeRegion}
            >
              <X size={17} strokeWidth={2} />
            </button>
          )}
        </div>
        {/* tab 右键菜单（自绘玻璃菜单，fixed 定位） */}
        {tabMenu !== null && (
          <div className={css.tabContextMenu} style={{ left: tabMenu.x, top: tabMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" className={css.tabMenuItem} onClick={() => { closeTab(tabMenu.path); setTabMenu(null) }}>关闭</button>
            <button type="button" className={css.tabMenuItem} onClick={() => { closeOtherTabs(tabMenu.path); setTabMenu(null) }}>关闭其他</button>
            <button type="button" className={css.tabMenuItem} onClick={() => { closeTabsToRight(tabMenu.path); setTabMenu(null) }}>关闭右侧所有</button>
            <div className={css.tabMenuDivider} />
            <button type="button" className={css.tabMenuItem} onClick={() => { closeAllTabs(); setTabMenu(null) }}>全部关闭</button>
          </div>
        )}

        {/* crumb（空态隐藏；父级段可点击 → 树中定位高亮该目录） */}
        {activeTab !== null && (
          <div className={css.crumb}>
            {(() => {
              if (isExternalPreviewPath(activeTab.path)) return <span className={css.crumbCurrent}>{activeTab.title}</span>
              const parts = activeTab.path.split('/').filter(Boolean)
              return parts.map((part, i) => {
                const isLast = i === parts.length - 1
                const segPath = '/' + parts.slice(0, i + 1).join('/')
                return (
                  <span key={segPath}>
                    {i > 0 && <span className={css.crumbSep}> › </span>}
                    {isLast
                      ? <span className={css.crumbCurrent}>{part}</span>
                      : (
                        <button
                          type="button"
                          className={css.crumbLink}
                          onClick={() => {
                            // 父级目录 → 树中定位（展开 + 高亮 + scrollIntoView）
                            setExpandedDirs(prev => {
                              const parents: string[] = []
                              for (let j = 1; j <= i; j++) parents.push('/' + parts.slice(0, j).join('/'))
                              const missing = parents.filter(p => !prev.includes(p))
                              return missing.length > 0 ? [...prev, ...missing] : prev
                            })
                            // 高亮定位（临时把 activeFilePath 指到该目录——树选中态由 activeFilePath 驱动）
                            // 目录不能打开为 tab，所以用 scrollIntoView 直接定位
                            requestAnimationFrame(() => {
                              document.querySelector(`[data-tree-path="${CSS.escape(segPath)}"]`)?.scrollIntoView({ block: 'nearest' })
                            })
                          }}
                        >
                          {part}
                        </button>
                      )}
                  </span>
                )
              })
            })()}
          </div>
        )}

        {/* Code（diff tab → DiffViewer；预览态 md/svg/图片/视频 → PreviewView；普通 tab → MonacoEditor） */}
        <div className={css.code}>
          {activeTab?.diff !== undefined
            ? (
              <>
                {/* diff 工具条：布局切换（并排 / 内联）。偏好持久化，跨 tab 与重启保持。 */}
                <div className={css.diffBar}>
                  <button
                    type="button"
                    className={css.diffToggle}
                    aria-pressed={diffSideBySide}
                    title={diffSideBySide ? '切换为内联单栏' : '切换为左右并排对比'}
                    onClick={() => { setDiffSideBySide(v => !v) }}
                  >
                    {diffSideBySide ? '左右并排' : '内联单栏'}
                  </button>
                </div>
                {/* 重建不完整时的如实提示（该文件被整文件覆盖写过等）：
                    避免用户把「尽力重建的左侧」误当成会话开始时的原文。 */}
                {activeTab.diffNote !== undefined && (
                  <div className={css.diffNote} role="status">{activeTab.diffNote}</div>
                )}
                <DiffViewer
                  key={activeTab.path}
                  original={activeTab.diff.original}
                  modified={activeTab.diff.modified}
                  originalContent={activeTab.diff.originalContent}
                  modifiedContent={activeTab.diff.modifiedContent}
                  language={activeTab.language}
                  readFile={readFile}
                  dark={dark}
                  sideBySide={diffSideBySide}
                />
              </>
            )
            : activeTab !== null && activeTab.kind === 'image'
            ? <ImagePreview key={`${activeTab.path}:${activeTab.previewRevision ?? 0}`} path={activeTab.path} title={activeTab.title} readBinary={readBinary} />
            : activeTab !== null && activeTab.kind === 'video'
            ? <VideoPreview key={`${activeTab.path}:${activeTab.previewRevision ?? 0}`} path={activeTab.path} title={activeTab.title} />
            : activeTab !== null && activeTab.viewMode === 'preview' && activeTab.kind === 'markdown'
            ? <MarkdownPreview key={activeTab.path} text={activeTab.content} />
            : activeTab !== null && activeTab.viewMode === 'preview' && activeTab.kind === 'svg'
            ? <SvgPreview key={activeTab.path} text={activeTab.content} title={activeTab.title} />
            : monacoFile !== null
            ? (
              <MonacoEditor
                file={monacoFile}
                dark={dark}
                className="corum-code-editor"
                editable={!isExternalPreviewPath(monacoFile.path)}
                onContentChange={onContentChange}
                onCursorChange={setCursorPos}
                disposePaths={disposePaths}
              />
            )
            : (
              <div className={css.emptyCode}>选择或打开一个文件开始编辑</div>
            )}
        </div>
        {activeTab?.error !== undefined && activeTab.error !== null && (
          <div className={css.loadError}>加载失败：{activeTab.error}</div>
        )}

        {/* Editor Status（空态隐藏；diff tab 只读无保存态） */}
        {activeTab !== null && (
          <div className={css.status}>
            <span>行 {cursorPos.line}, 列 {cursorPos.column}</span>
            <span>UTF-8</span>
            <span>{activeTab.language}</span>
            {isExternalPreviewPath(activeTab.path) && <span className={css.savedText}>外部文件 · 只读</span>}
            {activeTab.viewMode === 'preview' && (activeTab.kind === 'markdown' || activeTab.kind === 'svg') && (
              <span className={css.savedText}>预览</span>
            )}
            {activeTab.kind === 'image' && <span className={css.savedText}>图片</span>}
            {activeTab.kind === 'video' && <span className={css.savedText}>视频</span>}
            {activeTab.diff !== undefined && <span className={css.savedText}>只读对比</span>}
            {activeTab.externalChanged && activeDirty && (
              <span className={css.externalChangedText} title="磁盘上的文件已被外部修改；保存将覆盖磁盘版本">⚠ 磁盘已更改</span>
            )}
            <div className={css.statusSpacer} />
            {saveFeedback?.kind === 'saving' && <span className={css.savingText}>保存中…</span>}
            {saveFeedback?.kind === 'saved' && !activeDirty && <span className={css.savedText}>已保存</span>}
            {saveFeedback?.kind === 'failed' && (
              <span className={css.saveFailedText} title={saveFeedback.message}>保存失败：{saveFeedback.message}</span>
            )}
            {activeDirty && (
              <>
                <span className={css.dirtyDot} />
                <span className={css.dirtyText}>未保存</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Sash + divider + explorer (hidden when collapsed). */}
      {!explorerCollapsed && (
        <>
          <div className={css.sash} onMouseDown={onSashMouseDown} data-explorer-sash="" />
          <div className={css.divider} />
          <div className={css.explorerPane} style={{ width: explorerWidth }}>
            <ExplorerPane
              listDir={explorer.listDir}
              generation={explorer.generation}
              workspaceRoot={explorer.workspaceRoot}
              closeRegion={closeRegion}
              onToggleCollapsed={onToggleExplorerCollapsed}
              onOpenFile={openFile}
              activeFilePath={activePath}
              expandedPaths={expandedDirs}
              onExpandedChange={setExpandedDirs}
              refreshGen={treeRefreshGen}
              onCreateFile={onCreateFile}
              onCreateFolder={onCreateFolder}
              onDeletePath={onDeletePath}
              onRenamePath={onRenamePath}
              onMovePath={movePath}
              onCopyPath={onCopyPath}
              getAbsolutePath={getAbsolutePath}
              revealInFinder={revealInFinder}
              onCompare={openDiffTab}
              onAddToChat={onAddToChat}
            />
          </div>
        </>
      )}

      {/* 统一弹窗（替原生 alert/confirm）：confirm=确认执行 / info=错误告知。 */}
      {dialog !== null && (
        dialog.kind === 'confirm'
          ? (
            <ConfirmDialog
              title={dialog.title}
              message={dialog.message}
              {...(dialog.warning !== undefined ? { warning: dialog.warning } : {})}
              tone={dialog.danger === false ? 'primary' : 'danger'}
              confirmLabel={dialog.confirmLabel}
              onConfirm={() => { const fn = dialog.onConfirm; setDialog(null); fn() }}
              onCancel={() => { setDialog(null) }}
            />
          )
          : (
            <ConfirmDialog
              kind="info"
              tone="primary"
              title={dialog.title}
              message={dialog.message}
              onCancel={() => { setDialog(null) }}
            />
          )
      )}
    </div>
  )
}
