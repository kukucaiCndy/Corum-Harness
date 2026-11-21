/**
 * @corum/corum-ui-split-pane client half —— 通用分栏容器 + 分栏会话视图。
 *
 * ## 交付物
 *
 * 1. **SplitPane 组件**（`./SplitPane.tsx`）：左右分栏、中缝可拖拽、比例持久化、
 *    两栏独立滚动。通用容器，不耦合业务（保留不动）。
 * 2. **内容注册服务 `splitPaneContent`**（cordis provide）：`registerRenderer(key, fn)`
 *    + 渲染分发。本包自注册 `session` 渲染器（分栏会话）；未来其他包可经同一
 *    服务注册新内容（红线 1：跨 bundle 共享状态走 cordis 服务）。
 * 3. **分栏会话视图**（`SessionSplitContent`）：左栏 EmbeddedConversation（主会话）、
 *    右栏 EmbeddedConversation（目标会话）。mode 支持 'session'|'chat'|'view'
 *    三态：view 只读；chat 可交互（同会话时只读）；session 常规。
 *    target 缺失显式空态（不回落 mainId）。
 *    fork（corum, 2026-11-19）：frameHeader 精简为仅 closeBtn（移除了冗余标题条/
 *    sessionIdLabel/进度条——用户裁定不需要）。
 *
 * ## 消费契约（红线 1：cordis 服务，不做跨 bundle 运行时 import）
 *
 * 从 `conversationEmbed` cordis 服务（由 @corum/corum-ui-conversation provide）拿：
 *   - `EmbeddedConversation(props: { sessionId: string; readOnly?: boolean; hintText?: string }): ReactNode`
 *     完整会话视图（**整张外壳** = conversation 槽 occupant 即 ConversationRoot，
 *     含列宽轴/边距 gutter/滚动手柄/composer；自带身份行）。`readOnly` 时输入区让位
 *     改一行提示（`hintText` 覆盖措辞）。
 *   - `useMainSessionId(): string | undefined`  当前主会话 id（随侧栏切换跟随）。
 * apply 里 `inject('conversationEmbed')` + `ctx.get('conversationEmbed')` 取服务实例，
 * 写入模块级 `conversationEmbedRef`；SessionSplitContent 渲染时读 ref 拿组件引用。
 *
 * ## 挂载
 *
 * 占壳声明的网格槽 `corum.splitpane`（壳 @corum/corum-ide-ui 的 SlotMap/children/
 * IDE_GRID_SLOTS 已声明）。本包照 testsuite occupant 先例：`ctx.slots.inject`
 * 注册 occupant，apply 时订阅 `onOpenSplitPane` + 认领 `consumePendingSplitPane` +
 * `getSplitPanePayload` 恢复。
 *
 * ## 跨 bundle 红线
 *
 * - **红线 1**：EmbeddedConversation / useMainSessionId 经 `conversationEmbed` cordis
 *   服务拿（不做 `@corum/corum-ui-conversation/client` 运行时 import——dsh 内联会
 *   导致 duplicate factory registration）。
 * - **红线 3**：不 import 壳实现包类型，本地定义 `SplitPaneCapableLayout` +
 *   `ConversationEmbedCapability` 能力接口收窄 + inject 声明（照 conversation 包
 *   SidebarModeCapableLayout 先例）。
 * - **红线 4**：不用 `ctx.get` 取未装配服务；layout + conversationEmbed 在 inject 声明里。
 * - **RPC 通道**：照 `corum-ide-integrations-pages-ui` 的 IntegrationsRpcContext
 *   先例——`ctx.get('connection')` → `makeCorumRpcCall(connection)` → React
 *   Context 下发。
 *
 * 登记位置：`packages/desktop/cordis.ide.patch.yml` insert 段 +
 * `packages/desktop/package.json` 与 `packages/desktop/desktop-host/package.json`
 * 的 dependencies。
 *
 * @module corum-ui-split-pane/client
 */
import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// type-only：把壳的 SlotMap 行（corum.splitpane 的 owner 契约）拉进本编译单元。
import type {} from '@corum/corum-ide-ui/client'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
import { X } from 'lucide-react'
import { SplitPane } from './SplitPane.tsx'
import {
  SplitPaneRpcContext,
  splitPaneLayout,
  type SplitPaneCapableLayout,
  type SplitPaneOpenPayload,
} from './face.ts'
import css from './index.module.css'

