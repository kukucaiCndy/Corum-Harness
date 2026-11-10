/**
 * ide-shell 的 IDE 业务布局与槽位 —— 子壳注入层。
 *
 * shell-base 提供网格/区域/槽位的通用机制（不含业务槽位与默认布局）；本文件
 * 是 IDE 壳的特化：注册 IDE 的业务槽位（corum.*），并用 base 的构造 helper
 * 定义 IDE 默认布局（row[sidebar, conversation, column[editor, panel]]，
 * 编辑器卡内嵌资源管理器子面板，终端在编辑器卡下方，与其他区域同构可自由组合）。
 * @module ide-shell/client/ide-layout
 */
import {
  registerSlot, leafNode, rowBranch, columnBranch,
  type GridNode,
} from '@corum/corum-ui-base/client'

/** IDE 布局的持久化 key（沿用 v3，保住存量用户布局）。 */
export const IDE_GRID_STORAGE_KEY = 'corum.ide.grid.v3'

/**
 * IDE 壳的静态网格槽域（B2：单一事实源——唯一手写字面量清单）。
 *
 * 覆盖本壳放进网格/可浮动的内建槽位；下方 registerSlot 调用与 ideDefaultGrid
 * 布局树由它经 `satisfies` 编译期强制对齐（槽名拼写/重命名即刻编译错）。
 * 与官方 SlotMap（index.tsx 的 declare module）的对齐由 AppFrame 的
 * renderDynamicSlot 边界 helper 兜底（key 不在 SlotMap 声明域时 renderSlot 编译
 * 报错）。运行时网格槽域仍是宽 string（用户可拖入任意已注册槽，见 AppFrame）。
 */
export const IDE_GRID_SLOTS = [
  'corum.sidebar',
  'conversation',
  'corum.editor',
  'corum.trajectory',
  'corum.panel',
  'corum.testsuite',
  'details',
] as const

/** IDE 壳的网格槽 key 类型（IDE_GRID_SLOTS 的字面量联合）。 */
export type IdeGridSlot = (typeof IDE_GRID_SLOTS)[number]

/** 透明整卡的槽位（对话区子卡独立、间隙透出背景，设计稿无外层整卡）。
 *  corum.sidebar 同列：左列 = 标题栏（卡片外）+ 侧栏玻璃卡，外层 leaf 不再
 *  是整卡（否则标题栏被卡片 padding 包住、贴不到左列顶）。 */
export const IDE_TRANSPARENT_SLOTS: ReadonlySet<string> = new Set(['conversation', 'corum.sidebar'])

// ── IDE 业务槽位注册 ──
// 初始值（defaultWeight）与最小值（minWidth/minHeight）均以 2026-08-26 用户全屏
// 实机调整好的初始几何为准（窗口 1728×1004）。编辑器 minWidth 205 兜底防压垮。
//   - sidebar 300（2026-08-27 用户调整；可拉宽，不可更窄）
//   - conversation 默认 509、**最小 360**（2026-10-22 变更，见下）
//   - editor 合并卡吸收剩余（minWidth 205 兜底；2026-09-03 设计改版：编辑器+
//     资源管理器合一张卡，资源管理器 210px 子面板内嵌卡右缘、卡内 sash 调宽）
//   - corum.panel 终端 minHeight 227（可拉高，不可更低）
//
// **conversation 的最小宽度被改过口径，不要再按「只能拉宽」读这条**：
// 2026-08-26 的原始口径是「各区域当前值 = 最小值，可拉宽、不可比当前更窄」，
// 故当时 minWidth 与 defaultWeight 同为 509；2026-10-22 用户要求「对话栏允许
// 缩至 360px，便于向左扩大编辑区」（PR #116），最小宽度因此放宽到 360。
// 配套改动：InputBar 工具组改 flex-wrap（窄栏分行，不让模型/发送钮被挤没）。
// 要再动这个数字，先确认这条需求是否还有效——它推翻了上一轮的实机结论。
// sidebar 钉住（pinned）：IDE combo 下侧栏位置/宽度固定——不可被 drop 拖走/
// 拖入 split/swap，其余三区域（convo/editor/终端）自由组合不卷入它。
// 宽度仍可由其右缘 root sash 手调（minWidth 300），但不被其它区域拖动带跑。
// `satisfies` 锚定槽域（B2）：key 拼错/多写 IDE_GRID_SLOTS 之外的槽名即编译错。
// 折叠宽 **0**（2026-09-30 定案 = 整列隐藏）：GridView 折叠态直接把 collapsedWidth
// 当 locked 宽度用（grid.ts leafMinSize / GridView 的 locked 映射），0 ⇒ 该格不
// 占位、主区吃满；原值 56 会在折叠后留一条空槽。展开入口 = 常驻标题栏最左的
// 折叠/展开按钮（NavTitleBar），折叠态不再留图标轨。
registerSlot('corum.sidebar' satisfies IdeGridSlot, { label: '会话列表', defaultWeight: 260, minWidth: 240, pinned: true, collapsedWidth: 0, visibility: 'fixed' })
registerSlot('conversation' satisfies IdeGridSlot, { label: '对话区', defaultWeight: 509, minWidth: 360, visibility: 'fixed' })
registerSlot('corum.editor' satisfies IdeGridSlot, { label: '编辑器', defaultWeight: 700, minWidth: 205, visibility: 'fixed' })
// 轨迹区域（2026-09-09 用户定调：抽屉形态不好用，改为独立区域——与编辑器/终端
// 同构的右侧网格叶子，右上角轨迹按钮点亮）。occupant 由 fork #12 包
// @corum/corum-ui-trajectory 注册（它持有官方轨迹视图）；默认隐藏（DEFAULT_HIDDEN）。
registerSlot('corum.trajectory' satisfies IdeGridSlot, { label: '轨迹', defaultWeight: 260, minWidth: 320, visibility: 'fixed' })
// 终端：与其他区域同构的普通网格叶子，可调宽、可自由组合（design.pen ⑥）。
registerSlot('corum.panel' satisfies IdeGridSlot, { label: '终端', defaultWeight: 227, minHeight: 227, visibility: 'fixed' })
// 测试中心：右侧整列的网格叶子，**与编辑器/资源管理器同占一个位**（用户 2026-11-03
// 定调：「展开后不要覆盖会话栏，而是占用之前编辑器和资源管理器的槽位」——这样
// 对话区与侧栏都留着，可以边对话边看面板）。
//
// 它**不是**全屏工作面：旧实现是 testSuiteOpen 时把整个 mainRow 置 hidden、再在
// 网格外渲染占满活动栏右侧的面板，会话栏与对话区一并消失。改为网格叶子后，
// 开合只是「在右列把 editor 叶子换成测试中心」（见 AppFrame 的 renderGridSlot
// 特殊分支 + effectiveDetached 的互斥位），网格本身始终可见。
//
// defaultWeight 与 corum.editor 取同量级（700）：它是同一格的替身，宽度不该跳变。
// visibility 'fixed'：位置由壳决定，不进「添加区域」清单（与编辑器/终端同档）。
registerSlot('corum.testsuite' satisfies IdeGridSlot, { label: '测试中心', defaultWeight: 700, minWidth: 480, visibility: 'fixed' })

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
 *   - right-col（column）：编辑器合并卡（编辑器 main │ 资源管理器 210 子面板，
 *     同一张玻璃卡内嵌，design.pen 2026-09-03 改版 cZcBX）上方 + 终端下方横跨
 *     （终端只在编辑器卡下方，不跨侧栏/对话区）。
 * 所有列宽/行高用户可调，各区域保有各自 minWidth/minHeight。
 */
