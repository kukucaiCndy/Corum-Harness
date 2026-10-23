/**
 * IntegrationsFrame —— 集成中心（design.pen yXkOK 画板 F 定稿，PR4）。
 *
 * 「集成中心全屏独占工作面」的**面板本体**：活动栏底部组「插件」图标点亮后，
 * 本组件占满活动栏右侧的**全部宽度**（侧边栏与会话区一起让位——集成中心是
 * 统一模型里「没有侧栏部分的工作面」，故自然全幅，不是特例）。
 *
 * 结构（画板 F `CeM2r` 逐帧对照）：
 *
 *   ┌ 面板头 48（icon 26 · 标题「集成中心」· spacer · × 关闭）──────────────┐
 *   ├ 子导航 118（插件 / MCP 服务器 / 技能 / 扩展包 / 市场：pill r8）────────┤
 *   └ 内容区（renderSlot 五个子槽之一）─────────────────────────────────────┘
 *
 * ## 职责边界（PR4 / PR5 / PR6 分工）
 * 本组件只持**骨架**：面板头、子导航、五个内容子槽的**渲染**。五个内容页
 * （PluginsPage / McpPage / SkillsPage / ExtensionsPage / MarketPage）
 * 分别由 `corum-ide-integrations-ui` 与 `corum-ide-integrations-pages-ui`
 * 作为 occupant 注册进来（声明权在本壳的 `index.tsx` root 条目的 children 表，
 * 见那里的五键登记）。
 *
 * ## 顶栏让位 40px
 * 壳的窗口标题栏行（AppFrame 的 titlebarRow）是覆盖左列的 absolute 浮层，
 * 宽度跟随侧栏右缘；集成中心面板落在它下方 ⇒ 面板**内容**整体下移 40px
 * （与活动栏自身的 40px 让位、网格格的 leafTopOffset 同一条壳约定），
 * 否则面板头的 icon/标题会压在 macOS 红绿灯与那排图标按钮下面。面板自身
 * 的玻璃底仍贯通到窗口顶。
 *
 * ## 子导航状态为什么在 AppFrame
 * 工作面与子导航都是**壳级**状态：工作面切换要动 AppFrame 的行布局（会话区
 * 让位），子导航选中态只是面板内的视图选择。二者同住 AppFrame，本组件保持
 * 纯展示 + 回调（无内部 state）——与壳「纯组件，一切经 props 到达」的约定一致。
 *
 * @module corum-ide-ui/client/IntegrationsFrame
 */
import type { ReactNode } from 'react'
import { Blocks, Package, Server, Store, WandSparkles, X, type LucideIcon } from 'lucide-react'
import css from './IntegrationsFrame.module.css'

/**
 * 集成中心内容子槽的 owner 面：**空标记**。
 *
 * 内容页所需的全部数据面（RPC caller / 注入面）由**它们各自的注册方**自带
 * （PR5 经 `inject` 下发 `callRemote`，PR6 经 `IntegrationsRpcContext` 下发），
 * 骨架不下发任何字段——不预设以后再删的占位。
 *
 * 类型住在真源点（本组件是这些槽的**渲染者**）；`index.tsx` 的 SlotMap 登记
 * 与 root children 声明都从本文件取它，避免「同一契约两处各写一份」的漂移。
 */
export interface IntegrationsPageOwnerProps {
  /** 标记字段：owner 面当前刻意为空。 */
  children?: never
}

/** 集成中心子导航五项（design.pen 画板 F：插件 · MCP 服务器 · 技能 · 扩展包 · 市场）。 */
export const INTEGRATIONS_SECTIONS = ['plugins', 'mcp', 'skills', 'extensions', 'market'] as const

/** 子导航键（= 五个内容子槽的短名）。 */
export type IntegrationsSection = (typeof INTEGRATIONS_SECTIONS)[number]

/** 五个内容子槽 key 的字面量联合（`renderSlot` 收窄面的参数域）。 */
export type IntegrationsSectionSlot =
  | 'corum.integrations.plugins'
  | 'corum.integrations.mcp'
  | 'corum.integrations.skills'
  | 'corum.integrations.extensions'
  | 'corum.integrations.market'

/**
 * 子导航键 → 内容子槽 key（单一事实源；与 `index.tsx` 的 SlotMap 登记、
 * root children 声明、内容包注册的槽名**同字面量**）。
 *
 * `satisfies` 双向锚定：键域必须是 `IntegrationsSection`、值域必须是
 * `IntegrationsSectionSlot`——拼错/漏项即编译错。
 */
