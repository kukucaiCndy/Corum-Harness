/**
 * @corum/shell-base client half — 通用壳基座。
 *
 * 只导出通用机制，不含任何业务槽位与主题装饰：
 *   - GridView / RegionCard：自由二维网格渲染与区域卡片基座
 *   - grid.ts：布局树类型 + 全部树操作 + 槽位注册机制 + 构造 helper
 *     （leafNode/rowBranch/columnBranch）+ key 可配的持久化
 *   - region-events.ts：区域关闭/侧栏切换事件名
 *   - ThemePresenter：主题快照 → DOM 投影
 *   - base-theme.css：极简默认主题（字体栈 + 动效降级），构建期内联
 *
 * 子壳（如 ide-shell）在其上 registerSlot() 自己的槽位、用构造 helper
 * 写默认布局、叠自己的主题层。
 */
export { GridView } from './GridView.tsx'
export type { GridViewProps } from './GridView.tsx'
export { RegionCard, INTERACTIVE_SELECTOR } from './RegionCard.tsx'
export type { RegionCardProps } from './RegionCard.tsx'
export { FloatingLayer, useFloatingLayer, floatingLayerHost } from './FloatingLayer.tsx'
export type { FloatingItem, FloatingLayerApi } from './FloatingLayer.tsx'
export { CLOSE_REGION_EVENT, TOGGLE_SIDEBAR_EVENT, SET_REGION_HIDDEN_EVENT, RESET_LAYOUT_EVENT } from './region-events.ts'
export { ThemePresenter, DARK_ATTRIBUTE } from './theme-presenter.ts'
export * from './grid.ts'
import './base-theme.css'
