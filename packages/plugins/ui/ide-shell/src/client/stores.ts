/**
 * The IDE shell's transient layout store. GridView 接管后，列/行几何由分割树
 * （grid.ts weights）持有，这里只剩两个壳层面板：details 抽屉（官方
 * ui-conversation 的 DetailsPanel，openDetails/closeDetails 驱动）和底部
 * 面板（corum.panel 槽，togglePanel/setBottom 驱动）。
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** details 抽屉宽度夹取范围。 */
export const DETAILS_MIN = 300
export const DETAILS_MAX = 520
export const DETAILS_DEFAULT = 360

/** 底部面板高度夹取范围（0 = 收起）。 */
export const BOTTOM_COLLAPSED = 0
export const BOTTOM_DEFAULT = 150
export const BOTTOM_MIN = 120
export const BOTTOM_MAX = 420

/** 夹取一个面板尺寸到 [min, max]。 */
export function clampSize(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

type LayoutState = {
  /** details 抽屉宽度（0 = 关闭）。 */
  details: number
  /** 底部面板高度（0 = 收起）。 */
  bottom: number
}

type LayoutActions = {
  setDetails: (draft: LayoutState, px: number) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  setBottom: (draft: LayoutState, px: number) => void
  togglePanel: (draft: LayoutState) => void
}

/**
 * Create the IDE layout store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  return defineStore({
    init: (): LayoutState => ({
      details: 0,
      bottom: BOTTOM_COLLAPSED,
    }),
    actions: {
      setDetails: (d, px: number) => { d.details = clampSize(px, DETAILS_MIN, DETAILS_MAX) },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
      setBottom: (d, px: number) => { d.bottom = clampSize(px, BOTTOM_MIN, BOTTOM_MAX) },
      togglePanel: (d) => { d.bottom = d.bottom === BOTTOM_COLLAPSED ? BOTTOM_DEFAULT : BOTTOM_COLLAPSED },
    },
  })
}