export const INTEGRATIONS_SECTION_SLOTS = {
  plugins: 'corum.integrations.plugins',
  mcp: 'corum.integrations.mcp',
  skills: 'corum.integrations.skills',
  extensions: 'corum.integrations.extensions',
  market: 'corum.integrations.market',
} as const satisfies Record<IntegrationsSection, IntegrationsSectionSlot>

/** 子导航五项的展示元数据（图标/文案，画板 F 的 item 五连）。
 *  图标类型用 lucide 自己的 `LucideIcon`（与 `Blocks` 等具体图标同构，
 *  避免 `typeof Blocks` 这种「以某一个图标当整族类型」的别名）。 */
const SECTION_ITEMS: Record<IntegrationsSection, { label: string; icon: LucideIcon }> = {
  plugins: { label: '插件', icon: Blocks },
  mcp: { label: 'MCP 服务器', icon: Server },
  skills: { label: '技能', icon: WandSparkles },
  extensions: { label: '扩展包', icon: Package },
  market: { label: '市场', icon: Store },
}

/** 集成中心面板的 props（纯展示：状态与动作全由 AppFrame 下发）。 */
export interface IntegrationsFrameProps {
  /** 当前选中的子导航项（AppFrame 本地 state）。 */
  section: IntegrationsSection
  /** 点子导航项：切内容页。 */
  onSelectSection: (section: IntegrationsSection) => void
  /** 面板头的 × 关闭：切回会话布局（AppFrame 切工作面，不写 ctx.layout）。 */
  onClose: () => void
  /**
   * 内容子槽渲染面（AppFrame 的 `renderSlot`，此处**收窄到五个内容子槽**）：
   * 收窄是刻意的——本组件不该拿到壳的其它槽（网格区域/设置座位）的渲染权。
   */
  renderSlot: (key: IntegrationsSectionSlot, owner: IntegrationsPageOwnerProps) => ReactNode
}

/**
 * 集成中心面板（全屏独占工作面的右侧全幅部分）。
 * @param props - 子导航选中态 + 两个动作 + 收窄后的子槽渲染面。
 * @returns 面板元素（面板头 + 子导航 + 内容区）。
 */
export function IntegrationsFrame({ section, onSelectSection, onClose, renderSlot }: IntegrationsFrameProps) {
  return (
    <div className={css.panel} role="region" aria-label="集成中心">
      {/* 面板头（iYTAN `b17IoZ`：icon 26 r8 + 标题 13.5/600 + spacer +
          note 10.5 + × 24 r7）。 */}
      <div className={css.header}>
        <span className={css.headerIcon} aria-hidden="true">
          <Blocks size={15} strokeWidth={2} />
        </span>
        <h2 className={css.headerTitle}>集成中心</h2>
        <span className={css.headerSpacer} />
        <span className={css.headerNote}>× 关闭 → 回到会话布局（侧边栏与会话区恢复）</span>
        <button
          type="button"
          className={css.closeBtn}
          title="关闭集成中心（回到会话布局）"
          aria-label="关闭集成中心"
          onClick={onClose}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <div className={css.body}>
        {/* 子导航（画板 F Vyfds：118 宽、右分隔线、padding 10/8、gap 2）。 */}
        <nav className={css.subNav} aria-label="集成中心子导航">
          {INTEGRATIONS_SECTIONS.map((key) => {
            const { label, icon: Icon } = SECTION_ITEMS[key]
            const active = key === section
            return (
              <button
                key={key}
                type="button"
                className={css.subNavItem}
                data-active={active || undefined}
                aria-pressed={active}
                aria-current={active ? 'page' : undefined}
                title={label}
                onClick={() => { onSelectSection(key) }}
              >
                <span className={css.subNavPill}>
                  <Icon size={14} strokeWidth={2} />
                  <span className={css.subNavLabel}>{label}</span>
                </span>
              </button>
            )
          })}
        </nav>

        {/* 内容区（画板 F wXUJu：padding 12 / gap 10）：五个内容子槽之一。
            occupant 由内容包经 ctx.slots.inject 注册；未注册时为空面板（不白屏）。 */}
        <div className={css.content}>
          {renderSlot(INTEGRATIONS_SECTION_SLOTS[section], {})}
        </div>
      </div>
    </div>
  )
}
