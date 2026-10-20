/**
 * fork（corum）：「在编辑器打开」可编程入口的 cordis 服务面（统一事件中心
 * 三-2：`corum:open-in-editor` 跨 bundle CustomEvent 服务化）。
 *
 * 原实现：chat 插件 dispatch window CustomEvent('corum:open-in-editor')，
 * desktop client 监听并 fire-and-forget——chat 拿不到失败反馈，desktop 侧还带
 * 「100ms 轮询 3s 等 EditorColumn 挂载」的脆弱补偿。现收敛为 cordis 服务
 * `ctx.corumEditor`（provide 于 client/index.ts 的 apply）：
 *   - `openFile(absolutePath): Promise<OpenFileResult>` 返回 { ok, error }，
 *     调用方（chat）拿到结构化失败反馈（未打开项目 / 路径不在工作区根 /
 *     编辑器挂载超时）。
 *   - pending 队列替代 3s 轮询：EditorColumn 未挂载时请求挂起（最多 3s 兜底
 *     超时），EditorColumn 挂载（经 onEditorReady 订阅通知）时一次性认领——
 *     事件驱动，零轮询。时序参照 AppFrame openNewTaskForm 的「未挂载置 pending、
 *     挂载认领」模式。
 *
 * 本文件保持 cordis-free（纯库纪律）：无 cordis import，Context 合并由
 * client/index.ts 侧声明。
 */

import { getCorumMonacoInstance } from './monaco-bridge.ts'

/** openFile 结果（chat 侧给用户可见反馈的数据源）。 */
export interface OpenFileResult {
  ok: boolean
  error?: string
}

/**
 * corumEditor 服务面（cordis 服务，跨 bundle 单例）。
 * chat 等消费端用局部能力接口收窄注入（dev-conventions §2.4 红线 2/3）。
 */
export interface CorumEditorService {
  /**
   * 在工作区编辑器打开文件（绝对路径）。
   * 内部：绝对 → corumFs 相对 → 点亮编辑器区域 → EditorColumn.openFile(pin)。
   * EditorColumn 未挂载时请求挂起，挂载认领；3s 仍未挂载报超时。
   */
  openFile(absolutePath: string): Promise<OpenFileResult>
  /**
   * 打开「改动前后」diff tab（Review 卡点击文件行）。
   *
   * 左侧是调用方传进来的**原文**（来自 host 影子 git 仓库 `corumReview/fileBefore` —
   * 每个轮次的起始状态都提交过，所以这是**精确**的改动前内容），右侧是磁盘当前文件。
   * `note` 非空表示重建不完整（该文件被整文件覆盖写过等），编辑器以横幅如实告知。
   */
  openContentDiff(input: {
    absolutePath: string
    originalContent: string
    note?: string | undefined
  }): Promise<OpenFileResult>
  /**
   * 滚动定位到当前活动编辑器的指定行（「编辑未命中」卡行号跳转，2026-09-13）。
   * 经 monaco-bridge 同 bundle 引用直调；无活动编辑器时 no-op（静默——调用方
   * 是 openFile 之后的定位增强，失败不影响打开结果）。
   */
  revealLine?: (line: number) => void
}

/**
 * 编辑器就绪订阅面（服务实现内部用；EditorColumn 挂载/卸载时经 index.ts 的
 * notify 回调触发）。subscribe(listener) 返回退订函数。
 */
export interface EditorReadySource {
  subscribe(listener: () => void): () => void
}

/** 点亮区域 + 路径换算的后端面（由 index.ts 注入，隔离 cordis/layout 面）。 */
export interface EditorOpenBackend {
  /** 工作区外文件的只读预览入口；失败按原有结果面反馈。 */
  openExternalPreview?(absolute: string): Promise<{ path: string }>
  /** 绝对路径 → corumFs 相对路径；未打开项目 / 路径不在工作区根时返回 null。 */
  toRelativePath(absolute: string): string | null
  /** 当前工作区根（错误反馈用）。 */
  currentRoot(): string | null
  /** 点亮编辑器区域（清两层隐藏）。 */
  showEditorRegion(): void
}

/** EditorApiRef 的最小类型面（与 EditorColumn.tsx 的 EditorApiRef 结构一致；
 *  用结构化类型避免反向 import 组件文件）。 */
interface OpenFileRef {
  openFile: ((path: string, opts?: { preview?: boolean; pin?: boolean }) => Promise<void>) | null
  openContentDiff: ((input: { path: string; originalContent: string; note?: string | undefined }) => Promise<void>) | null
}

/** pending 挂载超时（与原 3s 轮询窗口一致，但纯事件驱动、零轮询）。 */
const MOUNT_TIMEOUT_MS = 3000

/**
 * 一个待编辑器挂载的请求。两种形态共用单 pending 槽（见 createCorumEditor）：
 *   - `file`：普通打开文件（EditorColumn.openFile）。
 *   - `diff`：Review 卡「改动前后」diff（EditorColumn.openContentDiff），
 *     多带一份内存重建的原文。
 */
type PendingRequest =
  | { kind: 'file'; rel: string }
  | { kind: 'diff'; rel: string; originalContent: string; note?: string | undefined }

/**
 * 创建 corumEditor 服务实例（index.ts 的 ctx.inject 回调里 new 出并 provide）。
 * @param editorApiRef - slot inject 面传入 EditorColumn 的 ref（挂载时 openFile 写入）。
 * @param readySource - EditorColumn 挂载/卸载通知源（认领 pending 的触发器）。
 * @param backend - 路径换算 + 点亮区域的后端面。
 */
