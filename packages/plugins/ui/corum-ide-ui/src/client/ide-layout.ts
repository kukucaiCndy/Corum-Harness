/**
 * ide-shell 的 IDE 业务布局与槽位 —— 子壳注入层。
 *
 * shell-base 提供网格/区域/槽位的通用机制（不含业务槽位与默认布局）；本文件
 * 是 IDE 壳的特化：注册 IDE 的业务槽位（corum.*），并用 base 的构造 helper
 * 定义 IDE 默认布局（row[sidebar, column[conversation, panel], editor, explorer]，
 * 终端在对话区列下方，与其他区域同构可自由组合）。
 * @module ide-shell/client/ide-layout
 */
import {
  registerSlot, leafNode, rowBranch, columnBranch,
  type GridNode,
} from '@corum/corum-ui-base/client'

/** IDE 布局的持久化 key（沿用 v3，保住存量用户布局）。 */
export const IDE_GRID_STORAGE_KEY = 'corum.ide.grid.v3'

/** 透明整卡的槽位（对话区子卡独立、间隙透出背景，设计稿无外层整卡）。
 *  corum.sidebar 同列：左列 = 标题栏（卡片外）+ 侧栏玻璃卡，外层 leaf 不再
 *  是整卡（否则标题栏被卡片 padding 包住、贴不到左列顶）。 */
export const IDE_TRANSPARENT_SLOTS: ReadonlySet<string> = new Set(['conversation', 'corum.sidebar'])

// ── IDE 业务槽位注册 ──
// 初始值（defaultWeight）与最小值（minWidth/minHeight）均以 2026-08-26 用户全屏
// 实机调整好的实测几何为准（窗口 1728×1004）。用户定调：各区域当前值 = 最小值，
// 可拉宽/拉高、不可比当前更窄/更低；编辑器吸收剩余（minWidth 205 仅兜底防压垮）。
//   - sidebar 283（可拉宽，不可更窄）
//   - conversation 509（可拉宽，不可更窄）
//   - explorer 205（最右侧，可拉宽，不可更窄）
//   - editor 吸收剩余（minWidth 205 兜底）
//   - corum.panel 终端 minHeight 227（可拉高，不可更低）
registerSlot('corum.sidebar', { label: '会话列表', defaultWeight: 283, minWidth: 283 })
registerSlot('conversation', { label: '对话区', defaultWeight: 509, minWidth: 509 })
registerSlot('corum.editor', { label: '编辑器', defaultWeight: 700, minWidth: 205 })
registerSlot('corum.explorer', { label: '资源管理器', defaultWeight: 205, minWidth: 205 })
// 终端：与其他区域同构的普通网格叶子，可调宽、可自由组合（design.pen ⑥）。
registerSlot('corum.panel', { label: '终端', defaultWeight: 227, minHeight: 227 })

/**
 * IDE 默认布局（design.pen L1 主界面 2026-08-26 交互改版）：
 *   根 row = [ left-body, right-col ]
 *   - left-body（row）：col-nav 侧栏 280 │ 对话区（Agent 标题栏在其上方）
 *   - right-col（column）：row-top（编辑器 │ 资源管理器）上方 + hvh 终端下方横跨
 * 终端在 right-col 下方（不再挂在对话区列内），与编辑器/资源管理器同列、高度
 * 随 right-col 内 sash 上下可调，仍可拖到任意位置自由组合。所有列宽/行高用户可调。
 */
export function ideDefaultGrid(): GridNode {
  // 初始几何与 registerSlot 的 defaultWeight 一致（2026-08-26 用户全屏实机值）。
  return rowBranch(
    [
      // left-body：侧栏 283 + 对话区 509（对话区占满该列剩余高度）。
      rowBranch(
        [leafNode('corum.sidebar'), leafNode('conversation')],
        [283, 509],
      ),
      // right-col：row-top（编辑器 700 + 资源管理器 205）上方 + 终端 227 下方。
      columnBranch(
        [
          rowBranch(
            [leafNode('corum.editor'), leafNode('corum.explorer')],
            [700, 205],
          ),
          leafNode('corum.panel'),
        ],
        // row-top 707 / 终端 227（column 分支沿高度分，总 934 内容高）。
        [707, 227],
      ),
    ],
    // left-body 792 / right-col 905 的相对份额（1728 - frame padding 32）。
    [792, 905],
  )
}