/* ── 内容注册服务：splitPaneContent（红线 1：cordis 服务）── */

/** 内容渲染器函数签名：props → ReactNode。 */
export type SplitPaneContentRenderer = (props: Record<string, unknown>) => ReactNode

/**
 * 分栏内容注册服务。cordis provide 单例（跨 bundle 唯一，红线 1）。
 *
 * 本包自注册 `session` 渲染器（分栏会话）；未来其他包可经 `registerRenderer`
 * 注册新内容键，occupant 按 payload.key 查渲染器分发。
 */
export interface SplitPaneContentService {
  /** 注册一个内容渲染器（key 唯一，重复注册覆盖后者）。返回注销函数。 */
  registerRenderer(key: string, renderer: SplitPaneContentRenderer): () => void
  /** 取已注册的渲染器；未知 key 返回 undefined。 */
  getRenderer(key: string): SplitPaneContentRenderer | undefined
}

/** 服务的实现（模块级 Map，经 cordis provide 保证跨 bundle 单例）。 */
class SplitPaneContentServiceImpl implements SplitPaneContentService {
  private readonly renderers = new Map<string, SplitPaneContentRenderer>()

  registerRenderer(key: string, renderer: SplitPaneContentRenderer): () => void {
    this.renderers.set(key, renderer)
    return () => {
      // 只在仍是同一个渲染器时摘除（避免后注册者被先注册者的注销函数误删）。
      if (this.renderers.get(key) === renderer) {
        this.renderers.delete(key)
      }
    }
  }

  getRenderer(key: string): SplitPaneContentRenderer | undefined {
    return this.renderers.get(key)
  }
}

/** 增强 cordis Context：splitPaneContent 服务。 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    splitPaneContent: SplitPaneContentService
  }
}

/** 增强 SlotMap：corum.splitpane 槽（壳已声明，此处仅 type-only 消费）。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 分栏容器槽（壳声明、本包 occupant）。 */
    'corum.splitpane': { kind: 'single'; scope: 'root' }
  }
}

/* ── 分栏会话视图消费面（红线 1 + 3 + 4）── */

/**
 * `conversationEmbed` 服务的本地能力接口（红线 3：不 import 实现包类型）。
 *
 * corum-ui-conversation 包在 apply 里 provide 此服务（cordis 单例），暴露
 * EmbeddedConversation + useMainSessionId。本包经 inject 声明拿服务实例，
 * 不做跨 bundle 运行时 import（dsh 内联会导致 duplicate factory）。
 */
interface ConversationEmbedCapability {
  readonly EmbeddedConversation: (props: {
    sessionId: string
    readOnly?: boolean
    hintText?: string
  }) => ReactNode
  readonly useMainSessionId: () => string | undefined
}

/**
 * 模块级 ref：apply 从 conversationEmbed 服务取到组件引用后写入；
 * SessionSplitContent 在渲染时读（渲染必在 apply 之后，故 ref 已挂）。
 *
 * 同 bundle 模块单例合法（红线 1 管跨 bundle 状态；此 ref 只在本 bundle 读）。
 */
const conversationEmbedRef: { current: ConversationEmbedCapability | null } = { current: null }

export { SplitPane } from './SplitPane.tsx'
export {
  SplitPaneRpcContext,
  useSplitPaneRpc,
  splitPaneLayout,
  type SplitPaneCapableLayout,
  type SplitPaneOpenPayload,
} from './face.ts'
export type { SplitPaneProps } from './SplitPane.tsx'

/**
 * Required services：`slots` 给 inject/register，`connection` 给 RPC 调用函数，
 * `layout` 给分栏打开态读写（SplitPaneCapableLayout 能力面），
 * `conversationEmbed` 给分栏会话视图（EmbeddedConversation + useMainSessionId，
 * 红线 1：经 cordis 服务拿组件引用，不做跨 bundle 运行时 import）。
 *
 * fork（corum, 2026-11-19 入口精简轮）：`sessions` / `remote` 已移除——
 * sessions 仅被 readDisplayTitle（frameTitle）消费，remote 仅被 useViewProgress
 * 消费；两者随分栏顶部进度条/冗余标题条移除一并退役。
 */