export function createCorumEditor(
  editorApiRef: OpenFileRef,
  readySource: EditorReadySource,
  backend: EditorOpenBackend,
): CorumEditorService {
  // pending 槽：EditorColumn 未挂载时的挂起请求（挂载认领；超时拒绝）。
  // 两种请求共用同一个槽（单槽语义：新的请求覆盖旧的，避免快速连点时排队打开
  // 多个 tab）；`kind` 决定认领时调哪个 api。
  let pending: {
    req: PendingRequest
    resolve: (r: OpenFileResult) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  const clearPending = (): void => {
    if (pending === null) return
    clearTimeout(pending.timer)
    pending = null
  }

  /**
   * 尝试立刻执行请求；编辑器未挂载（对应 api 为 null）时返回 null 表示需挂起。
   *
   * 两条路径都必须走这里：`showEditorRegion()` 只是把编辑器区域点亮，真正的
   * EditorColumn 在**下一次渲染**才挂载，所以「点亮后立刻调 api」必然是 null。
   * 早先 openContentDiff 绕过了挂起队列、直接判断 null 就报错，实测必然失败
   * （点文件只得到「编辑器挂载超时」）。
   */
  const runRequest = (req: PendingRequest): Promise<void> | null => {
    if (req.kind === 'file') {
      const api = editorApiRef.openFile
      if (api === null) return null
      return api(req.rel, { pin: true })
    }
    const api = editorApiRef.openContentDiff
    if (api === null) return null
    return api({
      path: req.rel,
      originalContent: req.originalContent,
      ...req.note !== undefined ? { note: req.note } : {},
    })
  }

  const claimPending = (): void => {
    if (pending === null) return
    const run = runRequest(pending.req)
    if (run === null) return
    const { resolve } = pending
    clearPending()
    void run
      .then(() => resolve({ ok: true }))
      .catch((err: unknown) => resolve({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  }

  // EditorColumn 挂载/卸载时通知：挂载则认领 pending（卸载时 api 为 null，
  // runRequest 返回 null，claimPending 自然 no-op）。
  readySource.subscribe(claimPending)

  /** 解析绝对路径 → 相对路径；失败时返回可直接回给调用方的错误。 */
  const resolveRel = (absolutePath: string): { rel: string } | { error: OpenFileResult } => {
    if (absolutePath === '') return { error: { ok: false, error: '路径为空' } }
    const rel = backend.toRelativePath(absolutePath)
    if (rel === null) {
      const root = backend.currentRoot()
      return {
        error: {
          ok: false,
          error: root === null || root === ''
            ? '未打开项目（编辑器没有当前工作区根）'
            : `路径不在当前工作区根下（root: ${root}）`,
        },
      }
    }
    return { rel }
  }

  /**
   * 统一入口：点亮编辑器区 → 立刻试跑；未挂载则挂起等 mount 认领（超时拒绝）。
   * openFile / openContentDiff 只在「构造哪种请求」上不同。
   */
  const dispatch = (req: PendingRequest): Promise<OpenFileResult> => {
    backend.showEditorRegion()
    const run = runRequest(req)
    if (run !== null) {
      return run
        .then((): OpenFileResult => ({ ok: true }))
        .catch((err: unknown): OpenFileResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    }
    clearPending()
    return new Promise<OpenFileResult>((resolve) => {
      const timer = setTimeout(() => {
        pending = null
        console.warn('[corum-desktop] corumEditor: editor mount timeout', { path: req.rel })
        resolve({ ok: false, error: '编辑器挂载超时（3s 未就绪）' })
      }, MOUNT_TIMEOUT_MS)
      pending = { req, resolve, timer }
    })
  }

  return {
    openFile: async (absolutePath: string): Promise<OpenFileResult> => {
      const resolved = resolveRel(absolutePath)
      if ('error' in resolved) {
        if (absolutePath === '' || backend.openExternalPreview === undefined) return resolved.error
        try {
          const preview = await backend.openExternalPreview(absolutePath)
          return await dispatch({ kind: 'file', rel: preview.path })
        } catch (error: unknown) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      return dispatch({ kind: 'file', rel: resolved.rel })
    },

    openContentDiff: (input): Promise<OpenFileResult> => {
      const resolved = resolveRel(input.absolutePath)
      if ('error' in resolved) return Promise.resolve(resolved.error)
      return dispatch({
        kind: 'diff',
        rel: resolved.rel,
        originalContent: input.originalContent,
        ...input.note !== undefined ? { note: input.note } : {},
      })
    },

    revealLine: (line: number): void => {
      // 延后一帧：openFile 的 pending 认领链 resolve 时 tab 刚打开，MonacoEditor
      // 的模型绑定在下一渲染帧完成；rAF 后 reveal 才能落在已绑定的模型上。
      requestAnimationFrame(() => {
        getCorumMonacoInstance()?.revealLine?.(line)
      })
    },
  }
}

/**
 * 创建 EditorColumn 就绪通知源（index.ts 持有；slot inject 的 editorApi
 * 包装对象在 openFile 被写入/清空时调 notify）。同一 bundle 内部实现细节。
 */
export function createEditorReadySource(): EditorReadySource & { notify(): void } {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify() {
      for (const fn of [...listeners]) fn()
    },
  }
}
