/**
 * ExplorerPane — the IDE resource manager, embedded as a sub-pane inside the
 * merged ③ 编辑器区 card (design.pen WJ4dP, 2026-09-03 改版：编辑器+资源管理器
 * 合一张玻璃卡，不再是独立区域/槽位). Structure follows the design frame:
 *
 *   explorer-titlebar (kKDmJ: 标题「资源管理器」13/600 + spacer +
 *     btn-toggle-explorer 20×20 panel-right-close 16 +
 *     tb-close 20×20 x 17) —— 两个按钮始终显示；
 *   tree-header (WbdhK: chevron-down 17 + 根名 16/700 + file-plus/folder-plus/
 *     rotate-cw/list-collapse 四个 20×20 工具钮；× 已上移到 titlebar)；
 *   tree-body (QdSbb: VS Code 风格树，chevron + folder/file 类型着色图标 +
 *     每级 14px 缩进 + 选中态 glass-2 加粗).
 *
 * Data comes from the host fs RPC (corumFs/list, rooted at the host project
 * cwd) via the official connection.rpc; the tree-header root name rides the
 * connection generation's host facts (host cwd basename, when published).
 *
 * 第十六轮（2026-09-04）：
 * - expandedPaths 受控（EditorColumn 持有 + 持久化）；tab 激活自动展开父级。
 * - activeFilePath → 树选中同步 + scrollIntoView；树选中清空 → 通知 EditorColumn。
 * - refreshGen bump → 局部刷新所有已展开目录（watch/新建/删除/重命名触发）。
 * - 右键菜单（自绘玻璃菜单，design 无稿按 corum 菜单语言）：文件（打开/重命名/
 *   删除）；目录（新建文件/新建文件夹/重命名/删除/刷新）。重命名行内 input；
 *   删除由 EditorColumn confirm。
 * - tree-header 新建文件/文件夹钮接通（在选中目录下创建，未选中在根）。
 *
 * 折叠态（design waRkJ）由 EditorColumn 处理：折叠时不渲染本组件（无 32px
 * 竖条），展开/关闭按钮移入 Editor Tabs 行尾。本组件只负责展开态渲染。
 * @module corum-desktop/client/editor/ExplorerPane
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import {
  Braces, ChevronDown, ChevronRight, FileCode, FileCog, FilePlus, FileText,
  Folder, FolderOpen, FolderPlus, Link, ListCollapse, Lock, PanelRightClose,
  RotateCw, Search, X,
} from 'lucide-react'
import css from './ExplorerPane.module.css'

/** One directory entry returned by corumFs/list. */
export interface FsEntry {
  name: string
  type: 'dir' | 'file'
}

/** Injected actions (see corum-desktop/src/client/index.ts apply). */
export interface ExplorerPaneInjected {
  listDir: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { entries: FsEntry[] } }>
  /** 连接 generation 源（每次连接握手后发布；host.cwd basename = 工作区根名）。 */
  generation: ConnectionGenerationState
  /** 当前工作区根只读快照（初始挂载读；事件可能先于挂载丢失，快照是可靠初始态）。 */
  workspaceRoot: { get: () => { root: string | null; rootName: string | null } } | undefined
  /** 关闭整个编辑器区域（直通 ctx.layout.closeRegion('corum.editor')）。 */
  /** 收起资源管理器子面板（design waRkJ：折叠 = 子面板完全消失）。 */
  onToggleCollapsed: () => void
  /** 点击文件 → 编辑器打开 tab（核心联动）。preview=斜体临时 tab；pin=固定已有预览。 */
  onOpenFile: (path: string, opts?: { preview?: boolean; pin?: boolean }) => void
  /** 编辑器当前激活文件路径（树选中同步 + scrollIntoView）。 */
  activeFilePath: string | null
  /** 展开的目录路径（受控，EditorColumn 持久化）。 */
  expandedPaths: readonly string[]
  /** 展开态变化（用户 chevron 点击）。 */
  onExpandedChange: (paths: string[]) => void
  /** 刷新生成号（watch/新建/删除/重命名 bump → 局部重载已展开目录）。 */
  refreshGen: number
  /** 新建文件（父目录 + 文件名）。 */
  onCreateFile: (parentDir: string, name: string) => void
  /** 新建文件夹（父目录 + 文件夹名）。 */
  onCreateFolder: (parentDir: string, name: string) => void
  /** 删除路径（EditorColumn confirm + tab 联动）。 */
  onDeletePath: (path: string, isDir: boolean) => void
  /** 重命名路径（EditorColumn RPC + tab 路径同步）。 */
  onRenamePath: (from: string, newName: string) => void
  /** 移动路径（跨目录拖拽；to = 完整目标路径）。 */
  onMovePath: (from: string, to: string) => void
  /** 复制文件/目录（VS Code「复制」+「粘贴」语义：同目录自动加「 副本」后缀）。 */
  onCopyPath: (from: string, toDir: string) => void
  /** 取绝对路径（「复制路径」菜单项；内部写剪贴板）。 */
  getAbsolutePath: (path: string) => Promise<string | null>
  /** 在系统文件管理器中显示（macOS Finder -R 揭示）。 */
  revealInFinder: (path: string) => void
  /** 打开 diff 对比 tab（VS Code「与已选项目比较」；original=先选，modified=后选）。 */
  onCompare: (original: string, modified: string) => void
  /** 把文件加入当前对话上下文（cordis 事件桥；会话插件消费）。 */
  onAddToChat: (path: string) => void
}

