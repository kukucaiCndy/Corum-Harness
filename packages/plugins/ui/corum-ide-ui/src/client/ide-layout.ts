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
// sidebar 钉住（pinned）：IDE combo 下侧栏位置/宽度固定——不可被 drop 拖走/
// 拖入 split/swap，其余四区域（convo/editor/explorer/终端）自由组合不卷入它。
// 宽度仍可由其右缘 root sash 手调（minWidth 283），但不被其它区域拖动带跑。
registerSlot('corum.sidebar', { label: '会话列表', defaultWeight: 283, minWidth: 283, pinned: true })
registerSlot('conversation', { label: '对话区', defaultWeight: 509, minWidth: 509 })
registerSlot('corum.editor', { label: '编辑器', defaultWeight: 700, minWidth: 205 })
registerSlot('corum.explorer', { label: '资源管理器', defaultWeight: 205, minWidth: 205 })
// 终端：与其他区域同构的普通网格叶子，可调宽、可自由组合（design.pen ⑥）。
registerSlot('corum.panel', { label: '终端', defaultWeight: 227, minHeight: 227 })

/**
 * IDE 默认布局（design.pen L1 主界面 2026-08-27 结构修正）：
 *   根 row = [ sidebar, conversation, right-col ] —— 三列同为 root 直接子节点。
 *   - sidebar 独立成 root 第一列（2026-08-27 用户定调：IDE combo 下侧栏位置/
 *     宽度固定，不被其它区域拖动带跑）。其宽度只由 sidebar│conversation 那条
 *     root sash 决定；拖 convo/editor/终端任何其它边都不会改变侧栏宽度。
 *   - conversation 与 right-col 之间是 root sash，拖动只调 convo 宽 vs 右侧整列，
 *     侧栏纹丝不动（修复「拖 convo 右边 nav 跟着变」——旧结构 convo 与 editor
 *     被拆进 left-body/right-col 两个分支，convo 右缘只剩 root left-body│right-col
 *     sash，拖动整列导致 nav 同比变化）。
 *   - right-col（column）：row-top（编辑器 │ 资源管理器）上方 + 终端下方横跨
 *     （终端只在编辑器+资源管理器下方，不跨侧栏/对话区）。
 * 所有列宽/行高用户可调，各区域保有各自 minWidth/minHeight。
 */
export function ideDefaultGrid(): GridNode {
  // 初始几何与 registerSlot 的 defaultWeight 一致（2026-08-26 用户全屏实机值）。
  return rowBranch(
    [
      // 侧栏 283（独立 root 列，宽度不被其它区域拖动影响）。
      leafNode('corum.sidebar'),
      // 对话区 509（与侧栏、右侧整列各隔一条 root sash，独立可调）。
      leafNode('conversation'),
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
    // sidebar 283 / convo 509 / right-col 905 的相对份额（1728 - frame padding 32）。
    [283, 509, 905],
  )
}
