/**
 * 分栏容器的**注入面**与**跨 bundle 线类型**。
 *
 * ## 为什么不 import host 实现包类型（红线 3）
 *
 * dsh 会把 `@corum/*` 源码内联进每个消费方 bundle，跨包 import 会把整个
 * host 实现包拉进本包的 bundle 图。故这里**本地声明** wire 类型，改动时
 * 两处需同步——但类型面收窄、运行期按 RPC 服务名取值，不耦合实现。
 *
 * ## RPC 通道先例
 *
 * 照 `@corum/corum-ide-integrations-pages-ui` 的 `IntegrationsRpcContext` 先例：
 * `ctx.get('connection')` 取官方 ConnectionHandle → `makeCorumRpcCall(connection)`
 * 构造 `CorumRpcCall` → 经 React Context 下发给纯组件。组件不接 cordis ctx，
 * 可跨包复用（与 McpPage / SkillsPage 的形态同构）。
 *
 * 2026-11 分栏会话：distill* 五个 RPC 的 wire 类型与回放视图已随 DistillReviewView
 * 迁出本包（搬到 corum-memory 包，另一任务负责）；本包只保留通用 RPC 通道
 * （SplitPaneRpcContext / useSplitPaneRpc）与分栏 layout 能力面。
 *
 * ## 能力接口（红线 3 + 红线 4）
 *
 * `SplitPaneCapableLayout` 收窄 `ctx.layout`（cordis 服务名 'layout'）新增的
 * 分栏 API 面。照 `corum-ui-conversation` 的 `SidebarModeCapableLayout` 先例：
 * 本地定义能力接口 + 延迟取服务（`ctx.get('layout')`），不用 `ctx.get` 取未
 * 装配服务（红线 4：callback 执行时 ide-shell 已激活，layout 一定已 provide）。
 *
 * @module corum-ui-split-pane/client/face
 */
import { createContext, useContext } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'

/* ── 能力接口：SplitPaneCapableLayout（红线 3 收窄 ctx.layout）── */

/** 分栏视图的打开载荷（壳 LayoutController 新增的 SplitPaneOpenPayload）。 */
export interface SplitPaneOpenPayload {
  key: string
  title: string
  props?: Record<string, unknown>
}

/**
 * ctx.layout 的分栏能力面（corum IDE 壳 LayoutController 提供，超出官方
 * 基座窄 ILayout 的部分）。cordis 服务跨 bundle 单例，本插件经它读/写
 * 分栏打开态，壳的 layout 控制器经同一服务发 openSplitPane 事件。
 *
 * ⚠️ 照 `corum-ui-conversation` 的 `SidebarModeCapableLayout` 先例（红线 3 + 4）：
 * 不 import 实现包类型，本地定义收窄面；用 `ctx.get('layout')` 延迟取——
 * apply 里订阅 onOpenSplitPane 是同步注册（服务名 'layout' 已在 inject 声明），
 * 回调执行时 layout 一定已 provide。
 */
export interface SplitPaneCapableLayout {
  openSplitPane(payload: SplitPaneOpenPayload): void
  onOpenSplitPane(listener: (payload: SplitPaneOpenPayload) => void): () => void
  consumePendingSplitPane(): SplitPaneOpenPayload | null
  getSplitPanePayload(): SplitPaneOpenPayload | null
  closeSplitPane(): void
}

/**
 * 取 ctx.layout 的分栏能力面。
 *
 * layout 在 inject 里声明（硬依赖），apply 同步路径直接取；若回调里延迟取，
 * 用此函数 fail-soft（照 SidebarModeCapableLayout 的 fail-soft 纪律）。
 * @param ctx - client context。
 * @returns 分栏能力面；layout 未装配时返回 no-op stub。
 */
export function splitPaneLayout(ctx: Context): SplitPaneCapableLayout {
  const layout = ctx.get('layout')
  if (layout === undefined) {
    // 不应到达（inject 已声明 'layout'）。但 fail-soft 而非 crash。
    return {
      openSplitPane() { /* layout not yet available */ },
      onOpenSplitPane() { return () => {} },
      consumePendingSplitPane() { return null },
      getSplitPanePayload() { return null },
      closeSplitPane() { /* layout not yet available */ },
    }
  }
  return layout as unknown as SplitPaneCapableLayout
}

/* ── RPC 注入面（照 IntegrationsRpcContext 先例）── */

/** 分栏内容的 RPC 调用函数上下文（与 IntegrationsRpcContext 同形同义）。 */
export const SplitPaneRpcContext = createContext<CorumRpcCall | null>(null)

/** 取出 RPC 调用函数；未 provide 时返回 null（视图降级为可重试提示）。 */
export function useSplitPaneRpc(): CorumRpcCall | null {
  return useContext(SplitPaneRpcContext)
}
