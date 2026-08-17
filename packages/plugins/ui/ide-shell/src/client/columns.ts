/**
 * Pure concession-chain column solver for the corum IDE shell.
 *
 * The IDE frame matches the design.pen L1 主界面 geometry:
 *
 *   ┌ 会话列表(280) │ 对话区(flex) │ 编辑器区(430) │ 资源管理器(210) ┐   ← Main Row (gap 14, padding 16)
 *   └ 底部面板 (150) ───────────────────────────────────────────────┘
 *   └ 状态栏 (34) ──────────────────────────────────────────────────┘
 *
 * Concession order (mirroring the official three-column solver):
 *   1. The sidebar (session list) keeps its preference — it never concedes.
 *   2. The explorer (file tree) column concedes first (shrink toward min).
 *   3. The editor column concedes second.
 *   4. The conversation column (center) absorbs any remaining deficit.
 *
 * The bottom panel is rendered INSIDE the frame as its own row (height), so it
 * participates in height, not width, and is handled by AppFrame, not here.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns {
  sidebar: number
  center: number
  editor: number
  explorer: number
}

// Contract-frozen geometry from design.pen L1 主界面 (source of truth). The
// sidebar value mirrors the official shell so the inherited ui-sidebar owner
// contract stays coherent.
/** Sidebar (session list) drag clamp floor. */
export const SIDEBAR_MIN = 240
/** Sidebar (session list) drag clamp ceiling. */
export const SIDEBAR_MAX = 400
/** Sidebar (session list) width before any user drag — design.pen ① 会话列表 280. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail. */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Editor column drag clamp floor. */
export const EDITOR_MIN = 340
/** Editor column drag clamp ceiling. */
export const EDITOR_MAX = 720
/** Editor column width before any user drag — design.pen ③ 编辑器区 430. */
export const EDITOR_DEFAULT = 430
/** Explorer (file tree) column drag clamp floor. */
export const EXPLORER_MIN = 180
/** Explorer (file tree) column drag clamp ceiling. */
export const EXPLORER_MAX = 320
/** Explorer (file tree) column width before any user drag — design.pen ④ 资源管理器 210. */
export const EXPLORER_DEFAULT = 210
/** Conversation (center) column floor; only the final fallback may go below it. */
export const CENTER_MIN = 400
/** Details drawer drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drawer drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details drawer width before any user drag. */
export const DETAILS_DEFAULT = 360
/** Outer frame padding (design.pen Main Row padding 16). */
export const FRAME_PADDING = 16
/** Column gap (design.pen Main Row gap 14). */
export const COLUMN_GAP = 14
/** Number of columns in the IDE grid (session-list / center / editor / explorer). */
export const COLUMN_COUNT = 4

/**
 * The track width budget for the column solver, derived from the frame's
 * border-box width: subtract the two outer paddings and the inter-column gaps.
 * The grid tracks sum to this value; the conversation center absorbs the rest.
 * @param frameWidth - the frame element's border-box width in px.
 * @returns the width available for column tracks in px.
 */
export function frameTrackSpace(frameWidth: number): number {
  return Math.max(0, frameWidth - FRAME_PADDING * 2 - COLUMN_GAP * (COLUMN_COUNT - 1))
}

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the IDE column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only. Preferences
 * re-clamp here because they cross the store boundary and callers may still
 * supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param editor - editor column width preference in px (0 = closed).
 * @param explorer - explorer column width preference in px (0 = closed).
 * @returns resolved widths; explorer 0 means visually closed.
 */
export function computeColumns(viewport: number, sidebar: number, editor: number, explorer: number): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const e0 = editor === 0 ? 0 : clampWidth(editor, EDITOR_MIN, EDITOR_MAX)
  const x0 = explorer === 0 ? 0 : clampWidth(explorer, EXPLORER_MIN, EXPLORER_MAX)
  // Width available to the conversation center after the fixed columns.
  const remaining = Math.max(0, viewport - s)

  // Step 1: everything fits at preferred widths.
  if (e0 + x0 + CENTER_MIN <= remaining) {
    return { sidebar: s, center: remaining - e0 - x0, editor: e0, explorer: x0 }
  }

  // Step 2: shrink the explorer toward its minimum.
  const x1 = x0 === 0 ? 0 : Math.max(EXPLORER_MIN, remaining - e0 - CENTER_MIN)
  if (e0 + x1 + CENTER_MIN <= remaining) {
    return { sidebar: s, center: CENTER_MIN, editor: e0, explorer: x1 }
  }

  // Step 3: shrink the editor toward its minimum (explorer already at floor).
  const e1 = e0 === 0 ? 0 : Math.max(EDITOR_MIN, remaining - x1 - CENTER_MIN)
  if (e1 + x1 + CENTER_MIN <= remaining) {
    return { sidebar: s, center: CENTER_MIN, editor: e1, explorer: x1 }
  }

  // Step 4: auto-close the explorer (derived — preferences untouched).
  if (e0 + CENTER_MIN <= remaining) {
    return { sidebar: s, center: remaining - e0, editor: e0, explorer: 0 }
  }

  // Step 5: auto-close the editor too; center absorbs any remaining deficit.
  return { sidebar: s, center: remaining, editor: 0, explorer: 0 }
}
