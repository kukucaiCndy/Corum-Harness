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

/** 透明整卡的槽位（对话区子卡独立、间隙透出背景，设计稿无外层整卡）。 */
export const IDE_TRANSPARENT_SLOTS: ReadonlySet<string> = new Set(['conversation'])

// ── IDE 业务槽位注册 ──
// minWidth 以 2026-08-26 用户实机调好的区域位置为下限（此后 sash 不能再收窄
// 到它以下；值略低于实测位置 2-3px，防 Σmin 顶到窗口宽度触发等比压缩兜底）：
//   sidebar 335 / conversation 495（实 497）/ editor 205（实 208）/ explorer 205。
// minHeight 未声明的区域统一走 shell-base 兜底固定值（160）。
registerSlot('corum.sidebar', { label: '会话列表', defaultWeight: 280, minWidth: 335 })
registerSlot('conversation', { label: '对话区', defaultWeight: 800, minWidth: 495 })
registerSlot('corum.editor', { label: '编辑器', defaultWeight: 430, minWidth: 205 })
registerSlot('corum.explorer', { label: '资源管理器', defaultWeight: 210, minWidth: 205 })
// 终端：与其他区域同构的普通网格叶子，可调宽、可自由组合（design.pen ⑥）。
registerSlot('corum.panel', { label: '终端', defaultWeight: 150, minHeight: 160 })

/**
 * IDE 默认布局（design.pen L1 主界面）：根 row = 四列，对话区列内上下分
 * （对话区 + 底部终端）。终端宽度随对话区列左右可调、高度随列内 sash 上下
 * 可调，且可拖到任意位置与其他区域自由组合（不再是横贯整宽的固定行）。
 */
export function ideDefaultGrid(): GridNode {
  return rowBranch(
    [
      leafNode('corum.sidebar'),
      columnBranch(
        [leafNode('conversation'), leafNode('corum.panel')],
        // 对话区占满剩余高度，终端 150（column 分支沿高度分）。
        [810, 150],
      ),
      leafNode('corum.editor'),
      leafNode('corum.explorer'),
    ],
    // 280 / 对话列(flex) / 430 / 210 的相对份额（对话列取一个较大 flex 值）。
    [280, 800, 430, 210],
  )
}
