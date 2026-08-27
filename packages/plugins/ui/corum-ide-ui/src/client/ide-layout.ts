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
// minWidth：各区域 sash 拖拽收窄的下限（均可拖宽、不能更窄）。
//   - sidebar 280（2026-08-26 用户全屏实机对齐后的实测固定值：窗口标题栏按钮区
//     右缘 = 侧栏右缘，gap 0；用户定 minWidth=280 可拖宽）。
//   - conversation 500（用户定：可拖宽、不能更窄）。
//   - editor / explorer 205（实 208，略低防 Σmin 顶到窗口宽度触发等比压缩兜底）。
// minHeight 未声明的区域统一走 shell-base 兜底固定值（160）。
registerSlot('corum.sidebar', { label: '会话列表', defaultWeight: 280, minWidth: 280 })
registerSlot('conversation', { label: '对话区', defaultWeight: 800, minWidth: 500 })
registerSlot('corum.editor', { label: '编辑器', defaultWeight: 430, minWidth: 205 })
registerSlot('corum.explorer', { label: '资源管理器', defaultWeight: 210, minWidth: 205 })
// 终端：与其他区域同构的普通网格叶子，可调宽、可自由组合（design.pen ⑥）。
registerSlot('corum.panel', { label: '终端', defaultWeight: 150, minHeight: 160 })

/**
 * IDE 默认布局（design.pen L1 主界面 2026-08-26 交互改版）：
 *   根 row = [ left-body, right-col ]
 *   - left-body（row）：col-nav 侧栏 280 │ 对话区（Agent 标题栏在其上方）
 *   - right-col（column）：row-top（编辑器 │ 资源管理器）上方 + hvh 终端下方横跨
 * 终端在 right-col 下方（不再挂在对话区列内），与编辑器/资源管理器同列、高度
 * 随 right-col 内 sash 上下可调，仍可拖到任意位置自由组合。所有列宽/行高用户可调。
 */
export function ideDefaultGrid(): GridNode {
  return rowBranch(
    [
      // left-body：侧栏 + 对话区（对话区占满该列剩余高度）。
      rowBranch(
        [leafNode('corum.sidebar'), leafNode('conversation')],
        [280, 530],
      ),
      // right-col：row-top（编辑器 + 资源管理器）上方 + 终端下方。
      columnBranch(
        [
          rowBranch(
            [leafNode('corum.editor'), leafNode('corum.explorer')],
            [504, 210],
          ),
          leafNode('corum.panel'),
        ],
        // row-top 占满剩余高度，终端 130（column 分支沿高度分）。
        [810, 130],
      ),
    ],
    // left-body 856 / right-col（fill）的相对份额。
    [856, 744],
  )
}