export type ExplorerPaneProps = ExplorerPaneInjected

/** 写系统剪贴板（降级链：navigator.clipboard → execCommand 兜底）。 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Electron renderer 无焦点时 clipboard API 可能拒——execCommand 兜底。
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch { /* ignore */ }
    document.body.removeChild(ta)
    return ok
  }
}

/** 工作区根名：generation host facts 里 cwd 的 basename，取不到时回退设计默认。 */
function rootNameFromGeneration(generationState: ConnectionGenerationState): string {
  const generation = generationState.getSnapshot()
  const host = generation?.host as { home?: unknown; cwd?: unknown } | undefined
  const cwd = host?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const base = cwd.split(/[\\/]/).filter(Boolean).pop()
    if (base !== undefined && base !== '') return base
  }
  return 'dsh'
}

/** Join a relative path under the root ('/' = root). */
function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/** 文件扩展名 → 类型着色图标（design ④ 文件图标着色规则）。 */
export function FileTypeIcon({ name }: { name: string }) {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const base = dot > 0 ? lower.slice(0, dot) : lower
  const ext = dot >= 0 ? lower.slice(dot) : ''
  const cls = css.fileIcon
  if (base === '.env' || ext === '.env' || lower.startsWith('.env')) {
    return <Lock size={18} strokeWidth={2} className={cls} data-tone="env" />
  }
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
      return <FileCode size={18} strokeWidth={2} className={cls} data-tone="code" />
    case '.md':
      return <FileText size={18} strokeWidth={2} className={cls} data-tone="md" />
    case '.json':
      return <Braces size={18} strokeWidth={2} className={cls} data-tone="json" />
    case '.yml':
    case '.yaml':
      return <FileCog size={18} strokeWidth={2} className={cls} data-tone="yml" />
    default:
      return <FileCode size={18} strokeWidth={2} className={cls} data-tone="code" />
  }
}

/** 右键菜单状态。blank=true 表示空白区（tree-body）菜单，无 path。 */
interface ContextMenuState {
  x: number
  y: number
  path: string
  isDir: boolean
  /** 空白区菜单（新建/粘贴/刷新/折叠全部）。 */
  blank?: boolean
}

/** 行内重命名状态。 */
interface RenamingState {
  path: string
  draft: string
}

