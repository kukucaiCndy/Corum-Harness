/**
 * The IDE shell's transient layout store: panel geometry as plain widths in px
 * (0 = closed), plus the narrow-viewport pair. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Actions are the complete write set; this store is the corum IDE
 * superset of the official ui-layout store (the inherited ILayout face keeps
 * its toggleSidebar/openDetails/closeDetails semantics, and the new panel
 * rows — editor + explorer + bottom + activity — add the IDE-only transitions).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  EDITOR_DEFAULT, EDITOR_MAX, EDITOR_MIN,
  EXPLORER_DEFAULT, EXPLORER_MAX, EXPLORER_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/**
 * Layout store state: panel width preferences in px (0 = closed), plus the
 * narrow-viewport pair. `bottom` is the bottom panel height preference (0 =
 * collapsed), `explorer` is the file-tree column width (0 = closed), `editor`
 * is the editor column width (0 = closed). The details panel is the official
 * ui-conversation drawer, still driven by openDetails/closeDetails.
 */
type LayoutState = {
  sidebar: number
  editor: number
  explorer: number
  details: number
  bottom: number
  narrow: boolean
  narrowExpanded: boolean
  activity: boolean
}

/** The bottom panel's contract height: collapsed vs. default open. */
export const BOTTOM_COLLAPSED = 0
export const BOTTOM_DEFAULT = 150
export const BOTTOM_MIN = 120
export const BOTTOM_MAX = 420

type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setEditor: (draft: LayoutState, px: number) => void
  setExplorer: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  openEditor: (draft: LayoutState) => void
  closeEditor: (draft: LayoutState) => void
  toggleEditor: (draft: LayoutState) => void
  openExplorer: (draft: LayoutState) => void
  closeExplorer: (draft: LayoutState) => void
  toggleExplorer: (draft: LayoutState) => void
  setBottom: (draft: LayoutState, px: number) => void
  togglePanel: (draft: LayoutState) => void
  toggleActivity: (draft: LayoutState) => void
}

/**
 * Create the IDE layout store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  return defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      editor: EDITOR_DEFAULT,
      explorer: EXPLORER_DEFAULT,
      details: 0,
      bottom: BOTTOM_COLLAPSED,
      narrow: false,
      narrowExpanded: false,
      activity: true,
    }),
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setEditor: (d, px: number) => { d.editor = clampWidth(px, EDITOR_MIN, EDITOR_MAX) },
      setExplorer: (d, px: number) => { d.explorer = clampWidth(px, EXPLORER_MIN, EXPLORER_MAX) },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
      openEditor: (d) => { if (d.editor === 0) d.editor = EDITOR_DEFAULT },
      closeEditor: (d) => { d.editor = 0 },
      toggleEditor: (d) => { d.editor = d.editor === 0 ? EDITOR_DEFAULT : 0 },
      openExplorer: (d) => { if (d.explorer === 0) d.explorer = EXPLORER_DEFAULT },
      closeExplorer: (d) => { d.explorer = 0 },
      toggleExplorer: (d) => { d.explorer = d.explorer === 0 ? EXPLORER_DEFAULT : 0 },
      setBottom: (d, px: number) => { d.bottom = clampWidth(px, BOTTOM_MIN, BOTTOM_MAX) },
      togglePanel: (d) => { d.bottom = d.bottom === BOTTOM_COLLAPSED ? BOTTOM_DEFAULT : BOTTOM_COLLAPSED },
      toggleActivity: (d) => { d.activity = !d.activity },
    },
  })
}