export function ideDefaultGrid(): GridNode {
  // 初始几何与 registerSlot 的 defaultWeight 一致（2026-08-26 用户全屏实机值）。
  // leafNode 槽名经 satisfies 锚定 IDE_GRID_SLOTS（B2）：拼错即编译错；树本身
  // 仍是宽 string 槽域（运行时用户可拖入任意已注册槽）。
  return rowBranch(
    [
      // 侧栏 300（独立 root 列，宽度不被其它区域拖动影响）。
      leafNode('corum.sidebar' satisfies IdeGridSlot),
      // 对话区 509（与侧栏、右侧整列各隔一条 root sash，独立可调）。
      leafNode('conversation' satisfies IdeGridSlot),
      // right-col：编辑器合并卡（资源管理器子面板内嵌卡内）上方 + 终端 227 下方。
      columnBranch(
        [
          leafNode('corum.editor' satisfies IdeGridSlot),
          // 轨迹区域默认隐藏（hidden leaf 不占高度）；点亮后与编辑器/终端三分右列。
          leafNode('corum.trajectory' satisfies IdeGridSlot),
          leafNode('corum.panel' satisfies IdeGridSlot),
          // 测试中心：与编辑器**同一格**的替身（2026-11-03 用户定调）。开合只由
          // AppFrame 的 testSuiteOpen 经 effectiveDetached 的互斥位驱动——打开时
          // editor 脱出、本叶子显示。
          //
          // **不能**写成 `{ ...leafNode(...), hidden: true }`：树的 hidden 是
          // 持久化的「用户关闭」位，GridView 的 BranchView 把它与运行时脱出合并成
          // 同一个折叠判定（`detachedSlots.has(slot) || leaf.hidden === true`），
          // 于是 effectiveDetached 再怎么 delete 都删不掉它——叶子恒折叠、occupant
          // 永不挂载（现象：点按钮后 aria-pressed 变 true 但面板 count=0）。
          // 默认隐藏一律走「运行时脱出」那种写法（见 DEFAULT_HIDDEN；轨迹叶子
          // 在树里也没有 hidden 标记）。
          leafNode('corum.testsuite' satisfies IdeGridSlot),
        ],
        // 编辑器卡 450 / 轨迹 260 / 终端 227 / 测试中心 450——测试中心取编辑器
        // 同量级份额（它是同一格的替身，占的正是编辑器让出来的那段高度）。
        [450, 260, 227, 450],
      ),
    ],
    // sidebar 300 / convo 509 / right-col 905 的相对份额（1728 主窗口边距=0）。
    [300, 509, 905],
  )
}
