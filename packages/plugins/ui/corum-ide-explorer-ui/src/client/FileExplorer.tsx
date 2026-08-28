/**
 * FileExplorer — the IDE resource manager (design.pen ④ 资源管理器, 210px, 浅
 * PmMu1 / 深 N0uIY). Structure follows the design frame: tree-header (N3NoP:
 * chevron + 根名 + file-plus/folder-plus/rotate-cw/list-collapse/× 五个 20×20
 * 工具钮) → tree-body (EaWC3: VS Code 风格树，chevron + folder/file 类型着色
 * 图标 + 每级 14px 缩进 + 选中态 glass-2 加粗). Data comes from the host fs RPC
 * (corum.fs.list, rooted at the host project cwd); the tree-header root name
 * rides the shell's host-description source (host cwd basename, same source as
 * the sidebar workspace label).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Braces, ChevronDown, ChevronRight, FileCode, FileCog, FilePlus, FileText,
  Folder, FolderOpen, FolderPlus, ListCollapse, Lock, RotateCw, X,
} from 'lucide-react'
import css from './FileExplorer.module.css'

/** One directory entry returned by corum.fs.list. */
export interface FsEntry {
  name: string
  type: 'dir' | 'file'
}

/** Injected actions (see client/index.ts apply). */
export interface FileExplorerInjected {
  listDir: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { entries: FsEntry[] } }>
  /** 壳的 host-description 源（每次连接握手后发布；cwd basename = 工作区根名）。 */
  hostDescription: {
    getSnapshot(): unknown
    subscribe(listener: () => void): () => void
  }
}

/** Composed props: the shell's owner share + this plugin's injected face. */
export type FileExplorerProps = PropsRuntime<'corum.explorer'> & FileExplorerInjected

/** 工作区根名：host-description 里 cwd 的 basename，取不到时回退设计默认。 */
function rootNameFromDescription(description: unknown): string {
  // snapshot 可能是扁平 {cwd,...}，也可能带一层 {value:{cwd,...}} 包装（看握手来源），两种都接。
  const flat = description as { cwd?: unknown } | undefined
  const wrapped = (description as { value?: unknown } | undefined)?.value as { cwd?: unknown } | undefined
  const cwd = flat?.cwd ?? wrapped?.cwd
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
function FileTypeIcon({ name }: { name: string }) {
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

/** The IDE resource manager (see module doc). */
export function FileExplorer({ listDir, hostDescription }: FileExplorerProps) {
  const [rootEntries, setRootEntries] = useState<FsEntry[] | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const description = useSyncExternalStore(hostDescription.subscribe, hostDescription.getSnapshot)
  // 根名 = host cwd basename（与侧栏 workspaceName 同源）；连接前回退设计默认。
  const rootName = rootNameFromDescription(description)
  /** Path → children entries cache (lazy; undefined key = not loaded). */
  const [dirCache, setDirCache] = useState<Record<string, FsEntry[] | undefined>>({})
  /** Currently expanded directory paths. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  /** Paths with an in-flight load (avoid duplicate fetches). */
  const [loading, setLoading] = useState<Set<string>>(() => new Set())
  /** The selected node path (VS Code single-selection; '' = none). */
  const [selected, setSelected] = useState<string>('')

  const loadRoot = useCallback((): void => {
    listDir('/').then((result) => {
      if (result.ok && result.value !== undefined) {
        setRootEntries(result.value.entries)
        setRootError(null)
      } else {
        setRootError(result.error?.message ?? '无法读取项目根目录')
        setRootEntries(null)
      }
    }).catch((error: unknown) => {
      setRootError(String(error))
    })
  }, [listDir])

  // Load the project root once.
  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  const toggle = useCallback((path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        setDirCache((cache) => {
          if (cache[path] !== undefined) return cache
          setLoading((loadingSet) => new Set(loadingSet).add(path))
          listDir(path).then((result) => {
            setDirCache((c) => ({ ...c, [path]: result.ok ? result.value?.entries : undefined }))
          }).catch(() => {
            setDirCache((c) => ({ ...c, [path]: undefined }))
          }).finally(() => {
            setLoading((loadingSet) => {
              const nextLoading = new Set(loadingSet)
              nextLoading.delete(path)
              return nextLoading
            })
          })
          return cache
        })
      }
      return next
    })
  }, [listDir])

  const collapseAll = useCallback((): void => {
    setExpanded(new Set())
  }, [])

  const renderNode = (path: string, entry: FsEntry, depth: number) => {
    const isDir = entry.type === 'dir'
    const isExpanded = expanded.has(path)
    const isSelected = selected === path
    const children = isDir ? dirCache[path] : undefined
    const isLoading = loading.has(path)
    return (
      <div key={path}>
        <button
          type="button"
          className={`${css.node}${isSelected ? ` ${css.nodeSelected}` : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => {
            setSelected(path)
            if (isDir) toggle(path)
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
        {isDir && isExpanded && children !== undefined && (
          <div>
            {children.map(child => renderNode(joinPath(path, child.name), child, depth + 1))}
            {children.length === 0 && <div className={css.emptyDir}>空目录</div>}
          </div>
        )}
        {isDir && isExpanded && children === undefined && !isLoading && (
          <div className={css.emptyDir}>加载失败</div>
        )}
      </div>
    )
  }

  return (
    <div className={css.explorer}>
      {/* N3NoP — tree-header（chevron + 根名 + 5 个 20×20 工具钮）。 */}
      <div className={css.treeHeader}>
        <ChevronDown size={17} strokeWidth={2} className={css.headerChev} />
        <span className={css.headerRoot}>{rootName}</span>
        <button type="button" className={css.tb} title="新建文件">
          <FilePlus size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="新建文件夹">
          <FolderPlus size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="刷新" onClick={loadRoot}>
          <RotateCw size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="折叠全部" onClick={collapseAll}>
          <ListCollapse size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button
          type="button"
          className={css.tb}
          title="关闭区域"
          onClick={() => window.dispatchEvent(new CustomEvent('corum:close-region', { detail: { slot: 'corum.explorer' } }))}
        >
          <X size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
      </div>
      {/* EaWC3 — tree-body。 */}
      <div className={css.treeBody}>
        {rootError !== null && <div className={css.error}>{rootError}</div>}
        {rootEntries === null && rootError === null && <div className={css.emptyDir}>加载中…</div>}
        {rootEntries?.map(entry => renderNode(joinPath('/', entry.name), entry, 0))}
      </div>
    </div>
  )
}
