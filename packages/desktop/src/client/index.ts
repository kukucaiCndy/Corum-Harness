/**
 * corum-desktop client half: framework-level surfaces for the desktop shell.
 * The transport is the official web stack (the renderer loads the host's
 * loopback webserver directly), so this plugin carries no connection glue —
 * only the notification store/host and the resident editor column. Dev HMR is
 * served by the official `dsh-client-hmr` row (webserver SSE), enabled by the
 * desktop overlay.
 * @module corum-desktop/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { createNotificationStore, type NotificationStore } from './notifications.ts'
import { installNativeNotificationMirror, installNotificationBridge } from './notification-bridge.ts'
import { installTrayBridge } from './tray-bridge.ts'
import { mountNotificationHost } from './mount-notifications.tsx'
// Type-only: pulls the `ctx.slots` Context merge (declared by dsh-client-ui-renderer).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `corum.editor` SlotMap row (declared by @corum/corum-ide-ui).
import type {} from '@corum/corum-ide-ui/client'
// Type-only: 拉入 fork 装配面的 ctx.remote Context 合并 + corum 事件 $on 类型投影
// （'corum/file/changed' listener 签名由此而来；fork 包在 cordis.patch.yml 以
// immediately:true 装配，remote 服务在本 bundle ctx.inject 回调运行时已就绪）。
import type {} from '@corum/corum-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { EditorColumn } from './editor/EditorColumn.tsx'
import type { EditorApiRef, EditorColumnInjected } from './editor/EditorColumn.tsx'
import { createCorumEditor, createEditorReadySource, type CorumEditorService } from './editor/corum-editor.ts'
import { createFontPrefs, setFontPrefsInstance, type FontPrefsStore } from './editor/font-prefs.ts'
import { createCorumFsClient, type CorumFsClient } from './editor/corum-fs-client.ts'
import type { FsEntry } from './editor/ExplorerPane.tsx'
import { workspaceRelativePath } from '../shared/preview-path.ts'

/** Required services: none — this is the wire root; the code-editor view registers lazily below. */
export const inject: string[] = []

/**
 * 跨 bundle 能力接口（dev-conventions §2.4）：本 bundle inject 的 ctx.layout
 * 类型面是官方基线 ILayout（corum 运行时 LayoutController 是其超集，新增
 * showRegion 面）。用局部能力接口收窄 + 可选链调用，不强耦合 ide-ui 实现包。
 */
interface ShowRegionCapableLayout {
  /** 点亮区域（清 userShown 运行时隐藏 + 树 hidden 持久化；实现缺该面时缺席）。 */
  showRegion?: (slot: string) => void
}

// Context merge: the framework notification store is injectable by any plugin.
declare module '@deepseek-ai/cordis' {
  interface Context {
    notifications: NotificationStore
    /**
     * 「在编辑器打开」可编程入口（统一事件中心三-2：corum:open-in-editor
     * 跨 bundle CustomEvent 服务化）。chat 等消费端用局部能力接口收窄注入
     * （dev-conventions §2.4 红线 2/3）。
     */
    corumEditor: CorumEditorService
    /**
     * fork（corum）P2-8：corumFs 的 11 个 RPC 封装服务（原散在 apply 闭包的注入面）。
     * 本包 provide；消费方经 inject 取（同 bundle 的 EditorColumn 仍走注入面，行为不变）。
     */
    corumFsClient: CorumFsClient
    /**
     * 编辑器/终端「字面」偏好（PRD §4.23 E1/E2/E3、§4.2 乙类）。
     * 本包 provide；Monaco（同 bundle）直接订阅，xterm（panel-bottom-ui）与
     * 设置页（ide-ui）经 inject + 局部能力接口收窄消费（红线 1/3/4）。
     */
    fontPrefs: FontPrefsStore
  }
}

