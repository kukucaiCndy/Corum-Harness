/**
 * @corum/corum-ui-split-pane client half —— 通用分栏容器 + 经验沉淀取舍视图。
 *
 * ## 交付物
 *
 * 1. **SplitPane 组件**（`./SplitPane.tsx`）：左右分栏、中缝可拖拽、比例持久化、
 *    两栏独立滚动。通用容器，不耦合业务。
 * 2. **内容注册服务 `splitPaneContent`**（cordis provide）：`registerRenderer(key, fn)`
 *    + 渲染分发。本包自注册 `distill-review` 渲染器；未来其他包可经同一服务注册
 *    新内容（红线 1：跨 bundle 共享状态走 cordis 服务）。
 * 3. **DistillReviewView**（`./DistillReviewView.tsx`）：经验沉淀取舍视图，接
 *    `corumAgent/distill*` 五个 RPC。
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
import { SplitPane } from './SplitPane.tsx'
import { DistillReviewView, type DistillReviewViewProps } from './DistillReviewView.tsx'
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
 * 本包自注册 `distill-review` 渲染器；未来其他包可经 `registerRenderer` 注册
 * 新内容键，occupant 按 payload.key 查渲染器分发。
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
export { DistillReviewView } from './DistillReviewView.tsx'
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
 * 2. 自注册 `distill-review` 渲染器。
 * 3. 注册 `corum.splitpane` 槽 occupant：订阅 onOpenSplitPane + 认领
 *    consumePendingSplitPane + getSplitPanePayload 恢复，按 payload.key 分发渲染器。
 *
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
  // 1. 内容注册服务（cordis provide，跨 bundle 单例）。
  const contentService = new SplitPaneContentServiceImpl()
  ctx.provide('splitPaneContent', contentService)

  // 2. 自注册 distill-review 渲染器（经验取舍视图）。
  //    RPC caller 在 occupant 渲染时经 SplitPaneRpcContext 下发（见 SplitPaneOccupant）。
  ctx.effect(
    () => contentService.registerRenderer('distill-review', (props) => {
      const splitProps: DistillReviewViewProps = {}
      if (typeof props.jobId === 'string') splitProps.jobId = props.jobId
      if (typeof props.sessionId === 'string') splitProps.sessionId = props.sessionId
      if (typeof props.close === 'function') splitProps.close = props.close as () => void
      return <DistillReviewView {...splitProps} />
    }),
    'corum-split-pane: register distill-review renderer',
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
            <button type="button" className={css.closeBtn} onClick={handleClose} aria-label="关闭">✕</button>
          </header>
          <div className={css.empty}>
            <p>未知内容类型「{payload.key}」，无已注册的渲染器。</p>
          </div>
        </div>
      </SplitPaneRpcContext.Provider>
    )
  }

  // 渲染器经 Context 拿到 rpc；props 透传 payload.props。
  // closeSplitPane 经 payload.props.close 下发给内容组件（DistillReviewView 读它）。
  const contentProps = { ...payload.props, close: handleClose }
  const content = renderer(contentProps)
  return (
    <SplitPaneRpcContext.Provider value={rpc}>
      {content}
    </SplitPaneRpcContext.Provider>
  )
}