export const inject = ['slots', 'connection', 'layout', 'conversationEmbed']

/**
 * Client plugin body。
 *
 * 1. provide `splitPaneContent` 内容注册服务（红线 1：cordis 服务单例）。
 * 2. 自注册 `session` 渲染器（分栏会话视图）。
 * 3. 注册 `corum.splitpane` 槽 occupant：订阅 onOpenSplitPane + 认领
 *    consumePendingSplitPane + getSplitPanePayload 恢复，按 payload.key 分发渲染器。
 *
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
  // 1. 内容注册服务（cordis provide，跨 bundle 单例）。
  const contentService = new SplitPaneContentServiceImpl()
  ctx.provide('splitPaneContent', contentService)

  // 1b. 从 conversationEmbed 服务拿分栏会话视图组件引用（红线 1：cordis 服务，
  // 不做跨 bundle 运行时 import）。conversationEmbed 在 inject 声明里，apply 同步
  // 路径取值安全。写入模块级 ref 供 SessionSplitContent 渲染时读。
  const conversationEmbed = ctx.get('conversationEmbed') as ConversationEmbedCapability | undefined
  if (conversationEmbed !== undefined) {
    conversationEmbedRef.current = conversationEmbed
  }

  // 1c. fork（corum, 2026-11-19 入口精简轮）：sessions / remote 已移除
  //     （sessions 仅被 readDisplayTitle/frameTitle 消费、remote 仅被
  //     useViewProgress 消费；两者随分栏顶部进度条/冗余标题条移除一并退役）。

  // 2. 自注册 session 渲染器（分栏会话视图）。
  //    mainId（useMainSessionId）在渲染器内部取——渲染器是组件，故由
  //    SessionSplitContent 组件内部调 hook，而非 apply 闭包传入。
  //    close 经 payload.props.close 下发（occupant 构造时注入）。
  //    mode 从 payload.props.mode 取（'session'|'chat'|'view'，缺省 'session'）。
  ctx.effect(
    () => contentService.registerRenderer('session', (props) => {
      const targetId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const close = typeof props.close === 'function' ? (props.close as () => void) : undefined
      const modeRaw = props.mode
      const mode = modeRaw === 'chat' || modeRaw === 'view' ? modeRaw : 'session'
      return <SessionSplitContent targetId={targetId} mode={mode} {...(close !== undefined ? { close } : {})} />
    }),
    'corum-split-pane: register session renderer',
  )

  // 3. connection → RPC caller（照 integrations-pages-ui 先例）。
  const connection = ctx.get('connection') as ConnectionHandle
  const rpc = makeCorumRpcCall(connection)

  // 4. layout 能力面（红线 3 + 4：inject 声明 + 能力接口收窄）。
  const layout = splitPaneLayout(ctx)

  // 5. 注册 corum.splitpane 槽 occupant。
  //    照 testsuite occupant 先例：ctx.slots.inject 保证「壳先声明、本包后注册」。
  ctx.effect(
    () => ctx.slots.inject('corum.splitpane', () => ctx.slots.register(
      {
        name: 'corum.splitpane',
      },
      () => <SplitPaneOccupant rpc={rpc} layout={layout} contentService={contentService} />,
    )),
    'corum-split-pane: corum.splitpane occupant',
  )
}

/* ── occupant 组件：按 payload.key 分发渲染器 ── */

/** occupant 的 props（由 apply 构造、经闭包传入）。 */
interface SplitPaneOccupantProps {
  rpc: ReturnType<typeof makeCorumRpcCall>
  layout: SplitPaneCapableLayout
  contentService: SplitPaneContentService
}

/**
 * 分栏容器的 occupant 组件。
 *
 * 订阅 `layout.onOpenSplitPane` 事件 + 认领 `consumePendingSplitPane`（首次
 * 打开）+ `getSplitPanePayload` 恢复（HMR / 重渲染）。按 payload.key 查
 * contentService 的渲染器；未知 key 显示空态。
 */