/**
 * Client plugin body: framework surfaces over the desktop IPC carrier.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  // Framework notifications (design.pen「row-通知框」): a framework-level
  // capability any combo can use — HMR failure is just the first consumer.
  // The store is provided as `ctx.notifications`; the host renders the toast
  // stack into a body-rooted portal (decoupled from any combo's slot system).
  const notifications = createNotificationStore()
  ctx.provide('notifications', notifications)
  const notificationHost = mountNotificationHost(notifications)
  ctx.effect(() => () => { notificationHost.dispose() }, 'corum-desktop: notification host')
  // Debug/console surface: lets CDP and the devtools console emit a notification
  // without a fiber reference (plugins should inject `ctx.notifications` instead).
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __corumNotify?: NotificationStore['notify'] }).__corumNotify = notifications.notify
  }

  // 字面偏好服务（PRD §4.23 E1/E2/E3、§4.2 乙类，§5 剩余项 3）：单实例
  // provide 到 **client root**（与 ctx.notifications 同层——cordis 嵌套 inject
  // 块（editorCtx）里 provide 的服务对兄弟 bundle 不可见，实测 ide-ui 卡在
  // "waiting for service: fontPrefs"）。Monaco（本 bundle，经 font-prefs 实例
  // 桥取同一实例）/ xterm（panel-bottom-ui inject）/ 设置页（ide-ui inject）共享。
  const fontPrefs = createFontPrefs()
  ctx.provide('fontPrefs', fontPrefs)
  setFontPrefsInstance(fontPrefs)

  // 常用事件 → 通知栏（2026-09-10 用户「要把一些常用的事件接入通知栏」）。
  // 通知通道此前只有两个罕见失败分支在用，日常使用中根本看不到通知栏；
  // 本 inject 把任务闭环/卡住/阻塞、子 Agent 完成、隔离分支待集成、下载完成
  // 这些「用户需要知道」的事件接上（高频过程事件刻意不接，见 bridge 的选型原则）。
  ctx.inject(['remote', 'sessions', 'notifications'], (notifyCtx) => {
    const dispose = installNotificationBridge(notifyCtx, notifications)
    notifyCtx.effect(() => () => { dispose() }, 'corum-desktop: notification bridge')
  })

  // 系统通知镜像：**当前默认关闭**（2026-09-10 用户定调「先降级不开发」）。
  //
  // 代码已就绪（`installNativeNotificationMirror` + 主进程 `corum:notify-native`），
  // 但 macOS（Electron 42+）的 UNNotification **要求代码签名**：本仓开发态与打包版
  // 都是 `linker-signed`，UNNotification 不接受 → 通知必然静默失败
  // （实测 `{ok:false, error:'UNErrorDomain错误1'}`）。
  // 在签名与分发配置就位前打开它只会白跑 IPC，故先关；签名解决后把下面的开关
  // 置 true 即可启用（无需改其他代码）。详见
  // `docs/ASSESSMENT-tray-floating-system-notification.md` §0.5。
  const NATIVE_NOTIFICATIONS_ENABLED = false
  if (NATIVE_NOTIFICATIONS_ENABLED) {
    ctx.effect(
      () => installNativeNotificationMirror(notifications),
      'corum-desktop: native notification mirror',
    )
  }

  // macOS 菜单栏托盘的渲染层半边（2026-09-10 用户「托盘常驻要做」+「托盘提示消息
  // 数量」）：把未读数推给主进程显示在菜单栏标题上，并接托盘菜单的「通知中心」动作。
  // 不走 ctx.inject —— 它只依赖 preload 桥与 notifications store，无 cordis 服务依赖。
  ctx.effect(
    () => installTrayBridge(notifications),
    'corum-desktop: tray bridge',
  )

  // The resident Monaco editor (design.pen ③ 编辑器区合并卡，2026-09-03 改版：
  // 编辑器 + 资源管理器合一张卡): registered into the shell's `corum.editor`
  // slot (declared by @corum/corum-ide-ui, IDE mode only). Monaco's worker/
  // protocol infrastructure lives in this client bundle, so the editor column
  // registers here rather than in a separate plugin (which would have to
  // re-bundle Monaco + re-plumb the worker protocol).
  // inject 面 closeRegion 直通 ctx.layout.closeRegion（原 CLOSE_REGION_EVENT
  // 窗口事件桥已退役）；explorer 面（listDir + generation）内嵌资源管理器
  // 子面板的数据源——原独立插件 @corum/corum-ide-explorer-ui 已并入本卡。
  ctx.inject(['slots', 'layout', 'connection', 'sessions', 'conversation', 'workspaces', 'remote'], (editorCtx) => {
    const connection = editorCtx.get('connection') as ConnectionHandle
    // P2-8：corumFs 调用面收进服务（11 个 RPC 封装单点定义），provide 到 client root
    // 供任意 bundle inject；本 bundle 的 EditorColumn 注入面经同一实例转调。
    const corumFs = createCorumFsClient(connection)
    editorCtx.provide('corumFsClient', corumFs)

    // ── 资源管理器根目录跟随当前工作区/会话（2026-09-04 用户定调：空态不该
    // 默认打开 host cwd——树/编辑器必须关联当前项目/任务
    // 的工作区）。优先级：当前会话 cwd > 首个工作区 path；**都没有（未打开
    // 项目/无会话）→ 广播空态**（资源管理器显示「未打开项目」提示，不开
    // host cwd）。
    const sessionsSvc = editorCtx.get('sessions') as {
      list: { subscribe: (fn: () => void) => () => void; getSnapshot: () => { current?: string; byId: Record<string, { cwd?: string }> } }
    } | undefined
    const workspacesSvc = editorCtx.get('workspaces') as {
      list: { subscribe: (fn: () => void) => () => void; getSnapshot: () => { items: { path: string }[] } }
    } | undefined
    let lastRoot: string | null = null
    /** 当前工作区根的只读快照（ExplorerPane 初始挂载时读——事件可能先于
     *  组件挂载发出而丢失，快照是最可靠的初始态）。 */
    const workspaceRootSnapshot = {
      get: (): { root: string | null; rootName: string | null } => {
        if (lastRoot === null || lastRoot === '') return { root: null, rootName: null }
        const base = lastRoot.split(/[\\/]/).filter(Boolean).pop() ?? null
        return { root: lastRoot, rootName: base }
      },
    }
    const syncRoot = (): void => {
      const snap = sessionsSvc?.list.getSnapshot()
      const currentCwd = snap?.current !== undefined && snap.current !== '' ? snap.byId[snap.current]?.cwd : undefined
      const target = (currentCwd !== undefined && currentCwd !== '')
        ? currentCwd
        : workspacesSvc?.list.getSnapshot().items[0]?.path
      if (target === undefined || target === '') {
        // 未打开项目：广播空态（ExplorerPane 显示提示，不渲染 dsh 树）。
        if (lastRoot !== '') {
          lastRoot = ''
          window.dispatchEvent(new CustomEvent('corum:workspace-root-changed', { detail: { root: null } }))
        }
        return
      }
      if (target === lastRoot) return
      lastRoot = target
      void corumFs.setRoot(target).then(() => {
        // 换根后重启 watch + 通知 EditorColumn 刷新树（cordis 红线：同 bundle
        // 内 CustomEvent 是合法的一次性信号，非共享可变状态）。
        void corumFs.watch()
        window.dispatchEvent(new CustomEvent('corum:workspace-root-changed', { detail: { root: target } }))
      }).catch((err: unknown) => {
        console.warn('[corum-desktop] corumFs/setRoot failed', err)
      })
    }
    // 启动时 + 会话/工作区列表变化时各同步一次。
    syncRoot()
    const unsubSessions = sessionsSvc?.list.subscribe(syncRoot)
    const unsubWorkspaces = workspacesSvc?.list.subscribe(syncRoot)
    editorCtx.effect(() => () => {
      unsubSessions?.()
      unsubWorkspaces?.()
    }, 'corum-desktop: workspace root tracking')

    // ── 「在编辑器打开」可编程入口（corumEditor cordis 服务）──
    // 统一事件中心三-2：原 chat → desktop 的 corum:open-in-editor 跨 bundle
    // CustomEvent（fire-and-forget + 100ms 轮询 3s 等 EditorColumn 挂载）服务化。
    // chat 经 inject 'corumEditor' + 局部能力接口收窄调 openFile(absolute)，拿到
    // { ok, error } 结构化反馈；EditorColumn 未挂载时请求挂起，挂载经
    // readySource 通知认领（pending 模式，替代轮询）。
    const rawEditorApiRef: EditorApiRef = { openFile: null, openContentDiff: null }
    const editorReady = createEditorReadySource()
    // 任一 api 写入/清空都通知就绪源（EditorColumn 挂载/卸载）→ 认领 pending。
    //
    // 两个 setter 都必须 notify：EditorColumn 的 mount effect 是
    // `openFile = …; openContentDiff = …` 顺序赋值，而 setter 里的 notify 是
    // **同步**的 —— 若只有 openFile 触发认领，挂起中的 diff 请求会在
    // openContentDiff 赋上前就被认领一次、看到 null 而放弃，之后再无通知，
    // 最终 3s 超时（实测过的坑）。
    const editorApiRef: EditorApiRef = {
      get openFile() { return rawEditorApiRef.openFile },
      set openFile(fn) {
        rawEditorApiRef.openFile = fn
        editorReady.notify()
      },
      get openContentDiff() { return rawEditorApiRef.openContentDiff },
      set openContentDiff(fn) {
        rawEditorApiRef.openContentDiff = fn
        editorReady.notify()
      },
    }

    /** 绝对路径 → corumFs 相对路径（去掉 lastRoot 前缀，保证 / 开头）。 */
    const toRelativePath = (absolute: string): string | null => {
      return workspaceRelativePath(lastRoot, absolute)
    }

    const corumEditor = createCorumEditor(editorApiRef, editorReady, {
      toRelativePath,
      openExternalPreview: async (absolute) => {
        const result = await corumFs.openExternalPreview(absolute)
        if (!result.ok || result.value === undefined) {
          throw new Error(result.error?.message ?? '无法打开外部文件预览')
        }
        return result.value
      },
      currentRoot: () => lastRoot,
      showEditorRegion: () => {
        // 点亮编辑器区域（两层隐藏一次清）：
        // ① 树 leaf.hidden 持久化标记 → setRegionHidden('corum.editor', false)；
        // ② AppFrame userShown 运行时隐藏集（DEFAULT_HIDDEN 场景，① 管不到）→
        //    layout.showRegion（LayoutController 新增面，AppFrame showRegion 的单槽
        //    包装，同时清 ①+②；保留 ① 让语义显式且防御未来实现变化）。
        // 跨 bundle 窄接口收窄（dev-conventions §2.4 红线 3）：editorCtx.layout 的
        // 类型面是官方基线 ILayout（无 showRegion），用局部能力接口 + 可选链
        // 防御——实现缺该面时静默跳过（编辑器仍可由用户手动点亮），不强耦合
        // ide-ui 实现包。原「setTimeout 50ms + 读 localStorage 字符串匹配 + 模拟
        // 点按钮」hack（6c43655c 引入）随本接口落地删除。
        editorCtx.layout.setRegionHidden('corum.editor', false)
        const layoutShowCapable = editorCtx.layout as unknown as ShowRegionCapableLayout
        layoutShowCapable.showRegion?.('corum.editor')
      },
    })
    // cordis 服务 provide（跨 bundle 单例，root reflect.store 保证）；fiber
    // dispose 时自动撤销注册。
    editorCtx.provide('corumEditor', corumEditor)

    const dispose = editorCtx.slots.inject('corum.editor', () => editorCtx.slots.register(
      {
        name: 'corum.editor',
        inject: (): EditorColumnInjected => ({
          closeRegion: () => { editorCtx.layout.closeRegion('corum.editor') },
          showEditor: () => { editorCtx.layout.setRegionHidden('corum.editor', false) },
          editorApi: editorApiRef,
          explorer: {
            generation: connection.generation,
            workspaceRoot: workspaceRootSnapshot,
            listDir: async (path) => await corumFs.list(path),
          },
          readFile: async (path) => await corumFs.read(path),
          readBinary: async (path) => await corumFs.readBinary(path),
          writeFile: async (path, content) => await corumFs.write(path, content),
          mkdirp: async (path) => await corumFs.mkdir(path),
          deletePath: async (path) => await corumFs.delete(path),
          renamePath: async (from, to) => await corumFs.rename(from, to),
          absolutePath: async (path) => await corumFs.absolutePath(path),
          revealPath: async (path) => await corumFs.reveal(path),
          startWatch: async () => await corumFs.watch(),
          // 统一事件中心：文件变更走官方 forwarded-Remote-event 通道（host
          // corumFs 在 watcher 去抖回调里 emit 批量 changes；真实推送——三期已删
          // 2s pollChanges 兜底 + host 端点）。$on 返回的 dispose 由组件 unmount 时调用。
          onFileChanged: (listener) => editorCtx.remote.$on('corum/file/changed', listener),
          addToConversation: (path: string) => {
            // 方案 A（子代理调查结论）：@path 追加进当前会话草稿，与手打
            // @-mention 完全同构（发送时发路径文本，agent 侧工具自行读文件）。
            // conversation 是 cordis service（root 单例），sessions.scope 寻址
            // 当前会话——不碰红线（inject 获取，非 window 全局）。
            const sessionsSvc = editorCtx.get('sessions') as {
              scope: (id: string) => Context
              list: { getSnapshot: () => { current?: string } }
            } | undefined
            const currentId = sessionsSvc?.list.getSnapshot().current
            if (sessionsSvc === undefined || currentId === undefined || currentId === '') {
              return { ok: false as const, error: '当前没有打开的会话' }
            }
            const scoped = sessionsSvc.scope(currentId)
            const conversation = scoped.get('conversation') as {
              input: { for: (actx: Context) => { setDraft: (t: string) => void; state: { getSnapshot: () => { draft: string } } } }
            } | undefined
            if (conversation === undefined) {
              return { ok: false as const, error: '会话服务未就绪' }
            }
            const input = conversation.input.for(scoped)
            const draft = input.state.getSnapshot().draft
            input.setDraft(draft + (draft.endsWith(' ') || draft === '' ? '' : ' ') + `@${path} `)
            return { ok: true as const }
          },
        }),
      },
      EditorColumn,
    ))
    return () => {
      dispose()
    }
  })
}