/** The resource manager sub-pane (see module doc). */
export function ExplorerPane({ listDir, generation, workspaceRoot, onToggleCollapsed, onOpenFile, activeFilePath, expandedPaths, onExpandedChange, refreshGen, onCreateFile, onCreateFolder, onDeletePath, onRenamePath, onMovePath, onCopyPath, getAbsolutePath, revealInFinder, onCompare, onAddToChat }: ExplorerPaneProps) {
  const [rootEntries, setRootEntries] = useState<FsEntry[] | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  useSyncExternalStore(generation.subscribe, generation.getSnapshot)
  /** Path → children entries cache (lazy; undefined key = not loaded). */
  const [dirCache, setDirCache] = useState<Record<string, FsEntry[] | undefined>>({})
  /** 展开集合（受控 prop 的本地 Set 镜像，便于 O(1) 查询）。 */
  const expanded = new Set(expandedPaths)
  /** Paths with an in-flight load (avoid duplicate fetches). */
  const [loading, setLoading] = useState<Set<string>>(() => new Set())
  /** 右键菜单。 */
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  /** 行内重命名。 */
  const [renaming, setRenaming] = useState<RenamingState | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  /** 树容器（scrollIntoView 作用域 + 键盘导航 focus）。 */
  const treeBodyRef = useRef<HTMLDivElement | null>(null)
  /** 多选集合（⌘Click 切换 / ⇧Click 范围选；键盘导航的「焦点」= 最后选中项）。 */
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  /** 范围选锚点（⇧Click 的起点）。 */
  const anchorRef = useRef<string | null>(null)
  /** 拖拽移动中的路径。 */
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** 剪贴板（VS Code 复制/剪切 + 粘贴语义；仅本面板内有效）。 */
  const [clipboard, setClipboard] = useState<{ path: string; cut: boolean } | null>(null)
  /** 「选择以进行比较」的已选文件（VS Code 语义：右键 A 选择以进行比较 →
   *  右键 B 出现「与已选项目比较」）。 */
  const [compareSource, setCompareSource] = useState<string | null>(null)
  // 由按项目 key 挂载的 EditorColumn 提供，根切换成功后才挂载文件树。
  const workspaceRootName = workspaceRoot?.get().rootName ?? null
  const noWorkspace = workspaceRoot?.get().root === null

  /** 树头根名：工作区同步的根名优先，回退 generation host cwd basename。 */
  const rootName = workspaceRootName ?? rootNameFromGeneration(generation)

  const loadDir = useCallback((path: string): void => {
    setLoading((prev) => new Set(prev).add(path))
    listDir(path).then((result) => {
      setDirCache((c) => ({ ...c, [path]: result.ok ? result.value?.entries : undefined }))
      if (path === '/') {
        if (result.ok && result.value !== undefined) {
          setRootEntries(result.value.entries)
          setRootError(null)
        } else {
          setRootError(result.error?.message ?? '无法读取项目根目录')
        }
      }
    }).catch(() => {
      setDirCache((c) => ({ ...c, [path]: undefined }))
    }).finally(() => {
      setLoading((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    })
  }, [listDir])

  const loadRoot = useCallback((): void => {
    loadDir('/')
  }, [loadDir])

  // Load the project root once（空态跳过——未打开项目时根目录无意义）。
  useEffect(() => {
    if (noWorkspace) return
    loadRoot()
  }, [loadRoot, noWorkspace])

  // 「展开但未缓存」的目录一律补 loadDir（声明式，非 mount 一次性——
  // 关浮窗/区域重挂载后 expandedPaths 持久化含展开目录、dirCache 空，且
  // EditorColumn 的 expandedDirs 从 localStorage 恢复有先后，mount 时可能
  // 还是空；渲染期每次检查，展开目录缺缓存即补，children===undefined 不再
  // 滞留成「加载失败」）。
  useEffect(() => {
    if (noWorkspace) return
    for (const p of expandedPaths) {
      if (dirCache[p] === undefined && !loading.has(p)) loadDir(p)
    }
  }, [expandedPaths, dirCache, loading, noWorkspace, loadDir])

  // refreshGen bump → 重载根 + 所有已展开目录（局部刷新）。
  const refreshGenRef = useRef(refreshGen)
  useEffect(() => {
    if (refreshGen === refreshGenRef.current) return
    refreshGenRef.current = refreshGen
    loadDir('/')
    for (const p of expandedPaths) {
      loadDir(p)
    }
  }, [refreshGen, expandedPaths, loadDir])

  const toggle = useCallback((path: string): void => {
    const next = new Set(expandedPaths)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      // 未缓存才加载
      if (dirCache[path] === undefined) {
        loadDir(path)
      }
    }
    onExpandedChange(Array.from(next))
  }, [expandedPaths, dirCache, loadDir, onExpandedChange])

  const collapseAll = useCallback((): void => {
    onExpandedChange([])
  }, [onExpandedChange])

  // tab 激活 → 树选中 scrollIntoView（选中态由 activeFilePath 直接驱动渲染）。
  useEffect(() => {
    if (activeFilePath === null || treeBodyRef.current === null) return
    const el = treeBodyRef.current.querySelector(`[data-tree-path="${CSS.escape(activeFilePath)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeFilePath])

  // 右键菜单：全局点击/Escape 关闭。
  useEffect(() => {
    if (contextMenu === null) return
    const onDown = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onDown)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onDown)
    }
  }, [contextMenu])

  // 重命名 input 自动 focus + 选中主名（不含扩展名）。
  useEffect(() => {
    if (renaming === null || renameInputRef.current === null) return
    const input = renameInputRef.current
    input.focus()
    const dot = renaming.draft.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : renaming.draft.length)
  }, [renaming])

  const commitRename = useCallback(() => {
    if (renaming === null) return
    const name = renaming.draft.trim()
    if (name !== '' && name !== renaming.path.split('/').pop()) {
      onRenamePath(renaming.path, name)
    }
    setRenaming(null)
  }, [renaming, onRenamePath])

  /** tree-header 新建钮：VS Code 语义——优先树选中项（目录→其内；文件→所在
   *  目录），无选中回退激活文件父目录，最后根目录。
   *  （第十六~二十二轮的 activeFilePath 版有 bug：选中目录后新建仍落到
   *  激活文件的目录，与选中预期不符。） */
  const selectedDirForCreate = useCallback((): string => {
    // 1. 树选中项（最后选中 = 焦点）
    if (selection.size > 0) {
      const focusPath = Array.from(selection)[selection.size - 1]
      if (focusPath === '/') return '/'
      // 选中目录 → 其内；选中文件 → 所在目录。目录判定：expanded 集合或
      // dirCache 命中的都是目录（文件不会进这两个结构）。
      if (expanded.has(focusPath) || dirCache[focusPath] !== undefined) return focusPath
      const idx = focusPath.lastIndexOf('/')
      return idx <= 0 ? '/' : focusPath.slice(0, idx)
    }
    // 2. 激活文件的父目录
    if (activeFilePath !== null) {
      const idx = activeFilePath.lastIndexOf('/')
      return idx <= 0 ? '/' : activeFilePath.slice(0, idx)
    }
    return '/'
  }, [selection, expanded, dirCache, activeFilePath])

  /** 粘贴（VS Code：目标目录下粘贴；复制=cp，剪切=mv）。 */
  const pasteInto = useCallback((destDir: string) => {
    if (clipboard === null) return
    const name = clipboard.path.split('/').pop() ?? ''
    if (name === '') return
    // 目标 = 源自身或源的子孙 → 拒绝（不能粘贴到自己里面）
    if (destDir === clipboard.path || destDir.startsWith(`${clipboard.path}/`)) return
    if (clipboard.cut) {
      const to = destDir === '/' ? `/${name}` : `${destDir}/${name}`
      if (to !== clipboard.path) onMovePath(clipboard.path, to)
      setClipboard(null)
    } else {
      onCopyPath(clipboard.path, destDir)
    }
  }, [clipboard, onMovePath, onCopyPath])

  /** 复制路径/相对路径到剪贴板。 */
  const copyPathText = useCallback((path: string, absolute: boolean) => {
    if (absolute) {
      void getAbsolutePath(path).then((abs) => {
        if (abs !== null) void copyTextToClipboard(abs)
      })
    } else {
      void copyTextToClipboard(path)
    }
  }, [getAbsolutePath])

  // ── 新建行内输入（VS Code 语义：在目标目录下插一个 input 行；window.prompt
  // 在 Electron renderer 被禁用「prompt() is not supported」，不可用）。 ──
  const [creating, setCreating] = useState<{ parentDir: string; kind: 'file' | 'dir'; draft: string } | null>(null)
  const createInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (creating === null || createInputRef.current === null) return
    createInputRef.current.focus()
  }, [creating])
  const startCreate = useCallback((kind: 'file' | 'dir', parentDir: string) => {
    // 确保父目录展开（新建行要显示在其子级首位）
    if (parentDir !== '/' && !expanded.has(parentDir)) {
      onExpandedChange([...expandedPaths, parentDir])
    }
    setCreating({ parentDir, kind, draft: '' })
  }, [expanded, expandedPaths, onExpandedChange])
  const commitCreate = useCallback(() => {
    if (creating === null) return
    const name = creating.draft.trim()
    if (name !== '') {
      if (creating.kind === 'file') onCreateFile(creating.parentDir, name)
      else onCreateFolder(creating.parentDir, name)
    }
    setCreating(null)
  }, [creating, onCreateFile, onCreateFolder])

  // ── 树内搜索（VS Code filter：tree-header 下方搜索框，匹配名过滤可见节点）。 ──
  const [filterText, setFilterText] = useState('')
  const [showFilter, setShowFilter] = useState(false)
  const filterInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (showFilter && filterInputRef.current !== null) filterInputRef.current.focus()
  }, [showFilter])
  /** 过滤：空串 = 全显；非空 = 名称含子串（大小写不敏感）的节点 + 其所有祖先。 */
  const filterMatch = useCallback((name: string): boolean => {
    if (filterText === '') return true
    return name.toLowerCase().includes(filterText.toLowerCase())
  }, [filterText])
  /** 收集过滤态下的可见节点（匹配节点 + 其祖先目录全展开）。 */
  const filteredVisible = useCallback((): Set<string> | null => {
    if (filterText === '') return null
    const visible = new Set<string>()
    const walk = (parentPath: string, entries: FsEntry[]): boolean => {
      let anyChildMatch = false
      for (const e of entries) {
        const p = joinPath(parentPath, e.name)
        const selfMatch = filterMatch(e.name)
        let childMatch = false
        if (e.type === 'dir') {
          const children = dirCache[p]
          if (children !== undefined) childMatch = walk(p, children)
        }
        if (selfMatch || childMatch) {
          visible.add(p)
          anyChildMatch = true
        }
      }
      return anyChildMatch
    }
    if (rootEntries !== null) walk('/', rootEntries)
    return visible
  }, [filterText, rootEntries, dirCache, filterMatch])

  /** 可见节点扁平化（键盘导航 ↑↓ 用；按渲染序）。 */
  const flattenVisible = useCallback((): { path: string; isDir: boolean }[] => {
    const out: { path: string; isDir: boolean }[] = []
    const walk = (parentPath: string, entries: FsEntry[]) => {
      for (const e of entries) {
        const p = joinPath(parentPath, e.name)
        out.push({ path: p, isDir: e.type === 'dir' })
        if (e.type === 'dir' && expanded.has(p)) {
          const children = dirCache[p]
          if (children !== undefined) walk(p, children)
        }
      }
    }
    if (rootEntries !== null) walk('/', rootEntries)
    return out
  }, [rootEntries, dirCache, expanded])

  /** 键盘导航（↑↓ 移动 / → 展开或进子 / ← 折叠或回父 / Enter 打开 / F2 重命名 /
   *  Delete 删除 / ⌘C ⌘X ⌘V 复制剪切粘贴——VS Code 树快捷键）。 */
  const onTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    // ⌘ 系快捷键（复制/剪切/粘贴）——不依赖可见列表，先处理。
    if (e.metaKey || e.ctrlKey) {
      const key = e.key.toLowerCase()
      if (key === 'c' || key === 'x') {
        if (selection.size > 0) {
          e.preventDefault()
          const focusPath = Array.from(selection)[selection.size - 1]
          if (focusPath !== '/') setClipboard({ path: focusPath, cut: key === 'x' })
        }
        return
      }
      if (key === 'v') {
        if (clipboard !== null) {
          e.preventDefault()
          pasteInto(selectedDirForCreate())
        }
        return
      }
      return
    }
    const visible = flattenVisible()
    if (visible.length === 0) return
    // 焦点 = 多选集合的最后一项；无焦点 → 第一个
    const focusPath = selection.size > 0 ? Array.from(selection)[selection.size - 1] : visible[0].path
    const idx = visible.findIndex(v => v.path === focusPath)
    const cur = idx >= 0 ? visible[idx] : visible[0]
    const curIdx = idx >= 0 ? idx : 0
    const moveFocus = (next: string) => {
      setSelection(new Set([next]))
      anchorRef.current = next
      treeBodyRef.current?.querySelector(`[data-tree-path="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = visible[Math.min(curIdx + 1, visible.length - 1)]
        moveFocus(next.path)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const next = visible[Math.max(curIdx - 1, 0)]
        moveFocus(next.path)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (cur.isDir && !expanded.has(cur.path)) {
          toggle(cur.path)
        } else if (cur.isDir) {
          // 已展开 → 进第一个子
          const next = visible[curIdx + 1]
          if (next !== undefined && next.path.startsWith(`${cur.path}/`)) moveFocus(next.path)
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (cur.isDir && expanded.has(cur.path)) {
          toggle(cur.path)
        } else {
          // 回父目录
          const parent = cur.path.slice(0, cur.path.lastIndexOf('/'))
          if (parent !== '' && parent !== cur.path) moveFocus(parent === '' ? '/' : parent)
        }
        break
      }
      case 'Enter': {
        e.preventDefault()
        if (cur.isDir) toggle(cur.path)
        else onOpenFile(cur.path, { preview: false, pin: true })
        break
      }
      case 'F2': {
        e.preventDefault()
        setRenaming({ path: cur.path, draft: cur.path.split('/').pop() ?? '' })
        break
      }
      case 'Delete':
      case 'Backspace': {
        e.preventDefault()
        onDeletePath(cur.path, cur.isDir)
        break
      }
    }
  }, [flattenVisible, selection, expanded, toggle, onOpenFile, onDeletePath, clipboard, pasteInto, selectedDirForCreate])

  /** 多选点击（⌘ 切换 / ⇧ 范围 / 普通单选）。 */
  const onNodeClick = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    if (e.metaKey || e.ctrlKey) {
      // ⌘Click 切换选中
      setSelection(prev => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
      anchorRef.current = path
      return
    }
    if (e.shiftKey && anchorRef.current !== null) {
      // ⇧Click 范围选（按可见序）
      const visible = flattenVisible()
      const a = visible.findIndex(v => v.path === anchorRef.current)
      const b = visible.findIndex(v => v.path === path)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelection(new Set(visible.slice(lo, hi + 1).map(v => v.path)))
        return
      }
    }
    // 普通单击：单选 + 行为（目录 toggle / 文件预览）
    setSelection(new Set([path]))
    anchorRef.current = path
    if (isDir) {
      toggle(path)
    } else {
      onOpenFile(path, { preview: true })
    }
  }, [flattenVisible, toggle, onOpenFile])

  /** 拖拽移动（拖到目录上 = 移入；拖到文件上 = 移到文件所在目录）。 */
  const onNodeDrop = useCallback((e: React.DragEvent, targetPath: string, targetIsDir: boolean) => {
    e.preventDefault()
    setDropTarget(null)
    if (dragPath === null || dragPath === targetPath) return
    // 不能拖到自己的子孙里
    if (targetPath.startsWith(`${dragPath}/`)) return
    const destDir = targetIsDir ? targetPath : targetPath.slice(0, targetPath.lastIndexOf('/'))
    const name = dragPath.split('/').pop() ?? ''
    const destPath = (destDir === '' || destDir === '/') ? `/${name}` : `${destDir}/${name}`
    if (destPath === dragPath) return
    onMovePath(dragPath, destPath)
    setDragPath(null)
  }, [dragPath, onMovePath])

  const filtered = filteredVisible()
  const renderNode = (path: string, entry: FsEntry, depth: number) => {
    // 过滤态：不在 filtered 集合内的节点不渲染
    if (filtered !== null && !filtered.has(path)) return null
    const isDir = entry.type === 'dir'
    // 过滤态强制展开（匹配项的祖先链全显）
    const isExpanded = filtered !== null ? true : expanded.has(path)
    const isSelected = activeFilePath === path || selection.has(path)
    const children = isDir ? dirCache[path] : undefined
    const isLoading = loading.has(path)
    const isRenaming = renaming?.path === path
    const isDropTarget = dropTarget === path
    return (
      <div key={path}>
        {isRenaming ? (
          <div className={css.renameRow} style={{ paddingLeft: 6 + depth * 14 }}>
            <span className={css.caretSpacer} />
            {isDir
              ? <Folder size={18} strokeWidth={2} className={css.dirIcon} />
              : <FileTypeIcon name={entry.name} />}
            <input
              ref={renameInputRef}
              className={css.renameInput}
              value={renaming.draft}
              onChange={(e) => setRenaming({ path: renaming.path, draft: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setRenaming(null)
                // IME composition（中文输入 Enter 确认候选不误提交）
                if (e.key === 'Enter' && e.nativeEvent.isComposing) return
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ) : (
          <button
            type="button"
            className={`${css.node}${isSelected ? ` ${css.nodeSelected}` : ''}${isDropTarget ? ` ${css.nodeDropTarget}` : ''}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            data-tree-path={path}
            draggable
            onDragStart={(e) => {
              setDragPath(path)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', path)
            }}
            onDragEnd={() => { setDragPath(null); setDropTarget(null) }}
            onDragOver={(e) => {
              if (dragPath !== null && dragPath !== path && !path.startsWith(`${dragPath}/`)) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTarget(path)
              }
            }}
            onDragLeave={() => { if (dropTarget === path) setDropTarget(null) }}
            onDrop={(e) => onNodeDrop(e, path, isDir)}
            onClick={(e) => onNodeClick(e, path, isDir)}
            onDoubleClick={() => {
              if (!isDir) {
                // 文件双击 → 固定 tab（取消预览态）
                onOpenFile(path, { preview: false, pin: true })
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // VS Code 语义：右键未选中的节点 → 先把它单选（菜单作用于
              // 所见节点；也修「右键后新建落在别处」的体感错位）。
              if (!selection.has(path)) {
                setSelection(new Set([path]))
                anchorRef.current = path
              }
              setContextMenu({ x: e.clientX, y: e.clientY, path, isDir })
            }}
            title={entry.name}
          >
            {isDir
              ? (
                <span className={css.caret}>
                  {isExpanded ? <ChevronDown size={16} strokeWidth={2} /> : <ChevronRight size={16} strokeWidth={2} />}
                </span>
              )
              : <span className={css.caretSpacer} />}
            {isDir
              ? (isExpanded
                ? <FolderOpen size={18} strokeWidth={2} className={css.dirIcon} />
                : <Folder size={18} strokeWidth={2} className={css.dirIcon} />)
              : <FileTypeIcon name={entry.name} />}
            <span className={`${css.name}${isSelected ? ` ${css.nameSelected}` : ''}`}>{entry.name}</span>
            {isLoading && <span className={css.loading}>…</span>}
          </button>
        )}
        {isDir && isExpanded && children !== undefined && (
          <div>
            {/* 新建行（在本目录下创建时插入子级首位） */}
            {creating !== null && creating.parentDir === path && (
              <div className={css.renameRow} style={{ paddingLeft: 6 + (depth + 1) * 14 }}>
                <span className={css.caretSpacer} />
                {creating.kind === 'dir'
                  ? <Folder size={18} strokeWidth={2} className={css.dirIcon} />
                  : <FileCode size={18} strokeWidth={2} className={css.fileIcon} data-tone="code" />}
                <input
                  ref={createInputRef}
                  className={css.renameInput}
                  placeholder={creating.kind === 'dir' ? '文件夹名' : '文件名'}
                  value={creating.draft}
                  onChange={(e) => setCreating({ ...creating, draft: e.target.value })}
                  onBlur={commitCreate}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitCreate()
                    if (e.key === 'Escape') setCreating(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            )}
            {children.map(child => renderNode(joinPath(path, child.name), child, depth + 1))}
            {children.length === 0 && creating?.parentDir !== path && <div className={css.emptyDir}>空目录</div>}
          </div>
        )}
        {isDir && isExpanded && children === undefined && !isLoading && (
          <button type="button" className={css.emptyDir} style={{ cursor: 'pointer', background: 'none', border: 'none', width: '100%', textAlign: 'left' }} onClick={() => loadDir(path)} title="点击重试">加载失败（点击重试）</button>
        )}
      </div>
    )
  }

  return (
    <div className={css.explorer}>
      {/* kKDmJ — explorer-titlebar（标题 + panel-right-close + ×）。 */}
      <div className={css.explorerTitlebar}>
        <span className={css.titlebarTitle}>资源管理器</span>
        <div className={css.titlebarSpacer} />
        <button
          type="button"
          className={css.tb}
          title="收起资源管理器"
          onClick={onToggleCollapsed}
        >
          <PanelRightClose size={16} strokeWidth={2} className={css.tbIconToggle} />
        </button>
      </div>
      <div className={css.workspaceBinding} title={workspaceRoot?.get().root ?? undefined}><Link size={12} /> 跟随当前对话</div>
      {/* WbdhK — tree-header（chevron + 根名 + 4 个 20×20 工具钮）。 */}
      <div className={css.treeHeader}>
        <ChevronDown size={17} strokeWidth={2} className={css.headerChev} />
        <span className={css.headerRoot}>{noWorkspace ? '（未打开项目）' : rootName}</span>
        <button type="button" className={css.tb} title="新建文件" disabled={noWorkspace} onClick={() => startCreate('file', selectedDirForCreate())}>
          <FilePlus size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="新建文件夹" disabled={noWorkspace} onClick={() => startCreate('dir', selectedDirForCreate())}>
          <FolderPlus size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={`${css.tb}${showFilter ? ` ${css.tbActive}` : ''}`} title="搜索文件" disabled={noWorkspace} onClick={() => { setShowFilter(v => !v); if (showFilter) setFilterText('') }}>
          <Search size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="刷新" disabled={noWorkspace} onClick={loadRoot}>
          <RotateCw size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="折叠全部" disabled={noWorkspace} onClick={collapseAll}>
          <ListCollapse size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
      </div>
      {/* 树内搜索框（VS Code filter：点击搜索钮展开/收起；Escape 清空并收起）。 */}
      {showFilter && (
        <div className={css.filterRow}>
          <input
            ref={filterInputRef}
            className={css.filterInput}
            placeholder="搜索文件名…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilterText('')
                setShowFilter(false)
              }
            }}
          />
        </div>
      )}
      {/* QdSbb — tree-body。 */}
      <div
        className={css.treeBody}
        ref={treeBodyRef}
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        data-tree-body=""
        onContextMenu={(e) => {
          // 空白区右键（未命中任何节点——节点自身 stopPropagation）：
          // VS Code 根菜单（新建/粘贴/刷新/折叠全部）。
          e.preventDefault()
          setContextMenu({ x: e.clientX, y: e.clientY, path: '/', isDir: true, blank: true })
        }}
      >
        {noWorkspace && (
          <div className={css.emptyDir} style={{ padding: '24px 16px', textAlign: 'center', lineHeight: 1.6 }}>
            未打开项目<br />
            <span style={{ fontSize: 12, opacity: 0.7 }}>在侧栏打开项目或开始任务后，这里显示对应工作区的文件</span>
          </div>
        )}
        {!noWorkspace && rootError !== null && (
          <button type="button" className={css.error} style={{ cursor: 'pointer', background: 'none', border: 'none', width: '100%', textAlign: 'left' }} onClick={loadRoot} title="点击重试">{rootError}（点击重试）</button>
        )}
        {!noWorkspace && rootEntries === null && rootError === null && <div className={css.emptyDir}>加载中…</div>}
        {/* 根目录新建行（在根下创建时插入首位） */}
        {creating !== null && creating.parentDir === '/' && (
          <div className={css.renameRow} style={{ paddingLeft: 6 }}>
            <span className={css.caretSpacer} />
            {creating.kind === 'dir'
              ? <Folder size={18} strokeWidth={2} className={css.dirIcon} />
              : <FileCode size={18} strokeWidth={2} className={css.fileIcon} data-tone="code" />}
            <input
              ref={createInputRef}
              className={css.renameInput}
              placeholder={creating.kind === 'dir' ? '文件夹名' : '文件名'}
              value={creating.draft}
              onChange={(e) => setCreating({ ...creating, draft: e.target.value })}
              onBlur={commitCreate}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitCreate()
                if (e.key === 'Escape') setCreating(null)
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
        {!noWorkspace && rootEntries?.map(entry => renderNode(joinPath('/', entry.name), entry, 0))}
      </div>
      {/* 右键菜单（自绘玻璃菜单，fixed 定位，挂在组件根；边缘翻转——
          靠近右/下边缘时菜单向左/上开，VS Code 语义）。 */}
      {contextMenu !== null && (
        <ContextMenuView state={contextMenu} onClose={() => setContextMenu(null)}>
          {contextMenu.blank === true ? (
            <>
              <button type="button" className={css.contextMenuItem} onClick={() => { startCreate('file', '/'); setContextMenu(null) }}>新建文件</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { startCreate('dir', '/'); setContextMenu(null) }}>新建文件夹</button>
              <div className={css.contextMenuDivider} />
              {clipboard !== null && (
                <>
                  <button type="button" className={css.contextMenuItem} onClick={() => { pasteInto('/'); setContextMenu(null) }}>粘贴</button>
                  <div className={css.contextMenuDivider} />
                </>
              )}
              <button type="button" className={css.contextMenuItem} onClick={() => { loadRoot(); setContextMenu(null) }}>刷新</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { collapseAll(); setContextMenu(null) }}>折叠全部</button>
            </>
          ) : contextMenu.isDir ? (
            <>
              <button type="button" className={css.contextMenuItem} onClick={() => { startCreate('file', contextMenu.path); setContextMenu(null) }}>新建文件</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { startCreate('dir', contextMenu.path); setContextMenu(null) }}>新建文件夹</button>
              <div className={css.contextMenuDivider} />
              <button type="button" className={css.contextMenuItem} onClick={() => { setClipboard({ path: contextMenu.path, cut: false }); setContextMenu(null) }}>复制</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { setClipboard({ path: contextMenu.path, cut: true }); setContextMenu(null) }}>剪切</button>
              {clipboard !== null && (
                <button type="button" className={css.contextMenuItem} onClick={() => { pasteInto(contextMenu.path); setContextMenu(null) }}>粘贴</button>
              )}
              <div className={css.contextMenuDivider} />
              <button type="button" className={css.contextMenuItem} onClick={() => { copyPathText(contextMenu.path, true); setContextMenu(null) }}>复制路径</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { copyPathText(contextMenu.path, false); setContextMenu(null) }}>复制相对路径</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { revealInFinder(contextMenu.path); setContextMenu(null) }}>在 Finder 中显示</button>
              <div className={css.contextMenuDivider} />
              <button type="button" className={css.contextMenuItem} onClick={() => { onAddToChat(contextMenu.path); setContextMenu(null) }}>添加到对话</button>
              <div className={css.contextMenuDivider} />
              <button type="button" className={css.contextMenuItem} onClick={() => { setRenaming({ path: contextMenu.path, draft: contextMenu.path.split('/').pop() ?? '' }); setContextMenu(null) }}>重命名</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { loadDir(contextMenu.path); setContextMenu(null) }}>刷新</button>
              <button type="button" className={`${css.contextMenuItem} ${css.contextMenuDanger}`} onClick={() => { onDeletePath(contextMenu.path, true); setContextMenu(null) }}>删除</button>
            </>
          ) : (
            <>
              <button type="button" className={css.contextMenuItem} onClick={() => { onOpenFile(contextMenu.path); setContextMenu(null) }}>打开</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { onOpenFile(contextMenu.path, { preview: false, pin: true }); setContextMenu(null) }}>固定打开</button>
              <div className={css.contextMenuDivider} />
              {/* VS Code 语义：文件右键的新建落在文件所在目录 */}
              <button type="button" className={css.contextMenuItem} onClick={() => { const dir = contextMenu.path.slice(0, contextMenu.path.lastIndexOf('/')) || '/'; startCreate('file', dir); setContextMenu(null) }}>新建文件</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { const dir = contextMenu.path.slice(0, contextMenu.path.lastIndexOf('/')) || '/'; startCreate('dir', dir); setContextMenu(null) }}>新建文件夹</button>
              <div className={css.contextMenuDivider} />
              <button type="button" className={css.contextMenuItem} onClick={() => { setClipboard({ path: contextMenu.path, cut: false }); setContextMenu(null) }}>复制</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { setClipboard({ path: contextMenu.path, cut: true }); setContextMenu(null) }}>剪切</button>
              <div className={css.contextMenuDivider} />
              <button type="button" className={css.contextMenuItem} onClick={() => { copyPathText(contextMenu.path, true); setContextMenu(null) }}>复制路径</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { copyPathText(contextMenu.path, false); setContextMenu(null) }}>复制相对路径</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { revealInFinder(contextMenu.path); setContextMenu(null) }}>在 Finder 中显示</button>
              <div className={css.contextMenuDivider} />
              {/* VS Code：选择以进行比较 → 与已选项目比较；添加到对话 */}
              <button type="button" className={css.contextMenuItem} onClick={() => { setCompareSource(contextMenu.path); setContextMenu(null) }}>选择以进行比较</button>
              {compareSource !== null && compareSource !== contextMenu.path && (
                <button type="button" className={css.contextMenuItem} onClick={() => { onCompare(compareSource, contextMenu.path); setCompareSource(null); setContextMenu(null) }}>与已选项目比较</button>
              )}
              <button type="button" className={css.contextMenuItem} onClick={() => { onAddToChat(contextMenu.path); setContextMenu(null) }}>添加到对话</button>
              <div className={css.contextMenuDivider} />
              <button type="button" className={css.contextMenuItem} onClick={() => { setRenaming({ path: contextMenu.path, draft: contextMenu.path.split('/').pop() ?? '' }); setContextMenu(null) }}>重命名</button>
              <button type="button" className={`${css.contextMenuItem} ${css.contextMenuDanger}`} onClick={() => { onDeletePath(contextMenu.path, false); setContextMenu(null) }}>删除</button>
            </>
          )}
        </ContextMenuView>
      )}
    </div>
  )
}

/** 右键菜单容器（边缘翻转：靠近右/下边缘时向左/上开，VS Code 语义）。
 *  挂载后测实际宽高再定位（避免首次渲染飞屏）。
 *
 *  关键：必须 createPortal 到 document.body。dsh 布局叶子（.lw7wFG_leaf）带
 *  `will-change: transform`，会创建合成层 containing block——菜单若留在
 *  组件树内，`position: fixed` 相对该叶子而非视口定位，直接飞出屏幕右侧
 *  （实机 x=2023 vs 视口 1596；inlineStyle left 1327 被叶子的 696 偏移推走）。 */
function ContextMenuView({ state, onClose, children }: { state: ContextMenuState; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 右边缘溢出 → 向左开；下边缘溢出 → 向上开；钳制在视口内（8px 边距）。
    let left = state.x
    let top = state.y
    if (left + rect.width > vw - 8) left = Math.max(8, state.x - rect.width)
    if (top + rect.height > vh - 8) top = Math.max(8, state.y - rect.height)
    setPos({ left, top })
  }, [state])
  return createPortal(
    <div
      ref={ref}
      className={css.contextMenu}
      style={pos !== null ? { left: pos.left, top: pos.top } : { left: state.x, top: state.y, visibility: 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}