function SplitPaneOccupant(props: SplitPaneOccupantProps): ReactNode {
  const { rpc, layout, contentService } = props
  // 当前打开的 payload（经事件 / 认领 / 恢复三条路径汇合）。
  const [payload, setPayload] = useState<SplitPaneOpenPayload | null>(
    () => layout.consumePendingSplitPane() ?? layout.getSplitPanePayload(),
  )

  // 订阅 onOpenSplitPane 事件（壳 openSplitPane 时触发）。
  useEffect(() => {
    const off = layout.onOpenSplitPane((p) => {
      setPayload(p)
    })
    return off
  }, [layout])

  // 关闭：调 closeSplitPane + 清本地态。
  const handleClose = useCallback(() => {
    layout.closeSplitPane()
    setPayload(null)
  }, [layout])

  // 无 payload：不渲染（槽空着是预期——occupant 未被打开）。
  if (payload === null) return null

  // 查渲染器；未知 key 显示空态。
  const renderer = contentService.getRenderer(payload.key)
  if (renderer === undefined) {
    return (
      <SplitPaneRpcContext.Provider value={rpc}>
        <div className={css.frame}>
          <header className={css.frameHeader}>
            <button type="button" className={css.closeBtn} onClick={handleClose} aria-label="关闭">
              <X size={16} />
            </button>
          </header>
          <div className={css.empty}>
            <p>未知内容类型「{payload.key}」，无已注册的渲染器。</p>
          </div>
        </div>
      </SplitPaneRpcContext.Provider>
    )
  }

  // 渲染器经 Context 拿到 rpc；props 透传 payload.props。
  // closeSplitPane 经 payload.props.close 下发给内容组件（SessionSplitContent 读它）。
  const contentProps = { ...payload.props, close: handleClose }
  const content = renderer(contentProps)
  return (
    <SplitPaneRpcContext.Provider value={rpc}>
      {content}
    </SplitPaneRpcContext.Provider>
  )
}

/* ── 分栏会话视图组件 ── */

/** 分栏模式。 */
type SplitMode = 'session' | 'chat' | 'view'

/** SessionSplitContent 的 props（由 session 渲染器构造）。 */
interface SessionSplitContentProps {
  /** 目标会话 id（payload.props.sessionId，string 校验后传入；undefined 表示缺失）。 */
  targetId: string | undefined
  /** 分栏模式（payload.props.mode，缺省 'session'）。 */
  mode: SplitMode
  /** 关闭回调（occupant 下发，调 closeSplitPane）。 */
  close?: () => void
}

/**
 * 分栏会话视图：左栏主会话、右栏目标会话。
 *
 * - mainId = useMainSessionId()（随侧栏切换跟随）。
 * - targetId = payload.props.sessionId（string 校验）；缺失时**不再回落 mainId**，
 *   显式空态「未指定会话」（mode='session'/'chat' 的 target 缺失场景）。
 * - mode='session'（缺省）：常规分栏，右栏可交互。
 * - mode='chat'：右栏可交互（除非同会话 readOnly）。
 * - mode='view'：右栏 readOnly（查看子 Agent 会话）。
 * - rightReadOnly = targetId === mainId || mode === 'view'。
 * - 默认比例按 mode：chat/view 左 0.62（右栏窄）、session 左 0.5；
 *   有 localStorage corum.splitpane.session-split 值仍优先（SplitPane 内部处理）。
 *
 * fork（corum, 2026-11-19 入口精简轮）：frameHeader 精简为仅右对齐 closeBtn
 * （slim 高度）。移除了 frameTitle（冗余标题条——嵌入会话自带 Root 头部标题）、
 * sessionIdLabel、ProgressBadge + useViewProgress（用户裁定不需要顶部进度条/step）。
 *
 * storageKey='session-split'（比例持久化键，用户拖拽记忆不被 mode 覆盖）。
 *
 * @param props - 见 {@link SessionSplitContentProps}。
 * @returns 视图元素。
 */
