/**
 * The IDE shell's transient layout store. GridView 接管后，列/行几何与终端等
 * 所有区域的显隐/调宽/组合都由分割树（grid.ts weights）持有，这里只剩 details
 * 抽屉（官方 ui-conversation 的 DetailsPanel，openDetails/closeDetails 驱动）。
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** details 抽屉宽度（固定；0 = 关闭）。 */
export const DETAILS_DEFAULT = 360

type LayoutState = {
  /** details 抽屉宽度（0 = 关闭）。 */
  details: number
}

type LayoutActions = {
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
}

/**
 * Create the IDE layout store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  return defineStore({
    init: (): LayoutState => ({
      details: 0,
    }),
    actions: {
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
    },
  })
}
