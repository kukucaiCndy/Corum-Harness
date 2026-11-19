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
 *    右栏 EmbeddedConversation（目标会话，同会话双开时 readOnly）。
 *
 * ## 消费契约（另一任务并行实现，按此 import 不得改名）
 *
 * 从 `@corum/corum-ui-conversation/client` 导出：
 *   - `EmbeddedConversation(props: { sessionId: string; readOnly?: boolean }): ReactNode`
 *     完整会话视图（含迷你头），readOnly 时无输入区。
 *   - `useMainSessionId(): string | undefined`  当前主会话 id（随侧栏切换跟随）。
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
 * - **红线 3**：不 import 壳实现包类型，本地定义 `SplitPaneCapableLayout` 能力
 *   接口收窄 + inject 声明（照 conversation 包 SidebarModeCapableLayout 先例）。
 * - **红线 4**：不用 `ctx.get` 取未装配服务；layout 在 inject 声明里。
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
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// type-only：把壳的 SlotMap 行（corum.splitpane 的 owner 契约）拉进本编译单元。
import type {} from '@corum/corum-ide-ui/client'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
// 消费契约：分栏会话视图 + 主会话 id 钩子（另一任务并行实现，按此 import 不得改名）。
import { EmbeddedConversation, useMainSessionId } from '@corum/corum-ui-conversation/client'
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
 * `layout` 给分栏打开态读写（SplitPaneCapableLayout 能力面）。
 */
export const inject = ['slots', 'connection', 'layout']

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

  // 2. 自注册 session 渲染器（分栏会话视图）。
  //    mainId（useMainSessionId）在渲染器内部取——渲染器是组件，故由
  //    SessionSplitContent 组件内部调 hook，而非 apply 闭包传入。
  //    close 经 payload.props.close 下发（occupant 构造时注入）。
  ctx.effect(
    () => contentService.registerRenderer('session', (props) => {
      const targetId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const close = typeof props.close === 'function' ? (props.close as () => void) : undefined
      return <SessionSplitContent targetId={targetId} {...(close !== undefined ? { close } : {})} />
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
            <span className={css.frameTitle}>{payload.title}</span>
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

/** SessionSplitContent 的 props（由 session 渲染器构造）。 */
interface SessionSplitContentProps {
  /** 目标会话 id（payload.props.sessionId，string 校验后传入；undefined 表示缺失）。 */
  targetId: string | undefined
  /** 关闭回调（occupant 下发，调 closeSplitPane）。 */
  close?: () => void
}

/**
 * 分栏会话视图：左栏主会话、右栏目标会话。
 *
 * - mainId = useMainSessionId()（随侧栏切换跟随）。
 * - targetId = payload.props.sessionId（string 校验）。
 * - mainId undefined + target 缺失 → 空态提示。
 * - target === mainId 时右栏 readOnly（同会话双开只读，规避输入单槽冲突）。
 * - 左右栏各自独立滚动由 EmbeddedConversation 内部负责；SplitPane 两栏容器
 *   overflow 处理不双重滚动（paneWrapper 设 overflow:hidden 让子组件自管滚动）。
 *
 * storageKey='session-split'（比例持久化键）。
 *
 * @param props - 见 {@link SessionSplitContentProps}。
 * @returns 视图元素。
 */
function SessionSplitContent(props: SessionSplitContentProps): ReactNode {
  const { targetId, close } = props
  const mainId = useMainSessionId()

  // 边界：mainId undefined + target 缺失 → 空态提示。
  if (mainId === undefined && targetId === undefined) {
    return (
      <div className={css.frame}>
        <header className={css.frameHeader}>
          <span className={css.frameTitle}>分栏会话</span>
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

  // 右栏 readOnly：target===mainId 时同会话双开只读（规避输入单槽冲突）。
  const rightReadOnly = targetId !== undefined && targetId === mainId
  // 右栏 sessionId：target 缺失时回落 mainId（至少展示一个会话，不白屏）。
  const rightSessionId = targetId ?? mainId ?? ''

  return (
    <div className={css.frame}>
      <header className={css.frameHeader}>
        <span className={css.frameTitle}>分栏会话</span>
        <span className={css.sessionIdLabel} title={rightSessionId}>
          {rightSessionId}
        </span>
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
              {mainId !== undefined ? (
                <EmbeddedConversation sessionId={mainId} />
              ) : (
                <div className={css.paneEmpty}>
                  <p>无主会话</p>
                </div>
              )}
            </div>
          }
          right={
            <div className={css.paneWrapper}>
              <EmbeddedConversation sessionId={rightSessionId} readOnly={rightReadOnly} />
            </div>
          }
          storageKey="session-split"
          defaultRatio={0.5}
        />
      </div>
    </div>
  )
}