function SessionSplitContent(props: SessionSplitContentProps): ReactNode {
  const { targetId, mode, close } = props
  // 红线 1：从 conversationEmbed 服务（模块级 ref）拿组件引用。apply 已在渲染前
  // 写入 ref（inject 声明保证 conversation 先激活）。useMainSessionId 是 React hook——
  // 在本组件函数内调，hook 闭包绑定 conversation bundle 的 scopedSlotComponents ref，
  // 后者绑定 renderer bundle 的 useScopeBinding（useContext 读 renderer 的 context）。
  // 组件渲染在 renderer React 树里（corum.splitpane 槽 occupant），context 已在上层。
  const embed = conversationEmbedRef.current
  const mainId = embed?.useMainSessionId()

  // 边界：mainId undefined + target 缺失 → 空态提示。
  if (mainId === undefined && targetId === undefined) {
    return (
      <div className={css.frame}>
        <header className={css.frameHeader}>
          {close !== undefined && (
            <button type="button" className={css.closeBtn} onClick={close} aria-label="关闭">
              <X size={16} />
            </button>
          )}
        </header>
        <div className={css.empty}>
          <p>暂无可用会话。请在侧栏选择一个会话后再打开分栏视图。</p>
        </div>
      </div>
    )
  }

  // target 缺失（但 mainId 存在）→ 显式空态「未指定会话」（删除旧 fallback 回落 mainId）。
  if (targetId === undefined) {
    return (
      <div className={css.frame}>
        <header className={css.frameHeader}>
          {close !== undefined && (
            <button type="button" className={css.closeBtn} onClick={close} aria-label="关闭">
              <X size={16} />
            </button>
          )}
        </header>
        <div className={css.empty}>
          <p>未指定会话。</p>
        </div>
      </div>
    )
  }

  // 右栏 readOnly：target===mainId（同会话双开只读）|| mode==='view'（查看模式只读）。
  const rightReadOnly = targetId === mainId || mode === 'view'
  // EmbeddedConversation 组件引用（经 conversationEmbed 服务拿，非运行时 import）。
  const EmbeddedConversation = embed?.EmbeddedConversation

  // 默认比例按 mode：chat/view 左 0.62（右栏窄）、session 左 0.5。
  // 有 localStorage corum.splitpane.session-split 值仍优先（SplitPane 的 readStoredRatio 处理）。
  const defaultRatio = mode === 'session' ? 0.5 : 0.62

  return (
    <div className={css.frame}>
      <header className={css.frameHeader}>
        {close !== undefined && (
          <button type="button" className={css.closeBtn} onClick={close} aria-label="关闭">
            <X size={16} />
          </button>
        )}
      </header>
      <div className={css.body}>
        <SplitPane
          left={
            <div className={css.paneWrapper}>
              {mainId !== undefined && EmbeddedConversation !== undefined ? (
                createElement(EmbeddedConversation, { sessionId: mainId })
              ) : (
                <div className={css.paneEmpty}>
                  <p>无主会话</p>
                </div>
              )}
            </div>
          }
          right={
            <div className={css.paneWrapper}>
              {EmbeddedConversation !== undefined ? (
                createElement(EmbeddedConversation, {
                  sessionId: targetId,
                  // 2026-11-19「外壳对齐轮」：只读是**外壳级 owner prop**（Root 收到后
                  // 整条输入区让位、改一行提示），不是本包自造的「无 composer 迷你壳」。
                  // 按成因分开传：
                  //   · mode='view' → 另一个会话（通常是子 Agent）的查看：readOnly +
                  //     自己的措辞（默认的「与左栏同一会话」在此语义是错的）；
                  //   · 同会话双开（target===mainId）→ readOnly + **不传** hintText，
                  //     用 Root 的默认文案「与左栏同一会话，输入请在左栏」；
                  //   · 异会话常规分栏（mode='session'/'chat'）→ 完全不传 readOnly
                  //     （两栏各自独立可交互）。
                  ...(rightReadOnly
                    ? {
                        readOnly: true,
                        ...(mode === 'view' ? { hintText: '子 Agent 会话 · 只读查看' } : {}),
                      }
                    : {}),
                })
              ) : (
                <div className={css.paneEmpty}>
                  <p>会话视图未就绪</p>
                </div>
              )}
            </div>
          }
          storageKey="session-split"
          defaultRatio={defaultRatio}
        />
      </div>
    </div>
  )
}
