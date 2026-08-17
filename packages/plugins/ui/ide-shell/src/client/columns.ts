/**
 * SplitView-style column geometry for the corum IDE shell.
 *
 * The four columns are the design.pen L1 主界面 tracks:
 *
 *   ┌ 会话列表(280) │ 对话区(flex) │ 编辑器区(430) │ 资源管理器(210) ┐   ← Main Row (gap 14, padding 16)
 *   └ 底部面板 (150) ───────────────────────────────────────────────┘
 *   └ 状态栏 (34) ──────────────────────────────────────────────────┘
 *
 * The drag model is VSCode's SplitView "adjacent push" (splitview.ts resize,
 * L1235–1321): dragging a seam hands the delta to the columns beside it, from
 * nearest to farthest, clamping each at its own min/max and letting the
 * residue flow to the next column. Columns NEVER auto-close under a drag —
 * they compress to their floor and stay. The conversation center is the only
 * column allowed to absorb an unbounded share; it has the lowest floor.
 *
 * Layout (CSS grid) still resolves the center as `minmax(0,1fr)`, so this
 * solver only owns the three fixed tracks (sidebar / editor / explorer); the
 * center is whatever the grid leaves. The drag therefore only has to keep the
 * three fixed tracks inside the budget — the center flexes around them.
 */

/** Resolved fixed-track widths (the center is the grid's flex remainder). */
export interface Columns {
  sidebar: number
  center: number
  editor: number
  explorer: number
}

// Contract-frozen geometry from design.pen L1 主界面 (source of truth).
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
/** Conversation (center) floor; the grid may take it to 0 only as a last resort. */
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
 * Solve the resting column widths for one frame (no active drag). The sidebar
 * keeps its preference (or the rail); editor and explorer keep theirs; the
 * center is the remainder. If even at floors the fixed tracks overflow the
 * budget, the center is allowed to drop below CENTER_MIN (toward 0) — the
 * columns never auto-close, matching the SplitView model.
 * @param trackSpace - available column-track width in px (frameTrackSpace).
 * @param sidebar - sidebar width preference in px (0 = rail).
 * @param editor - editor column width preference in px.
 * @param explorer - explorer column width preference in px.
 * @returns resolved widths; the center is the flex remainder (may be < CENTER_MIN).
 */
export function computeColumns(trackSpace: number, sidebar: number, editor: number, explorer: number): Columns {
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const e = clampWidth(editor, EDITOR_MIN, EDITOR_MAX)
  const x = clampWidth(explorer, EXPLORER_MIN, EXPLORER_MAX)
  const center = Math.max(0, trackSpace - s - e - x)
  return { sidebar: s, center, editor: e, explorer: x }
}

/**
 * One column's drag geometry: its min/max and current width. The center is
 * the flex remainder and is modelled as a track with the CENTER_MIN floor.
 */
export interface TrackSpec {
  min: number
  max: number
  size: number
}

/**
 * VSCode SplitView sash resize (splitview.ts resize, L1235–1321), verbatim
 * semantics for a single sash between two columns.
 *
 * A sash sits BETWEEN the column at `leftIndex` and `leftIndex+1`. Dragging by
 * `delta` (px, + = sash moves right) asks the LEFT side to grow by delta and
 * the RIGHT side to shrink by delta. Both sides absorb nearest-first: the
 * left side takes space (clamped at each column's max), the right side gives
 * space (clamped at each column's min); residue the whole side cannot absorb
 * flows to the next column outward, and whatever NEITHER side can absorb
 * clamps the delta. Sizes never leave [min,max] and columns never close.
 *
 * @param tracks - every column's spec, in layout order (left → right).
 * @param sashIndex - the index of the column on the LEFT of the dragged sash.
 * @param delta - requested sash movement in px (+ = right, − = left).
 * @returns the new sizes for every track (same order as `tracks`).
 */
export function resizeSash(tracks: TrackSpec[], sashIndex: number, delta: number): number[] {
  const sizes = tracks.map((t) => t.size)
  const mins = tracks.map((t) => t.min)
  const maxs = tracks.map((t) => t.max)

  // Clamp the raw delta to what BOTH sides can absorb (VSCode computes
  // minDelta/maxDelta from the two sides' cumulative headroom).
  // Left side grows (toward max), right side shrinks (toward min).
  let maxGrow = 0
  for (let i = 0; i <= sashIndex; i++) maxGrow += maxs[i] - sizes[i]
  let maxShrinkRight = 0
  for (let i = sashIndex + 1; i < tracks.length; i++) maxShrinkRight += sizes[i] - mins[i]
  // Left side shrinks (toward min), right side grows (toward max).
  let maxShrinkLeft = 0
  for (let i = 0; i <= sashIndex; i++) maxShrinkLeft += sizes[i] - mins[i]
  let maxGrowRight = 0
  for (let i = sashIndex + 1; i < tracks.length; i++) maxGrowRight += maxs[i] - sizes[i]

  const d = Math.max(-Math.min(maxShrinkLeft, maxGrowRight), Math.min(Math.min(maxGrow, maxShrinkRight), delta))
  if (d === 0) return sizes

  if (d > 0) {
    // Sash moves right: left side grows, right side shrinks.
    let grow = d
    for (let i = sashIndex; i >= 0 && grow > 0; i++) {
      const take = Math.min(grow, maxs[i] - sizes[i])
      sizes[i] += take
      grow -= take
    }
    let shrink = d
    for (let i = sashIndex + 1; i < tracks.length && shrink > 0; i++) {
      const give = Math.min(shrink, sizes[i] - mins[i])
      sizes[i] -= give
      shrink -= give
    }
  } else {
    // Sash moves left: left side shrinks, right side grows.
    let shrink = -d
    for (let i = sashIndex; i >= 0 && shrink > 0; i++) {
      const give = Math.min(shrink, sizes[i] - mins[i])
      sizes[i] -= give
      shrink -= give
    }
    let grow = -d
    for (let i = sashIndex + 1; i < tracks.length && grow > 0; i++) {
      const take = Math.min(grow, maxs[i] - sizes[i])
      sizes[i] += take
      grow -= take
    }
  }
  return sizes
}
